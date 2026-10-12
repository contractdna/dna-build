// The lab on X (src/lab.ts) without a database: the window's facts from experiment records like the live ones, the
// verdict words, the fact sheet, the site line, the guards a lab draft goes through, and the cards that now carry
// studio art under a borrowed scene (lab, status, reflection, recap) with a plate when the art does not come.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://x@127.0.0.1:1/x";
const { labFacts, verdictOf, LAB } = await import("../src/lab.ts");
const { titleOf, PRIORITY } = await import("../src/announce.ts");
const { claimIssues, factNumbers, factSheet, postFilter, voiceIssues, MIND_EVENTS } = await import("../src/voice.ts");
const { hasArt, slotsOf, artIssue } = await import("../src/media-slots.ts");
const card = await import("../src/card.ts");

const exp = (id: string, eth: number, swaps: number, note: string, status = "rejected") =>
  ({ id, status, sim: `sim #${id}`, note, metrics: [{ name: "project ETH/day (ε=1)", delta: eth }, { name: "swap retention (ε=1)", delta: swaps }, { name: "fee at cap", delta: 0.1 }] });
// the shapes of 2026-10-11's records (E-0006 … E-0011)
const EXPS = [
  exp("6", 0.79, -5.23, "base 2.30%, multiplier 0.20×, cap 3.30% · Main said no-go: ETH/day rose to 13.131 and swaps held with 0 reverts, but retention fell 5.23%"),
  exp("8", -1.45, 12.62, "base 1.80%, multiplier 0.25×, cap 2.50% · gates failed: project ETH/day at ε=1 13.142141 < baseline 13.335434"),
  exp("10", -0.57, 5.49, "base 2.10%, multiplier 0.12×, cap 3.00% · gates failed: project ETH/day at ε=1 13.497618 < baseline 13.575081"),
  exp("11", 1.15, -8.21, "base 2.50%, multiplier 0.10×, cap 3.20% · Main said no-go: Gates and red team passed and ETH/day rose 1.15%"),
];
const PARAMS = new Map<string, [number, number, number]>([["sim #11", [25000, 1000, 32000]], ["sim #6", [23000, 2000, 33000]]]);
const FINDINGS = [{ kind: "red-team", severity: "medium", status: "open" }, { kind: "red-team", severity: "low", status: "accepted" }, { kind: "guardian", severity: "info", status: "resolved" }];

test("verdicts: fixed words from the record's note, never the brain's own reason (it carries thresholds)", () => {
  assert.equal(verdictOf("base 2.20% · gates failed: swap retention at ε=1 89.2% < 90%"), "it lost too many swaps");
  assert.equal(verdictOf("x · gates failed: project ETH/day at ε=1 11.7 < baseline 12.1"), "it made less ETH than the live fee");
  assert.equal(verdictOf("x · gates failed: fork replay failed: boom"), "it failed a gate");
  assert.equal(verdictOf("x · the red team blocked it"), "the red team blocked it");
  assert.equal(verdictOf("x · the red team blocked this same candidate in this market regime"), "the red team blocked it");
  assert.equal(verdictOf("x · Main said no-go: Gates and red team passed"), "the brain said no-go", "not 'failed a gate' because the reason names the gates");
  assert.equal(verdictOf("x · engine is dry_run: would queue SetParams"), "not queued");
  assert.equal(verdictOf("x · Main said no-go: the red team blocked a similar one last week"), "the brain said no-go", "the brain's own words never read as a red-team block");
});

test("lab facts: counts, the best candidate by simulated ETH a day with its fee, up/down figures without a sign, the red team and research; nothing simulated, no post", () => {
  assert.equal(labFacts(2, [], PARAMS, FINDINGS, 3), null);
  const f = labFacts(2, EXPS, PARAMS, FINDINGS, 3)!;
  assert.deepEqual(f, {
    event: "lab", hours: 2, tested: 4, rejected: 4,
    best: { fee: { basePct: 2.5, multiplier: 0.1, capPct: 3.2 }, ethUpPct: 1.15, swapsDownPct: 8.21, verdict: "the brain said no-go" },
    redTeamFindings: 2, redTeamOpen: 1, researchFindings: 3,
  });
  const g = labFacts(6, [exp("1", -3.86, 32.19, "x · gates failed: project ETH/day < baseline"), exp("2", 0.4, 1, "x · the red team blocked it")], new Map(), [], 0)!;
  assert.deepEqual(g.best, { ethUpPct: 0.4, swapsUpPct: 1, verdict: "the red team blocked it" }, "no sim params: no fee");
  assert.ok(!("redTeamFindings" in g) && !("researchFindings" in g));
  assert.deepEqual([LAB.hours, LAB.afterHours, PRIORITY.lab], [2, 6, 3.5]);
});

test("the lab's fact sheet, site line and guards: simulated said, nothing shipped, only the sheet's numbers", () => {
  const raw = { ...labFacts(2, EXPS, PARAMS, FINDINGS, 3)!, best: { ...labFacts(2, EXPS, PARAMS, FINDINGS, 3)!.best, verdict: "rm -rf", note: "Main said no-go: 13.131" } };
  const s = factSheet(raw);
  assert.equal((s.best as Record<string, unknown>).verdict, undefined, "a verdict outside the list is dropped");
  assert.equal((s.best as Record<string, unknown>).note, undefined, "only the allowed best fields");
  assert.match(String(s.stage), /simulated only/);
  assert.ok(MIND_EVENTS.has("lab"));
  const sheet = factSheet(labFacts(2, EXPS, PARAMS, FINDINGS, 3)!);
  assert.equal(titleOf(sheet), "Lab, last 2 h: 4 fee candidates simulated, 4 rejected; best in simulation: base 2.5%, multiplier 0.1×, cap 3.2%: ETH a day +1.15%, swaps -8.21% (the brain said no-go); red team: 2 findings (1 open); research: 3 findings read. Simulated only: the live fee is unchanged");
  const allowed = factNumbers(sheet);
  const ok = "4 fee tweaks in the sim, 4 binned. the best: 1.15% more eth a day for 8.21% fewer swaps. the brain said no. greed has a price.";
  assert.deepEqual([...postFilter(ok, allowed, 24), ...claimIssues(sheet, ok), ...voiceIssues(sheet, ok, { linked: true })], []);
  assert.deepEqual(voiceIssues(sheet, "4 fee tweaks, 4 binned. 1.15% more eth for 8.21% fewer swaps. no deal.", { linked: true }), ["does not say it was simulated"]);
  assert.deepEqual(voiceIssues(sheet, "4 candidates tested, rejected 1.15 vs 8.21% in the sim", { linked: true }), ["1.15 without %"]);
  assert.ok(postFilter("simulated 4, the best made 1.2% more", allowed, 24).length, "a rounded number is not the sheet's");
  assert.deepEqual(claimIssues(sheet, "the sim says no. the new fee is live."), ["claims it shipped"]);
});

test("studio art for the lab, the status, the reflection and the recap under a borrowed scene (the studio's enum is unchanged); a plate card when it does not come", () => {
  for (const ev of ["lab", "status", "reflection", "recap", "outcome", "digest"]) assert.ok(hasArt(ev), ev);
  assert.ok(!hasArt("queued") && !hasArt("treasury_buy"));
  assert.equal(slotsOf({ event: "lab" }, "lab:2026-10-11T18", "film").event, "outcome");
  assert.equal(slotsOf({ event: "status" }, "status:2026-10-11T22", "riso").event, "digest");
  const p = card.plates();
  const layers = {
    lab: card.factLayer(factSheet(labFacts(2, EXPS, PARAMS, FINDINGS, 3)!), {}, 1),
    status: card.factLayer({ event: "status", hours: 12, swaps: 3963, volumeEth: 611, feesEth: 13.4, burnedDna: 25106443 }, {}, 1),
    reflection: card.factLayer({ event: "reflection", day: 2 }, {}, 1),
    recap: card.factLayer({ event: "recap", gamesShipped: 1, experimentsKept: 0, experimentsKilled: 3, siteChanges: 2 }, {}, 1),
  };
  assert.deepEqual(layers.lab.figures.map((g) => g.value), ["4", "4", "2", "3"]);
  assert.deepEqual(layers.lab.addresses, ["best: base 2.5%  multiplier 0.1x  cap 3.2%"]);
  assert.equal(layers.status.headline, "LAST 12 HOURS");
  for (const [ev, l] of Object.entries(layers)) {
    assert.ok(l.headline && l.figures.length <= 4 && l.figures.every((g) => g.value.length <= 11), ev);
    const png = card.composite(p.bytes(0), l, "wide");
    assert.ok(png.length <= card.CARD.maxBytes && artIssue(png, "wide") === null, ev);
  }
});
