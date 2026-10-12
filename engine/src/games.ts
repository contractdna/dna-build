// The game layer, off-chain (contracts/SPEC.md §12–§14).
// Keepers (keeper key, permissionless calls): each decided by a pure `due` rule from chain state, then SIMULATED
// quietly, so an on-chain gate that says "not yet" (PrizeTooSmall, GasTooHigh, a cooldown) costs nothing and logs nothing.
//  - GamePot (holder jackpot): rollWindow once the open window ended; requestDraw from a posted list's eta; settle with
//    the 10 winners' walk (every drawn leaf + proof) from our own list record once VRF delivered; voidDraw
//    DRAW_SETTLE_WINDOW after an unsettled fulfilment; abortDraw after VRF_TIMEOUT; rescueToBuyback only when the
//    contract allows it; executeDrawInterval after its delay; payReward once a queued idea reward's public hour is
//    over; expireClaim after CLAIM_WINDOW (draw shares and rewards alike); recreateSubscription once the coordinator
//    no longer knows it.
//  - MutationBoard: markBroken once a sealed mystery's reveal window passed; reveal our own mysteries (the preimage is
//    sealed in `secret` with the same key provider as the X token).
// Agent tasks (agent key; live mode, level ≥ 5, unpaused; numbers deterministic, the LLM only names and narrates):
//  - the jackpot's params and ticket list: src/jackpot.ts.
//  - the ballot (every BALLOT_EVERY, only while ≥ 1% of DNA is staked): 3 options that pass the deterministic gates
//    now; the winner goes through loop.queueCandidate and the board records ballotRun(…, opId), else ballotSkipped.
//  - the mystery sealer: payload = a candidate vector, keccak256(salt ‖ payload) sealed REVEAL_MIN + 1 h out; at reveal
//    the payload is gated like any candidate (mysteryRun / mysteryRejected).
//  - drawInterval: the interval at which the jackpot inflow reaches DRAW_TARGET_PRIZE, within [12 h, maxInterval (24 h)],
//    proposed only when it differs from the current one by > 25%, or the current one is above maxInterval.
import { HOOK_FEES } from "./hook-fees.ts";
import { randomBytes } from "node:crypto";
import { type Abi, type Address, BaseError, ContractFunctionRevertedError, encodePacked, type Hex, keccak256, parseAbi, stringToHex, toHex } from "viem";
import { z } from "zod";
import * as abi from "./abi.ts";
import { d, KEEPER, LOG_BASE_URL } from "./config.ts";
import { edb as sql } from "./db.ts";
import { Defer, type Handler, type Job } from "./jobs.ts";
import { agentCall, keeperJob } from "./keepers.ts";
import { alert } from "./telegram.ts";
import { linkIssues, phraseIssue } from "./voice.ts";
import { llm } from "./llm.ts";
import { prompt, sys } from "./persona.ts";
import { canonical } from "./log.ts";
import { mode } from "./mode.ts";
import { capOf, chainRows, observeNow, pair, snapshot } from "./observe.ts";
import { clampVector, MODELS, type Vector } from "./policy.ts";
import { latest, nowIso, record } from "./records.ts";
import { seal, unseal } from "./sealed.ts";
import { analytic, candidateGates } from "./sim.ts";
import { addressOf, pub, send } from "./tx.ts";

const H = 3600, DAY = 86_400;
/** Contract constants (GamePot / ConvictionVault / MutationBoard, contracts/SPEC.md §12–§14), seconds. */
export const C = {
  VRF_TIMEOUT: 36 * H, STALL: 14 * DAY, CLAIM_WINDOW: 7 * DAY, DRAW_SETTLE_WINDOW: 7 * DAY, QUEUE_DELAY: H, BUDGET_PERIOD: 24 * H,
  MIN_INTERVAL: 12 * H, MAX_INTERVAL: 3 * DAY, BALLOT_EVERY: 48 * H, VOTING: 24 * H, VETO_WINDOW: H, REVEAL_MIN: 2 * DAY, REVEAL_WINDOW: 24 * H,
  MIN_PRIZE: 25n * 10n ** 16n, MIN_REWARD: 10n ** 16n, MAX_REWARD_BPS: 2500n, MIN_LEVEL: 5,
} as const;
/** Engine policy for the agent's game tasks (published; the contract bounds stay the hard limits). */
export const GAME_POLICY = {
  drawTargetPrize: 10n ** 18n, // drawInterval: aim for ~1 ETH a draw
  intervalChange: 0.25, // propose a new interval only when it moves > 25%
  // draws never wait longer than this (DRAW_MAX_INTERVAL_H, default 24), kept within the contract's [12 h, 3 d]
  maxInterval: Math.min(C.MAX_INTERVAL, Math.max(C.MIN_INTERVAL, Math.round(Number(process.env.DRAW_MAX_INTERVAL_H) || 24) * H)),
  mysteryEveryS: 7 * DAY, // a new mystery each week (the contract allows one sealed at a time)
  ballotMinStakedBps: 100n, // ballots only while ≥ 1% of DNA is staked
  // simplification: sync() is ~48k gas, ~0.000003 ETH at ~0.06 gwei, so any arrival worth showing is worth counting
  syncMin: 10n ** 16n, // 0.01 ETH: below it the jackpot on the site doesn't move enough to matter
  // at most one small sync per distribute period (hourly): arrivals land with distribute(). simplification: judged from
  // the latest finalized Synced, so right after one, a lagging indexer can let up to 2 more through that hour
  syncEveryS: KEEPER.intervalMs / 1000,
};

// ---------------------------------------------------------------- pure decisions (unit-tested)

export type PotView = {
  now: number; draw: { window: number; eta: number; reqId: bigint; requestedAt: number; fulfilledAt: number }; windowEnd: number; stalledSince: number;
  arrived: bigint; // fees above every liability that no sync() has counted yet
  lastSync: number; // the latest indexed Synced (any caller, requestDraw's own included), 0 = none
  overCap: boolean; // counting them would push the jackpot over POT_CAP (the excess goes to BuybackBurn)
  pending: { eta: number };
};
export type PotAction = "rescueToBuyback" | "abortDraw" | "rollWindow" | "requestDraw" | "settle" | "voidDraw" | "executeDrawInterval" | "sync";
/** What the GamePot can be asked to do now, in order (a due roll before the interval change it unblocks). */
export function potActions(s: PotView): PotAction[] {
  const out: PotAction[] = [];
  const { draw: d } = s;
  const requested = d.reqId !== 0n && d.fulfilledAt === 0;
  if (requested && s.now >= d.requestedAt + C.VRF_TIMEOUT) out.push(s.stalledSince !== 0 && s.now >= s.stalledSince + C.STALL ? "rescueToBuyback" : "abortDraw");
  if (s.windowEnd !== 0 && s.now >= s.windowEnd) out.push("rollWindow");
  if (d.window !== 0 && d.reqId === 0n && d.fulfilledAt === 0 && s.now >= d.eta) out.push("requestDraw");
  if (d.fulfilledAt !== 0) out.push(s.now >= d.fulfilledAt + C.DRAW_SETTLE_WINDOW ? "voidDraw" : "settle");
  if (s.pending.eta !== 0 && s.now >= s.pending.eta) out.push("executeDrawInterval");
  // arrivals counted into the jackpot and the idea reserve (a requestDraw that goes out syncs on its own: keeper:games
  // skips this then; one held back by a gate, PrizeTooSmall or GasTooHigh, doesn't, so the jackpot still moves)
  // so the jackpot people see keeps up: at least syncMin waiting, once a distribute period; right away when a minimum
  // prize is waiting or the jackpot would cross POT_CAP
  const small = s.arrived >= GAME_POLICY.syncMin && s.now >= s.lastSync + GAME_POLICY.syncEveryS;
  if (small || s.arrived >= C.MIN_PRIZE || s.overCap) out.push("sync");
  return out;
}

/** A VRF request open this long (s) pages: the node normally answers in minutes; an underfunded subscription or a changed
 *  coordinator config leaves it pending until abortDraw at VRF_TIMEOUT. */
export const VRF_ALERT_S = 30 * 60;
export const vrfOverdue = (dr: PotView["draw"], now: number) => dr.reqId !== 0n && dr.fulfilledAt === 0 && now >= dr.requestedAt + VRF_ALERT_S;

/** FeeVault fell back to its 35/35/30/0 baseline (games off) although the registry has a split module: the module
 *  reverts, runs out of its gas cap or returns shares out of bounds. A zero module is the expected baseline (before the
 *  launch split, or after a split rollback). */
export const splitFellBack = (module: string, baseline: boolean) => baseline && BigInt(module) !== 0n;

/** Simulation reverts that only mean "not yet" or "someone else did it" (gates, races): the keeper waits quietly. Any
 *  other revert of a game tx (a VRF coordinator error, a bad list or proof, a lost proposer right) alerts. */
export const QUIET_REVERTS: Record<string, readonly string[]> = {
  "*": ["TooEarly", "InFlight", "NotInFlight", "NothingPending", "NotFulfilled", "AlreadyClaimed", "RollFirst"],
  requestDraw: ["PrizeTooSmall", "GasTooHigh", "NoList"],
  rescueToBuyback: ["NotStalled"],
  recreateSubscription: ["SubscriptionLive"],
  payReward: ["Unauthorized"], // the agent is paused or below level 5: nothing pays until it is back (GamePot.payReward)
  markBroken: ["BadStatus"],
  reveal: ["BadStatus"],
};
export const unexpectedRevert = (fn: string, why: string) => !QUIET_REVERTS["*"].includes(why) && !QUIET_REVERTS[fn]?.includes(why);

/** Queued idea rewards whose public hour is over (amount 0 = paid or cancelled on chain). payReward re-judges the rest
 *  (agent paused, proposer, excluded recipient): its quiet simulation says "Unauthorized" and nothing is sent. */
export const rewardsDue = (rewards: { id: number; amount: bigint; eta: number }[], now: number) =>
  rewards.filter((r) => r.amount > 0n && now >= r.eta).map((r) => r.id);

/** Prizes (draw shares and idea rewards whose push failed) that can be returned to the jackpot. */
export const expiredClaims = (prizes: { drawId: number; wonAt: number; claimed: boolean }[], now: number) =>
  prizes.filter((p) => !p.claimed && p.wonAt !== 0 && now >= p.wonAt + C.CLAIM_WINDOW).map((p) => p.drawId);

/** MysteryStatus: 0 None, 1 Sealed, 2 Revealed, 3 Run, 4 Rejected, 5 Broken, 6 Cancelled. */
export const brokenDue = (m: { status: number; revealAt: number }, now: number) => m.status === 1 && now >= m.revealAt + C.REVEAL_WINDOW;
export const revealDue = (m: { status: number; revealAt: number }, now: number) => m.status === 1 && now >= m.revealAt && now < m.revealAt + C.REVEAL_WINDOW;

/** The interval at which the jackpot reaches the target prize, rounded to the hour and clamped to [12 h, maxInterval];
 *  null = keep the current one (within ±25%, or no inflow). A current interval above maxInterval is always brought
 *  down to it, so an interval set before the cap gets undone. */
export function desiredInterval(jackpotInflowPerDayWei: bigint, current: number, p = GAME_POLICY): number | null {
  const over = current > p.maxInterval;
  if (jackpotInflowPerDayWei <= 0n) return over ? p.maxInterval : null;
  const raw = Number((p.drawTargetPrize * BigInt(DAY)) / jackpotInflowPerDayWei);
  const v = Math.min(p.maxInterval, Math.max(C.MIN_INTERVAL, Math.round(raw / H) * H));
  return over || Math.abs(v - current) / current > p.intervalChange ? v : null;
}

/** Three distinct ballot vectors around a base vector (deterministic), before gating. */
export function ballotCandidates(base: Vector): Vector[] {
  const steps: Vector[] = [[2_500, 0, 2_500], [-2_500, 0, -2_500], [0, 2_000, 5_000], [5_000, 0, 5_000], [-5_000, 0, 0], [0, -2_000, 0]];
  const seen = new Set<string>();
  const out: Vector[] = [];
  for (const s of steps) {
    const v = clampVector([base[0] + s[0], base[1] + s[1], base[2] + s[2]]);
    const k = v.join(",");
    if (!seen.has(k) && k !== clampVector(base).join(",")) { seen.add(k); out.push(v); }
  }
  return out;
}

/** Holders vote only while ≥ 1% of DNA is staked; below that the AI runs its own experiments. */
export const ballotsOpen = (totalLocked: bigint, supply: bigint, p = GAME_POLICY) => supply > 0n && totalLocked * 10_000n >= supply * p.ballotMinStakedBps;
/** The label the site and the X posts use for those experiments. */
export const VOTES_CLOSED = "AI pick (votes open at 1% staked)";

/** Records are keyed by the id the contract will assign; they are ours only if they match what is on chain. */
export const sameDescriptors = (rec: readonly string[] | undefined, chain: readonly unknown[]) =>
  !!rec && rec.length === chain.length && rec.every((x, i) => x.toLowerCase() === String(chain[i]).toLowerCase());

/** keccak256(salt ‖ payload), exactly MutationBoard's commitment. */
export const commitmentOf = (salt: Hex, payload: Hex) => keccak256(encodePacked(["bytes32", "bytes"], [salt, payload]));

// ---------------------------------------------------------------- chain reads

const rd = <T>(address: Address, a: readonly unknown[], functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi: a as never, functionName, args } as never) as Promise<T>;
const chainNow = async () => Number((await pub.getBlock()).timestamp);

/** The revert's error name, or null if the call would succeed. RPC errors throw (the job retries). */
export async function quietSim(key: "keeper" | "agent", address: Address, a: readonly unknown[], functionName: string, args: unknown[] = []): Promise<string | null> {
  try {
    await pub.simulateContract({ account: addressOf(key)!, address, abi: a as Abi, functionName, args } as never);
    return null;
  } catch (e) {
    const r = e instanceof BaseError ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null;
    if (!r) throw e;
    return r.data?.errorName ?? r.shortMessage ?? "reverted";
  }
}

async function potView(): Promise<PotView> {
  const g = d.gamePot!;
  const [draw, windowEnd, stalledSince, pend, now] = await Promise.all([
    rd<readonly [bigint, number, number, number, bigint, bigint, Hex, bigint, bigint, bigint]>(g, abi.gamePotAbi, "draw"), rd<number>(g, abi.gamePotAbi, "windowEnd"),
    rd<bigint>(g, abi.gamePotAbi, "stalledSince"), rd<readonly [number, number, Address]>(g, abi.gamePotAbi, "pendingInterval"), chainNow(),
  ]);
  const { potState } = await import("./jackpot.ts");
  const { arrived, overCap } = await potState(pub);
  const [last] = await sql<{ at: Date }[]>`select at from chain_log where event = 'Synced' order by block desc, log_index desc limit 1`;
  return {
    now, draw: { window: Number(draw[0]), eta: Number(draw[1]), requestedAt: Number(draw[2]), fulfilledAt: Number(draw[3]), reqId: draw[5] }, windowEnd: Number(windowEnd),
    stalledSince: Number(stalledSince), arrived, overCap, lastSync: last ? Math.floor(last.at.getTime() / 1000) : 0, pending: { eta: Number(pend[1]) },
  };
}

const keeper = (job: Job) => ({ key: "keeper" as const, since: job.created_at });
/** Time-critical keeper calls: the emergency gas ceiling (a reveal missed is a broken mystery; a draw left open blocks
 *  the next one). */
const URGENT = new Set(["reveal", "abortDraw", "settle"]);
/** Simulate, then send (send() re-estimates, applies the gas ceiling, the daily cap, dry_run and halted). */
async function act(job: Job, address: Address, a: readonly unknown[], fn: string, args: unknown[] = [], gasMin?: bigint) {
  const why = await quietSim("keeper", address, a, fn, args);
  if (why && unexpectedRevert(fn, why)) {
    await alert(`Game tx ${fn}${args.length ? `(${args.map(String).join(", ").slice(0, 80)})` : ""} would revert: ${why.slice(0, 200)}. Not sent; the keeper re-simulates every run. Not a "not yet" gate: check the contract state${fn === "requestDraw" ? " and the VRF coordinator's config and subscription" : ""}.`, `alert:gamesim:${fn}:${why.slice(0, 60)}:${new Date().toISOString().slice(0, 10)}`);
  }
  if (why) return { fn, waiting: why };
  return { fn, ...(await send({ ...keeper(job), to: address, abi: a, fn, args, purpose: `keeper:game:${fn}`, emergency: URGENT.has(fn), gasMin })) };
}
/** settle's gas-limit floor: the measured worst case (GamePot.t.sol test_gas_settleWorstCase (c), 1,629,213: 17-level
 *  proofs × 32 tickets × 10 cold failing receivers) + ~10%. A receiver that passes eth_estimateGas but burns its
 *  PUSH_GAS at inclusion would otherwise make every retry revert LowGas until the draw is voided. */
export const SETTLE_GAS_MIN = 1_800_000n;
/** Runs each action on its own: a gas Defer on one never holds back the next; the first Defer is rethrown at the end
 *  (the job retries later) once every other action had its turn. */
function actions() {
  const out: unknown[] = [];
  let deferred: Defer | undefined;
  return {
    out,
    async do(p: () => Promise<unknown>) {
      try { out.push(await p()); } catch (e) { if (!(e instanceof Defer)) throw e; deferred ??= e; out.push({ deferred: e.message }); }
    },
    done() { if (deferred) throw deferred; return out; },
  };
}

// ---------------------------------------------------------------- keepers

export const gameKeeperHandlers: Record<string, Handler> = {
  /** GamePot + MutationBoard: every EXECUTE_INTERVAL. */
  "keeper:games": keeperJob(async (job) => {
    if (!d.gamePot) return "no GamePot in the deployment";
    const run = actions();
    const v = await potView();
    for (const a of potActions(v)) {
      if (a === "settle") { await run.do(() => settleDraw(job)); continue; }
      if (a === "sync" && run.out.some((x) => (x as { fn?: string }).fn === "requestDraw" && !(x as { waiting?: string }).waiting)) continue;
      await run.do(() => act(job, d.gamePot!, abi.gamePotAbi, a));
    }
    // a cancelled VRF subscription (getSubscription reverts) between draws: recreate it
    if (v.draw.reqId === 0n && d.vrfCoordinator) {
      const subId = await rd<bigint>(d.gamePot, abi.gamePotAbi, "subId");
      const gone = await pub.readContract({ address: d.vrfCoordinator, abi: parseAbi(["function getSubscription(uint256) view returns (uint96, uint96, uint64, address, address[])"]), functionName: "getSubscription", args: [subId] }).then(() => false, (e) => e instanceof BaseError && !!e.walk((x) => x instanceof ContractFunctionRevertedError));
      if (gone) await run.do(() => act(job, d.gamePot!, abi.gamePotAbi, "recreateSubscription"));
    }
    // queued idea rewards whose public hour is over (candidates: indexed RewardQueued rows minus paid / cancelled;
    // confirmed on chain): anyone may pay them, the keeper does
    const queued = await sql<{ id: number }[]>`select (args->>'id')::int as id from chain_log q where q.event = 'RewardQueued'
      and not exists (select 1 from chain_log x where x.event in ('RewardPaid', 'RewardCancelled') and x.args->>'id' = q.args->>'id') order by 1`;
    const rewards = await Promise.all(queued.map(async ({ id }) => {
      const r = await rd<readonly [Address, bigint, Address, number, Hex]>(d.gamePot!, abi.gamePotAbi, "rewards", [BigInt(id)]); // (to, amount, proposer, eta, ideaRef)
      return { id, amount: r[1], eta: Number(r[3]) };
    }));
    for (const id of rewardsDue(rewards, v.now)) await run.do(() => act(job, d.gamePot!, abi.gamePotAbi, "payReward", [BigInt(id)]));
    // unclaimed prizes and rewards past CLAIM_WINDOW (candidates: the claim ids of indexed failed pushes, Winner.prizeId
    // and RewardPaid.claimId != 0, minus claimed / expired; confirmed on chain)
    const open = await sql<{ id: number }[]>`select c.id from (
        select (args->>'prizeId')::int as id from chain_log where event = 'Winner' and args->>'prizeId' <> '0'
        union select (args->>'claimId')::int from chain_log where event = 'RewardPaid' and args->>'claimId' <> '0') c
      where not exists (select 1 from chain_log x where x.event in ('PrizeClaimed', 'PrizeExpired') and x.args->>'drawId' = c.id::text) order by 1`;
    const prizes = await Promise.all(open.map(async ({ id }) => {
      const p = await rd<readonly [Address, bigint, number]>(d.gamePot!, abi.gamePotAbi, "prizes", [BigInt(id)]); // (winner, amount, wonAt); amount 0 = claimed or expired
      return { drawId: id, wonAt: Number(p[2]), claimed: p[1] === 0n };
    }));
    for (const id of expiredClaims(prizes, v.now)) await run.do(() => act(job, d.gamePot!, abi.gamePotAbi, "expireClaim", [BigInt(id)]));
    if (d.mutationBoard) {
      const id = await rd<bigint>(d.mutationBoard, abi.mutationBoardAbi, "pendingMystery");
      if (id !== 0n) {
        const m = await rd<readonly [Hex, number, number, Address]>(d.mutationBoard, abi.mutationBoardAbi, "mysteries", [id]);
        const mv = { status: Number(m[2]), revealAt: Number(m[1]) };
        if (revealDue(mv, v.now)) await run.do(() => revealOurs(job, id, m[0]));
        else if (brokenDue(mv, v.now)) await run.do(() => act(job, d.mutationBoard!, abi.mutationBoardAbi, "markBroken", [id]));
      }
    }
    return run.done();
  }),

};

/** Fail-closed conditions nothing else pages (minute checks, every mode): the fee split fell back to the baseline with a
 *  module set, and a VRF request pending > VRF_ALERT_S. Each alert once a UTC day per module / request. */
export async function failClosedChecks(now = Math.floor(Date.now() / 1000)) {
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const [route, split] = await Promise.all([
    rd<{ module: Address }>(d.registry, abi.registryAbi, "splitRoute"), rd<readonly [bigint, bigint, bigint, bigint, boolean]>(d.feeVault, abi.feeVaultAbi, "currentSplit"),
  ]);
  if (splitFellBack(route.module, split[4])) {
    await alert(`Fee split fell back to 35/35/30/0 (games off) although split module ${route.module} is set: it reverts, runs out of gas or returns shares out of bounds. Every distribute() until it is fixed sends nothing to the games. Safe: rollback the split or register a working module.`, `alert:splitfallback:${route.module.toLowerCase()}:${day}`);
  }
  if (!d.gamePot) return;
  const dr = await rd<readonly [bigint, number, number, number, bigint, bigint]>(d.gamePot, abi.gamePotAbi, "draw");
  const draw = { window: Number(dr[0]), eta: Number(dr[1]), requestedAt: Number(dr[2]), fulfilledAt: Number(dr[3]), reqId: dr[5] };
  if (vrfOverdue(draw, now)) {
    const subId = await rd<bigint>(d.gamePot, abi.gamePotAbi, "subId");
    await alert(`VRF request ${draw.reqId} (window ${draw.window}) unfulfilled for ${Math.floor((now - draw.requestedAt) / 60)} min. Check subscription ${subId} on the coordinator: anyone can top it up with fundSubscriptionWithNative(${subId}). abortDraw opens ${C.VRF_TIMEOUT / H} h after the request; after a 14-day stall anyone can rescueToBuyback.`, `alert:vrf:${draw.reqId}:${day}`);
  }
}

/** settle(leaves, proofs) for the fulfilled draw: the 10-winner walk over our own list record. Not ours (a Safe-posted
 *  list): anyone else can settle it; voidDraw after DRAW_SETTLE_WINDOW. */
async function settleDraw(job: Job) {
  const draw = await rd<readonly [bigint, number, number, number, bigint, bigint, Hex, bigint, bigint]>(d.gamePot!, abi.gamePotAbi, "draw");
  const { settleArgs } = await import("./jackpot.ts");
  const a = await settleArgs(Number(draw[0]), draw[6], draw[8], (x) => rd<boolean>(d.gamePot!, abi.gamePotAbi, "isExcluded", [x]));
  if (!a) return { fn: "settle", waiting: "no list record of ours matches the draw's root" };
  return act(job, d.gamePot!, abi.gamePotAbi, "settle", [a.leaves, a.proofs], SETTLE_GAS_MIN);
}

// ---------------------------------------------------------------- mystery preimages (sealed at rest)

const mysteryKey = (commitment: Hex) => `mystery:${commitment.toLowerCase()}`;
export async function storePreimage(commitment: Hex, salt: Hex, payload: Hex) {
  await sql`insert into secret (key, value) values (${mysteryKey(commitment)}, ${await seal("mystery", JSON.stringify({ salt, payload }))}) on conflict (key) do nothing`;
}
export async function loadPreimage(commitment: Hex) {
  const [r] = await sql<{ value: string }[]>`select value from secret where key = ${mysteryKey(commitment)}`;
  const open = r ? await unseal("mystery", r.value) : null;
  const p = open ? (JSON.parse(open) as { salt: Hex; payload: Hex }) : null;
  return p && commitmentOf(p.salt, p.payload) === commitment.toLowerCase() ? p : null; // never reveal what doesn't match
}

async function revealOurs(job: Job, id: bigint, commitment: Hex) {
  const p = await loadPreimage(commitment);
  if (!p) return { fn: "reveal", waiting: "not our mystery (no preimage)" };
  return act(job, d.mutationBoard!, abi.mutationBoardAbi, "reveal", [id, p.salt, p.payload]);
}

// ---------------------------------------------------------------- agent tasks

const Names = z.object({ names: z.array(z.string().min(1).max(40)).length(3) });
/** LLM names are display text: one short phrase each, no digits / links / handles / banned terms; else the fallback. */
const nameOk = (n: string) => !/\p{N}/u.test(n) && !linkIssues(n).length && phraseIssue(n.split(/\s+/).slice(0, 4).join(" ")) === null;

async function nameBallot(vectors: Vector[]) {
  const fallback = ["Option A", "Option B", "Option C"];
  try {
    const r = await llm({ agent: "game-namer", model: MODELS.narrate, schema: Names, maxOutputTokens: 300, effort: "low",
      system: sys("game-namer", prompt("game-namer")), input: { options: vectors.map((v) => ({ basePct: v[0] / 1e4, multiplier: v[1] / 1e4, capPct: v[2] / 1e4 })) } });
    return r.data.names.map((n, i) => (nameOk(n) ? n.trim() : fallback[i]));
  } catch {
    return fallback;
  }
}

const agentOk = async () => {
  const [level, paused, agent] = await Promise.all([rd<number>(d.registry, abi.registryAbi, "level"), rd<boolean>(d.registry, abi.registryAbi, "agentPaused"), rd<Address>(d.registry, abi.registryAbi, "agent")]);
  return Number(level) >= C.MIN_LEVEL && !paused && agent.toLowerCase() === addressOf("agent")?.toLowerCase();
};
/** Every game agent tx: anchored and mined first in the enclave (keepers.agentCall), after its decision record. */
const agentSend = (to: Address, a: readonly unknown[], fn: string, args: unknown[], purpose: string, since?: Date) => agentCall({ to, abi: a, fn, args, purpose, since });

/** The base vector options and mysteries start from: the active plate's params, else the hook's baseline. */
async function baseVector(): Promise<Vector> {
  const snap = await snapshot();
  const r = snap?.value.route;
  return r && !/^0x0{40}$/i.test(r.active) ? (r.activeParams.slice(0, 3).map((h) => Number(BigInt(h))) as Vector) : [HOOK_FEES.baseline, 0, HOOK_FEES.baseline];
}
/** Vectors that pass the deterministic analytic gates on the trailing 24 h (fork replay waits for the shadow stage). */
async function gated(vs: Vector[]) {
  const stats = await observeNow(24);
  const swaps = pair(await chainRows(["Swap", "FeeTaken"], stats.fromMs)).filter((s) => s.at < stats.toMs);
  const snap = await snapshot();
  const capOld = capOf(snap?.value.route.active, snap?.value.route.activeParams);
  return vs.filter((v) => !candidateGates(analytic(swaps, v, (stats.toMs - stats.fromMs) / 86_400_000, capOld), null, swaps.filter((s) => s.fee).length).filter((g) => !/^no fork replay/.test(g)).length);
}
const fmt = (v: Vector) => `base ${(v[0] / 1e4).toFixed(2)}%, multiplier ${(v[1] / 1e4).toFixed(2)}×, cap ${(v[2] / 1e4).toFixed(2)}%`;

/** loop.queueCandidate, behind a seam (tests stand in for the experiment pipeline). */
export const GAME_DEPS = {
  queueCandidate: async (...a: Parameters<typeof import("./loop.ts").queueCandidate>) => (await import("./loop.ts")).queueCandidate(...a),
  openRun: async () => (await import("./loop.ts")).openRun(),
};
/** The run `source` already started: queueCandidate saved it, then a Defer (gas guard, daily cap, hold, halted) cut
 *  the call short, and a retry must not read its own run as "an experiment is already running". */
async function startedBy(source: string): Promise<Result | undefined> {
  const open = await GAME_DEPS.openRun();
  if (open?.source !== source) return undefined;
  const first = open.allOps?.[0] ?? open.ops[0]; // ops moves on with the stages (SetCanary's id later); allOps keeps the first
  if (!first) throw new Defer(60_000, "the winner's op is not queued yet");
  return { opId: first, thread: open.id };
}

type BallotRec = { kind: "ballot"; descriptors: Hex[]; options: { name: string; vector: Vector; descriptor: Hex }[]; ballot?: number };
type Result = { option?: number; opId?: string; thread?: string; skipped?: string };
export const descriptorOf = (o: { name: string; vector: Vector }) => keccak256(stringToHex(canonical({ name: o.name, vector: o.vector })));

async function ballotTask(since: Date, now: number) {
  const b = d.mutationBoard!;
  const count = await rd<bigint>(b, abi.mutationBoardAbi, "ballotCount");
  if (count > 0n) {
    const [descs, , end, cancelled, resolved] = await rd<readonly [Hex[], bigint, bigint, boolean, boolean, bigint[]]>(b, abi.mutationBoardAbi, "ballots", [count]);
    if (!cancelled && !resolved) {
      if (now < Number(end)) return "ballot voting";
      const w = Number(await rd<number>(b, abi.mutationBoardAbi, "winner", [count]));
      const found = await latest<BallotRec & { result?: Result }>("game", `ballot:${count}`);
      if (!found || !sameDescriptors(found.descriptors, descs)) return "the open ballot is not ours (no matching option record): the Safe resolves it";
      const rec = { kind: found.kind, descriptors: found.descriptors, options: found.options, ballot: found.ballot };
      const opt = rec.options[w];
      if (!opt) return "the winning option has no record";
      // the decision is recorded BEFORE the board call: a retry resends that call and never queues the winner twice
      let res = found.result;
      const own = res ? undefined : await startedBy(`ballot ${count}`);
      if (own) {
        res = { option: w, ...own };
        await record("game", `ballot:${count}`, { ...rec, result: res, at: nowIso() });
      }
      if (!res) {
        const r = await GAME_DEPS.queueCandidate({ title: `Ballot ${count} winner: ${opt.name}`, hypothesis: `Holders voted for ${fmt(opt.vector)}; it goes next in line for testing if it still passes the safety checks.`, vector: opt.vector, source: `ballot ${count}` }, since);
        res = r.opId ? { option: w, opId: r.opId, thread: r.thread } : { option: w, skipped: (r.why ?? "not queued").slice(0, 300) };
        await record("game", `ballot:${count}`, { ...rec, result: res, at: nowIso() });
      }
      if (res.opId) {
        await agentSend(b, abi.mutationBoardAbi, "ballotRun", [count, res.option ?? w, BigInt(res.opId)], "agent:game:ballotRun", since);
        return { ballot: Number(count), run: res.opId };
      }
      await agentSend(b, abi.mutationBoardAbi, "ballotSkipped", [count, keccak256(stringToHex(res.skipped ?? ""))], "agent:game:ballotSkipped", since);
      return { ballot: Number(count), skipped: res.skipped };
    }
  }
  const last = Number(await rd<bigint>(b, abi.mutationBoardAbi, "lastBallotAt"));
  if (last !== 0 && now < last + C.BALLOT_EVERY) return "a ballot within the last 48 h already";
  if (d.convictionVault) {
    const [locked, supply] = await Promise.all([rd<bigint>(d.convictionVault, abi.convictionVaultAbi, "totalLocked"), rd<bigint>(d.token, abi.tokenAbi, "totalSupply")]);
    if (!ballotsOpen(locked, supply)) return VOTES_CLOSED;
  }
  const vectors = (await gated(ballotCandidates(await baseVector()))).slice(0, 3);
  if (vectors.length < 3) {
    await record("game", "ballot:skipped", { kind: "ballot-skipped", reason: `only ${vectors.length} options pass the gates`, at: nowIso() });
    return "fewer than 3 options pass the gates";
  }
  const names = await nameBallot(vectors);
  const options = vectors.map((vector, i) => ({ name: names[i], vector, descriptor: descriptorOf({ name: names[i], vector }) }));
  const descriptors = options.map((o) => o.descriptor);
  // recorded BEFORE the proposal: anyone can check a descriptor against its option (name + vector)
  await record("game", `ballot:${count + 1n}`, { kind: "ballot", descriptors, options, ballot: Number(count + 1n), at: nowIso() } satisfies BallotRec & { at: string });
  return { proposed: (await agentSend(b, abi.mutationBoardAbi, "propose", [descriptors], "agent:game:propose", since)).status };
}

type MysteryPayload = { op: "SetParams"; vector: Vector };
async function mysteryTask(since: Date, now: number) {
  const b = d.mutationBoard!;
  const id = await rd<bigint>(b, abi.mutationBoardAbi, "pendingMystery");
  const count = await rd<bigint>(b, abi.mutationBoardAbi, "mysteryCount");
  // a revealed mystery of ours waits for its verdict, wherever it is (an older one can sit behind a newer seal, or behind
  // a later Run / Rejected). simplification: every mystery read hourly; at ≤ 1 seal a week that is ~52 calls a year
  for (let i = count; i > 0n; i--) {
    const m = await rd<readonly [Hex, number, number, Address]>(b, abi.mutationBoardAbi, "mysteries", [i]);
    const status = Number(m[2]);
    if (status === 2 && m[3].toLowerCase() === addressOf("agent")?.toLowerCase()) return mysteryVerdict(i, m[0], since);
  }
  if (id !== 0n) return "a mystery is sealed";
  const lastSeal = await sql<{ at: Date }[]>`select at from chain_log where event = 'Sealed' order by block desc limit 1`;
  if (lastSeal[0] && Date.now() - lastSeal[0].at.getTime() < GAME_POLICY.mysteryEveryS * 1000) return "mystery cadence";
  const vs = await gated(ballotCandidates(await baseVector()));
  if (!vs.length) return "no candidate passes the gates for a mystery";
  const payload = stringToHex(canonical({ op: "SetParams", vector: vs[vs.length - 1] } satisfies MysteryPayload));
  const salt = toHex(randomBytes(32));
  const commitment = commitmentOf(salt, payload);
  await storePreimage(commitment, salt, payload); // before the seal: a crash after it never loses the preimage
  await record("game", `mystery:${commitment}`, { kind: "mystery", commitment, at: nowIso() }); // the commitment only, never the payload
  return { sealed: (await agentSend(b, abi.mutationBoardAbi, "seal", [commitment, BigInt(now + C.REVEAL_MIN + H)], "agent:game:seal", since)).status };
}

async function mysteryVerdict(i: bigint, commitment: Hex, since: Date) {
  const b = d.mutationBoard!;
  const found = await latest<{ result?: Result }>("game", `mystery:${i}`);
  let res = found?.result;
  const own = res ? undefined : await startedBy(`mystery ${i}`);
  if (own) {
    res = own;
    await record("game", `mystery:${i}`, { kind: "mystery-result", result: res, at: nowIso() });
  }
  if (!res) {
    const pre = await loadPreimage(commitment);
    let p: MysteryPayload | undefined;
    try { p = pre ? JSON.parse(Buffer.from(pre.payload.slice(2), "hex").toString("utf8")) : undefined; } catch { /* not ours */ }
    if (!p || p.op !== "SetParams" || p.vector?.length !== 3) return "revealed payload not readable";
    const r = await GAME_DEPS.queueCandidate({ title: `Mystery ${i}: ${fmt(p.vector)}`, hypothesis: `Sealed on-chain at least two days ago: ${fmt(p.vector)}.`, vector: p.vector, source: `mystery ${i}` }, since);
    res = r.opId ? { opId: r.opId, thread: r.thread } : { skipped: (r.why ?? "not queued").slice(0, 300) };
    await record("game", `mystery:${i}`, { kind: "mystery-result", result: res, at: nowIso() }); // before the board call (as ballots)
  }
  if (res.opId) {
    await agentSend(b, abi.mutationBoardAbi, "mysteryRun", [i, BigInt(res.opId)], "agent:game:mysteryRun", since);
    return { mystery: Number(i), run: res.opId };
  }
  await agentSend(b, abi.mutationBoardAbi, "mysteryRejected", [i, keccak256(stringToHex(res.skipped ?? ""))], "agent:game:mysteryRejected", since);
  return { mystery: Number(i), rejected: res.skipped };
}

async function intervalTask(since: Date) {
  const g = d.gamePot!;
  const [pend, current] = await Promise.all([rd<readonly [number, number, Address]>(g, abi.gamePotAbi, "pendingInterval"), rd<number>(g, abi.gamePotAbi, "drawInterval")]);
  if (Number(pend[1]) !== 0) return "an interval change is pending";
  const [{ s }] = await sql<{ s: string | null }[]>`select sum((args->>'arrived')::numeric)::text as s from chain_log where event = 'Synced' and at >= ${new Date(Date.now() - 7 * DAY * 1000)}`;
  const v = desiredInterval((BigInt(s ?? 0) * 7_000n) / 10_000n / 7n, Number(current));
  if (v === null) return "the draw interval stays";
  await record("game", "interval", { kind: "interval", interval: v, current: Number(current), at: nowIso() }); // the decision, before the call
  return { interval: v, ...(await agentSend(g, abi.gamePotAbi, "proposeDrawInterval", [v], "agent:game:proposeDrawInterval", since)) };
}

async function jackpotError(task: string, e: unknown) {
  if (e instanceof Defer) throw e; // gas, halted: the whole job waits as usual
  const msg = (e as Error).message.slice(0, 300);
  await alert(`Jackpot ${task} task failed: ${msg}`, `alert:jackpot:${task}:${new Date().toISOString().slice(0, 13)}`);
  return `error: ${msg}`;
}

/** Hourly, agent lane (serial with the loop): jackpot params + list, ballot, mystery, draw interval. Live only, level ≥ 5. */
export const gameAgentHandler: Handler = {
  lane: "agent",
  run: async (job) => {
    if (!d.gamePot && !d.mutationBoard) return "no game contracts in the deployment";
    if ((await mode()) !== "live") return "engine not live: game tasks wait";
    if (!(await agentOk())) return "agent level < 5, paused or not our key";
    const now = await chainNow();
    const out: Record<string, unknown> = {};
    if (d.mutationBoard) {
      out.ballot = await ballotTask(job.created_at, now);
      out.mystery = await mysteryTask(job.created_at, now);
    }
    if (d.gamePot) {
      // the jackpot's tasks never hold the others back: an error (RPC providers disagreeing, a lagging indexer) is
      // alerted and retried next hour
      const { listTask, paramsTask } = await import("./jackpot.ts");
      out.jackpotList = await listTask(job.created_at, now).catch((e) => jackpotError("list", e));
      out.jackpotParams = await paramsTask(now).catch((e) => jackpotError("params", e));
      out.interval = await intervalTask(job.created_at);
    }
    return out;
  },
};

// ---------------------------------------------------------------- X (src/x.ts resolves these into fact sheets)

const ETH = (wei: bigint) => Number((Number(wei) / 1e18).toFixed(3));
const DNA = (wei: bigint) => Math.round(Number(wei / 10n ** 18n));
/** Raw game event → the raw fact input (src/voice.ts FIELDS is the allow-list), plus text code appends. null = skip. */
export async function gameFacts(ev: Record<string, unknown>): Promise<{ facts: Record<string, unknown>; append?: string } | null> {
  const a = ev.args as Record<string, string>;
  switch (ev.name) {
    case "BallotProposed": {
      const rec = await latest<BallotRec>("game", `ballot:${a.ballot}`);
      if (!sameDescriptors(rec?.descriptors, a.options as unknown as unknown[])) return null; // not our ballot
      return { facts: { event: "ballot_opened", options: rec.options.map((o) => o.name), votingHours: C.VOTING / H, opensInHours: C.VETO_WINDOW / H } };
    }
    case "BallotRun": case "BallotSkipped": {
      const found = await latest<BallotRec>("game", `ballot:${a.ballot}`);
      const [descs, , , , , tallies] = await rd<readonly [Hex[], bigint, bigint, boolean, boolean, readonly bigint[]]>(d.mutationBoard!, abi.mutationBoardAbi, "ballots", [BigInt(a.ballot)]);
      const rec = sameDescriptors(found?.descriptors, descs) ? found : undefined; // another proposer's ballot: no names
      const w = rec?.options[Number((rec as { result?: { option: number } }).result?.option ?? a.option ?? 0)];
      // the vote weights: the same read's tallies, in DNA-weight units
      const win = Number((rec as { result?: { option: number } } | undefined)?.result?.option ?? a.option ?? 0);
      return { facts: { event: "ballot_result", ballot: Number(a.ballot), outcome: ev.name === "BallotRun" ? "queued for testing" : "failed the safety checks, not queued", winner: w?.name,
        winnerWeight: DNA(tallies[win] ?? 0n), totalWeight: DNA(tallies.reduce((s, t) => s + t, 0n)) } };
    }
    // up to 10 equal winners; their FULL addresses are on the site's line and the proof page (code, never the model).
    // `paid`: the settle's Winner rows, attached by the watcher (src/watch.ts) from the same tx
    case "Drawn": {
      const paid = (a.paid ?? []) as unknown as { prizeId: string }[];
      return { facts: { event: "jackpot_drawn", window: Number(a.window), winners: Number(a.winners), shareEth: ETH(BigInt(a.share)), prizeEth: ETH(BigInt(a.share) * BigInt(a.winners)),
        claimable: paid.filter((p) => p.prizeId !== "0").length, claimDays: C.CLAIM_WINDOW / DAY },
        append: `proof ${LOG_BASE_URL}/play/draw/${a.window}` };
    }
    case "ListPosted": return { facts: { event: "jackpot_list", window: Number(a.window), holders: Number(a.holders), totalTickets: Number(a.totalTickets), capPct: Number(a.capBps) / 100,
      minBalance: DNA(BigInt(a.minBalance)), vetoHours: 1 }, append: `list ${a.uri}` };
    case "DrawVoided": return { facts: { event: "jackpot_voided", window: Number(a.window), prizeEth: ETH(BigInt(a.prize)) } };
    case "PrizeClaimed": return { facts: { event: "prize_claimed", drawId: Number(a.drawId), prizeEth: ETH(BigInt(a.amount)) } };
    case "PrizeExpired": return { facts: { event: "prize_expired", drawId: Number(a.drawId), prizeEth: ETH(BigInt(a.amount)), claimDays: C.CLAIM_WINDOW / DAY } };
    // an idea reward left the reserve: the amount, the claim fallback, and the signed reward record as the proof (the
    // RewardQueued's ideaRef is that record's hash, anchored on-chain before the queue). The recipient's address is on
    // the site line only (short form), never in the fact sheet
    case "RewardPaid": {
      const claim = Number(a.claimId ?? 0); // 0 = pushed
      const [q] = await sql<{ args: { ideaRef: string } }[]>`select args from chain_log where event = 'RewardQueued' and args->>'id' = ${String(a.id)} order by block desc limit 1`;
      const [anc] = q ? await sql<{ args: { uri: string } }[]>`select args from chain_log where event = 'Anchored' and lower(args->>'root') = ${q.args.ideaRef.toLowerCase()} order by block limit 1` : [];
      return { facts: { event: "reward_paid", reward: Number(a.id), rewardEth: ETH(BigInt(a.amount)), claimable: claim !== 0, claim, claimDays: C.CLAIM_WINDOW / DAY },
        append: anc ? `proof ${anc.args.uri}` : undefined };
    }
    case "Sealed": return { facts: { event: "mystery_sealed", revealInDays: Math.max(0, Math.round((Number(a.revealAt) - Date.now() / 1000) / DAY)) }, append: `commitment ${a.commitment}` };
    case "Run": case "Rejected": {
      // the verdict on a revealed mystery; the reason as a fixed phrase (never a threshold)
      const r = await latest<{ result?: { skipped?: string } }>("game", `mystery:${a.mystery}`);
      return { facts: { event: "mystery_result", mystery: Number(a.mystery), outcome: ev.name === "Run" ? "queued for testing" : "rejected", reason: ev.name === "Run" ? undefined : reasonOf(r?.result?.skipped ?? "") } };
    }
    case "RoundFinalized": {
      // an idea round's outcome: accepted ideas and what stakers of accepted ideas receive on top of their stake
      const accepted = popcount(BigInt(a.accepted));
      const [, count] = await rd<readonly [number, number]>(d.ideaMarket!, abi.ideaMarketAbi, "rounds", [BigInt(a.round)]);
      const A = BigInt(a.acceptedStake), R = BigInt(a.rejectedStake);
      const refunded = A === 0n || a.expired === "true" || (a.expired as unknown) === true;
      const [rep] = await sql<{ seq: string }[]>`select seq::text from log where kind = 'report' and ref = ${`round:${a.round}`} order by log.seq desc limit 1`;
      return { facts: { event: "idea_round", round: Number(a.round), accepted, ideas: Number(count), refunded, payoutPct: refunded ? 0 : Number((R * 1000n) / A) / 10 },
        append: rep ? `report ${LOG_BASE_URL}/api/log/${rep.seq}` : undefined };
    }
    case "Revealed": {
      let p: MysteryPayload | undefined;
      try { p = JSON.parse(Buffer.from(String(a.payload).slice(2), "hex").toString("utf8")); } catch { /* opaque payload */ }
      return { facts: { event: "mystery_revealed", fee: p?.vector?.length === 3 ? { basePct: p.vector[0] / 1e4, multiplier: p.vector[1] / 1e4, capPct: p.vector[2] / 1e4 } : undefined } };
    }
  }
  return null;
}

/** The game (and idea-market) events the watcher hands to X and the site's announcements. */
export const GAME_X_EVENTS = new Set(["BallotProposed", "BallotRun", "BallotSkipped", "ListPosted", "Drawn", "DrawVoided", "PrizeClaimed", "PrizeExpired", "RewardPaid", "Sealed", "Revealed", "Run", "Rejected", "RoundFinalized"]);
export const gameEventAbi = [...abi.gamePotAbi, ...abi.convictionVaultAbi, ...abi.mutationBoardAbi, ...abi.ideaMarketAbi].filter((x) => x.type === "event");
export const gameAddresses = () => [d.gamePot, d.convictionVault, d.mutationBoard].filter((x): x is Address => !!x);
/** What the watcher reads for announcements: the game contracts and the idea market. */
export const announceAddresses = () => [...gameAddresses(), d.ideaMarket].filter((x): x is Address => !!x);

const popcount = (x: bigint) => { let n = 0; for (; x; x >>= 1n) n += Number(x & 1n); return n; };
/** A rejection or close reason as a fixed public phrase (the raw text can carry gate thresholds). Never "promoted":
 *  that comes from the run's outcome (src/x.ts enqueueOutcome), not from its text. */
export function reasonOf(why: string): string {
  const w = why.toLowerCase();
  if (/cancel|veto/.test(w)) return "the Safe cancelled it";
  if (/did not promote/.test(w)) return "the Safe did not promote it";
  if (/already running/.test(w)) return "another experiment is running";
  if (/plate's bounds|outside/.test(w)) return "outside the plate's bounds";
  if (/gate|safety/.test(w)) return "failed the safety checks";
  if (/kill condition/.test(w)) return "a kill condition fired";
  if (/red team/.test(w)) return "the red team blocked it";
  if (/insufficient data|not enough data/.test(w)) return "not enough data";
  if (/roll(ed)? ?back|breaker/.test(w)) return "rolled back";
  if (/pending ops|free .*plate|level/.test(w)) return "no room to test it now";
  if (/readable/.test(w)) return "the payload was not readable";
  return "closed";
}
