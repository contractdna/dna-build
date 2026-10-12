// A whole order with a scripted team (no model calls): the pipeline, the build's own SPEC.json and game.json, the
// patch, the report, the stops; then the published result passes the enclave's gates, the address gate included.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { getContractAddress, type Hex } from "viem";
import { runGates } from "../../engine/src/seq-forge.ts";
import { parseRaw } from "../../engine/src/seq-gates.ts";
import type { Order } from "../../engine/src/seq-order.ts";
import { type Query, scriptDriver } from "../src/driver.ts";
import { BUILD_MS, build, patchOf, RESERVE_MS, SETUP_MS, slot } from "../src/run.ts";
import { checkout } from "./checkout.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const FIX = join(REPO, "engine/test/fixtures/seq/lastclick");
const hasForge = (() => { try { execFileSync("forge", ["--version"], { stdio: "ignore" }); return existsSync(join(REPO, "contracts/lib/forge-std/src/Test.sol")); } catch { return false; } })();
const fixture = (): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out[relative(FIX, p)] = readFileSync(p, "utf8"); } };
  walk(FIX);
  return out;
};
const spec = JSON.parse(fixture()["contracts/src/games/lastclick/SPEC.json"]).spec as string;
const order = (base: string, over: Partial<Order> = {}): Order => ({
  v: 1, id: "o-test-0001", build: "b-test", round: 1, slug: "lastclick", salt: `0x${"ab".repeat(32)}`, factory: "0x5fbdb2315678afecb367f032d93f642f64180aa3", safe: "0x00000000000000000000000000000000000005af",
  baseSha: base, spec, specSha256: createHash("sha256").update(spec).digest("hex"), rubric: { value: 4, fit: 5, clarity: 4, originality: 3 },
  models: { lead: "anthropic/claude-opus-5.5", worker: "anthropic/claude-haiku-5.5", tester: "anthropic/claude-sonnet-5.5", fixer: "anthropic/claude-sonnet-5.5", review: "anthropic/claude-opus-5.5" }, effort: { lead: "medium", worker: "max", tester: "high", fixer: "high", review: "high" },
  budget: { ceilingUsd: 12, perQueryUsd: { lead: 2, worker: 0.5, tester: 1, fixer: 1, review: 2 } }, fixRounds: 3, issues: [], expiresAt: "2099-01-01T00:00:00Z", ...over,
});
const PLAN = {
  title: "Last Click", template: "none", interface: ["click()", "settle()", "leader()", "deadline()", "ROUND()", "PRIZE_BPS()"], tests: ["rounds", "claims"],
  tasks: [
    { goal: "Write the game contract from the spec.", files: ["contracts/src/games/lastclick/LastClick.sol"] },
    { goal: "Write the game's tests with the conformance suite.", files: ["contracts/test/games/lastclick/LastClick.t.sol"] },
    { goal: "Write the page from the template.", files: ["web/app/g/lastclick/page.tsx", "web/app/g/lastclick/page.module.css"] },
  ],
};
const BODY = "Last Click: each click starts or extends a one-hour round. When it runs out the last clicker wins a tenth of the pot. Tested with fuzzing, an invariant and the shared conformance suite.";

/** The scripted team: the lead plans, workers write the fixture's files, the tester and the review answer. */
function team(dir: string, opts: { tester?: (n: number) => unknown; plan?: unknown; edit?: (files: Record<string, string>) => void } = {}) {
  const calls: Query[] = [];
  let tests = 0;
  const files = fixture();
  opts.edit?.(files);
  return {
    calls,
    driver: scriptDriver((q) => {
      calls.push(q);
      if (q.role === "lead") return { output: opts.plan ?? PLAN };
      if (q.role === "worker") {
        for (const f of q.access.write) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), files[f]); }
        return {};
      }
      if (q.role === "tester") return { output: opts.tester ? opts.tester(++tests) : { pass: true, findings: [] } };
      if (q.role === "review") return { output: { ready: true, review: "Matches the spec.", prBody: BODY } };
      return {};
    }),
  };
}

test("every step's time is its limit clipped to what is left before the deadline; under the step's minimum it doesn't start", () => {
  const D = 100 * 60_000;
  assert.equal(slot(10 * 60_000, D, 0), 10 * 60_000, "far from the deadline: the limit");
  assert.equal(slot(10 * 60_000, D, D - 3 * 60_000), 3 * 60_000, "near it: what is left");
  assert.equal(slot(5 * 60_000, D, D - 59_000), null, "under a minute: nothing starts");
  assert.equal(slot(5 * 60_000, D, D + 1), null);
});

test("the team's time, the runner's setup and the fixed reserve fit the build job's timeout", () => {
  const yml = readFileSync(join(REPO, ".github/workflows/sequencer.yml"), "utf8");
  const job = Number(yml.slice(yml.indexOf("\n  build:")).match(/timeout-minutes: (\d+)/)![1]) * 60_000;
  assert.equal(RESERVE_MS, 10 * 60_000);
  assert.ok(BUILD_MS + SETUP_MS + RESERVE_MS <= job, `${BUILD_MS} + ${SETUP_MS} + ${RESERVE_MS} > ${job}`);
});

test("the build job's script writes report.json even when it fails before the team starts (no model key here): the spend is unknown, so it is the whole ceiling", () => {
  const tmp = mkdtempSync(join(tmpdir(), "seq-run-cli-"));
  try {
    writeFileSync(join(tmp, "order.json"), JSON.stringify(order("e".repeat(40))));
    const r = spawnSync(process.execPath, [join(REPO, "sequencer/src/run.ts"), "--order", join(tmp, "order.json"), "--out", join(tmp, "out"), "--root", tmp], { env: { PATH: process.env.PATH ?? "", GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "5" }, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    const rep = JSON.parse(readFileSync(join(tmp, "out/report.json"), "utf8"));
    assert.match(rep.outcome, /^error: .*OPENROUTER_API_KEY_SEQUENCER/);
    assert.deepEqual([rep.orderId, rep.runId, rep.runAttempt, rep.totalUsd, rep.queries], ["o-test-0001", "5", "1", 12, []]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the lead's spec amendment: every later role gets it in the plan, and the report carries it for the brain, even when the build stops", async () => {
  const { dir, base } = checkout();
  const { dir: d2, base: b2 } = checkout();
  try {
    const amendment = { reason: "Crediting every finisher at settle loops over all players, past the 200k gas limit.", change: "Pay by claim instead of at settle." };
    const t = team(dir, { plan: { ...PLAN, amendment }, tester: () => ({ pass: false, findings: ["settle pays twice"] }) });
    const r = await build(order(base, { fixRounds: 1 }), dir, t.driver, {});
    assert.equal(r.ok, false);
    assert.deepEqual(r.report.amendment, amendment);
    for (const c of t.calls.filter((x) => x.role !== "lead")) assert.ok(c.prompt.includes(amendment.change), c.role);
    // no amendment proposed: none in the report
    const r2 = await build(order(b2, { fixRounds: 1 }), d2, team(d2, { tester: () => ({ pass: false, findings: ["x"] }) }).driver, {});
    assert.equal(r2.report.amendment, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  }
});

describe("a whole order", { skip: hasForge ? false : "needs forge and forge-std" }, () => {
  const made: string[] = [];
  after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

  test("lead → workers → tester → review; SPEC.json and game.json from the build; a patch of the game's folders only; it passes the enclave's gates", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const o = order(base);
    const t = team(dir);
    const r = await build(o, dir, t.driver, { GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1" });
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(t.calls.map((c) => c.role), ["lead", "worker", "worker", "worker", "tester", "review"]);
    assert.ok(t.calls.every((c) => c.prompt.includes(spec) && c.prompt.includes("data")), "the spec reaches every role as data");
    assert.deepEqual(r.report.queries.map((q) => q.role), ["lead", "worker", "worker", "worker", "tester", "review"]);
    assert.equal(r.report.runId, "77");
    const specJson = JSON.parse(readFileSync(join(dir, "contracts/src/games/lastclick/SPEC.json"), "utf8"));
    assert.equal(specJson.specSha256, o.specSha256);
    assert.ok(specJson.files.includes("web/app/g/lastclick/game.json"));
    const game = JSON.parse(readFileSync(join(dir, "web/app/g/lastclick/game.json"), "utf8"));
    const patch = patchOf(dir, "lastclick");
    assert.ok(patch.includes("+++ b/contracts/src/games/lastclick/LastClick.sol"));
    assert.ok(!/\+\+\+ b\/(?!contracts\/src\/games\/lastclick\/|contracts\/test\/games\/lastclick\/|web\/app\/g\/lastclick\/)/.test(patch), "nothing outside the game's folders");
    // the enclave's view: the committed result through every gate, the address gate with the order's factory and salt
    const g = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]).toString();
    g("add", "-A"); g("commit", "-qm", "build");
    const changes = parseRaw(g("diff", "--raw", "-z", "--no-abbrev", "-M", base, "HEAD"));
    const files = Object.fromEntries(changes.map((c) => [c.path, readFileSync(join(dir, c.path), "utf8")]));
    for (const c of changes) c.size = files[c.path].length;
    const run = await runGates({ slug: "lastclick", changes, files, baseHasSlug: false, prBody: r.prBody!, kit: join(dir, "contracts"), order: { seed: "s", specSha256: o.specSha256, factory: o.factory as Hex, salt: o.salt as Hex, safe: o.safe as Hex } });
    assert.deepEqual(run.results.filter((x) => !x.ok), []);
    assert.ok(run.results.some((x) => x.gate === "G13"));
    assert.equal(game.address, getContractAddress({ opcode: "CREATE2", from: o.factory as Hex, salt: o.salt as Hex, bytecode: run.game!.initCode }));
  });

  test("the plan's interface is a guide: SPEC.json's interface is written from the compiled ABI, so a function the plan missed or named wrong costs no round", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const t = team(dir, { plan: { ...PLAN, interface: ["click()", "settle()", "notThere()"] } });
    const r = await build(order(base), dir, t.driver, {});
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(t.calls.map((c) => c.role), ["lead", "worker", "worker", "worker", "tester", "review"], "no fixer round");
    const specJson = JSON.parse(readFileSync(join(dir, "contracts/src/games/lastclick/SPEC.json"), "utf8"));
    assert.deepEqual(specJson.interface, ["PRIZE_BPS()", "ROUND()", "click()", "deadline()", "leader()", "settle()"]);
  });

  test("planted: a payable function the plan never named is not written into SPEC.json: G5 sends it to the fixer, then no pull request", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const S = "contracts/src/games/lastclick/LastClick.sol";
    const t = team(dir, { edit: (f) => { f[S] = f[S].replace("    address public leader;", "    address public leader;\n\n    function tip() external payable {}"); } });
    const r = await build(order(base, { fixRounds: 2 }), dir, t.driver, {});
    assert.equal(r.ok, false);
    assert.match(r.why, /still fail after 2 rounds/);
    const fixes = t.calls.filter((c) => c.role === "fixer");
    assert.equal(fixes.length, 1);
    assert.match(fixes[0].prompt, /G5 ABI and structure: tip\(\) is payable/);
    assert.doesNotMatch(fixes[0].prompt, /not in SPEC\.json's interface/, "only the forbidden difference fails");
  });

  test("tests that keep failing: the fixer gets fixRounds − 1 turns, then no pull request", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const t = team(dir, { tester: () => ({ pass: false, findings: ["settle pays twice"] }) });
    const r = await build(order(base), dir, t.driver, {});
    assert.equal(r.ok, false);
    assert.match(r.why, /still fail after 3 rounds/);
    assert.equal(t.calls.filter((c) => c.role === "fixer").length, 2);
    assert.equal(t.calls.filter((c) => c.role === "review").length, 0);
    assert.match(r.report.outcome, /^stopped/);
    assert.deepEqual(r.report.tests, [1, 2, 3].map((round) => ({ round, pass: false, findings: ["settle pays twice"] })), "each round's findings are in the report");
  });

  test("a tester that passes with notes: the suite passes, so the notes go to the report and never to the fixer", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const key = "sk-or-v1-planted";
    const t = team(dir, { tester: () => ({ pass: true, findings: ["All tests pass, the conformance suite included.", `settle is covered by a fuzz test ${key}`] }) });
    const r = await build(order(base), dir, t.driver, { OPENROUTER_API_KEY_SEQUENCER: key });
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(t.calls.map((c) => c.role), ["lead", "worker", "worker", "worker", "tester", "review"]);
    assert.deepEqual(r.report.tests, [{ round: 1, pass: true, findings: ["All tests pass, the conformance suite included.", "settle is covered by a fuzz test <key>"] }]);
  });

  test("planted: a tester that says pass over a failing suite; forge's own run sends it to the fixer, then no pull request", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const t = team(dir, { edit: (f) => { const p = "contracts/test/games/lastclick/LastClick.t.sol"; f[p] = f[p].replace(/\}\s*$/, "  function test_planted() public pure { assertTrue(false); }\n}\n"); } });
    const r = await build(order(base), dir, t.driver, {});
    assert.equal(r.ok, false);
    assert.match(r.why, /still fail/);
    const fixes = t.calls.filter((c) => c.role === "fixer");
    assert.equal(fixes.length, 2);
    assert.match(fixes[0].prompt, /forge test fails[\s\S]*test_planted/);
    assert.equal(r.report.tests.length, 3);
    assert.ok(r.report.tests.every((x) => x.pass && x.findings.length === 1 && x.findings[0].length <= 400 && /^forge test fails/.test(x.findings[0])), "the suite's failure, cut short, is in the report");
  });

  test("planted: a passing suite whose tests import the factory and use a banned cheatcode; the build's own G2/G3 check sends it to the fixer, then no pull request", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const T = "contracts/test/games/lastclick/LastClick.t.sol";
    const t = team(dir, {
      edit: (f) => {
        f[T] = f[T].replace('import {GameKitConformance} from "../GameKitConformance.sol";', 'import {GameKitConformance} from "../GameKitConformance.sol";\nimport {GameFactory} from "../../../src/games/GameFactory.sol";')
          .replace("    function test_lastClickerIsOwedTenPercent()", '    function test_planted_env() public {\n        vm.setEnv("SEQ_PLANTED", "1");\n    }\n\n    function test_lastClickerIsOwedTenPercent()');
      },
    });
    const r = await build(order(base, { fixRounds: 2 }), dir, t.driver, {});
    assert.equal(r.ok, false);
    assert.match(r.why, /still fail after 2 rounds/);
    const fixes = t.calls.filter((c) => c.role === "fixer");
    assert.equal(fixes.length, 1, "the gates' findings count as a failing round");
    assert.match(fixes[0].prompt, /G2 dependencies: contracts\/test\/games\/lastclick\/LastClick\.t\.sol: import "\.\.\/\.\.\/\.\.\/src\/games\/GameFactory\.sol" is not allowed/);
    assert.match(fixes[0].prompt, /G3 Solidity patterns: contracts\/test\/games\/lastclick\/LastClick\.t\.sol:\d+: cheatcode vm\.setEnv/);
    assert.doesNotMatch(fixes[0].prompt, /forge test fails/, "the suite itself passed");
    assert.equal(t.calls.filter((c) => c.role === "review").length, 0);
    assert.ok(r.report.tests.every((x) => x.pass && x.findings.some((f) => /^G2 /.test(f)) && x.findings.some((f) => /^G3 /.test(f))), "each round's gate findings are in the report");
  });

  test("planted: a game that counts days from 0 passes the suite at forge's timestamp 1 but fails G9's run at the chain's real time, here in the build", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const S = "contracts/src/games/lastclick/LastClick.sol";
    const t = team(dir, {
      edit: (f) => {
        f[S] = f[S].replace("    address public leader;", "    address public leader;\n    uint256 internal lastDay;\n    mapping(uint256 => uint256) internal clicksOn;")
          .replace("        leader = msg.sender;", "        for (uint256 d = lastDay; d < block.timestamp / 1 days; ++d) clicksOn[d + 1] = clicksOn[d] + 1;\n        lastDay = block.timestamp / 1 days;\n        leader = msg.sender;");
      },
    });
    const r = await build(order(base, { fixRounds: 2 }), dir, t.driver, {});
    assert.equal(r.ok, false);
    const fixes = t.calls.filter((c) => c.role === "fixer");
    assert.equal(fixes.length, 1);
    assert.doesNotMatch(fixes[0].prompt, /forge test fails/, "the suite at timestamp 1 passes");
    assert.match(fixes[0].prompt, /G9 fork sim: test_conformance_\w+\(\): Failure: \S/, "G9's failure, with its reason, reaches the fixer");
  });

  test("planted: the same G9 bug next to a banned cheatcode: the static gates already refuse it, so G9's forge run is skipped", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const S = "contracts/src/games/lastclick/LastClick.sol";
    const T = "contracts/test/games/lastclick/LastClick.t.sol";
    const t = team(dir, {
      edit: (f) => {
        f[S] = f[S].replace("    address public leader;", "    address public leader;\n    uint256 internal lastDay;\n    mapping(uint256 => uint256) internal clicksOn;")
          .replace("        leader = msg.sender;", "        for (uint256 d = lastDay; d < block.timestamp / 1 days; ++d) clicksOn[d + 1] = clicksOn[d] + 1;\n        lastDay = block.timestamp / 1 days;\n        leader = msg.sender;");
        f[T] = f[T].replace("    function test_lastClickerIsOwedTenPercent()", '    function test_planted_env() public {\n        vm.setEnv("SEQ_PLANTED", "1");\n    }\n\n    function test_lastClickerIsOwedTenPercent()');
      },
    });
    const r = await build(order(base, { fixRounds: 2 }), dir, t.driver, {});
    assert.equal(r.ok, false);
    const fixes = t.calls.filter((c) => c.role === "fixer");
    assert.equal(fixes.length, 1);
    assert.match(fixes[0].prompt, /G3 Solidity patterns: .*cheatcode vm\.setEnv/);
    assert.doesNotMatch(fixes[0].prompt, /G9 /, "G9 never ran: a build already refused spends nothing on it");
  });

  test("planted: a plan that gives one file to two tasks stops before any worker", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const t = team(dir, { plan: { ...PLAN, tasks: [...PLAN.tasks, { goal: "Write the game contract again.", files: ["contracts/src/games/lastclick/LastClick.sol"] }] } });
    const r = await build(order(base), dir, t.driver, {});
    assert.match(r.why, /one file to two tasks/);
    assert.deepEqual(t.calls.map((c) => c.role), ["lead"]);
  });

  test("a game's plan says which template it copies (or none); one that doesn't stops before any worker", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const { template: _, ...untold } = PLAN;
    const t = team(dir, { plan: untold });
    const r = await build(order(base), dir, t.driver, {});
    assert.match(r.why, /names no template/);
    assert.deepEqual(t.calls.map((c) => c.role), ["lead"]);
    const bad = team(dir, { plan: { ...PLAN, template: "lottery" } });
    assert.match((await build(order(base), dir, bad.driver, {})).why, /plan is not valid/);
  });

  test("past the build's deadline no query starts, and the report still says why", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const t = team(dir);
    const r = await build(order(base), dir, t.driver, {}, Date.now() + 30_000);
    assert.equal(r.ok, false);
    assert.deepEqual(t.calls, []);
    assert.match(r.report.outcome, /^stopped: the lead did not finish/);
  });

  test("a tester that answers too close to the deadline: the suite run doesn't start, the report says why", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    let clock = 0;
    const deadline = 100 * 60_000;
    const t = team(dir);
    const driver = { run: async (q: Query) => { const r = await t.driver.run(q); if (q.role === "tester") clock = deadline - 30_000; return r; } };
    const r = await build(order(base), dir, driver, {}, deadline, () => clock);
    assert.equal(r.ok, false);
    assert.match(r.report.outcome, /^stopped: out of time before the suite run/);
    assert.deepEqual(t.calls.map((c) => c.role), ["lead", "worker", "worker", "worker", "tester"]);
  });

  test("a crash inside the build (the kit can't be copied) still ends in a report, with what was spent", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    rmSync(join(dir, "contracts/lib/forge-std"), { recursive: true, force: true });
    const t = team(dir);
    const r = await build(order(base), dir, t.driver, {});
    assert.equal(r.ok, false);
    assert.match(r.report.outcome, /^error: .*ENOENT/);
    assert.deepEqual(r.report.queries.map((q) => q.role), ["lead", "worker", "worker", "worker", "tester"]);
    assert.ok(r.report.totalUsd > 0);
  });

  test("planted: a plan that writes outside the game's folders stops before any worker", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const t = team(dir, { plan: { ...PLAN, tasks: [...PLAN.tasks, { goal: "Tweak the site's config a little.", files: ["web/next.config.ts"] }] } });
    const r = await build(order(base), dir, t.driver, {});
    assert.match(r.why, /outside the game's folders: web\/next.config.ts/);
    assert.deepEqual(t.calls.map((c) => c.role), ["lead"]);
  });

  test("the order's ceiling stops the team: parallel workers can't spend past it", async () => {
    const { dir, base } = checkout();
    made.push(dir);
    const t = team(dir);
    const r = await build(order(base, { budget: { ceilingUsd: 1, perQueryUsd: { lead: 2, worker: 0.5, tester: 1, fixer: 1, review: 2 } } }), dir, t.driver, {});
    assert.equal(r.ok, false);
    assert.match(r.why, /worker did not finish/);
    assert.ok(r.report.totalUsd <= 1);
  });
});
