// The SDK options every role's query runs with, pinned field by field, and the CLI's environment.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capHook, OPENROUTER, type Query, sdkEnv, sdkOptions } from "../src/driver.ts";
import { meter } from "../src/ledger.ts";
import { Findings, ROLES } from "../src/roles.ts";

const q = (role: keyof typeof ROLES, schema?: Query["schema"]): Query => ({
  role, model: "anthropic/model-x", effort: "high", system: "s", prompt: "p", maxBudgetUsd: 1.5, maxTurns: 7, timeoutMs: 1000, slug: "g", schema,
  access: { root: "/tmp", tools: ROLES[role].tools, read: ROLES[role].read("g"), write: ROLES[role].write("g", ["contracts/src/games/g/G.sol"]) },
});

test("a role's query: only its tools, nothing approved beyond them, no settings or sessions, its budget, the guard on every tool", async () => {
  const o = sdkOptions(q("tester", Findings), "/tmp", { PATH: "/bin" }, new AbortController());
  assert.deepEqual(o.tools, ["Read", "Write", "Edit", "Glob", "Grep"]);
  assert.deepEqual(o.allowedTools, ["Read", "Write", "Edit", "Glob", "Grep", "mcp__gates__forge_build", "mcp__gates__forge_test"]);
  assert.equal(o.permissionMode, "dontAsk");
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.persistSession, false);
  assert.deepEqual([o.model, o.effort, o.maxBudgetUsd, o.maxTurns], ["anthropic/model-x", "high", 1.5, 7]);
  assert.equal(o.hooks!.PreToolUse!.length, 1);
  assert.equal(o.hooks!.PreToolUse![0].hooks.length, 2, "the guard and the cap");
  assert.equal(o.hooks!.PreToolUse![0].matcher, undefined, "no matcher: every tool");
  assert.ok(o.mcpServers?.gates, "the gates server for a role that runs forge");
  assert.equal(o.outputFormat?.type, "json_schema");
  assert.deepEqual(await o.canUseTool!("Bash", {}, { signal: new AbortController().signal } as never), { behavior: "deny", message: "not allowed" });
  assert.equal(o.includePartialMessages, true, "the driver meters each model call from the stream");
  // the SDK's budget is only a backstop: Haiku's cap × 100 (the SDK prices it at a guess about 40× too high)
  assert.equal(sdkOptions({ ...q("worker"), model: "anthropic/claude-haiku-5.5", maxBudgetUsd: 0.3 }, "/tmp", { PATH: "/bin" }, new AbortController()).maxBudgetUsd, 30);
  const lead = sdkOptions(q("lead"), "/tmp", { PATH: "/bin" }, new AbortController());
  assert.equal(lead.mcpServers, undefined, "the lead runs nothing");
  assert.deepEqual(lead.tools, ["Read", "Glob", "Grep"]);
});

test("the CLI's env: OpenRouter as the API, the Sequencer key as the auth token, no Anthropic key, nothing else of the runner's", () => {
  const e = sdkEnv({ PATH: "/usr/bin", OPENROUTER_API_KEY_SEQUENCER: "k", ANTHROPIC_API_KEY: "should-not-pass", GITHUB_TOKEN: "x", HOME: "/srv/runner" });
  assert.equal(e.ANTHROPIC_BASE_URL, OPENROUTER);
  assert.equal(OPENROUTER, "https://openrouter.ai/api");
  assert.equal(e.ANTHROPIC_AUTH_TOKEN, "k");
  assert.equal(e.ANTHROPIC_API_KEY, "");
  assert.equal(e.GITHUB_TOKEN, undefined);
  assert.equal(e.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000", "a page written in one reply fits (the CLI asks Haiku for 32,000 by default)");
  assert.notEqual(e.HOME, "/srv/runner");
  assert.throws(() => sdkEnv({ PATH: "/usr/bin" }), /OPENROUTER_API_KEY_SEQUENCER/);
});

test("only a loopback model endpoint may replace OpenRouter (the offline simulation); anything else is refused", () => {
  const base = { PATH: "/usr/bin", OPENROUTER_API_KEY_SEQUENCER: "k" };
  assert.equal(sdkEnv({ ...base, SEQ_MODEL_API: "http://127.0.0.1:5123" }).ANTHROPIC_BASE_URL, "http://127.0.0.1:5123");
  for (const bad of ["https://x.example", "http://127.0.0.1.x.example:1", "http://127.0.0.1:1/@x.example", "http://localhost:1"]) {
    assert.throws(() => sdkEnv({ ...base, SEQ_MODEL_API: bad }), /loopback/, bad);
  }
});

test("the cap hook: once the call behind a tool call is metered and the query is over its cap, the CLI is stopped in-band", async () => {
  const m = meter("anthropic/claude-haiku-5.5");
  let over = false;
  const hook = capHook({ over: () => over, metered: m.metered });
  assert.deepEqual(await capHook({ over: () => false, metered: () => true })({}, "t1"), {}, "under the cap: no say");
  // the stream lags the CLI: the hook waits until the call that asked for t2 is metered (30 ms later), then decides
  setTimeout(() => {
    m.see({ type: "message_start", message: { model: "anthropic/claude-haiku-5.5", usage: { input_tokens: 10 } } });
    m.see({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t2", name: "Read", input: {} } });
    m.see({ type: "message_delta", usage: { output_tokens: 5 } });
    over = true;
  }, 30);
  assert.equal(m.metered("t2"), false);
  const r = (await hook({}, "t2")) as { continue?: boolean; hookSpecificOutput?: { permissionDecision: string } };
  assert.equal(m.metered("t2"), true);
  assert.equal(r.continue, false);
  assert.equal(r.hookSpecificOutput?.permissionDecision, "deny");
  // a tool call the stream never shows: after its wait the hook decides on what it has
  assert.equal(((await capHook({ over: () => true, metered: () => false }, 20)({}, "t9")) as { continue?: boolean }).continue, false);
});
