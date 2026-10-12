// The game layer's pure decisions (src/games.ts): every keeper decision path, idea rewards due, the draw interval,
// ballot candidates and the mystery commitment. DB + fake-chain paths are in games-db.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { concat, keccak256, toHex } from "viem";
import { ballotCandidates, ballotsOpen, brokenDue, C, commitmentOf, desiredInterval, expiredClaims, GAME_POLICY, potActions, type PotView, revealDue, rewardsDue, sameDescriptors, SETTLE_GAS_MIN, splitFellBack, unexpectedRevert, VOTES_CLOSED, vrfOverdue } from "../src/games.ts";
import { gasLimit } from "../src/tx.ts";
import { capFor, capForWindow, CEX_WALLETS, J, JACKPOT_POLICY, latestClosed, listBlocked, nextParamsWindow, syncedPot } from "../src/jackpot.ts";
import { CAP_POLICY, MAX_MULT, MAX_TICKETS, multAt, STREAK_STEPS, WINNERS } from "../src/tickets.ts";
import { boundsIssue, clampVector, POLICY } from "../src/policy.ts";

const H = 3600, D = 86_400;
const T = 1_800_000_000;
const noDraw = { window: 0, eta: 0, reqId: 0n, requestedAt: 0, fulfilledAt: 0 };
const pot = (over: Partial<PotView> = {}): PotView => ({
  now: T, draw: noDraw, windowEnd: T + H, stalledSince: 0, arrived: 0n, overCap: false, lastSync: T - H,
  pending: { eta: 0 }, ...over,
});
const req = (over: Partial<PotView["draw"]>) => ({ ...noDraw, window: 3, eta: T - 2 * D, ...over });

test("GamePot windows: roll once the open window ended; a due roll goes before the interval change it unblocks", () => {
  assert.deepEqual(potActions(pot()), [], "window still open, no list");
  assert.deepEqual(potActions(pot({ windowEnd: T })), ["rollWindow"]);
  assert.deepEqual(potActions(pot({ windowEnd: T, pending: { eta: T } })), ["rollWindow", "executeDrawInterval"]);
  assert.deepEqual(potActions(pot({ windowEnd: 0 })), [], "not initialized");
});

test("GamePot: unsynced arrivals are synced (the jackpot and the idea reserve count them)", () => {
  assert.deepEqual(potActions(pot({ arrived: C.MIN_PRIZE })), ["sync"]);
  assert.deepEqual(potActions(pot({ arrived: GAME_POLICY.syncMin })), ["sync"], "a small arrival, the last sync a distribute period ago");
  assert.deepEqual(potActions(pot({ arrived: GAME_POLICY.syncMin, lastSync: 0 })), ["sync"], "never synced");
  assert.deepEqual(potActions(pot({ arrived: C.MIN_PRIZE - 1n, lastSync: T - GAME_POLICY.syncEveryS + 1 })), [], "small arrivals: at most once a distribute period");
  assert.deepEqual(potActions(pot({ arrived: C.MIN_PRIZE, lastSync: T })), ["sync"], "a minimum prize waiting: right away");
  assert.deepEqual(potActions(pot({ arrived: 1n, overCap: true, lastSync: T })), ["sync"], "over POT_CAP: right away");
  assert.deepEqual(potActions(pot({ arrived: GAME_POLICY.syncMin - 1n })), [], "dust: not worth a tx");
  assert.equal(GAME_POLICY.syncEveryS, H, "the distribute cadence (KEEPER_INTERVAL_MS default)");
  assert.deepEqual(potActions(pot({ arrived: 1n, overCap: true })), ["sync"], "the jackpot would cross POT_CAP");
  assert.deepEqual(potActions(pot({ arrived: 0n })), []);
  // a due requestDraw goes first; keeper:games drops the sync when the request goes out (games-db.test.ts)
  assert.deepEqual(potActions(pot({ arrived: C.MIN_PRIZE, draw: req({ eta: T }) })), ["requestDraw", "sync"]);
  assert.deepEqual(potActions(pot({ arrived: GAME_POLICY.syncMin, draw: req({ eta: T }) })), ["requestDraw", "sync"]);
  assert.equal(C.MIN_PRIZE, J.MIN_PRIZE);
});

test("the synced pot: arrivals above every liability (queued rewards too), 70% to the jackpot, capped at POT_CAP (GamePot._sync)", () => {
  const E = 10n ** 18n;
  const v = { claims: 3n * E, eth: E / 2n, jackpotPot: E, ideaReserve: E / 4n, queuedRewards: E / 4n, escrow: E / 4n, owed: E / 4n, potCap: 15n * E, jackpotBps: 7000n };
  assert.deepEqual(syncedPot(v), { arrived: E + E / 2n, jackpotPot: E + (E + E / 2n) * 7n / 10n, overCap: false });
  assert.deepEqual(syncedPot({ ...v, claims: E }), { arrived: 0n, jackpotPot: E, overCap: false }, "nothing above the liabilities");
  assert.equal(syncedPot({ ...v, queuedRewards: 0n }).arrived, E + E / 2n + E / 4n, "a queued reward's escrow is a liability, not an arrival");
  assert.equal(syncedPot({ ...v, jackpotPot: 15n * E - 1n, claims: 17n * E }).overCap, true);
  assert.equal(syncedPot({ ...v, claims: 100n * E }).jackpotPot, 15n * E, "POT_CAP");
});

test("settle's gas limit: never below the floor (a receiver can burn more at inclusion than estimateGas saw), else the estimate × 1.2", () => {
  assert.equal(gasLimit(500_000n, SETTLE_GAS_MIN), SETTLE_GAS_MIN);
  assert.equal(gasLimit(2_000_000n, SETTLE_GAS_MIN), 2_400_000n);
  assert.equal(gasLimit(100_000n), 120_000n, "no floor: unchanged");
  assert.ok(SETTLE_GAS_MIN >= (1_628_868n * 11n) / 10n, "the measured worst case + 10% (GamePot.t.sol test_gas_settleWorstCase (c))");
});

test("GamePot draw: request from the list's eta; settle once VRF delivered; void after DRAW_SETTLE_WINDOW", () => {
  assert.deepEqual(potActions(pot({ draw: req({ eta: T }) })), ["requestDraw"]);
  assert.deepEqual(potActions(pot({ draw: req({ eta: T + 1 }) })), [], "the Safe's veto hour");
  assert.deepEqual(potActions(pot({ draw: req({ reqId: 7n, requestedAt: T - H }) })), [], "requested: wait for the VRF");
  assert.deepEqual(potActions(pot({ draw: req({ reqId: 7n, requestedAt: T - H, fulfilledAt: T - 1 }) })), ["settle"]);
  assert.deepEqual(potActions(pot({ draw: req({ reqId: 7n, requestedAt: T - 8 * D, fulfilledAt: T - C.DRAW_SETTLE_WINDOW + 1 }) })), ["settle"]);
  assert.deepEqual(potActions(pot({ draw: req({ reqId: 7n, requestedAt: T - 8 * D, fulfilledAt: T - C.DRAW_SETTLE_WINDOW }) })), ["voidDraw"]);
});

test("GamePot: abort after VRF_TIMEOUT; rescue only when stuck now AND STALL since the first unfulfilled request; never a fulfilled draw", () => {
  assert.deepEqual(potActions(pot({ draw: req({ reqId: 7n, requestedAt: T - C.VRF_TIMEOUT }), stalledSince: T - C.VRF_TIMEOUT })), ["abortDraw"]);
  assert.deepEqual(potActions(pot({ draw: req({ reqId: 7n, requestedAt: T - C.VRF_TIMEOUT + 1 }), stalledSince: T - 20 * D })), [], "not stuck yet");
  assert.deepEqual(potActions(pot({ draw: req({ reqId: 7n, requestedAt: T - 2 * D }), stalledSince: T - C.STALL })), ["rescueToBuyback"]);
  assert.deepEqual(potActions(pot({ draw: req({ reqId: 7n, requestedAt: T - 2 * D }), stalledSince: T - C.STALL + 1 })), ["abortDraw"]);
  assert.deepEqual(potActions(pot({ draw: req({ reqId: 7n, requestedAt: T - 2 * D, fulfilledAt: T - D }), stalledSince: 0 })), ["settle"], "delivered: settle, never abort");
});

test("GamePot: draw interval executes after its delay; idea rewards pay once their public hour is over", () => {
  assert.deepEqual(potActions(pot({ pending: { eta: T } })), ["executeDrawInterval"]);
  assert.deepEqual(potActions(pot({ pending: { eta: T + 1 } })), []);
  const queued = T - C.QUEUE_DELAY;
  assert.deepEqual(rewardsDue([{ id: 1, amount: C.MIN_REWARD, eta: queued }, { id: 2, amount: C.MIN_REWARD, eta: T + 1 }, { id: 3, amount: 0n, eta: queued }], T), [1],
    "due; still in the Safe's hour; paid or cancelled on chain (amount 0)");
  assert.deepEqual(rewardsDue([], T), []);
});

test("claims expire after CLAIM_WINDOW; claimed ones never", () => {
  assert.deepEqual(expiredClaims([
    { drawId: 1, wonAt: T - C.CLAIM_WINDOW, claimed: false }, { drawId: 2, wonAt: T - C.CLAIM_WINDOW + 1, claimed: false },
    { drawId: 3, wonAt: T - 60 * D, claimed: true }, { drawId: 4, wonAt: 0, claimed: false },
  ], T), [1]);
});

test("jackpot params go to the next window that can still be anchored before it starts (≥ 30 min ahead)", () => {
  const s = { windowId: 3, windowEnd: T + 2 * H, drawInterval: D };
  assert.deepEqual(nextParamsWindow(s, T), { window: 4, start: T + 2 * H });
  assert.deepEqual(nextParamsWindow(s, T + 2 * H - 30 * 60), { window: 4, start: T + 2 * H }, "exactly the margin");
  assert.deepEqual(nextParamsWindow(s, T + 2 * H - 30 * 60 + 1), { window: 5, start: T + 2 * H + D }, "too close: the one after");
  assert.deepEqual(nextParamsWindow(s, T + 3 * D), { window: 7, start: T + 2 * H + 3 * D }, "after an outage: unrolled windows start every interval from the open window's end");
});

test("jackpot lists: only the latest closed window, within LIST_GRACE, never drawn, never over a draw in flight or a posted list", () => {
  assert.deepEqual(latestClosed({ windowId: 5, windowStart: T - H, windowEnd: T + H }, T), { window: 4, end: T - H });
  assert.deepEqual(latestClosed({ windowId: 5, windowStart: T - H, windowEnd: T }, T), { window: 5, end: T }, "ended, not rolled: it is the latest closed");
  assert.deepEqual(latestClosed({ windowId: 0, windowStart: 0, windowEnd: 0 }, T), { window: 0, end: 0 });
  const ok = { now: T, end: T - H, window: 4, lastDrawnWindow: 3, draw: { window: 0, reqId: 0n, fulfilledAt: 0 } };
  assert.equal(listBlocked(ok), null);
  assert.equal(listBlocked({ ...ok, window: 0 }), "no closed window yet");
  assert.equal(listBlocked({ ...ok, now: T - H + J.LIST_GRACE }), null, "the grace's last second");
  assert.equal(listBlocked({ ...ok, now: T - H + J.LIST_GRACE + 1 }), "the list grace for this window is over");
  assert.equal(listBlocked({ ...ok, lastDrawnWindow: 4 }), "this window was drawn");
  assert.equal(listBlocked({ ...ok, draw: { window: 3, reqId: 9n, fulfilledAt: 0 } }), "a draw is in flight");
  assert.equal(listBlocked({ ...ok, draw: { window: 3, reqId: 9n, fulfilledAt: T } }), "a draw is in flight");
  assert.equal(listBlocked({ ...ok, draw: { window: 4, reqId: 0n, fulfilledAt: 0 } }), "this window's list is posted");
  assert.equal(listBlocked({ ...ok, draw: { window: 3, reqId: 0n, fulfilledAt: 0 } }), null, "an older unrequested list is replaced");
});

test("the jackpot cap: 2% until a posted draw had ≥ 100 wallets, then 1% (no posted draw = 2%: a small pool still draws)", () => {
  assert.deepEqual([capFor(undefined), capFor(null), capFor(100), capFor(5_000), capFor(99), capFor(50), capFor(0)], [200, 200, 100, 100, 200, 200, 200]);
  assert.equal(JACKPOT_POLICY.capBps, CAP_POLICY.normal, "one source of the 1%");
  // only a recent draw counts (windows w−2, w−3 for window w): an old big draw doesn't pin 1% forever
  const big = (window: number) => ({ window, holders: 150 });
  assert.deepEqual([capForWindow(10, big(8)), capForWindow(10, big(7)), capForWindow(10, big(6)), capForWindow(10, null), capForWindow(10, { window: 8, holders: 80 })], [100, 100, 200, 200, 200]);
  assert.ok([capFor(0), capFor(1_000)].every((c) => c >= J.CAP_BPS[0] && c <= J.CAP_BPS[1]), "inside the contract's bounds");
});

test("the exchange wallet list is valid: addresses, unique, never 0x0 (pinned by hash in each window's params)", () => {
  const seen = new Set<string>();
  for (const a of CEX_WALLETS) {
    assert.match(a, /^0x[0-9a-fA-F]{40}$/);
    assert.notEqual(BigInt(a), 0n);
    assert.ok(!seen.has(a.toLowerCase()), `duplicate ${a}`);
    seen.add(a.toLowerCase());
  }
});

test("ballots only while ≥ 1% of DNA is staked; below that the AI picks", () => {
  const S = 10n ** 27n;
  assert.ok(ballotsOpen(S / 100n, S) && ballotsOpen(S, S));
  assert.ok(!ballotsOpen(S / 100n - 1n, S) && !ballotsOpen(0n, S) && !ballotsOpen(0n, 0n));
  assert.equal(VOTES_CLOSED, "AI pick (votes open at 1% staked)");
});

test("mysteries: reveal inside the window, broken after it", () => {
  assert.ok(revealDue({ status: 1, revealAt: T }, T) && !brokenDue({ status: 1, revealAt: T }, T));
  assert.ok(!revealDue({ status: 1, revealAt: T + 1 }, T));
  assert.ok(brokenDue({ status: 1, revealAt: T - C.REVEAL_WINDOW }, T) && !revealDue({ status: 1, revealAt: T - C.REVEAL_WINDOW }, T));
  assert.ok(!brokenDue({ status: 2, revealAt: T - 10 * D }, T), "revealed is not broken");
});

test("commitment = keccak256(salt ‖ payload), as MutationBoard computes it", () => {
  const salt = toHex(7n, { size: 32 });
  const payload = toHex('{"op":"SetParams","vector":[22500,0,22500]}');
  assert.equal(commitmentOf(salt, payload), keccak256(concat([salt, payload])));
});

test("draw interval: the time for the jackpot inflow to reach ~1 ETH, within [12 h, 24 h], only on a > 25% move", () => {
  const E = 10n ** 18n;
  assert.equal(GAME_POLICY.maxInterval, 24 * H, "default cap 24 h");
  assert.equal(desiredInterval(2n * E, D), 12 * H); // 2 ETH/day → 12 h
  assert.equal(desiredInterval(10n * E, D), 12 * H, "floor 12 h");
  assert.equal(desiredInterval(E / 100n, 12 * H), 24 * H, "low inflow → the 24 h cap");
  assert.equal(desiredInterval(E / 100n, 3 * D), 24 * H, "a 72 h interval already set is brought down to 24 h");
  assert.equal(desiredInterval(E / 100n, D), null, "at the cap with low inflow: keep");
  assert.equal(desiredInterval(E, D), null, "already right");
  assert.equal(desiredInterval(E * 6n / 5n, D), null, "within 25%");
  assert.equal(desiredInterval(0n, D), null, "no inflow: keep");
  assert.equal(desiredInterval(0n, 3 * D), 24 * H, "no inflow, above the cap: down to it");
  const p = { ...GAME_POLICY, maxInterval: 60 * H };
  assert.equal(desiredInterval(E / 100n, 3 * D, p), 60 * H, "above the cap even within 25%");
});

test("the engine's constants mirror the contracts' (a contract change must update src/games.ts)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = ["GamePot", "MutationBoard"].map((f) => readFileSync(new URL(`../../contracts/src/${f}.sol`, import.meta.url), "utf8")).join("\n");
  const unit: Record<string, number> = { hours: 3600, days: 86_400 };
  const val = (name: string) => {
    const m = src.match(new RegExp(`constant ${name} = (\\d+) (hours|days);`));
    assert.ok(m, `${name} not found`);
    return Number(m[1]) * unit[m[2]];
  };
  for (const k of ["VRF_TIMEOUT", "STALL", "CLAIM_WINDOW", "DRAW_SETTLE_WINDOW", "QUEUE_DELAY", "BUDGET_PERIOD", "MIN_INTERVAL", "MAX_INTERVAL", "BALLOT_EVERY", "VOTING", "VETO_WINDOW", "REVEAL_MIN", "REVEAL_WINDOW"] as const) assert.equal(C[k], val(k), k);
  for (const k of ["LIST_DELAY", "LIST_GRACE", "DRAW_SETTLE_WINDOW"] as const) assert.equal(J[k], val(k), k);
  assert.deepEqual([J.LIST_DELAY, J.LIST_GRACE, J.DRAW_SETTLE_WINDOW], [3600, 24 * 3600, 7 * 86_400], "list delay 1 h, grace 24 h, draw settle 7 d");
  const num = (name: string) => src.match(new RegExp(`constant ${name} = ([\\d_]+)( ether)?;`))!;
  assert.deepEqual([Number(num("MIN_CAP_BPS")[1]), Number(num("MAX_CAP_BPS")[1])], [...J.CAP_BPS]);
  assert.deepEqual(["MIN_BALANCE_FLOOR", "MIN_BALANCE_CEIL"].map((k) => BigInt(num(k)[1].replaceAll("_", "")) * 10n ** 18n), [...J.MIN_BALANCE]);
  assert.match(src, /constant MIN_PRIZE = 0\.25 ether;/);
  assert.match(src, /constant MIN_REWARD = 0\.01 ether;/);
  assert.equal(C.MIN_REWARD, 10n ** 16n, "0.01 ETH");
  assert.equal(BigInt(num("MAX_REWARD_BPS")[1].replaceAll("_", "")), C.MAX_REWARD_BPS, "25% per reward and per day");
  assert.equal(J.MIN_PRIZE, 25n * 10n ** 16n, "0.25 ETH, 0.025 per winner");
  assert.match(src, /constant WINNERS = 10;/);
  assert.match(src, /constant MAX_TICKETS = 32;/);
  assert.deepEqual([WINNERS, MAX_TICKETS], [10, 32]);
  assert.ok(JACKPOT_POLICY.capBps >= J.CAP_BPS[0] && JACKPOT_POLICY.capBps <= J.CAP_BPS[1] && JACKPOT_POLICY.capBps === 100, "a true 1% cap");
  assert.ok(JACKPOT_POLICY.minBalance >= J.MIN_BALANCE[0] && JACKPOT_POLICY.minBalance <= J.MIN_BALANCE[1]);
  assert.deepEqual([C.BALLOT_EVERY, C.VOTING, C.REVEAL_MIN], [48 * 3600, 24 * 3600, 2 * 86_400], "a ballot every 48 h, 24 h voting, 2 d reveal");
  // ConvictionVault's weights, as the ticket builder evaluates them
  const vault = readFileSync(new URL("../../contracts/src/ConvictionVault.sol", import.meta.url), "utf8");
  const t0 = vault.match(/return tier == 0 \? (\d+) (hours|days) : \(tier == 1 \? (\d+) (hours|days) : (\d+) (hours|days)\)/)!;
  assert.deepEqual([Number(t0[1]) * unit[t0[2]], Number(t0[3]) * unit[t0[4]], Number(t0[5]) * unit[t0[6]]], [12 * 3600, 3 * 86_400, 7 * 86_400], "ConvictionVault.term");
  const sm = vault.match(/age >= (\d+) days \? 200 : \(age >= (\d+) days \? 150 : \(age >= (\d+) days \? 125/)!;
  assert.deepEqual(STREAK_STEPS, [Number(sm[3]), Number(sm[2]), Number(sm[1])].map((x) => x * 86_400), "ConvictionVault.streakMult");
  const tm = vault.match(/return tier == 0 \? (\d+) : \(tier == 1 \? (\d+) : (\d+)\);/)!;
  assert.deepEqual(tm.slice(1, 4).map(Number), [200, 250, 300], "ConvictionVault.tierMult");
  assert.match(vault, /\? tierMult\(tier\) : 2 \* BPS\) \* streakMult\(age\)/, "×2 after the term");
  assert.match(vault, new RegExp(`constant MAX_MULT = ${MAX_MULT.toLocaleString("en-US").replaceAll(",", "_")};`));
  const pos = (tier: number, ageDays: number) => ({ id: 1, owner: "0x1" as const, amount: 1n, start: 0, terms: [{ termStart: 0, tier }], withdrawnAt: null });
  assert.deepEqual([multAt(pos(0, 0), 0), multAt(pos(1, 0), 0), multAt(pos(2, 0), 0)], [20_000, 25_000, 30_000], "×2 / ×2.5 / ×3 in term");
  assert.equal(multAt(pos(0, 0), 13 * 3600), 20_000, "×2 after the term");
  assert.equal(multAt(pos(1, 0), 2 * 86_400), 31_250, "×2.5 × ×1.25");
  assert.equal(multAt(pos(2, 0), 6 * 86_400), 40_000, "×3 × ×1.5 = ×4.5 → ×4 ceiling");
  assert.equal(multAt(pos(0, 0), 10 * 86_400), 40_000, "×2 × ×2 = ×4");
  assert.match(vault, /constant MIN_AGE = 12 hours;/);
  assert.equal(GAME_POLICY.mysteryEveryS, 7 * 86_400, "a new mystery each week");
  // the site says the same (homepage organs, /play)
  const web = (p: string) => readFileSync(new URL(`../../web/app/${p}`, import.meta.url), "utf8");
  assert.match(vault, /constant MIN_LOCK = 10_000 ether;/, "the 10,000 DNA staking minimum /play states");
  const min = (JACKPOT_POLICY.minBalance / 10n ** 18n).toLocaleString("en-US");
  for (const [file, s] of [["_dna/DNA.tsx", "Every two days the AI puts three fee mutations on a ballot"], ["_dna/DNA.tsx", "It opens about two days later"],
    ["_dna/DNA.tsx", `Hold ${min}+ DNA`], ["_dna/DNA.tsx", "10 wallets split the pot equally"], ["_dna/DNA.tsx", "Stakers count ×2 to ×4"],
    ["play/page.tsx", `Hold at least ${min} DNA on average`], ["play/page.tsx", `Anyone averaging ${min}+ DNA over the window`],
    ["play/page.tsx", "Stake 10,000+ DNA for 12 hours (×2), 3 days (×2.5) or 7 days (×3)"], ["play/page.tsx", "×1.25 after 2 days, ×1.5 after 5, ×2 after 10"], ["play/page.tsx", "Never above ×4"],
    ["play/page.tsx", `No wallet holds more than ${capFor(null) / 100}% of the tickets (${JACKPOT_POLICY.capBps / 100}% once a recent draw had ${10_000 / JACKPOT_POLICY.capBps}+ wallets)`], ["play/page.tsx", `Fewer than ${10_000 / capFor(null)} eligible wallets: no draw`],
    ["play/page.tsx", "Sent to each winner automatically"], ["play/page.tsx", "10 different wallets per draw, equal shares. The prize is at least 0.25 ETH and at most 3 ETH."], ["play/page.tsx", "has 7 days to claim"],
    ["play/page.tsx", "Once a week the AI seals a hidden fee mutation"], ["play/page.tsx", "Stakers vote for 24 hours"], ["play/page.tsx", "votes open at 1%"], ["play/page.tsx", "Every 12 hours to 3 days"], ["play/page.tsx", "once it's 12 hours old"],
    ["play/page.tsx", "The Safe has 1 hour to veto it"]] as const) {
    assert.ok(web(file).includes(s), `${file}: ${s}`);
  }
});

test("Telegram: game proposals alert the signers with the Safe's cancel deadline", async () => {
  const { describe } = await import("../src/watch.ts");
  const by = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const ev = (eventName: string, args: Record<string, unknown>) => ({ eventName, args, transactionHash: "0x" as const, blockNumber: 1n });
  assert.match(describe(ev("RewardQueued", { id: 5n, to: by, amount: 10n ** 17n, ideaRef: `0x${"ab".repeat(32)}`, eta: BigInt(T) }))!, /0\.1 ETH to 0x3C44…93BC .*cancelReward\(5\) until then/);
  assert.match(describe(ev("BallotProposed", { ballot: 3n, start: BigInt(T), by }))!, /cancelBallot\(3\)/);
  assert.match(describe(ev("DrawIntervalProposed", { value: 172_800, eta: BigInt(T), by }))!, /48 h .*cancelDrawInterval/);
  assert.match(describe(ev("Sealed", { mystery: 2n, revealAt: BigInt(T), by }))!, /cancelSeal\(2\)/);
  assert.match(describe(ev("ListPosted", { window: 4n, holders: 120n, totalTickets: 1_000n, capBps: 100n, eta: BigInt(T) }))!, /120 holders.*cancelList\(4\) until the draw is requested/);
  assert.match(describe(ev("WinnerExcluded", { window: 4n, winner: by, prize: 0n }))!, /excluded; the walk skipped it/);
});

test("ballot candidates: distinct, inside the policy bounds, not the current vector", () => {
  const base: [number, number, number] = [20_000, 0, 20_000];
  const c = ballotCandidates(base);
  assert.ok(c.length >= 3);
  assert.equal(new Set(c.map((v) => v.join())).size, c.length);
  for (const v of c) {
    assert.ok(v[0] >= POLICY.base[0] && v[0] <= POLICY.base[1] && v[2] >= v[0] && v[2] <= POLICY.cap[1]);
    assert.notEqual(v.join(), base.join());
  }
});

test("a voted or sealed vector outside the plate's bounds is refused, never clamped into another one", () => {
  const plate = { min: [10_000, 0, 10_000], max: [30_000, 5_000, 30_000] } as never;
  const inside: [number, number, number] = [20_000, 0, 20_000];
  assert.equal(boundsIssue(inside, clampVector(inside, plate)), null);
  const outside: [number, number, number] = [40_000, 0, 40_000];
  assert.equal(boundsIssue(outside, clampVector(outside, plate)), "outside the plate's bounds");
});

test("records keyed by a predicted id count only if they match the chain (ballot descriptors)", () => {
  const a = `0x${"01".repeat(32)}`, b = `0x${"02".repeat(32)}`;
  assert.ok(sameDescriptors([a, b], [a.toUpperCase().replace("0X", "0x"), b]));
  assert.ok(!sameDescriptors([a, b], [b, a]) && !sameDescriptors(undefined, [a]) && !sameDescriptors([a], [a, b]));
});

test("fail-closed alerts: a VRF request open > 30 min, a split fallback with a module set, a game tx revert that is no gate", () => {
  const asked = { ...noDraw, window: 3, reqId: 9n, requestedAt: T - 30 * 60 };
  assert.equal(vrfOverdue({ ...asked, requestedAt: T - 30 * 60 + 1 }, T), false, "29 min 59 s");
  assert.equal(vrfOverdue(asked, T), true);
  assert.equal(vrfOverdue({ ...asked, fulfilledAt: T - 60 }, T), false, "fulfilled");
  assert.equal(vrfOverdue(noDraw, T), false, "nothing requested");
  const module = `0x${"00".repeat(19)}aa`;
  assert.equal(splitFellBack(`0x${"00".repeat(20)}`, true), false, "no module: the expected baseline (before the launch split, after a rollback)");
  assert.equal(splitFellBack(module, true), true);
  assert.equal(splitFellBack(module, false), false);
  for (const why of ["PrizeTooSmall", "GasTooHigh", "TooEarly", "NoList", "InFlight"]) assert.equal(unexpectedRevert("requestDraw", why), false, why);
  assert.equal(unexpectedRevert("requestDraw", "reverted"), true, "a coordinator error GamePot's ABI can't name");
  assert.equal(unexpectedRevert("requestDraw", "Unauthorized"), true);
  assert.equal(unexpectedRevert("settle", "BadProof"), true, "our list doesn't match the root");
  assert.equal(unexpectedRevert("payReward", "Unauthorized"), false, "the agent is paused: nothing pays, by design");
  assert.equal(unexpectedRevert("executeDrawInterval", "Unauthorized"), true, "a lost proposer right: the Safe cancels it");
  assert.equal(unexpectedRevert("reveal", "BadReveal"), true, "our sealed preimage doesn't open the commitment");
});
