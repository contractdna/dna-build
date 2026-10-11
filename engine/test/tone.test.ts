// The writer's tone pass, pure parts: rotating shapes (4 a call, never the same shape twice in a row for an event),
// running bits with fatigue, the emoji allow-list, the loosened slang, the stage-parrot guard, bounds only where they
// answer something, and the judge (it only orders candidates that already passed; safety never depends on it).
import assert from "node:assert/strict";
import { test } from "node:test";
import { allyIssues, BITS, bitsFor, chooseShapes, EMOJI, factNumbers, factSheet, FOILS, namesAlly, parrotIssue, pickBest, postFilter, SHAPE_KEYS, shapesFor, STANDING, WriterOut, writerCall } from "../src/voice.ts";

test("emoji: the allow-list only, at most 2; every other pictograph still refused", () => {
  assert.equal(EMOJI.length, 10);
  assert.deepEqual(postFilter("burn day 🔥🧬", new Set()), []);
  assert.ok(postFilter("🚀 soon", new Set()).includes("emoji"));
  assert.ok(postFilter("🔥🔥🔥 burn", new Set()).includes("over 2 emoji"));
  assert.ok(postFilter("love it ❤️", new Set()).length > 0);
});

test("slang is loose; price, impersonation and disclosure stay banned; number words too", () => {
  assert.deepEqual(postFilter("gm. ser, the fud desk is open and the burn is not mid.", new Set()), []);
  assert.deepEqual(postFilter("nobody gets an airdrop. the burn gets everything.", new Set()), []);
  assert.ok(postFilter("no airdrop, the burn is the only one", new Set()).includes("number word one"));
  for (const bad of ["to the moon", "dm me", "the threshold moved", "connect your wallet", "let's go"]) assert.ok(postFilter(bad, new Set()).length > 0, bad);
});

test("allies: Hazar is one, by name; 'hazard' is not", () => {
  assert.ok(namesAlly("thanks Hazar"));
  assert.ok(!namesAlly("a hazard on the book"));
  assert.ok(allyIssues({ event: "reply", category: "idea", relationship: "ally" }, "hazar is a clown").length > 0);
  assert.ok(postFilter("hazar is mid", new Set()).some((i) => /ally/.test(i)), "loosened slang never reaches an ally");
});

test("shapes: 4 a call, least used first, never the last one used for the same event; reasoning and complaint only when they fit", () => {
  assert.deepEqual([...SHAPE_KEYS].sort(), ["complaint", "deadpan", "diary", "hype", "reasoning", "roast", "self-review", "status ledger", "two-panel"]);
  const plain = shapesFor("post", factSheet({ event: "burn_summary", hours: 6 }), "steady");
  assert.ok(!plain.includes("reasoning") && !plain.includes("complaint") && !plain.includes("status ledger"));
  assert.ok(shapesFor("post", factSheet({ event: "outcome", mind: { why: "volatile hours pay more", confidencePct: 60 } }), "steady").includes("reasoning"));
  assert.ok(shapesFor("post", factSheet({ event: "cancelled", by: "the Safe owners" }), "steady").includes("complaint"));
  assert.ok(shapesFor("post", factSheet({ event: "status", hours: 12 }), "steady").includes("status ledger"));
  const recent = [{ shape: "diary", event: "burn_summary" }, { shape: "hype", event: "online" }, { shape: "two-panel", event: "burn_summary" }];
  const four = chooseShapes(plain, recent, "burn_summary");
  assert.equal(four.length, 4);
  assert.ok(!four.includes("diary"), "the last shape for this event never comes back to back");
  assert.ok(four.indexOf("two-panel") === -1 || four.indexOf("two-panel") === 3, "recently used shapes go last");
  assert.equal(new Set(four).size, 4);
});

test("bits: a label used in the last 6 posts rests; foils and standing truths are on hand", () => {
  assert.ok(BITS.length >= 3 && FOILS.length >= 3 && STANDING.length >= 4);
  const label = BITS[0].label;
  assert.ok(!bitsFor(BITS, [{ joke: label }]).some((b) => b.label === label));
  assert.ok(bitsFor(BITS, [1, 2, 3, 4, 5, 6].map(() => ({})).concat([{ joke: label }])).some((b) => b.label === label), "older than 6 posts: back");
  for (const s of STANDING) assert.deepEqual(postFilter(s, factNumbers({ mechanics: [s] })).filter((i) => !/over 280/.test(i)), [], s);
});

test("stage is code's words, not the post: progress posts get a short `what`; a draft that copies stage is refused", () => {
  const f = factSheet({ event: "fees_distributed", hours: 6, distributions: 3, totalEth: 1 });
  assert.equal(f.stage, undefined);
  assert.equal(f.what, "fee split");
  const g = factSheet({ event: "online" });
  assert.ok(String(g.stage).length > 40, "the claim-guard events keep their stage");
  assert.match(parrotIssue(g, "the engine is live and runs on its own from here: it reads the chain and runs its loop") ?? "", /parrots stage/);
  assert.equal(parrotIssue(g, "day 1. the loop runs itself now. receipt below."), null);
});

test("bounds only where they answer something", () => {
  assert.ok(factSheet({ event: "queued", opId: 3 }).bounds);
  assert.ok(factSheet({ event: "test_live" }).bounds);
  assert.ok(factSheet({ event: "reply", category: "rules_question" }).bounds);
  assert.equal(factSheet({ event: "reply", category: "price_fud" }).bounds, undefined);
  assert.equal(factSheet({ event: "burn_summary", hours: 6 }).bounds, undefined);
});

test("writer call: 4 candidates in the asked shapes, temperature 1, effort low; shapes, bits, foils, standing and emoji in the input", () => {
  assert.equal(WriterOut.safeParse({ candidates: ["a", "b", "c", "d"], shapes: ["hype", "diary", "deadpan", "roast"] }).success, true);
  assert.equal(WriterOut.safeParse({ candidates: ["a", "b", "c", "d", "e"] }).success, false);
  const c = writerCall(factSheet({ event: "burn_summary", hours: 6 }), [], undefined, { recent: [], banned: [], mood: "steady", jokes: [], shapes: ["hype", "diary", "deadpan", "roast"] });
  assert.deepEqual([c.temperature, c.effort], [1, "low"]);
  const input = c.input as { shapes: { name: string; rule: string }[]; bits: unknown[]; foils: string[]; standing: string[]; emoji: string[] };
  assert.deepEqual(input.shapes.map((s) => s.name), ["hype", "diary", "deadpan", "roast"]);
  assert.ok(input.shapes.every((s) => s.rule.length > 5));
  assert.ok(input.bits.length && input.foils.length && input.standing.length);
  assert.deepEqual(input.emoji, [...EMOJI]);
});

test("judge: orders only what passed; clarity is a gate; any judge failure falls back to the first that passed", () => {
  const cands = [{ text: "a", issues: ["number 9"] }, { text: "b", issues: [] }, { text: "c", issues: [] }, { text: "d", issues: [] }];
  const s = (hook: number, clarity: number) => ({ hook, alive: 3, wit: 3, clarity, freshness: 3 });
  // the judge saw the passing ones in order (b, c, d)
  assert.equal(pickBest(cands, { best: 2, scores: [s(2, 4), s(3, 4), s(5, 4)] })!.text, "d");
  assert.equal(pickBest(cands, { best: 2, scores: [s(2, 4), s(3, 4), s(5, 1)] })!.text, "c", "an unclear winner loses to the best clear one");
  assert.equal(pickBest(cands, { best: 7, scores: [] })!.text, "b", "an invalid index: the first that passed");
  assert.equal(pickBest(cands, null)!.text, "b", "no judge: the first that passed");
  assert.equal(pickBest([{ text: "x", issues: ["banned"] }], { best: 0, scores: [s(5, 5)] }), undefined, "the judge can never pick a refused draft");
});

test("story: what happened lately, the last post of the same kind first; the writer gets the story, never its figures", async () => {
  const { earlierOf } = await import("../src/life.ts");
  const now = Date.parse("2026-10-12T12:00:00Z");
  const at = (h: number) => new Date(now - h * 3600_000);
  const rows = [{ type: "status", title: "Last 12 h: 41 swaps", at: at(1) }, { type: "burn_summary", title: "Last 6 h: 2 buybacks spent 0.75 ETH and burned 1,834,567 DNA", at: at(6) }, { type: "online", title: "The engine is live", at: at(30) }, { type: "outcome", title: "x", at: at(40) }];
  const e = earlierOf(rows, "burn_summary", now);
  assert.deepEqual(e.map((x) => x.hoursAgo), [6, 1, 30]);
  const f = factSheet({ event: "burn_summary", hours: 6, buybacks: 1, earlier: e, hoursSinceLaunch: 20 });
  assert.equal(f.hoursSinceLaunch, 20);
  assert.deepEqual((f.earlier as { line: string }[]).map((x) => x.line), ["Last h: buybacks spent ETH and burned DNA", "Last h: swaps", "The engine is live"]);
  assert.deepEqual(postFilter("yesterday's burn was a warm-up. 20 hours in.", factNumbers(f)), []);
  assert.ok(postFilter("yesterday's 1,834,567 DNA was a warm-up.", factNumbers(f)).includes("number 1834567"), "yesterday's figures are not today's facts");
  assert.ok(postFilter("that was 30 hours ago.", factNumbers(f)).includes("number 30"), "hoursAgo orders the story; it is not a number to state");
  const mind = factSheet({ event: "outcome", outcome: "kept", mind: { closed: [{ title: "steeper plate", outcome: "kept", date: "2026-10-10", daysAgo: 2 }] } });
  assert.ok(postFilter("kept it 2 days ago.", factNumbers(mind)).includes("number 2"), "daysAgo neither");
});

test("named roasts: only in a reply to a competitor that engaged first, by code's name for it; never an ally's", () => {
  assert.equal(factSheet({ event: "reply", category: "idea", relationship: "competitor", rival: "CLAUS" }).rival, "CLAUS");
  assert.equal(factSheet({ event: "reply", category: "idea", rival: "CLAUS" }).rival, undefined, "not a competitor reply: no name");
  assert.equal(factSheet({ event: "outcome", relationship: "competitor", rival: "CLAUS" }).rival, undefined, "never in an event post");
  assert.ok(allyIssues({ event: "reply", relationship: "competitor", rival: "CLAUS" }, "CLAUS launched on Programmable").length > 0);
  // a competitor is never read as an ally, whatever the draft calls them
  assert.deepEqual(allyIssues({ event: "reply", category: "greeting", relationship: "competitor", rival: "CLAUS" }, "an ally in the replies is the only hype i rate."), ["calls a competitor an ally"]);
  assert.deepEqual(allyIssues({ event: "reply", category: "greeting", relationship: "competitor", rival: "CLAUS" }, "CLAUS ships daily. so does my burn."), []);
});
