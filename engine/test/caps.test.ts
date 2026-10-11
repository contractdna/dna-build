// LLM spend caps: the launch schedule, the monthly cap, the pause order across budgets, the treasury-scaled ceiling.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isoWithZone } from "../src/enclave.ts";
import { budgetOf, dailyCap, nearCap, orderCeiling, overCap, partition, RESERVE_AGENT, treasuryCap } from "../src/llm.ts";

const D = 86_400_000;
const launch = Date.parse("2026-10-10T12:00:00Z");
// explicit caps: the shell's env never changes what these tests check
const c = {
  launchAt: launch, dailyCapUsd: 100, week1DailyCapUsd: 200, monthlyCapUsd: 3000, treasury: { share: 0.5, floorUsd: 20 },
  subCapsUsd: { research: 20, redteam: 40, rest: 40 }, pauseAt: { research: 0.8 },
};

test("daily cap: $200 for the 7 days after launch, then $100; before launch or without a launch time, $100", () => {
  assert.equal(dailyCap(launch - 1, c), 100);
  assert.equal(dailyCap(launch, c), 200);
  assert.equal(dailyCap(launch + 7 * D - 1, c), 200);
  assert.equal(dailyCap(launch + 7 * D, c), 100);
  assert.equal(dailyCap(launch + 30 * D, c), 100);
  assert.equal(dailyCap(launch, { ...c, launchAt: undefined }), 100);
});

test("treasury-scaled ceiling: a share of daily treasury income, at least the floor, never above the hard cap", () => {
  const t = { share: 0.5, floorUsd: 20 };
  assert.equal(treasuryCap(0, 100, t), 20);
  assert.equal(treasuryCap(100, 100, t), 50);
  assert.equal(treasuryCap(1000, 100, t), 100);
  assert.equal(treasuryCap(1000, 200, t), 200);
  assert.equal(treasuryCap(Number.NaN, 100, t), 20, "a bad income reading is no income");
  assert.equal(treasuryCap(-5, 100, t), 20);
  assert.equal(treasuryCap(1000, 10, t), 10, "the floor never lifts the cap above the hard cap");
  assert.equal(dailyCap(launch + 8 * D, { ...c, treasury: t }, 60), 30, "income given: the lower of the schedule and the treasury ceiling");
  assert.equal(dailyCap(launch, { ...c, treasury: t }, 10_000), 200);
});

test("partition: the Sequencer gets 48% of the day's cap, everything else shares 52%; the order ceiling keeps a whole build inside the dev part", () => {
  const p = { devPct: 0.48, orderCeilingUsd: 12 };
  const r2 = (x: number) => Math.round(x * 100) / 100;
  for (const [cap, dev, shared, ceiling] of [[200, 96, 104, 12], [100, 48, 52, 12], [40, 19.2, 20.8, 4.8], [20, 9.6, 10.4, 2.4]]) {
    const part = partition(cap, p);
    assert.deepEqual([r2(part.dev), r2(part.shared)], [dev, shared], `cap ${cap}`);
    assert.equal(r2(orderCeiling(cap, p)), ceiling, `ceiling at cap ${cap}`);
    assert.ok(4 * orderCeiling(cap, p) <= part.dev + 1e-9, "a whole build (4 orders) fits the dev part");
  }
});

test("cap order: dev and the shared part are independent; research pauses at 80% of the shared part; dev pauses first in a month", () => {
  const caps = { ...c, devPct: 0.48, devMonthlyPct: 0.6, pauseAt: { research: 0.8 }, subCapsUsd: { research: 100, redteam: 100, rest: 100 } };
  const day = (dev: number, shared: number) => ({ total: dev + shared, by: { dev, rest: shared }, month: { total: dev + shared, by: {} } });
  const allowed = (dev: number, shared: number) => ["dev", "research", "redteam", "rest"].filter((b) => overCap(day(dev, shared), b, 1, caps) === null);
  assert.deepEqual(allowed(0, 0), ["dev", "research", "redteam", "rest"]);
  assert.deepEqual(allowed(47.5, 0), ["research", "redteam", "rest"], "dev full: the shared part is untouched");
  assert.deepEqual(allowed(0, 51.5), ["dev"], "shared full: dev is untouched");
  assert.deepEqual(allowed(0, 41), ["dev", "redteam", "rest"], "research stops at 80% of $52 = $41.60");
  assert.deepEqual(allowed(0, 40), ["dev", "research", "redteam", "rest"]);
  assert.match(overCap(day(47.5, 0), "dev", 1, caps)!, /daily LLM cap \$100: the Sequencer's part \$48/);
  assert.match(overCap(day(0, 41), "research", 1, caps)!, /the shared part \$52.*research pauses at 80%/);
  // a $48 whole-build reservation fits an empty dev part exactly, and not a cent more
  assert.equal(overCap(day(0, 0), "dev", 48, caps), null);
  assert.match(overCap(day(0.01, 0), "dev", 48, caps)!, /Sequencer's part/);
  // the monthly cap bounds the total; dev pauses at 60% of it, research at 80%, the rest at 100%
  const month = (total: number) => ({ total: 0, by: {}, month: { total, by: {} } });
  assert.equal(overCap(month(1798), "dev", 1, caps), null);
  assert.match(overCap(month(1800), "dev", 1, caps)!, /monthly LLM cap \$3000.*dev pauses at 60%/);
  assert.equal(overCap(month(2390), "research", 1, caps), null);
  assert.match(overCap(month(2400), "research", 1, caps)!, /monthly LLM cap/);
  assert.equal(overCap(month(2900), "rest", 1, caps), null);
  assert.match(overCap(month(2999.5), "rest", 1, caps)!, /monthly LLM cap/);
  // the other budgets keep their own daily sub-caps
  assert.match(overCap({ total: 30, by: { rest: 30 }, month: { total: 30, by: {} } }, "rest", 1, { ...caps, subCapsUsd: { rest: 30 } })!, /rest LLM cap \$30/);
  // budgets: dev-* agents (and build reservations) are the Sequencer's; the brain counts as rest
  assert.deepEqual(["dev-lead", "dev-worker", RESERVE_AGENT, "brain", "research", "redteam", "main"].map(budgetOf), ["dev", "dev", "dev", "rest", "research", "redteam", "rest"]);
});

test("70% alert per part, on real charges: a build reservation alone never alerts", () => {
  const p = { devPct: 0.48 };
  const s = (by: Record<string, number>, real: Record<string, number>) => ({ total: 0, by, real });
  assert.deepEqual(nearCap(s({ dev: 48 }, { dev: 0 }), 100, 0.7, p), [], "reserved, not charged");
  assert.deepEqual(nearCap(s({ dev: 48 }, { dev: 34 }), 100, 0.7, p).map((n) => n.part), ["dev"]);
  assert.deepEqual(nearCap(s({ rest: 37 }, { rest: 37 }), 100, 0.7, p).map((n) => n.part), ["shared"]);
  assert.deepEqual(nearCap(s({ rest: 36 }, { rest: 36 }), 100, 0.7, p), []);
  assert.deepEqual(nearCap(s({ dev: 10, rest: 37 }, { dev: 10, rest: 37 }), 100, 0.7, p).map((n) => n.part), ["shared"], "dev spend never counts toward the shared part");
});

test("launch time: an ISO date-time that names its zone (LLM_LAUNCH_AT and the compose literal share the check)", () => {
  for (const v of ["2026-10-10T12:00:00Z", "2026-10-10T12:00Z", "2026-10-10T12:00:00.000Z", "2026-10-10T14:00:00+02:00"]) assert.equal(isoWithZone(v), true, v);
  for (const v of ["2026-10-10", "2026-10-10Z", "2026-10-10T12:00:00", "soon", "2026-13-40T12:00:00Z"]) assert.equal(isoWithZone(v), false, v);
});
