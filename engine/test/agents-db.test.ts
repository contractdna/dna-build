// Agent-loop jobs against a real Postgres (fresh database per run), LLM calls REPLAYED from committed fixtures
// (test/fixtures/llm/). Those fixtures are SYNTHETIC (scripts/synthetic.ts, `"synthetic": true` in each response):
// no XAI/OpenRouter key exists in CI. Regenerate after changing a prompt, schema or these inputs:
//   RECORD_FIXTURES=1 TEST_DATABASE_URL=… node --test test/agents-db.test.ts
// (with XAI_API_KEY/OPENROUTER_API_KEY_ENGINE and RECORD_LIVE=1 it records real answers instead; assertions stay structural).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { startFakes } from "../scripts/fakes.ts";
import { synthetic } from "../scripts/synthetic.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
fakes.llm.xai = (b) => synthetic("xai", b);
fakes.llm.anthropic = (b) => synthetic("anthropic", b);
const dbName = `dna_agents_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
const live = process.env.RECORD_LIVE === "1";

if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc`, ENGINE_MODE: "dry_run",
    LLM_MODE: process.env.RECORD_FIXTURES ? "record" : "replay", LLM_FIXTURES: new URL("./fixtures/llm/", import.meta.url).pathname,
    ...(live ? {} : { XAI_API_BASE: fakes.url, OPENROUTER_API_BASE: fakes.url, XAI_API_KEY: "k", OPENROUTER_API_KEY_ENGINE: "k" }),
  });
}
const { edb: sql, migrate } = await import("../src/db.ts");
const records = await import("../src/records.ts");
const observe = await import("../src/observe.ts");
const loop = await import("../src/loop.ts");

before(async () => { if (ADMIN) await migrate(); });
after(async () => {
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await fakes.close();
});

const job = (payload: Record<string, unknown> = {}) => ({ id: "0", kind: "t", payload, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null }) as never;
const DAY = "2026-10-05";
const t = (h: number) => new Date(`${DAY}T${String(h).padStart(2, "0")}:00:00Z`);
const MOD = "0x00000000000000000000000000000000000000a1";
const SPLIT = "0x00000000000000000000000000000000000000b2";

async function chain(block: number, li: number, at: Date, tx: string, event: string, args: Record<string, unknown>) {
  await sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (${block}, ${li}, ${tx}, '0x', ${at}, '0x', ${event}, ${sql.json(args as never)})`;
}

test("records: zod-validated (site kinds), sequential step ids, latest per ref", { skip }, async () => {
  await assert.rejects(records.record("memory", "1", { id: 1, title: "x" }), /invalid|expected/i);
  await assert.rejects(records.record("security", "R-1", { id: "R-1", kind: "red-team", title: "t", severity: "critical", status: "open", detail: "d", date: DAY }), /severity|invalid/i);
  await records.record("thread", "T-9", { id: "T-9", title: "t", status: "open" });
  await records.step("T-9", { kind: "hypothesis", agent: "Main", model: "m", text: "a" });
  await records.step("T-9", { kind: "next", agent: "Main", model: "m", text: "b" });
  const steps = await sql<{ doc: { id: string } }[]>`select doc from log where kind = 'step' and ref = 'T-9' order by seq`;
  assert.deepEqual(steps.map((s) => s.doc.id), ["T-9-s1", "T-9-s2"]);
  assert.equal((await records.latest<{ status: string }>("thread", "T-9"))!.status, "open");
  await assert.rejects(records.step("T-9", { kind: "guess" as never, agent: "Main", model: "m", text: "c" }));
});

test("observe: trailing stats from paired chain rows, epoch records (genesis, fee promotions only), idempotent", { skip }, async () => {
  await sql`insert into state (key, block, value) values ('deployment', 0, ${sql.json({ startBlock: 1 })}), ('chain', 9, ${sql.json({ level: 5, route: { active: MOD, activeParams: [`0x${(20_000).toString(16)}`, "0x0", `0x${(30_000).toString(16)}`, "0x0"] } })})`;
  await sql`insert into cursor (id, block, hash, at) values (1, 99, '0x', ${t(23)})`;
  await chain(2, 0, t(1), "0xr1", "Registered", { module: MOD, kind: 0 });
  await chain(2, 1, t(1), "0xr2", "Registered", { module: SPLIT, kind: 1 });
  for (let i = 0; i < 6; i++) {
    const buy = i % 2 === 0;
    const tx = `0xs${i}`;
    const fee = { buy, exactInput: true, gross: "1000000000000000000", project: "20000000000000000", platform: "3000000000000000", pips: i === 5 ? "30000" : "20000" };
    if (buy) await chain(10 + i, 0, t(2 + i), tx, "FeeTaken", fee);
    await chain(10 + i, 1, t(2 + i), tx, "Swap", { amount0: buy ? "-1000000000000000000" : "1000000000000000000", amount1: buy ? "5" : "-5", tick: String(i * 10) });
    if (!buy) await chain(10 + i, 2, t(2 + i), tx, "FeeTaken", fee);
  }
  await chain(30, 0, t(12), "0xp1", "StatusChanged", { module: SPLIT, from: 3, to: 4 }); // split promotion: no fee epoch
  await chain(31, 0, t(13), "0xp2", "StatusChanged", { module: MOD, from: 3, to: 4 });
  const s = await observe.observeHandler.run(job()) as Awaited<ReturnType<typeof observe.observeNow>>;
  assert.deepEqual([s.swaps, s.feeSwaps, s.buys, s.sells, s.volumeEth, s.projectEth], [6, 6, 3, 3, 6, 0.12]);
  assert.equal(s.atCapShare, 0.1667); // one swap at the 3% cap
  assert.equal((await records.latest<{ feeSwaps: number }>("observe"))!.feeSwaps, 6);
  assert.match(String(await observe.observeHandler.run(job())), /block 99 already observed/); // one record (feed line) per finalized block
  const epochs = await sql<{ doc: { n: number; block: number; changed: string } }[]>`select doc from log where kind = 'epoch' order by seq`;
  assert.deepEqual(epochs.map((e) => [e.doc.n, e.doc.block]), [[0, 1], [1, 31]]);
  assert.match(epochs[1].doc.changed, /promoted fee module 0x0000…00a1/);
});

test("journal: numbers from SQL, Main text kept only if constrained, no X post (state changes only), once per day", { skip }, async () => {
  await loop.journalHandler.run(job({ day: DAY }));
  const j = (await records.latest<{ stats: { label: string; value: string }[]; summary: string; autonomy: string }>("journal", DAY))!;
  assert.deepEqual(j.stats.slice(0, 2), [{ label: "swaps", value: "6" }, { label: "project fees", value: "0.12 ETH" }]);
  assert.equal(j.autonomy, "5 → 5");
  assert.ok(j.summary.length > 0);
  assert.equal((await sql`select count(*)::int as n from draft where kind = 'x_post'`)[0].n, 0); // no daily status post
  // DAY is before this engine's first record (day < 1): no reflection goes to X
  assert.equal((await sql`select count(*)::int as n from x_outbox where event_key like 'reflection:%'`)[0].n, 0);
  assert.equal(await loop.journalHandler.run(job({ day: DAY })), "already written");
});

test("scheduler at 15 min: one cycle job per period; a queued or running cycle coalesces the next period", { skip }, async () => {
  const jobs = await import("../src/jobs.ts");
  const s = [{ kind: "cycle", everyMs: 15 * 60_000 }];
  const t0 = Date.UTC(2026, 9, 7, 10, 0, 0);
  const n = async () => (await sql<{ n: number }[]>`select count(*)::int as n from job where kind = 'cycle'`)[0].n;
  await jobs.schedule(s, t0 + 1000);
  await jobs.schedule(s, t0 + 14 * 60_000);
  assert.equal(await n(), 1);
  await jobs.schedule(s, t0 + 15 * 60_000); // the 10:00 cycle has not run yet: no backlog
  assert.equal(await n(), 1);
  await sql`update job set status = 'done' where kind = 'cycle'`;
  await jobs.schedule(s, t0 + 15 * 60_000 + 1);
  await jobs.schedule(s, t0 + 29 * 60_000);
  assert.equal(await n(), 2);
  assert.deepEqual((await sql<{ k: string }[]>`select dedupe_key as k from job where kind = 'cycle' order by id`).map((r) => r.k), ["cycle:2026-10-07T10:00:00.000Z", "cycle:2026-10-07T10:15:00.000Z"]);
  await sql`delete from job where kind = 'cycle'`;
});

test("pulse: an hourly 'today so far' journal record (ref pulse), numbers only, newest wins", { skip }, async () => {
  const llm0 = (await sql<{ n: number }[]>`select count(*)::int as n from llm_call`)[0].n;
  await loop.setLoop({ cycle: 41, day: new Date().toISOString().slice(0, 10), cyclesToday: 7, threadCycles: 0, seen: [] });
  const out = await loop.pulseHandler.run(job()) as { cycles: number };
  assert.equal(out.cycles, 7);
  const p = (await records.latest<{ pulse: boolean; summary: string; stats: { label: string; value: string }[] }>("journal", "pulse"))!;
  assert.equal(p.pulse, true);
  assert.match(p.summary, /^Today so far \(\d\d:00 UTC\): 7 cycles, /);
  assert.deepEqual(p.stats[0], { label: "cycles", value: "7" });
  assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from llm_call`)[0].n, llm0, "no model call");
});

test("gate red team: an LLM-cap Defer leaves run.fable unset, one step a day, and never fails the tick", { skip }, async () => {
  const jobs = await import("../src/jobs.ts");
  const r = { id: "T-0077", stage: "shadow", fable: undefined } as unknown as Parameters<typeof loop.gateRedTeam>[0];
  const capped = async () => { throw new jobs.Defer(3600_000, "LLM cap: redteam LLM cap $40 (spent $40.00)"); };
  assert.equal(await loop.gateRedTeam(r, "canary", capped), undefined);
  assert.equal(await loop.gateRedTeam(r, "canary", capped), undefined); // the next tick, same day: no second step
  const steps = await sql<{ doc: { kind: string; text: string } }[]>`select doc from log where kind = 'step' and ref = 'T-0077'`;
  assert.equal(steps.length, 1);
  assert.match(steps[0].doc.text, /^Gate red team deferred: LLM cap: redteam LLM cap \$40/);
  assert.equal(r.fable, undefined);
  assert.equal(await loop.gateRedTeam(r, "canary", async () => true), true); // budget back: the retry runs
  await assert.rejects(loop.gateRedTeam(r, "canary", async () => { throw new Error("anthropic 500"); }), /anthropic 500/); // other errors: the job retries
});

test("search cycle without a free plate still counts on the open thread and closes it when due", { skip }, async () => {
  const word = (x: number) => `0x${x.toString(16).padStart(64, "0")}`;
  const block = { number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"00".repeat(32)}`, timestamp: "0x6700a000", baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], miner: `0x${"00".repeat(20)}`, difficulty: "0x0", extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, size: "0x0", stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, uncles: [], totalDifficulty: "0x0", mixHash: `0x${"00".repeat(32)}` };
  Object.assign(fakes.rpc, { eth_call: () => word(3600), eth_getBlockByNumber: () => block }); // MIN_DELAY / PARAMS_EPOCH 1 h; no plates registered
  const { LOOP } = await import("../src/config.ts");
  await loop.setLoop({ cycle: 50, threadCycles: LOOP.searchCycles - 1, thread: "T-0901", seen: [], last: { title: "Search T-0901", hypothesis: "h", vector: [20_000, 0, 23_000], plate: "A", why: "gates failed", revenueDeltaPct: 1 } });
  await records.record("thread", "T-0901", { id: "T-0901", title: "Search T-0901", status: "open" });
  assert.equal(await loop.cycleHandler.run(job()), "no free AdaptiveFee plate");
  const steps = await sql<{ doc: { agent: string; text: string } }[]>`select doc from log where kind = 'step' and ref = 'T-0901' order by seq`;
  assert.match(steps[0].doc.text, /^Cycle 51 · .* No free AdaptiveFee plate this cycle/);
  assert.match(steps.at(-1)!.doc.text, /^Closed this search after \d+ cycles: memory entry #\d+/);
  assert.equal((await records.latest<{ status: string }>("thread", "T-0901"))!.status, "decided");
  const st = await loop.getLoop();
  assert.deepEqual([st.thread, st.threadCycles], [undefined, 0]);
});

test("genesis (pre-launch): research + analytic only, labelled, cites the pools, written once", { skip }, async () => {
  const out = await loop.genesisHandler.run(job()) as { entries: number };
  assert.ok(out.entries >= 1);
  const th = (await records.latest<{ status: string; title: string; genesis: boolean }>("thread", "G-0000"))!;
  assert.deepEqual([th.status, th.genesis], ["decided", true]);
  assert.match(th.title, /^Genesis, pre-launch/);
  const mem = await sql<{ doc: { title: string; refs: { label: string; ref: string }[] } }[]>`select doc from log where kind = 'memory' and doc->>'genesis' = 'true'`;
  assert.equal(mem.length, out.entries);
  assert.ok(mem.every((m) => m.doc.title.startsWith("Genesis, pre-launch: ") && m.doc.refs.some((r) => r.label === "pool")));
  const steps = await sql<{ doc: { agent: string; text: string; ref?: string } }[]>`select doc from log where kind = 'step' and ref = 'G-0000' order by seq`;
  assert.ok(steps.some((s) => s.doc.agent === "Simulation" && /Analytic only/.test(s.doc.text)));
  assert.ok(steps.filter((s) => s.doc.ref?.startsWith("pool 0x")).length >= 1);
  assert.equal((await records.latest<{ day: number; autonomy: string }>("journal", "genesis"))!.day, 0);
  assert.equal((await sql`select 1 from log where kind = 'research' and ref = 'genesis' and doc->>'tainted' = 'true'`).length, 1);
  assert.equal(await loop.genesisHandler.run(job()), "genesis already written");
  // ENGINE_PRELAUNCH cycles at the launch cadence: an analytic sweep step + a fresh core task, no model call
  const llmBefore = (await sql<{ n: number }[]>`select count(*)::int as n from llm_call`)[0].n;
  const c1 = await loop.prelaunchCycleHandler.run(job()) as { cycle: number; feePips: number };
  const c2 = await loop.prelaunchCycleHandler.run(job()) as { cycle: number; feePips: number };
  assert.deepEqual([c2.cycle - c1.cycle, c2.feePips - c1.feePips], [1, 2_500]);
  const last = await sql<{ doc: { text: string } }[]>`select doc from log where kind = 'step' and ref = 'G-0000' order by seq desc limit 1`;
  assert.match(last[0].doc.text, new RegExp(`^Pre-launch cycle ${c2.cycle} \\(analytic only`));
  assert.match((await records.latest<{ task: string }>("core"))!.task, new RegExp(`^pre-launch cycle ${c2.cycle}: analytic fee sweep`));
  assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from llm_call`)[0].n, llmBefore);
  // every model answer used here came from a committed fixture (replay) unless re-recording
  if (!process.env.RECORD_FIXTURES) assert.ok((await sql<{ mode: string }[]>`select distinct mode from llm_call`).every((r) => r.mode === "replay"));
});
