// Pure agent-loop logic: FeeTaken↔Swap pairing, stats, kill conditions, clamps, gates, the plate state machine per
// level, the closed-round rule, number discipline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedNumbers, sanitize, strayNumbers, textOk } from "../src/agents.ts";
import { assertClosed, incomplete, outcomeOf, titleKey } from "../src/ideas.ts";
import { advance, type Facts, queuePlanned, type Run, vectorWords } from "../src/loop.ts";
import { canaryCeiling, type ChainRow, inWindow, killCheck, pair, type Paired, stats } from "../src/observe.ts";
import { checkTimings, clampVector, KILL, TIMING } from "../src/policy.ts";
import { adaptive, analytic, candidateGates, volEmas } from "../src/sim.ts";

const at = new Date("2026-10-06T00:00:00Z");
let li = 0;
const swap = (tx: string, buy: boolean, eth: bigint, tick = 0, block = 1, sender = "0x00000000000000000000000000000000000000aa"): ChainRow => ({ block, log_index: li++, tx, at, event: "Swap", args: { sender, amount0: String(buy ? -eth : eth), amount1: String(buy ? 10n ** 21n : -(10n ** 21n)), tick: String(tick) } });
const BB = "0x00000000000000000000000000000000000000Bb"; // BuybackBurn (any case)
const fee = (tx: string, buy: boolean, exactInput: boolean, pips = 20_000, project = 10n ** 15n, block = 1): ChainRow => ({ block, log_index: li++, tx, at, event: "FeeTaken", args: { buy, exactInput, gross: String(5n * 10n ** 16n), project: String(project), platform: "1", pips: String(pips) } });

test("pairing: FeeTaken precedes its Swap iff exactInput == buy, else follows; buybacks stay fee-less", () => {
  const rows = [
    fee("a", true, true), swap("a", true, 10n ** 18n), // exact-in buy: ETH specified → before
    swap("b", false, 5n * 10n ** 17n), fee("b", false, true), // exact-in sell: DNA specified → after
    swap("c", true, 10n ** 17n, 0, 1, BB.toLowerCase()), fee("c", true, false, 0, 0n), // buyback (exact-out buy): platform fee only, not a trader's fee
    fee("d", false, false), swap("d", false, 10n ** 17n), // exact-out sell (exactInput false == buy false): ETH specified → before
    swap("e", true, 10n ** 17n), fee("e", true, false), // exact-out buy: DNA specified → after
    fee("f", true, true), swap("f", true, 1n), fee("f", true, true), swap("f", true, 2n), // two swaps in one tx
    fee("g", true, true, 0, 0n), swap("g", true, 1n, 0, 1, BB), // an exact-in buyback: its FeeTaken precedes it, still not paired
  ];
  const p = pair(rows, BB);
  assert.deepEqual(p.map((s) => [s.tx, s.buy, s.fee ? `${s.fee.buy}/${s.fee.exactInput}` : null]), [
    ["a", true, "true/true"], ["b", false, "false/true"], ["c", true, null], ["d", false, "false/false"], ["e", true, "true/false"], ["f", true, "true/true"], ["f", true, "true/true"], ["g", true, null],
  ]);
  // a FeeTaken never pairs across transactions, nor with a swap of the other direction
  assert.equal(pair([fee("x", true, true), swap("y", true, 1n)])[0].fee, undefined);
  assert.equal(pair([swap("z", true, 1n), fee("z", false, true)])[0].fee, undefined);
});

test("stats: volume, project fees per day, mix, realized vol, time at cap, shadow and failures", () => {
  const t0 = at.getTime();
  const mk = (i: number, buy: boolean, pips: number, tick: number): Paired => ({ block: i, logIndex: 0, at: t0 + i * 1000, tx: `t${i}`, buy, ethWei: 10n ** 18n, tokenWei: 1n, tick, fee: { buy, exactInput: true, gross: 10n ** 18n, project: (10n ** 18n * BigInt(pips)) / 1_000_000n, pips } });
  const p = [mk(0, true, 20_000, 0), mk(1, false, 35_000, 100), mk(2, true, 35_000, 50), { ...mk(3, true, 0, 50), fee: undefined }];
  const s = stats(p, { fromMs: t0, toMs: t0 + 43_200_000, capPips: 35_000, shadow: [{ ...swap("s", true, 1n), event: "ShadowFee", at: new Date(t0 + 5), args: { pips: "25000" } }], failed: [] });
  assert.equal(s.swaps, 4);
  assert.equal(s.feeSwaps, 3);
  assert.equal(s.buybacks, 1);
  assert.deepEqual([s.buys, s.sells], [2, 1]);
  assert.equal(s.volumeEth, 3);
  assert.equal(s.projectEth, 0.09);
  assert.equal(s.projectEthPerDay, 0.18); // 12 h window
  assert.equal(s.atCapShare, 0.6667);
  assert.equal(s.meanPips, 30_000);
  assert.equal(s.shadowMeanPips, 25_000);
  assert.ok(Math.abs(s.realizedVolPct - Math.sqrt((100 * Math.log(1.0001)) ** 2 + (50 * Math.log(1.0001)) ** 2) * 100) < 1e-3);
});

test("canary window and kill conditions", () => {
  const w = { start: 100, period: 10, len: 5 };
  assert.deepEqual([99, 100, 104, 105, 109, 110].map((b) => inWindow(b, w)), [false, true, true, false, false, true]);
  const s = (block: number, pips = 20_000): Paired => ({ block, logIndex: 0, at: 0, tx: `t${block}`, buy: true, ethWei: 1n, tokenWei: 1n, tick: 0, fee: { buy: true, exactInput: true, gross: 1n, project: 1n, pips } });
  const k = { ...KILL, minSwaps: 3 };
  const o = { window: w, fromBlock: 100, toBlock: 199, capPips: 30_000, canaryFailures: 0 };
  assert.match(killCheck([], { ...o, canaryFailures: 1 }, k)!, /ModuleFailed ×1/);
  // in-window swaps pinned at the cap
  assert.match(killCheck([s(100, 30_000), s(101, 30_000), s(102, 20_000), s(105)], o, k)!, /at the canary ceiling \(3.00%\) 66.7%/);
  // the hook clamps the canary to active + 1 pt: with a 3.5% plate cap over a 2% active fee the ceiling is 3%, and
  // swaps pinned there must still count (the plate's own cap is unreachable)
  assert.equal(canaryCeiling(35_000, [20_000, 20_000]), 30_000);
  assert.equal(canaryCeiling(35_000, [], 25_000), 35_000);
  assert.equal(canaryCeiling(50_000, []), 32_000, "no out-of-window swaps: the 2.2% baseline + 1 point");
  assert.equal(canaryCeiling(25_000, [20_000]), 25_000);
  assert.match(killCheck([s(100, 30_000), s(101, 30_000), s(102, 30_000), s(105), s(106), s(107)], { ...o, capPips: 35_000 }, k)!, /canary ceiling \(3.00%\) 100.0%/);
  // traders avoid the window: 0 in-window swaps vs 4 outside
  assert.match(killCheck([s(105), s(106), s(115), s(116)], o, k)!, /swap rate 0%/);
  // balanced: no kill; too few out-window swaps: no judgement
  assert.equal(killCheck([s(100), s(101), s(105), s(106), s(110), s(115)], o, k), null);
  assert.equal(killCheck([s(105)], o, k), null);
  // mainnet schedule (100 of every 600 blocks): a window that just opened (7 in-window blocks, 0 swaps there yet,
  // 12 outside) is not evidence: no kill (the bug: ratio 0 → endCanary at every window opening)
  const w6 = { start: 600, period: 600, len: 100 };
  const out = (n: number) => Array.from({ length: n }, (_, i) => s(10 + i * 8));
  assert.equal(killCheck(out(12), { window: w6, fromBlock: 0, toBlock: 606, capPips: 30_000, canaryFailures: 0 }, k), null);
  // a full window passed, but thin flow predicts < minSwaps in-window swaps: still no judgement
  assert.equal(killCheck(out(12), { window: w6, fromBlock: 0, toBlock: 699, capPips: 30_000, canaryFailures: 0 }, k), null);
  // a full window passed with enough expected flow (60 outside → 12 expected inside) and 0 inside: kill
  assert.match(killCheck(Array.from({ length: 60 }, (_, i) => s(i * 9)), { window: w6, fromBlock: 0, toBlock: 699, capPips: 30_000, canaryFailures: 0 }, k)!, /swap rate 0%/);
});

test("clamp: policy ∩ plate bounds, cap ≥ base, non-finite → lower bound", () => {
  assert.deepEqual(clampVector([5_000, 50_000, 90_000]), [10_000, 18_000, 35_000]);
  assert.deepEqual(clampVector([25_000, 1_000, 12_000]), [25_000, 1_000, 25_000]); // cap raised to base
  assert.deepEqual(clampVector([20_000, 13_000, 34_000], { min: [12_000, 0, 12_000], max: [22_000, 10_000, 30_000] }), [20_000, 10_000, 30_000]);
  assert.deepEqual(clampVector([Number.NaN, 0, 0]), [10_000, 0, 10_000]);
  assert.throws(() => clampVector([20_000, 0, 20_000], { min: [40_000, 0, 0], max: [50_000, 0, 50_000] }), /don't overlap/);
  assert.deepEqual(vectorWords([1, 2, 3]).map((h) => BigInt(h)), [1n, 2n, 3n, 0n]);
});

test("simulator: AdaptiveFee formula, volEma rebuild, analytic elasticity, candidate gates", () => {
  assert.equal(adaptive([20_000, 13_000, 50_000], 1_000), 21_300);
  assert.equal(adaptive([20_000, 13_000, 21_000], 1_000), 21_000);
  const p = (tick: number, pips = 20_000): Paired => ({ block: 1, logIndex: 0, at: 0, tx: "t", buy: true, ethWei: 10n ** 18n, tokenWei: 1n, tick, fee: { buy: true, exactInput: true, gross: 10n ** 18n, project: (10n ** 18n * BigInt(pips)) / 1_000_000n, pips } });
  assert.deepEqual(volEmas([p(0), p(8), p(8)]), [0, 0, 100]); // (0·7 + 800)/8 = 100 before the third swap
  const swaps = Array.from({ length: 30 }, () => p(0));
  const a = analytic(swaps, [22_000, 0, 25_000], 1, 50_000);
  assert.equal(a.baseline.projectEthPerDay, 0.6);
  const e1 = a.elasticity.find((e) => e.eps === 1)!;
  // the platform fee (0.30%) sits on both totals: 20,000 + pf vs 22,000 + pf
  assert.equal(e1.swapRetention, Number((23_000 / 25_000).toFixed(6)));
  assert.equal(e1.projectEthPerDay, Number((30 * 0.022 * (23_000 / 25_000)).toFixed(6)));
  assert.ok(a.elasticity.find((e) => e.eps === 2)!.projectEthPerDay < e1.projectEthPerDay);
  const safe = { replayed: 30, candidateReverts: 0, moduleFailed: 0, breakerFailCount: 0, maxGasDelta: 3_000, clamped: 0 };
  assert.deepEqual(candidateGates(a, safe, 30), []);
  assert.deepEqual(candidateGates(a, null, 30), ["no fork replay (safety unmeasured)"]);
  assert.equal(candidateGates(a, { ...safe, moduleFailed: 1, maxGasDelta: 150_000 }, 30).length, 2);
  assert.match(candidateGates(analytic(swaps, [35_000, 0, 35_000], 1, 50_000), safe, 30).join(), /retention/);
  assert.match(candidateGates(a, safe, 5).join(), /only 5 recorded swaps/);
});

// ---------------------------------------------------------------- plate state machine

const P = "0x00000000000000000000000000000000000000a1" as const;
const ACT = "0x00000000000000000000000000000000000000c3" as const;
const V: [number, number, number] = [22_000, 0, 25_000];
const run = (stage: Run["stage"], over: Partial<Run> = {}): Run => ({ id: "T-0001", title: "t", hypothesis: "h", plate: P, label: "A", vector: V, stage, stageAt: 0, ops: ["7"], sim: "sim #1", exp: "E-0001", bench: "1", confidence: 60, simNumbers: {}, ...over });
const facts = (over: Partial<Facts> & { status?: number; params?: [number, number, number] } = {}): Facts => ({ now: 0, head: 1000, level: 5, agentPending: 0, opsPending: false, kill: null, samples: 1000, minDelayMs: H, promotePending: false, plate: { status: over.status ?? 2, params: over.params ?? V }, ...over });
const H = 3600_000;

test("state machine: shadow → Fable → SetCanary → canary → kill → endCanary", () => {
  assert.deepEqual(advance(run("queued_shadow"), facts({ opsPending: true })).actions, []);
  assert.equal(advance(run("queued_shadow"), facts({ now: 5 })).run.stage, "shadow");
  assert.equal(advance(run("queued_shadow"), facts({ params: [1, 2, 3] })).run.outcome, "rejected"); // cancelled → close
  assert.deepEqual(advance(run("shadow"), facts({ now: TIMING.shadowMs - 1 })).actions, []); // time-based
  assert.deepEqual(advance(run("shadow"), facts({ now: TIMING.shadowMs })).actions, [{ t: "fable", purpose: "canary" }]);
  assert.equal(advance(run("shadow", { fable: { canary: false } }), facts({ now: TIMING.shadowMs })).run.outcome, "rejected");
  assert.deepEqual(advance(run("shadow", { fable: { canary: true } }), facts({ now: TIMING.shadowMs, agentPending: 2 })).actions, []); // pending ≤ 2
  const c = advance(run("shadow", { fable: { canary: true } }), facts({ now: TIMING.shadowMs, head: 777 }));
  assert.equal(c.run.stage, "queued_canary");
  assert.deepEqual(c.actions, [{ t: "queue", op: "SetCanary", args: [P, 777n, TIMING.canaryPeriod, TIMING.canaryLen] }]);
  assert.ok(TIMING.canaryLen >= 50 && TIMING.canaryLen < TIMING.canaryPeriod);
  assert.equal(advance(run("shadow", { fable: { canary: true } }), facts({ now: TIMING.shadowMs, level: 4 })).run.outcome, "rejected");
  const live = advance(run("queued_canary"), facts({ status: 3, head: 900 }));
  assert.deepEqual([live.run.stage, live.run.canaryBlock], ["canary", 900]);
  const k = advance(run("canary"), facts({ status: 3, kill: "x" }));
  assert.deepEqual(k.actions.map((a) => a.t), ["endCanary", "close"]);
  assert.equal(k.run.reason, "kill condition: x");
  assert.equal(advance(run("canary"), facts({ status: 1 })).actions.some((a) => a.t === "endCanary"), false); // already ended by the Safe
  assert.equal(advance(run("canary"), facts({ status: 6 })).run.outcome, "rolled_back");
});

test("hours-based timings (everything 1 h + 15-min loop): defaults and startup validation", () => {
  assert.deepEqual([TIMING.shadowMs / H, TIMING.canaryMs / H, TIMING.promoteWaitMs / H, KILL.windowHours, TIMING.extendStepMs / H, TIMING.maxStretch], [2, 4, 13, 1, 1, 3]);
  assert.deepEqual(checkTimings(), []);
  assert.match(checkTimings({ ...TIMING, shadowMs: Number.NaN }).join(), /SHADOW_HOURS must be a number/);
  assert.match(checkTimings({ ...TIMING, promoteWaitMs: 0 }).join(), /PROMOTE_WAIT_HOURS/);
  assert.match(checkTimings(TIMING, { ...KILL, windowHours: 0 }).join(), /KILL_WINDOW_HOURS/);
  assert.match(checkTimings({ ...TIMING, minCanarySamples: 2.5 }).join(), /MIN_CANARY_SAMPLES must be an integer/);
  assert.match(checkTimings({ ...TIMING, shadowMs: 0 }).join(), /SHADOW_HOURS 0 needs MIN_SHADOW_SAMPLES 0/);
});

test("state machine: short of data → extend in 1 h steps up to 3×, then close as insufficient data (never pass)", () => {
  const S = TIMING.shadowMs, C = TIMING.canaryMs, few = TIMING.minShadowSamples - 1;
  const e1 = advance(run("shadow"), facts({ now: S, samples: few }));
  assert.deepEqual([e1.run.extended, e1.actions], [1, [{ t: "extend", hours: 1, why: `${few} shadow samples < ${TIMING.minShadowSamples}` }]]);
  assert.deepEqual(advance(e1.run, facts({ now: S + H - 1, samples: few })).actions, []); // one record per 1 h step
  assert.equal(advance(e1.run, facts({ now: S + H, samples: few })).run.extended, 2);
  assert.deepEqual(advance(e1.run, facts({ now: S + H, samples: TIMING.minShadowSamples })).actions, [{ t: "fable", purpose: "canary" }]); // data arrived
  const out = advance(run("shadow", { extended: 4 }), facts({ now: 3 * S, samples: few }));
  assert.equal(out.run.outcome, "rejected");
  assert.match(out.run.reason!, /^insufficient data: \d+ shadow samples < \d+ after 6 h \(the stage was extended to 3× its 2 h\)$/);
  assert.deepEqual(out.actions.map((a) => a.t), ["close"]);
  // canary: same rule on in-window fee swaps; closing ends the canary
  const c1 = advance(run("canary"), facts({ status: 3, now: C, samples: 0 }));
  assert.deepEqual([c1.run.stage, c1.actions[0].t], ["canary", "extend"]);
  const c3 = advance(run("canary"), facts({ status: 3, now: 3 * C, samples: 0 }));
  assert.deepEqual([c3.run.outcome, c3.actions.map((a) => a.t)], ["rejected", ["endCanary", "close"]]);
  // the next stage starts with no extension
  const next = advance(run("shadow", { extended: 2, fable: { canary: true } }), facts({ now: S + 2 * H, head: 5 }));
  assert.deepEqual([next.run.stage, next.run.extended], ["queued_canary", undefined]);
});

test("state machine: canary pass by level (L5 request, L6 SetParams(active), L8 Fable → PromoteActive)", () => {
  const done = TIMING.canaryMs;
  assert.deepEqual(advance(run("canary"), facts({ status: 3, now: done - 1 })).actions, []);
  const l5 = advance(run("canary"), facts({ status: 3, now: done, level: 5, active: { address: ACT, params: [20_000, 0, 30_000], min: [10_000, 0, 10_000], max: [35_000, 18_000, 35_000] } }));
  assert.deepEqual([l5.run.stage, l5.actions[0].t], ["promote_requested", "request"]);
  assert.match((l5.actions[0] as { text: string }).text, /queue PromoteActive\(0x[0-9a-f]+\) within 12 h \(it executes 1 h later\); the canary ends at 13 h without it\.$/);
  // L6–7 tune changes the LIVE fee: the gate model first, then the vector clamped to the ACTIVE plate's bounds
  const act = { address: ACT, params: [20_000, 0, 30_000] as [number, number, number], min: [10_000, 1_000, 10_000], max: [21_000, 18_000, 24_000] };
  assert.deepEqual(advance(run("canary"), facts({ status: 3, now: done, level: 6, active: act })).actions, [{ t: "fable", purpose: "promote" }]);
  assert.deepEqual(advance(run("canary", { fable: { promote: false } }), facts({ status: 3, now: done, level: 7, active: act })).actions.map((a) => a.t), ["endCanary", "close"]);
  const l6 = advance(run("canary", { fable: { promote: true } }), facts({ status: 3, now: done, level: 6, active: act }));
  assert.equal(l6.run.stage, "tune_queued");
  assert.deepEqual(l6.run.tuned, [21_000, 1_000, 24_000]);
  assert.deepEqual(l6.actions, [{ t: "queue", op: "SetParams", args: [ACT, vectorWords([21_000, 1_000, 24_000])] }]);
  assert.equal(advance(run("canary"), facts({ status: 3, now: done, level: 7 })).run.stage, "promote_requested"); // no active plate: needs a promotion
  assert.deepEqual(advance(run("canary"), facts({ status: 3, now: done, level: 8 })).actions, [{ t: "fable", purpose: "promote" }]);
  const l8 = advance(run("canary", { fable: { promote: true } }), facts({ status: 3, now: done, level: 8 }));
  assert.deepEqual([l8.run.stage, l8.actions], ["promote_queued", [{ t: "queue", op: "PromoteActive", args: [P] }]]);
  assert.deepEqual(advance(run("canary", { fable: { promote: false } }), facts({ status: 3, now: done, level: 9 })).actions.map((a) => a.t), ["endCanary", "close"]);
  // after the pass
  const tuned = advance(run("tune_queued", { tuned: [21_000, 1_000, 24_000] }), facts({ status: 3, active: { ...act, params: [21_000, 1_000, 24_000] } }));
  assert.deepEqual([tuned.run.outcome, tuned.actions.map((a) => a.t)], ["accepted", ["endCanary", "close"]]);
  assert.equal(advance(run("promote_queued"), facts({ status: 4 })).run.outcome, "accepted");
  assert.equal(advance(run("promote_requested"), facts({ status: 4 })).run.outcome, "accepted");
  const late = advance(run("promote_requested", { stageAt: 0 }), facts({ status: 3, now: TIMING.promoteWaitMs + H }));
  assert.deepEqual([late.run.outcome, late.actions[0].t], ["rejected", "endCanary"]);
  assert.equal(advance(run("promote_requested"), facts({ status: 3, kill: "rate" })).run.reason, "kill condition: rate");
  // the Safe already queued PromoteActive: never time out under it (it executes, or is cancelled and then times out)
  assert.deepEqual(advance(run("promote_requested", { stageAt: 0 }), facts({ status: 3, now: TIMING.promoteWaitMs + 5 * H, promotePending: true })).actions, []);
  assert.equal(advance(run("promote_requested", { stageAt: 0 }), facts({ status: 4, promotePending: true })).run.outcome, "accepted");
  // the request wording follows the registry's MIN_DELAY, not a literal
  const l5b = advance(run("canary"), facts({ status: 3, now: done, level: 5, minDelayMs: 2 * H }));
  assert.match((l5b.actions[0] as { text: string }).text, /within 11 h \(it executes 2 h later\); the canary ends at 13 h without it\.$/);
  assert.match(checkTimings(TIMING, KILL, 13 * H).join(), /PROMOTE_WAIT_HOURS must be > the registry MIN_DELAY \(13 h\)/);
  assert.deepEqual(checkTimings(TIMING, KILL, H), []);
  // the watcher's endCanary landed first (plate back to Proposed): still recorded as a kill, no second endCanary
  const k2 = advance(run("canary"), facts({ status: 1, kill: "ModuleFailed" }));
  assert.deepEqual([k2.run.reason, k2.actions.map((a) => a.t)], ["kill condition: ModuleFailed", ["close"]]);
});

test("daily cycle retry: first-stage ops resume where they stopped (never a second SetParams, never untracked)", async () => {
  const r = run("queued_shadow", { ops: [], planned: [{ op: "SetParams", args: [P, vectorWords(V)] }, { op: "SetShadow", args: [P] }] });
  const sent: string[] = [];
  const saved: string[][] = [];
  let fail = true;
  const queue = async (op: string) => {
    if (op === "SetShadow" && fail) throw new Error("daily maximum reached"); // Defer / revert / RPC error
    sent.push(op);
    return { status: "mined", id: String(10 + sent.length) };
  };
  const save = async (x: Run) => { saved.push([...x.ops]); };
  await assert.rejects(queuePlanned(r, queue, save), /daily maximum/);
  assert.deepEqual([r.ops, r.allOps, r.planned!.map((p) => p.op), saved], [["11"], ["11"], ["SetShadow"], [["11"]]]); // SetParams owned + saved
  fail = false;
  await queuePlanned(r, queue, save);
  assert.deepEqual([sent, r.ops, r.planned], [["SetParams", "SetShadow"], ["11", "12"], []]);
  await assert.rejects(queuePlanned(run("queued_shadow", { planned: [{ op: "SetParams", args: [] }] }), async () => ({ status: "dry_run" }), save), /queue SetParams: dry_run/);
});

test("ideas: no bitmap from a partially indexed round; report → draft bitmaps", () => {
  assert.equal(incomplete([{ index: 0 }, { index: 1 }], 2), null);
  assert.match(incomplete([{ index: 0 }], 2)!, /1 of 2 ideas indexed/);
  assert.match(incomplete([{ index: 0 }, { index: 2 }], 2)!, /indices/);
  const body = JSON.stringify({ round: 4, ideas: [{ id: 7, index: 0, decision: "accept" }, { id: 8, index: 1, decision: "reject" }, { id: 9, index: 2, decision: "void" }] });
  const o = outcomeOf(JSON.parse(body), "55", body);
  assert.deepEqual([o.accepted, o.voided, o.allVoid], ["1", "4", false]);
  assert.match(o.uri, /\/api\/log\/55$/);
  assert.equal(o.reportHash.length, 66);
});

test("model text bound for records: links, domains, handles, foreign cashtags removed", () => {
  assert.equal(sanitize("See https://x.co/a and example.com, ping @dev, buy $PEPE not $DNA"), "See and , ping , buy not $DNA");
  assert.equal(sanitize("@a https://b.io"), "(withheld: the text was only links or handles)");
  assert.equal(sanitize("fee 0.05 ETH, e.g. 1.8×"), "fee 0.05 ETH, e.g. 1.8×");
});

test("ideas: research refuses an open round; title dedupe key", () => {
  assert.throws(() => assertClosed(3, 3), /still open/);
  assert.throws(() => assertClosed(4, 3), (e: Error & { final?: boolean }) => e.final === true);
  assert.doesNotThrow(() => assertClosed(2, 3));
  assert.equal(titleKey("Lower fee, for SMALL swaps!"), titleKey("lower fee for small swaps"));
  assert.notEqual(titleKey("lower fee"), titleKey("higher fee"));
});

test("number discipline: published text may only state given numbers", () => {
  const allowed = allowedNumbers({ swaps: 128, projectEth: 0.0412, share: 0.25, day: "37" });
  assert.deepEqual(strayNumbers("128 swaps, 0.04 ETH, 25% at cap, day 37", allowed), []);
  assert.deepEqual(strayNumbers("1,280 swaps and 9.5% more", allowed), ["1280", "9.5"]);
  assert.equal(textOk("128 swaps today", allowed), true);
  assert.equal(textOk("128 swaps, see example.com", allowed), false);
});
