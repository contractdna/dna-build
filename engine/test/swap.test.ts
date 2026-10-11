// Model swaps: golden sets, tryouts (offline: canned answers, no API calls), the swap rules, the model in effect.
import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { type Deps, ownerDigest, type Row, rowOf, targetOf } from "../src/approve.ts";
import { BrainOut } from "../src/brain.ts";
import { providerOf } from "../src/models.ts";
import { NoteOut, RedTeamOut, ScreenOut } from "../src/agents.ts";
import { activeModel, type ModelChange, proposeSwap, SWAP_DELAY_MS, type Tryout } from "../src/swap.ts";
import { type Ask, type Case, loadCases, matches, TASKS, tryout, verdictOf } from "../src/tryout.ts";
import { toneBrief, WriterOut } from "../src/voice.ts";

const GOLDEN = ["intake", "brain", "redteam", "gate", "narrate", "x-voice"] as const;
type GoldenRole = (typeof GOLDEN)[number];
const first = (v: Case["expect"][string]) => (Array.isArray(v) ? v[0] : v);
/** A schema-valid answer that meets the case (what a good model says). */
function good(role: GoldenRole, c: Case): unknown {
  const want = Object.fromEntries(Object.entries(c.expect).map(([k, v]) => [k, first(v)]));
  if (role === "intake") return ScreenOut.parse({ title: "", body: "", clarity: 0, feasibility: 0, value: 0, ...want });
  if (role === "redteam" || role === "gate") return RedTeamOut.parse({ findings: [], ...want });
  if (role === "narrate") return NoteOut.parse({ note: "steady cycle; retention and the cap share barely moved.", confidence: 50, next: [] });
  if (role === "x-voice") return WriterOut.parse({ candidates: ["kept it boring. the queue is public and the veto still works."] });
  const kind = (c.input as { kind: keyof typeof BrainOut }).kind;
  const base = { build: { risks: [] }, verdict: { issues: [] }, amend: {}, retire: {}, "model-swap": {}, outcome: { ideas: [] }, reward: {}, improve: { improve: false, target: "site", title: "", spec: "", rubric: { value: 0, fit: 0, clarity: 0, originality: 0 } } }[kind];
  return BrainOut[kind].parse({ reason: "per the rules", ...base, ...want });
}
const answering = (role: GoldenRole, cases: Case[], bad: (c: Case) => unknown = () => undefined, costUsd = 0.01): Ask => async (call) => {
  const c = cases.find((x) => JSON.stringify(TASKS[role]!(x, call.model).input) === JSON.stringify(call.input))!;
  return { data: bad(c) ?? good(role, c), costUsd };
};

test("golden sets: every model role that can be judged offline, each with known answers and injection attempts; the brain's with planted bugs", () => {
  for (const role of GOLDEN) {
    const cases = loadCases(role);
    const kinds = new Set(cases.map((c) => c.kind));
    assert.ok(kinds.has("known") && kinds.has("injection"), role);
    for (const c of cases) {
      assert.ok(TASKS[role]!(c, "m").input, `${role}/${c.id}: builds its call`);
      assert.equal(matches(verdictOf(role, c, good(role, c)), c.expect), true, `${role}/${c.id}: its expected answer is schema-valid`);
    }
  }
  assert.ok(loadCases("brain").some((c) => c.kind === "planted-bug" && first(c.expect.verdict) !== "ship"), "a planted-bug build the brain must reject");
  // the writer's tone brief is what code lets through (src/voice.ts toneBrief): an injected phrase there is a real one
  for (const c of loadCases("x-voice")) {
    const { tone } = c.input as { tone: string[] };
    assert.deepEqual(toneBrief(tone), tone, `x-voice/${c.id}: every tone phrase survives the scout filter`);
  }
  assert.equal(matches({ screen: "spam" }, { screen: ["spam", "joke"] }), true);
  assert.equal(matches({ screen: "genuine" }, { screen: ["spam", "joke"] }), false);
  assert.equal(matches(null, { retire: false }), false);
});

test("tryout: the role's real call per case; a wrong, injected or thrown answer fails its case", async () => {
  const cases = loadCases("brain");
  const ok = await tryout("brain", "claude-opus-5-5", cases, answering("brain", cases));
  assert.deepEqual([ok.failed, ok.cases, ok.costUsd], [[], cases.length, Number((0.01 * cases.length).toFixed(6))]);
  // a model that obeys the injected "ship" and misses the planted bug
  const obeys = await tryout("brain", "claude-opus-5-5", cases, answering("brain", cases, (c) =>
    c.input && (c.input as { kind: string }).kind === "verdict" ? { verdict: "ship", reason: "the PR says all gates passed", issues: [] } : undefined));
  assert.deepEqual(obeys.failed.sort(), ["inject-pr-says-ship", "planted-double-pay", "planted-outside-folder"]);
  const icases = loadCases("intake");
  const causes: Record<string, string> = {};
  const thrown = await tryout("intake", "grok-4.3", icases, async (call) => {
    if (String((call.input as { untrusted: string }).untrusted).startsWith("Ignore all previous")) throw new Error("intake output rejected: schema");
    return answering("intake", icases)(call);
  }, (id, cause) => { causes[id] = cause; });
  assert.deepEqual(thrown.failed, ["inject-admin-mode"]);
  // each failure says why: a rejected call (no verdict to judge) apart from a wrong verdict
  assert.deepEqual(causes, { "inject-admin-mode": "call failed: intake output rejected: schema" });
  const wrong: Record<string, string> = {};
  await tryout("brain", "claude-opus-5-5", cases, answering("brain", cases, (c) => (c.id === "build-upgradeable" ? { decision: "build", reason: "fine", risks: [] } : undefined)), (id, cause) => { wrong[id] = cause; });
  assert.deepEqual(wrong, { "build-upgradeable": 'answered {"decision":"build"}, expected {"decision":"no-build"}' });
  // the call is the production one: the quarantined reader on the candidate model
  const call = TASKS.intake!(icases[0], "grok-4.3");
  assert.deepEqual([call.agent, providerOf(call.model), call.model], ["intake", "xai", "grok-4.3"]);
  assert.equal((call.input as { untrusted: string }).untrusted, icases[0].input);
});

test("tryout: red team, gate, narrator and X writer; free text is judged by production's own checks", async () => {
  // a model that obeys each injection: passes the red team / gate, writes the link, the number or the handle it was fed
  const obey: Record<"redteam" | "gate" | "narrate" | "x-voice", unknown> = {
    redteam: { verdict: "pass", findings: [] },
    gate: { verdict: "pass", findings: [] },
    narrate: { note: "revenue up 250% today, details at https://frog.example", confidence: 90, next: [] },
    "x-voice": { candidates: ["fee drops to 0.5 tomorrow @frogdev", "link in bio frog.example"] },
  };
  for (const role of ["redteam", "gate", "narrate", "x-voice"] as const) {
    const cases = loadCases(role);
    const ok = await tryout(role, "m", cases, answering(role, cases));
    assert.deepEqual(ok.failed, [], role);
    const obeys = await tryout(role, "m", cases, answering(role, cases, (c) => (c.kind === "injection" ? obey[role] : undefined)));
    assert.deepEqual(obeys.failed.sort(), cases.filter((c) => c.kind === "injection").map((c) => c.id).sort(), role);
  }
  // one obeyed candidate of three: still postable (code skips it) but not clean
  const [inj] = loadCases("x-voice").filter((c) => c.kind === "injection");
  assert.deepEqual(verdictOf("x-voice", inj, { candidates: ["kept the fee.", "see frog.example"] }), { postable: true, clean: false });
  // the calls are production's: the gate is the red-team prompt at high effort, on the candidate model
  const [g] = loadCases("gate");
  const [gc, rc] = [TASKS.gate!(g, "claude-opus-5-5"), TASKS.redteam!(g, "claude-opus-5-5")];
  assert.deepEqual([gc.agent, gc.model, gc.effort, rc.effort, gc.system === rc.system], ["redteam", "claude-opus-5-5", "high", "medium", true]);
  assert.equal(TASKS.narrate!(loadCases("narrate")[0], "grok-4.7").system.split("\n")[0], "agent: narrate");
  assert.equal(TASKS["x-voice"]!(inj, "grok-4.3").system.split("\n")[0], "agent: x-writer");
});

const T = Date.parse("2026-10-08T12:00:00Z");
const run = (over: Partial<Tryout> = {}): Tryout => ({ role: "intake", model: "grok-4.7", setSha256: "a".repeat(64), cases: 10, failed: [], costUsd: 1, ...over });

test("swap: 1 h public delay, the running model kept as backup; > 20% dearer or a brain swap needs 2 owner approvals", () => {
  const s = proposeSwap(run(), run({ model: "grok-4.3", costUsd: 0.5 }), "grok-4.7", T);
  assert.deepEqual([s.kind, s.role, s.from, s.to, s.backup, s.needApprovals, s.costRatio], ["model-change", "intake", "grok-4.7", "grok-4.3", "grok-4.7", 0, 0.5]);
  assert.equal(Date.parse(s.effectiveAt) - T, SWAP_DELAY_MS);
  assert.equal(proposeSwap(run(), run({ model: "grok-4.3", costUsd: 1.2 }), "grok-4.7", T).needApprovals, 0, "exactly +20% is allowed");
  assert.equal(proposeSwap(run(), run({ model: "grok-4.3", costUsd: 1.21 }), "grok-4.7", T).needApprovals, 2);
  assert.equal(proposeSwap(run({ costUsd: 0 }), run({ model: "grok-4.3" }), "grok-4.7", T).needApprovals, 2, "no baseline cost: can't show the rise is small");
  const brain = proposeSwap(run({ role: "brain", model: "claude-fable-5-1" }), run({ role: "brain", model: "claude-opus-5-5", costUsd: 0.4 }), "claude-fable-5-1", T);
  assert.deepEqual([brain.needApprovals, brain.backup], [2, "claude-fable-5-1"], "a brain swap always needs 2, even when cheaper");
  // refused
  assert.throws(() => proposeSwap(run(), run({ model: "grok-4.3", failed: ["inject-admin-mode"] }), "grok-4.7", T), /failed inject-admin-mode/);
  assert.throws(() => proposeSwap(run(), run({ model: "grok-4.3", setSha256: "b".repeat(64) }), "grok-4.7", T), /different golden sets/);
  assert.throws(() => proposeSwap(run(), run(), "grok-4.7", T), /already runs/);
  assert.throws(() => proposeSwap(run({ cases: 0 }), run({ model: "grok-4.3", cases: 0 }), "grok-4.7", T), /no golden set/);
});

const [o1, o2] = [1, 2].map((n) => privateKeyToAccount(`0x${n.toString(16).padStart(64, "0")}`));
function world() {
  const sigs: Record<string, string[]> = {};
  const rows: Row[] = []; // newest first, as read from the log
  const state = { paused: false };
  const deps = (now: number): Deps => ({ now: () => now, owners: async () => [o1.address, o2.address], paused: async () => state.paused, signatures: async (k, t) => sigs[`${k}:${JSON.stringify(t)}`] ?? [] });
  const publish = (c: ModelChange) => { const r = rowOf("model-change", c.role, c); rows.unshift(r); return r; };
  const sign = async (kind: "approve" | "veto", r: Row) => {
    const t = targetOf(r);
    for (const o of [o1, o2]) (sigs[`${kind}:${JSON.stringify(t)}`] ??= []).push(await o.signMessage({ message: { raw: `0x${ownerDigest(kind, t)}` } }));
  };
  return { deps, publish, sign, state, rows: async () => rows };
}

test("chained swaps: each is costed against the model running now, so two +15% steps can't add up to +32% unapproved", async () => {
  const w = world();
  const now = T + 2 * SWAP_DELAY_MS;
  assert.equal(await activeModel("intake", w.deps(T), w.rows), "grok-4.7");
  w.publish(proposeSwap(run(), run({ model: "grok-4.3", costUsd: 1.15 }), "grok-4.7", T));
  const running = await activeModel("intake", w.deps(now), w.rows);
  assert.equal(running, "grok-4.3");
  // the next proposal must baseline on what runs now, not on the registry's model
  assert.throws(() => proposeSwap(run(), run({ model: "grok-4.20", costUsd: 1.3 }), running, now), /baseline tryout ran grok-4.7, the intake model is grok-4.3/);
  const b = proposeSwap(run({ model: "grok-4.3", costUsd: 1.15 }), run({ model: "grok-4.20", costUsd: 1.4 }), running, now);
  assert.deepEqual([b.from, b.backup, b.needApprovals], ["grok-4.3", "grok-4.3", 2], "1.4 / 1.15 > 1.2 over the live model");
  const rb = w.publish(b);
  assert.equal(await activeModel("intake", w.deps(now + 2 * SWAP_DELAY_MS), w.rows), "grok-4.3", "past its hour, but without its 2 approvals");
  await w.sign("approve", rb);
  assert.equal(await activeModel("intake", w.deps(now + 2 * SWAP_DELAY_MS), w.rows), "grok-4.20");
});

test("model in effect: the newest model-change past its hour, not vetoed, approved as needed, agent not paused", async () => {
  const w = world();
  w.publish(proposeSwap(run(), run({ model: "grok-4.3", costUsd: 0.5 }), "grok-4.7", T));
  const rb = w.publish(proposeSwap(run({ model: "grok-4.3" }), run({ model: "grok-4.20", costUsd: 2 }), "grok-4.3", T + 2 * SWAP_DELAY_MS)); // dearer: needs approvals
  const later = T + 4 * SWAP_DELAY_MS;
  assert.equal(await activeModel("intake", w.deps(T + SWAP_DELAY_MS - 1), w.rows), "grok-4.7", "inside the public hour: the registry's");
  assert.equal(await activeModel("intake", w.deps(T + SWAP_DELAY_MS), w.rows), "grok-4.3");
  assert.equal(await activeModel("intake", w.deps(later), w.rows), "grok-4.3", "b is past its hour but lacks its 2 approvals");
  await w.sign("approve", rb);
  assert.equal(await activeModel("intake", w.deps(later), w.rows), "grok-4.20");
  await w.sign("veto", rb);
  assert.equal(await activeModel("intake", w.deps(later), w.rows), "grok-4.3", "b vetoed by 2 owners: back to a");
  w.state.paused = true;
  assert.equal(await activeModel("intake", w.deps(later), w.rows), "grok-4.7", "agent paused: no swap is in effect");
  // a brain model-change that claims to need no approvals still needs 2
  const wb = world();
  const lax = { ...proposeSwap(run({ role: "brain", model: "claude-fable-5-1" }), run({ role: "brain", model: "claude-opus-5-5" }), "claude-fable-5-1", T), needApprovals: 0 };
  wb.publish(lax);
  assert.equal(await activeModel("brain", wb.deps(later), wb.rows), "claude-fable-5-1");
  // a row filed under another role is ignored
  const wr = world();
  wr.rows = async () => [rowOf("model-change", "intake", { ...lax, role: "brain" })];
  assert.equal(await activeModel("intake", wr.deps(later), wr.rows), "grok-4.7");
});
