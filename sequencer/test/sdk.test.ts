// The real Agent SDK and its CLI, run against a loopback fake of the model API (no model, no network): what a role can
// actually do. The fake model plants each forbidden call; the guard, the tool list and the settings isolation must
// stop every one, while the role's own work and its structured answer go through.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sdkDriver, sdkEnv } from "../src/driver.ts";
import { Findings, ROLES } from "../src/roles.ts";
import { checkout } from "./checkout.ts";
import { type Block, fakeModel, promptOf, results, step, USAGE } from "./fakemodel.ts";

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A checkout with a game folder, a secret file, and repo settings that would grant Bash and a CLAUDE.md, if loaded. */
function root() {
  const d = mkdtempSync(join(tmpdir(), "seq-sdk-"));
  made.push(d);
  for (const p of ["contracts/src/games/g", "contracts/test/games/g", "engine", ".claude"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, "contracts/src/games/g/G.sol"), "contract G {}\n");
  writeFileSync(join(d, "engine/.env"), "SECRET=1\n");
  writeFileSync(join(d, "CLAUDE.md"), "MARKER-FROM-CLAUDE-MD\n");
  writeFileSync(join(d, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash", "WebFetch", "Read(//**)"] } }));
  return d;
}
const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const access = (dir: string, role: "tester" | "worker" | "fixer") => ({ root: dir, tools: ROLES[role].tools, read: ROLES[role].read("g"), write: ROLES[role].write("g", ["contracts/src/games/g/G.sol"]), output: ROLES[role].schema !== undefined });
const query = (dir: string, over: Record<string, unknown>) => ({
  role: "tester" as const, model: "anthropic/claude-sonnet-5.5", effort: "high" as const, system: "ROLE-SYSTEM-PROMPT", prompt: "Test the game.",
  maxBudgetUsd: 1, maxTurns: 20, timeoutMs: 60_000, slug: "g", access: access(dir, "tester"), schema: Findings, ...over,
});

test("planted, through the real CLI: secrets, /proc, Bash, the web, sub-agents, writes outside, repo settings and CLAUDE.md are all refused; the role's own write and its answer go through", async () => {
  const dir = root();
  const plan: [string, string, unknown, RegExp | null][] = [
    ["environ", "Read", { file_path: "/proc/self/environ" }, /read outside|Cannot read/],
    ["passwd", "Read", { file_path: "/etc/passwd" }, /read outside/],
    ["env", "Read", { file_path: join(dir, "engine/.env") }, /read outside/],
    ["claudemd", "Read", { file_path: join(dir, "CLAUDE.md") }, /read outside/],
    ["bash", "Bash", { command: "env" }, /No such tool/],
    ["web", "WebFetch", { url: "https://x.example", prompt: "x" }, /No such tool/],
    ["task", "Task", { description: "x", prompt: "x", subagent_type: "general-purpose" }, /No such tool/],
    ["workflow", "Write", { file_path: join(dir, ".github/workflows/x.yml"), content: "on: push\n" }, /write outside/],
    ["source", "Edit", { file_path: join(dir, "contracts/src/games/g/G.sol"), old_string: "G", new_string: "H" }, /write outside/],
    ["flag", "mcp__gates__forge_test", { match: "--ffi" }, /letters, digits|match/],
    ["test", "Write", { file_path: join(dir, "contracts/test/games/g/G.t.sol"), content: "// a test\n" }, null],
    ["answer", "StructuredOutput", { pass: false, findings: ["settle pays twice"] }, null],
  ];
  let seen: Record<string, { text: string; error: boolean }> = {};
  const m = await fakeModel((r) => {
    seen = results(r);
    const s = plan[step(r)];
    return s ? [use(s[0], s[1], s[2])] : [{ type: "text", text: "done" }];
  });
  try {
    const r = await sdkDriver(dir, sdkEnv({ PATH: process.env.PATH, OPENROUTER_API_KEY_SEQUENCER: "test-key", SEQ_MODEL_API: m.url })).run(query(dir, {}));
    for (const [id, , , want] of plan) {
      if (want) {
        assert.equal(seen[id]?.error, true, `${id} refused`);
        assert.match(seen[id].text, want, id);
      } else assert.notEqual(seen[id]?.error, true, `${id} allowed: ${seen[id]?.text}`);
    }
    assert.equal(r.subtype, "success");
    assert.deepEqual(r.output, { pass: false, findings: ["settle pays twice"] });
    assert.equal(readFileSync(join(dir, "contracts/test/games/g/G.t.sol"), "utf8"), "// a test\n");
    assert.equal(readFileSync(join(dir, "contracts/src/games/g/G.sol"), "utf8"), "contract G {}\n");
    assert.ok(!existsSync(join(dir, ".github")));
    const calls = m.requests.filter((q) => q.path.endsWith("/v1/messages"));
    assert.ok(calls.length >= plan.length);
    assert.ok(Math.abs(r.costUsd - calls.length * (1000 * 2 + 200 * 10) / 1e6) < 1e-9, "priced from models.json: Sonnet 5.5 at $2/$10");
    for (const c of calls) {
      assert.equal(c.headers.authorization, "Bearer test-key");
      assert.equal(c.headers["x-api-key"], undefined);
      assert.equal(c.body.model, "anthropic/claude-sonnet-5.5");
      assert.deepEqual(c.body.tools?.map((t) => t.name).sort(), ["Edit", "Glob", "Grep", "Read", "StructuredOutput", "Write", "mcp__gates__forge_build", "mcp__gates__forge_test"]);
      assert.ok(!JSON.stringify(c.body).includes("MARKER-FROM-CLAUDE-MD"), "no CLAUDE.md");
      assert.ok(JSON.stringify(c.body.system).includes("ROLE-SYSTEM-PROMPT"));
    }
  } finally {
    await m.close();
  }
});

test("the fixer, through the real CLI, gets the findings and can work on them: it reads and edits the game's source and tests, and nothing else", async () => {
  const dir = root();
  const src = join(dir, "contracts/src/games/g/G.sol");
  const plan: [string, string, unknown, RegExp | null][] = [
    ["read", "Read", { file_path: src }, null],
    ["edit", "Edit", { file_path: src, old_string: "G {}", new_string: "G { uint256 x; }" }, null],
    ["test", "Write", { file_path: join(dir, "contracts/test/games/g/G.t.sol"), content: "// a test\n" }, null],
    ["relative", "Read", { file_path: "contracts/test/games/g/G.t.sol" }, null],
    ["outside", "Write", { file_path: join(dir, "engine/x.ts"), content: "x\n" }, /write outside/],
  ];
  let seen: Record<string, { text: string; error: boolean }> = {};
  const m = await fakeModel((r) => {
    seen = results(r);
    const s = plan[step(r)];
    return s ? [use(s[0], s[1], s[2])] : [{ type: "text", text: "fixed" }];
  });
  try {
    const findings = "FINDINGS TO FIX (data):\n<<<\n- settle pays twice\n>>>";
    const r = await sdkDriver(dir, sdkEnv({ PATH: process.env.PATH, OPENROUTER_API_KEY_SEQUENCER: "k", SEQ_MODEL_API: m.url })).run(query(dir, { role: "fixer", prompt: findings, schema: undefined, maxTurns: ROLES.fixer.maxTurns, access: access(dir, "fixer") }));
    for (const [id, , , want] of plan) {
      if (want) assert.match(seen[id]?.text ?? "", want, id);
      else assert.notEqual(seen[id]?.error, true, `${id}: ${seen[id]?.text}`);
    }
    assert.equal(r.subtype, "success");
    assert.equal(r.turns, plan.length + 1, "one turn per model call: the query ends only when the model answers without a tool call");
    assert.equal(readFileSync(src, "utf8"), "contract G { uint256 x; }\n");
    assert.ok(!existsSync(join(dir, "engine/x.ts")));
    assert.ok(m.requests.filter((q) => q.path.endsWith("/v1/messages")).every((q) => promptOf(q).includes("settle pays twice")), "the findings reach every call");
  } finally {
    await m.close();
  }
});

test("the query's budget stops it (error_max_budget_usd), priced from models.json", async () => {
  const dir = root();
  const m = await fakeModel((r) => [use(`r${step(r)}`, "Read", { file_path: join(dir, "contracts/src/games/g/G.sol") })]);
  try {
    const r = await sdkDriver(dir, sdkEnv({ PATH: process.env.PATH, OPENROUTER_API_KEY_SEQUENCER: "k", SEQ_MODEL_API: m.url })).run(query(dir, { maxBudgetUsd: 0.01, schema: undefined, role: "worker", access: access(dir, "worker") }));
    assert.equal(r.subtype, "error_max_budget_usd");
    assert.ok(m.requests.filter((q) => q.path.endsWith("/v1/messages")).length <= 4);
  } finally {
    await m.close();
  }
});

const haikuWorker = (dir: string, over: Record<string, unknown> = {}) =>
  query(dir, { model: "anthropic/claude-haiku-5.5", maxBudgetUsd: 0.3, schema: undefined, role: "worker", access: access(dir, "worker"), ...over });

test("a Haiku worker the SDK can't price (costBasis unknown) costs its models.json price and finishes under its $0.30 cap", async () => {
  const dir = root();
  // three calls of 11K output tokens: $0.0168 at Haiku's price, about $0.67 at the SDK's guess
  const m = await fakeModel((r) => (step(r) < 2 ? [use(`r${step(r)}`, "Read", { file_path: join(dir, "contracts/src/games/g/G.sol") })] : [{ type: "text", text: "done" }]), { ...USAGE, output_tokens: 11_000 });
  try {
    const r = await sdkDriver(dir, sdkEnv({ PATH: process.env.PATH, OPENROUTER_API_KEY_SEQUENCER: "k", SEQ_MODEL_API: m.url })).run(haikuWorker(dir));
    assert.equal(r.subtype, "success");
    assert.ok(Math.abs(r.costUsd - (3 * 1000 * 0.1 + 33_000 * 0.5) / 1e6) < 1e-9, String(r.costUsd));
    const sdk = (r.modelUsage as Record<string, { costUSD: number; costBasis?: string }>)["anthropic/claude-haiku-5.5"];
    assert.equal(sdk.costBasis, "unknown", "this SDK has no price for Haiku 5.5");
    assert.ok(sdk.costUSD > 0.3, "its guess alone would have stopped the worker");
  } finally {
    await m.close();
  }
});

test("replies that name the model with a release date (anthropic/claude-haiku-5.5-20260831): still Haiku's price, not the priciest card", async () => {
  const dir = root();
  const m = await fakeModel((r) => (step(r) < 2 ? [use(`r${step(r)}`, "Read", { file_path: join(dir, "contracts/src/games/g/G.sol") })] : [{ type: "text", text: "done" }]), { ...USAGE, output_tokens: 11_000 }, "anthropic/claude-haiku-5.5-20260831");
  try {
    const r = await sdkDriver(dir, sdkEnv({ PATH: process.env.PATH, OPENROUTER_API_KEY_SEQUENCER: "k", SEQ_MODEL_API: m.url })).run(haikuWorker(dir));
    assert.equal(r.subtype, "success");
    assert.ok(Math.abs(r.costUsd - (3 * 1000 * 0.1 + 33_000 * 0.5) / 1e6) < 1e-9, String(r.costUsd));
    assert.deepEqual(r.replied, ["anthropic/claude-haiku-5.5-20260831"], "the report shows the name the replies gave");
  } finally {
    await m.close();
  }
});

test("the cap still binds when the real cost passes it: no model call after the one that crossed it, and that one is charged", async () => {
  const dir = root();
  // $0.0301 a call at Haiku's price: the tenth takes it past $0.30 (its tool call is where the query ends)
  const m = await fakeModel((r) => [use(`r${step(r)}`, "Read", { file_path: join(dir, "contracts/src/games/g/G.sol") })], { ...USAGE, output_tokens: 60_000 });
  try {
    const r = await sdkDriver(dir, sdkEnv({ PATH: process.env.PATH, OPENROUTER_API_KEY_SEQUENCER: "k", SEQ_MODEL_API: m.url })).run(haikuWorker(dir, { maxTurns: 40 }));
    assert.equal(r.subtype, "error_max_budget_usd");
    assert.equal(m.requests.filter((q) => q.path.endsWith("/v1/messages")).length, 10);
    assert.ok(Math.abs(r.costUsd - 10 * (1000 * 0.1 + 60_000 * 0.5) / 1e6) < 1e-9, String(r.costUsd));
  } finally {
    await m.close();
  }
});

test("the query's timer stops a hung model call", async () => {
  const dir = root();
  const m = await fakeModel(() => new Promise((ok) => setTimeout(() => ok([{ type: "text", text: "late" }]), 8_000)));
  try {
    const t0 = Date.now();
    const r = await sdkDriver(dir, sdkEnv({ PATH: process.env.PATH, OPENROUTER_API_KEY_SEQUENCER: "k", SEQ_MODEL_API: m.url })).run(query(dir, { timeoutMs: 1_500 }));
    assert.equal(r.subtype, "timeout");
    assert.ok(Date.now() - t0 < 6_000);
    assert.equal(r.costUsd, 1, "a stopped query is charged its whole cap");
  } finally {
    await m.close();
  }
});

const hasForge = (() => { try { execFileSync("forge", ["--version"], { stdio: "ignore" }); return existsSync(new URL("../../contracts/lib/forge-std/src/Test.sol", import.meta.url)); } catch { return false; } })();
const running = (pattern: string) => { try { return execFileSync("pgrep", ["-f", pattern]).toString().trim(); } catch { return ""; } };

test("planted: a forge run the role started late in its query dies with the query (no forge outlives it)", { skip: hasForge ? false : "needs forge and forge-std", timeout: 120_000 }, async () => {
  const { dir } = checkout();
  made.push(dir);
  mkdirSync(join(dir, "contracts/test/games/spinforever"), { recursive: true });
  // a test that runs for hours: a heavy loop under 100,000 fuzz runs (inline config wins over the run's fuzz setting)
  writeFileSync(join(dir, "contracts/test/games/spinforever/Spin.t.sol"), "// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\nimport {Test} from \"forge-std/Test.sol\";\ncontract SpinTest is Test {\n  /// forge-config: default.fuzz.runs = 100000\n  function testFuzz_spin(uint256 x) public pure { uint256 i; while (i < 5_000_000) { i += 1 + (x & 0); } }\n}\n");
  // the model thinks for a while, then asks for the suite: the run starts well after the query did
  const m = await fakeModel(async (r) => {
    if (step(r) === 0) { await new Promise((ok) => setTimeout(ok, 4_000)); return [use("look", "Read", { file_path: join(dir, "contracts/test/games/spinforever/Spin.t.sol") })]; }
    if (step(r) === 1) return [use("run", "mcp__gates__forge_test", {})];
    return [{ type: "text", text: "done" }];
  });
  try {
    const t0 = Date.now();
    const r = await sdkDriver(dir, sdkEnv({ PATH: process.env.PATH, HOME: process.env.HOME, OPENROUTER_API_KEY_SEQUENCER: "k", SEQ_MODEL_API: m.url })).run(query(dir, {
      slug: "spinforever", timeoutMs: 15_000, access: { root: dir, tools: ROLES.tester.tools, read: ROLES.tester.read("spinforever"), write: ROLES.tester.write("spinforever"), output: true },
    }));
    assert.equal(r.subtype, "timeout");
    await new Promise((ok) => setTimeout(ok, 500));
    assert.ok(Date.now() - t0 < 25_000);
    assert.equal(running("match-path .*games.spinforever"), "", "no forge left behind");
  } finally {
    await m.close();
  }
});
