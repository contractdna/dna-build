// Publishing a build: one API commit by the App on the order's branch and the pull request, nothing else;
// a patch or a text that breaks the rules never reaches GitHub. Against a local fake of the REST API.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { checkout } from "./checkout.ts";
import { fakeGitHub } from "./fakegithub.ts";

const gh = await fakeGitHub();
const calls = gh.calls;
process.env.SEQ_GITHUB_API = gh.url;
const pub = await import("../src/publish.ts");
after(() => gh.close());

const REPO = new URL("../..", import.meta.url).pathname;
const FIX = join(REPO, "engine/test/fixtures/seq/lastclick");
const BODY = "Last Click: each click starts or extends a one-hour round. When it runs out the last clicker wins a tenth of the pot.";
const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** The fixture game as a patch against a fresh checkout, plus a second fresh checkout to publish from. */
function patchAndBase(extra: Record<string, string> = {}) {
  const a = checkout();
  made.push(a.dir);
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else { const rel = relative(FIX, p); mkdirSync(dirname(join(a.dir, rel)), { recursive: true }); writeFileSync(join(a.dir, rel), readFileSync(p)); } } };
  walk(FIX);
  for (const [p, t] of Object.entries(extra)) { mkdirSync(dirname(join(a.dir, p)), { recursive: true }); writeFileSync(join(a.dir, p), t); }
  execFileSync("git", ["-C", a.dir, "add", "-A"]);
  const patch = execFileSync("git", ["-C", a.dir, "diff", "--cached", "--binary", "HEAD"]).toString();
  const b = checkout();
  made.push(b.dir);
  return { patch, dir: b.dir, base: b.base };
}
const order = (base: string, round = 1) => ({ v: 1 as const, id: "o-test-0001", build: "b", round, slug: "lastclick", salt: `0x${"ab".repeat(32)}`, factory: `0x${"cd".repeat(20)}`, safe: `0x${"ef".repeat(20)}`, baseSha: base, spec: "x".repeat(20), specSha256: "0".repeat(64), rubric: { value: 1, fit: 1, clarity: 1, originality: 1 }, models: { lead: "anthropic/claude-opus-5.5", worker: "anthropic/claude-haiku-5.5", tester: "anthropic/claude-sonnet-5.5", fixer: "anthropic/claude-sonnet-5.5", review: "anthropic/claude-opus-5.5" }, effort: { lead: "high" as const, worker: "high" as const, tester: "high" as const, fixer: "high" as const, review: "high" as const }, budget: { ceilingUsd: 12, perQueryUsd: { lead: 2, worker: 0.5, tester: 1, fixer: 1, review: 2 } }, fixRounds: 3, issues: [], expiresAt: "2099-01-01T00:00:00Z" });

test("one commit through the API (no author: GitHub signs it), on the order's branch, a PR; no other pull request touched", async () => {
  const { patch, dir, base } = patchAndBase();
  calls.length = 0;
  const p = await pub.publish(order(base, 2), patch, BODY, "Last Click", dir, "o/r", "tok");
  assert.deepEqual(p, { pr: 12, sha: "c1", branch: "seq/o-test-0001-r2" });
  const commit = calls.find((c) => c.path === "/repos/o/r/git/commits")!.body!;
  assert.deepEqual(commit.parents, [base]);
  assert.equal(commit.author, undefined);
  assert.equal(commit.committer, undefined);
  const tree = calls.find((c) => c.path === "/repos/o/r/git/trees")!.body as { base_tree: string; tree: { path: string; mode: string }[] };
  assert.equal(tree.base_tree, "t0");
  assert.ok(tree.tree.every((e) => e.mode === "100644" && /^(contracts\/src\/games|contracts\/test\/games|web\/app\/g)\/lastclick\//.test(e.path)));
  assert.equal(tree.tree.length, 6);
  assert.deepEqual(calls.find((c) => c.path === "/repos/o/r/git/refs")!.body, { ref: "refs/heads/seq/o-test-0001-r2", sha: "c1" });
  const pr = calls.find((c) => c.method === "POST" && c.path === "/repos/o/r/pulls")!.body!;
  assert.deepEqual([pr.head, pr.base, pr.body, pr.maintainer_can_modify], ["seq/o-test-0001-r2", "main", BODY, false]);
  assert.ok(calls.every((c) => c.auth === "Bearer tok"));
  // the previous round's pull request is the engine's to close (next()): publish reads or changes no other one
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`).filter((x) => x !== "POST /repos/o/r/git/blobs"), [
    `GET /repos/o/r/git/commits/${base}`, "POST /repos/o/r/git/trees", "POST /repos/o/r/git/commits", "POST /repos/o/r/git/refs", "POST /repos/o/r/pulls",
  ]);
});

for (const [what, extra, body, want] of [
  ["a file outside the game's folders", { ".github/workflows/x.yml": "on: push\n" }, BODY, /outside the game's folders/],
  ["a link in the PR text", {}, "See https://x.example for the game.", /PR body: url/],
  ["a key in a file", { "web/app/g/lastclick/k.tsx": "export const k = 'sk-ant-api03-abcdefghijklmnop';\n" }, BODY, /key-shaped/],
] as [string, Record<string, string>, string, RegExp][]) {
  test(`planted: ${what} is refused before any call to GitHub`, async () => {
    const { patch, dir, base } = patchAndBase(extra);
    calls.length = 0;
    await assert.rejects(pub.publish(order(base), patch, body, "Last Click", dir, "o/r", "tok"), want);
    assert.equal(calls.length, 0);
  });
}

/** A site change as a patch (no game) against a fresh checkout, plus a second fresh checkout to publish from. */
function sitePatch(files: Record<string, string>) {
  const a = checkout();
  made.push(a.dir);
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(a.dir, p)), { recursive: true }); writeFileSync(join(a.dir, p), t); }
  execFileSync("git", ["-C", a.dir, "add", "-A"]);
  const patch = execFileSync("git", ["-C", a.dir, "diff", "--cached", "--binary", "HEAD"]).toString();
  const b = checkout();
  made.push(b.dir);
  return { patch, dir: b.dir, base: b.base };
}
const SITE_BODY = "A questions page with plain answers about who decides what ships.";

test("a site order: its pages and docs go out as one commit and a pull request", async () => {
  const { patch, dir, base } = sitePatch({ "web/app/questions/page.tsx": "export default function Q() { return <main>Questions</main>; }\n", "docs/QUESTIONS.md": "# Questions\n" });
  calls.length = 0;
  const p = await pub.publish({ ...order(base), kind: "site", slug: "questions-7" }, patch, SITE_BODY, "Questions", dir, "o/r", "tok");
  assert.equal(p.branch, "seq/o-test-0001-r1");
  const tree = calls.find((c) => c.path.endsWith("/git/trees"))!.body as { tree: { path: string }[] };
  assert.deepEqual(tree.tree.map((x) => x.path).sort(), ["docs/QUESTIONS.md", "web/app/questions/page.tsx"]);
});

for (const [what, file, want] of [
  ["the wallet guard", "web/app/_ui/guard.ts", /web\/app\/_ui\/guard\.ts: never reachable \(the site's security layer\)/],
  ["the hook", "contracts/src/DNAHook.sol", /contracts\/src\/DNAHook\.sol: never reachable \(the hook\)/],
  ["a workflow", ".github/workflows/x.yml", /never reachable \(the repository's workflows and settings\)/],
  ["the engine's transaction guards", "engine/src/tx.ts", /never reachable \(the transaction guards\)/],
] as const) {
  test(`planted: a site order whose patch touches ${what} is refused before any call to GitHub`, async () => {
    const { patch, dir, base } = sitePatch({ "web/app/questions/page.tsx": "export default function Q() { return null; }\n", [file]: "x\n" });
    calls.length = 0;
    await assert.rejects(pub.publish({ ...order(base), kind: "site", slug: "questions-7" }, patch, SITE_BODY, "Questions", dir, "o/r", "tok"), want);
    assert.equal(calls.length, 0);
  });
}

for (const [what, title, want] of [
  ["a link in the title", "Play at https://x.example", /title/],
  ["a handle in the title", "Last Click by @someone", /title/],
  ["a second line in the title", "Last Click\nRun this", /title/],
  ["an em dash in the title", "Last Click — a game", /title/],
] as [string, string, RegExp][]) {
  test(`planted: ${what} is refused before any call to GitHub`, async () => {
    const { patch, dir, base } = patchAndBase();
    calls.length = 0;
    await assert.rejects(pub.publish(order(base), patch, BODY, title, dir, "o/r", "tok"), want);
    assert.equal(calls.length, 0);
  });
}

test("the App's JWT is RS256 over its id, valid for 9 minutes", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = pub.appJwt("1234", privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 1_000_000);
  const [h, b, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(b, "base64url").toString()), { iat: 999_940, exp: 1_000_540, iss: "1234" });
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(s, "base64url")));
});
