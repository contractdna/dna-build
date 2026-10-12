// Takes on crypto Twitter (src/ct.ts) against Postgres and the local fakes: a due slot scouts once and records its
// verdict; a quiet scout posts nothing; a take runs through x:send's filters and the judge (refused drafts recorded with
// their reasons); a flat take and a stale one are dropped, never digested.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import postgres from "postgres";
import { startFakes } from "../scripts/fakes.ts";
import { synthetic } from "../scripts/synthetic.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
const dbName = `dna_ct_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;

if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc`, ENGINE_MODE: "live",
    TELEGRAM_API_BASE: fakes.url, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_ID: "-100", TELEGRAM_ALLOWED_USER_IDS: "7", TELEGRAM_POLL_TIMEOUT_S: "1",
    XAI_API_BASE: fakes.url, OPENROUTER_API_BASE: fakes.url, XAI_API_KEY: "k", OPENROUTER_API_KEY_ENGINE: "k", LLM_MODE: "record", LLM_FIXTURES: `${mkdtempSync(join(tmpdir(), "dna-llm-"))}/`,
    X_API_BASE: fakes.url, X_CLIENT_ID: "cid", X_REFRESH_TOKEN: "seed", X_USER_ID: "42", SECRET_SEAL_KEY: "11".repeat(32),
  });
}
// imported only after the env is set (config is read at import)
const { edb: sql, migrate } = await import("../src/db.ts");
const modeM = await import("../src/mode.ts");
const xM = await import("../src/x.ts");
const ct = await import("../src/ct.ts");
const { writerSystem } = await import("../src/voice.ts");
const { latest } = await import("../src/records.ts");

before(async () => {
  if (!ADMIN) return;
  await migrate();
  await modeM.initMode();
  await sql`update engine_flags set override = null`;
});
after(async () => {
  mock.timers.reset();
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await fakes.close();
});

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const job = () => ({ id: "0", kind: "x:ct", payload: {}, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null }) as never;
const scoutOf = (b: Json) => String(b.instructions ?? "").startsWith("agent: x-ct-scout");
const xaiText = (b: Json, data: unknown) => ({ model: b.model, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(data) }] }], usage: { input_tokens: 100, output_tokens: 50 } });
const judgeOf = (b: Json) => JSON.stringify(b.system ?? "").includes("agent: x-judge");
/** The user message of an Anthropic Messages body (a string or text blocks). */
const userText = (b: Json): string => { const c = b.messages.findLast((m: Json) => m.role === "user").content; return Array.isArray(c) ? c.find((p: Json) => p.type === "text").text : c; };
const posts = () => fakes.calls.filter((c) => c.path === "/2/tweets" && c.method === "POST");
/** Runs x:ct as if the clock read `at` (the database keeps its own clock). */
const runAt = async (at: number) => {
  mock.timers.enable({ apis: ["Date"], now: at });
  try { return await ct.ctHandler.run(job()); } finally { mock.timers.reset(); }
};

test("x:ct: no watch list, no scout", { skip }, async () => {
  ct.WATCH.handles = [];
  ct.WATCH.searches = [];
  assert.equal(await ct.ctHandler.run(job()), "no watch list: no CT scout");
});

test("x:ct: a quiet slot posts nothing and says why; a slot is taken once; a take goes through every filter and the judge", { skip }, async () => {
  ct.WATCH.handles = ["tone1"];
  ct.WATCH.searches = ["uniswap v4 hook", "$DNA"];
  const day = ct.planDay(Date.now());
  const seed = await ct.seedOf(day);
  const slots = ct.ctSlots(seed.hash, day);
  const scouts = () => fakes.calls.filter((c) => c.path === "/v1/responses" && scoutOf(c.body)).length;

  // slot 0: the scout finds nothing worth a take
  fakes.llm.xai = (b) => (scoutOf(b) ? xaiText(b, { topics: [{ line: "the usual price talk", about: "ct", heat: 2 }], worth: 1, big: false }) : synthetic("xai", b));
  const n0 = scouts();
  assert.equal(await runAt(slots[0].at + 60_000), `ct:${day}:0: quiet: worth 1 under ${ct.CT.bar}`);
  assert.equal(scouts(), n0 + 1);
  const q = await latest<Json>("tone", `ct:${day}:0`);
  assert.equal(q.status, "skipped");
  assert.deepEqual(q.seed, seed, "the record names the seed its times came from");
  assert.equal((await sql`select 1 from x_outbox where event_key = ${`ct:${day}:0`}`).length, 0, "nothing queued");
  assert.equal(await runAt(slots[0].at + 120_000), "no slot due", "taken once");
  assert.equal(scouts(), n0 + 1, "no second scout for the slot");

  // slot 1: something worth a take; the scout searches all of X (no handle restriction) with the watch list as input
  fakes.llm.xai = (b) => synthetic("xai", b);
  fakes.llm.anthropic = (b) => synthetic("anthropic", b);
  assert.deepEqual(await runAt(slots[1].at + 60_000), { [`ct:${day}:1`]: "queued", topics: 2 });
  const req = fakes.calls.findLast((c) => c.path === "/v1/responses" && scoutOf(c.body))!.body;
  assert.deepEqual(req.tools, [{ type: "x_search", from_date: new Date(slots[1].at + 60_000 - 6 * 3600_000).toISOString().slice(0, 10) }]);
  assert.equal(req.max_turns, 1);
  const rec = await latest<Json>("tone", `ct:${day}:1`);
  assert.equal(rec.status, "queued");
  assert.equal(rec.dropped, 1, "the topic with a link was screened out");
  assert.ok(rec.topics.every((t: Json) => !/example\.com/.test(t.line)));

  // x:send: the take is written, filtered (the writer's "999 swaps" draft refused), judged, posted text-only, no link
  const before = posts().length;
  const sent = await xM.sendHandler.run(job());
  assert.ok((sent as { tweetId?: string }).tweetId, JSON.stringify(sent));
  assert.equal(posts().length, before + 1);
  const [a] = await sql<{ doc: Json }[]>`select doc from log where kind = 'x_post' and ref = ${`ct:${day}:1`} and doc->>'status' = 'attempt'`;
  assert.ok(a.doc.candidates.some((c: Json) => c.issues?.includes("number 999")), "the filters ran on the take's drafts");
  assert.ok(a.doc.judge, "the judge scored it");
  assert.equal(a.doc.media?.kind, "none", "text only");
  assert.ok(!/https?:/.test(a.doc.text), "no link appended");
  assert.equal(a.doc.promptHash, createHash("sha256").update(writerSystem(a.doc.facts)).digest("hex"), "the record names the take's writer prompt");
  const writer = fakes.calls.findLast((c) => JSON.stringify(c.body).includes("agent: x-writer"))!;
  assert.ok(JSON.stringify(writer.body).includes("Takes on crypto Twitter"), "the writer got the take task");
  assert.equal((await sql`select 1 from log where kind = 'announce' and ref = ${`ct:${day}:1`}`).length, 0, "a take is no announcement");

  // slot 2: the take just went out (on the DB's clock), so the slot is inside the gap; slot 3: a take still queued
  const n2 = scouts();
  assert.equal(await runAt(slots[2].at + 60_000), `ct:${day}:2: the last take went out less than ${ct.CT.gapMin} min ago`);
  await xM.enqueueX(`ct:${day}:q`, "post", { event: "ct", topics: [], uniswapVersion: 4, stage: ct.CT_STAGE });
  assert.equal(await runAt(slots[3].at + 60_000), `ct:${day}:3: a take is still queued`);
  assert.equal(scouts(), n2, "no scout for either");
  assert.equal((await latest<Json>("tone", `ct:${day}:3`)).status, "skipped");
  await sql`delete from x_outbox where event_key = ${`ct:${day}:q`}`;
});

test("x:ct: a flat take is dropped (never digested); a take waiting past its hour is dropped too", { skip }, async () => {
  await sql`delete from x_outbox where event->>'event' = 'ct'`;
  const key = "ct:2000-01-01:2";
  await xM.enqueueX(key, "post", { event: "ct", topics: [{ line: "people argue whether hooks need receipts", about: "hooks" }], uniswapVersion: 4, stage: ct.CT_STAGE });
  fakes.llm.xai = (b) => synthetic("xai", b);
  // the judge finds every draft clear but flat
  fakes.llm.anthropic = (b) => {
    if (!judgeOf(b)) return synthetic("anthropic", b);
    const scores = (JSON.parse(userText(b)).candidates as unknown[]).map(() => ({ hook: 3, alive: 2, wit: 2, clarity: 4, freshness: 3 }));
    return { model: b.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ scores, best: 0 }) }], usage: { input_tokens: 100, output_tokens: 50 } };
  };
  await sql`update x_outbox set created_at = now() where event_key = ${key}`;
  // the spacing after the last test's post: posts may go any time here
  const { X } = await import("../src/config.ts");
  const spacing = X.spacingMs;
  X.spacingMs = 0;
  try {
    assert.equal(await xM.sendHandler.run(job()), "miss");
  } finally { X.spacingMs = spacing; }
  const [o] = await sql<{ status: string; error: string }[]>`select status, error from x_outbox where event_key = ${key}`;
  assert.equal(o.status, "skipped");
  assert.match(o.error, /^flat take: alive 2, wit 2/);
  const [m] = await sql<{ doc: Json }[]>`select doc from log where kind = 'x_post' and ref = ${key} order by seq desc limit 1`;
  assert.equal(m.doc.status, "miss");

  // stale: queued over CT.staleMin ago → dropped by the next x:ct run, never rolled into the digest
  const old = "ct:2000-01-01:3";
  await xM.enqueueX(old, "post", { event: "ct", topics: [], uniswapVersion: 4, stage: ct.CT_STAGE });
  await sql`update x_outbox set created_at = now() - interval '2 hours' where event_key = ${old}`;
  await ct.ctHandler.run(job());
  assert.deepEqual((await sql<{ status: string; error: string }[]>`select status, error from x_outbox where event_key = ${old}`)[0], { status: "skipped", error: "stale take" });
});
