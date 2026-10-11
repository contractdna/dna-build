// Keeper jobs (keeper key, permissionless calls), the daily anchor (anchor key) and the agent's registry queue op
// (agent key). Each keeper reads its precondition first (pure `due.*`, unit-tested) and only then calls send(), which
// estimates gas (= eth_call) before anything is broadcast. Times are chain time (latest block), never the wall clock.
import { type Abi, type Address, encodeFunctionData, type Hex, parseEventLogs } from "viem";
import * as abi from "./abi.ts";
import { d, KEEPER, LOG_BASE_URL } from "./config.ts";
import { edb as sql } from "./db.ts";
import { Defer, type Handler, type Job } from "./jobs.ts";
import { ENCLAVE, tcbInfo } from "./enclave.ts";
import { encodeOp, type OpName, OPS, SAFE_ONLY_OPS } from "./lib.ts";
import { append, type EnclaveRow, recordOk } from "./log.ts";
import { mode } from "./mode.ts";
import { alert } from "./telegram.ts";
import { LIMITS } from "./policy.ts";
import { addressOf, pub, type Sent, send } from "./tx.ts";

const DAY = 86_400n;
/** BountyBoard.AWARD_GRACE (engine/test/engine.test.ts checks it against BountyBoard.sol). */
export const AWARD_GRACE = 7n * DAY;
// sized for the 1 h registry (MIN_DELAY / PARAMS_EPOCH): a reverting op is re-simulated hourly, and a ParamsEpoch
// revert (the plate's 1 h params epoch not over yet) on the very next keeper run
export const EXEC_RETRY_MS = 3600_000;
export const retryMs = (error: string) => (/ParamsEpoch/.test(error) ? 0 : EXEC_RETRY_MS);
/** Engine gate re-check for a due agent op (set by loop.ts; null = execute). Indirection avoids an import cycle. */
export const gate: { check: (id: string) => Promise<string | null> } = { check: async () => null };
type ExecState = { from: string; failed: Record<string, { queuedAt: string; at: number; error: string }> };

export const DUST_WEI = 10n ** 12n;
/** Pure preconditions (bigint seconds unless noted). */
export const due = {
  distribute: (claims: bigint, min = KEEPER.distributeMinWei) => claims >= min,
  /** BuybackBurn.process / LiquidityVault.add: claims to spend (≥ 1e12 wei, BuybackBurn.MIN_SIZE: never a dust call)
   *  and the on-chain COOLDOWN (1 h buyback, 4 h LP) passed. */
  cooldown: (claims: bigint, now: bigint, last: bigint, cooldown: bigint) => claims >= DUST_WEI && now >= last + cooldown,
  /** PlatformRevenue.claim: ≥ 0.5 ETH, or anything once a week (ms). */
  claim: (claims: bigint, lastClaimMs: number | null, nowMs: number, min = KEEPER.claimMinWei) =>
    claims >= min || (claims > 0n && (lastClaimMs === null || nowMs - lastClaimMs >= KEEPER.claimEveryMs)),
  execute: (queuedAt: bigint, now: bigint, delay: bigint) => queuedAt !== 0n && now >= queuedAt + delay,
  /** IdeaMarket.finalize: a proposal ≥ 24 h old by a still-valid proposer, or the all-void expiry at roundEnd +
   *  RESOLVE_WINDOW (read from the contract) + MIN_DELAY (24 h). status 0 Open 1 Proposed 2 Final. */
  finalize: (r: { status: number; count: number; proposedAt: bigint; proposerValid: boolean }, roundEnd: bigint, now: bigint, resolveWindow: bigint) =>
    r.count > 0 && r.status !== 2 && ((r.status === 1 && r.proposerValid && now >= r.proposedAt + DAY) || now >= roundEnd + resolveWindow + DAY),
  /** BountyBoard.expire: Proposed (1) past deadline, Open (2) past deadline + AWARD_GRACE. */
  expire: (b: { status: number; deadline: bigint }, now: bigint) => (b.status === 1 && now >= b.deadline) || (b.status === 2 && now >= b.deadline + AWARD_GRACE),
};

const read = <T>(address: Address, a: readonly unknown[], functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi: a as never, functionName, args } as never) as Promise<T>;
const claims = (owner: Address) => read<bigint>(d.poolManager, abi.poolManagerAbi, "balanceOf", [owner, 0n]);
const chainNow = async () => (await pub.getBlock()).timestamp;
const keeper = (job: Job) => ({ key: "keeper" as const, since: job.created_at });

async function kv<T>(key: string): Promise<T | undefined> {
  return (await sql<{ value: T }[]>`select value from state where key = ${key}`)[0]?.value;
}
async function setKv(key: string, value: unknown) {
  await sql`insert into state (key, block, value) values (${key}, 0, ${sql.json(value as never)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/** Each keeper's period. process (1 h on-chain cooldown) and add (4 h) check every executeMs: an hourly tick lands a few
 *  seconds before the cooldown ends and the buy slips a whole hour; due.cooldown makes the extra ticks plain reads. */
export const KEEPER_EVERY = { distribute: KEEPER.intervalMs, process: KEEPER.executeMs, add: KEEPER.executeMs, claim: KEEPER.intervalMs, expire: KEEPER.intervalMs };

/** Keepers: no-ops while halted (the next period re-checks); dry_run logs what would be sent. */
export const keeperJob = (run: (job: Job) => Promise<unknown>): Handler => ({
  lane: "tx:keeper",
  run: async (job) => ((await mode()) === "halted" ? "halted" : run(job)),
});

export const keeperHandlers: Record<string, Handler> = {
  "keeper:distribute": keeperJob(async (job) => {
    const bal = await claims(d.feeVault);
    if (!due.distribute(bal)) return "below minimum";
    return send({ ...keeper(job), to: d.feeVault, abi: abi.feeVaultAbi, fn: "distribute", purpose: "keeper:distribute", valueMoved: bal });
  }),

  "keeper:process": keeperJob(async (job) => {
    const [bal, last, cd, now] = await Promise.all([claims(d.buybackBurn), read<bigint>(d.buybackBurn, abi.buybackBurnAbi, "lastProcess"), read<bigint>(d.buybackBurn, abi.buybackBurnAbi, "COOLDOWN"), chainNow()]);
    if (!due.cooldown(bal, now, last, cd)) return "not due";
    const size = bal > 10n ** 18n ? 10n ** 18n : bal; // MAX_SIZE 1 ETH
    return send({ ...keeper(job), to: d.buybackBurn, abi: abi.buybackBurnAbi, fn: "process", purpose: "keeper:process", valueMoved: size });
  }),

  "keeper:add": keeperJob(async (job) => {
    const [bal, last, cd, now] = await Promise.all([claims(d.liquidityVault), read<bigint>(d.liquidityVault, abi.liquidityVaultAbi, "lastAdd"), read<bigint>(d.liquidityVault, abi.liquidityVaultAbi, "COOLDOWN"), chainNow()]);
    if (!due.cooldown(bal, now, last, cd)) return "not due";
    return send({ ...keeper(job), to: d.liquidityVault, abi: abi.liquidityVaultAbi, fn: "add", purpose: "keeper:add", valueMoved: bal });
  }),

  "keeper:claim": keeperJob(async (job) => {
    const bal = await claims(d.platformRevenue);
    const [last] = await sql<{ at: Date }[]>`select at from log where kind = 'tx' and ref = 'keeper:claim' and doc->>'status' = 'mined' order by seq desc limit 1`;
    if (!due.claim(bal, last ? last.at.getTime() : null, Date.now())) return "not due";
    return send({ ...keeper(job), to: d.platformRevenue, abi: abi.platformRevenueAbi, fn: "claim", purpose: "keeper:claim", valueMoved: bal });
  }),

  /** registry.execute for every due op (Safe's and the agent's: execute is permissionless). Agent ops are first
   *  re-judged by the engine's gates (`agentOpGate`): a failing op is not executed and the Safe is asked to cancel it.
   *  Scans from the lowest id that was still pending last time. An op whose execute reverts in simulation is alerted
   *  once and skipped for retryMs (1 h; a ParamsEpoch revert is retried on the next run). */
  "keeper:execute": keeperJob(async (job) => {
    const [next, delay, now, [failCount]] = await Promise.all([
      read<bigint>(d.registry, abi.registryAbi, "nextId"), read<bigint>(d.registry, abi.registryAbi, "MIN_DELAY"), chainNow(),
      read<readonly [number, bigint]>(d.hook, abi.hookAbi, "breaker"),
    ]);
    if (failCount >= 3) return "breaker tripped: only rollback may change the route";
    const st = (await kv<ExecState>("engine_exec")) ?? { from: "1", failed: {} };
    let lowestPending: bigint | undefined;
    const out: unknown[] = [];
    for (let id = BigInt(st.from); id <= next; id++) {
      const [op, proposer, queuedAt] = await read<readonly [number, Address, bigint, Hex]>(d.registry, abi.registryAbi, "queued", [id]);
      if (queuedAt === 0n) { delete st.failed[String(id)]; continue; } // executed, cancelled or never queued
      lowestPending ??= id;
      if (!due.execute(queuedAt, now, delay)) continue;
      const f = st.failed[String(id)];
      if (f && f.queuedAt === String(queuedAt) && Date.now() - f.at < retryMs(f.error)) continue;
      if (proposer.toLowerCase() === addressOf("agent")?.toLowerCase()) {
        const why = await gate.check(String(id));
        if (why) {
          await alert(`NOT executing agent op #${id} (${OPS[op] ?? `op ${op}`}): ${why}. The Safe should cancel it (anyone else can still execute it after its eta).`, `alert:gate:${id}`);
          continue;
        }
      }
      const r = await send({ ...keeper(job), to: d.registry, abi: abi.registryAbi, fn: "execute", args: [id], purpose: "keeper:execute" });
      if (r.status === "sim_revert") {
        st.failed[String(id)] = { queuedAt: String(queuedAt), at: Date.now(), error: r.error ?? "" };
        await alert(`registry.execute(#${id}, ${OPS[op] ?? `op ${op}`}) reverts: ${r.error}. ${retryMs(r.error ?? "") ? `Skipping it for ${EXEC_RETRY_MS / 3600_000} h` : "Retrying on every keeper run until the params epoch passes"}; the Safe can cancel it.`, `alert:execfail:${id}:${queuedAt}`);
      } else if (r.status === "mined") delete st.failed[String(id)];
      out.push({ id, ...r });
    }
    await setKv("engine_exec", { ...st, from: String(lowestPending ?? next + 1n) });
    return out;
  }),

  "keeper:finalize": keeperJob(async (job) => {
    if (!d.ideaMarket) return "no IdeaMarket in the deployment";
    const im = d.ideaMarket;
    const [current, now, safe, agent, paused, resolveWindow] = await Promise.all([
      read<bigint>(im, abi.ideaMarketAbi, "currentRound"), chainNow(), read<Address>(d.registry, abi.registryAbi, "safe"),
      read<Address>(d.registry, abi.registryAbi, "agent"), read<boolean>(d.registry, abi.registryAbi, "agentPaused"),
      read<bigint>(im, abi.ideaMarketAbi, "RESOLVE_WINDOW"),
    ]);
    const out: unknown[] = [];
    // simplification: scans every round (24 h rounds → ~365/yr); start from the oldest non-Final round if it gets slow
    for (let r = 0n; r < current; r++) {
      const [status, count, , , proposedAt, proposer] = await read<readonly [number, number, number, number, number, Address]>(im, abi.ideaMarketAbi, "rounds", [r]);
      const proposerValid = proposer.toLowerCase() === safe.toLowerCase() || (proposer.toLowerCase() === agent.toLowerCase() && !paused);
      const end = await read<bigint>(im, abi.ideaMarketAbi, "roundEnd", [r]);
      if (!due.finalize({ status, count, proposedAt: BigInt(proposedAt), proposerValid }, end, now, resolveWindow)) continue;
      out.push({ round: r, ...(await send({ ...keeper(job), to: im, abi: abi.ideaMarketAbi, fn: "finalize", args: [r], purpose: "keeper:finalize" })) });
    }
    return out;
  }),

  "keeper:expire": keeperJob(async (job) => {
    if (!d.bountyBoard) return "no BountyBoard in the deployment";
    const bb = d.bountyBoard;
    const [next, now] = await Promise.all([read<bigint>(bb, abi.bountyBoardAbi, "nextId"), chainNow()]);
    const out: unknown[] = [];
    for (let id = 1n; id < next; id++) {
      const [, deadline, status] = await read<readonly [bigint, bigint, number, boolean, Address]>(bb, abi.bountyBoardAbi, "bounties", [id]); // (reward, deadline, status, fromAllowance, winner)
      if (!due.expire({ status, deadline }, now)) continue;
      out.push({ id, ...(await send({ ...keeper(job), to: bb, abi: abi.bountyBoardAbi, fn: "expire", args: [id], purpose: "keeper:expire" })) });
    }
    return out;
  }),

  /** Breaker tripped (watcher): permissionless rollback(Fee). Emergency gas ceiling, no value guard. Deferred (not
   *  dropped) while halted; anything but mined / dry_run (a sim revert, a reverted tx) throws so the job retries with
   *  backoff, and the watcher keeps re-alerting while the breaker stays tripped. */
  "keeper:rollback": {
    lane: "tx:keeper",
    run: async (job) => {
      const [failCount] = await read<readonly [number, bigint]>(d.hook, abi.hookAbi, "breaker");
      if (failCount < 3) return "breaker no longer tripped";
      const r = await send({ ...keeper(job), to: d.registry, abi: abi.registryAbi, fn: "rollback", args: [0], purpose: "keeper:rollback", emergency: true });
      if (r.status !== "mined" && r.status !== "dry_run") throw new Error(`rollback ${r.status}: ${r.error ?? r.hash}`);
      return r;
    },
  },
};

export const ANCHOR_BACKFILL_DAYS = 7;
/** Days to anchor for payload `day`: it and the ANCHOR_BACKFILL_DAYS - 1 before it, oldest first. */
export const anchorDays = (day: string) =>
  Array.from({ length: ANCHOR_BACKFILL_DAYS }, (_, i) => new Date(Date.parse(`${day}T00:00:00Z`) - (ANCHOR_BACKFILL_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10));

/** Head hash of each UTC day → registry.anchor(root, <LOG_BASE_URL>/api/log/<day>), for `day` and the 6 days before it
 *  that are still unanchored (a missed or failed day is backfilled). Skips empty days; idempotent per day (a live
 *  anchor record for the day ends it). */
export const anchorHandler: Handler = {
  lane: "tx:anchor",
  run: async (job) => {
    const day = String(job.payload.day);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day ${day}`);
    const out: Record<string, unknown> = {};
    for (const x of anchorDays(day)) out[x] = await anchorDay(x);
    return out;
  },
};

async function anchorDay(day: string) {
  const [done] = await sql`select 1 from log where kind = 'anchor' and ref = ${day} and doc->>'mode' = 'live'`;
  if (done) return "already anchored";
  const range = sql`at >= ${day}::date::timestamp at time zone 'UTC' and at < (${day}::date + 1)::timestamp at time zone 'UTC'`;
  let head: { seq: string; hash: string } | undefined;
  if (ENCLAVE.on) {
    // the root is the day's last record the enclave itself signed (ehash): a row the DB made up is never anchored
    // (it would fail every later boot check)
    const signer = (await import("./signed.ts")).signerAddress();
    for (const r of await sql<(EnclaveRow & { seq: string })[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where ${range} and ehash is not null order by log.seq desc limit 20`) {
      if (await recordOk(r, signer)) { head = { seq: r.seq, hash: r.ehash!.toString("hex") }; break; }
    }
    if (!head) return "no enclave record today";
  } else {
    [head] = await sql<{ seq: string; hash: string }[]>`select seq::text, encode(hash, 'hex') as hash from log where ${range} order by log.seq desc limit 1`;
    if (!head) return "empty day";
  }
  const root = `0x${head.hash}` as Hex;
  const uri = `${LOG_BASE_URL}/api/log/${day}`;
  const r = await send({ key: "anchor", to: d.registry, abi: abi.registryAbi, fn: "anchor", args: [root, uri], purpose: "anchor" });
  if (r.status === "mined" || r.status === "dry_run") await append("anchor", day, { day, root, seq: head.seq, uri, hash: r.hash ?? null, mode: r.status === "mined" ? "live" : "dry_run" });
  if (r.status === "reverted" || r.status === "sim_revert") throw new Error(`anchor ${day} ${r.status}: ${r.error ?? r.hash}`);
  return r;
}

/** The agent's queued registry op (level-gated on-chain: L4 SetShadow; L5 SetCanary, SetParams on non-active; L6
 *  SetParams on active; L8 PromoteActive; L9 split-kind; L10 Register of a Safe-approved codehash). Safe-only ops are
 *  refused before any RPC; at most LIMITS.agentQueueOps per UTC day (dry runs count too, so a dry run shows the same
 *  ceiling). Returns the on-chain op id once mined (parsed from the Queued event). */
export async function queueOp(op: OpName, args: unknown[], since?: Date): Promise<Sent & { id?: string }> {
  if (SAFE_ONLY_OPS.includes(op)) throw Object.assign(new Error(`${op} is Safe-only: the agent never queues it`), { final: true });
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from log where kind = 'tx' and ref like 'agent:queue:%'
    and doc->>'status' in ('mined', 'dry_run') and at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`;
  if (n >= LIMITS.agentQueueOps) throw new Defer(3600_000, `daily maximum of ${LIMITS.agentQueueOps} agent queue ops reached`);
  const q = encodeOp(op, args);
  const anchored = ENCLAVE.on ? await anchorFirst({ to: d.registry, abi: abi.registryAbi, fn: "queue", args: [q.op, q.data] }, { op, args }) : undefined;
  const r = await send({ key: "agent", to: d.registry, abi: abi.registryAbi, fn: "queue", args: [q.op, q.data], purpose: `agent:queue:${op}`, since });
  // the tx hashes land in the next record: the verifier matches intent.calldata to Queued.data and anchorTx < queueTx
  if (anchored) await append("anchor", `op:${anchored.seq}`, { kind: "queued", intent: anchored.seq, op, anchorTx: anchored.hash ?? null, queueTx: r.hash ?? null, status: r.status });
  if (r.status === "reverted" || r.status === "sim_revert") throw new Error(`queue ${op} ${r.status}: ${r.error ?? r.hash}`);
  if (r.status !== "mined") return r;
  const rc = await pub.getTransactionReceipt({ hash: r.hash! });
  const ev = parseEventLogs({ abi: abi.registryAbi, logs: rc.logs, eventName: "Queued" })[0];
  return { ...r, id: ev ? String(ev.args.id) : undefined };
}

/** Enclave: the decision record — carrying the exact calldata the queue tx will send — is
 *  anchored on-chain (root = its enclave-chain hash, uri = the record) and MINED before the queue tx. Not mined within
 *  ANCHOR_OP.timeoutMs: the op is dropped for this cycle (a final error: the next tick / cycle decides again). Never an
 *  op without an anchor; an anchor that mines late, without its op, is harmless. */
export const ANCHOR_OP = { timeoutMs: 10 * 60_000 };
type AgentCall = { to: Address; abi: readonly unknown[]; fn: string; args: readonly unknown[] };
/** `what`: {op, args} for a registry queue op (the verifier re-runs the mapper), {fn, args} for any other agent call. */
async function anchorFirst(c: AgentCall, what: { op: OpName; args: unknown[] } | { fn: string; args: readonly unknown[] }) {
  const calldata = encodeFunctionData({ abi: c.abi as Abi, functionName: c.fn, args: c.args as never });
  const op = "op" in what ? what.op : what.fn;
  const rec = await append("anchor", `op:${op}`, { kind: "intent", ...what, to: c.to, calldata, tcb: await tcbInfo(), at: new Date().toISOString() });
  const sent = send({ key: "anchor", to: d.registry, abi: abi.registryAbi, fn: "anchor", args: [`0x${rec.ehash}`, `${LOG_BASE_URL}/api/log/${rec.seq}`], purpose: `anchor:op:${rec.seq}` });
  sent.catch(() => {}); // a late failure after a timeout is the send's own record
  let timer: NodeJS.Timeout | undefined;
  const r = await Promise.race([sent, new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), ANCHOR_OP.timeoutMs); })]).finally(() => clearTimeout(timer));
  if (r === "timeout" || (r.status !== "mined" && r.status !== "dry_run")) {
    const why = r === "timeout" ? `not mined in ${ANCHOR_OP.timeoutMs / 60_000} min` : `${r.status}: ${r.error ?? r.hash}`;
    await append("anchor", `op:${rec.seq}`, { kind: "dropped", intent: rec.seq, op, reason: `anchor ${why}` });
    throw Object.assign(new Error(`${op} dropped this cycle: its decision anchor ${why}`), { final: true });
  }
  return { seq: rec.seq, hash: r.hash };
}

/** An agent tx that is not a registry queue op (the game board and pot): in the enclave its decision is anchored and
 *  mined first, exactly like queueOp's; the tx hashes land in the next record. */
export async function agentCall(c: AgentCall & { purpose: string; since?: Date }) {
  const anchored = ENCLAVE.on ? await anchorFirst(c, { fn: c.fn, args: c.args }) : undefined;
  const r = await send({ key: "agent", ...c });
  if (anchored) await append("anchor", `op:${anchored.seq}`, { kind: "sent", intent: anchored.seq, fn: c.fn, anchorTx: anchored.hash ?? null, tx: r.hash ?? null, status: r.status });
  return r;
}

export const queueHandler: Handler = {
  lane: "tx:agent",
  run: async (job) => {
    const { op, args } = job.payload as { op: OpName; args: unknown[] };
    return queueOp(op, args, job.created_at);
  },
};

/** Agent: end the Fee canary now (immediate call, not queued; L5+). The plate returns to Proposed; not a rollback. */
export const endCanaryHandler: Handler = {
  lane: "tx:agent",
  run: async (job) => {
    const r = await send({ key: "agent", to: d.registry, abi: abi.registryAbi, fn: "endCanary", purpose: "agent:endCanary", since: job.created_at, emergency: true });
    if (r.status === "sim_revert" && /NoCanary/.test(r.error ?? "")) return "no canary (already ended)";
    if (r.status === "reverted" || r.status === "sim_revert") throw new Error(`endCanary ${r.status}: ${r.error ?? r.hash}`);
    return r;
  },
};
