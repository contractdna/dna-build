// The idea queue's pure rules (src/idea-queue.ts): the reward's on-chain caps checked BEFORE queueReward (so the queue
// never reverts), the brain's amount clamped into them, where an X idea came from, which "not queued" reasons wait.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clampReward, type Pot, rewardCaps, rewardRoom, transient, xMentionOf } from "../src/idea-queue.ts";

const E = 10n ** 18n;
const NOW = 1_800_000_000;
const pot: Pot = { canPropose: true, excluded: false, minReward: E / 100n, maxBps: 2500n, reserve: 2n * E, reserveCap: 15n * E, budgetStart: BigInt(NOW - 3600), dayBudget: E / 2n, daySpent: E / 10n };

test("reward caps: MIN_REWARD, 25% of the reserve, and what is left of the rolling day's budget", () => {
  assert.deepEqual(rewardCaps(pot, NOW), { min: E / 100n, max: (4n * E) / 10n }, "day budget 0.5 − 0.1 spent = 0.4 < 25% of 2 = 0.5");
  assert.deepEqual(rewardCaps({ ...pot, daySpent: 0n }, NOW), { min: E / 100n, max: E / 2n });
  assert.deepEqual(rewardCaps(pot, NOW + 86_400 - 3600), { min: E / 100n, max: E / 2n }, "a new rolling day: 25% of the reserve again");
  assert.deepEqual(rewardCaps({ ...pot, daySpent: E / 2n }, NOW).max, 0n, "the day's budget is spent");
  // above RESERVE_CAP (a Safe cancel put it there): queueReward's sync cuts it to the cap first, so the checks use the cap
  const over = { ...pot, reserve: 20n * E, reserveCap: 15n * E, dayBudget: 100n * E };
  assert.equal(rewardCaps(over, NOW + 86_400).max, (15n * E) / 4n, "25% of the cap, not of the pre-sync reserve");
  assert.match(rewardRoom(over, (15n * E) / 4n + 1n, NOW)!, /over 25% of the idea reserve/);
  assert.equal(rewardRoom(over, (15n * E) / 4n, NOW), null);
});

test("reward room: every on-chain check queueReward makes, read first", () => {
  assert.equal(rewardRoom(pot, E / 10n, NOW), null);
  assert.equal(rewardRoom(pot, (4n * E) / 10n, NOW), null, "exactly what is left today");
  assert.match(rewardRoom(pot, (4n * E) / 10n + 1n, NOW)!, /over the rolling day's budget/);
  assert.match(rewardRoom({ ...pot, dayBudget: 10n * E }, E / 2n + 1n, NOW)!, /over 25% of the idea reserve/);
  assert.match(rewardRoom(pot, E / 100n - 1n, NOW)!, /below MIN_REWARD/);
  assert.match(rewardRoom({ ...pot, canPropose: false }, E / 10n, NOW)!, /agent can't queue/);
  assert.match(rewardRoom({ ...pot, excluded: true }, E / 10n, NOW)!, /excluded/);
  assert.equal(rewardRoom({ ...pot, daySpent: E / 2n }, E / 10n, NOW + 86_400), null, "the next rolling day starts over");
});

test("the brain's amount: clamped down to the cap, 0 below MIN_REWARD (no reward)", () => {
  const caps = { min: E / 100n, max: E / 4n };
  assert.equal(clampReward(E / 10n, caps), E / 10n);
  assert.equal(clampReward(E, caps), E / 4n);
  assert.equal(clampReward(E / 1000n, caps), 0n);
  assert.equal(clampReward(0n, caps), 0n);
  assert.equal(clampReward(E, { min: E / 100n, max: 0n }), 0n, "no room at all");
});

test("the brain's amount as a float: tiny or huge values never reach parseEther in exponent form; the schema bounds it too", async () => {
  const { rewardWei } = await import("../src/idea-queue.ts");
  const { BrainOut } = await import("../src/brain.ts");
  const caps = { min: E / 100n, max: E / 4n };
  assert.equal(rewardWei(1e-7, caps), 0n, "below MIN_REWARD: no reward, no throw");
  assert.equal(rewardWei(1e21, caps), E / 4n, "clamped to the cap");
  assert.equal(rewardWei(0.05, caps), E / 20n);
  assert.equal(rewardWei(0.1 + 0.2, { ...caps, max: E }), 300000000000000000n, "float noise dropped at the gwei");
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) assert.equal(rewardWei(bad, caps), 0n, `${bad}: no reward`);
  assert.equal(BrainOut.reward.safeParse({ amountEth: 1e21, reason: "x" }).success, false);
  assert.equal(BrainOut.reward.safeParse({ amountEth: 1e-7, reason: "x" }).success, true);
});

test("source: an agent-submitted idea names its X mention; 'not queued' reasons that pass with time wait, the rest skip", () => {
  assert.equal(xMentionOf("Lower the fee at night.\n\n(from X mention 1844000000000000001)"), "1844000000000000001");
  assert.equal(xMentionOf("(from X mention 12) and more text"), null, "only the agent's own suffix");
  assert.equal(xMentionOf("a human's idea"), null);
  for (const w of ["an experiment is already running", "no free AdaptiveFee plate", "the agent already has 2 pending ops (limit 2)", "autonomy level 4 < 5"]) assert.equal(transient(w), true, w);
  for (const w of ["gates failed: retention 45% < 90%", "outside the plate's bounds"]) assert.equal(transient(w), false, w);
});
