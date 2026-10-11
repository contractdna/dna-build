// The dev team's path guard and budget ledger.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type Access, decide, guardHook } from "../src/guard.ts";
import { Ledger, MIN_QUERY_USD } from "../src/ledger.ts";
import { ROLES } from "../src/roles.ts";

const root = mkdtempSync(join(tmpdir(), "seq-guard-"));
after(() => rmSync(root, { recursive: true, force: true }));
for (const d of ["contracts/src/games/g", "contracts/test/games/g", "web/app/g/g", "contracts/src/games/example", "engine"]) mkdirSync(join(root, d), { recursive: true });
writeFileSync(join(root, "contracts/src/games/GameKit.sol"), "kit");
writeFileSync(join(root, "contracts/src/games/g/G.sol"), "game");
writeFileSync(join(root, "engine/.env"), "SECRET=1");
symlinkSync("/etc/passwd", join(root, "contracts/src/games/g/link.sol"));
symlinkSync(join(root, "engine"), join(root, "web/app/g/g/escape"));

const access = (role: keyof typeof ROLES, files?: string[]): Access => ({ root, tools: ROLES[role].tools, read: ROLES[role].read("g"), write: ROLES[role].write("g", files), output: ROLES[role].schema !== undefined });

test("a worker reads the kit and its game, writes only its task's files", () => {
  const a = access("worker", ["contracts/src/games/g/G.sol"]);
  assert.equal(decide(a, "Read", { file_path: "contracts/src/games/GameKit.sol" }), null);
  assert.equal(decide(a, "Read", { file_path: join(root, "contracts/src/games/g/G.sol") }), null, "an absolute path inside is fine");
  assert.equal(decide(a, "Write", { file_path: "contracts/src/games/g/G.sol", content: "x" }), null);
  assert.equal(decide(a, "Edit", { file_path: "contracts/src/games/g/G.sol", old_string: "a", new_string: "b" }), null);
  assert.equal(decide(a, "mcp__gates__forge_build", {}), null);
  assert.equal(decide(a, "Glob", { pattern: "contracts/src/games/g/**/*.sol" }), null);
  assert.equal(decide(a, "Grep", { pattern: "a..b", path: "contracts/src/games/g" }), null, "a regex may hold dots");
});

test("a role that answers in a fixed shape may call the SDK's StructuredOutput tool; one that doesn't may not", () => {
  assert.equal(decide(access("tester"), "StructuredOutput", { pass: true, findings: [] }), null);
  assert.equal(decide(access("lead"), "StructuredOutput", {}), null);
  assert.match(decide(access("worker", []), "StructuredOutput", {}) ?? "allowed", /not allowed/);
});

for (const [what, role, tool, input, want] of [
  ["the env file", "worker", "Read", { file_path: "engine/.env" }, /read outside/],
  ["/proc", "worker", "Read", { file_path: "/proc/self/environ" }, /read outside/],
  ["a dot-dot path", "worker", "Read", { file_path: "contracts/src/games/g/../../../../engine/.env" }, /read outside/],
  ["a symlink to /etc/passwd", "worker", "Read", { file_path: "contracts/src/games/g/link.sol" }, /read outside/],
  ["a path through a symlinked folder", "fixer", "Read", { file_path: "web/app/g/g/escape/.env" }, /read outside/],
  ["writing the kit", "fixer", "Write", { file_path: "contracts/src/games/GameKit.sol", content: "x" }, /write outside/],
  ["writing another task's file", "worker", "Write", { file_path: "contracts/test/games/g/G.t.sol", content: "x" }, /write outside/],
  ["writing a workflow", "fixer", "Write", { file_path: ".github/workflows/x.yml", content: "x" }, /write outside/],
  ["a huge write", "fixer", "Write", { file_path: "contracts/src/games/g/G.sol", content: "x".repeat(100_001) }, /bytes/],
  ["the tester writing the game's source", "tester", "Edit", { file_path: "contracts/src/games/g/G.sol", old_string: "a", new_string: "b" }, /write outside/],
  ["the lead writing", "lead", "Write", { file_path: "contracts/src/games/g/G.sol", content: "x" }, /not allowed/],
  ["Bash", "fixer", "Bash", { command: "env" }, /not allowed/],
  ["WebFetch", "fixer", "WebFetch", { url: "https://x.example" }, /not allowed/],
  ["Task", "lead", "Task", { prompt: "x" }, /not allowed/],
  ["an absolute glob", "worker", "Glob", { pattern: "/etc/*" }, /outside/],
  ["a glob climbing out", "worker", "Glob", { pattern: "../**/*" }, /outside/],
  ["a glob whose wildcard widens the folder", "worker", "Glob", { pattern: "contracts/src/games/g*/**" }, /search outside/],
  ["a glob climbing out inside braces", "worker", "Glob", { pattern: "contracts/src/games/g/{..,x}/*" }, /outside/],
  ["a grep glob climbing out inside braces", "worker", "Grep", { pattern: "x", path: "contracts/src/games/g", glob: "{..,x}/*" }, /outside/],
  ["a non-ASCII path (lookalike or direction marks)", "fixer", "Write", { file_path: "contracts/src/games/g/G\u202e.sol", content: "x" }, /write outside/],
  ["a path with a control character", "fixer", "Write", { file_path: "contracts/src/games/g/G\n.sol", content: "x" }, /write outside/],
  ["a path in another case", "fixer", "Write", { file_path: "Contracts/src/games/g/G.sol", content: "x" }, /write outside/],
  ["a whole-checkout grep", "worker", "Grep", { pattern: "KEY" }, /search outside/],
  ["a grep of the engine", "worker", "Grep", { pattern: "KEY", path: "engine" }, /search outside/],
  ["forge_test with a flag", "fixer", "mcp__gates__forge_test", { match: "--ffi" }, /letters, digits/],
  ["forge_test with a path", "fixer", "mcp__gates__forge_test", { match: "../x" }, /letters, digits/],
  ["forge_test for the lead", "lead", "mcp__gates__forge_test", {}, /not allowed/],
] as [string, keyof typeof ROLES, string, Record<string, unknown>, RegExp][]) {
  test(`planted: ${what}`, () => assert.match(decide(access(role, ["contracts/src/games/g/G.sol"]), tool, input) ?? "allowed", want));
}

test("the hook denies through the SDK's PreToolUse answer, and leaves other events alone", async () => {
  const h = guardHook(access("worker", ["contracts/src/games/g/G.sol"]));
  const deny = await h({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/proc/self/environ" } });
  assert.equal((deny as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await h({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "contracts/src/games/g/G.sol" } }), {});
  assert.deepEqual(await h({ hook_event_name: "PostToolUse" }), {});
});

test("ledger: role caps, the margin, parallel holds, and a stop below the minimum", () => {
  const l = new Ledger(12, { lead: 2, worker: 0.5, tester: 1, fixer: 1, review: 2 });
  assert.equal(l.margin, 3);
  assert.equal(l.take("lead"), 2);
  l.settle(2, { role: "lead", model: "m", costUsd: 1.5, subtype: "success", turns: 3 });
  const held = [l.take("worker"), l.take("worker"), l.take("worker"), l.take("worker")];
  assert.deepEqual(held, [0.5, 0.5, 0.5, 0.5]);
  for (const h of held) l.settle(h!, { role: "worker", model: "m", costUsd: 0.5, subtype: "success", turns: 9 });
  assert.equal(l.spent, 3.5);
  // ceiling 12 − margin 3 − spent 3.5 = 5.5 left
  for (let i = 0; i < 5; i++) l.settle(l.take("fixer")!, { role: "fixer", model: "m", costUsd: 1, subtype: "success", turns: 1 });
  assert.equal(l.take("review"), 0.5);
  const small = new Ledger(1, { lead: 2, worker: 0.5, tester: 1, fixer: 1, review: 2 });
  assert.equal(small.margin, 0.25);
  assert.equal(small.take("lead"), 0.75);
  assert.equal(small.take("worker"), null, `below ${MIN_QUERY_USD} left`);
  const bad = new Ledger(12, { lead: 2, worker: 0.5, tester: 1, fixer: 1, review: 2 });
  bad.settle(0, { role: "lead", model: "m", costUsd: Number.NaN, subtype: "error", turns: 0 });
  assert.equal(bad.spent, 0);
});
