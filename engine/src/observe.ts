// Observe (every 5 min, code only): finalized chain_log → swap stats, the canary kill conditions, and epoch records.
// Pure parts (pair, stats, inWindow, killCheck) are unit-tested in test/agents.test.ts.
import { d } from "./config.ts";
import { edb as sql } from "./db.ts";
import { HOOK_FEES } from "./hook-fees.ts";
import type { Handler } from "./jobs.ts";
import { KILL } from "./policy.ts";
import { latest, nowIso, record } from "./records.ts";

type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type ChainRow = { block: number; log_index: number; tx: string; at: Date; event: string; args: Args };
export type Fee = { buy: boolean; exactInput: boolean; gross: bigint; project: bigint; pips: number };
export type Paired = { block: number; logIndex: number; at: number; tx: string; buy: boolean; ethWei: bigint; tokenWei: bigint; tick: number; fee?: Fee };

const abs = (x: bigint) => (x < 0n ? -x : x);
const toFee = (a: Args): Fee => ({ buy: a.buy === true || a.buy === "true", exactInput: a.exactInput === true || a.exactInput === "true", gross: BigInt(a.gross), project: BigInt(a.project), pips: Number(a.pips) });

/** The hook's project-fee cap (5%): every module answer is clamped to it, so only a launch guard's launch tax (its first
 *  blocks, all of it to buyback-and-burn) is ever charged above it. Never one on a hook without the guard. */
export const MAX_PROJECT_FEE = 50_000;
export const isLaunchTax = (f: { pips: number }) => f.pips > MAX_PROJECT_FEE;

/** FeeTaken ↔ Swap pairing by tx hash. The hook emits FeeTaken in beforeSwap when ETH is the specified side
 *  (exactInput == buy), so it PRECEDES its Swap log; otherwise in afterSwap, so it FOLLOWS its Swap. Buybacks (Swap
 *  sender = BuybackBurn) pay only the platform fee: their FeeTaken (project 0) is left unpaired, so they stay fee-less
 *  here and the stats count traders' swaps. A swap that paid the launch tax (isLaunchTax) is left out with its
 *  FeeTaken: no fee observation, simulation or gate ever sees it (launchTax reports those swaps apart). `rows` must be in
 *  (block, log_index) order. */
export function pair(rows: ChainRow[], buybackBurn: string = d.buybackBurn): Paired[] {
  const bb = buybackBurn.toLowerCase();
  const out: Paired[] = [];
  let tx = "";
  let pre: Fee | undefined; // ETH-specified FeeTaken waiting for the Swap that follows it
  let awaiting: Paired | undefined; // Swap waiting for its afterSwap FeeTaken
  let taxed: boolean | undefined; // a launch-tax FeeTaken's `buy`, waiting to drop the Swap that follows it
  for (const r of rows) {
    if (r.tx !== tx) { tx = r.tx; pre = undefined; awaiting = undefined; taxed = undefined; }
    if (r.event === "Swap") {
      const a0 = BigInt(r.args.amount0);
      const s: Paired = { block: r.block, logIndex: r.log_index, at: r.at.getTime(), tx: r.tx, buy: a0 < 0n, ethWei: abs(a0), tokenWei: abs(BigInt(r.args.amount1)), tick: Number(r.args.tick) };
      if (taxed === s.buy) { taxed = undefined; pre = undefined; awaiting = undefined; continue; }
      if (String(r.args.sender ?? "").toLowerCase() === bb) awaiting = undefined; // a buyback: its FeeTaken is not a trader's
      else if (pre && pre.buy === s.buy) { s.fee = pre; awaiting = undefined; } else awaiting = s;
      pre = undefined;
      out.push(s);
    } else if (r.event === "FeeTaken") {
      const f = toFee(r.args);
      if (isLaunchTax(f)) {
        if (f.exactInput === f.buy) taxed = f.buy;
        else if (awaiting && !awaiting.fee && awaiting.buy === f.buy) { out.splice(out.indexOf(awaiting), 1); awaiting = undefined; }
        continue;
      }
      if (f.exactInput === f.buy) pre = f;
      else if (awaiting && !awaiting.fee && awaiting.buy === f.buy) { awaiting.fee = f; awaiting = undefined; }
    }
  }
  return out;
}

export type Stats = {
  fromMs: number; toMs: number; hours: number;
  swaps: number; feeSwaps: number; buybacks: number; buys: number; sells: number;
  volumeEth: number; projectEth: number; projectEthPerDay: number; swapsPerDay: number;
  realizedVolPct: number; meanPips: number; atCapShare: number; capPips: number;
  shadowSamples: number; shadowMeanPips: number | null; moduleFailed: number;
};
const eth = (w: bigint) => Number(w) / 1e18;
const round = (x: number, d = 6) => Number(x.toFixed(d));

/** Window stats. capPips: the active fee module's cap (time at cap = share of fee-paying swaps charged ≥ it). */
export function stats(p: Paired[], o: { fromMs: number; toMs: number; capPips: number; shadow?: ChainRow[]; failed?: ChainRow[] }): Stats {
  const w = p.filter((s) => s.at >= o.fromMs && s.at < o.toMs);
  const paid = w.filter((s) => s.fee);
  const days = (o.toMs - o.fromMs) / 86_400_000;
  let sq = 0;
  for (let i = 1; i < w.length; i++) sq += ((w[i].tick - w[i - 1].tick) * Math.log(1.0001)) ** 2;
  const project = paid.reduce((n, s) => n + s.fee!.project, 0n);
  const shadow = (o.shadow ?? []).filter((r) => r.at.getTime() >= o.fromMs && r.at.getTime() < o.toMs);
  return {
    fromMs: o.fromMs, toMs: o.toMs, hours: round(days * 24, 2),
    swaps: w.length, feeSwaps: paid.length, buybacks: w.length - paid.length,
    buys: paid.filter((s) => s.buy).length, sells: paid.filter((s) => !s.buy).length,
    volumeEth: round(eth(paid.reduce((n, s) => n + s.ethWei, 0n))),
    projectEth: round(eth(project)), projectEthPerDay: round(eth(project) / days), swapsPerDay: round(paid.length / days, 2),
    realizedVolPct: round(Math.sqrt(sq) * 100, 3),
    meanPips: paid.length ? Math.round(paid.reduce((n, s) => n + s.fee!.pips, 0) / paid.length) : 0,
    atCapShare: paid.length ? round(paid.filter((s) => s.fee!.pips >= o.capPips).length / paid.length, 4) : 0,
    capPips: o.capPips,
    shadowSamples: shadow.length,
    shadowMeanPips: shadow.length ? Math.round(shadow.reduce((n, r) => n + Number(r.args.pips), 0) / shadow.length) : null,
    moduleFailed: (o.failed ?? []).filter((r) => r.at.getTime() >= o.fromMs && r.at.getTime() < o.toMs).length,
  };
}

/** The swaps that paid the launch tax in `rows` (FeeTaken above the project-fee cap), reported apart from the fee
 *  stats: how many, their ETH volume (the ETH each fee was levied on) and the tax (ETH, all of it to buyback-and-burn).
 *  All 0 on a hook without the launch guard. */
export function launchTax(rows: ChainRow[]) {
  const taxed = rows.filter((r) => r.event === "FeeTaken" && isLaunchTax(toFee(r.args)));
  return { eth: round(eth(taxed.reduce((n, r) => n + BigInt(r.args.project), 0n))), swaps: taxed.length, volumeEth: round(eth(taxed.reduce((n, r) => n + BigInt(r.args.gross), 0n))) };
}

export type Window = { start: number; period: number; len: number };
/** The hook's canary test: block ≥ start and (block − start) mod period < len. */
export const inWindow = (block: number, w: Window) => block >= w.start && (block - w.start) % w.period < w.len;

export const CANARY_DELTA = 10_000; // hook: the canary fee is clamped to the active fee ± 1 point

/** The fee an in-window swap can't exceed: the plate's cap, or the active fee + 1 pt when the hook's canary clamp binds
 *  first. The active fee is the mean charged outside the window (falls back to `activePips`: the 22,000 baseline). */
export const canaryCeiling = (capPips: number, outsidePips: number[], activePips: number = HOOK_FEES.baseline) =>
  Math.min(capPips, (outsidePips.length ? Math.round(outsidePips.reduce((a, b) => a + b, 0) / outsidePips.length) : activePips) + CANARY_DELTA);

/** Deterministic canary kill conditions (manifest adaptive-fee-v1.json), judged on [fromBlock, toBlock]:
 *  1. any ModuleFailed from the canary plate; 2. in-window share of fee-paying swaps charged at the canary's ceiling
 *  (`canaryCeiling`) > maxCapShare; 3. in-window swap rate / out-of-window swap rate < minRetention, once the
 *  out-window has ≥ minSwaps, at least one full window's blocks (len) were in-window, and the out-window rate predicts
 *  ≥ minSwaps in-window swaps. The caller's range spans ≥ one full canary period (loop.ts canaryKill). Returns the
 *  first reason, or null. */
export function killCheck(p: Paired[], o: { window: Window; fromBlock: number; toBlock: number; capPips: number; activePips?: number; canaryFailures: number }, k = KILL): string | null {
  if (o.canaryFailures > 0) return `ModuleFailed ×${o.canaryFailures} from the canary plate`;
  const span = p.filter((s) => s.fee && s.block >= o.fromBlock && s.block <= o.toBlock);
  const inside = span.filter((s) => inWindow(s.block, o.window));
  const outside = span.length - inside.length;
  if (inside.length >= k.minSwaps) {
    const ceiling = canaryCeiling(o.capPips, span.filter((s) => !inWindow(s.block, o.window)).map((s) => s.fee!.pips), o.activePips);
    const share = inside.filter((s) => s.fee!.pips >= ceiling).length / inside.length;
    if (share > k.maxCapShare) return `in-window swaps at the canary ceiling (${(ceiling / 1e4).toFixed(2)}%) ${(share * 100).toFixed(1)}% > ${k.maxCapShare * 100}%`;
  }
  // simplification: O(blocks) count of in-window blocks (≤ 3,600 for 12 h); closed form if windows get long
  let inBlocks = 0;
  for (let b = o.fromBlock; b <= o.toBlock; b++) if (inWindow(b, o.window)) inBlocks++;
  const outBlocks = o.toBlock - o.fromBlock + 1 - inBlocks;
  // judged only on a full window's worth of in-window blocks AND an expected in-window count ≥ minSwaps: right after a
  // window opens (a few in-window blocks, 0 swaps yet) the rate is not evidence of anything
  const expectedInside = outBlocks > 0 ? (outside / outBlocks) * inBlocks : 0;
  if (outside >= k.minSwaps && inBlocks >= o.window.len && expectedInside >= k.minSwaps && outBlocks > 0) {
    const ratio = inside.length / inBlocks / (outside / outBlocks);
    if (ratio < k.minRetention) return `in-window swap rate ${(ratio * 100).toFixed(0)}% of the out-window rate < ${k.minRetention * 100}% over ${k.windowHours} h`;
  }
  return null;
}

// ---------------------------------------------------------------- DB side

export const chainRows = (events: string[], fromMs: number) => sql<ChainRow[]>`select block::int as block, log_index, tx, at, event, args
  from chain_log where event = any(${events}) and at >= ${new Date(fromMs)} order by block, log_index`;

type Snapshot = { level: number; route: { active: string; canary: string; activeParams: string[]; canaryParams: string[]; canaryStart: string; canaryPeriod: string; canaryLen: string } };
export const snapshot = async () => (await sql<{ value: Snapshot; block: number }[]>`select value, block::int as block from state where key = 'chain'`)[0];
const ZERO = /^0x0{40}$/i;
export const capOf = (module: string | undefined, params: string[] | undefined) => (module && !ZERO.test(module) && params ? Number(BigInt(params[2])) || MAX_PROJECT_FEE : MAX_PROJECT_FEE);

/** Trailing-24 h stats at the finalized tip (the indexer's chain snapshot gives the active cap). */
export async function observeNow(hours = 24) {
  const [cursor] = await sql<{ at: Date }[]>`select at from cursor`;
  const toMs = (cursor?.at ?? new Date()).getTime() + 1;
  const fromMs = toMs - hours * 3600_000;
  const [rows, shadow, failed, snap] = await Promise.all([
    chainRows(["Swap", "FeeTaken"], fromMs), chainRows(["ShadowFee"], fromMs), chainRows(["ModuleFailed"], fromMs), snapshot(),
  ]);
  const r = snap?.value.route;
  return stats(pair(rows), { fromMs, toMs, capPips: capOf(r?.active, r?.activeParams), shadow, failed });
}

/** Epoch records from finalized chain events: epoch 0 at the deployment's start block, then one per Fee-kind
 *  promotion (StatusChanged → Active) or fee rollback. Idempotent: resumes after the newest epoch record's block. */
export async function syncEpochs() {
  const last = await latest<{ n: number; block: number; after: string }>("epoch");
  const [dep] = await sql<{ value: { startBlock: number } }[]>`select value from state where key = 'deployment'`;
  const snap = await snapshot();
  const level = snap?.value.level ?? 0;
  if (!last) {
    await record("epoch", "0", { n: 0, name: "GENESIS", block: dep?.value.startBlock ?? 0, before: "uninitialized", after: "baseline fee + split", changed: "launch", rollbacks: 0, autonomy: [level, level], branches: [{ id: "genesis", label: "baseline", outcome: "active" }] });
    return syncEpochs();
  }
  const fee = new Set((await sql<{ m: string }[]>`select lower(args->>'module') as m from chain_log where event = 'Registered' and (args->>'kind')::int = 0`).map((r) => r.m));
  const ev = await sql<ChainRow[]>`select block::int as block, log_index, tx, at, event, args from chain_log
    where block > ${last.block} and (event = 'RolledBack' and (args->>'kind')::int = 0 or event = 'StatusChanged' and (args->>'to')::int = 4)
    order by block, log_index`;
  let prev: { n: number; block: number; after: string } = last;
  for (const e of ev) {
    if (e.event === "StatusChanged" && !fee.has(String(e.args.module).toLowerCase())) continue;
    const n = prev.n + 1;
    const promoted = e.event === "StatusChanged";
    const who = promoted ? String(e.args.module) : String(e.args.canary !== "0x0000000000000000000000000000000000000000" ? e.args.canary : e.args.active);
    const label = `fee module ${who.slice(0, 6)}…${who.slice(-4)}`;
    const mem = await sql<{ doc: { id: number; title: string; decision: "rejected" | "rolled_back" } }[]>`select doc from log where kind = 'memory'
      and at > (select at from log where kind = 'epoch' and ref = ${String(prev.n)} order by seq desc limit 1) and doc->>'decision' <> 'accepted'`;
    const after = promoted ? `${label} active` : "baseline fee (rolled back)";
    await record("epoch", String(n), {
      n, name: `EPOCH ${String(n).padStart(2, "0")}`, block: e.block, before: prev.after, after,
      changed: promoted ? `promoted ${label}` : `rolled back ${label}`, rollbacks: promoted ? 0 : 1, autonomy: [level, level],
      branches: [{ id: `${e.block}-${e.log_index}`, label, outcome: promoted ? "active" : "rolled_back" },
        ...mem.map((m) => ({ id: `mem-${m.doc.id}`, label: m.doc.title.slice(0, 60), outcome: m.doc.decision }))],
    });
    prev = { n, block: e.block, after };
  }
}

/** Every OBSERVE_MS (5 min): one observe record per finalized advance (≈ every 6.4 min on mainnet), each one a feed
 *  line on the site (web elogToFeed). Nothing new finalized: no record. */
export const observeHandler: Handler = {
  lane: "default",
  run: async () => {
    await syncEpochs();
    const [cur] = await sql<{ block: number }[]>`select block::int as block from cursor`;
    const ref = String(cur?.block ?? 0);
    if (await latest("observe", ref)) return `block ${ref} already observed`;
    const s = await observeNow();
    await record("observe", ref, { ...s, block: cur?.block ?? 0, at: nowIso() });
    return s;
  },
};
