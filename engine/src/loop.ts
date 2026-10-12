// The agent loop. A cycle every CYCLE_MS (15 min, always): observe → (research, on a trigger) → Main hypothesis +
// vector (clamped) → simulate (fork safety on the long-lived fork + analytic revenue) → red team (Opus, only for a new
// candidate that passed every gate) → decide (deterministic gates AND red team ≠ block AND Main = go: any can stop,
// none can force) → records. While an experiment is open a cycle only narrates it (cheaper model) and refreshes the
// core record. Search cycles write into one open thread that closes into a memory entry after SEARCH_THREAD_CYCLES.
// Registry state machine for the AdaptiveFee plates at the on-chain level (delays read from the registry):
//   SetParams(plate) [+ SetShadow] → MIN_DELAY, keeper executes → shadow (time) → Fable red team → SetCanary(len ≥ 50)
//   → canary (time; kill conditions checked every tick and on every watcher event) → pass:
//       L8+: Fable red team → agent queues PromoteActive · L6–7 with an active plate: SetParams(active) = the vector
//       · else: Telegram request for a Safe PromoteActive
//   → fail / kill: endCanary() at once.
// One experiment at a time; the agent's own pending ops ≤ LIMITS.agentPending; nothing is queued unless the engine
// would accept it executing (keeper:execute re-judges agent ops through `agentOpGate`). Runs only start in live mode.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Address, type Hex, keccak256, toHex } from "viem";
import * as abi from "./abi.ts";
import * as agents from "./agents.ts";
import { d, LOOP, RPC_URLS } from "./config.ts";
import { HOOK_FEES, pctOf } from "./hook-fees.ts";
import { edb as sql } from "./db.ts";
import { Defer, enqueue, type Handler } from "./jobs.ts";
import { canonical, stateSig, trusted } from "./log.ts";
import { chainRef, CYCLE_EVENTS, cursorAgreed, readAgreed } from "./chainref.ts";
import { type Leakage, leakageFor } from "./clones.ts";
import { ENCLAVE, tcbInfo } from "./enclave.ts";
import { GENESIS_POOLS } from "./genesis.ts";
import { gate, queueOp } from "./keepers.ts";
import { chainRows, capOf, inWindow, killCheck, observeNow, pair, type Paired, snapshot, stats, type Stats } from "./observe.ts";
import { mode } from "./mode.ts";
import { boundsIssue, checkTimings, clampVector, GATES, KILL, LIMITS, MODELS, POLICY, TIMING, type Vector } from "./policy.ts";
import { count, latest, nextId, nowIso, PIPELINE, record, step, trustedDocs } from "./records.ts";
import { analytic, candidateGates, forkReplay, HARNESS, replaySet, type Safety } from "./sim.ts";
import { alert } from "./telegram.ts";
import { addressOf, pub, send } from "./tx.ts";
import { enqueueOutcome, enqueueReflection } from "./x.ts";

export const GOAL = "raise project-fee ETH per day to the vaults without losing swaps";
/** The fee research question (Research, on a trigger). */
export const RESEARCH_QUESTION = "Which dynamic-fee designs on Uniswap v4 and v3-style pools raised fee revenue without losing swap count, and what fee levels did traders tolerate during volatility?";
const SPEC_HASH = keccak256(readFileSync(new URL("../modules/adaptive-fee-v1.json", import.meta.url)));
const ZERO = /^0x0{40}$/i;
const S = { None: 0, Proposed: 1, Shadow: 2, Canary: 3, Active: 4, RolledBack: 6 } as const;
const word = (x: number) => toHex(BigInt(x), { size: 32 });
export const vectorWords = (v: Vector) => [word(v[0]), word(v[1]), word(v[2]), word(0)] as [Hex, Hex, Hex, Hex];
const pct = (x: number) => Number((x * 100).toFixed(2));
const fmtV = (v: Vector) => `base ${(v[0] / 1e4).toFixed(2)}%, multiplier ${(v[1] / 1e4).toFixed(2)}×, cap ${(v[2] / 1e4).toFixed(2)}%`;

// ---------------------------------------------------------------- plates

type ModuleStruct = { kind: number; status: number; paramsAt: bigint; params: readonly Hex[]; minParams: readonly Hex[]; maxParams: readonly Hex[] };
export type Plate = { address: Address; label: string; status: number; params: Vector; min: number[]; max: number[]; paramsAt: number };
const nums = (h: readonly Hex[]) => h.slice(0, 3).map((x) => Number(BigInt(x)));

/** The AdaptiveFee plates: Fee modules registered with this manifest's spec hash, labelled A, B, C in first
 *  registration order (a re-registered plate keeps its letter). State read at head. */
export async function plates(): Promise<Plate[]> {
  const rows = await sql<{ m: Address }[]>`select args->>'module' as m from chain_log where event = 'Registered' and lower(args->>'specHash') = ${SPEC_HASH.toLowerCase()}
    and (args->>'kind')::int = 0 group by 1 order by min(block), min(log_index)`;
  return Promise.all(rows.map(async (r, i) => {
    const m = (await pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "getModule", args: [r.m] })) as unknown as ModuleStruct;
    return { address: r.m, label: String.fromCharCode(65 + i), status: m.status, params: nums(m.params) as Vector, min: nums(m.minParams), max: nums(m.maxParams), paramsAt: Number(m.paramsAt) };
  }));
}

/** The registry's MIN_DELAY (queue → executable) and PARAMS_EPOCH (one SetParams per module per epoch), in seconds,
 *  read once from the contract (constants: they only change with a new registry). */
let regTiming: Promise<{ minDelay: number; paramsEpoch: number }> | undefined;
export const registryTiming = () => (regTiming ??= Promise.all([
  pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "MIN_DELAY" }),
  pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "PARAMS_EPOCH" }),
]).then(([a, b]) => {
  const t = { minDelay: Number(a), paramsEpoch: Number(b) };
  // PROMOTE_WAIT_HOURS must leave the Safe time to queue PromoteActive before the canary ends: > the real MIN_DELAY
  const bad = checkTimings(TIMING, KILL, t.minDelay * 1000);
  if (bad.length) throw Object.assign(new Error(bad.join("; ")), { final: true });
  return t;
}).catch((e) => { regTiming = undefined; throw e; }));
const hours = (s: number) => `${Number((s / 3600).toFixed(2))} h`;
/** A plate can take a SetParams queued now: its PARAMS_EPOCH has passed by the time the op becomes executable. */
export const paramsFree = (paramsAt: number, chainNow: number, t: { minDelay: number; paramsEpoch: number }) => paramsAt + t.paramsEpoch <= chainNow + t.minDelay;
const queuedText = async (op: string, label: string, id: string) =>
  `Queued ${op} for plate ${label} as registry op #${id} (executable by anyone in ${hours((await registryTiming()).minDelay)}; the Safe can cancel).`;

// ---------------------------------------------------------------- the state machine (pure)

export type Stage = "queued_shadow" | "shadow" | "queued_canary" | "canary" | "tune_queued" | "promote_queued" | "promote_requested" | "closed";
export type Run = {
  id: string; title: string; hypothesis: string; plate: Address; label: string; vector: Vector; stage: Stage; stageAt: number;
  ops: string[]; // ids the current stage waits on
  allOps?: string[]; // every op this experiment queued (keeper:execute judges them by this list)
  planned?: { op: "SetParams" | "SetShadow"; args: unknown[] }[]; // first-stage ops still to queue (a retried cycle resumes here)
  sim: string; exp: string; bench: "1" | "2" | "3"; canaryBlock?: number;
  fable?: { canary?: boolean; promote?: boolean }; active?: Address; tuned?: Vector; canaryOp?: string; outcome?: "accepted" | "rejected" | "rolled_back"; reason?: string;
  confidence: number; simNumbers: Record<string, number>;
  extended?: number; // 1 h extensions of the current stage so far (short of its minimum samples)
  source?: string; // who asked for it from outside the loop: "ballot <n>" / "mystery <n>" (src/games.ts finds its own run by it)
  gateDeferred?: string; // UTC day the gate red team was last deferred by the LLM cap (one step per day)
};
export type ActivePlate = { address: Address; params: Vector; min: number[]; max: number[] };
/** samples: the current stage's data so far (shadow: ShadowFee events from the plate; canary: in-window fee swaps). */
export type Facts = { now: number; head: number; level: number; plate: { status: number; params: Vector }; active?: ActivePlate; opsPending: boolean; agentPending: number; kill: string | null; samples: number;
  minDelayMs: number; // the registry's MIN_DELAY
  promotePending: boolean; // a PromoteActive(run.plate) is queued on-chain and neither executed nor cancelled
};
export type Action = { t: "queue"; op: "SetCanary" | "SetParams" | "PromoteActive"; args: unknown[] } | { t: "endCanary" } | { t: "fable"; purpose: "canary" | "promote" } | { t: "request"; text: string } | { t: "close"; outcome: NonNullable<Run["outcome"]>; reason: string }
  | { t: "extend"; hours: number; why: string };
const hrsOf = (ms: number) => `${Number((ms / 3600_000).toFixed(2))} h`;

const same = (a: Vector, b: Vector) => a.every((x, i) => x === b[i]);
const CANARY_STAGES: Stage[] = ["canary", "tune_queued", "promote_queued", "promote_requested"];

/** One step of the plate state machine. Pure: facts in, the next run + the actions to take out. */
export function advance(run: Run, f: Facts, t = TIMING): { run: Run; actions: Action[] } {
  const to = (stage: Stage, extra: Partial<Run> = {}) => ({ ...run, extended: undefined, ...extra, stage, stageAt: f.now });
  const close = (outcome: NonNullable<Run["outcome"]>, reason: string, end = false): { run: Run; actions: Action[] } =>
    ({ run: to("closed", { outcome, reason }), actions: [...(end && f.plate.status === S.Canary ? [{ t: "endCanary" } as const] : []), { t: "close", outcome, reason }] });
  const wait = { run, actions: [] as Action[] };
  /** Time is up but the stage is short of data: extend (policy.ts TIMING), never pass on missing data. null = enough. */
  const enough = (stageMs: number, min: number, what: string, end: boolean) => {
    if (f.samples >= min) return null;
    const elapsed = f.now - run.stageAt;
    const why = `${f.samples} ${what} < ${min}`;
    if (elapsed >= t.maxStretch * stageMs) return close("rejected", `insufficient data: ${why} after ${hrsOf(elapsed)} (the stage was extended to ${t.maxStretch}× its ${hrsOf(stageMs)})`, end);
    const k = Math.floor((elapsed - stageMs) / t.extendStepMs) + 1;
    return k > (run.extended ?? 0) ? { run: { ...run, extended: k }, actions: [{ t: "extend", hours: (k * t.extendStepMs) / 3600_000, why } as Action] } : wait;
  };
  const p = f.plate;
  if (run.stage === "closed") return wait;
  if (p.status === S.RolledBack) return close("rolled_back", "the plate was rolled back");
  if (CANARY_STAGES.includes(run.stage)) {
    if (p.status === S.Active && (run.stage === "promote_queued" || run.stage === "promote_requested")) return close("accepted", `plate ${run.label} promoted to active`);
    // a kill first: the watcher's immediate endCanary may already have moved the plate back to Proposed
    if (f.kill) return close("rejected", `kill condition: ${f.kill}`, true);
    if (p.status !== S.Canary) return close("rejected", "the plate left the canary slot (ended by the Safe or displaced)");
  }
  switch (run.stage) {
    case "queued_shadow":
      if (f.opsPending) return wait;
      if (p.status === S.Shadow && same(p.params, run.vector)) return { run: to("shadow"), actions: [] };
      return close("rejected", "the queued SetParams/SetShadow were cancelled or did not apply");
    case "shadow":
      if (p.status !== S.Shadow) return close("rejected", "the plate left the shadow slot");
      if (f.now - run.stageAt < t.shadowMs) return wait;
      { const short = enough(t.shadowMs, t.minShadowSamples, "shadow samples", false); if (short) return short; }
      if (run.fable?.canary === undefined) return { run, actions: [{ t: "fable", purpose: "canary" }] };
      if (!run.fable.canary) return close("rejected", `${MODELS.redteamGate} red team blocked the canary`);
      if (f.level < 5) return close("rejected", `autonomy level ${f.level} < 5: no canary`);
      if (f.agentPending >= LIMITS.agentPending) return wait;
      return { run: to("queued_canary"), actions: [{ t: "queue", op: "SetCanary", args: [run.plate, BigInt(f.head), t.canaryPeriod, t.canaryLen] }] };
    case "queued_canary":
      if (f.opsPending) return wait;
      if (p.status === S.Canary) return { run: to("canary", { canaryBlock: f.head }), actions: [] };
      return close("rejected", "the queued SetCanary was cancelled or did not apply");
    case "canary": {
      if (f.now - run.stageAt < t.canaryMs) return wait;
      { const short = enough(t.canaryMs, t.minCanarySamples, "in-window fee-paying swaps", true); if (short) return short; }
      if (f.agentPending >= LIMITS.agentPending) return wait;
      const tune = f.level >= 6 && f.level < 8 && f.active && f.active.address.toLowerCase() !== run.plate.toLowerCase();
      if (f.level >= 8 || tune) {
        // both paths change the LIVE fee: the gate model red-teams first
        if (run.fable?.promote === undefined) return { run, actions: [{ t: "fable", purpose: "promote" }] };
        if (!run.fable.promote) return close("rejected", `${MODELS.redteamGate} red team blocked the ${tune ? "active-plate tune" : "promotion"}`, true);
      }
      if (f.level >= 8) return { run: to("promote_queued"), actions: [{ t: "queue", op: "PromoteActive", args: [run.plate] }] };
      if (tune) {
        const v = clampVector(run.vector, f.active); // the ACTIVE plate's registered bounds
        return { run: to("tune_queued", { active: f.active!.address, tuned: v }), actions: [{ t: "queue", op: "SetParams", args: [f.active!.address, vectorWords(v)] }] };
      }
      return { run: to("promote_requested"), actions: [{ t: "request", text: `Canary passed for adaptive-fee plate ${run.label} (${run.id}, ${fmtV(run.vector)}). The agent is at level ${f.level}: the Safe may queue PromoteActive(${run.plate}) within ${hrsOf(t.promoteWaitMs - f.minDelayMs)} (it executes ${hrsOf(f.minDelayMs)} later); the canary ends at ${hrsOf(t.promoteWaitMs)} without it.` }] };
    }
    case "tune_queued":
      if (f.opsPending) return wait;
      if (f.active && same(f.active.params, run.tuned ?? run.vector)) return close("accepted", `active plate tuned to ${fmtV(run.tuned ?? run.vector)}`, true);
      return close("rejected", "the queued SetParams on the active plate was cancelled or did not apply", true);
    case "promote_queued":
      if (f.opsPending) return wait;
      return close("rejected", "the queued PromoteActive was cancelled or did not apply", true);
    case "promote_requested":
      if (f.promotePending) return wait; // the Safe queued PromoteActive: never time out under it (executes or is cancelled)
      if (f.now - run.stageAt > t.promoteWaitMs) return close("rejected", `the Safe did not promote within ${t.promoteWaitMs / 3600_000} h`, true);
      return wait;
  }
  return wait;
}

// ---------------------------------------------------------------- facts (chain + finalized log)

// thread rows are enclave-signed state: an unsigned or foreign run is ignored (and alerted)
export const openRun = async () => {
  const [r] = await sql<{ id: string; data: Run; sig: string | null }[]>`select id, data, sig from thread where kind = 'fee' and stage <> 'closed' order by created_at limit 1`;
  return r && (await trusted("thread", r.id, r.data, r.sig)) ? r.data : undefined;
};
const saveRun = async (run: Run, tx: typeof sql = sql) => {
  const value = JSON.parse(JSON.stringify(run)) as Run; // exactly what jsonb stores (undefined fields dropped)
  return tx`insert into thread (id, kind, stage, data, sig) values (${run.id}, 'fee', ${run.stage}, ${sql.json(value as never)}, ${await stateSig("thread", run.id, value)})
    on conflict (id) do update set stage = excluded.stage, data = excluded.data, sig = excluded.sig, updated_at = now()`;
};
/** The experiment that queued op `id` (signed rows only in the enclave). */
export async function runOfOp(id: string): Promise<Run | undefined> {
  const [r] = await sql<{ id: string; data: Run; sig: string | null }[]>`select id, data, sig from thread where kind = 'fee' and (data->'allOps' ? ${id} or data->'ops' ? ${id}) order by created_at desc limit 1`;
  return r && (await trusted("thread", r.id, r.data, r.sig)) ? r.data : undefined;
}

/** Kill-condition look-back in blocks (12 s): max(the hours window, one full canary period + its window). */
export const killLookback = (windowHours: number, period: number, len: number) => Math.max(Math.round((windowHours * 3600) / 12), period + len);

async function canaryKill(run: Run, route: { active: string; activeParams: readonly Hex[]; canary: string; canaryStart: bigint; canaryPeriod: number; canaryLen: number }) {
  if (run.canaryBlock === undefined) return null;
  const cur = await cursorAgreed(); // enclave: both RPC providers agree on the cursor's block hash, or no kill decision
  if (!cur) return null;
  // enclave: the route at the cursor's block, read through both providers (not one provider's word at its head)
  if (ENCLAVE.on) route = await readAgreed((c) => c.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "route", blockNumber: BigInt(cur.block) }));
  // look back KILL_WINDOW_HOURS or one full canary period (+ its window), whichever is longer: a 1 h look-back alone
  // can hold a just-opened window and nothing else
  const fromBlock = Math.max(run.canaryBlock, cur.block - killLookback(KILL.windowHours, route.canaryPeriod, route.canaryLen));
  const rows = (await chainRows(["Swap", "FeeTaken"], cur.at.getTime() - (cur.block - fromBlock) * 12_000 - 3600_000)).filter((r) => r.block >= fromBlock);
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from chain_log where event = 'ModuleFailed' and lower(args->>'module') = ${run.plate.toLowerCase()} and block >= ${run.canaryBlock}`;
  // the window is only known while the plate is the routed canary; otherwise only ModuleFailed can be judged
  if (route.canary.toLowerCase() !== run.plate.toLowerCase()) return n ? `ModuleFailed ×${n} from the canary plate` : null;
  const window = { start: Number(route.canaryStart), period: route.canaryPeriod, len: route.canaryLen };
  // no out-of-window swaps to read the active fee from: the active plate's base, or the hook's baseline
  const activePips = ZERO.test(route.active) ? HOOK_FEES.baseline : Number(BigInt(route.activeParams[0]));
  return killCheck(pair(rows), { window, fromBlock, toBlock: cur.block, capPips: run.vector[2], activePips, canaryFailures: n });
}

/** The current stage's data (finalized chain_log): ShadowFee events from the plate since the shadow began, or
 *  fee-paying swaps inside the canary window since the canary began. */
async function samplesOf(run: Run, route: { canary: string; canaryStart: bigint; canaryPeriod: number; canaryLen: number }) {
  if (run.stage === "shadow") {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from chain_log where event = 'ShadowFee'
      and lower(args->>'module') = ${run.plate.toLowerCase()} and at >= ${new Date(run.stageAt)}`;
    return n;
  }
  if (run.stage !== "canary" || run.canaryBlock === undefined || route.canary.toLowerCase() !== run.plate.toLowerCase()) return 0;
  const w = { start: Number(route.canaryStart), period: route.canaryPeriod, len: route.canaryLen };
  return pair((await chainRows(["Swap", "FeeTaken"], run.stageAt - 3600_000)).filter((r) => r.block >= run.canaryBlock!)).filter((s) => s.fee && inWindow(s.block, w)).length;
}

/** A PromoteActive(plate) (op 3) queued by anyone (the Safe) and still pending on-chain: indexed Queued events give the
 *  ids, registry.queued(id) at head says whether each is still pending (not executed, not cancelled). */
async function promoteQueued(plate: Address) {
  const ids = await sql<{ id: string }[]>`select args->>'id' as id from chain_log where event = 'Queued' and (args->>'op')::int = 3
    and lower(args->>'target') = ${plate.toLowerCase()}`;
  for (const { id } of ids) {
    if ((await pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "queued", args: [BigInt(id)] }))[2] !== 0n) return true;
  }
  return false;
}

async function facts(run: Run, killHint?: string): Promise<Facts> {
  const agent = addressOf("agent") ?? d.safe;
  const [level, head, block, pending, route, all] = await Promise.all([
    pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "level" }),
    pub.getBlockNumber(), pub.getBlock(),
    pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "pendingOf", args: [agent] }),
    pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "route" }),
    plates(),
  ]);
  const plate = all.find((x) => x.address.toLowerCase() === run.plate.toLowerCase());
  const active = all.find((x) => x.address.toLowerCase() === route.active.toLowerCase());
  const opsPending = (await Promise.all(run.ops.map(async (id) => (await pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "queued", args: [BigInt(id)] }))[2] !== 0n))).some(Boolean);
  const kill = CANARY_STAGES.includes(run.stage) ? (killHint ?? (await canaryKill(run, route))) : null;
  return {
    now: Number(block.timestamp) * 1000, head: Number(head), level: Number(level), agentPending: Number(pending), opsPending, kill, samples: await samplesOf(run, route),
    minDelayMs: (await registryTiming()).minDelay * 1000, promotePending: run.stage === "promote_requested" && (await promoteQueued(run.plate)),
    plate: { status: plate?.status ?? S.None, params: plate?.params ?? [0, 0, 0] },
    active: active && !ZERO.test(route.active) ? { address: active.address, params: active.params, min: active.min, max: active.max } : undefined,
  };
}

/** keeper:execute asks before executing an agent op: null = execute; else why not (the Safe is alerted to cancel).
 *  First-stage ops (SetParams/SetShadow) are re-judged only on their experiment still being open; canary-stage ops
 *  also on the kill conditions. The engine's mode is not a reason: keepers already do nothing while halted and only
 *  simulate in dry_run, and a healthy op must not trigger a "Safe should cancel" alert. */
export async function agentOpGate(id: string): Promise<string | null> {
  const run = await runOfOp(id);
  // enclave: no operator path exists (no registry:queue handler), so an agent op no signed experiment owns is refused
  if (!run) return ENCLAVE.on ? "not owned by an experiment of this enclave" : null; // plain build: an operator's CLI op, theirs to judge
  if (run.stage === "closed") return `its experiment ${run.id} closed (${run.reason})`;
  if (CANARY_STAGES.includes(run.stage)) {
    const route = await pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "route" });
    const why = await canaryKill(run, route);
    if (why) return `kill condition: ${why}`;
  }
  return null;
}
gate.check = agentOpGate;

// ---------------------------------------------------------------- tick (every 10 min + on watcher events)

async function stepRecord(run: Run, event: string, extra: Record<string, unknown> = {}) {
  await record("plate", run.id, { event, run: run.id, plate: run.plate, label: run.label, stage: run.stage, ...extra, at: nowIso() });
}

/** The watcher's kill hint (head-of-chain ModuleFailed). Enclave: a job payload is DB data, so it is ignored and the
 *  kill is re-derived from verified chain reads (canaryKill). */
export const killHintOf = (payload: Record<string, unknown>) => (ENCLAVE.on ? undefined : (payload.kill as string | undefined));

export const tickHandler: Handler = {
  lane: "agent",
  run: async (job) => {
    let run = await openRun();
    if (!run) {
      await orphanCanary();
      return "no open experiment";
    }
    if (run.planned?.length) return `${run.id}: first-stage ops still being queued (the cycle job resumes them)`;
    const f = await facts(run, killHintOf(job.payload));
    const m = await mode();
    if (m !== "live") {
      if (f.kill) await alert(`Kill condition on canary ${run.id} (${f.kill}) but the engine is ${m}: the Safe (or /live) should end the canary.`, `alert:kill:${run.id}:${new Date().toISOString().slice(0, 13)}`);
      return `engine ${m}: ${run.id} paused at ${run.stage}`;
    }
    // re-advance on the same facts only while nothing changed on-chain (a Fable verdict or a pure stage move);
    // after a queue / endCanary / request the facts are stale: the next tick reads fresh ones
    let deferred = false;
    for (let i = 0; i < 4; i++) {
      const before = run.stage;
      const { run: next, actions } = advance(run, f);
      run = next;
      if (!actions.length && run.stage === before) break;
      for (const a of actions) {
        if (a.t === "queue") {
          const r = await queueOp(a.op, a.args, job.created_at);
          if (!r.id) throw new Error(`queue ${a.op}: ${r.status}`);
          run.ops = [r.id];
          run.allOps = [...(run.allOps ?? []), r.id];
          if (a.op === "SetCanary") run.canaryOp = r.id;
          await saveRun(run); // tracked before anything else can fail
          await stepRecord(run, "queue", { op: a.op, id: r.id });
          await step(run.id, { kind: "decision", agent: "Main", model: "code", text: await queuedText(a.op, run.label, r.id), ref: `op #${r.id}` });
        } else if (a.t === "endCanary") {
          await endCanary(run.id);
        } else if (a.t === "fable") {
          const v = await gateRedTeam(run, a.purpose);
          if (v === undefined) deferred = true;
          else run.fable = { ...run.fable, [a.purpose]: v };
        } else if (a.t === "request") {
          await alert(a.text, `alert:promote:${run.id}`);
          await step(run.id, { kind: "next", agent: "Main", model: "code", text: "Canary passed: asked the Safe signers for PromoteActive." });
        } else if (a.t === "close") {
          await closeRun(run);
          // X: only an experiment whose test ran (a stage past the queued shadow) has an outcome worth a post
          if (before !== "queued_shadow") await enqueueOutcome(run, f.samples);
        } else if (a.t === "extend") {
          // honest on /lab and /mind: the stage is waiting for data, not passing without it
          const max = (TIMING.maxStretch - 1) * (run.stage === "shadow" ? TIMING.shadowMs : TIMING.canaryMs) / 3600_000;
          await stepRecord(run, "extend", { hours: a.hours, why: a.why });
          await step(run.id, { kind: "next", agent: "Main", model: "code", text: `Not enough data yet (${a.why}): ${run.stage} extended by 1 h (${a.hours} h of at most ${max} h), then closed as insufficient data if still short.` });
          await experimentRecord(run, run.stage === "canary" ? "canary" : "shadow", `${fmtV(run.vector)} · insufficient data so far: ${a.why}; ${run.stage} extended ${a.hours} h · uncalibrated`);
        }
      }
      if (run.stage !== before) {
        await stepRecord(run, "stage", { from: before, to: run.stage, reason: run.reason ?? null });
        if (run.stage !== "closed") await experimentRecord(run, run.stage === "canary" ? "canary" : run.stage === "queued_canary" ? "canary_queued" : "shadow");
        await coreRecord({ task: taskOf(run) });
      }
      await saveRun(run);
      if (deferred || run.stage === "closed" || actions.some((a) => a.t === "queue" || a.t === "endCanary" || a.t === "request")) break;
    }
    return deferred ? `${run.stage}: gate red team deferred (LLM cap); the next tick retries` : run.stage;
  },
};

/** The gate (Fable) red team inside the tick. An LLM-cap Defer must not fail the tick job: a deferred plates:tick would
 *  sit until tomorrow and schedule() coalesces every later tick behind it (no kill checks). Instead: one "deferred"
 *  step per UTC day, run.fable left unset, and the next tick (10 min) retries. undefined = deferred. */
export async function gateRedTeam(run: Run, purpose: "canary" | "promote", rt: (run: Run, stage: string, isGate: boolean) => Promise<boolean> = redTeamStage) {
  try {
    return await rt(run, purpose, true);
  } catch (e) {
    if (!(e instanceof Defer)) throw e;
    const day = nowIso().slice(0, 10);
    if (run.gateDeferred !== day) {
      run.gateDeferred = day;
      await step(run.id, { kind: "next", agent: "Red-team", model: "code", text: `Gate red team deferred: ${e.message}. The ${run.stage} waits; the next tick retries.`.slice(0, 1200) });
    }
    return undefined;
  }
}

/** A canary from a closed experiment's SetCanary that someone executed after the engine closed it (execute is
 *  permissionless): not accepted, so end it. Only when chain_log shows THAT op executed, after the newest SetCanary
 *  of anyone else: a canary the Safe set itself is never touched. */
async function orphanCanary() {
  const route = await pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "route" });
  if (ZERO.test(route.canary)) return;
  const [ours] = await sql`select 1 from thread t join chain_log e on e.event = 'Executed' and e.args->>'id' = t.data->>'canaryOp'
    where t.kind = 'fee' and t.stage = 'closed' and lower(t.data->>'plate') = ${route.canary.toLowerCase()} and not t.data ? 'canaryBlock'
      and not exists (select 1 from chain_log x where x.event = 'Executed' and (x.args->>'op')::int = 2 and (x.block, x.log_index) > (e.block, e.log_index))`;
  if (ours && (await mode()) === "live") await endCanary("orphan");
}

async function endCanary(ref: string) {
  const r = await send({ key: "agent", to: d.registry, abi: abi.registryAbi, fn: "endCanary", purpose: "agent:endCanary", emergency: true });
  if (r.status === "sim_revert" && /NoCanary/.test(r.error ?? "")) return r; // already ended
  if (r.status === "reverted" || r.status === "sim_revert") throw new Error(`endCanary (${ref}) ${r.status}: ${r.error ?? r.hash}`);
  return r;
}

const taskOf = (run: Run) => run.stage === "closed" ? "observing; next hypothesis next cycle" : `${run.stage.replace("_", " ")}: adaptive-fee plate ${run.label} (${run.id})`;

// ---------------------------------------------------------------- red team → security records

async function redTeamStage(run: Run, stage: string, isGate: boolean, extra: Record<string, unknown> = {}) {
  const out = await agents.redTeam(isGate, { stage, candidate: { plate: run.label, params: run.vector }, sim: run.simNumbers, gates: extra.gates ?? "passed at queue time", quotedHypothesis: run.hypothesis, context: extra });
  const model = isGate ? MODELS.redteamGate : MODELS.redteam;
  await record("plate", run.id, { event: "redteam", run: run.id, stage, model, verdict: out.data.verdict, findings: out.data.findings.length, at: nowIso() });
  for (const f of out.data.findings) {
    const id = `R-${String(await nextId("security")).padStart(4, "0")}`;
    const title = agents.sanitize(f.title), detail = agents.sanitize(f.detail);
    await record("security", id, { id, kind: "red-team", title, severity: f.severity, status: f.severity === "high" || f.severity === "medium" ? "open" : "accepted", detail, date: nowIso(), ref: `thread ${run.id}` });
    await step(run.id, { kind: "counter", agent: "Red-team", model, text: `${title}: ${detail}`, ref: `red-team ${id}` });
  }
  await step(run.id, { kind: out.data.verdict === "pass" ? "evidence+" : "evidence-", agent: "Red-team", model, text: `Red team (${stage}): ${out.data.verdict}, ${out.data.findings.length} finding(s).` });
  return out.data.verdict === "pass";
}

// ---------------------------------------------------------------- records: experiment, core, autonomy, memory

async function experimentRecord(run: Run, status: "shadow" | "canary_queued" | "canary" | "rejected" | "passed", note?: string) {
  const n = run.simNumbers;
  await record("experiment", run.exp, {
    id: run.exp, bench: run.bench, module: `adaptive-fee plate ${run.label}`, status, sim: run.sim, thread: run.id,
    metrics: [
      { name: "project ETH/day (ε=1)", delta: n.revenueDeltaPct ?? 0, unit: "%" },
      { name: "swap retention (ε=1)", delta: n.retentionDeltaPct ?? 0, unit: "%" },
      { name: "fee at cap", delta: n.capDeltaPct ?? 0, unit: "%" },
    ],
    note: note ?? `${fmtV(run.vector)} · ${run.stage.replace("_", " ")} · uncalibrated`,
  });
}

export async function coreRecord(over: Partial<{ task: string; hypothesis: string; confidence: number; next: string[]; stage: (typeof PIPELINE)[number] }>) {
  const prev = await latest<{ goal: string; task: string; hypothesis: string; confidence: number; next: string[]; stage?: string }>("core");
  await record("core", "core", {
    goal: GOAL, task: prev?.task ?? "observing", hypothesis: prev?.hypothesis ?? "no hypothesis yet", confidence: prev?.confidence ?? 0, next: prev?.next ?? [],
    ...(prev?.stage ? { stage: prev.stage } : {}), ...over, simulations: await count("sim"),
  });
}

export async function autonomyRecord() {
  const [r] = await sql<Record<string, number>[]>`select
    count(*) filter (where kind = 'sim')::int as simulations,
    count(*) filter (where kind = 'plate' and doc->>'event' = 'redteam')::int as "redteamRuns",
    count(*) filter (where kind = 'plate' and doc->>'event' = 'redteam' and doc->>'verdict' = 'pass')::int as "redteamPasses",
    count(*) filter (where kind = 'plate' and doc->>'event' = 'redteam' and doc->>'verdict' = 'block')::int as "redteamBlocks",
    count(*) filter (where kind = 'plate' and doc->>'event' = 'stage' and doc->>'to' = 'canary')::int as canaries,
    count(*) filter (where kind = 'plate' and doc->>'event' = 'stage' and doc->>'from' in ('canary', 'tune_queued', 'promote_queued', 'promote_requested') and doc->>'to' = 'closed' and doc->>'reason' like 'kill condition%')::int as "canariesKilled"
    from log where kind in ('sim', 'plate')`;
  const [{ passed }] = await sql<{ passed: number }[]>`select count(*)::int as passed from thread where kind = 'fee' and data->>'outcome' = 'accepted' and data->>'canaryBlock' is not null`;
  const [{ high }] = await sql<{ high: number }[]>`select count(*)::int as high from (select distinct on (ref) doc from log where kind = 'security' order by ref, seq desc) s
    where doc->>'severity' = 'high' and doc->>'status' = 'open'`;
  await record("autonomy", "attestations", { ...r, canariesPassed: passed, openHighFindings: high, at: nowIso() });
}

async function closeRun(run: Run) {
  const outcome = run.outcome!;
  const nums = { ...run.simNumbers, base: run.vector[0], mult: run.vector[1], cap: run.vector[2] };
  let text = { result: `${outcome === "accepted" ? "Accepted" : outcome === "rolled_back" ? "Rolled back" : "Rejected"}: ${run.reason}.`, futureRule: outcome === "accepted" ? "Keep the tested vector as the next baseline." : "Do not repeat this vector without new evidence." };
  try {
    const l = await agents.lesson({ outcome, reason: run.reason, plate: run.label, params: nums, stageReached: run.canaryBlock ? "canary" : "shadow" });
    const allowed = agents.allowedNumbers({ nums, reason: run.reason });
    const lt = { result: clean(l.data.result), futureRule: clean(l.data.futureRule) };
    if (agents.textOk(lt.result, allowed) && agents.textOk(lt.futureRule, allowed)) text = lt;
  } catch (e) {
    console.error("lesson failed, using the template", (e as Error).message);
  }
  const id = await nextId("memory");
  await sql.begin(async (tx) => {
    await record("memory", String(id), {
      id, title: run.title.slice(0, 200), hypothesis: run.hypothesis, decision: outcome, date: nowIso().slice(0, 10), ...text,
      method: `Fork replay for safety + analytic revenue at ε ∈ {0.5, 1, 2} (uncalibrated); shadow ≥ ${TIMING.shadowMs / 3600_000} h${run.canaryBlock ? `; canary ${TIMING.canaryLen}/${TIMING.canaryPeriod} blocks` : ""}.`,
      refs: [{ label: "thread", ref: run.id }, { label: "sim", ref: run.sim.replace("sim ", "") }, ...run.ops.map((o) => ({ label: "op", ref: `#${o}` }))],
    }, tx);
    await record("thread", run.id, { id: run.id, title: run.title, status: "decided", pipeline: pipeline("memory") }, tx);
  });
  await step(run.id, { kind: "decision", agent: "Main", model: "code", text: `Closed ${outcome}: ${run.reason}. Memory entry #${id}: ${text.futureRule}`, ref: `memory #${id}` });
  await experimentRecord(run, outcome === "accepted" ? "passed" : "rejected", `${fmtV(run.vector)} · ${run.reason}`);
  await coreRecord({ task: taskOf(run), stage: "memory", next: ["observe", "next hypothesis"] });
  await autonomyRecord();
}

const pipeline = (stage: (typeof PIPELINE)[number]) => PIPELINE.map((s) => ({ stage: s, current: s === stage }));

// ---------------------------------------------------------------- the 15-minute cycle

const clean = agents.sanitize;
const r3 = (x: number) => Number(x.toFixed(3));
const signed = (x: number) => (x > 0 ? `+${x}` : String(x));

/** The few numbers a cycle shows and Main sees (compact: no swap list, no history). leakagePct: the share of DNA
 *  volume that went through copy pools over the last ~day (src/clones.ts; null = not measured yet). A fee that only
 *  pushes volume there shows up here, not in the hook pool's own numbers. */
export type Brief = { block: number; feeSwaps: number; swapsPerDay: number; volumeEth: number; projectEth: number; realizedVolPct: number; meanPips: number; atCapPct: number; moduleFailed: number; shadowSamples: number; leakagePct: number | null };
export const briefOf = (s: Stats, block: number, leakagePct: number | null = null): Brief => ({
  block, feeSwaps: s.feeSwaps, swapsPerDay: s.swapsPerDay, volumeEth: s.volumeEth, projectEth: s.projectEth, realizedVolPct: s.realizedVolPct,
  meanPips: s.meanPips, atCapPct: pct(s.atCapShare), moduleFailed: s.moduleFailed, shadowSamples: s.shadowSamples, leakagePct,
});
/** Change since the previous cycle (null on the first one; a field missing or null on either side has no change). */
export const deltasOf = (prev: Brief | undefined, cur: Brief) =>
  prev ? (Object.fromEntries(Object.keys(cur).map((k) => {
    const [a, b] = [cur[k as keyof Brief], prev[k as keyof Brief]];
    return [k, a == null || b == null ? null : r3(a - b)];
  })) as Brief) : null;

/** Market regime buckets (log2): a candidate is "the same" for the red team only within one bucket. */
export const regimeOf = (s: { realizedVolPct: number; swapsPerDay: number }) => ({ vol: Math.round(Math.log2(1 + s.realizedVolPct)), flow: Math.round(Math.log2(1 + s.swapsPerDay)) });
export const candidateHash = (plate: string, v: Vector, regime: { vol: number; flow: number }) =>
  createHash("sha256").update(canonical({ plate: plate.toLowerCase(), v, regime })).digest("hex").slice(0, 16);

export type Seen = { hash: string; pass: boolean; go?: boolean; at: number };
export const SEEN_TTL_MS = 24 * 3600_000; // a reviewed verdict is reused for a day at most
/** The still-valid entry for a candidate (a missing or old `at` = expired). */
export const seenFor = (seen: Seen[], hash: string, now = Date.now()) => seen.find((x) => x.hash === hash && now - x.at < SEEN_TTL_MS);
export type RedTeamPlan = "gates" | "run" | "reuse-pass" | "reuse-block" | "limit";
/** The routine (Opus) red team runs only for a candidate that passed every deterministic gate AND differs materially
 *  (plate + vector + regime hash) from every recently red-teamed one; a known candidate reuses its verdict. */
export function redTeamPlan(gates: string[], hash: string, seen: Seen[], runsToday: number, limit = LIMITS.redteamPerDay, now = Date.now()): RedTeamPlan {
  if (gates.length) return "gates";
  const hit = seenFor(seen, hash, now);
  if (hit) return hit.pass ? "reuse-pass" : "reuse-block";
  return runsToday >= limit ? "limit" : "run";
}

type SafetyMark = { hash: string; block: number; safety: Safety; sim: string };
/** A fork safety result is reused for the same candidate+regime hash while its fork is < maxAge blocks old. */
export const reuseSafety = (prev: SafetyMark | undefined, hash: string, block: number, maxAge: number) =>
  prev && prev.hash === hash && block - prev.block < maxAge ? prev : undefined;

type ResearchMark = { at: number; vol: number; mentions: number; rounds: number };
/** Research (Grok + web/X search) only on a trigger, at most once per researchMinMs. */
export function researchTrigger(now: number, last: ResearchMark | undefined, cur: Omit<ResearchMark, "at">, t = TIMING): string | null {
  if (!last) return "no research yet";
  if (now - last.at < t.researchMinMs) return null;
  if (now - last.at >= t.researchEveryMs) return `the last research is ${Math.round(t.researchEveryMs / 3600_000)} h old`;
  if (cur.vol !== last.vol) return "the volatility regime changed";
  if (cur.mentions > last.mentions) return "new X mentions";
  if (cur.rounds > last.rounds) return "an idea round closed";
  return null;
}

/** Loop state between cycles (state key 'loop'). */
export type LoopState = {
  cycle: number; day?: string; cyclesToday?: number;
  thread?: string; threadCycles: number; threadAt?: number; // the open search thread
  prev?: Brief; lastSimBlock?: number; seen: Seen[]; research?: ResearchMark; lastSafety?: SafetyMark;
  last?: { title: string; hypothesis: string; vector: Vector; plate: string; why: string; revenueDeltaPct: number };
};
/** state.loop is enclave-signed: an unsigned or foreign value restarts from an empty loop state (and is alerted). */
export async function getLoop(): Promise<LoopState> {
  const [r] = await sql<{ value: LoopState; sig: string | null }[]>`select value, sig from state where key = 'loop'`;
  return r && (await trusted("state", "loop", r.value, r.sig)) ? r.value : { cycle: 0, threadCycles: 0, seen: [] };
}
export const setLoop = async (st: LoopState) => {
  const value = JSON.parse(JSON.stringify(st)) as LoopState;
  return sql`insert into state (key, block, value, sig) values ('loop', 0, ${sql.json(value as never)}, ${await stateSig("state", "loop", value)})
    on conflict (key) do update set value = excluded.value, sig = excluded.sig, updated_at = now()`;
};
function tick(st: LoopState) {
  const day = nowIso().slice(0, 10);
  st.cycle++;
  st.cyclesToday = st.day === day ? (st.cyclesToday ?? 0) + 1 : 1;
  st.day = day;
}

type QueueFn = (op: "SetParams" | "SetShadow", args: unknown[]) => Promise<{ status: string; id?: string }>;
/** Queue the run's remaining first-stage ops one at a time, saving after each, so a retried cycle job (daily cap or
 *  gas-guard Defer, a revert, an RPC error) resumes exactly where it stopped: never a second SetParams, never an
 *  untracked op. */
export async function queuePlanned(run: Run, queue: QueueFn, save: (run: Run) => Promise<unknown>, onQueued?: (op: string, id: string) => Promise<unknown>) {
  while (run.planned?.length) {
    const { op, args } = run.planned[0];
    const r = await queue(op, args);
    if (!r.id) throw new Error(`queue ${op}: ${r.status}`);
    run.ops = [...run.ops, r.id];
    run.allOps = [...(run.allOps ?? []), r.id];
    run.planned = run.planned.slice(1);
    await save(run);
    await onQueued?.(op, r.id);
  }
  return run;
}

/** Queue (or resume queueing) a started run's first-stage ops, then publish its shadow stage. */
async function startRun(run: Run, since?: Date) {
  await queuePlanned(run, (op, args) => queueOp(op, args, since), saveRun, async (op, id) =>
    step(run.id, { kind: "decision", agent: "Main", model: "code", text: await queuedText(op, run.label, id), ref: `op #${id}` }));
  await stepRecord(run, "stage", { from: null, to: run.stage });
  await experimentRecord(run, "shadow");
  await record("thread", run.id, { id: run.id, title: run.title, status: "open", pipeline: pipeline("canary") });
  await step(run.id, { kind: "next", agent: "Main", model: "code", text: `Shadow for ${TIMING.shadowMs / 3600_000} h, then a ${MODELS.redteamGate} red team before SetCanary.` });
  await coreRecord({ task: taskOf(run), confidence: run.confidence, stage: "canary", next: ["shadow samples", "red team before canary"] });
  await autonomyRecord();
  return { thread: run.id, go: true, ops: run.ops };
}

/** A vector chosen outside the search cycle (a ballot winner, a revealed mystery: src/games.ts) enters the same
 *  pipeline: one experiment at a time, a free plate, the policy/plate clamp, the analytic gates on the trailing 24 h,
 *  the pending-op ceiling, then the usual state machine. No fork replay here: the shadow stage and the gate red team
 *  stand in for it (disclosed). Returns the first queued op id, or why nothing was queued. */
export async function queueCandidate(c: { title: string; hypothesis: string; vector: Vector; source: string }, since?: Date): Promise<{ opId?: string; thread?: string; why?: string }> {
  if (await openRun()) return { why: "an experiment is already running" };
  const level = Number(await pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "level" }));
  if (level < 5) return { why: `autonomy level ${level} < 5` };
  const all = await plates();
  const timing = await registryTiming();
  const chainNow = Number((await pub.getBlock()).timestamp);
  const free = (p: Plate) => paramsFree(p.paramsAt, chainNow, timing);
  const target = all.find((p) => p.status === S.Shadow && free(p)) ?? all.find((p) => p.status === S.Proposed && free(p));
  if (!target) return { why: "no free AdaptiveFee plate" };
  const vector = clampVector(c.vector, target);
  const outside = boundsIssue(c.vector, vector); // a voted / sealed vector runs as voted or not at all
  if (outside) return { why: outside };
  const stats = await observeNow(24);
  const swaps = pair(await chainRows(["Swap", "FeeTaken"], stats.fromMs)).filter((s) => s.at < stats.toMs);
  const snap = await snapshot();
  const a = analytic(swaps, vector, (stats.toMs - stats.fromMs) / 86_400_000, capOf(snap?.value.route.active, snap?.value.route.activeParams));
  const gates = candidateGates(a, null, swaps.filter((s) => s.fee).length).filter((g) => !/^no fork replay/.test(g));
  if (gates.length) return { why: `gates failed: ${gates.join("; ")}` };
  const pendingCount = Number(await pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "pendingOf", args: [addressOf("agent")!] }));
  const need = target.status === S.Proposed ? 2 : 1;
  if (pendingCount + need > LIMITS.agentPending) return { why: `the agent already has ${pendingCount} pending ops (limit ${LIMITS.agentPending})` };
  const e1 = a.elasticity.find((x) => x.eps === 1)!;
  const simNumbers = { revenueDeltaPct: a.baseline.projectEthPerDay ? pct(e1.projectEthPerDay / a.baseline.projectEthPerDay - 1) : 0, retentionDeltaPct: pct(e1.swapRetention - 1), capDeltaPct: pct(a.candidate.atCapShare - a.baseline.atCapShare), swaps: swaps.length };
  const simN = await nextId("sim");
  const sim = `sim #${simN}`;
  const id = `T-${String(await nextId("thread")).padStart(4, "0")}`;
  await record("sim", sim, { id: sim, thread: id, label: "uncalibrated", harness: HARNESS, plate: target.label, params: vector, forkBlock: null, replayed: 0, safety: null, ...a });
  await record("thread", id, { id, title: c.title.slice(0, 200), status: "open", pipeline: pipeline("simulate") });
  await step(id, { kind: "hypothesis", agent: "Main", model: "code", text: `${c.hypothesis} (${c.source}) Candidate for plate ${target.label}: ${fmtV(vector)}.`.slice(0, 1200) });
  const run: Run = {
    id, title: c.title.slice(0, 200), hypothesis: c.hypothesis.slice(0, 300), plate: target.address, label: target.label, vector, stage: "queued_shadow", stageAt: Date.now(), source: c.source,
    ops: [], sim, exp: `E-${String(simN).padStart(4, "0")}`, bench: String(((simN - 1) % 3) + 1) as Run["bench"], confidence: 50, simNumbers,
    planned: [{ op: "SetParams", args: [target.address, vectorWords(vector)] }, ...(target.status === S.Proposed ? [{ op: "SetShadow" as const, args: [target.address] }] : [])],
  };
  await saveRun(run);
  await startRun(run, since);
  return { opId: run.ops[0], thread: id };
}

export const cycleHandler: Handler = {
  lane: "agent",
  run: async (job) => {
    const open = await openRun();
    if (open?.planned?.length) return startRun(open, job.created_at); // a retry: resume queueing, no new thread or LLM spend
    const st = await getLoop();
    tick(st);
    const stats = await observeNow(24);
    const cur = await cursorAgreed();
    // the chain data this cycle judged, by reference: anyone can replay eth_getLogs and recompute eventsSha256
    const judged = cur ? (await chainRows(CYCLE_EVENTS, stats.fromMs)).filter((r) => r.block <= cur.block) : [];
    await record("cycle", String(st.cycle), { cycle: st.cycle, chain: cur ? await chainRef(judged, cur.block, cur.hash, stats.fromMs) : null, ...(ENCLAVE.on ? { tcb: await tcbInfo() } : {}), at: nowIso() });
    const brief = briefOf(stats, cur?.block ?? 0, leakageFor(await latest<Leakage>("leakage"), cur?.block ?? 0));
    const delta = deltasOf(st.prev, brief);
    const out = open ? await monitorCycle(open, st, brief, delta) : await searchCycle(job.created_at, st, stats, brief, delta);
    st.prev = brief;
    await setLoop(st);
    return out;
  },
};

const marketLine = (n: number, b: Brief, dl: Brief | null) =>
  `Cycle ${n} · trailing 24 h: ${b.feeSwaps} fee-paying swaps${dl ? ` (${signed(dl.feeSwaps)} since the last cycle)` : ""}, ${b.volumeEth} ETH volume, ${b.projectEth} ETH project fees, realized volatility ${b.realizedVolPct}%, ${b.atCapPct}% at the cap, ${b.moduleFailed} module failures${b.leakagePct === null ? "" : `, ${b.leakagePct}% of DNA volume through copy pools`}.`;

/** An experiment is open: narrate it (cheaper model, template if the model is capped or its text fails the number
 *  check) and refresh the core record. No sim, no red team: the state machine (plates:tick) moves the experiment. */
async function monitorCycle(run: Run, st: LoopState, b: Brief, dl: Brief | null) {
  // the kill conditions are judged every cycle too (besides the 10-min tick and the watcher's immediate path)
  await enqueue("plates:tick", {}, { dedupeKey: `tick:cycle:${st.cycle}` });
  const hoursIn = Number(((Date.now() - run.stageAt) / 3600_000).toFixed(1));
  await step(run.id, { kind: "evidence+", agent: "Market", model: "code", text: `${marketLine(st.cycle, b, dl)} ${b.shadowSamples} shadow samples.`, ref: `block ${b.block}` });
  let text = `${run.stage.replace("_", " ")} for ${hoursIn} h; watching swap retention, time at the cap and module failures.`;
  let conf = run.confidence;
  let next = ["next cycle", run.stage === "shadow" ? "red team before canary" : "kill conditions"];
  let model = "code";
  try {
    const input = { stage: run.stage, plate: run.label, vector: run.vector, hoursInStage: hoursIn, now: b, change: dl, sim: run.simNumbers };
    const o = await agents.note(input);
    const allowed = agents.allowedNumbers(input);
    const t = clean(o.data.note);
    if (agents.textOk(t, allowed)) { text = t; conf = o.data.confidence; next = o.data.next.map(clean).filter(Boolean); model = o.model; }
  } catch (e) {
    console.error("cycle note failed, using the template", (e as Error).message);
  }
  await step(run.id, { kind: "confidence", agent: "Main", model, text: `${conf}% · ${text}`.slice(0, 1200), value: conf });
  await coreRecord({ task: `cycle ${st.cycle} · ${taskOf(run)} · ${hoursIn} h in stage`.slice(0, 200), confidence: conf, next: next.length ? next.slice(0, 3) : ["next cycle"] });
  return { thread: run.id, monitored: run.stage };
}

/** Close the open search thread into one memory entry (the cycles it ran, the last reason nothing was queued). */
async function closeSearch(st: LoopState) {
  const tid = st.thread!;
  const last = st.last;
  const nums = { cycles: st.threadCycles, revenueDeltaPct: last?.revenueDeltaPct ?? 0, base: last?.vector[0] ?? 0, mult: last?.vector[1] ?? 0, cap: last?.vector[2] ?? 0 };
  const reason = last?.why ?? "no candidate";
  let text = { result: `No candidate queued in ${st.threadCycles} cycles. Last: ${reason}.`.slice(0, 300), futureRule: "Keep searching only when the numbers move; do not repeat a rejected vector in the same regime." };
  try {
    const l = await agents.lesson({ outcome: "rejected", reason, cycles: st.threadCycles, params: nums, stageReached: "search" });
    const lt = { result: clean(l.data.result), futureRule: clean(l.data.futureRule) };
    const allowed = agents.allowedNumbers({ nums, reason });
    if (agents.textOk(lt.result, allowed) && agents.textOk(lt.futureRule, allowed)) text = lt;
  } catch (e) {
    console.error("search lesson failed, using the template", (e as Error).message);
  }
  const id = await nextId("memory");
  const title = last?.title ?? "Search for the next fee candidate";
  await sql.begin(async (tx) => {
    await record("memory", String(id), {
      id, title: title.slice(0, 200), hypothesis: (last?.hypothesis ?? "no hypothesis").slice(0, 600), decision: "rejected", date: nowIso().slice(0, 10), ...text,
      method: `${st.threadCycles} cycles of ${LOOP.cycleMs / 60_000} min: Main hypothesis, analytic revenue at ε ∈ {0.5, 1, 2} (uncalibrated) + fork replay, gates, red team for new candidates that passed.`,
      refs: [{ label: "thread", ref: tid }],
    }, tx);
    await record("thread", tid, { id: tid, title: title.slice(0, 200), status: "decided", pipeline: pipeline("memory") }, tx);
  });
  await step(tid, { kind: "decision", agent: "Main", model: "code", text: `Closed this search after ${st.threadCycles} cycles: memory entry #${id}. ${text.futureRule}`, ref: `memory #${id}` });
  st.thread = undefined;
  st.threadCycles = 0;
}

async function searchCycle(since: Date, st: LoopState, stats: Stats, b: Brief, dl: Brief | null) {
  const n = st.cycle;
  // a search thread that became an experiment (a crash between saving the run and the loop state) is not reused
  if (st.thread && (await sql`select 1 from thread where id = ${st.thread}`).length) { st.thread = undefined; st.threadCycles = 0; }
  const all = await plates();
  const active = all.find((p) => p.status === S.Active);
  const timing = await registryTiming();
  const chainNow = Number((await pub.getBlock()).timestamp);
  const free = (p: Plate) => paramsFree(p.paramsAt, chainNow, timing);
  const target = all.find((p) => p.status === S.Shadow && free(p)) ?? all.find((p) => p.status === S.Proposed && free(p));
  if (!target) {
    // an open search thread still counts this cycle (and closes when due); no new thread opens without a plate
    if (st.thread) {
      st.threadCycles++;
      await step(st.thread, { kind: "evidence-", agent: "Market", model: "code", text: `${marketLine(n, b, dl)} No free AdaptiveFee plate this cycle: no candidate.`, ref: `block ${b.block}` });
      if (st.threadCycles >= LOOP.searchCycles) await closeSearch(st);
    }
    await coreRecord({ task: `cycle ${n} · observing: no free AdaptiveFee plate (active, in canary, rolled back or inside its params epoch)` });
    return "no free AdaptiveFee plate";
  }
  if (st.thread && st.threadCycles >= LOOP.searchCycles) await closeSearch(st);
  if (!st.thread) {
    st.thread = `T-${String(await nextId("thread")).padStart(4, "0")}`;
    st.threadCycles = 0;
    st.threadAt = Date.now();
    await record("thread", st.thread, { id: st.thread, title: "Searching for the next fee candidate", status: "open", pipeline: pipeline("research") });
    await setLoop(st); // the thread id is owned before anything else can fail
  }
  const tid = st.thread;
  st.threadCycles++;
  const snap = await snapshot();
  const level = Number(await pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "level" }));
  await step(tid, { kind: "evidence+", agent: "Market", model: "code", text: marketLine(n, b, dl), ref: `block ${snap?.block ?? b.block}` });

  // research (tainted): on a trigger only, at most hourly; stored whole, Main sees ≤ 3 reduced claims
  const regime = regimeOf(stats);
  const [{ mentions }] = await sql<{ mentions: number }[]>`select count(*)::int as mentions from x_mention`;
  const [{ rounds }] = await sql<{ rounds: number }[]>`select count(*)::int as rounds from chain_log where event = 'RoundFinalized'`;
  const mark = { vol: regime.vol, mentions, rounds };
  const trigger = researchTrigger(Date.now(), st.research, mark);
  if (trigger) {
    // research failing (cap, provider, schema) never fails the cycle, and its hourly throttle covers failures too:
    // the mark is saved at once, so a retried cycle does not research again
    try {
      const r = await agents.research(RESEARCH_QUESTION, { trigger, stats: { swapsPerDay: b.swapsPerDay, realizedVolPct: b.realizedVolPct, meanPips: b.meanPips } }, [{ type: "web_search" }, { type: "x_search" }]);
      await record("research", "fee", { tainted: true, thread: tid, trigger, realizedVolPct: b.realizedVolPct, ...r.data, at: nowIso() });
      const red = agents.reduceResearch(r.data);
      await step(tid, { kind: "evidence+", agent: "Research", model: MODELS.research, text: clean(`Research (${trigger}; untrusted, ${red.claims.length} claims): ${red.claims[0] ?? "none"}`).slice(0, 1200) });
    } catch (e) {
      const why = e instanceof Defer ? "the research LLM budget for today is used" : `it failed (${clean((e as Error).message).slice(0, 200)})`;
      await step(tid, { kind: "evidence-", agent: "Research", model: "code", text: `Research skipped (${trigger}): ${why}. The last research stays in use; next try in ≥ ${TIMING.researchMinMs / 3600_000} h.` });
    } finally {
      st.research = { at: Date.now(), ...mark };
      await setLoop(st);
    }
  }
  const lastR = await latest<agents.ResearchOut>("research", "fee");
  const reduced = lastR ? { ...agents.reduceResearch(lastR), claims: agents.reduceResearch(lastR).claims.slice(0, 3) } : null;
  const rules = (await trustedDocs<{ futureRule?: string }>("memory", undefined, 10)).map((x) => x.futureRule).filter((r): r is string => !!r).slice(0, 3);

  // Main: compact input, low effort. Over the LLM cap: a code-only cycle, never a deferred cycle job
  let h0: Awaited<ReturnType<typeof agents.hypothesize>>;
  try {
    h0 = await agents.hypothesize({
      objective: GOAL, stats: b, deltas: dl, rules, research: reduced, activeParams: active?.params ?? `baseline ${pctOf(HOOK_FEES.baseline)} (no active plate)`,
      last: st.last ? { vector: st.last.vector, plate: st.last.plate, why: st.last.why } : null,
      plates: all.map((p) => ({ label: p.label, status: p.status, params: p.params, min: p.min, max: p.max })),
      policyBounds: POLICY,
    });
  } catch (e) {
    if (!(e instanceof Defer)) throw e;
    await step(tid, { kind: "next", agent: "Main", model: "code", text: `Main skipped this cycle: ${e.message}. Observing only until the budget resets.` });
    await coreRecord({ task: `cycle ${n} · observing (LLM budget reached for today)` });
    return { thread: tid, go: false, why: e.message };
  }
  const h = { ...h0, data: { ...h0.data, title: clean(h0.data.title), hypothesis: clean(h0.data.hypothesis), evidenceFor: clean(h0.data.evidenceFor), evidenceAgainst: clean(h0.data.evidenceAgainst), next: h0.data.next.map(clean) } };
  const asked: Vector = [h.data.params.base, h.data.params.mult, h.data.params.cap];
  const vector = clampVector(asked, target);
  const changed = !st.last || !same(st.last.vector, vector) || st.last.plate !== target.label;
  await record("thread", tid, { id: tid, title: h.data.title, status: "open", pipeline: pipeline("simulate") });
  await step(tid, { kind: "hypothesis", agent: "Main", model: h.model, text: `${h.data.hypothesis} Candidate for plate ${target.label}: ${fmtV(vector)}${same(asked, vector) ? "" : " (clamped to the policy and plate bounds)"}.`.slice(0, 1200) });
  if (changed) {
    await step(tid, { kind: "evidence+", agent: "Main", model: h.model, text: h.data.evidenceFor });
    await step(tid, { kind: "evidence-", agent: "Main", model: h.model, text: h.data.evidenceAgainst });
  }
  await coreRecord({ hypothesis: h.data.hypothesis, confidence: h.data.confidence, next: h.data.next.length ? h.data.next : ["simulate", "red team"], task: `cycle ${n} · simulating ${fmtV(vector)}`, stage: "simulate" });

  // simulate: analytic revenue (no fork) + fork replay of the new swaps and a fixed recent window on the long-lived fork
  const rows = await chainRows(["Swap", "FeeTaken"], stats.fromMs);
  const swaps: Paired[] = pair(rows).filter((s) => s.at < stats.toMs);
  const days = (stats.toMs - stats.fromMs) / 86_400_000;
  const capOld = capOf(snap?.value.route.active, snap?.value.route.activeParams);
  const a = analytic(swaps, vector, days, capOld);
  let safety: Safety | null = null;
  let simError: string | undefined;
  const replay = replaySet(swaps, st.lastSimBlock, Number(process.env.SIM_REPLAY_WINDOW ?? 50), Number(process.env.SIM_MAX_SWAPS ?? 200));
  const hash = candidateHash(target.address, vector, regime);
  // the same candidate in the same regime on a fork < SIM_REUSE_BLOCKS old: its fork safety result is reused (each
  // replay costs ~300–550 upstream RPC calls, docs/CAPACITY.md); the analytic revenue is always recomputed
  const reused = reuseSafety(st.lastSafety, hash, b.block, Number(process.env.SIM_REUSE_BLOCKS ?? 300));
  let forkBlock = b.block;
  if (reused) { safety = reused.safety; forkBlock = reused.block; }
  else if (replay.length >= GATES.minSwaps) {
    try {
      safety = await forkReplay({ url: process.env.SIM_FORK_RPC_URL ?? RPC_URLS[0], block: forkBlock, hook: d.hook, registry: d.registry, token: d.token, poolManager: d.poolManager }, target.address, vector, replay);
      st.lastSimBlock = forkBlock;
    } catch (e) {
      simError = (e as Error).message.slice(0, 300);
    }
  }
  const simN = await nextId("sim");
  const simId = `sim #${simN}`;
  await record("sim", simId, { id: simId, thread: tid, label: "uncalibrated", harness: HARNESS, plate: target.label, params: vector, forkBlock: safety ? forkBlock : null, replayed: safety?.replayed ?? 0, safety, ...a });
  if (safety && !reused) st.lastSafety = { hash, block: forkBlock, safety, sim: simId };
  const e1 = a.elasticity.find((x) => x.eps === 1)!;
  const simNumbers = {
    revenueDeltaPct: a.baseline.projectEthPerDay ? pct(e1.projectEthPerDay / a.baseline.projectEthPerDay - 1) : 0,
    retentionDeltaPct: pct(e1.swapRetention - 1), capDeltaPct: pct(a.candidate.atCapShare - a.baseline.atCapShare),
    baselineEthPerDay: a.baseline.projectEthPerDay, candidateEthPerDay: e1.projectEthPerDay, swaps: swaps.length,
    candidateReverts: safety?.candidateReverts ?? -1, moduleFailed: safety?.moduleFailed ?? -1, maxGasDelta: safety?.maxGasDelta ?? -1,
  };
  const gates = candidateGates(a, safety, swaps.filter((s) => s.fee).length);
  if (simError) gates.push(`fork replay failed: ${simError}`);
  await step(tid, { kind: gates.length ? "evidence-" : "evidence+", agent: "Simulation", model: HARNESS, ref: simId,
    text: `Uncalibrated. At ε=1: project fees ${e1.projectEthPerDay} vs ${a.baseline.projectEthPerDay} ETH/day (${simNumbers.revenueDeltaPct}%), swap retention ${pct(e1.swapRetention)}%, time at cap ${pct(a.candidate.atCapShare)}%. ${reused ? `(Fork replay reused from ${reused.sim}: same candidate and regime, fork at block ${reused.block}.) ` : ""}${safety ? `Replay of ${safety.replayed} swaps: ${safety.candidateReverts} extra reverts, ${safety.moduleFailed} module failures, +${safety.maxGasDelta} gas max, ${safety.clamped} clamped by the canary bound.` : "No fork replay."}` });

  const bench = String(((simN - 1) % 3) + 1) as Run["bench"];
  const exp = `E-${String(simN).padStart(4, "0")}`;
  const run: Run = { id: tid, title: h.data.title, hypothesis: h.data.hypothesis, plate: target.address, label: target.label, vector, stage: "queued_shadow", stageAt: Date.now(), ops: [], sim: simId, exp, bench, confidence: h.data.confidence, simNumbers };

  // red team: routine model only for a NEW candidate that passed every gate (verdicts reused by plate+vector+regime for ≤ 24 h)
  const [{ rt }] = await sql<{ rt: number }[]>`select count(*)::int as rt from log where kind = 'plate' and doc->>'event' = 'redteam' and doc->>'model' = ${MODELS.redteam}
    and at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`;
  const plan = redTeamPlan(gates, hash, st.seen, rt);
  const remember = (s: Seen) => { st.seen = [s, ...st.seen.filter((x) => x.hash !== s.hash)].slice(0, 32); };
  let go = false;
  let conf = h.data.confidence;
  let why = "";
  if (plan === "gates") why = `gates failed: ${gates.join("; ")}`;
  else if (plan === "limit") why = `the daily maximum of ${LIMITS.redteamPerDay} routine red-team runs is reached`;
  else if (plan === "reuse-block") why = "the red team blocked this same candidate in this market regime";
  else if (plan === "reuse-pass") await step(tid, { kind: "evidence+", agent: "Red-team", model: "code", text: `Red team not re-run: this candidate passed in the same market regime (${hash}).` });
  else {
    await record("thread", tid, { id: tid, title: h.data.title, status: "open", pipeline: pipeline("red-team") });
    try {
      const pass = await redTeamStage(run, "candidate", false, { gates });
      remember({ hash, pass, at: Date.now() });
      if (!pass) why = "the red team blocked it";
    } catch (e) {
      if (!(e instanceof Defer)) throw e;
      why = "the red-team LLM budget for today is used";
    }
  }
  if (!why) {
    const known = seenFor(st.seen, hash)?.go;
    if (known === false) why = "Main said no-go to this same candidate in this regime";
    else {
      try {
        const dcs = await agents.decide({ hypothesis: h.data.hypothesis, params: vector, sim: simNumbers, gates: "all passed", redTeam: "pass", level, mode: await mode() });
        go = dcs.data.go;
        conf = dcs.data.confidence;
        const reason = clean(dcs.data.reason);
        remember({ hash, pass: true, go, at: Date.now() });
        why = go ? reason : `Main said no-go: ${reason}`;
        await step(tid, { kind: "confidence", agent: "Main", model: dcs.model, text: `${conf}% · ${reason}`, value: conf });
      } catch (e) {
        if (!(e instanceof Defer)) throw e;
        why = "the Main LLM budget for today is used";
      }
    }
  }
  const m = await mode();
  if (go && m !== "live") { go = false; why = `engine is ${m}: would queue SetParams(plate ${run.label}, ${fmtV(vector)})${target.status === S.Proposed ? " + SetShadow" : ""}`; }
  if (go && level < 5) { go = false; why = `autonomy level ${level} < 5: the agent may not tune plates; the Safe can queue SetParams(${target.address}, ${fmtV(vector)})`; await alert(`Candidate ready (${tid}): ${why}.`, `alert:candidate:${tid}`); }
  let pendingCount = 0;
  if (go) pendingCount = Number(await pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "pendingOf", args: [addressOf("agent")!] }));
  const need = target.status === S.Proposed ? 2 : 1;
  if (go && pendingCount + need > LIMITS.agentPending) { go = false; why = `the agent already has ${pendingCount} pending ops (limit ${LIMITS.agentPending})`; }
  st.last = { title: h.data.title, hypothesis: h.data.hypothesis, vector, plate: target.label, why: why.slice(0, 300), revenueDeltaPct: simNumbers.revenueDeltaPct };

  if (!go) {
    await step(tid, { kind: "decision", agent: "Main", model: "code", text: `No change queued: ${why}.`.slice(0, 1200) });
    run.stage = "closed"; run.outcome = "rejected"; run.reason = why.slice(0, 300);
    await experimentRecord(run, "rejected", `${fmtV(vector)} · ${why}`.slice(0, 300));
    await coreRecord({ task: `cycle ${n} · searching: last candidate not queued (${why})`.slice(0, 200), confidence: conf, next: ["next cycle", "observe"], stage: "simulate" });
    await autonomyRecord();
    return { thread: tid, go: false, why };
  }
  // saved BEFORE the first queue: the run owns its ops from the first one, and a retry resumes it
  run.confidence = conf;
  run.planned = [{ op: "SetParams", args: [target.address, vectorWords(vector)] }, ...(target.status === S.Proposed ? [{ op: "SetShadow" as const, args: [target.address] }] : [])];
  await saveRun(run);
  st.thread = undefined; // the search thread continues as this experiment's thread
  st.threadCycles = 0;
  await setLoop(st);
  return startRun(run, since);
}

// ---------------------------------------------------------------- pulse (hourly) and the pre-launch cycle

/** Hourly: a short "today so far" journal record (ref 'pulse', newest wins) so /journal and the home readouts move
 *  every hour. Numbers from SQL only, no LLM. The daily journal for a day supersedes its pulse on the site. */
export const pulseHandler: Handler = {
  lane: "default",
  run: async () => {
    const day = nowIso().slice(0, 10);
    const [j, st, core, mem] = await Promise.all([
      journalNumbers(day), getLoop(), latest<{ task: string }>("core"),
      sql<{ r: string }[]>`select doc->>'futureRule' as r from log where kind = 'memory' and doc->>'futureRule' is not null and at >= ${new Date(`${day}T00:00:00Z`)} order by seq desc limit 1`,
    ]);
    const n = j.numbers;
    const cycles = st.day === day ? (st.cyclesToday ?? 0) : 0;
    const hh = nowIso().slice(11, 13);
    await record("journal", "pulse", {
      day: j.day, date: day, pulse: true,
      summary: `Today so far (${hh}:00 UTC): ${cycles} cycles, ${n.simulated} simulated, ${n.rejected} rejected, ${n.swaps} swaps, ${n.projectEth} ETH in project fees.`,
      learned: mem[0]?.r ?? "Nothing closed yet today.",
      tomorrow: `Now: ${core?.task ?? "observing"}`.slice(0, 400),
      stats: [
        { label: "cycles", value: String(cycles) }, { label: "swaps", value: String(n.swaps) }, { label: "project fees", value: `${n.projectEth} ETH` },
        { label: "simulated", value: String(n.simulated) }, { label: "rejected", value: String(n.rejected) }, { label: "red-team", value: String(n.redTeam) },
      ],
      autonomy: j.autonomy,
    });
    return { day: j.day, cycles };
  },
};

/** Revenue of a flat project fee f (pips) vs the hook's baseline on unit volume, volume ∝ total fee^−ε (+ the platform fee). */
export const flatRevenue = (f: number, eps: number) => {
  const { baseline: b, platform: pf } = HOOK_FEES;
  return Number(((f / b) * ((f + pf) / (b + pf)) ** -eps).toFixed(3));
};

/** ENGINE_PRELAUNCH: no chain yet, so a cycle every CYCLE_MS steps an analytic fee sweep (code only, no LLM, no RPC)
 *  into the genesis thread and refreshes the core record: the site moves at the launch cadence from day 0. */
export const prelaunchCycleHandler: Handler = {
  lane: "agent",
  run: async () => {
    if (!(await latest("thread", "G-0000"))) return "genesis not written yet";
    const st = await getLoop();
    tick(st);
    const grid = Array.from({ length: 11 }, (_, i) => 10_000 + i * 2_500); // 1.00% … 3.50%
    const f = grid[(st.cycle - 1) % grid.length];
    const r = Object.fromEntries(GATES.eps.map((e) => [e, flatRevenue(f, e)]));
    await step("G-0000", { kind: "evidence+", agent: "Simulation", model: HARNESS, text: `Pre-launch cycle ${st.cycle} (analytic only, uncalibrated, nothing ran on DNA's pool): a flat ${(f / 1e4).toFixed(2)}% project fee earns ${r[0.5]}× (ε=0.5), ${r[1]}× (ε=1), ${r[2]}× (ε=2) the ${pctOf(HOOK_FEES.baseline)} baseline's revenue on unit volume.` });
    await coreRecord({ task: `pre-launch cycle ${st.cycle}: analytic fee sweep at ${(f / 1e4).toFixed(2)}%`, next: ["launch", "observe"] });
    await setLoop(st);
    return { cycle: st.cycle, feePips: f };
  },
};

// ---------------------------------------------------------------- journal (00:05 UTC, for the day that ended)

export async function journalNumbers(day: string) {
  const from = Date.parse(`${day}T00:00:00Z`);
  const to = from + 86_400_000;
  const [rows, ideas, eng, lvl, first] = await Promise.all([
    chainRows(["Swap", "FeeTaken"], from),
    // ideas that came in that day: holders' on-chain submissions and ideas from X the intake took in (the agent's own
    // submissions are those X ideas going on-chain: not counted twice)
    sql<{ n: number }[]>`select ((select count(*) from chain_log where event = 'IdeaSubmitted' and at >= ${new Date(from)} and at < ${new Date(to)} and lower(args->>'author') <> ${addressOf("agent")?.toLowerCase() ?? ""})
      + (select count(*) from intake where at >= ${new Date(from)} and at < ${new Date(to)} and status in ('candidate', 'picked', 'submitted', 'not_picked', 'queued', 'rejected')))::int as n`,
    sql<{ sims: number; rejected: number; redteam: number; canaries: number }[]>`select
      count(*) filter (where kind = 'sim')::int as sims,
      count(*) filter (where kind = 'memory' and doc->>'decision' <> 'accepted')::int as rejected,
      count(*) filter (where kind = 'plate' and doc->>'event' = 'redteam')::int as redteam,
      count(*) filter (where kind = 'plate' and doc->>'event' = 'stage' and doc->>'to' = 'canary')::int as canaries
      from log where at >= ${new Date(from)} and at < ${new Date(to)}`,
    sql<{ from: number; to: number }[]>`select (args->>'from')::int as from, (args->>'to')::int as to from chain_log where event = 'LevelSet' and at >= ${new Date(from)} and at < ${new Date(to)} order by block, log_index`,
    sql<{ at: Date }[]>`select at from log order by seq limit 1`,
  ]);
  const st = stats(pair(rows), { fromMs: from, toMs: to, capPips: 50_000 });
  const level = (await snapshot())?.value.level ?? 0;
  const dayN = first[0] ? Math.floor((from - Date.parse(first[0].at.toISOString().slice(0, 10))) / 86_400_000) + 1 : 1;
  return {
    day: dayN, date: day,
    numbers: { swaps: st.feeSwaps, volumeEth: st.volumeEth, projectEth: st.projectEth, ideas: ideas[0].n, simulated: eng[0].sims, rejected: eng[0].rejected, redTeam: eng[0].redteam, canaries: eng[0].canaries, level },
    autonomy: lvl.length ? `${lvl[0].from} → ${lvl.at(-1)!.to}` : `${level} → ${level}`,
  };
}

export const journalHandler: Handler = {
  lane: "agent",
  run: async (job) => {
    const day = String(job.payload.day);
    if (await latest("journal", day)) return "already written";
    const j = await journalNumbers(day);
    const n = j.numbers;
    let text = {
      summary: `${n.swaps} swaps, ${n.volumeEth} ETH volume, ${n.projectEth} ETH in project fees. ${n.simulated} simulated, ${n.rejected} rejected, ${n.redTeam} red-team runs.`,
      learned: n.simulated ? "See the memory entries for today's decisions." : "No experiment closed today.",
      tomorrow: "Observe, then the next daily hypothesis.",
    };
    try {
      const out = await agents.journalText({ date: day, ...n });
      const allowed = agents.allowedNumbers({ ...n, day: j.day, date: day.split("-").map(Number) });
      if (Object.values(out.data).every((t) => agents.textOk(t, allowed))) text = out.data;
    } catch (e) {
      console.error("journal text failed, using the template", (e as Error).message);
    }
    const stats = [
      { label: "swaps", value: String(n.swaps) }, { label: "project fees", value: `${n.projectEth} ETH` },
      { label: "ideas", value: String(n.ideas) }, { label: "simulated", value: String(n.simulated) },
      { label: "rejected", value: String(n.rejected) }, { label: "red-team", value: String(n.redTeam) },
    ];
    await record("journal", day, { day: j.day, date: day, ...text, stats, autonomy: j.autonomy });
    // X hears it as the nightly reflection, in its own words (the lines are screened before any writer sees them);
    // a day before the engine's first record (day < 1, a first boot's previous day) has nothing to reflect on
    if (j.day >= 1) await enqueueReflection(day, text);
    return { day: j.day };
  },
};

// ---------------------------------------------------------------- genesis (pre-launch: research + analytic only)

export const genesisHandler: Handler = {
  lane: "agent",
  run: async () => {
    const tid = "G-0000";
    if (await latest("thread", tid)) return "genesis already written";
    const title = "Genesis, pre-launch: how dynamic fees behave on Claus and other Uniswap v4 hook pools";
    await record("thread", tid, { id: tid, title, status: "open", genesis: true, pipeline: pipeline("research") });
    const r = await agents.research(
      "For each pool below (Uniswap v4, Ethereum mainnet), how does its hook set fees, what fee levels has it charged, and what happened to volume when fees rose? Cite sources.",
      { pools: GENESIS_POOLS.map((p) => ({ name: p.name, poolId: p.poolId, hook: p.hook, mechanism: p.mechanism })) },
      [{ type: "web_search" }, { type: "x_search" }],
    );
    await record("research", "genesis", { tainted: true, thread: tid, genesis: true, ...r.data, at: nowIso() });
    for (const p of GENESIS_POOLS) await step(tid, { kind: "evidence+", agent: "Research", model: MODELS.research, text: `${p.name}: ${p.mechanism}`, ref: `pool ${p.poolId.slice(0, 10)}…` });
    // analytic only: revenue of a flat fee f vs the hook's baseline on unit volume, volume ∝ total fee^−ε (+ the platform fee)
    const table = [10_000, 15_000, 20_000, HOOK_FEES.baseline, 25_000, 35_000].map((f) => ({ // the baseline row reads 1.0×
      feePct: f / 1e4,
      revenueVsBaseline: Object.fromEntries(GATES.eps.map((e) => [`eps${e}`, flatRevenue(f, e)])),
    }));
    await step(tid, { kind: "evidence+", agent: "Simulation", model: HARNESS, text: `Analytic only (no replay: nothing ran on DNA's pool). Revenue vs the ${pctOf(HOOK_FEES.baseline)} baseline on unit volume at 3.5%: ${table[5].revenueVsBaseline.eps0_5}× (ε=0.5), ${table[5].revenueVsBaseline.eps1}× (ε=1), ${table[5].revenueVsBaseline.eps2}× (ε=2). Uncalibrated.` });
    const g = await agents.genesisSynthesis({ claims: agents.reduceResearch(r.data), analytic: table, pools: GENESIS_POOLS.map((p) => p.name) });
    const allowed = agents.allowedNumbers({ table, claims: r.data.findings.map((f) => f.claim) });
    for (const e0 of g.data.entries) {
      const e = { title: clean(e0.title), hypothesis: clean(e0.hypothesis), method: clean(e0.method), result: clean(e0.result), futureRule: clean(e0.futureRule) };
      const id = await nextId("memory");
      await record("memory", String(id), { id, genesis: true, title: `Genesis, pre-launch: ${e.title}`.slice(0, 200), hypothesis: e.hypothesis, method: e.method, result: e.result, decision: "accepted", futureRule: e.futureRule, refs: [{ label: "thread", ref: tid }, ...GENESIS_POOLS.slice(0, 3).map((p) => ({ label: "pool", ref: p.poolId.slice(0, 10) }))], date: nowIso().slice(0, 10) });
    }
    await step(tid, { kind: "decision", agent: "Main", model: MODELS.grok, text: clean(`Genesis, pre-launch: ${g.data.summary}`).slice(0, 1200) });
    await record("thread", tid, { id: tid, title, status: "decided", genesis: true, pipeline: pipeline("memory") });
    const ok = [g.data.summary, g.data.learned, g.data.tomorrow].every((t) => agents.textOk(t, allowed));
    await record("journal", "genesis", {
      day: 0, date: nowIso().slice(0, 10), genesis: true,
      summary: ok ? `Genesis, pre-launch: ${g.data.summary}`.slice(0, 400) : `Genesis, pre-launch: researched Claus and ${GENESIS_POOLS.length - 1} other dynamic-fee v4 pools; analytic fee table only.`,
      learned: ok ? g.data.learned : "Dynamic fees trade revenue per swap against swap count; the elasticity is unknown until DNA trades.",
      tomorrow: ok ? g.data.tomorrow : "Launch, then observe before any experiment.",
      stats: [{ label: "pools researched", value: String(GENESIS_POOLS.length) }, { label: "memory entries", value: String(g.data.entries.length) }],
      autonomy: "pre-launch",
    });
    await coreRecord({ hypothesis: clean(g.data.entries[0].hypothesis).slice(0, 400), task: "pre-launch research (genesis)", confidence: 0, next: ["launch", "observe"], stage: "memory" });
    return { thread: tid, entries: g.data.entries.length };
  },
};
