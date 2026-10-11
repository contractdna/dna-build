// The Sequencer's whole timeline against a real Postgres (enclave-signed rows and records), a local fake of GitHub
// (scripts/fake-github.ts), a scripted brain and gate run, and a fake chain and funding path behind the seams:
// idea → brain build → reservation → signed order (the workflow's own check accepts it) → run + report → bot PR →
// gates (G14 + the gate run) → verdict → ship record (one public hour) → merge pinned to the gated sha → deploy at the
// predicted address → fund → release record + fast-forward → idea shipped and its reward started → reservation
// released on its own day. And what must stop it: a veto, a PR edited after gating, a merge that is not the gated
// tree, a re-run, a second run, the 4th round, a second active build, the day's post while a build still runs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import postgres from "postgres";
import { type Address, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getCreate2Address, type Hex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startFakeGitHub } from "../scripts/fake-github.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const LOG_KEY = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e";
const gh = await startFakeGitHub({ repo: "dna/game-lab", bot: "dna-sequencer[bot]" });
const dbName = `dna_seq_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
const HOUR = 3600_000;
if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, ENGINE_MODE: "live", LOG_SIGNING_KEY: LOG_KEY, LLM_LAUNCH_AT: new Date(Date.now() - 48 * HOUR).toISOString(),
    GITHUB_API_BASE: gh.url, GITHUB_REPO: gh.repo, GITHUB_TOKEN: gh.token, SEQ_BOT: gh.bot,
  });
}
const { edb: sql, migrate } = await import("../src/db.ts");
const enclave = await import("../src/enclave.ts");
const { append, stateSig } = await import("../src/log.ts");
const { d, LLM } = await import("../src/config.ts");
const s = await import("../src/sequencer.ts");
const realOpenRisks = s.SEQ_DEPS.openRisks; // before the seams replace it
const { verifyOrder } = await import("../src/seq-order.ts");
const { RESERVE_AGENT } = await import("../src/llm.ts");

d.gameFactory = "0x00000000000000000000000000000000000000fa";
const signer = privateKeyToAccount(LOG_KEY).address;
const RUNTIME = "0x6080604052600a" as Hex;
const pages = await import("../src/pages.ts");
type PageCheck = import("../src/pages.ts").PageCheck;
const PAGE_OK: PageCheck = { ok: true, kill: false, why: "", violations: [] };
const PAGE_BAD: PageCheck = { ok: false, kill: true, why: "refused: eth_sendTransaction: transactions go only to this game", violations: [{ kind: "refused", detail: "eth_sendTransaction: transactions go only to this game", run: "desktop@0" }] };
const INIT = "0x60806040526001600255" as Hex;

// ---------------------------------------------------------------- the seams
const st = {
  now: Date.now(), alerts: [] as string[], verdicts: [] as ("ship" | "rework" | "kill")[], build: "build" as "build" | "no-build", retire: true,
  live: new Set<string>(), code: new Map<string, Hex>(), deploys: 0, vetoed: new Set<string>(), fundRoom: true, gateCalls: [] as unknown[], gatesOk: true,
  lag: 0, deployFail: null as string | null, players: { players48h: 0, sinceFund: 0 }, fundCalls: [] as string[], fundSt: null as unknown, approved: new Set<string>(), landed: true as boolean | "error", finalLag: 0,
  pageCalls: [] as { slug: string; files: Record<string, string>; salt: string; initCode: string }[], page: PAGE_OK, deep: PAGE_OK, deepCalls: 0,
  kind: "game" as "game" | "site" | "module", siteCalls: [] as { files: Record<string, string>; pages: string[] }[], moduleKit: true,
  risks: [] as string[], improve: null as Record<string, unknown> | null, inputs: {} as Record<string, unknown>,
  amend: true, stopped: null as string | null,
};
async function brain(kind: string, input: unknown, ref: string) {
  st.inputs[kind] = input;
  const decision = kind === "improve" ? (st.improve ?? { improve: false, target: "engine", title: "", spec: "", rubric: { value: 0, fit: 0, clarity: 0, originality: 0 }, reason: "nothing worth it" }) : kind === "build" ? { decision: st.build, target: st.kind, reason: "fits the rules", risks: [] } : kind === "verdict" ? { verdict: st.verdicts.shift() ?? "ship", reason: "every gate passed", issues: ["add a test"] } : kind === "amend" ? { approve: st.amend, reason: "the loop breaks the gas limit; claims keep the idea" } : { retire: st.retire, reason: "rule" };
  const rec = await append("brain", `${kind}:${ref}`, { kind, decision, inputSha256: "x" });
  return { seq: rec.seq, decision };
}
before(async () => {
  if (!ADMIN) return;
  await migrate();
  enclave.ENCLAVE.on = true;
  Object.assign(pages.PAGES_DEPS, { now: () => st.now, alert: async (t: string) => { st.alerts.push(t); } });
  Object.assign(s.SEQ_DEPS, {
    now: () => st.now,
    mode: async () => "live",
    stopped: async () => st.stopped,
    decide: brain,
    models: async () => ({ lead: "anthropic/claude-opus-5.5", worker: "anthropic/claude-haiku-5.5", tester: "anthropic/claude-sonnet-5.5", fixer: "anthropic/claude-sonnet-5.5", review: "anthropic/claude-opus-5.5" }),
    alert: async (t: string) => { st.alerts.push(t); },
    runGates: async (i: unknown) => {
      st.gateCalls.push(i);
      return { results: [{ gate: "G1", name: "paths", ok: true, issues: [] }, { gate: "G6", name: "tests", ok: st.gatesOk, issues: st.gatesOk ? [] : ["red"] }], game: { name: "Dice", initCode: INIT, deployed: RUNTIME, runtime: RUNTIME } };
    },
    // M1 as src/approve.ts has it: its hour, no veto, and its owner approvals when it needs them
    effective: async (row: { ref: string; body: string }) => { const b = JSON.parse(row.body); return !st.vetoed.has(row.ref) && Date.parse(b.effectiveAt) <= st.now && (!b.needApprovals || st.approved.has(row.ref) || st.approved.has(String((row as { seq?: string }).seq))); },
    vetoed: async (row: { ref: string }) => st.vetoed.has(row.ref),
    chain: async () => ({
      liveCount: async () => st.live.size,
      isLive: async (g: string) => st.live.has(g.toLowerCase()),
      codeHash: async (a: string) => (st.lag-- > 0 ? null : st.code.get(a.toLowerCase()) ?? null), // a lagging provider: no code yet
      players: async () => st.players,
      deploy: async (initCode: Hex, salt: Hex) => {
        if (st.deployFail) return { status: "sim_revert", error: st.deployFail };
        const at = getCreate2Address({ from: d.gameFactory!, salt, bytecodeHash: keccak256(initCode) }).toLowerCase();
        st.deploys++;
        st.code.set(at, keccak256(RUNTIME));
        st.live.add(at);
        return { status: "mined" };
      },
      retire: async (g: string) => { st.live.delete(g.toLowerCase()); return { status: "mined" }; },
      sweep: async () => "nothing to sweep",
      deployLanded: async () => { if (st.landed === "error") throw new Error("rpc 503"); return st.landed; },
      finalizedCodeHash: async (a: string) => (st.finalLag-- > 0 ? null : st.code.get(a.toLowerCase()) ?? null),
    }),
    pageGate: async (b: { slug: string; files: Record<string, string>; salt: string; initCode: string }) => { st.pageCalls.push(b); return pages.pageGateResult(st.page); },
    sitePageGate: async (b: { files: Record<string, string>; pages: string[] }) => { st.siteCalls.push(b); return pages.pageGateResult(st.page); },
    moduleKit: async () => st.moduleKit,
    openRisks: async () => st.risks,
    deepCheck: async () => { st.deepCalls++; return st.deep; },
    fund: async () => ({
      ...(await import("../src/funding.ts")),
      queueFund: async (_g: string, _b: string, reason: string) => { st.fundCalls.push(reason); return st.fundRoom ? { queued: true, amount: 28_571_428_571_428_571n, delayNonce: 1n } : { queued: false, why: "over the weekly budget" }; },
      fundState: async () => { if (!st.fundSt) throw new Error("no funding path"); return st.fundSt; },
      executeReady: async () => "nothing ready",
    }),
  });
});
after(async () => {
  enclave.ENCLAVE.on = false;
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await gh.close();
});

let base = "";
let ideaN = 0;
beforeEach(async () => {
  if (!ADMIN) return;
  await sql`delete from seq_build`;
  await sql`delete from llm_call`;
  await sql`delete from idea_queue`; // an idea a test sent back to the queue would be picked first (and reuse its build id)
  // noon today: an hour's wait never crosses midnight (the midnight test sets its own clock)
  Object.assign(st, { now: Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`), alerts: [], verdicts: [], build: "build", live: new Set(), code: new Map(), deploys: 0, vetoed: new Set(), fundRoom: true, gateCalls: [], gatesOk: true, lag: 0, deployFail: null, players: { players48h: 0, sinceFund: 0 }, fundCalls: [], fundSt: null, approved: new Set(), landed: true, finalLag: 0, pageCalls: [], page: PAGE_OK, deep: PAGE_OK, deepCalls: 0, kind: "game", siteCalls: [], moduleKit: true, risks: [], improve: null, inputs: {}, amend: true });
  base = gh.commitFiles(null, { "README.md": "dna\n", "contracts/src/games/GameKit.sol": "kit\n" });
  gh.refs.set("main", base);
  gh.refs.set("release", base);
  // a build idea in the queue (what W2 ingests from a final round), with raw text the order must never carry
  ideaN++;
  const id = `im:${ideaN}`;
  const value = { kind: "build", status: "queued", score: 15, data: { idea: ideaN, round: 1, index: 0, report: "1", title: "Dice", summary: "a dice game", spec: "A dice game: each player rolls once a day; the highest roll of the day wins the day's pot.", source: { source: "ideamarket", author: "0x00000000000000000000000000000000000000a5" }, rubric: { value: 4, fit: 4, clarity: 4, originality: 3 }, raw: "RAW-IDEA-MARKER" } };
  await sql`insert into idea_queue (id, kind, status, score, data, sig) values (${id}, 'build', 'queued', 15, ${sql.json(value.data as never)}, ${await stateSig("idea_queue", id, value)})`;
});

// ---------------------------------------------------------------- helpers
const active = () => s.activeBuild();
/** The dev team's run for the current round: its report, the bot's one commit and the PR (what publish does). */
async function devTeam(o: { amendment?: { reason: string; change: string }; cost?: number; attempt?: number; runs?: number; files?: Record<string, string>; noPr?: boolean } = {}) {
  const r = (await active())!;
  const oid = r.data.orders.find((x) => x.round === r.round)!.id;
  assert.match(oid, new RegExp(`^${r.id}-r${r.round}-[0-9a-f]{12}$`));
  const payload = gh.dispatches.at(-1).client_payload;
  const order = JSON.parse(payload.body);
  assert.equal(order.id, oid);
  for (let i = 0; i < (o.runs ?? 1); i++) gh.addRun(`seq order:${oid}`, { run_attempt: o.attempt ?? 1, artifacts: { build: { "report.json": Buffer.from(JSON.stringify({ orderId: oid, round: r.round, runId: "1", runAttempt: String(o.attempt ?? 1), queries: [], totalUsd: o.cost ?? 3.5, outcome: "pr", ...(o.amendment ? { amendment: o.amendment } : {}) })) } } });
  if (o.noPr) return { r, oid, order };
  const slug = r.data.slug;
  const head = gh.commitFiles(order.baseSha, o.files ?? { [`contracts/src/games/${slug}/Dice.sol`]: "contract Dice {}\n", [`contracts/test/games/${slug}/Dice.t.sol`]: "contract T {}\n", [`web/app/g/${slug}/page.tsx`]: "export default function P() { return null; }\n" }, gh.byBot);
  const pr = gh.openPull(`seq/${oid}-r${r.round}`, head, order.baseSha);
  return { r, oid, order, head, pr };
}
const step = () => s.seqStep();
const spend = async () => sql<{ agent: string; at: Date; cost_usd: number }[]>`select agent, at, cost_usd::float8 as cost_usd from llm_call where budget = 'dev' order by id`;

// ---------------------------------------------------------------- the timeline

test("ship: idea → order → PR → gates → verdict → one public hour → merge → deploy → fund → release → reward", { skip }, async () => {
  st.stopped = "muted"; // the once-ever "switched on" post waits while X posting is muted (it would be spent unseen)
  assert.match(await step(), /^decided: b\d{8}-\d+ \(dice-\d+\)$/);
  assert.equal((await sql`select 1 from x_outbox where event_key = 'seq:online'`).length + (await sql`select 1 from log where kind = 'announce' and ref = 'seq:online'`).length, 0);
  st.stopped = null;
  const r0 = (await active())!;
  assert.equal((await sql`select status from idea_queue where id = ${r0.data.idea}`)[0].status, "building");
  assert.deepEqual((await spend()).map((x) => [x.agent, x.cost_usd]), [[RESERVE_AGENT, 48]], "the whole build (4 × $12) reserved at round 1");
  assert.match(await step(), /^dispatched: /);
  // the dispatch is the signed record; the workflow's own check accepts it, and it carries no raw idea text
  const payload = gh.dispatches.at(-1).client_payload;
  const v = await verifyOrder(payload, signer, st.now);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok(!payload.body.includes("RAW-IDEA-MARKER"));
  assert.equal(await step(), "waiting for the run");
  const { head } = await devTeam({ cost: 3.5 });
  assert.match(await step(), /gated: .* all green/);
  const call = st.gateCalls[0] as { order: { factory: string; safe: string; salt: string; specSha256: string }; slug: string };
  assert.equal(call.order.factory.toLowerCase(), d.gameFactory);
  assert.equal(call.order.safe.toLowerCase(), d.safe.toLowerCase());
  assert.equal(gh.statuses.at(-1)?.state, "success");
  assert.match(await step(), /ship decided/);
  assert.match(await step(), /ship record \d+/);
  assert.equal(await step(), "waiting: the public hour");
  assert.equal(gh.refs.get("main"), base, "nothing merged during the hour");
  st.now += HOUR + 1000;
  assert.match(await step(), /^shipped: b.* at 0x/);
  const r = (await sql<{ status: string; data: { mergeSha: string; game: { address: string }; fund: { queued: boolean } } }[]>`select status, data from seq_build`)[0];
  assert.equal(r.status, "shipped");
  assert.equal(gh.refs.get("main"), r.data.mergeSha);
  assert.equal(gh.refs.get("release"), r.data.mergeSha, "release fast-forwarded to the merge");
  assert.equal(st.deploys, 1);
  assert.equal(r.data.fund.queued, true);
  void head;
  // the idea: shipped, its reward resting on the ship record
  const q = (await sql<{ status: string; data: { basis: { kind: string; seq: string } } }[]>`select status, data from idea_queue where id = ${r0.data.idea}`)[0];
  assert.equal(q.status, "reward");
  const [ship] = await sql<{ kind: string; doc: { verdict: string; predicted: string } }[]>`select kind, doc from log where seq = ${q.data.basis.seq}`;
  assert.equal(ship.kind, "ship");
  assert.equal(ship.doc.verdict, "ship");
  assert.equal(ship.doc.predicted.toLowerCase(), r.data.game.address.toLowerCase());
  // spend: +48 reserve, +3.5 the round, −48 release, all on the reservation's day: the build nets to 3.5
  const rows = await spend();
  assert.deepEqual(rows.map((x) => [x.agent, x.cost_usd]), [[RESERVE_AGENT, 48], ["dev-round", 3.5], [RESERVE_AGENT, -48]]);
  assert.ok(rows.every((x) => x.at.getTime() === rows[0].at.getTime()));
  // announcements: the site records, and the new game also queued for X
  const ann = (await sql<{ ref: string }[]>`select ref from log where kind = 'announce' order by seq`).map((x) => x.ref);
  assert.ok(ann.includes(`seq:${r0.id}:seq_started`), "round 1 is the build's start");
  assert.ok(!ann.some((k) => k.endsWith(":r1:seq_building")), "announced once, as the start");
  for (const e of ["seq_pr", "seq_verdict"]) assert.ok(ann.some((k) => k.endsWith(`:r1:${e}`)), e);
  assert.ok(ann.some((k) => k.endsWith(":seq_shipped")));
  assert.equal((await sql`select 1 from x_outbox where event_key like '%:seq_shipped'`).length, 1);
  // X: the start and the new game, each with its signed record as the proof link; never a round's steps
  const xs = await sql<{ event_key: string; link: string }[]>`select event_key, link from x_outbox where event_key like ${`seq:${r0.id}:%`} order by id`;
  assert.deepEqual(xs.map((x) => x.event_key), [`seq:${r0.id}:seq_started`, `seq:${r0.id}:seq_shipped`]);
  assert.ok(xs.every((x) => /\/api\/log\/\d+$/.test(x.link)), JSON.stringify(xs));
  assert.equal((await sql`select 1 from x_outbox where event_key ~ ':r[0-9]+:'`).length, 0, "a round's steps stay on the site");
  // a second build the same day: none (one ship a UTC day)
  assert.equal(await step(), "done for today: a game shipped");
  // switched on: once, ever, on a signed record (every start() past the gates checks; the first with a record to rest on posts)
  await step();
  assert.equal((await sql`select 1 from log where kind = 'announce' and ref = 'seq:online'`).length, 1);
  assert.equal((await sql`select 1 from x_outbox where event_key = 'seq:online'`).length, 1);
});

test("the reservation and its release stay on the reservation's day when a build crosses midnight", { skip }, async () => {
  const midnight = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  st.now = midnight - 10 * 60_000; // 23:50 yesterday
  await step();
  await step();
  st.now = midnight + 30 * 60_000;
  await devTeam({ cost: 2 });
  st.verdicts.push("kill");
  await step(); // gated
  assert.match(await step(), /^killed/);
  const rows = await spend();
  assert.deepEqual(rows.map((x) => x.cost_usd), [48, 2, -48]);
  assert.ok(rows.every((x) => x.at.getTime() === midnight - 10 * 60_000), "all on yesterday: today's dev part is untouched");
  assert.equal((await sql`select coalesce(sum(cost_usd), 0)::float8 as s from llm_call where budget = 'dev' and at >= ${new Date(midnight)}`)[0].s, 0);
});

test("a Safe veto in the public hour stops the ship: no merge, no deploy, the reservation released", { skip }, async () => {
  await step(); await step();
  await devTeam();
  await step(); await step(); await step();
  const r = (await active())!;
  st.vetoed.add(`ship:${r.id}`);
  st.now += HOUR + 1000;
  assert.match(await step(), /^killed: the Safe owners vetoed the ship/);
  assert.equal(gh.refs.get("main"), base);
  assert.equal(st.deploys, 0);
  assert.equal(gh.refs.get("release"), base);
  assert.equal((await sql`select status from idea_queue where id = ${r.data.idea}`)[0].status, "killed");
  assert.deepEqual((await spend()).map((x) => x.cost_usd), [48, 3.5, -48]);
});

test("a PR edited after it was gated is never merged", { skip }, async () => {
  await step(); await step();
  const { pr, order } = await devTeam();
  await step(); await step(); await step();
  const edited = gh.commitFiles(gh.refs.get(pr!.branch)!, { "contracts/src/games/dice/Evil.sol": "contract E {}\n" }, gh.byBot);
  gh.refs.set(pr!.branch, edited);
  st.now += HOUR + 1000;
  assert.match(await step(), /killed: the pull request changed after it was gated/);
  assert.equal(gh.refs.get("main"), order.baseSha);
  assert.equal(st.deploys, 0);
  assert.ok(st.alerts.some((a) => /moved or closed after it was gated/.test(a)));
});

test("a merge that is not the gated tree: nothing deployed, an alert", { skip }, async () => {
  await step(); await step();
  await devTeam();
  await step(); await step(); await step();
  gh.knobs.mergeEdits = { "web/next.config.ts": "export default {};\n" };
  st.now += HOUR + 1000;
  try {
    assert.match(await step(), /killed: the merged tree is not the gated one/);
  } finally { gh.knobs.mergeEdits = null; }
  assert.equal(st.deploys, 0);
  assert.equal(gh.refs.get("release"), base);
  assert.ok(st.alerts.some((a) => /not the gated tree/.test(a)));
});

test("rework: round r opens with the issues and closes r−1's PR; a 4th rework is a kill", { skip }, async () => {
  await step(); await step();
  const id = (await active())!.id;
  st.verdicts.push("rework", "rework", "rework", "rework");
  for (let round = 1; round <= 4; round++) {
    const { pr } = await devTeam({ cost: 1 });
    await step(); // gated
    const out = await step(); // verdict
    const vin = st.inputs.verdict as { round: number; maxRounds: number; reworkRoundsLeft: number };
    assert.deepEqual([vin.round, vin.maxRounds, vin.reworkRoundsLeft], [round, 4, 4 - round], "the brain is told how many rework rounds remain");
    assert.equal(gh.pulls.find((p) => p.number === pr!.number)!.state, "closed", `round ${round}'s PR closed`);
    if (round < 4) {
      assert.equal(out, `rework: round ${round + 1}`);
      assert.match(await step(), /^dispatched/);
      const order = JSON.parse(gh.dispatches.at(-1).client_payload.body);
      assert.equal(order.round, round + 1);
      assert.ok(order.issues.includes("add a test"));
    } else assert.match(out, /^killed: no shippable build after 4 rounds/);
  }
  assert.deepEqual((await spend()).map((x) => x.cost_usd), [48, 1, 1, 1, 1, -48]);
  // later rounds stay on the site; the kill is one X post ("tried, didn't make the bar")
  const ann = (await sql<{ ref: string }[]>`select ref from log where kind = 'announce' and ref like ${`seq:${id}:%`}`).map((x) => x.ref);
  for (const r of [2, 3, 4]) assert.ok(ann.includes(`seq:${id}:r${r}:seq_building`), `round ${r}`);
  const xs = await sql<{ event_key: string; event: { rounds: number } }[]>`select event_key, event from x_outbox where event_key like ${`seq:${id}:%`} order by id`;
  assert.deepEqual(xs.map((x) => x.event_key), [`seq:${id}:seq_started`, `seq:${id}:seq_killed`]);
  assert.equal(xs[1].event.rounds, 4);
  await step(); // a later step never announces the kill again
  assert.equal((await sql`select 1 from x_outbox where event_key = ${`seq:${id}:seq_killed`}`).length, 1);
});

test("a red gate turns the brain's ship into a rework", { skip }, async () => {
  await step(); await step();
  await devTeam();
  st.gatesOk = false;
  assert.match(await step(), /with failures/);
  assert.equal(gh.statuses.at(-1)?.state, "failure");
  assert.equal(await step(), "rework: round 2");
});

test("an impossible spec: the lead's amendment is reviewed once at the first verdict; approved, the round is rebuilt to the amended spec (no same-round ship), whose verdict checks it, and the ship record names it", { skip }, async () => {
  await step(); await step();
  const id = (await active())!.id;
  const original = (await active())!.data.spec;
  const amendment = { reason: "Crediting every finisher at settle loops over all players, past the 200k gas limit.", change: "Pay by claim instead of at settle: each finisher claims their share." };
  st.verdicts.push("ship");
  await devTeam({ amendment });
  await step(); // gated
  assert.equal(await step(), "rework: round 2", "an approved amendment never ships the round built before it was approved");
  assert.equal(st.inputs.verdict, undefined, "no verdict on the old spec's build");
  assert.equal(st.verdicts.length, 1);
  const asked = st.inputs.amend as { kind: string; title: string; spec: string; change: string; reason: string; amendedSpec: string; untrusted: boolean };
  assert.equal(asked.kind, "game");
  assert.equal(asked.title, "Dice");
  assert.equal(asked.spec, original);
  assert.equal(asked.change, amendment.change);
  assert.equal(asked.untrusted, true);
  assert.match(await step(), /^dispatched/);
  const order2 = JSON.parse(gh.dispatches.at(-1).client_payload.body);
  assert.ok(order2.spec.startsWith(original) && order2.spec.includes(amendment.change), "round 2 builds the amended spec");
  assert.equal(order2.specSha256, createHash("sha256").update(order2.spec).digest("hex"));
  assert.ok(order2.issues.some((i: string) => /^the spec amendment was approved/.test(i)), order2.issues.join(" | "));
  // reviewed once: another proposal is not put to the brain again
  delete st.inputs.amend;
  await devTeam({ amendment: { reason: "Fewer players settle faster.", change: "Cap participants at 10 per round." } });
  await step(); // gated
  assert.match(await step(), /^ship decided/);
  assert.equal(st.inputs.amend, undefined);
  const v2 = st.inputs.verdict as unknown as { spec: string; reworkRoundsLeft: number; amendment: { approved: boolean } };
  assert.equal(v2.spec, order2.spec, "the verdict checks the amended spec");
  assert.equal(v2.reworkRoundsLeft, 2);
  assert.equal(v2.amendment.approved, true);
  assert.equal((await sql`select 1 from log where kind = 'brain' and ref = ${`amend:${id}`}`).length, 1);
  assert.match(await step(), /ship record/);
  const [ship] = await sql<{ body: string }[]>`select body from log where kind = 'ship' and ref = ${`ship:${id}`}`;
  const a = JSON.parse(ship.body).amendment;
  assert.equal(a.change, amendment.change);
  assert.equal(a.reason, amendment.reason);
  assert.equal(a.specSha256, order2.specSha256);
  assert.match(a.brainSeq, /^\d+$/);
});

test("an amendment that relaxes a cap is refused without the brain: the verdict checks the spec as written and the next round is told", { skip }, async () => {
  await step(); await step();
  const original = (await active())!.data.spec;
  st.verdicts.push("rework");
  await devTeam({ amendment: { reason: "Settling every player needs more gas than allowed.", change: "Raise the gas limit to 500k for settle." } });
  await step(); // gated
  assert.equal(await step(), "rework: round 2");
  assert.equal(st.inputs.amend, undefined, "never put to the brain");
  const v = st.inputs.verdict as { spec: string; amendment: { approved: boolean } };
  assert.equal(v.spec, original);
  assert.equal(v.amendment.approved, false);
  assert.match(await step(), /^dispatched/);
  const order2 = JSON.parse(gh.dispatches.at(-1).client_payload.body);
  assert.equal(order2.spec, original);
  assert.ok(order2.issues.some((i: string) => /^the spec amendment was refused/.test(i)), order2.issues.join(" | "));
  assert.equal((await active())!.data.amendment?.approved, false);
});

test("an amendment in a round that reaches no verdict is not reviewed: the next round is told to propose it again", { skip }, async () => {
  await step(); await step();
  await devTeam({ amendment: { reason: "Crediting every finisher at settle loops over all players.", change: "Pay by claim instead of at settle." }, noPr: true });
  assert.equal(await step(), "rework: round 2");
  assert.equal(st.inputs.amend, undefined);
  assert.match(await step(), /^dispatched/);
  const order2 = JSON.parse(gh.dispatches.at(-1).client_payload.body);
  assert.ok(order2.issues.some((i: string) => /^the spec amendment proposed in round 1 was not reviewed/.test(i)), order2.issues.join(" | "));
  assert.equal((await active())!.data.amendment, undefined);
});

test("a re-run is refused (charged the whole ceiling); a second run of one order alerts and only the first counts", { skip }, async () => {
  await step(); await step();
  await devTeam({ attempt: 2, noPr: true });
  assert.equal(await step(), "rework: round 2");
  assert.ok(st.alerts.some((a) => /re-run/.test(a)));
  assert.deepEqual((await spend()).map((x) => x.cost_usd), [48, 12]);
  await step(); // dispatch round 2
  await devTeam({ runs: 2, cost: 2 });
  assert.match(await step(), /^gated/);
  assert.ok(st.alerts.some((a) => /2 runs for order/.test(a)));
});

test("an order is charged once, even when a crash lost the saved charge", { skip }, async () => {
  await step(); await step();
  await devTeam({ cost: 2 });
  await step(); // gated: charged 2
  // a crash between the charge row and the saved build: the row says dispatched and uncharged again
  const r = (await active())!;
  const o = r.data.orders.find((x) => x.round === r.round)!;
  delete o.charge;
  await s.saveBuild({ ...r, status: "dispatched" });
  assert.match(await step(), /^gated/);
  assert.deepEqual((await spend()).map((x) => [x.agent, x.cost_usd]), [[RESERVE_AGENT, 48], ["dev-round", 2]]);
});

test("a run may start until the order expires (+5 min); none by then: skipped, the idea back in the queue, no second build that day", { skip }, async () => {
  await step(); await step();
  const r = (await active())!;
  st.now += 19 * 60_000; // the order is still valid: a run starting now is still matched
  assert.equal(await step(), "waiting for the run");
  st.now += 7 * 60_000; // 26 min: past expiry + 5 min
  assert.match(await step(), /^skipped: no run of .* within 25 min/);
  assert.equal((await sql`select status from idea_queue where id = ${r.data.idea}`)[0].status, "queued");
  assert.deepEqual((await spend()).map((x) => x.cost_usd), [48, -48]);
  assert.equal(await step(), "done for today: a build was skipped (outage)");
});

test("an order model with no price in models.json: not dispatched, an alert; dispatched once every model is priced", { skip }, async () => {
  const models = s.SEQ_DEPS.models;
  const before = gh.dispatches.length;
  s.SEQ_DEPS.models = async () => ({ ...(await models()), worker: "anthropic/claude-unknown-9" });
  try {
    await step();
    assert.match(await step(), /^not dispatched: no price in models\.json for anthropic\/claude-unknown-9/);
    assert.equal(gh.dispatches.length, before, "nothing sent to GitHub");
    assert.equal((await active())!.status, "decided");
    assert.match(st.alerts.at(-1) ?? "", /not dispatched.*anthropic\/claude-unknown-9/);
  } finally {
    s.SEQ_DEPS.models = models;
  }
  assert.match(await step(), /^dispatched: /);
});

test("GitHub down while gating: an outage skips the build", { skip }, async () => {
  await step(); await step();
  await devTeam();
  gh.knobs.fail = { status: 503, path: /\/pulls$/ };
  try { assert.match(await step(), /^skipped: outage/); } finally { gh.knobs.fail = null; }
});

test("no fund room: the game still ships, awaiting funding", { skip }, async () => {
  st.fundRoom = false;
  await step(); await step();
  await devTeam();
  await step(); await step(); await step();
  st.now += HOUR + 1000;
  assert.match(await step(), /^shipped/);
  const [{ id }] = await sql<{ id: string }[]>`select id from seq_build where status = 'shipped'`;
  const [a] = await sql<{ doc: { facts: { fundEth: number | null } } }[]>`select doc from log where kind = 'announce' and ref = ${`seq:${id}:seq_shipped`}`;
  assert.equal(a.doc.facts.fundEth, null);
});

test("a 4th game: the fewest-players game gets a brain-signed retire record with the ship, and the deploy waits for it", { skip }, async () => {
  // three live games of ours
  for (let i = 0; i < 3; i++) {
    const g = `0x00000000000000000000000000000000000000${(0xb0 + i).toString(16)}`;
    st.live.add(g);
    const id = `old${i}`;
    const value = { status: "shipped", round: 1, data: { idea: `im:x${i}`, ideaNum: 100 + i, slug: `old-${i}`, title: "Old", spec: "", specSha256: "", rubric: {}, brainSeq: "1", ceilingUsd: 12, reservation: { at: new Date().toISOString(), amount: 48 }, orders: [], issues: [], game: { address: g, codehash: "0x", deployedAt: new Date(st.now - (10 - i) * HOUR).toISOString() } } };
    await sql`insert into seq_build (id, status, round, data, sig) values (${id}, 'shipped', 1, ${sql.json(value.data as never)}, ${await stateSig("seq_build", id, value)})`;
  }
  await step(); await step();
  await devTeam();
  await step(); await step();
  assert.match(await step(), /ship record/);
  const [ret] = await sql<{ ref: string; doc: { rule: string; game: string } }[]>`select ref, doc from log where kind = 'retire'`;
  assert.equal(ret.doc.rule, "evict");
  assert.equal(ret.doc.game, "0x00000000000000000000000000000000000000b0", "fewest players (all 0), then the oldest");
  st.now += HOUR + 1000;
  assert.equal(await step(), "waiting: the evicted game retires first");
  st.live.delete("0x00000000000000000000000000000000000000b0");
  assert.match(await step(), /^shipped/);
});

test("one build at a time: the database refuses a second active row", { skip }, async () => {
  await step();
  await assert.rejects(sql`insert into seq_build (id, status, round, data) values ('other', 'dispatched', 1, '{}')`, /seq_build_one_active/);
});

test("the day's post: never while a build runs, once after the day with no ship", { skip }, async () => {
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  await append("build", "order:x", { note: "a record for the day to rest on" });
  await step(); // a build is active
  st.now = today + 86_400_000 + 30 * 60_000; // 00:30 tomorrow
  const out = await s.seqHourly();
  assert.equal(out.daily, "no post");
  await sql`delete from seq_build`;
  const again = await s.seqHourly();
  assert.match(String(again.daily), /^nothing good enough on/);
  assert.equal((await sql`select 1 from x_outbox where event_key like 'seq:nothing:%'`).length, 1);
  await s.seqHourly();
  assert.equal((await sql`select 1 from log where kind = 'announce' and ref like 'seq:nothing:%'`).length, 1, "once");
});

test("a merge on main by anyone else: its own release record, released after its own hour", { skip }, async () => {
  const m = gh.commitFiles(base, { "docs/x.md": "x\n" });
  gh.refs.set("main", m);
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), base, "not before its hour");
  st.now += HOUR + 1000;
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), m);
});

// ---------------------------------------------------------------- review fixes

const { Defer } = await import("../src/jobs.ts");
const isDefer = (e: unknown) => e instanceof Defer;
/** decided → dispatched → (the team) → gated → verdict → shipping (the ship record signed). */
async function toShipping(o: Parameters<typeof devTeam>[0] = {}) {
  await step(); await step();
  const t = await devTeam(o);
  await step(); await step();
  assert.match(await step(), /ship record/);
  return t;
}

test("a gates record the DB swapped (other init code) is refused: no verdict, no ship record", { skip }, async () => {
  await step(); await step();
  await devTeam();
  await step(); // gated
  const r = (await active())!;
  const o = r.data.orders.find((x) => x.round === r.round)!;
  await sql.unsafe("alter table log disable trigger log_no_update");
  try {
    await sql`update log set body = replace(body, ${INIT.slice(2)}, ${"6080604052deadbeef"}) where seq = ${o.gatesSeq!}`;
  } finally { await sql.unsafe("alter table log enable trigger log_no_update"); }
  await assert.rejects(step(), /signed gates record .* is missing or not ours|hides the enclave's newest record/);
  assert.equal((await active())!.status, "gated");
  assert.equal((await sql`select 1 from log where kind = 'ship' and ref = ${`ship:${r.id}`}`).length, 0);
});

test("a deploy a lagging provider does not show yet: wait, never kill a live game", { skip }, async () => {
  await toShipping();
  st.now += HOUR + 1000;
  st.lag = 2; // the first read (before the deploy) and the one after it see no code
  await assert.rejects(step(), isDefer);
  assert.equal(st.deploys, 1);
  assert.match(await step(), /^shipped/);
  assert.equal(st.deploys, 1, "never deployed twice");
});

test("a deploy that keeps failing is stopped after a bound; a veto after the merge stops everything after it", { skip }, async () => {
  await toShipping();
  st.now += HOUR + 1000;
  st.deployFail = "TooManyLive()";
  for (let i = 1; i < 6; i++) await assert.rejects(step(), isDefer);
  assert.match(await step(), /^killed: the deploy failed 6 times/);
  assert.equal(st.deploys, 0);
  assert.equal(gh.refs.get("release"), base, "the merge is never released");
  assert.ok((await sql`select 1 from seq_build where data ? 'badMerge'`).length);
});

test("a veto that lands after the merge: nothing deployed, no fund, no release, no reward", { skip }, async () => {
  await toShipping();
  const r = (await active())!;
  st.now += HOUR + 1000;
  st.deployFail = "TooManyLive()";
  await assert.rejects(step(), isDefer); // merged, the deploy waits
  assert.notEqual(gh.refs.get("main"), base);
  st.vetoed.add(`ship:${r.id}`);
  assert.match(await step(), /^killed: the Safe owners vetoed the ship/);
  assert.equal(st.deploys, 0);
  assert.deepEqual(st.fundCalls, []);
  assert.equal(gh.refs.get("release"), base);
  assert.equal((await sql`select status from idea_queue where id = ${r.data.idea}`)[0].status, "killed");
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), base, "the hourly job never releases a vetoed ship's merge");
});

test("a push to main under a pending ship gets an hour of its own: the ship's merge waits for it", { skip }, async () => {
  await toShipping();
  const pushed = gh.commitFiles(gh.refs.get("main")!, { "docs/x.md": "pushed\n" });
  gh.refs.set("main", pushed);
  st.now += HOUR + 1000;
  assert.match(await step(), /^shipped/);
  assert.equal(gh.refs.get("release"), base, "not with the ship's hour");
  assert.ok(st.alerts.some((a) => /an hour of its own/.test(a)));
  st.now += HOUR + 1000;
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), gh.refs.get("main"), "released after its own hour");
});

test("step (e) after a crash: the idea already shipped and rewarded is not an error", { skip }, async () => {
  await toShipping();
  st.now += HOUR + 1000;
  assert.match(await step(), /^shipped/);
  const [row] = await sql<{ id: string; round: number; data: Record<string, unknown> }[]>`select id, round, data from seq_build`;
  await s.saveBuild({ id: row.id, status: "shipping", round: row.round, data: { ...row.data, rewarded: false } } as never);
  assert.match(await step(), /^shipped/);
});

test("a run still going at 4 h: skipped and charged the whole ceiling", { skip }, async () => {
  await step(); await step();
  const r = (await active())!;
  gh.addRun(`seq order:${r.data.orders[0].id}`, { status: "in_progress", conclusion: null });
  st.now += 4 * HOUR + 1000;
  assert.match(await step(), /^skipped: .* ran past 4 h/);
  assert.deepEqual((await spend()).map((x) => x.cost_usd), [48, 12, -48]);
});

test("a pull request not gated within 4 h: skipped, and its pull request closed", { skip }, async () => {
  await step(); await step();
  const { pr } = await devTeam();
  st.now += 4 * HOUR + 1000;
  assert.match(await step(), /^skipped: .* not gated within 4 h/);
  assert.equal(gh.pulls.find((p) => p.number === pr!.number)!.state, "closed");
});

test("the order ceiling shrinks with the day's cap", { skip }, async () => {
  const saved = LLM.week1DailyCapUsd;
  LLM.week1DailyCapUsd = 40;
  try {
    await step(); await step();
    assert.deepEqual((await spend()).map((x) => x.cost_usd), [19.2], "4 × min($12, 48% of $40 / 4) = 4 × $4.80");
    assert.equal(JSON.parse(gh.dispatches.at(-1).client_payload.body).budget.ceilingUsd, 4.8);
  } finally { LLM.week1DailyCapUsd = saved; }
});

test("awaiting funding, then funded when room appears; a top-up after 5 new players", { skip }, async () => {
  st.fundRoom = false;
  await toShipping();
  st.now += HOUR + 1000;
  assert.match(await step(), /^shipped/);
  assert.deepEqual(st.fundCalls, ["start"]);
  const [{ data }] = await sql<{ data: { game: { address: string } } }[]>`select data from seq_build`;
  const game = data.game.address.toLowerCase();
  const saved = [d.gameFunder, d.delay];
  [d.gameFunder, d.delay] = ["0x00000000000000000000000000000000000000f0", "0x00000000000000000000000000000000000000de"];
  try {
    const fundSt = (funded: bigint) => ({ s: { weeklyBudget: 2n * 10n ** 17n, perGameCap: 10n ** 17n, spentInWindow: 0n, balance: 10n ** 18n, funded: { [game]: funded }, pending: [] }, q: { txNonce: 0n, queueNonce: 0n, headCreatedAt: 0n, cooldown: 3600n, expiration: 86_400n }, block: 1n, records: [], lastFunded: {}, stopped: new Set() });
    st.fundSt = fundSt(0n);
    st.fundRoom = true;
    await s.seqHourly();
    assert.deepEqual(st.fundCalls, ["start", "start"], "retried hourly until room appears");
    st.fundSt = fundSt(10n ** 16n);
    st.players = { players48h: 4, sinceFund: 4 };
    await s.seqHourly();
    assert.deepEqual(st.fundCalls, ["start", "start"], "4 new players: no top-up yet");
    st.players = { players48h: 6, sinceFund: 5 };
    await s.seqHourly();
    assert.deepEqual(st.fundCalls, ["start", "start", "topup"]);
  } finally { [d.gameFunder, d.delay] = saved; }
});

// ---------------------------------------------------------------- funding (src/funding.ts) against its chain seam

const ADDED = { type: "event", name: "TransactionAdded", inputs: [{ name: "queueNonce", type: "uint256", indexed: true }, { name: "txHash", type: "bytes32", indexed: true }, { name: "to", type: "address", indexed: false }, { name: "value", type: "uint256", indexed: false }, { name: "data", type: "bytes", indexed: false }, { name: "operation", type: "uint8", indexed: false }] } as const;
test("funding: a crash after the queue tx mined is recorded from its receipt, never queued twice; a vetoed fund stops the game until the Safe funds it", { skip }, async () => {
  const f = await import("../src/funding.ts");
  const abi = await import("../src/abi.ts");
  const game = "0x00000000000000000000000000000000000000a7" as Address;
  const saved = [d.gameFunder, d.delay, d.roles, d.gameFactory];
  Object.assign(d, { gameFunder: "0x00000000000000000000000000000000000000f0", delay: "0x00000000000000000000000000000000000000de", roles: "0x00000000000000000000000000000000000000c1" });
  const deps = { ...f.FUND_DEPS };
  const sends: unknown[] = [];
  const receipt = (nonce: bigint, amount: bigint, block: bigint) => ({
    blockNumber: block, status: "success",
    logs: [{ address: d.delay!, topics: encodeEventTopics({ abi: [ADDED], eventName: "TransactionAdded", args: { queueNonce: nonce, txHash: `0x${"11".repeat(32)}` } }), data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }], [d.gameFunder!, 0n, encodeFunctionData({ abi: abi.gameFunderAbi, functionName: "fund", args: [game, amount] }), 0]) }],
  });
  let lastFunded: bigint | undefined;
  Object.assign(f.FUND_DEPS, {
    chain: async () => ({ block: 900n, weeklyBudget: 2n * 10n ** 17n, perGameCap: 10n ** 17n, spentInWindow: 0n, balance: 10n ** 18n, q: { txNonce: 8n, queueNonce: 8n, headCreatedAt: 0n, cooldown: 3600n, expiration: 86_400n }, funded: {}, lastFundedBlock: { [game]: lastFunded } }),
    game: async () => ({ isGame: true, live: true }),
    safeCall: async () => "ok",
    send: async (c: unknown) => { sends.push(c); return { status: "mined", hash: `0x${"22".repeat(32)}` }; },
    receipt: async (h: Hex) => (h === `0x${"aa".repeat(32)}` ? receipt(7n, 3n * 10n ** 16n, 500n) : receipt(8n, 2n * 10n ** 16n, 950n)),
  });
  try {
    // the Roles tx of fund #0 mined, then a crash before its fund record
    await append("tx", `seq:fund:b1:${game}:0`, { key: "funder", mode: "live", status: "mined", hash: `0x${"aa".repeat(32)}` });
    const a = await f.queueFund(game, "b1", "start");
    assert.deepEqual(a, { queued: true, amount: 3n * 10n ** 16n, delayNonce: 7n });
    assert.equal(sends.length, 0, "recorded from the receipt, not sent again");
    const [rec] = await f.fundRecords(1);
    assert.equal(rec.delayNonce, "7");
    assert.equal(rec.block, "500");
    // Delay passed nonce 7 (txNonce 8) with no Funded for the game since: vetoed ⇒ stopped, alerted once
    const b = await f.queueFund(game, "b1", "topup");
    assert.equal(b.queued, false);
    assert.match((b as { why: string }).why, /funding stopped/);
    await f.queueFund(game, "b1", "topup");
    assert.equal((await sql`select 1 from job where dedupe_key = ${`alert:fund:stopped:${game}`}`).length, 1);
    assert.equal(sends.length, 0);
    // the Safe funds the game itself (a Funded after the vetoed fund): funding resumes
    lastFunded = 600n;
    const c = await f.queueFund(game, "b1", "topup");
    assert.equal(c.queued, true);
    assert.equal(sends.length, 1);
  } finally {
    Object.assign(f.FUND_DEPS, deps);
    [d.gameFunder, d.delay, d.roles, d.gameFactory] = saved;
  }
});

test("a stopped ship's merge on main: release waits for one owner's approval (after a revert), and never moves without it", { skip }, async () => {
  await toShipping();
  gh.knobs.mergeEdits = { "web/next.config.ts": "export default {};\n" };
  st.now += HOUR + 1000;
  try { assert.match(await step(), /killed: the merged tree is not the gated one/); } finally { gh.knobs.mergeEdits = null; }
  const bad = gh.refs.get("main")!;
  await s.seqHourly();
  assert.ok(st.alerts.some((a) => a.includes(bad) && /one Safe owner's approval/.test(a)));
  st.now += 3 * HOUR;
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), base, "never without the approval");
  // the owners revert it on main; the new head still has the bad merge under it: it too needs an approval
  const reverted = gh.commitFiles(bad, { "web/next.config.ts": null });
  gh.refs.set("main", reverted);
  await s.seqHourly();
  st.now += HOUR + 1000;
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), base, "its hour alone is not enough");
  st.approved.add(`release:${reverted}`);
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), reverted, "one owner's approval releases it");
  // later merges release with their own hour again (nothing bad between release and them)
  const next = gh.commitFiles(reverted, { "docs/y.md": "y\n" });
  gh.refs.set("main", next);
  await s.seqHourly();
  st.now += HOUR + 1000;
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), next);
});

test("a mined deploy whose code never shows: after 30 minutes its receipt is checked; gone (a reorg) ⇒ deployed again", { skip }, async () => {
  await toShipping();
  st.now += HOUR + 1000;
  st.lag = 1000;
  st.landed = false;
  for (let i = 0; i < 30; i++) await assert.rejects(step(), isDefer);
  assert.equal(st.deploys, 1);
  assert.ok(st.alerts.some((a) => /no code after 30 minutes.*deploying again/.test(a)));
  await assert.rejects(step(), isDefer);
  assert.equal(st.deploys, 2);
  st.lag = 0;
  assert.match(await step(), /^shipped/);
});

test("funding: a crash with the queue tx still pending resolves its receipt instead of queuing a second entry", { skip }, async () => {
  const f = await import("../src/funding.ts");
  const abi = await import("../src/abi.ts");
  const game = "0x00000000000000000000000000000000000000a8" as Address;
  const saved = [d.gameFunder, d.delay, d.roles];
  Object.assign(d, { gameFunder: "0x00000000000000000000000000000000000000f0", delay: "0x00000000000000000000000000000000000000de", roles: "0x00000000000000000000000000000000000000c1" });
  const deps = { ...f.FUND_DEPS };
  const sends: unknown[] = [];
  const pending = `0x${"bb".repeat(32)}` as Hex;
  let mined = false;
  Object.assign(f.FUND_DEPS, {
    chain: async () => ({ block: 900n, weeklyBudget: 2n * 10n ** 17n, perGameCap: 10n ** 17n, spentInWindow: 0n, balance: 10n ** 18n, q: { txNonce: 3n, queueNonce: 3n, headCreatedAt: 0n, cooldown: 3600n, expiration: 86_400n }, funded: {}, lastFundedBlock: {} }),
    game: async () => ({ isGame: true, live: true }),
    safeCall: async () => "ok",
    nonce: async () => 4,
    send: async (c: unknown) => { sends.push(c); return { status: "mined", hash: pending }; },
    receipt: async (h: Hex) => {
      if (h !== pending || !mined) throw new Error("not found");
      return { blockNumber: 700n, status: "success", logs: [{ address: d.delay!, topics: encodeEventTopics({ abi: [ADDED], eventName: "TransactionAdded", args: { queueNonce: 3n, txHash: `0x${"11".repeat(32)}` } }), data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }], [d.gameFunder!, 0n, encodeFunctionData({ abi: abi.gameFunderAbi, functionName: "fund", args: [game, 25n * 10n ** 15n] }), 0]) }] };
    },
  });
  try {
    await append("tx", `seq:fund:b2:${game}:0`, { key: "funder", mode: "live", status: "pending", nonce: 4, hashes: [pending] });
    const a = await f.queueFund(game, "b2", "start");
    assert.match((a as { why: string }).why, /still pending/, "its nonce is still open: wait, send nothing");
    mined = true;
    const b = await f.queueFund(game, "b2", "start");
    assert.deepEqual(b, { queued: true, amount: 25n * 10n ** 15n, delayNonce: 3n }, "recorded from its receipt, with the amount it queued");
    assert.equal(sends.length, 0);
  } finally {
    Object.assign(f.FUND_DEPS, deps);
    [d.gameFunder, d.delay, d.roles] = saved;
  }
});

test("an RPC error while rechecking the deploy's receipt waits (Defer) and never deploys again", { skip }, async () => {
  await toShipping();
  st.now += HOUR + 1000;
  st.lag = 1000;
  st.landed = "error";
  for (let i = 0; i < 33; i++) await assert.rejects(step(), isDefer);
  assert.equal(st.deploys, 1, "the receipt could not be read: not counted as gone");
  assert.ok(!st.alerts.some((a) => /deploying again/.test(a)));
  st.lag = 0;
  st.landed = true;
  assert.match(await step(), /^shipped/);
  assert.equal(st.deploys, 1);
});

test("a stopped ship whose deploy tx is on record pages the retire, even before the row noted it", { skip }, async () => {
  await toShipping();
  const r = (await active())!;
  st.now += HOUR + 1000;
  st.deployFail = "TooManyLive()";
  await assert.rejects(step(), isDefer); // merged; the deploy has not landed as far as the row knows
  await append("tx", `seq:deploy:${r.id}`, { key: "agent", mode: "live", status: "mined", hash: `0x${"cd".repeat(32)}` });
  st.vetoed.add(`ship:${r.id}`);
  assert.match(await step(), /^killed: the Safe owners vetoed the ship/);
  assert.ok(st.alerts.some((a) => /factory\.retire\(0x/.test(a)));
});

test("the fund and the reward wait for the game's code at the finalized block", { skip }, async () => {
  await toShipping();
  const r = (await active())!;
  st.now += HOUR + 1000;
  st.finalLag = 2;
  await assert.rejects(step(), isDefer);
  await assert.rejects(step(), isDefer);
  assert.equal(st.deploys, 1);
  assert.deepEqual(st.fundCalls, [], "no fund before the code is final");
  assert.equal((await sql`select status from idea_queue where id = ${r.data.idea}`)[0].status, "building", "no reward before it either");
  assert.match(await step(), /^shipped/);
  assert.deepEqual(st.fundCalls, ["start"]);
  assert.equal((await sql`select status from idea_queue where id = ${r.data.idea}`)[0].status, "reward");
});

test("a plain release record refused at fast-forward (a veto landed under it since): a held record, one alert, released on approval", { skip }, async () => {
  const y = gh.commitFiles(base, { "docs/y.md": "y\n" });
  gh.refs.set("main", y);
  await s.seqHourly(); // y: a plain record
  const x = gh.commitFiles(y, { "docs/x.md": "x\n" });
  gh.refs.set("main", x);
  await s.seqHourly(); // x: a plain record (nothing bad under it yet)
  st.vetoed.add(`release:${y}`); // the owners veto y's release
  st.now += HOUR + 1000;
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), base);
  assert.equal(st.alerts.filter((a) => a.includes(x) && /one Safe owner's approval/.test(a)).length, 1);
  await s.seqHourly();
  assert.equal(st.alerts.filter((a) => a.includes(x) && /one Safe owner's approval/.test(a)).length, 1, "once per sha");
  st.approved.add(`release:${x}`);
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), x);
});

test("a stopped merge stays held after its build row is deleted: the signed log record marks it", { skip }, async () => {
  await toShipping();
  gh.knobs.mergeEdits = { "web/next.config.ts": "export default {};\n" };
  st.now += HOUR + 1000;
  try { assert.match(await step(), /killed: the merged tree is not the gated one/); } finally { gh.knobs.mergeEdits = null; }
  const bad = gh.refs.get("main")!;
  const [mark] = await sql<{ doc: { bad: string[]; needApprovals: number } }[]>`select doc from log where kind = 'release' and ref = ${`release:${bad}`}`;
  assert.deepEqual(mark.doc.bad, [bad]);
  assert.equal(mark.doc.needApprovals, 1);
  await sql`delete from seq_build`; // the attacker drops the killed build (and its badMerge)
  const next = gh.commitFiles(bad, { "docs/z.md": "z\n" });
  gh.refs.set("main", next);
  await s.seqHourly();
  const [rec] = await sql<{ doc: { needApprovals?: number; bad?: string[] } }[]>`select doc from log where kind = 'release' and ref = ${`release:${next}`}`;
  assert.equal(rec.doc.needApprovals, 1, "the next commit's release is held");
  assert.deepEqual(rec.doc.bad, [bad]);
  st.now += 3 * HOUR;
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), base, "never out without an owner's approval");
});

test("approving a stopped merge's own record never carries a vetoed commit under it; the full-list record does", { skip }, async () => {
  const f = gh.commitFiles(base, { "docs/f.md": "f\n" }); // another merge on main, then vetoed by the owners
  gh.refs.set("main", f);
  await s.seqHourly();
  await toShipping();
  gh.knobs.mergeEdits = { "web/next.config.ts": "export default {};\n" };
  st.now += HOUR + 1000;
  try { assert.match(await step(), /killed: the merged tree is not the gated one/); } finally { gh.knobs.mergeEdits = null; }
  const m = gh.refs.get("main")!;
  st.vetoed.add(`release:${f}`);
  const seqs = async () => (await sql<{ seq: string; doc: { bad?: string[] } }[]>`select seq::text, doc from log where kind = 'release' and ref = ${`release:${m}`} order by seq`);
  const [mark] = await seqs();
  assert.deepEqual(mark.doc.bad, [m], "F was not vetoed yet when M stopped");
  st.approved.add(mark.seq); // one owner approves M's own record only
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), base, "F's veto is not carried by an approval of M's record");
  const full = (await seqs()).at(-1)!;
  assert.notEqual(full.seq, mark.seq);
  assert.deepEqual([...(full.doc.bad ?? [])].sort(), [f, m].sort(), "a new held record with the full list");
  assert.ok(st.alerts.some((a) => a.includes(`release record ${full.seq}`)));
  st.approved.add(full.seq);
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), m, "approving the full list moves it");
});

// ---------------------------------------------------------------- game pages (G15, ship-cancel, page-kill)

test("G15 at the gate: a page that breaks a rule kills the build at once (not a rework), its PR closed, the owners paged", { skip }, async () => {
  await step(); await step();
  const { pr, order } = await devTeam();
  st.page = PAGE_BAD;
  assert.match(await step(), /^killed: the page check failed \(G15\)/);
  const call = st.pageCalls[0];
  const r = (await sql<{ data: { slug: string; idea: string } }[]>`select data from seq_build`)[0];
  assert.ok(call.files[`web/app/g/${r.data.slug}/page.tsx`], "the gated page itself goes to the check");
  assert.equal(call.salt, order.salt, "staged at the order's CREATE2 salt");
  assert.equal(call.initCode, INIT, "with the enclave's own compile");
  const [g] = await sql<{ doc: { ok: boolean; results: { gate: string; ok: boolean; kill?: boolean }[] } }[]>`select doc from log where kind = 'gates' order by seq desc limit 1`;
  assert.equal(g.doc.ok, false);
  assert.deepEqual([g.doc.results.at(-1)!.gate, g.doc.results.at(-1)!.kill], ["G15", true], "the evidence is in the signed gates record");
  assert.equal(gh.pulls.find((p) => p.number === pr!.number)!.state, "closed");
  assert.ok(st.alerts.some((a) => /the page check of .* failed/.test(a)));
  assert.equal((await sql`select status from idea_queue where id = ${r.data.idea}`)[0].status, "killed");
  assert.equal(st.deploys, 0);
});

test("G15 runs only after every other gate passed (it builds and runs the page)", { skip }, async () => {
  await step(); await step();
  await devTeam();
  st.gatesOk = false;
  assert.match(await step(), /with failures/);
  assert.equal(st.pageCalls.length, 0);
});

test("the public hour's page check fails: the enclave cancels its own ship, nothing merged or deployed, the owners asked to veto", { skip }, async () => {
  await step(); await step();
  await devTeam();
  await step(); await step();
  assert.match(await step(), /ship record (\d+)/);
  const r = (await active())!;
  st.deep = { ...PAGE_BAD, why: "network: navigation to https://x.example/" };
  assert.match(await step(), /^killed: the enclave cancelled its ship/);
  const [c] = await sql<{ ref: string; doc: { ship: string; why: string } }[]>`select ref, doc from log where kind = 'ship-cancel'`;
  assert.equal(c.ref, `ship:${r.id}`);
  assert.equal(c.doc.ship, r.data.shipSeq);
  assert.match(c.doc.why, /navigation/);
  assert.ok(st.alerts.some((a) => new RegExp(`/veto ${r.data.shipSeq}`).test(a)), "the owners are asked to veto the ship record too");
  st.now += HOUR + 1000;
  assert.equal(gh.refs.get("main"), base, "nothing merged");
  assert.equal(st.deploys, 0);
});

test("the public hour's page check runs once, before anything merges", { skip }, async () => {
  await step(); await step();
  await devTeam();
  await step(); await step(); await step();
  assert.equal(await step(), "waiting: the public hour");
  assert.equal(await step(), "waiting: the public hour");
  assert.equal(st.deepCalls, 1);
  st.now += HOUR + 1000;
  assert.match(await step(), /^shipped/);
  assert.equal(st.deepCalls, 1);
});

test("page kill: the record the play origin reads, the owners paged, release without the page at once, main through a merge commit; twice = once", { skip }, async () => {
  const slug = "dice-9";
  const withGame = gh.commitFiles(base, { [`web/app/g/${slug}/page.tsx`]: "p\n", [`web/app/g/${slug}/game.json`]: "{}\n", "web/app/g/other-1/page.tsx": "o\n" });
  gh.refs.set("release", withGame);
  const later = gh.commitFiles(withGame, { "docs/y.md": "y\n" }); // on main, still in its own public hour
  gh.refs.set("main", later);
  const seq = await pages.pageKill(slug, pages.KILL_WHY.check, "refused: personal_sign");
  // what the play origin reads (web/app/g/state.ts)
  const k = await sql<{ why: string }[]>`select doc->>'why' as why from log where kind = 'page-kill' and ref = ${slug} order by seq desc limit 1`;
  assert.equal(k[0].why, pages.KILL_WHY.check);
  assert.ok(st.alerts.some((a) => /page of dice-9 was pulled/.test(a)));
  assert.equal((await sql`select 1 from job where kind = 'pages:revert' and dedupe_key = ${`pages:revert:${slug}`}`).length, 1);
  assert.match(await pages.revertStep(slug, seq), /^merged: /);
  // release: the kill commit right on top of what was released (not main's unreleased commit)
  const rel = gh.refs.get("release")!;
  assert.deepEqual(gh.commits.get(rel)!.parents, [withGame]);
  const relFiles = Object.keys(gh.filesOf(rel));
  assert.ok(!relFiles.some((f) => f.startsWith(`web/app/g/${slug}/`)));
  assert.ok(relFiles.includes("web/app/g/other-1/page.tsx"), "only that page's folder");
  assert.ok(!relFiles.includes("docs/y.md"), "release did not jump ahead of main's public hour");
  const [rr] = await sql<{ doc: { pageKill: string; sha: string } }[]>`select doc from log where kind = 'release' and ref = ${`release:${rel}`}`;
  assert.equal(rr.doc.pageKill, seq, "the watchdog finds a signed release record for the new release head");
  // main: a merge commit with the kill commit as a parent, so release keeps fast-forwarding
  const main = gh.refs.get("main")!;
  assert.deepEqual(gh.commits.get(main)!.parents, [later, rel]);
  assert.ok(!Object.keys(gh.filesOf(main)).some((f) => f.startsWith(`web/app/g/${slug}/`)));
  assert.ok(Object.keys(gh.filesOf(main)).includes("docs/y.md"));
  // twice = once
  assert.equal(await pages.pageKill(slug, pages.KILL_WHY.check, "again"), seq);
  assert.equal(await pages.revertStep(slug, seq), "done");
  assert.equal((await sql`select 1 from log where kind = 'page-kill'`).length, 1);
});

test("page kill with a stopped ship's merge under main: the revert on release is never refused for it; main's next release record is held", { skip }, async () => {
  const slug = "dice-10";
  const withGame = gh.commitFiles(base, { [`web/app/g/${slug}/page.tsx`]: "p\n", [`web/app/g/${slug}/game.json`]: "{}\n" });
  gh.refs.set("main", withGame);
  gh.refs.set("release", withGame);
  // a ship stopped after its merge: a merge on main that must never go out on its own
  await toShipping();
  gh.knobs.mergeEdits = { "web/next.config.ts": "export default {};\n" };
  st.now += HOUR + 1000;
  try { assert.match(await step(), /killed: the merged tree is not the gated one/); } finally { gh.knobs.mergeEdits = null; }
  const bad = gh.refs.get("main")!;
  assert.ok((await sql`select 1 from seq_build where data->>'badMerge' = ${bad}`).length);
  // the page is pulled: release moves at once to a commit on top of what was released, without the page
  const seq = await pages.pageKill(slug, pages.KILL_WHY.check, "refused: personal_sign");
  assert.match(await pages.revertStep(slug, seq), /^merged: /);
  const rel = gh.refs.get("release")!;
  assert.deepEqual(gh.commits.get(rel)!.parents, [withGame], "nothing of main came along: the stopped merge stays out");
  assert.ok(!Object.keys(gh.filesOf(rel)).some((f) => f.startsWith(`web/app/g/${slug}/`)));
  const [rr] = await sql<{ doc: { pageKill: string; needApprovals?: number } }[]>`select doc from log where kind = 'release' and ref = ${`release:${rel}`}`;
  assert.equal(rr.doc.pageKill, seq);
  assert.equal(rr.doc.needApprovals, undefined, "a kill's own record is never held");
  // main: the kill merged in; its next release record carries the stopped merge under it, so it is held
  const main = gh.refs.get("main")!;
  assert.deepEqual(gh.commits.get(main)!.parents, [bad, rel]);
  await s.seqHourly();
  const [held] = await sql<{ doc: { needApprovals?: number; bad?: string[] } }[]>`select doc from log where kind = 'release' and ref = ${`release:${main}`} order by seq desc limit 1`;
  assert.equal(held.doc.needApprovals, 1);
  assert.ok(held.doc.bad!.includes(bad));
  st.now += HOUR + 1000;
  await s.seqHourly();
  assert.equal(gh.refs.get("release"), rel, "release stays on the kill commit until an owner approves");
});

test("page kill revert: only for a signed kill of that page; a commit GitHub made wrong is never released; a lost kill commit waits (Defer), never done", { skip }, async () => {
  const slug = "dice-11";
  const withGame = gh.commitFiles(base, { [`web/app/g/${slug}/page.tsx`]: "p\n", "README.md": "dna\n" });
  gh.refs.set("main", withGame);
  gh.refs.set("release", withGame);
  await assert.rejects(pages.revertStep("../x", "1"), /bad slug/);
  await assert.rejects(pages.revertStep(slug, "999999"), /no signed page-kill record 999999/);
  const seq = await pages.pageKill(slug, pages.KILL_WHY.check, "refused: personal_sign");
  // GitHub hands back a tree with something extra: nothing signed, release not moved, the owners told
  gh.knobs.treeEdits = { "web/next.config.ts": "export default {};\n" };
  try { await assert.rejects(pages.revertStep(slug, seq), /is not release .* without/); } finally { gh.knobs.treeEdits = null; }
  assert.equal(gh.refs.get("release"), withGame);
  assert.ok(st.alerts.some((a) => /not the released tree without its page/.test(a)));
  // release already without the page but no commit of this kill there (someone else removed it): wait, retried
  const other = gh.commitFiles(withGame, { [`web/app/g/${slug}/page.tsx`]: null });
  gh.refs.set("release", other);
  await assert.rejects(pages.revertStep(slug, seq), isDefer);
  assert.ok(st.alerts.some((x) => x.includes(slug) && /is waiting: main still has the page/.test(x)), "a revert that cannot go on is never silent");
});

// ---------------------------------------------------------------- a site change

const FAQ = `import Link from "next/link";\nexport const metadata = { title: "Questions" };\nexport default function Faq() { return <main><h1>Questions</h1><Link href="/rules">The rules</Link></main>; }\n`;
/** The real gates (a site change's are static), with the gate calls still counted. */
async function realGates<T>(fn: () => Promise<T>) {
  const { runGates } = await import("../src/seq-forge.ts");
  const fake = s.SEQ_DEPS.runGates;
  s.SEQ_DEPS.runGates = (async (i: Parameters<typeof runGates>[0]) => { st.gateCalls.push(i); return runGates(i); }) as never;
  try { return await fn(); } finally { s.SEQ_DEPS.runGates = fake; }
}

test("site: the brain picks a site change → a site order → the real gates and G15 on the site's pages → one public hour → merge → release; nothing deployed or funded", { skip }, () => realGates(async () => {
  st.kind = "site";
  assert.match(await step(), /^decided: /);
  const r0 = (await active())!;
  assert.equal(r0.data.kind, "site");
  assert.match(await step(), /^dispatched: /);
  const v = await verifyOrder(gh.dispatches.at(-1).client_payload, signer, st.now);
  assert.equal(v.ok && v.order.kind, "site", "the workflow's own check accepts a site order");
  const files = { "web/app/faq/page.tsx": FAQ, "docs/FAQ.md": "# Questions\n" };
  await devTeam({ files });
  assert.match(await step(), /gated: .* all green/);
  assert.equal((st.gateCalls[0] as { kind: string }).kind, "site");
  const [gates] = await sql<{ doc: { results: { gate: string; ok: boolean }[]; game?: unknown } }[]>`select doc from log where kind = 'gates' order by seq desc limit 1`;
  assert.deepEqual(gates.doc.results.map((g) => [g.gate, g.ok]), [["G14", true], ["G1", true], ["G2", true], ["G11", true], ["G12", true], ["G15", true]]);
  assert.equal(gates.doc.game, undefined);
  assert.ok(st.siteCalls[0].pages.includes("web/app/faq/page.tsx"), "G15 sees the gated tree's pages");
  assert.deepEqual(Object.keys(st.siteCalls[0].files).sort(), Object.keys(files).sort());
  assert.equal(st.pageCalls.length, 0, "no game page check");
  assert.match(await step(), /ship decided/);
  assert.match(await step(), /ship record \d+/);
  const [ship] = await sql<{ doc: { target: string; paths: string[]; predicted?: string; treeHashes: Record<string, string> } }[]>`select doc from log where kind = 'ship' order by seq desc limit 1`;
  assert.equal(ship.doc.target, "site");
  assert.deepEqual(ship.doc.paths, ["docs/FAQ.md", "web/app/faq/page.tsx"]);
  assert.deepEqual(Object.keys(ship.doc.treeHashes), ["docs/FAQ.md", "web/app/faq/page.tsx"]);
  assert.equal(ship.doc.predicted, undefined);
  assert.equal(await step(), "waiting: the public hour");
  assert.equal(gh.refs.get("main"), base, "nothing merged during the hour");
  assert.equal(st.deepCalls, 1, "the public hour's page check ran first");
  st.now += HOUR + 1000;
  assert.match(await step(), /^shipped: .* \(site, released at [0-9a-f]{40}\)$/);
  const r = (await sql<{ status: string; data: { mergeSha: string; game?: unknown; fund?: unknown } }[]>`select status, data from seq_build`)[0];
  assert.equal(r.status, "shipped");
  assert.equal(gh.refs.get("main"), r.data.mergeSha);
  assert.equal(gh.refs.get("release"), r.data.mergeSha, "released after the public hour");
  assert.deepEqual([st.deploys, st.fundCalls.length, r.data.game, r.data.fund], [0, 0, undefined, undefined], "nothing to deploy or fund");
  assert.equal((await sql`select status from idea_queue where id = ${r0.data.idea}`)[0].status, "reward");
  const ann = (await sql<{ ref: string }[]>`select ref from log where kind = 'announce' order by seq`).map((x) => x.ref);
  assert.ok(ann.includes(`seq:${r0.id}:seq_released`));
  assert.ok(!ann.includes(`seq:${r0.id}:seq_shipped`), "no new game announced");
  assert.equal((await sql`select 1 from x_outbox where event_key = ${`seq:${r0.id}:seq_released`}`).length, 1, "a shipped site change goes to X too");
  assert.deepEqual((await spend()).map((x) => x.cost_usd), [48, 3.5, -48]);
}));

test("site: a PR that reaches the wallet guard fails G1 (never reachable): no page check, the brain's ship turns into a rework", { skip }, () => realGates(async () => {
  st.kind = "site";
  await step(); await step();
  await devTeam({ files: { "web/app/faq/page.tsx": FAQ, "web/app/_ui/guard.ts": "export const guardScript = () => \"\";\n" } });
  assert.match(await step(), /gated: .* with failures/);
  const [gates] = await sql<{ doc: { results: { gate: string; ok: boolean; issues: string[] }[] } }[]>`select doc from log where kind = 'gates' order by seq desc limit 1`;
  const g1 = gates.doc.results.find((g) => g.gate === "G1")!;
  assert.equal(g1.ok, false);
  assert.match(g1.issues.join("\n"), /web\/app\/_ui\/guard\.ts: never reachable \(the site's security layer\)/);
  assert.equal(st.siteCalls.length, 0, "G15 runs only once every other gate passed");
  assert.equal(gh.statuses.at(-1)?.state, "failure");
  assert.match(await step(), /^rework: round 2/);
}));

test("site: a merge that changes a file the ship record does not name is never released", { skip }, () => realGates(async () => {
  st.kind = "site";
  await step(); await step();
  await devTeam({ files: { "web/app/faq/page.tsx": FAQ } });
  await step(); await step(); await step();
  gh.knobs.mergeEdits = { "web/app/rules/page.tsx": "export default function P() { return null; }\n" };
  st.now += HOUR + 1000;
  try {
    assert.match(await step(), /killed: the merged tree is not the gated one/);
  } finally { gh.knobs.mergeEdits = null; }
  assert.equal(gh.refs.get("release"), base);
  assert.ok(st.alerts.some((a) => /not the gated tree \(also changes web\/app\/rules\/page\.tsx\)/.test(a)));
}));

// ---------------------------------------------------------------- a module

const MODULE_CODE = "0x6080604052348015600e575f5ffd5b50" as Hex;
const MODULE_RUNTIME = "0x6080604052" as Hex;
/** The gates' run for a module order: every gate green and the enclave's own compile of it. */
async function moduleGates<T>(fn: () => Promise<T>) {
  const fake = s.SEQ_DEPS.runGates;
  s.SEQ_DEPS.runGates = (async (i: { kind?: string; order: { salt?: Hex } }) => {
    st.gateCalls.push(i);
    const { moduleAddress } = await import("../src/seq-forge.ts");
    return {
      results: ["G1", "G2", "G12", "G3", "G5", "G4", "G6", "G8", "G7"].map((g) => ({ gate: g, name: g, ok: true, issues: [] })),
      module: { name: "TierFee", kind: "fee", initCode: MODULE_CODE, runtime: MODULE_RUNTIME, codehash: keccak256(MODULE_RUNTIME), salt: i.order.salt!, address: moduleAddress(i.order.salt!, MODULE_CODE), bounds: { min: ["10000", "0", "10000", "1"], max: ["35000", "5000", "35000", "9"], start: ["20000", "5000", "35000", "2"] } },
    };
  }) as never;
  try { return await fn(); } finally { s.SEQ_DEPS.runGates = fake; }
}

test("module: the brain picks a module → a module order → its gates → one public hour → merge and release → a proposal for the Safe; nothing sent on chain", { skip }, () => moduleGates(async () => {
  st.kind = "module";
  const [{ logFrom }] = await sql<{ logFrom: string }[]>`select coalesce(max(seq), 0)::text as "logFrom" from log`;
  const [{ jobsFrom }] = await sql<{ jobsFrom: string }[]>`select coalesce(max(id), 0)::text as "jobsFrom" from job`;
  assert.match(await step(), /^decided: /);
  assert.equal((await active())!.data.kind, "module");
  assert.match(await step(), /^dispatched: /);
  const v = await verifyOrder(gh.dispatches.at(-1).client_payload, signer, st.now);
  assert.equal(v.ok && v.order.kind, "module", "the workflow's own check accepts a module order");
  const slug = (await active())!.data.slug;
  await devTeam({ files: { [`contracts/src/modules/${slug}/TierFee.sol`]: "contract TierFee {}\n", [`contracts/test/modules/${slug}/TierFee.t.sol`]: "contract T {}\n", [`contracts/src/modules/${slug}/SPEC.json`]: "{}\n" } });
  assert.match(await step(), /gated: .* all green/);
  assert.equal((st.gateCalls[0] as { kind: string }).kind, "module");
  assert.equal(st.pageCalls.length + st.siteCalls.length, 0, "a module has no page");
  const [gates] = await sql<{ doc: { module: { codehash: string; initCode: string } } }[]>`select doc from log where kind = 'gates' order by seq desc limit 1`;
  assert.equal(gates.doc.module.codehash, keccak256(MODULE_RUNTIME));
  assert.equal(gates.doc.module.initCode, MODULE_CODE);
  assert.match(await step(), /ship decided/);
  assert.match(await step(), /ship record \d+/);
  const [ship] = await sql<{ seq: string; doc: { target: string; paths: string[]; module: { codehash: string; address: string; calls: { to: string; data?: string; initCodeIn?: string }[] } } }[]>`select seq::text, doc from log where kind = 'ship' order by log.seq desc limit 1`;
  assert.equal(ship.doc.target, "module");
  assert.deepEqual(ship.doc.paths, [`contracts/src/modules/${slug}/`, `contracts/test/modules/${slug}/`]);
  assert.equal(ship.doc.module.codehash, keccak256(MODULE_RUNTIME));
  assert.deepEqual(ship.doc.module.calls.map((c) => c.to.toLowerCase()), ["0x4e59b44847b379578588920ca78fbf26c0b4956c", d.registry.toLowerCase(), d.registry.toLowerCase()]);
  assert.equal(ship.doc.module.calls[0].initCodeIn, (await sql<{ seq: string }[]>`select seq::text from log where kind = 'gates' order by log.seq desc limit 1`)[0].seq, "the deploy's init code is the gates record's");
  assert.equal(await step(), "waiting: the public hour");
  st.now += HOUR + 1000;
  assert.match(await step(), /^shipped: .* \(module 0x[0-9a-f]{64}, proposed to the Safe\)$/);
  const r = (await sql<{ id: string; status: string; data: { mergeSha: string } }[]>`select id, status, data from seq_build`)[0];
  assert.equal(gh.refs.get("main"), r.data.mergeSha, "merged");
  assert.equal(gh.refs.get("release"), r.data.mergeSha);
  // never switched on: nothing deployed, queued or funded by the engine
  assert.deepEqual([st.deploys, st.fundCalls.length], [0, 0]);
  assert.equal((await sql`select 1 from log where kind = 'tx' and seq > ${logFrom}`).length, 0, "no transaction of any key");
  assert.equal((await sql`select 1 from job where id > ${jobsFrom} and kind like '%queue%'`).length, 0, "no registry op queued");
  assert.ok(st.alerts.some((a) => a.includes(keccak256(MODULE_RUNTIME)) && /ApproveCodehash, Register\. The engine sends none of them/.test(a)));
  const ann = (await sql<{ ref: string }[]>`select ref from log where kind = 'announce' order by seq`).map((x) => x.ref);
  assert.ok(ann.includes(`seq:${r.id}:seq_released`));
  // on X once: proposed to the Safe (the fact sheet's stage says nothing changes until the Safe approves it)
  const xs = await sql<{ event: { target: string } }[]>`select event from x_outbox where event_key = ${`seq:${r.id}:seq_released`}`;
  assert.deepEqual(xs.map((x) => x.event.target), ["module"]);
}));

test("module: an image without the module kit builds no module: a no-build and an alert", { skip }, async () => {
  st.kind = "module";
  st.moduleKit = false;
  assert.match(await step(), /^no-build: .* \(no module kit in this image\)$/);
  assert.equal(await active(), null);
  assert.ok(st.alerts.some((a) => /has no module kit/.test(a)));
});

test("module: a Safe veto in the public hour: no merge, no proposal", { skip }, () => moduleGates(async () => {
  st.kind = "module";
  await step(); await step();
  const slug = (await active())!.data.slug;
  await devTeam({ files: { [`contracts/src/modules/${slug}/TierFee.sol`]: "contract TierFee {}\n", [`contracts/test/modules/${slug}/TierFee.t.sol`]: "contract T {}\n" } });
  await step(); await step(); await step();
  st.vetoed.add(`ship:${(await active())!.id}`);
  st.now += HOUR + 1000;
  assert.match(await step(), /^killed: the Safe owners vetoed the ship/);
  assert.equal(gh.refs.get("main"), base);
  assert.ok(!st.alerts.some((a) => /The engine sends none of them/.test(a)));
}));

// ---------------------------------------------------------------- an engine change, from the brain's own open risks

const ENGINE_FILES = {
  "engine/src/watch-retry.ts": "export const tries = 2;\n",
  "engine/test/watch-retry.test.ts": `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { tries } from "../src/watch-retry.ts";\ntest("a failed read is tried twice", () => assert.equal(tries, 2));\n`,
};
const IMPROVE = { improve: true, risk: "the watch's head read has no retry", target: "engine", title: "Watch retry", spec: "Retry a failed head read once before alerting, and add a test that a single failed read is retried.", rubric: { value: 3, fit: 4, clarity: 4, originality: 2 }, reason: "an open risk with a small, testable fix" };

test("engine: no idea queued → the brain picks one of its open risks → an engine order → its gates → handed: the pull request left for an owner, never merged", { skip }, () => realGates(async () => {
  await sql`delete from idea_queue`;
  st.risks = ["the watch's head read has no retry"];
  st.improve = IMPROVE;
  assert.match(await step(), /^decided: b\d{8}-s1 /);
  const r0 = (await active())!;
  assert.deepEqual([r0.data.kind, r0.data.idea, r0.data.title], ["engine", "", "Watch retry"]);
  assert.match(r0.data.orders[0].id, new RegExp(`^${r0.id}-r1-[0-9a-f]{12}$`), "a chosen change's order id is drawn at random too");
  const [asked] = await sql<{ doc: { input?: unknown } }[]>`select doc from log where kind = 'brain' and ref = ${`improve:${new Date(st.now).toISOString().slice(0, 10)}`}`;
  assert.ok(asked, "the brain weighed the open risks (a signed brain record)");
  assert.deepEqual(st.inputs.improve, { openRisks: ["the watch's head read has no retry"], untrusted: true }, "the self-file's risks reach the brain as data");
  assert.equal(r0.data.risk, "the watch's head read has no retry", "the build row keeps the risk it answers");
  assert.match(await step(), /^dispatched: /);
  const v = await verifyOrder(gh.dispatches.at(-1).client_payload, signer, st.now);
  assert.equal(v.ok && v.order.kind, "engine", "the workflow's own check accepts an engine order");
  const { pr } = await devTeam({ files: ENGINE_FILES });
  assert.match(await step(), /gated: .* all green/);
  const [gates] = await sql<{ doc: { results: { gate: string; ok: boolean }[] } }[]>`select doc from log where kind = 'gates' order by seq desc limit 1`;
  assert.deepEqual(gates.doc.results.map((g) => [g.gate, g.ok]), [["G14", true], ["G1", true], ["G2", true], ["G12", true], ["G16", true]]);
  assert.match(await step(), /ship decided/);
  const touch = (st.inputs.verdict as { touch?: { path: string; plus: number }[] }).touch;
  assert.deepEqual(touch?.map((t) => [t.path, t.plus]).sort(), [["engine/src/watch-retry.ts", 1], ["engine/test/watch-retry.test.ts", 4]], "the verdict sees what each file touches");
  assert.match(await step(), /^handed: .* \(pull request #\d+ waits for an owner's merge\)$/);
  const [ship] = await sql<{ doc: { target: string; ownerMerge: boolean; paths: string[]; pr: number; risk: string; touch: unknown[] } }[]>`select doc from log where kind = 'ship' order by seq desc limit 1`;
  assert.deepEqual([ship.doc.target, ship.doc.ownerMerge, ship.doc.paths.sort(), ship.doc.pr, ship.doc.risk, ship.doc.touch.length], ["engine", true, Object.keys(ENGINE_FILES).sort(), pr!.number, "the watch's head read has no retry", 2]);
  const row = (await sql<{ id: string; status: string; data: Record<string, unknown> }[]>`select id, status, data from seq_build`)[0];
  assert.equal(row.status, "handed");
  assert.equal(await active(), null, "handed is not active: the next build may start");
  const alert = st.alerts.find((a) => a.includes(`pull request #${pr!.number}`) && /waits for an owner's review and merge/.test(a)) ?? "";
  assert.match(alert, /It answers the open risk: the watch's head read has no retry/);
  assert.match(alert, /- engine\/src\/watch-retry\.ts \+1\/-0/, "the owners see what it touches");
  assert.ok((await sql<{ ref: string }[]>`select ref from log where kind = 'announce'`).some((x) => x.ref === `seq:${row.id}:seq_handoff`));
  assert.equal((await sql`select 1 from x_outbox where event_key = ${`seq:${row.id}:seq_handoff`}`).length, 1, "on X once: handed over, not merged");
  assert.deepEqual((await spend()).map((x) => x.cost_usd), [48, 3.5, -48], "the reservation released");
  // hours later: still open, never merged; the open risks are not weighed twice a day
  st.now += 3 * HOUR;
  assert.equal(await step(), "done for today: an engine change was handed to an owner");
  assert.equal(gh.refs.get("main"), base);
  assert.equal(pr!.state, "open");
  assert.equal(pr!.merged, false);
  // and a row forged back into `shipping`: the ship path refuses to merge an engine change
  await s.saveBuild({ id: row.id, status: "shipping", round: 1, data: row.data as never });
  await assert.rejects(s._test.ship((await active())!, st.now), /an engine change is merged by an owner only/);
  assert.equal(gh.refs.get("main"), base, "never merged");
}));

test("open risks: the newest self record the enclave signed (its text hashing to its sha256); a record that doesn't hash is skipped for the file", { skip }, async () => {
  const text = "# Self\n\n## Open risks\n- the watch's head read has no retry\n- the page check can't see after a day\n";
  const day = `2099-01-${String(10 + (ideaN % 20)).padStart(2, "0")}`;
  await append("self", day, { kind: "self", day, text, sha256: createHash("sha256").update(text).digest("hex") });
  assert.deepEqual(await realOpenRisks(), ["the watch's head read has no retry", "the page check can't see after a day"]);
  await append("self", day, { kind: "self", day, text: `${text}- a forged risk\n`, sha256: createHash("sha256").update(text).digest("hex") });
  assert.deepEqual(await realOpenRisks(), [], "a self record whose text doesn't hash is not read (no self-file on disk here)");
});

test("improve: no open risk, no brain call; a no from the brain, no build", { skip }, async () => {
  await sql`delete from idea_queue`;
  st.now += 48 * HOUR; // a day the open risks were not weighed yet
  assert.equal(await step(), "nothing queued");
  assert.equal((await sql`select 1 from log where kind = 'brain' and ref = ${`improve:${new Date(st.now).toISOString().slice(0, 10)}`}`).length, 0, "no open risk, no brain call");
  st.risks = ["the watch's head read has no retry"];
  assert.match(await step(), /^nothing to improve today: nothing worth it/);
  assert.equal(await active(), null);
});

test("the daily live page check waits while a build is going (they share the one page check service)", { skip }, async () => {
  await step(); // a build decided
  await assert.rejects(s.pagesDailyHandler.run({ id: "1", kind: "pages:daily", payload: {}, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null }), isDefer);
});
