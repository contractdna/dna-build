// The enclave's GitHub client against a local fake (scripts/fake-github.ts): GitHub's answers are data. A blob that
// does not hash to its id is refused; the change list comes from the two trees (deletes, mode changes, symlinks,
// binaries all show); a merge is pinned to the gated head; `release` only moves forward; runs are found by their
// run-name; artifact zips are read; the token's expiry is read off every answer.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startFakeGitHub } from "../scripts/fake-github.ts";

const fake = await startFakeGitHub();
Object.assign(process.env, { GITHUB_API_BASE: fake.url, GITHUB_REPO: fake.repo, GITHUB_TOKEN: fake.token });
const gh = await import("../src/github.ts");
gh.GH.api = fake.url;
gh.GH.repo = fake.repo;
after(() => fake.close());

let base = "";
before(() => {
  base = fake.commitFiles(null, { "README.md": "dna\n", "contracts/src/DNAHook.sol": "contract H {}\n", "web/app/g/old/page.tsx": "x\n" });
  fake.refs.set("main", base);
  fake.refs.set("release", base);
});

test("blobs: the bytes must hash to the id GitHub was asked for", async () => {
  const [, f] = Object.entries(fake.filesOf(base))[0];
  assert.equal((await gh.blob(f.sha)).toString(), "dna\n");
  fake.knobs.tamper.add(f.sha);
  await assert.rejects(gh.blob(f.sha), /does not hash/);
  fake.knobs.tamper.clear();
});

test("changedFiles: from both trees, every kind of change, verified text", async () => {
  const head = fake.commitFiles(base, {
    "contracts/src/games/dice/Dice.sol": "contract Dice {}\n",
    "web/app/g/old/page.tsx": null,
    "web/app/g/dice/link": { text: "../../../.env", mode: "120000" },
    "web/app/g/dice/run.sh": { text: "echo\n", mode: "100755" },
    "web/app/g/dice/img.bin": "a\u0000b",
  });
  const { changes, texts } = await gh.changedFiles(base, head);
  const by = Object.fromEntries(changes.map((c) => [c.path, c]));
  assert.equal(by["contracts/src/games/dice/Dice.sol"].status, "A");
  assert.equal(texts["contracts/src/games/dice/Dice.sol"], "contract Dice {}\n");
  assert.equal(by["web/app/g/old/page.tsx"].status, "D");
  assert.equal(by["web/app/g/dice/link"].mode, "120000");
  assert.equal(texts["web/app/g/dice/link"], undefined, "a symlink's target is never read as a file");
  assert.equal(by["web/app/g/dice/run.sh"].mode, "100755");
  assert.equal(by["web/app/g/dice/img.bin"].binary, true);
  assert.equal(by["README.md"], undefined, "unchanged files are not listed");
  const t = await gh.treeOf(head);
  assert.deepEqual(Object.keys(gh.treeHashes(t, ["contracts/src/games/dice/"])), ["contracts/src/games/dice/Dice.sol"]);
  assert.equal(gh.hasPrefix(t, "web/app/g/old/"), false);
  assert.equal(gh.hasPrefix(await gh.treeOf(base), "web/app/g/old/"), true);
});

test("merge: pinned to the gated sha (a moved head is refused); release moves forward only", async () => {
  const head = fake.commitFiles(base, { "contracts/src/games/coin/Coin.sol": "contract Coin {}\n" }, fake.byBot);
  const pr = fake.openPull("seq/b1-r1-r1", head, base);
  const found = await gh.pullOn("seq/b1-r1-r1");
  assert.equal(found?.number, pr.number);
  assert.equal(found?.head.sha, head);
  assert.deepEqual((await gh.pullCommits(pr.number)).map((c) => c.sha), [head]);
  // the PR moved after it was gated
  const moved = fake.commitFiles(head, { "contracts/src/games/coin/Coin.sol": "contract Coin { uint x; }\n" }, fake.byBot);
  fake.refs.set(pr.branch, moved);
  await assert.rejects(gh.merge(pr.number, head), (e) => e instanceof gh.GitHubError && e.status === 409);
  fake.refs.set(pr.branch, head);
  const m = await gh.merge(pr.number, head);
  assert.equal(await gh.refSha("main"), m);
  const t = await gh.treeOf(m);
  assert.deepEqual(gh.treeHashes(t, ["contracts/src/games/coin/"]), gh.treeHashes(await gh.treeOf(head), ["contracts/src/games/coin/"]));
  await gh.fastForward("release", m);
  assert.equal(await gh.refSha("release"), m);
  // a commit that does not descend from release: GitHub refuses (no force push ever)
  const side = fake.commitFiles(base, { "x.txt": "x\n" });
  await assert.rejects(gh.fastForward("release", side), (e) => e instanceof gh.GitHubError && e.status === 422);
  assert.equal(await gh.refSha("release"), m);
  assert.ok(fake.calls.filter((c) => c.method === "PATCH" && c.path.includes("/git/refs/")).every((c) => c.body.force === false));
});

test("runs by run-name; report.json out of the artifact zip; dispatch carries the record", async () => {
  fake.addRun("seq order:other");
  const run = fake.addRun("seq order:b2-r1", { artifacts: { build: { "report.json": Buffer.from('{"totalUsd":3.5}'), "pr.md": Buffer.from("hi") } } });
  const runs = await gh.runsFor("order:b2-r1");
  assert.deepEqual(runs.map((r) => r.id), [run.id]);
  assert.equal((await gh.artifactFile(run.id, "build", "report.json"))?.toString(), '{"totalUsd":3.5}');
  assert.equal(await gh.artifactFile(run.id, "order", "order.json"), null);
  assert.equal((await gh.runOf(run.id)).run_attempt, 1);
  await gh.dispatch({ seq: "1", kind: "build" });
  assert.deepEqual(fake.dispatches.at(-1), { event_type: "sequencer-build", client_payload: { seq: "1", kind: "build" } });
});

test("downloads are capped: by Content-Length and while streaming", async () => {
  assert.equal((await gh.capped(new Response("abc"), 3)).toString(), "abc");
  await assert.rejects(gh.capped(new Response("abcd"), 3), /over 3 bytes/);
  await assert.rejects(gh.capped(new Response("a", { headers: { "content-length": "99" } }), 3), /over 3 bytes/);
});

test("token expiry: read off every answer; outages are told apart from refusals", async () => {
  assert.equal(gh.expiryOf("2026-12-01 10:00:00 UTC"), Date.parse("2026-12-01T10:00:00Z"));
  assert.equal(gh.expiryOf("2026-12-01 10:00:00 -0800"), Date.parse("2026-12-01T18:00:00Z"));
  fake.knobs.tokenExpiry = "2026-10-20 00:00:00 UTC";
  await gh.refSha("main");
  assert.equal(Math.round(gh.tokenDaysLeft(Date.parse("2026-10-10T00:00:00Z"))!), 10);
  fake.knobs.fail = { status: 502, path: /git\/ref\/heads\/main/ };
  await assert.rejects(gh.refSha("main"), (e) => gh.outage(e));
  fake.knobs.fail = { status: 404, path: /git\/ref\/heads\/main/ };
  await assert.rejects(gh.refSha("main"), (e) => !gh.outage(e));
  fake.knobs.fail = null;
});

test("CI's Slither advice: only findings in the build's own folder; the shared kit's are left out", () => {
  // shaped like a real build's report (dna-build PR 6): four in GameKit.sol, one in the game
  const at = (f: string) => ({ source_mapping: { filename_relative: `pr/contracts/src/games/${f}` } });
  const report = JSON.stringify({ results: { detectors: [
    { check: "incorrect-equality", impact: "Medium", description: "GameKit._send(address,uint256) (src/games/GameKit.sol#131-135) uses a dangerous strict equality", elements: [at("GameKit.sol")] },
    { check: "missing-zero-check", impact: "Low", description: "WordHunt.setKeeper(address).who (src/games/word-hunt-1000006/WordHunt.sol#50) lacks a zero-check", elements: [at("word-hunt-1000006/WordHunt.sol")] },
    { check: "timestamp", impact: "Low", description: "GameKit.sweep() (src/games/GameKit.sol#88-95) uses timestamp for comparisons", elements: [at("GameKit.sol")] },
    { check: "dead-code", impact: "Informational", description: "GameKit._credit(address,uint256) (src/games/GameKit.sol#119-126) is never used", elements: [at("GameKit.sol")] },
    { check: "reentrancy-events", impact: "Low", description: "Reentrancy in WordHunt.play() (src/games/word-hunt-1000006/WordHunt.sol#70-80) through GameKit._send" },
  ] } });
  assert.deepEqual(gh.slitherFindings(report).map((f) => f.check), ["missing-zero-check", "reentrancy-events"]);
  assert.deepEqual(gh.slitherFindings("not json"), []);
});
