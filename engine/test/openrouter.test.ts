// Routing: Claude calls go through OpenRouter pinned to Anthropic; grok calls go to xAI direct (server-side search exists
// only there), falling back to OpenRouter pinned to xAI while xAI is down. Request shapes, reply parsing and cost from the synthetic
// fixtures (test/fixtures/openrouter/), provider and model checks, the registry's routing rules. No network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";

Object.assign(process.env, { OPENROUTER_API_KEY_ENGINE: "or-test", XAI_API_KEY: "xai-test" });
delete process.env.OPENROUTER_API_BASE;
delete process.env.XAI_API_BASE;
const { FALLBACK, parseOpenRouter, replyIssue, request, routeOf, TROUBLE } = await import("../src/llm.ts");
const { LLM } = await import("../src/config.ts");
const { BASE, parseRegistry, ROLES, slugOf } = await import("../src/models.ts");

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/openrouter/${f}`, import.meta.url), "utf8")).response;
const raw = JSON.parse(readFileSync(new URL("../models.json", import.meta.url), "utf8"));
const base = { agent: "redteam", system: "S", input: {}, schema: z.object({}) };
const schema = { type: "object", properties: {}, additionalProperties: false };

test("registry: X-search roles via xAI, every other role via OpenRouter; each OpenRouter model has a pinned slug", () => {
  const via = Object.fromEntries(ROLES.map((r) => [r, BASE.roles[r].via]));
  for (const r of ROLES) assert.equal(via[r], r === "research" || r === "x-scout" ? "xai" : "openrouter", r);
  assert.deepEqual(BASE.openrouter, {
    "claude-fable-5-1": "anthropic/claude-fable-5.1", "claude-opus-5-5": "anthropic/claude-opus-5.5", "claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
    "claude-haiku-5-5": "anthropic/claude-haiku-5.5", "grok-4.7": "x-ai/grok-4.7", "grok-4.3": "x-ai/grok-4.3",
  });
  assert.equal(slugOf("claude-opus-5-5"), "anthropic/claude-opus-5.5");
  assert.throws(() => slugOf("claude-unknown"), /no OpenRouter slug/);
  // an X-search role must run Grok; an OpenRouter role (model or backup) must have a slug
  const claudeSearch = structuredClone(raw);
  claudeSearch.roles["x-scout"].backup = "claude-opus-5-5";
  assert.throws(() => parseRegistry(claudeSearch), /x-scout.*xAI.*grok/);
  const noSlug = structuredClone(raw);
  delete noSlug.openrouter["claude-haiku-5-5"];
  assert.throws(() => parseRegistry(noSlug), /dev-worker.*claude-haiku-5-5.*no OpenRouter slug/);
  const badVia = structuredClone(raw);
  badVia.roles.brain.via = "anthropic";
  assert.throws(() => parseRegistry(badVia));
});

test("route: every grok call ⇒ xAI direct (search only exists there); Claude ⇒ OpenRouter; grok without search falls back to OpenRouter while xAI is down or keyless", () => {
  assert.equal(routeOf({}), "openrouter");
  assert.equal(routeOf({ model: "claude-opus-5-5" }), "openrouter");
  assert.equal(routeOf({ model: "grok-4.7" }), "xai");
  assert.equal(routeOf({ model: "grok-4.7", tools: [] }), "xai");
  assert.equal(routeOf({ tools: [{ type: "x_search" }] }), "xai");
  const now = Date.now();
  Object.assign(TROUBLE.xai, { count: FALLBACK.after, last: now });
  try {
    assert.equal(routeOf({ model: "grok-4.7" }, now), "openrouter", "xAI down: the same model through OpenRouter");
    assert.equal(routeOf({ model: "grok-4.7", tools: [{ type: "x_search" }] }, now), "xai", "search has no fallback");
    assert.equal(routeOf({ model: "grok-4.7" }, now + FALLBACK.ms), "xai", "tried again after the window");
  } finally { Object.assign(TROUBLE.xai, { count: 0, last: 0 }); }
  const k = LLM.xaiKey;
  LLM.xaiKey = undefined;
  try { assert.equal(routeOf({ model: "grok-4.7" }), "openrouter", "no xAI key: OpenRouter"); } finally { LLM.xaiKey = k; }
  const direct = request({ ...base, agent: "x-writer", model: "grok-4.7", effort: "low", temperature: 1 }, schema, "{}");
  assert.equal(direct.url, "https://api.x.ai/v1/responses");
  assert.deepEqual([direct.body.model, direct.body.store, direct.body.temperature, direct.body.provider], ["grok-4.7", false, 1, undefined]);
  const x = request({ ...base, agent: "x-scout", model: "grok-4.7", tools: [{ type: "x_search", allowed_x_handles: ["a"] }], maxTurns: 1 }, schema, "{}");
  assert.equal(x.url, "https://api.x.ai/v1/responses");
  assert.deepEqual(x.headers, { authorization: "Bearer xai-test" });
  assert.equal(x.body.model, "grok-4.7");
  assert.deepEqual(x.body.tools, [{ type: "x_search", allowed_x_handles: ["a"] }]);
  assert.equal(x.body.max_turns, 1);
  assert.equal(x.body.provider, undefined);
  assert.throws(() => request({ ...base, model: "claude-opus-5-5", tools: [{ type: "x_search" }] }, schema, "{}"), /search runs on xAI.*grok/);
});

test("OpenRouter, Claude: Messages endpoint, bearer key, pinned to Anthropic with no fallback, cache_control kept", () => {
  const r = request({ ...base, agent: "brain", model: "claude-fable-5-1", cache: true, effort: "high", maxOutputTokens: 8000 }, schema, "{}");
  assert.equal(r.url, "https://openrouter.ai/api/v1/messages");
  assert.deepEqual(r.headers, { authorization: "Bearer or-test", "anthropic-version": "2023-06-01", "x-openrouter-metadata": "enabled" });
  assert.equal(r.body.model, "anthropic/claude-fable-5.1");
  assert.deepEqual(r.body.provider, { order: ["anthropic"], allow_fallbacks: false });
  assert.deepEqual(r.body.system, [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(r.body.output_config, { format: { type: "json_schema", schema }, effort: "high" });
  assert.equal(r.body.max_tokens, 8000);
  const img = request({ ...base, model: "claude-opus-5-5", images: ["QUJD"] }, schema, "{}").body as { messages: { content: unknown }[] };
  assert.deepEqual(img.messages[0].content, [{ type: "text", text: "{}" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }]);
  // the studio's art is JPEG: the media type follows the bytes (a provider may refuse a mismatched one)
  const jpg = request({ ...base, model: "claude-opus-5-5", images: ["/9j/4AAQ"] }, schema, "{}").body as { messages: { content: { source?: { media_type: string } }[] }[] };
  assert.equal(jpg.messages[0].content[1].source?.media_type, "image/jpeg");
});

test("OpenRouter (grok's fallback route), Grok without search: chat endpoint, strict json_schema, pinned to xAI with no fallback", () => {
  const r = request({ ...base, agent: "x-writer", model: "grok-4.7", effort: "low", maxOutputTokens: 1500 }, schema, '{"a":1}', undefined, "openrouter");
  assert.equal(r.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.deepEqual(r.headers, { authorization: "Bearer or-test", "x-openrouter-metadata": "enabled" });
  assert.deepEqual(r.body, {
    model: "x-ai/grok-4.7", max_tokens: 1500,
    messages: [{ role: "system", content: "S" }, { role: "user", content: '{"a":1}' }],
    response_format: { type: "json_schema", json_schema: { name: "output", strict: true, schema } },
    reasoning: { effort: "low" },
    provider: { order: ["xai"], allow_fallbacks: false },
  });
  const img = request({ ...base, model: "grok-4.3", images: ["QUJD"] }, schema, "{}", undefined, "openrouter").body as { messages: { content: unknown }[]; max_tokens: number };
  assert.deepEqual(img.messages[1].content, [{ type: "text", text: "{}" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }]);
  const jpg = request({ ...base, model: "grok-4.3", images: ["/9j/4AAQ"] }, schema, "{}", undefined, "openrouter").body as { messages: { content: { image_url?: { url: string } }[] }[] };
  assert.equal(jpg.messages[1].content[1].image_url?.url, "data:image/jpeg;base64,/9j/4AAQ");
  assert.equal(img.max_tokens, 4000);
});

test("OpenRouter replies: text, our model id, the reported provider, the higher of OpenRouter's cost and the price table's", () => {
  const m = parseOpenRouter(fixture("messages.json"), "claude-fable-5-1");
  assert.deepEqual([m.text, m.model, m.provider, m.inTok, m.outTok, m.costUsd], ['{"verdict":"pass","reason":"synthetic"}', "claude-fable-5-1", "Anthropic", 101_000, 1000, 0.0851]);
  const c = parseOpenRouter(fixture("chat.json"), "grok-4.7");
  assert.deepEqual([c.text, c.model, c.provider, c.inTok, c.outTok, c.costUsd], ['{"verdict":"block","reason":"synthetic"}', "grok-4.7", "xAI", 1000, 200, 0.0027]);
  // no reported cost: the price table (Fable: 1000 in + 100K cache reads + 1000 out = $0.085; Grok 4.7: 600 in, 400 cached, 200 out)
  const strip = (r: Record<string, any>) => ({ ...r, usage: { ...r.usage, cost: undefined } }); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(Number(parseOpenRouter(strip(fixture("messages.json")), "claude-fable-5-1").costUsd.toFixed(6)), 0.085);
  assert.equal(Number(parseOpenRouter(strip(fixture("chat.json")), "grok-4.7").costUsd.toFixed(6)), 0.0026);
  // a reported cost below the price table's never lowers the count: the higher one is charged
  const low = (r: Record<string, any>) => ({ ...r, usage: { ...r.usage, cost: 0.0001 } }); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(Number(parseOpenRouter(low(fixture("messages.json")), "claude-fable-5-1").costUsd.toFixed(6)), 0.085);
  assert.equal(Number(parseOpenRouter(low(fixture("chat.json")), "grok-4.7").costUsd.toFixed(6)), 0.0026);
  // a top-level provider field counts too; a cut-off answer is no answer
  assert.equal(parseOpenRouter({ ...fixture("chat.json"), provider: "xAI", openrouter_metadata: undefined }, "grok-4.7").provider, "xAI");
  const cut = fixture("chat.json");
  cut.choices[0].finish_reason = "length";
  assert.deepEqual([parseOpenRouter(cut, "grok-4.7").text, parseOpenRouter(cut, "grok-4.7").refusal], [null, "finish_reason length"]);
});

test("OpenRouter replies are refused unless the model's own provider served the exact model", () => {
  const ok = (r: unknown, id: string) => replyIssue(parseOpenRouter(r as never, id), id);
  assert.equal(ok(fixture("messages.json"), "claude-fable-5-1"), null);
  assert.equal(ok(fixture("chat.json"), "grok-4.7"), null);
  assert.match(ok({ ...fixture("messages.json"), provider: "Amazon Bedrock" }, "claude-fable-5-1")!, /provider mismatch: want Anthropic, got Amazon Bedrock/);
  assert.match(ok({ ...fixture("messages.json"), provider: undefined }, "claude-fable-5-1")!, /provider unreported/);
  assert.match(ok({ ...fixture("chat.json"), openrouter_metadata: { endpoints: { available: [{ provider: "Azure", selected: true }] } } }, "grok-4.7")!, /got Azure/);
  // a reply that names no model is refused like one that names no provider
  assert.match(ok({ ...fixture("chat.json"), model: undefined }, "grok-4.7")!, /model unreported \(want grok-4.7\)/);
  assert.match(ok({ ...fixture("messages.json"), model: undefined }, "claude-fable-5-1")!, /model unreported/);
  // the model: our id, the slug, or either with a date suffix; anything else is another model
  for (const model of ["claude-fable-5-1", "anthropic/claude-fable-5.1", "claude-fable-5-1-20260831"]) assert.equal(ok({ ...fixture("messages.json"), model }, "claude-fable-5-1"), null, model);
  for (const model of ["anthropic/claude-opus-5.5", "anthropic/claude-fable-5.1:fast", "anthropic/claude-fable-5.1-2026"]) assert.match(ok({ ...fixture("messages.json"), model }, "claude-fable-5-1")!, /model mismatch/, model);
});

test("record mode: a fixture stores every system prompt as its sha256, never its text (the brain's carries the private persona)", async () => {
  const { fixtureRequest } = await import("../src/llm.ts");
  const { createHash } = await import("node:crypto");
  const secret = "# Charter\nA private persona line that must never reach a committed fixture.";
  const calls = [
    { ...base, agent: "brain", model: "claude-fable-5-1", system: secret, cache: true }, // Anthropic, cached blocks
    { ...base, agent: "brain", model: "claude-fable-5-1", system: secret }, // Anthropic, one string
    { ...base, model: "grok-4.7", system: secret }, // chat: a system message
    { ...base, agent: "research", model: "grok-4.7", system: secret, tools: [{ type: "web_search" as const }] }, // xAI: instructions
  ];
  for (const c of calls) {
    const body = request(c, schema, '{"kind":"build"}').body;
    assert.ok(JSON.stringify(body).includes("must never reach"), "the live request does carry it");
    const stored = JSON.stringify(fixtureRequest(body));
    assert.ok(!stored.includes("must never reach") && !stored.includes("# Charter"), `${c.model} ${c.agent}`);
    assert.match(stored, /sha256:[0-9a-f]{64}/);
    assert.ok(stored.includes(JSON.stringify('{"kind":"build"}').slice(1, -1)), "the user message is kept");
  }
  const cached = fixtureRequest(request(calls[0], schema, "{}").body) as { system: { text: string }[] };
  assert.equal(cached.system[0].text, `sha256:${createHash("sha256").update(secret).digest("hex")}`);
});

test("committed fixtures: every stored system prompt is a sha256, never text", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("./fixtures/llm/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 6);
  const HASH = /^sha256:[0-9a-f]{64}$/;
  for (const f of files) {
    const q = JSON.parse(readFileSync(new URL(f, dir), "utf8")).request as Record<string, unknown>;
    const systems: unknown[] = [];
    if (q.system !== undefined) systems.push(...(Array.isArray(q.system) ? q.system.map((b: { text: unknown }) => b.text) : [q.system]));
    if (q.instructions !== undefined) systems.push(q.instructions);
    for (const k of ["messages", "input"]) for (const m of (q[k] ?? []) as { role?: string; content?: unknown }[]) if (m.role === "system" || m.role === "developer") systems.push(m.content);
    assert.ok(systems.length, `${f}: a system prompt is recorded`);
    for (const s of systems) assert.match(String(s), HASH, f);
    assert.doesNotMatch(JSON.stringify(q), /agent: [a-z-]+\\n/, `${f}: no tagged prompt text anywhere in the request`);
  }
});
