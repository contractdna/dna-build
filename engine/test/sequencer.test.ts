// The Sequencer's pure rules (src/sequencer.ts): when it is open, what a round costs, what the code makes of a
// verdict, round limits, a game's folder name, which spec may go public, which game a 4th one evicts, the idle rule,
// the "nothing good enough today" rule, and the signed order: built from the queue's neutral fields only and accepted
// by the workflow's own check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";

process.env.LOG_SIGNING_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const { d } = await import("../src/config.ts");
d.gameFactory = "0x00000000000000000000000000000000000000fa";
const s = await import("../src/sequencer.ts");
const { verifyOrder, Order } = await import("../src/seq-order.ts");
const { chainHash, logDigest, GENESIS } = await import("../src/log.ts");
const { sha256 } = await import("../src/seq-gates.ts");

const HOUR = 3600_000;
const ok = (gate: string) => ({ gate, name: gate, ok: true, issues: [] }) as never;
const bad = (gate: string, issue: string) => ({ gate, name: gate, ok: false, issues: [issue] }) as never;

test("the self-file's open risks: its section's bullets, at most 10, cut to 300 characters; none without the section", () => {
  const md = "# Self\n\n## Can\n- swap models\n\n## Open risks\n- the watch read has no retry\n* a long one " + "x".repeat(400) + "\nnot a bullet\n\n## Recent decisions\n- shipped dice\n";
  const r = s.openRisksOf(md);
  assert.equal(r.length, 2);
  assert.equal(r[0], "the watch read has no retry");
  assert.equal(r[1].length, 300);
  assert.deepEqual(s.openRisksOf("# Self\n- not under the heading\n"), []);
  assert.equal(s.openRisksOf(`## Open risks\n${"- r\n".repeat(20)}`).length, 10);
});

test("open SEQ_OPEN_DELAY_MIN after launch (default 0: with the launch), never without a launch time", () => {
  const launch = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(s.SEQ.openAfterMs, 0, "the dev team starts with the launch");
  assert.equal(s.seqOpen(launch - 1, launch), false);
  assert.equal(s.seqOpen(launch, launch), true);
  assert.equal(s.seqOpen(Date.now(), undefined), false);
  const saved = s.SEQ.openAfterMs;
  try {
    s.SEQ.openAfterMs = 2 * HOUR; // SEQ_OPEN_DELAY_MIN=120
    assert.equal(s.seqOpen(launch + 2 * HOUR - 1, launch), false);
    assert.equal(s.seqOpen(launch + 2 * HOUR, launch), true);
  } finally { s.SEQ.openAfterMs = saved; }
});

test("a round's charge: the reported cost clipped to [0, ceiling]; the whole ceiling without a trustworthy report", () => {
  const o = { id: "b20261010-7-r1", ceilingUsd: 12 };
  assert.equal(s.chargeOf({ orderId: o.id, runAttempt: "1", totalUsd: 3.25 }, o), 3.25);
  assert.equal(s.chargeOf({ orderId: o.id, runAttempt: "1", totalUsd: 99 }, o), 12);
  assert.equal(s.chargeOf({ orderId: o.id, runAttempt: "1", totalUsd: -5 }, o), 0);
  assert.equal(s.chargeOf(null, o), 12, "no report");
  assert.equal(s.chargeOf({ orderId: "other", runAttempt: "1", totalUsd: 1 }, o), 12, "another order's report");
  assert.equal(s.chargeOf({ orderId: o.id, runAttempt: "2", totalUsd: 1 }, o), 12, "a re-run");
  assert.equal(s.chargeOf({ orderId: o.id, runAttempt: "1", totalUsd: "1" }, o), 12, "not a number");
});

test("per-query caps scale with a smaller order ceiling", () => {
  assert.deepEqual(s.perQuery(12), { lead: 2, worker: 0.5, tester: 1, fixer: 1, review: 2 });
  assert.deepEqual(s.perQuery(4.8), { lead: 0.8, worker: 0.2, tester: 0.4, fixer: 0.4, review: 0.8 });
});

test("the code ANDs the brain's ship with the gates; a rework after round 4 is a kill", () => {
  assert.equal(s.outcome("ship", [ok("G1"), ok("G14")], 1), "ship");
  assert.equal(s.outcome("ship", [ok("G1"), bad("G6", "red")], 1), "rework", "a failing gate turns ship into rework");
  assert.equal(s.outcome("ship", [], 1), "rework", "no gate results: never ship");
  assert.equal(s.outcome("rework", [], 3), "rework");
  assert.equal(s.outcome("rework", [], 4), "kill");
  assert.equal(s.outcome("ship", [bad("G3", "x")], 4), "kill");
  assert.equal(s.outcome("kill", [ok("G1")], 1), "kill");
  const issues = s.issuesFor(["add a fuzz test"], [ok("G1"), bad("G6", "no invariant")]);
  assert.deepEqual(issues, ["add a fuzz test", "G6 G6: no invariant"]);
  assert.ok(s.issuesFor(Array(20).fill("x".repeat(400)), []).every((i) => i.length <= 300));
  assert.equal(s.issuesFor(Array(20).fill("x"), []).length, 12);
});

test("a game's folder: the title's words and the idea number, always a valid new slug", () => {
  const SLUG = /^[a-z][a-z0-9-]{2,30}$/;
  for (const [title, n, want] of [["Coin Flip!", 12, "coin-flip-12"], ["3 Dice", 7, "g3-dice-7"], ["", 5, "gx5"], ["!!!", 123456, "g123456"], ["A very long title that keeps going on", 9, "a-very-long-title-th-9"]] as const) {
    assert.equal(s.slugFor(title, n), want);
    assert.match(s.slugFor(title, n), SLUG);
  }
});

test("a spec goes into a public order only when it is plain text of a sane length", () => {
  assert.deepEqual(s.specIssues("A coin flip game where each player picks heads or tails."), []);
  assert.ok(s.specIssues("short").length);
  assert.ok(s.specIssues("x".repeat(4001)).some((i) => /4000/.test(i)));
  assert.ok(s.specIssues("Build a game like the one on https://example.com please").some((i) => /url/.test(i)));
  assert.ok(s.specIssues("Ask @someone about the rules of this game, then build").some((i) => /handle/.test(i)));
});

test("the rework rounds left, as the verdict is told them: round 1 of 4 leaves 3, round 2 leaves 2, round 4 none", () => {
  assert.deepEqual([1, 2, 3, 4].map(s.reworksLeft), [3, 2, 1, 0]);
});

test("a spec amendment: read from the build's report as data, appended to the spec, never relaxing a rule or a cap", () => {
  const spec = "A race game: every player who finishes the track before the deadline is credited an equal share of the pot at settle.";
  const gas = { reason: "Crediting every finisher at settle loops over all players and breaks the 200k gas limit.", change: "Pay by claim instead of at settle: each finisher claims their share after settle." };
  const cap = { reason: "An unbounded list of players can't be settled under the gas limit.", change: "Cap participants at 50 per round." };
  assert.deepEqual(s.amendmentOf({ amendment: gas }), gas);
  assert.equal(s.amendmentOf({ amendment: { reason: "x" } }), undefined);
  assert.equal(s.amendmentOf({}), undefined);
  assert.equal(s.amendmentOf(null), undefined);
  assert.ok(s.amendmentOf({ amendment: { reason: "r".repeat(900), change: "c".repeat(900) } })!.change.length <= 600);
  const amended = s.amendedSpec(spec, gas);
  assert.ok(amended.startsWith(spec) && amended.includes(gas.change) && amended.includes(gas.reason));
  // the live run's cases: allowed
  assert.deepEqual(s.amendmentIssues(spec, gas), []);
  assert.deepEqual(s.amendmentIssues(spec, cap), []);
  // a best-effort text screen on the change only: plain words that name a cap, or a reason that names what it avoids, pass
  assert.deepEqual(s.amendmentIssues(spec, { reason: cap.reason, change: "Cap players at 50; players above the cap are refused." }), []);
  assert.deepEqual(s.amendmentIssues(spec, { reason: "Paying at settle needs an external call per player, past the gas limit.", change: gas.change }), []);
  // relaxing a cap, a limit, a gate or a rule: refused
  for (const change of ["Raise the gas limit to 500k for settle.", "Remove the 5% fee cap.", "Settle may skip the conformance checks.", "Disable the gas limit check for settle.", "Increase the prize limit to half the pot.", "Lift the per-query budget ceiling.", "Waive the per-player limit."]) {
    assert.ok(s.amendmentIssues(spec, { reason: gas.reason, change }).some((i) => /relax/.test(i)), change);
  }
  // what the rules forbid: refused
  for (const change of ["Make play payable so players can stake ETH.", "Players make a deposit to enter.", "Add a receive function for tips.", "Use inline assembly to loop cheaper.", "Use tx.origin to identify players."]) {
    assert.ok(s.amendmentIssues(spec, { reason: gas.reason, change }).some((i) => /forbid/.test(i)), change);
  }
  // the same checks as any spec: plain text, at most 4000 characters in all
  assert.ok(s.amendmentIssues("x".repeat(3900), gas).some((i) => /4000/.test(i)));
  assert.ok(s.amendmentIssues(spec, { reason: gas.reason, change: "Pay by claim, as on https://example.com explains." }).some((i) => /url/.test(i)));
  // the spec the build checks against: the amended one only once approved
  const data = { spec, specSha256: sha256(spec) } as never as Parameters<typeof s.specOf>[0];
  assert.deepEqual(s.specOf(data), { spec, specSha256: sha256(spec) });
  assert.deepEqual(s.specOf({ ...data, amendment: { ...gas, round: 1, approved: false, why: "no" } }), { spec, specSha256: sha256(spec) });
  assert.deepEqual(s.specOf({ ...data, amendment: { ...gas, round: 1, approved: true, why: "gas bound", spec: amended, specSha256: sha256(amended) } }), { spec: amended, specSha256: sha256(amended) });
});

test("a 4th game evicts the fewest players in 48 h, then the oldest, of those live 8 h or more; the idle rule", () => {
  const g = (game: string, players48h: number, deployedAt: number) => ({ game: game as never, build: game, players48h, deployedAt });
  const now = 100 * HOUR;
  assert.equal(s.evictee([g("0xa", 3, 1), g("0xb", 1, 5), g("0xc", 1, 2)], now), "0xc");
  assert.equal(s.evictee([], now), undefined);
  assert.equal(s.evictee([g("0xa", 3, 1), g("0xd", 0, now - 7 * HOUR)], now), "0xa", "a game live under 8 h is never evicted");
  assert.equal(s.evictee([g("0xd", 0, now - 7 * HOUR)], now), undefined, "nothing old enough: wait");
  assert.deepEqual(s.evictOrder([g("0xa", 3, 1), g("0xb", 1, 5), g("0xc", 1, 2)], now).map((x) => x.game), ["0xc", "0xb", "0xa"]);
  assert.equal(s.retireDue({ ageMs: 48 * HOUR, players48h: 0 }), true);
  assert.equal(s.retireDue({ ageMs: 47 * HOUR, players48h: 0 }), false, "too young");
  assert.equal(s.retireDue({ ageMs: 100 * HOUR, players48h: 1 }), false);
});

test("the order: neutral fields only, a fresh id per round, accepted by the workflow's check when the log key signs it", async () => {
  const marker = "RAW-IDEA-TEXT-MARKER";
  const spec = "A dice game: each player rolls once a day, the highest roll of the day wins the pot.";
  const row = {
    id: "b20261010-7", status: "decided", round: 2,
    data: { idea: "im:7", ideaNum: 7, slug: "dice-7", title: "Dice", spec, specSha256: sha256(spec), rubric: { value: 3, fit: 4, clarity: 4, originality: 2 }, brainSeq: "1", ceilingUsd: 12, reservation: { at: new Date().toISOString(), amount: 48 }, orders: [{ round: 1, id: s.orderIdFor("b20261010-7", 1) }, { round: 2, id: s.orderIdFor("b20261010-7", 2) }], issues: ["G6 tests: add an invariant"] },
  } as never as Parameters<typeof s.orderOf>[0];
  const models = { lead: "anthropic/claude-opus-5.5", worker: "anthropic/claude-haiku-5.5", tester: "anthropic/claude-sonnet-5.5", fixer: "anthropic/claude-sonnet-5.5", review: "anthropic/claude-opus-5.5" };
  const now = Date.now();
  const o = s.orderOf(row, "a".repeat(40), models, now);
  assert.equal(Order.safeParse(o).success, true);
  // the id saved with the round: the build, the round and a random suffix no one can guess ahead of the dispatch
  assert.equal(o.id, (row as never as { data: { orders: { id: string }[] } }).data.orders[1].id);
  assert.match(o.id, /^b20261010-7-r2-[0-9a-f]{12}$/);
  assert.notEqual(s.orderIdFor("b20261010-7", 2), o.id);
  assert.equal(s.orderOf(row, "a".repeat(40), models, now).id, o.id, "a retried dispatch keeps the round's id");
  assert.equal(s.branchOf(o), `seq/${o.id}-r2`);
  assert.equal(o.expiresAt, new Date(now + 20 * 60_000).toISOString());
  assert.equal(o.factory, d.gameFactory!.toLowerCase());
  assert.equal(o.safe, d.safe.toLowerCase());
  assert.ok(!JSON.stringify(o).includes(marker));
  // a game's order carries no kind (the orders from before kinds existed read the same); a site change's names it
  assert.deepEqual(Object.keys(o).sort(), Object.keys(Order.shape).filter((k) => k !== "kind").sort(), "nothing but the schema's fields (no source, author, report)");
  const site = s.orderOf({ ...row, data: { ...row.data, kind: "site" } } as typeof row, "a".repeat(40), models, now);
  assert.equal(site.kind, "site");
  assert.deepEqual(Object.keys(site).sort(), Object.keys(Order.shape).sort());
  assert.equal(Order.safeParse(site).success, true);
  // the workflow's check: the record as the enclave signs it
  const body = (await import("../src/log.ts")).canonical(o);
  const ehash = chainHash(GENESIS, body).toString("hex");
  const esig = await privateKeyToAccount(process.env.LOG_SIGNING_KEY as `0x${string}`).signMessage({ message: { raw: `0x${logDigest(ehash, "build", `order:${o.id}`)}` } });
  const rec = { seq: "5", kind: "build", ref: `order:${o.id}`, body, eprev: GENESIS.toString("hex"), ehash, esig };
  const v = await verifyOrder(rec, privateKeyToAccount(process.env.LOG_SIGNING_KEY as `0x${string}`).address, now);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal((await verifyOrder(rec, privateKeyToAccount(process.env.LOG_SIGNING_KEY as `0x${string}`).address, now + 21 * 60_000)).ok, false, "expired after 20 min");
});

test("publicReason: sanitized, at most 300 bytes, cut at a word with an ellipsis; empty stays empty", async () => {
  assert.equal(await s.publicReason("  "), "");
  assert.equal(await s.publicReason("short reason"), "short reason");
  const long = `${"word ".repeat(70)}tail`;
  const r = await s.publicReason(long);
  assert.ok(Buffer.byteLength(r) <= 300, String(Buffer.byteLength(r)));
  assert.match(r, /word…$/);
});
