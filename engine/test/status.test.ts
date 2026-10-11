// What the engine tells X about the project between events (src/status.ts) and the X fact sheets of the dev team's
// events (src/voice.ts): the twice-daily status and the weekly recap on their hours, every number from code (fixtures
// here), a quiet window skipped, milestones once per threshold, a distinct shape for status posts. DB-backed dedupe
// (each key announced and queued once) is in status-db.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { periodStart } from "../src/jobs.ts";
import { crossed, MILESTONES, milestoneFacts, milestoneKey, recapFacts, RECAP_AT, STATUS_HOURS, statusFacts, type StatusInput, xSchedules } from "../src/status.ts";
import { claimIssues, factNumbers, factSheet, HARD_BOUNDS, postFilter, SHAPES, shapesFor, WRITER, writerCall } from "../src/voice.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("schedule: status at 14:00 and 22:00 UTC every day, the recap Sundays at 18:00 UTC, milestones hourly", () => {
  assert.deepEqual(STATUS_HOURS, [14, 22]);
  assert.deepEqual(RECAP_AT, { weekday: 0, hour: 18 });
  const s = xSchedules();
  const status = s.filter((x) => x.kind === "x:status");
  const recap = s.filter((x) => x.kind === "x:recap");
  assert.equal(status.length, 2);
  assert.equal(recap.length, 1);
  // every period start a status schedule produces over a week, minute by minute
  const week = Date.UTC(2026, 9, 5); // a Monday
  const starts = new Set<string>();
  const recaps = new Set<string>();
  for (let t = week; t < week + 7 * DAY; t += MIN) {
    for (const x of status) starts.add(periodStart(t, x.everyMs, x.offsetMs).toISOString());
    recaps.add(periodStart(t, recap[0].everyMs, recap[0].offsetMs).toISOString());
  }
  const hours = [...starts].filter((x) => x >= new Date(week).toISOString()).map((x) => x.slice(11, 16));
  assert.deepEqual([...new Set(hours)].sort(), ["14:00", "22:00"], "only these two hours");
  assert.equal(hours.length, 14, "two a day for seven days");
  const r = [...recaps].filter((x) => x >= new Date(week).toISOString());
  assert.deepEqual(r, ["2026-10-11T18:00:00.000Z"], "the week's one recap: Sunday 18:00");
  assert.equal(new Date(r[0]).getUTCDay(), 0);
  // payload periods are distinct jobs (jobs.ts schedule dedupes them by kind and start): the due hour rides along
  for (const x of [...status, ...recap]) assert.deepEqual(x.payload!(new Date("2026-10-09T14:00:00Z")), { due: "2026-10-09T14:00:00.000Z" });
  assert.ok(s.some((x) => x.kind === "x:milestones" && x.everyMs === HOUR));
});

/** A 12 h window as the engine reads it (fixtures: chain rows, the snapshot, signed build rows). */
const input: StatusInput = {
  hours: 12, swaps: 41, volumeEth: 3.2149, feesEth: 0.064213, burnedDna: 120_000, buybackPotEth: 0.12345, jackpotPotEth: 1.5,
  gamesLive: 2, liveFee: { basePct: 2, multiplier: 1.5, capPct: 5 }, testing: { stage: "canary", plate: "B" },
  devTeam: { stage: "building", round: 2, title: "Last Click" },
};

test("status facts: every number from the fixture (code), rounded by code; the writer may state only those", () => {
  const { facts, quiet } = statusFacts(input, undefined);
  assert.equal(quiet, false);
  assert.deepEqual(facts, {
    event: "status", hours: 12, swaps: 41, volumeEth: 3.21, feesEth: 0.0642, burnedDna: 120_000, buybackPotEth: 0.123, jackpotPotEth: 1.5, gamesLive: 2,
    liveFee: { basePct: 2, multiplier: 1.5, capPct: 5 }, testing: { stage: "canary", plate: "B" }, devTeam: { stage: "building", round: 2, title: "Last Click" }, moved: ["DNA burned", "swaps"],
  });
  // the first status has nothing to compare with: no `changed` (an empty list read as "nothing moved" on launch day)
  assert.equal((facts as Record<string, unknown>).changed, undefined);
  const launch = statusFacts({ ...input, launchTax: { eth: 0.585, swaps: 14, volumeEth: 0.65 }, burnedDna: 19_802_529 }, undefined).facts;
  assert.deepEqual(launch.moved, ["the launch tax: all of it to buyback-and-burn", "DNA burned", "swaps"], "it leads with the burn");
  // a raw counter never reaches a post: the writer gets 19.8M and only that form passes
  const ls = factSheet(launch);
  assert.deepEqual([postFilter("19.8M DNA burned on launch day.", factNumbers(ls)), postFilter("19802529 DNA burned.", factNumbers(ls)), postFilter("19,802,529 DNA burned.", factNumbers(ls))],
    [[], ["number 19802529"], ["number 19802529"]]);
  assert.equal((writerCall(ls, []).input as { facts: { burnedDna: unknown } }).facts.burnedDna, "19.8M");
  const sheet = factSheet(facts);
  const fixture = new Set(["12", "41", "3.21", "0.0642", "120000", "0.123", "1.5", "2", "5"]); // the code-rounded fixture values
  for (const v of factNumbers(sheet)) assert.ok(fixture.has(v) || Object.values(HARD_BOUNDS).map(String).includes(v), `${v} is not a code number`);
  // model-written text never carries a number into the sheet: a title with a digit is dropped, one with a link too
  for (const title of ["Game 2048", "see evil.example", "ask @someone"]) {
    const t = factSheet(statusFacts({ ...input, devTeam: { stage: "building", round: 1, title } }, undefined).facts);
    assert.deepEqual(t.devTeam, { stage: "building", round: 1 }, title);
  }
  // what changed since the last status: the pots, games, the fee and the dev team
  const next = statusFacts({ ...input, gamesLive: 3, devTeam: { stage: "idle" } }, facts);
  assert.deepEqual(next.facts.changed, ["gamesLive", "devTeam"]);
});

test("a quiet window: no swaps, nothing burned, nothing changed since the last status ⇒ no status post (silence)", () => {
  const prev = statusFacts(input, undefined).facts;
  const still = { ...input, swaps: 0, volumeEth: 0, feesEth: 0, burnedDna: 0 };
  assert.equal(statusFacts(still, prev).quiet, true);
  assert.equal(statusFacts({ ...still, jackpotPotEth: 1.6 }, prev).quiet, false, "a pot that moved is news");
  assert.equal(statusFacts({ ...still, swaps: 1 }, prev).quiet, false);
  assert.equal(statusFacts({ ...still, burnedDna: 5 }, prev).quiet, false);
  assert.equal(statusFacts(still, undefined).quiet, true, "no activity and no earlier status: still quiet");
});

test("status and recap posts may take the ledger shape among the others; other posts never", () => {
  assert.ok(shapesFor("post", { event: "status", changed: ["gamesLive"] }).includes("status ledger"));
  assert.ok(shapesFor("post", { event: "recap" }).includes("status ledger"));
  assert.ok(!shapesFor("post", { event: "outcome" }).includes("status ledger"));
  assert.ok(SHAPES["status ledger"].length > 5);
  assert.match(WRITER, /`stage`/);
  assert.match(WRITER, /`changed`/);
});

test("milestones: the highest round threshold crossed; burned once per threshold ever, the jackpot pot once per climb", () => {
  assert.equal(crossed(999_999, MILESTONES.dna_burned), null);
  assert.equal(crossed(1_000_000, MILESTONES.dna_burned), 1_000_000);
  assert.equal(crossed(7_400_000, MILESTONES.dna_burned), 5_000_000, "a jump past two posts the highest only");
  assert.equal(crossed(0.49, MILESTONES.jackpot_pot), null);
  assert.equal(crossed(1.08, MILESTONES.jackpot_pot), 1);
  // a run of hourly reads (burned only grows; the pot grows, is drawn, grows again): one key per threshold, the pot's
  // per draw count
  const keys: string[] = [];
  const seen = new Set<string>();
  const fire = (metric: "dna_burned" | "jackpot_pot", v: number, draws = "0") => {
    const f = milestoneFacts(metric, v);
    if (!f) return;
    const key = milestoneKey(metric, f.threshold, draws);
    if (!seen.has(key)) { seen.add(key); keys.push(key); } // the outbox and the announce record dedupe by key
  };
  for (const v of [0, 400_000, 1_000_001, 1_200_000, 2_000_000, 2_600_000, 2_700_000, 12_000_000]) fire("dna_burned", v, "3");
  for (const [v, draws] of [[0.2, "0"], [0.6, "0"], [0.9, "0"], [1.1, "0"], [1.15, "0"], [0.1, "1"], [0.7, "1"], [1.2, "1"], [1.3, "1"], [2.6, "1"]] as const) fire("jackpot_pot", v, draws);
  assert.deepEqual(keys, ["milestone:dna_burned:1000000", "milestone:dna_burned:2500000", "milestone:dna_burned:10000000",
    "milestone:jackpot_pot:0:0.5", "milestone:jackpot_pot:0:1",
    "milestone:jackpot_pot:1:0.5", "milestone:jackpot_pot:1:1", "milestone:jackpot_pot:1:2.5"], "a draw empties the pot: the next climb past 1 ETH posts again");
  assert.equal(milestoneKey("dna_burned", 1_000_000, "7"), "milestone:dna_burned:1000000", "burned: never per draw");
  const f = milestoneFacts("dna_burned", 1_204_332.9)!;
  assert.deepEqual(f, { event: "milestone", metric: "dna_burned", threshold: 1_000_000, value: 1_204_332 });
  // no bounds (they answer nothing here); no field name (`metric`) or banned word (`threshold`) for the writer to copy
  assert.deepEqual(Object.keys(factSheet(f)).sort(), ["event", "label", "mark", "value"]);
  assert.deepEqual(postFilter("1.2M DNA burned, past the 1M mark.", factNumbers(factSheet(f))), []);
  assert.ok(postFilter("dna_burned is 1.2M", factNumbers(factSheet(f))).includes("field name"));
});

test("recap: what shipped, what was killed, what changed in fees and games, from signed announcements; nothing ⇒ none", () => {
  const docs = [
    { type: "seq_shipped", facts: { title: "Last Click" } }, { type: "seq_killed", facts: { title: "Coin Flip 2" } }, { type: "seq_killed", facts: { title: "Dice" } },
    { type: "seq_released", facts: { title: "Docs fix", target: "site" } }, { type: "seq_released", facts: { title: "Calm fee", target: "module" } },
    { type: "game_retired", facts: { title: "Old" } }, { type: "outcome", facts: { outcome: "kept (promoted)" } }, { type: "outcome", facts: { outcome: "killed" } },
    { type: "outcome", facts: { outcome: "rolled back" } }, { type: "module_approved", facts: {} }, { type: "seq_handoff", facts: { title: "Faster reads" } },
  ];
  const r = recapFacts(docs, { gamesLive: 2, liveFee: { basePct: 2, multiplier: 1, capPct: 5 } })!;
  assert.deepEqual(r, {
    event: "recap", days: 7, gamesShipped: 1, siteChanges: 1, modulesProposed: 1, modulesApproved: 1, handedOver: 1, buildsKilled: 2, gamesRetired: 1,
    experimentsKept: 1, experimentsKilled: 2, gamesLive: 2, liveFee: { basePct: 2, multiplier: 1, capPct: 5 }, shipped: ["Last Click"], killed: ["Coin Flip 2", "Dice"],
  });
  assert.deepEqual(factSheet(r).killed, ["Dice"], "a title with a digit never reaches the writer");
  assert.equal(recapFacts([], { gamesLive: 2, liveFee: { basePct: 2 } }), null, "a week with nothing: no recap");
});

test("the dev team's X fact sheets: allow-listed fields and a code-made stage line; never 'shipped' before it ships", () => {
  const b = { build: "b20261009-7", title: "Last Click", record: "1234" };
  const sheet = (raw: Record<string, unknown>) => factSheet(raw);
  assert.deepEqual(sheet({ event: "seq_started", ...b }), { event: "seq_started", title: "Last Click", stage: "building started; nothing has shipped yet" });
  assert.equal(sheet({ event: "seq_killed", ...b, rounds: 4 }).stage, "tried and dropped: it did not make the bar and nothing shipped");
  assert.equal(sheet({ event: "seq_killed", ...b, rounds: 4 }).rounds, 4);
  assert.match(String(sheet({ event: "seq_online", record: "1" }).stage), /switched on/);
  assert.match(String(sheet({ event: "seq_released", ...b, target: "site" }).stage), /^shipped/);
  assert.match(String(sheet({ event: "seq_released", ...b, target: "module" }).stage), /^proposed to the Safe; nothing changes until the Safe approves/);
  assert.match(String(sheet({ event: "seq_handoff", ...b, pr: 12 }).stage), /^handed to the owners for review; not merged and not running/);
  assert.match(String(sheet({ event: "module_approved", codehash: `0x${"ab".repeat(32)}`, kind: "fee" }).stage), /live fee is unchanged/);
  for (const e of ["seq_shipped", "game_retired", "seq_nothing_today"]) assert.doesNotThrow(() => sheet({ event: e, ...b, slug: "s", game: "0x12", fundEth: 0.05, days: 3, returnedEth: null, day: "2026-10-09", tried: 1 }), e);
  // no build id, record, address or codehash: their digits could only fail the filter
  for (const raw of [{ event: "seq_started", ...b }, { event: "seq_shipped", ...b, slug: "s", game: "0x12ab000000000000000000000000000000009f3c", fundEth: 0.05 }, { event: "module_approved", codehash: `0x${"ab".repeat(32)}`, kind: "fee" }]) {
    const json = JSON.stringify(sheet(raw));
    for (const k of ["b20261009", "1234", "0x12ab", "abab"]) assert.ok(!json.includes(k), `${k} in ${json}`);
  }
});

test("an event that shipped nothing never reads as shipped, live, fixed, merged or approved (code's filter, not the prompt)", () => {
  const b = { title: "Last Click" };
  for (const facts of [{ event: "seq_started", ...b }, { event: "seq_killed", ...b }, { event: "seq_online" }, { event: "seq_handoff", ...b }, { event: "seq_released", ...b, target: "module" }]) {
    for (const t of ["Last Click shipped.", "the dev team fixed the timer", "Last Click is live", "it went live", "now live on main", "merged into main", "the Safe approved it"]) {
      assert.ok(claimIssues(facts, t).length, `${facts.event}: ${t}`);
    }
    assert.deepEqual(claimIssues(facts, "the dev team is on it; nothing to see yet"), [], facts.event);
  }
  // a module approval may say approved, never live (nor shipped, fixed, merged)
  const ok = { event: "module_approved", kind: "fee" };
  assert.deepEqual(claimIssues(ok, "the Safe approved new fee module code"), []);
  for (const t of ["approved and live", "the live fee moves", "shipped", "fixed the fee"]) assert.ok(claimIssues(ok, t).length, t);
  // shipped events and a released site change: unrestricted
  for (const facts of [{ event: "seq_shipped", ...b }, { event: "seq_released", ...b, target: "site" }, { event: "outcome" }]) assert.deepEqual(claimIssues(facts, "shipped, live, fixed"), [], String(facts.event));
  assert.ok(claimIssues({ event: "seq_started" }, "ＳＨＩＰＰＥＤ").length, "NFKC first");
});
