// Schema limits in the prompt, one retry on an over-limit answer (same caps and books, never a truncation), and the
// pre-call estimate of a search call. The provider is a local server and calls are booked in memory: no keys, no database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { z } from "zod";
import { HypothesisOut, ResearchOut } from "../src/agents.ts";
import { BrainOut, brainCall } from "../src/brain.ts";
import { LLM } from "../src/config.ts";
import { CALL_TROUBLE, type CallRow, estimateUsd, HELD, FALLBACK, limitsText, llm, LLM_WAIT_MS, OUTAGE, request, systemText, TROUBLE, useLedger, waitOf } from "../src/llm.ts";
import { Defer, type Handler } from "../src/jobs.ts";
import { HALTED_WAIT_MS, MODEL_JOBS, waitWhenHalted } from "../src/mode.ts";

test("limits: every bound the provider schema drops is stated in the system prompt of every route", () => {
  const build = limitsText(BrainOut.build);
  assert.match(build, /reason: at most 400 characters; risks: at most 5 items; risks\[\]: at most 200 characters/);
  assert.match(limitsText(BrainOut.outcome), /ideas\[\]\.reason: at most 200 characters; ideas\[\]\.title: at most 120 characters; ideas\[\]\.rubric\.value: 0 to 5/);
  assert.match(limitsText(ResearchOut), /summary: at most 600 characters; findings: at most 6 items; findings\[\]\.claim: at most 300 characters/);
  for (const f of ["hypothesis", "evidenceFor", "evidenceAgainst"]) assert.match(limitsText(HypothesisOut), new RegExp(`\\b${f}: at most 300 characters`));
  assert.match(limitsText(HypothesisOut), /next\[\]: at most 120 characters/);
  assert.doesNotMatch(limitsText(HypothesisOut), /params|9007199254740991/, "integers' default safe bounds are no limit");
  assert.equal(limitsText(z.object({ a: z.string() })), "");

  const schema = {};
  // the brain: its cached prompt block stays byte-identical across kinds, the limits follow in a second block
  const b = request(brainCall("build", {}), schema, "{}").body as { system: { text: string; cache_control?: unknown }[] };
  assert.equal(b.system.length, 2);
  assert.ok(b.system[0].cache_control && !b.system[1].cache_control);
  assert.equal(b.system[0].text, brainCall("outcome", {}).system);
  assert.equal(b.system[1].text, build);
  // Grok via OpenRouter (the fallback: system message) and xAI direct (instructions), with or without search
  const call = { agent: "research", model: "grok-4.7", system: "S", input: {}, schema: ResearchOut };
  assert.equal((request(call, schema, "{}", undefined, "openrouter").body.messages as { content: string }[])[0].content, `S\n\n${limitsText(ResearchOut)}`);
  assert.equal(request(call, schema, "{}").body.instructions, `S\n\n${limitsText(ResearchOut)}`);
  assert.equal(request({ ...call, tools: [{ type: "web_search" }] }, schema, "{}").body.instructions, `S\n\n${limitsText(ResearchOut)}`);
});

const rows: CallRow[] = [];
const alerts: string[] = [];
let refuseAfter = Infinity; // the ledger refuses once this many calls are booked
let halted = false;
useLedger({ spend: async () => ({ total: 0, by: {} }), record: async (r) => rows.push(r), alert: async (t) => alerts.push(t), refuse: () => (rows.length >= refuseAfter ? "trial budget" : null), halted: async () => halted });
LLM.openrouterKey = LLM.xaiKey = "test-key";
const sent: { url: string; body: Record<string, unknown> }[] = [];
let replies: Record<string, unknown>[] = [];
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  sent.push({ url: req.url ?? "", body: JSON.parse(body) });
  const r = replies.shift() as { __status?: number; __headers?: Record<string, string>; __drop?: boolean } | undefined;
  if (r?.__drop) return void res.socket?.destroy();
  if (r?.__status) res.writeHead(r.__status, r.__headers ?? {});
  res.end(JSON.stringify(r));
}).listen(0, "127.0.0.1");
await once(provider, "listening");
LLM.openrouterApi = LLM.xaiApi = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
after(() => { provider.close(); provider.closeAllConnections(); });
const reset = (...r: Record<string, unknown>[]) => { rows.length = 0; sent.length = 0; alerts.length = 0; replies = r; refuseAfter = Infinity; halted = false; };
// replies as each route returns them
const claude = (data: unknown) => ({ model: "anthropic/claude-fable-5.1", provider: "Anthropic", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(data) }], usage: { input_tokens: 1000, output_tokens: 100 } });
const grokChat = (data: unknown) => ({ model: "x-ai/grok-4.7", provider: "xAI", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
const grokSearch = (data: unknown) => ({ model: "grok-4.7", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(data) }] }], usage: { input_tokens: 1000, output_tokens: 100, cost_in_usd_ticks: 5e9 } });

const long = "x".repeat(512);
const tooLong = { decision: "no-build", reason: long, risks: ["a", "b", "c", "d", "e", "f"] };
const fits = { decision: "no-build", reason: "Upgradeable proxy with an agent-key admin is forbidden.", risks: ["upgradeability"] };

test("retry: an over-limit answer is asked for once more with that answer and the limits it broke; both calls are booked", async () => {
  reset(claude(tooLong), claude(fits));
  const r = await llm(brainCall("build", { spec: "s" }));
  assert.deepEqual(r.data, fits, "the second answer as given, nothing cut");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => [x.agent, x.budget, x.ok]), [["brain", "rest", false], ["brain", "rest", true]]);
  // the recorded prompt hash is the system text as sent: the prompt and the schema's limits
  const sysText = systemText(brainCall("build", {}));
  assert.equal(sysText, `${brainCall("build", {}).system}\n\n${limitsText(BrainOut.build)}`);
  for (const row of rows) assert.equal(row.promptHash, createHash("sha256").update(sysText).digest("hex"));
  assert.equal(Number(r.costUsd.toFixed(6)), Number((rows[0].costUsd + rows[1].costUsd).toFixed(6)), "the decision carries both calls' cost");
  const msgs = sent[1].body.messages as { role: string; content: string }[];
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(msgs[0].content, (sent[0].body.messages as { content: string }[])[0].content, "the same question");
  assert.equal(msgs[1].content, JSON.stringify(tooLong));
  assert.match(msgs[2].content, /- reason: 512 characters, the limit is 400 characters\n- risks: 6 items, the limit is 5 items/);
});

test("retry: a second overrun is rejected, not truncated; other invalid answers are not retried", async () => {
  reset(claude(tooLong), claude(tooLong));
  await assert.rejects(llm(brainCall("build", {})), /brain output rejected: .*too_big/s);
  assert.equal(rows.length, 2);
  reset(claude({ decision: "maybe", reason: "r", risks: [] }));
  await assert.rejects(llm(brainCall("build", {})), /brain output rejected/);
  assert.equal(rows.length, 1);
  // the retry passes the caps like any call: refused, it defers and nothing more is sent
  reset(claude(tooLong));
  refuseAfter = 1;
  await assert.rejects(llm(brainCall("build", {})), (e) => e instanceof Defer && /trial budget/.test(e.message));
  assert.equal(sent.length, 1);
});

test("retry: a search call is retried without its tools (the first answer holds what they found)", async () => {
  const over = { summary: "s".repeat(700), findings: [{ claim: "c".repeat(350), source: "a source" }] };
  const ok = { summary: "short", findings: [{ claim: "a claim", source: "a source" }] };
  reset(grokSearch(over), grokSearch(ok));
  const r = await llm({ agent: "research", model: "grok-4.7", system: "agent: research", input: { q: 1 }, schema: ResearchOut, tools: [{ type: "web_search" }, { type: "x_search" }], maxTurns: 2, maxOutputTokens: 3000 });
  assert.deepEqual(r.data, ok);
  assert.deepEqual(rows.map((x) => [x.via, x.budget]), [["xai", "research"], ["xai", "research"]]);
  assert.equal(sent[1].body.tools, undefined);
  assert.match((sent[1].body.input as { content: string }[]).at(-1)!.content, /- summary: 700 characters, the limit is 600 characters\n- findings\[0\]\.claim: 350 characters/);
});

test("estimate: a search call reserves every pass's re-read context and output, enough for the live research call", () => {
  // the live research call: 2 turns of web and X search, 294,675 input and 8,265 output tokens, $0.751
  const research = { agent: "research", model: "grok-4.7", system: "x".repeat(400), input: {}, schema: ResearchOut, tools: [{ type: "web_search" as const }, { type: "x_search" as const }], maxTurns: 2, maxOutputTokens: 3000 };
  const est = estimateUsd(research, "y".repeat(300));
  assert.ok(est >= 0.751, `estimate $${est.toFixed(3)} below the live call's cost`);
  assert.ok(est < 0.751 * 5, "and below the alert's 5x");
  // 3 passes: 3x the prompt, 120K + 240K search tokens at the long-prompt card ($4 in, $12 out), 3x 3000 output, 2 tool turns
  assert.equal(Number(est.toFixed(6)), Number((((700 / 3) * 3 + 360_000) * 4 / 1e6 + 9000 * 12 / 1e6 + 2 * 0.05).toFixed(6)));
  // without tools nothing changes: one pass
  const plain = { ...research, tools: undefined };
  assert.equal(Number(estimateUsd(plain, "y".repeat(300)).toFixed(6)), Number(((700 / 3) * 2 / 1e6 + 3000 * 6 / 1e6).toFixed(6)));
});

test("halted: no model call is sent or booked (dry_run calls as before); a halted model job waits without running", async () => {
  const search = { agent: "x-scout", model: "grok-4.7", system: "agent: x-scout", input: {}, schema: ResearchOut, tools: [{ type: "x_search" as const }], maxTurns: 1 };
  reset(grokSearch({ summary: "s", findings: [] }));
  halted = true;
  await assert.rejects(llm(search), (e) => e instanceof Defer && e.ms === LLM_WAIT_MS.halted && /engine halted: x-scout/.test(e.message));
  await assert.rejects(llm(brainCall("build", {})), (e) => e instanceof Defer && /engine halted: brain/.test(e.message));
  assert.equal(sent.length, 0);
  assert.equal(rows.length, 0);
  halted = false; // dry_run / live
  assert.deepEqual((await llm(search)).data, { summary: "s", findings: [] });
  assert.equal(sent.length, 1);

  // the job layer: the cycle, the journal and the scout (every MODEL_JOBS kind) wait while halted; others run
  for (const k of ["x:scout", "cycle", "journal", "genesis", "x:mentions", "x:replies", "voice:audit", "ideas:rounds"]) assert.ok(MODEL_JOBS.includes(k), k);
  const ran: string[] = [];
  const h = (kind: string): Handler => ({ lane: "x", run: async () => ran.push(kind) });
  let m = "halted";
  const wrapped = waitWhenHalted({ "x:scout": h("x:scout"), cycle: h("cycle"), "keeper:distribute": h("keeper:distribute") }, async () => m === "halted");
  const j = { id: "1", kind: "x:scout", payload: {}, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null };
  await assert.rejects(wrapped["x:scout"].run(j), (e) => e instanceof Defer && e.ms === HALTED_WAIT_MS && /engine halted: x:scout waits/.test(e.message));
  await assert.rejects(wrapped.cycle.run(j), Defer);
  await wrapped["keeper:distribute"].run(j); // not a model job: unchanged (keepers judge halted themselves)
  assert.deepEqual(ran, ["keeper:distribute"]);
  m = "dry_run";
  await wrapped["x:scout"].run(j);
  await wrapped.cycle.run(j);
  assert.deepEqual(ran, ["keeper:distribute", "x:scout", "cycle"]);
  assert.equal(wrapped.cycle.lane, "x");
});

test("an unset or empty provider key: the call is skipped with a note, never sent with an empty bearer", async () => {
  const search = { agent: "x-scout", model: "grok-4.7", system: "agent: x-scout", input: {}, schema: ResearchOut, tools: [{ type: "x_search" as const }], maxTurns: 1 };
  try {
    reset(grokSearch({ summary: "s", findings: [] }));
    LLM.xaiKey = ""; // the real CVM: an empty sealed value sent "Bearer " and got a 400
    await assert.rejects(llm(search), (e) => e instanceof Defer && e.ms === LLM_WAIT_MS.noKey && /XAI_API_KEY unset: x-scout call skipped/.test(e.message));
    LLM.openrouterKey = undefined;
    await assert.rejects(llm(brainCall("build", {})), (e) => e instanceof Defer && /OPENROUTER_API_KEY_ENGINE unset/.test(e.message));
    assert.equal(sent.length, 0, "nothing reached the provider");
    assert.equal(rows.length, 0);
    assert.equal(alerts.length, 2);
    assert.match(alerts[0], /XAI_API_KEY is not set, so x-scout calls are skipped/);
    assert.ok(alerts.every((a) => !a.includes("test-key")));
  } finally {
    LLM.openrouterKey = LLM.xaiKey = "test-key";
  }
});

test("provider trouble: a 429 or 5xx is a wait honoring Retry-After, never an error; an outage alerts once it lasts", async () => {
  assert.equal(waitOf("120", 1), 120_000);
  assert.equal(waitOf(new Date(Date.now() + 60_000).toUTCString(), 1) > 50_000, true, "an HTTP date");
  assert.deepEqual([waitOf(null, 1), waitOf(null, 2), waitOf(null, 3), waitOf(null, 20), waitOf("0", 1), waitOf("99999", 1)], [30_000, 60_000, 120_000, 900_000, 10_000, 900_000]);
  const slow = { __status: 429, __headers: { "retry-after": "120" }, error: { message: "new accounts are limited to 20 requests per minute" } };
  reset(slow);
  await assert.rejects(llm(brainCall("build", {})), (e) => e instanceof Defer && e.ms === 120_000 && /openrouter 429: brain call waits/.test(e.message));
  assert.equal(rows.length, 0, "nothing booked");
  assert.equal(alerts.length, 0, "one 429 is no outage");
  // 5 in a row: one alert (deduped per outage), then a good answer resets the count
  TROUBLE.openrouter.count = 0;
  CALL_TROUBLE.clear();
  reset(...Array.from({ length: OUTAGE.calls }, () => ({ __status: 503 })), claude(fits));
  for (let i = 0; i < OUTAGE.calls; i++) await assert.rejects(llm(brainCall("build", {})), (e) => e instanceof Defer);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /openrouter has failed 5 calls in a row.*Calls wait and retry; an X call past 5 waits fails/);
  assert.equal((await llm(brainCall("build", {}))).data.decision, "no-build");
  assert.equal(TROUBLE.openrouter.count, 0);
  // an X call past OUTAGE.calls waits is an error (the job spends an attempt): never an endless wait; the brain keeps waiting
  TROUBLE.openrouter.count = 0;
  const xCall = { ...brainCall("build", {}), agent: "x-judge" };
  reset(...Array.from({ length: OUTAGE.calls + 1 }, () => ({ __status: 503 })));
  for (let i = 0; i < OUTAGE.calls; i++) await assert.rejects(llm(xCall), (e) => e instanceof Defer);
  await assert.rejects(llm(xCall), (e) => !(e instanceof Defer) && /x-judge call failed after 5 waits/.test((e as Error).message));
  assert.equal(CALL_TROUBLE.size, 0, "the count starts again");
  reset(...Array.from({ length: OUTAGE.calls + 1 }, () => ({ __status: 503 })));
  for (let i = 0; i <= OUTAGE.calls; i++) await assert.rejects(llm(brainCall("build", {})), (e) => e instanceof Defer);
  assert.equal(CALL_TROUBLE.size, 0, "the brain is not bounded");
  // a dropped connection may have been billed: booked at the estimate, then a wait
  TROUBLE.openrouter.count = 0;
  reset({ __drop: true });
  await assert.rejects(llm(brainCall("build", {})), (e) => e instanceof Defer && /unreachable/.test(e.message));
  assert.deepEqual(rows.map((r) => [r.ok, r.costUsd > 0, /booked at the estimate/.test(r.error ?? "")]), [[false, true, true]]);
  assert.equal(HELD.rest, 0, "the hold is released on a drop too");
  CALL_TROUBLE.clear();
  TROUBLE.openrouter.count = 0;
  // a 400 is our mistake, not the provider's: an error as before
  reset({ __status: 400, error: "bad request" });
  await assert.rejects(llm(brainCall("build", {})), (e) => !(e instanceof Defer) && /openrouter 400/.test((e as Error).message));
});

test("xAI down: grok waits through its backoff, then the same model goes through OpenRouter (the record names the route); a good xAI answer later resets it", async () => {
  const chat = { agent: "x-writer", model: "grok-4.7", system: "agent: x-writer", input: {}, schema: z.object({ a: z.number() }) };
  TROUBLE.xai.count = 0;
  reset(...Array.from({ length: FALLBACK.after }, () => ({ __status: 503 })), grokChat({ a: 1 }));
  for (let i = 0; i < FALLBACK.after; i++) await assert.rejects(llm(chat), (e) => e instanceof Defer && /xai 503/.test(e.message));
  assert.ok(sent.every((x) => x.url === "/v1/responses"), "xAI direct first, with store: false");
  assert.ok(sent.every((x) => x.body.store === false));
  assert.deepEqual((await llm(chat)).data, { a: 1 });
  assert.equal(sent.at(-1)!.url, "/v1/chat/completions");
  assert.deepEqual(rows.map((r) => [r.via, r.requestedModel, r.returnedModel]), [["openrouter", "grok-4.7", "grok-4.7"]]);
  // the window passes: xAI again, booked with its cost (ticks) like any call
  TROUBLE.xai.last = Date.now() - FALLBACK.ms;
  reset(grokSearch({ a: 2 }));
  assert.deepEqual((await llm(chat)).data, { a: 2 });
  assert.deepEqual(rows.map((r) => [r.via, r.provider, r.costUsd]), [["xai", "xAI", 0.5]]);
  assert.equal(TROUBLE.xai.count, 0);
  // no ticks: the tokens at the registry's price, and no search charge for a call that had no search tools
  reset({ model: "grok-4.7", output: [{ type: "message", content: [{ type: "output_text", text: '{"a":3}' }] }], usage: { input_tokens: 100_000, output_tokens: 0 } });
  await llm(chat);
  assert.equal(rows[0].costUsd, 0.2);
});

test("spend holds: concurrent calls count each other's estimate before either is booked; every call releases its hold", async () => {
  const est = estimateUsd(brainCall("build", {}), "{}");
  const saved = LLM.subCapsUsd.rest;
  LLM.subCapsUsd.rest = est * 1.5; // room for one call, not two
  try {
    reset(claude(fits), claude(fits));
    const r = await Promise.allSettled([llm(brainCall("build", {})), llm(brainCall("build", {}))]);
    assert.deepEqual(r.map((x) => x.status), ["fulfilled", "rejected"]);
    const why = (r[1] as PromiseRejectedResult).reason;
    assert.ok(why instanceof Defer && /rest LLM cap/.test(why.message), String(why));
    assert.equal(sent.length, 1, "the second never reached the provider");
    assert.equal(HELD.rest, 0);
    reset({ __status: 400, error: "bad request" });
    await assert.rejects(llm(brainCall("build", {})));
    assert.equal(HELD.rest, 0, "released on an error too");
  } finally { LLM.subCapsUsd.rest = saved; }
});

test("record mode: a call's secret input keys (the private bundle's shapes, bits, foils) reach a fixture only as sha256", async () => {
  const { mkdtempSync, readdirSync, readFileSync: read } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "fx-"));
  const saved = { mode: LLM.mode, fixtures: LLM.fixtures };
  const call = { agent: "x-writer", model: "grok-4.7", system: "S", schema: z.object({ a: z.number() }), secret: ["bits"],
    input: { facts: { event: "status" }, bits: [{ label: "x", premise: "a private premise that stays home" }] } };
  try {
    Object.assign(LLM, { mode: "record", fixtures: pathToFileURL(`${dir}/`) });
    TROUBLE.xai.count = 0;
    reset(grokSearch({ a: 1 }));
    assert.deepEqual((await llm(call)).data, { a: 1 });
    assert.ok(JSON.stringify(sent[0].body).includes("a private premise"), "the live request carries it");
    const stored = read(join(dir, readdirSync(dir)[0]), "utf8");
    assert.ok(!stored.includes("a private premise"));
    assert.match(stored, /bits\\":\\"sha256:[0-9a-f]{64}/);
    assert.ok(stored.includes("status"), "the rest of the input is kept");
  } finally { Object.assign(LLM, saved); }
});
