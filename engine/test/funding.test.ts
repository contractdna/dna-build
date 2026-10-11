// Funding amounts and the FIFO-safe queue rule (src/funding.ts), pure: a small start spread over the week, top-ups
// once real players arrive, every cap counted with what is already queued, never 0 and never below MIN_FUND, and
// Delay's head skipped when expired.
import assert from "node:assert/strict";
import { test } from "node:test";
import { daysLeftInWeek, type DelayState, type FundState, fundAmount, fundRoom, headExpired, headReady, MIN_FUND, topupDue } from "../src/funding.ts";

const E = 10n ** 18n;
const eth = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const G = "0x00000000000000000000000000000000000000a1";
const H = "0x00000000000000000000000000000000000000b2";
const NOW = Date.parse("2026-10-09T12:00:00Z");
const DAY = 86_400_000;
const empty = (o: Partial<FundState> = {}): FundState => ({ weeklyBudget: eth(0.2), perGameCap: eth(0.1), spentInWindow: 0n, balance: E, funded: {}, pending: [], ...o });

test("start: the week's budget spread over 7 days on an empty window (≈ 0.0286 ETH), at most the per-game cap", () => {
  assert.equal(fundAmount(empty(), G, NOW, "start"), eth(0.2) / 7n);
  assert.equal(fundAmount(empty({ weeklyBudget: eth(2) }), G, NOW, "start"), eth(0.1), "capped at perGameCap");
});

test("days left in the week: from the oldest spend still counted", () => {
  assert.equal(daysLeftInWeek(empty(), NOW), 7);
  assert.equal(daysLeftInWeek(empty({ oldestSpendAt: NOW - 5.5 * DAY }), NOW), 2);
  assert.equal(daysLeftInWeek(empty({ oldestSpendAt: NOW - 7 * DAY + 1000 }), NOW), 1, "at least 1");
  // 0.15 spent, the oldest spend leaves the window in 2 days: (0.2 − 0.15) / 2 = 0.025
  assert.equal(fundAmount(empty({ spentInWindow: eth(0.15), oldestSpendAt: NOW - 5.5 * DAY }), G, NOW, "start"), eth(0.025));
});

test("queued-but-unexecuted funds count against the week, the game and GameFunder's balance", () => {
  const s = empty({ pending: [{ game: H, amount: eth(0.1) }], spentInWindow: eth(0.05) });
  // 0.2 − 0.05 − 0.1 = 0.05 left, over 7 days ⇒ 0.00714 < MIN_FUND ⇒ nothing
  assert.equal(fundAmount(s, G, NOW, "start"), 0n);
  assert.equal(fundRoom(s, G, eth(0.06), { isGame: true, live: true }), "over the weekly budget");
  assert.equal(fundRoom(empty({ pending: [{ game: G, amount: eth(0.08) }] }), G, eth(0.03), { isGame: true, live: true }), "over the per-game cap");
  assert.equal(fundRoom(empty({ balance: eth(0.05), pending: [{ game: H, amount: eth(0.03) }] }), G, eth(0.03), { isGame: true, live: true }), "GameFunder's balance is short");
  assert.equal(fundRoom(empty(), G, eth(0.03), { isGame: true, live: true }), null);
});

test("never 0, never below MIN_FUND, never a retired or foreign game", () => {
  assert.equal(fundRoom(empty(), G, 0n, { isGame: true, live: true }), "zero amount");
  assert.equal(fundRoom(empty(), G, MIN_FUND - 1n, { isGame: true, live: true }), "below MIN_FUND");
  assert.equal(fundRoom(empty(), G, MIN_FUND, { isGame: false, live: false }), "not a game of the factory");
  assert.equal(fundRoom(empty(), G, MIN_FUND, { isGame: true, live: false }), "the game is retired");
  assert.equal(fundAmount(empty({ spentInWindow: eth(0.2) }), G, NOW, "start"), 0n, "no room: awaiting funding");
});

test("top-ups: after 5 new distinct players with nothing queued for the game; at most a third of the cap and what is left of it", () => {
  assert.equal(topupDue(empty(), G, 4), false);
  assert.equal(topupDue(empty(), G, 5), true);
  assert.equal(topupDue(empty({ pending: [{ game: G, amount: eth(0.02) }] }), G, 9), false);
  const s = empty({ weeklyBudget: eth(2), funded: { [G]: eth(0.03) } });
  assert.equal(fundAmount(s, G, NOW, "topup"), eth(0.1) / 3n);
  assert.equal(fundAmount(empty({ weeklyBudget: eth(2), funded: { [G]: eth(0.08) } }), G, NOW, "topup"), eth(0.02), "up to the per-game cap");
  assert.equal(fundAmount(empty({ weeklyBudget: eth(2), funded: { [G]: eth(0.095) } }), G, NOW, "topup"), 0n, "0.005 left < MIN_FUND");
});

test("the funder key: only Roles or Delay, and only while Roles still has it as an enabled module", async () => {
  const { funderCheck } = await import("../src/tx.ts");
  const dep = { roles: "0x00000000000000000000000000000000000000c1", delay: "0x00000000000000000000000000000000000000c2" } as const;
  assert.equal(funderCheck(dep.roles, true, dep), null);
  assert.equal(funderCheck(dep.delay, true, dep), null);
  assert.match(funderCheck(dep.roles, false, dep)!, /no longer an enabled module/);
  assert.match(funderCheck(G, true, dep)!, /only calls Roles or Delay/);
  assert.match(funderCheck(dep.roles, true, {})!, /no Roles/);
});

test("a fund Delay passed without a Funded for its game stops the game's funding until the Safe funds it once", async () => {
  const { stoppedGames } = await import("../src/funding.ts");
  const rec = (game: string, nonce: number, block: number) => ({ kind: "fund", game, amount: "1", delayNonce: String(nonce), tx: "0x", block: String(block), build: "b", reason: "start", at: "" }) as never;
  // G: its fund at nonce 3 (block 100) executed (Funded at 400); H: its fund at nonce 4 (block 200) was vetoed
  assert.deepEqual([...stoppedGames([rec(H, 4, 200), rec(G, 3, 100)], 5n, { [G]: 400n })], [H]);
  assert.deepEqual([...stoppedGames([rec(H, 4, 200)], 4n, {})], [], "still queued");
  assert.deepEqual([...stoppedGames([rec(H, 4, 200)], 5n, { [H]: 900n })], [], "the Safe funded it afterwards: restarted");
  assert.deepEqual([...stoppedGames([rec(H, 4, 200)], 5n, { [H]: 150n })], [H], "a Funded before the vetoed fund does not count");
});

test("Delay's head: expired ⇒ skip first; ready ⇒ executable", () => {
  const nowS = 1_000_000;
  const q = (o: Partial<DelayState>): DelayState => ({ txNonce: 3n, queueNonce: 4n, headCreatedAt: BigInt(nowS - 1800), cooldown: 3600n, expiration: 86_400n, ...o });
  assert.equal(headReady(q({}), nowS), false, "still cooling down");
  assert.equal(headReady(q({ headCreatedAt: BigInt(nowS - 3600) }), nowS), true);
  assert.equal(headExpired(q({ headCreatedAt: BigInt(nowS - 3600 - 86_401) }), nowS), true);
  assert.equal(headReady(q({ headCreatedAt: BigInt(nowS - 3600 - 86_401) }), nowS), false);
  assert.equal(headExpired(q({ queueNonce: 3n, headCreatedAt: 0n }), nowS), false, "empty queue");
});
