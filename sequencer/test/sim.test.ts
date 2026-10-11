// The whole workflow offline, its three jobs run as the workflow runs them (the same scripts, as child processes):
// verify a signed order → the dev team builds it through the real Agent SDK against a loopback fake model that
// replays a scripted team (with planted escapes the guard must stop) → publish one App commit and the pull request to
// a loopback fake of GitHub. No model, no network, no secrets.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { canonical } from "../../engine/src/canonical.ts";
import { chainHash, logDigest, type Order, orderRef } from "../../engine/src/seq-order.ts";
import { PROMPT_DEFAULTS } from "../src/roles.ts";
import { checkout } from "./checkout.ts";
import { fakeGitHub } from "./fakegithub.ts";
import { type Block, fakeModel, results, step } from "./fakemodel.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const FIX = join(REPO, "engine/test/fixtures/seq/lastclick");
const hasForge = (() => { try { execFileSync("forge", ["--version"], { stdio: "ignore" }); return existsSync(join(REPO, "contracts/lib/forge-std/src/Test.sol")); } catch { return false; } })();
const files: Record<string, string> = {};
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files[relative(FIX, p)] = readFileSync(p, "utf8"); } };
walk(FIX);
const spec = JSON.parse(files["contracts/src/games/lastclick/SPEC.json"]).spec as string;
const PLAN = {
  title: "Last Click", template: "none", interface: ["click()", "settle()", "leader()", "deadline()", "ROUND()", "PRIZE_BPS()"], tests: ["rounds", "claims"],
  tasks: [
    { goal: "Write the game contract from the spec.", files: ["contracts/src/games/lastclick/LastClick.sol"] },
    { goal: "Write the game's tests with the conformance suite.", files: ["contracts/test/games/lastclick/LastClick.t.sol"] },
    { goal: "Write the page from the template.", files: ["web/app/g/lastclick/page.tsx", "web/app/g/lastclick/page.module.css"] },
  ],
};
const BODY = "Last Click: each click starts or extends a one-hour round. When it runs out the last clicker wins a tenth of the pot. Tested with fuzzing, an invariant and the shared conformance suite.";
const enclave = privateKeyToAccount(`0x${"11".repeat(32)}`);
const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** One of the workflow's scripts as a child process, with only the env the step would give it. */
const node = (script: string, args: string[], env: Record<string, string>) => new Promise<{ status: number; stdout: string; stderr: string }>((ok) =>
  execFile(process.execPath, [join(REPO, "sequencer/src", script), ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, timeout: 10 * 60_000 },
    (e, stdout, stderr) => ok({ status: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));

/** The scripted team, answering as the real models would through the SDK: tool calls, then a structured answer. */
function team(dir: string) {
  const denied: Record<string, string> = {};
  const seen: Record<string, string> = {};
  const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
  const reply = (r: Parameters<Parameters<typeof fakeModel>[0]>[0]): Block[] => {
    const sys = JSON.stringify(r.body.system ?? "");
    // a role is told apart by its job (the defaults: the build runs with no SEQ_PROMPTS here)
    const is = (role: string) => sys.includes(JSON.stringify(PROMPT_DEFAULTS[`seq.job.game.${role}`]).slice(1, -1));
    const said = results(r);
    for (const [id, x] of Object.entries(said)) { seen[id] = x.text; if (x.error) denied[id] = x.text; }
    const n = step(r);
    const plan: Block[] = [];
    if (is("lead")) {
      plan.push(use("lead-kit", "Read", { file_path: join(dir, "contracts/src/games/GameKit.sol") }), use("lead-env", "Read", { file_path: join(dir, "engine/.env") }), use("lead-plan", "StructuredOutput", PLAN));
    } else if (is("worker")) {
      const mine = (JSON.stringify(r.body.messages).match(/FILES YOU WRITE: ([^\\"]+)/)?.[1] ?? "").split(", ").filter(Boolean);
      const k = mine[0].replace(/\W/g, "_");
      plan.push(use(`w-${k}-workflow`, "Write", { file_path: join(dir, ".github/workflows/x.yml"), content: "on: push\n" }));
      mine.forEach((f, i) => plan.push(use(`w-${k}-${i}`, "Write", { file_path: join(dir, f), content: files[f] })));
      if (f0IsContract(mine)) plan.push(use(`w-${k}-build`, "mcp__gates__forge_build", {}));
    } else if (is("tester")) {
      plan.push(use("t-environ", "Read", { file_path: "/proc/self/environ" }), use("t-flag", "mcp__gates__forge_test", { match: "--ffi" }), use("t-run", "mcp__gates__forge_test", {}), use("t-answer", "StructuredOutput", { pass: true, findings: [] }));
    } else if (is("review")) {
      plan.push(use("r-answer", "StructuredOutput", { ready: true, review: "Matches the spec; the suite passes.", prBody: BODY }));
    }
    return plan[n] ? [plan[n]] : [{ type: "text", text: "done" }];
  };
  return { reply, denied, seen };
}
const f0IsContract = (mine: string[]) => mine[0]?.endsWith(".sol") && mine[0].startsWith("contracts/src/");

test("offline: verify → build (real SDK, fake model) → publish (fake GitHub); the guard stops every planted escape", { skip: hasForge ? false : "needs forge and forge-std", timeout: 15 * 60_000 }, async () => {
  const { dir, base } = checkout();
  made.push(dir);
  const pub = mkdtempSync(join(tmpdir(), "seq-sim-base-"));
  made.push(pub);
  execFileSync("git", ["clone", "-q", dir, pub]);
  mkdirSync(join(dir, "engine"), { recursive: true });
  writeFileSync(join(dir, "engine/.env"), "SECRET=1\n");
  const tmp = mkdtempSync(join(tmpdir(), "seq-sim-"));
  made.push(tmp);

  // the enclave's signed order, dispatched
  const o: Order = {
    v: 1, id: "o-sim-0001", build: "b-sim", round: 2, slug: "lastclick", salt: `0x${"ab".repeat(32)}`, factory: "0x5fbdb2315678afecb367f032d93f642f64180aa3", safe: "0x00000000000000000000000000000000000005af",
    baseSha: base, spec, specSha256: createHash("sha256").update(spec).digest("hex"), rubric: { value: 4, fit: 5, clarity: 4, originality: 3 },
    models: { lead: "anthropic/claude-opus-5.5", worker: "anthropic/claude-haiku-5.5", tester: "anthropic/claude-sonnet-5.5", fixer: "anthropic/claude-sonnet-5.5", review: "anthropic/claude-opus-5.5" },
    effort: { lead: "medium", worker: "max", tester: "high", fixer: "high", review: "high" },
    budget: { ceilingUsd: 12, perQueryUsd: { lead: 2, worker: 0.5, tester: 1, fixer: 1, review: 2 } }, fixRounds: 3, issues: ["the first round paid the prize twice"], expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
  };
  const body = canonical(o);
  const eprev = "00".repeat(32);
  const ehash = chainHash(Buffer.from(eprev, "hex"), body).toString("hex");
  const esig = await enclave.signMessage({ message: { raw: `0x${logDigest(ehash, "build", orderRef(o))}` } });
  writeFileSync(join(tmp, "payload.json"), JSON.stringify({ seq: "9", kind: "build", ref: orderRef(o), body, eprev, ehash, esig }));
  writeFileSync(join(tmp, "release.json"), JSON.stringify({ logSigner: enclave.address }));
  writeFileSync(join(tmp, "release-null.json"), JSON.stringify({ logSigner: null }));

  // job 1: verify
  const verifyArgs = (release: string) => ["--payload", join(tmp, "payload.json"), "--out", join(tmp, "order.json"), "--release", join(tmp, release)];
  assert.match((await node("verify.ts", verifyArgs("release-null.json"), { GITHUB_RUN_ATTEMPT: "1" })).stderr, /no enclave log signer/);
  assert.match((await node("verify.ts", verifyArgs("release.json"), { GITHUB_RUN_ATTEMPT: "2" })).stderr, /run attempt 2/);
  writeFileSync(join(tmp, "gh-output"), "");
  const runs = [{ id: 4242, display_title: `seq ${orderRef(o)}`, status: "in_progress" }, { id: 4241, display_title: "seq order:o-sim-0000", status: "completed" }];
  const vgh = await fakeGitHub(runs);
  try {
    const venv = { GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "4242", GITHUB_TOKEN: "ro-token", SEQ_GITHUB_API: vgh.url };
    const v = await node("verify.ts", verifyArgs("release.json"), { ...venv, GITHUB_OUTPUT: join(tmp, "gh-output") });
    assert.equal(v.status, 0, v.stderr);
    assert.match(readFileSync(join(tmp, "gh-output"), "utf8"), new RegExp(`base_sha=${base}\nslug=lastclick\nid=o-sim-0001\nround=2`));
    assert.equal(vgh.calls.length, 1);
    assert.equal(vgh.calls[0].auth, "Bearer ro-token");
    // the same signed order dispatched again inside its window: a second run, refused (every status: verify.test.ts)
    const again = await node("verify.ts", verifyArgs("release.json"), { ...venv, GITHUB_RUN_ID: "4243" });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /refused: order:o-sim-0001 already has run 4242 \(in_progress\)/);
  } finally {
    await vgh.close();
  }

  // job 2: build, the real SDK against the fake model
  const t = team(dir);
  const model = await fakeModel(t.reply);
  const out = join(tmp, "out");
  try {
    const env = { GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "4242", OPENROUTER_API_KEY_SEQUENCER: "sim-key", SEQ_MODEL_API: model.url };
    const args = ["--order", join(tmp, "order.json"), "--out", out, "--root", dir];
    assert.match((await node("run.ts", args, { ...env, GITHUB_RUN_ATTEMPT: "2" })).stderr, /run attempt 2/);
    const b = await node("run.ts", args, env);
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /^ready: Last Click/);
  } finally {
    await model.close();
  }
  // every planted escape was refused, and nothing landed outside the game's folders
  const deniedIds = Object.keys(t.denied);
  assert.ok(deniedIds.includes("lead-env"), "the lead can't read the env file");
  assert.ok(deniedIds.filter((id) => id.endsWith("-workflow")).length === 3, "no worker can write a workflow");
  assert.ok(deniedIds.includes("t-environ") && deniedIds.includes("t-flag"), "the tester can't read /proc or pass forge a flag");
  assert.ok(!deniedIds.includes("t-run") && !deniedIds.includes("lead-kit"));
  assert.match(t.seen["t-run"], /"text":"OK\\n[\s\S]*0 failed/, "the tester ran the suite through the gates tool");
  assert.match(t.seen["w-contracts_src_games_lastclick_LastClick_sol-build"], /"text":"OK\\n/, "the contract worker compiled through the gates tool");
  assert.ok(!existsSync(join(dir, ".github")));
  const calls = model.requests.filter((q) => q.path.endsWith("/v1/messages"));
  assert.ok(calls.every((c) => c.headers.authorization === "Bearer sim-key"));
  assert.ok(calls.every((c) => JSON.stringify(c.body.messages).includes("the first round paid the prize twice")), "the issues reach every role");

  // what the build job uploads
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  assert.deepEqual(report.queries.map((q: { role: string }) => q.role).sort(), ["lead", "review", "tester", "worker", "worker", "worker"]);
  assert.ok(report.queries.every((q: { costUsd: number; subtype: string }) => q.costUsd > 0 && q.subtype === "success"));
  assert.deepEqual([report.orderId, report.round, report.runId, report.runAttempt, report.outcome], ["o-sim-0001", 2, "4242", "1", "pr"]);
  assert.ok(report.totalUsd > 0 && report.totalUsd <= 12 - 3);
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf8")).title, "Last Click");
  assert.equal(readFileSync(join(out, "pr.md"), "utf8").trim(), BODY);
  const patch = readFileSync(join(out, "patch.diff"), "utf8");
  assert.ok(patch.includes("+++ b/web/app/g/lastclick/game.json") && patch.includes("+++ b/contracts/src/games/lastclick/SPEC.json"));

  // job 3: publish, to the fake GitHub, applying the patch to the base as data
  const gh = await fakeGitHub();
  try {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const args = ["--order", join(tmp, "order.json"), "--patch", join(out, "patch.diff"), "--body", join(out, "pr.md"), "--title", "Last Click", "--root", pub];
    const env = { GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "o/r", SEQ_APP_ID: "123", SEQ_APP_KEY: key, SEQ_GITHUB_API: gh.url };
    assert.match((await node("publish.ts", args, { ...env, GITHUB_RUN_ATTEMPT: "2" })).stderr, /run attempt 2/);
    assert.equal(gh.calls.length, 0);
    const p = await node("publish.ts", args, env);
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /^opened #12 on seq\/o-sim-0001-r2 \(c1\)$/m);
    const tok = gh.calls.find((c) => c.path === "/app/installations/7/access_tokens")!;
    assert.deepEqual(tok.body, { repositories: ["r"], permissions: { contents: "write", pull_requests: "write" } });
    assert.match(tok.auth, /^Bearer eyJ/);
    const repoCalls = gh.calls.filter((c) => c.path.startsWith("/repos/o/r/") && c.path !== "/repos/o/r/installation");
    assert.ok(repoCalls.every((c) => c.auth === "Bearer inst-token"));
    assert.equal(gh.calls.filter((c) => c.path === "/repos/o/r/git/commits" && c.method === "POST").length, 1, "exactly one commit");
    const commit = gh.calls.find((c) => c.path === "/repos/o/r/git/commits" && c.method === "POST")!.body!;
    assert.deepEqual(commit.parents, [base]);
    const tree = gh.calls.find((c) => c.path === "/repos/o/r/git/trees")!.body as { tree: { path: string }[] };
    assert.deepEqual(tree.tree.map((e) => e.path).sort(), [
      "contracts/src/games/lastclick/LastClick.sol", "contracts/src/games/lastclick/SPEC.json", "contracts/test/games/lastclick/LastClick.t.sol",
      "web/app/g/lastclick/game.json", "web/app/g/lastclick/page.module.css", "web/app/g/lastclick/page.tsx",
    ]);
    const pr = gh.calls.find((c) => c.method === "POST" && c.path === "/repos/o/r/pulls")!.body!;
    assert.deepEqual([pr.title, pr.head, pr.base, pr.body], ["Sequencer: Last Click", "seq/o-sim-0001-r2", "main", BODY]);
  } finally {
    await gh.close();
  }
});
