// What a query costs, from token counts at models.json prices: never the SDK's own figure, which has no price for some
// models (Haiku 5.5 on Agent SDK 0.3.282: costBasis "unknown", priced at an Opus-class guess about 40× too high).
// Every call is priced as the query's requested model (which the enclave only dispatches when priced), whatever name
// the reply gives it: a dated or differently spelled name must not fall to the priciest card.
import assert from "node:assert/strict";
import { test } from "node:test";
import { backstopUsd, MAX_OUTPUT_TOKENS, meter, usageUsd } from "../src/ledger.ts";

const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const HAIKU = "anthropic/claude-haiku-5.5";
const OPUS = "anthropic/claude-opus-5.5";

/** A worker's modelUsage as the SDK reported it in the rehearsal: 33K output tokens, priced by the SDK's guess. */
const HAIKU_WORKER = {
  "anthropic/claude-haiku-5.5": {
    inputTokens: 1200, outputTokens: 33_000, cacheReadInputTokens: 410_000, cacheCreationInputTokens: 38_000, webSearchRequests: 0,
    costUSD: 0.9368, contextWindow: 200000, maxOutputTokens: 32000, thinkingTokens: 0, canonicalModel: "anthropic/claude-haiku-5.5", provider: "firstParty", costBasis: "unknown",
  },
};
const OPUS_LEAD = {
  "anthropic/claude-opus-5.5": {
    inputTokens: 2400, outputTokens: 9000, cacheReadInputTokens: 180_000, cacheCreationInputTokens: 22_000, webSearchRequests: 0,
    costUSD: 0.3716, contextWindow: 200000, maxOutputTokens: 32000, canonicalModel: "claude-opus-5-5", provider: "firstParty", costBasis: "list",
  },
};
const HAIKU_USD = 0.00012 + 0.0165 + 0.0041 + 0.00475;

test("the unknown-basis Haiku worker costs its real price (models.json), not the SDK's guess, and stays under a $0.30 cap", () => {
  // 1,200 × $0.1 + 33,000 × $0.5 + 410,000 × $0.01 (cache read) + 38,000 × $0.125 (cache write), per 1M tokens
  const usd = usageUsd(HAIKU_WORKER, HAIKU);
  near(usd, HAIKU_USD);
  assert.ok(usd! < 0.3 && usd! < HAIKU_WORKER["anthropic/claude-haiku-5.5"].costUSD / 30);
});

test("modelUsage under a dated or differently spelled name: priced as the requested model, never the priciest card", () => {
  const u = HAIKU_WORKER["anthropic/claude-haiku-5.5"];
  for (const name of ["anthropic/claude-haiku-5.5-20260831", "claude-haiku-5-5-20260831", "claude-haiku-5-5"]) near(usageUsd({ [name]: u }, HAIKU), HAIKU_USD);
  near(usageUsd(OPUS_LEAD, OPUS), (2400 * 4 + 9000 * 20 + 180_000 * 0.2 + 22_000 * 5) / 1e6);
  // several entries add up
  near(usageUsd({ "anthropic/claude-haiku-5.5-20260831": u, "anthropic/claude-haiku-5.5": u }, HAIKU), 2 * HAIKU_USD);
  // a requested model models.json doesn't know (the dispatch guard refuses one): the priciest rate
  near(usageUsd({ x: { inputTokens: 1000, outputTokens: 1000 } }, "anthropic/claude-unknown-9"), (1000 * 10 + 1000 * 50) / 1e6);
});

test("no usable modelUsage: null (the caller charges the whole cap); missing counts are zero", () => {
  for (const bad of [undefined, null, "x", 3, []]) assert.equal(usageUsd(bad, HAIKU), null, String(bad));
  assert.equal(usageUsd({}, HAIKU), 0);
  near(usageUsd({ "anthropic/claude-haiku-5.5": { outputTokens: 1000, inputTokens: "lots" } }, HAIKU), 1000 * 0.5 / 1e6);
});

const start = (model: string, usage: object) => ({ type: "message_start", message: { id: "m", model, usage } });

test("the meter: each model call from its stream events (message_start, then message_delta's final output count), its own prompt-length card", () => {
  const m = meter(HAIKU);
  m.see({ type: "message_delta", usage: { output_tokens: 99_999 } }); // before any call: ignored
  m.see(start(HAIKU, { input_tokens: 120_000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
  m.see({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } });
  near(m.usd(), (120_000 * 0.5 + 1 * 2.5) / 1e6); // over 100K prompt tokens: Haiku's long-prompt card
  m.see({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2000 } });
  near(m.usd(), (120_000 * 0.5 + 2000 * 2.5) / 1e6);
  m.see(start(HAIKU, { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 }));
  m.see({ type: "message_delta", usage: { output_tokens: 500 } });
  near(m.usd(), (120_000 * 0.5 + 2000 * 2.5) / 1e6 + (1000 * 0.1 + 50_000 * 0.01 + 500 * 0.5) / 1e6);
  near(m.charge(), m.usd()); // every call finished: nothing more to add
  for (const junk of [null, 1, "x", { type: "message_start" }, { type: "message_delta", usage: { output_tokens: -5 } }]) m.see(junk);
  assert.ok(Number.isFinite(m.usd()));
});

test("the meter prices a call as the requested model whatever name the stream gives it (dated, our id, or another)", () => {
  for (const name of ["anthropic/claude-haiku-5.5-20260831", "claude-haiku-5-5-20260831", "claude-haiku-5-5", "anthropic/claude-unknown-9"]) {
    const m = meter(HAIKU);
    m.see(start(name, { input_tokens: 1000, output_tokens: 1 }));
    m.see({ type: "message_delta", usage: { output_tokens: 11_000 } });
    near(m.usd(), (1000 * 0.1 + 11_000 * 0.5) / 1e6);
  }
});

test("a call cut off before its final count (an abort): the charge adds the most output it could have had, so it never under-reports", () => {
  const m = meter(OPUS);
  m.see(start(OPUS, { input_tokens: 1000, output_tokens: 1 }));
  m.see({ type: "message_delta", usage: { output_tokens: 300 } });
  m.see(start(OPUS, { input_tokens: 2000, output_tokens: 1 })); // never finished
  near(m.usd(), (1000 * 4 + 300 * 20 + 2000 * 4 + 1 * 20) / 1e6);
  near(m.charge(), (1000 * 4 + 300 * 20 + 2000 * 4 + MAX_OUTPUT_TOKENS * 20) / 1e6);
  assert.equal(MAX_OUTPUT_TOKENS, 64_000);
});

test("a call left unfinished by a CLI retry (a mid-stream provider error), then a finished one: under the cap at a result", () => {
  const m = meter(HAIKU);
  m.see(start(HAIKU, { input_tokens: 1000, output_tokens: 1 })); // the stream broke here; the CLI retried
  m.see(start(HAIKU, { input_tokens: 1000, output_tokens: 1 }));
  m.see({ type: "message_delta", usage: { output_tokens: 2000 } });
  // a result: usd() is what the driver charges (the retried call produced no more than it showed)
  near(m.usd(), (1000 * 0.1 + 1 * 0.5 + 1000 * 0.1 + 2000 * 0.5) / 1e6);
  assert.ok(m.usd() < 0.01);
  // only an abort adds the cut call's most output: here 64K × $0.5 per 1M
  near(m.charge() - m.usd(), (MAX_OUTPUT_TOKENS - 1) * 0.5 / 1e6);
});

test("the names the replies gave the model are kept for the report (each once, in order)", () => {
  const m = meter(HAIKU);
  assert.deepEqual(m.models(), []);
  for (const name of [HAIKU, "anthropic/claude-haiku-5.5-20260831", HAIKU]) m.see(start(name, { input_tokens: 1 }));
  m.see({ type: "message_start", message: { usage: {} } }); // no name: not listed
  assert.deepEqual(m.models(), [HAIKU, "anthropic/claude-haiku-5.5-20260831"]);
});

test("the SDK's own budget is a backstop the cap always reaches first: the cap × how far the priciest card is above the model's", () => {
  near(backstopUsd(0.3, HAIKU), 30); // $10/$50 over $0.1/$0.5: 100×, past the SDK's ~40× guess
  near(backstopUsd(2, OPUS), 5);
  near(backstopUsd(1, "anthropic/claude-unknown-9"), 1);
});
