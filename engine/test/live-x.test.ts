// The public X test (scripts/live-x.ts) offline, against the local fakes: its guards, the rotated token handed to the
// store before anything posts, the caps, and the cleanup (every post deleted in the finally block, a failed delete
// reported loudly). Each run is a child process with a clean env.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/live-x.ts", import.meta.url).pathname;
/** A token store that keeps what it gets on stdin (or fails, `fail`). */
function sink(fail = false) {
  const d = mkdtempSync(join(tmpdir(), "sink-"));
  const f = join(d, "sink.sh");
  writeFileSync(f, fail ? "#!/bin/sh\ncat >/dev/null\nexit 3\n" : `#!/bin/sh\n[ "$1" = store-token ] || exit 9\ncat > "${d}/stored"\n`, { mode: 0o755 });
  return { path: f, stored: () => (existsSync(join(d, "stored")) ? readFileSync(join(d, "stored"), "utf8") : null) };
}
const run = (args: string[], env: Record<string, string> = {}) => {
  const out = mkdtempSync(join(tmpdir(), "live-x-"));
  const r = spawnSync(process.execPath, [script, "--out", out, "--delete-after", "0", ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 120_000 });
  const report = existsSync(join(out, "report.json")) ? JSON.parse(readFileSync(join(out, "report.json"), "utf8")) : null;
  return { ...r, out, report };
};

test("live-x: refuses without --i-have-a-go, before any network or token use; refuses a wallet key or a database URL", () => {
  const s = sink();
  const r = run(["--dry"], { LIVE_X_TOKEN_SINK: s.path });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /only with --i-have-a-go/);
  assert.equal(r.report, null);
  assert.equal(s.stored(), null);
  for (const [k, v] of [["DATABASE_URL", "postgres://u:pw@db/dna"], ["AGENT_PRIVATE_KEY", "0xsecretkey"], ["TELEGRAM_BOT_TOKEN", "tg-secret"]]) {
    const b = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: s.path, [k]: v });
    assert.equal(b.status, 2, k);
    assert.ok(!b.stderr.includes(v) && !b.stdout.includes(v));
  }
});

test("live-x: one image, one post, two replies to that post, read back, all deleted; the rotated token stored first", () => {
  const s = sink();
  const r = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: s.path });
  assert.equal(r.status, 0, r.stderr);
  assert.match(s.stored() ?? "", /^fake-refresh-\d+\n$/);
  assert.ok(!r.stdout.includes("fake-refresh") && !r.stderr.includes("fake-refresh"), "the token is never printed");
  const j = r.report;
  assert.equal(j.image.generated, 1);
  assert.equal(j.image.source, "studio");
  assert.ok(existsSync(j.image.art) && existsSync(j.image.card));
  assert.match(j.postUrl, /^https:\/\/x\.com\/fake_account\/status\/\d+$/);
  assert.deepEqual(j.checks.filter((c: { ok: boolean }) => !c.ok), []);
  assert.deepEqual(j.checks.map((c: { what: string }) => c.what), ["post text", "post media", "reply fixed text", "reply fixed threaded", "reply writer text", "reply writer threaded", "deleted reply writer", "deleted reply fixed", "deleted post"]);
  assert.equal(j.filter.picked, "Synthetic post about a reply event."); // the synthetic writer's first candidate fails the filter
  assert.ok(JSON.parse(r.stdout).rateLimits.post);
});

test("live-x: a reply that fails still deletes the post (finally); a failed delete prints the ids loudly and fails the run", () => {
  const a = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: sink().path, LIVE_X_DRY_FAIL: "reply" });
  assert.equal(a.status, 1);
  assert.match(a.report.error, /reply fixed: POST \/2\/tweets 503/);
  assert.deepEqual(a.report.checks.filter((c: { what: string }) => c.what.startsWith("deleted")).map((c: { what: string; ok: boolean }) => [c.what, c.ok]), [["deleted post", true]]);
  const b = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: sink().path, LIVE_X_DRY_FAIL: "delete" });
  assert.equal(b.status, 1);
  assert.equal(b.report.NOT_DELETED.length, 3);
  assert.match(b.stderr, /NOT DELETED, delete these by hand on @fake_account: \d+, \d+, \d+/);
});

test("live-x: a token store that fails posts nothing; the rotated token is kept in a private file", () => {
  const r = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: sink(true).path });
  assert.equal(r.status, 1);
  assert.match(r.report.error, /token store failed .* Nothing was posted/);
  assert.equal(r.report.postUrl, undefined);
  const f = r.report.tokenFile;
  assert.ok(!f.startsWith(r.out) && !f.includes("/engine/"), "the fallback file is a temp file, never in the repository");
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test("live-x: a post X created but answered with an error is found among the account's posts and deleted", () => {
  const r = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: sink().path, LIVE_X_DRY_FAIL: "accepted" });
  assert.equal(r.status, 1);
  assert.match(r.report.error, /reply fixed: POST \/2\/tweets 503/);
  const deleted = r.report.checks.filter((c: { what: string }) => c.what.startsWith("deleted")).map((c: { what: string; ok: boolean }) => [c.what, c.ok]);
  assert.deepEqual(deleted, [["deleted post", true], ["deleted orphan", true]]);
  assert.equal(r.report.NOT_DELETED, undefined);
});

test("live-x: Ctrl-C during the viewing wait deletes everything at once and fails the run; a second Ctrl-C never skips it", async () => {
  const out = mkdtempSync(join(tmpdir(), "live-x-"));
  // the cleanup is slowed (each delete 400 ms) so the second Ctrl-C lands inside it
  const child = spawn(process.execPath, [script, "--out", out, "--delete-after", "60", "--i-have-a-go", "--dry"], { env: { PATH: process.env.PATH ?? "", LIVE_X_TOKEN_SINK: sink().path, LIVE_X_DRY_DELETE_MS: "400" } });
  let err = "";
  let sent = 0;
  const t0 = Date.now();
  child.stderr.on("data", (d) => {
    err += d;
    if (sent === 0 && /deleting in 60 s/.test(err)) { sent = 1; child.kill("SIGINT"); }
    if (sent === 1 && /interrupted \(SIGINT\): deleting/.test(err)) { sent = 2; setTimeout(() => child.kill("SIGINT"), 100); }
  });
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  assert.equal(code, 1, err);
  assert.ok(Date.now() - t0 < 30_000, "the wait ended at the first Ctrl-C");
  const j = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  assert.deepEqual(j.checks.filter((c: { what: string }) => c.what.startsWith("deleted")).map((c: { ok: boolean }) => c.ok), [true, true, true]);
  assert.match(err, /cleaning up, please wait/);
});

test("live-x: a kill (SIGTERM) or a closed terminal (SIGHUP) during the viewing wait still deletes everything", async () => {
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    const out = mkdtempSync(join(tmpdir(), "live-x-"));
    const child = spawn(process.execPath, [script, "--out", out, "--delete-after", "60", "--i-have-a-go", "--dry"], { env: { PATH: process.env.PATH ?? "", LIVE_X_TOKEN_SINK: sink().path } });
    let err = "";
    child.stderr.on("data", (d) => { err += d; if (/deleting in 60 s/.test(err) && !child.killed) child.kill(sig); });
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    assert.equal(code, 1, `${sig}: ${err}`);
    const j = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    assert.deepEqual(j.checks.filter((c: { what: string }) => c.what.startsWith("deleted")).map((c: { ok: boolean }) => c.ok), [true, true, true], sig);
  }
});

test("live-x: own posts that can't be listed after a failed post: a banner sends a human to check the account", () => {
  const r = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: sink().path, LIVE_X_DRY_FAIL: "reply", LIVE_X_DRY_LIST_STATUS: "429" });
  assert.equal(r.status, 1);
  assert.equal(r.report.LIST_FAILED, true);
  assert.match(r.stderr, /!{72}\n.*could not list own posts: check @fake_account by hand/s);
});

test("live-x: X's HTML-escaped text (&, <, >) still matches ours: the writer's reply checks out, and an orphan of it is deleted", () => {
  const writer = "Rules & limits: the cap is the cap, <always>.";
  const ok = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: sink().path, LIVE_X_DRY_WRITER: writer });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.report.checks.some((c: { what: string; ok: boolean }) => c.what === "reply writer text" && c.ok));
  const orphan = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: sink().path, LIVE_X_DRY_WRITER: writer, LIVE_X_DRY_FAIL: "accepted-writer" });
  assert.equal(orphan.status, 1);
  assert.ok(orphan.report.checks.some((c: { what: string; ok: boolean }) => c.what === "deleted orphan" && c.ok), JSON.stringify(orphan.report.checks));
  assert.equal(orphan.report.UNKNOWN_POSTS, undefined);
});

test("live-x: X's trailing t.co media link on the post still matches ours (an orphan with it is deleted); any other suffix fails the check", () => {
  // the dry fake appends ` https://t.co/…` to a post with media, as X does
  const ok = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: sink().path });
  assert.ok(ok.report.checks.some((c: { what: string; ok: boolean; detail?: string }) => c.what === "post text" && c.ok && /\shttps:\/\/t\.co\/\w+$/.test(c.detail ?? "")), JSON.stringify(ok.report.checks));
  const orphan = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: sink().path, LIVE_X_DRY_FAIL: "accepted" });
  assert.deepEqual(orphan.report.checks.filter((c: { what: string }) => c.what === "deleted orphan").map((c: { ok: boolean }) => c.ok), [true]);
  for (const link of ["https://example.com/Ab12", "https://t.co/Ab12 extra", "https://t.co.evil/Ab12"]) {
    const bad = run(["--i-have-a-go", "--dry"], { LIVE_X_TOKEN_SINK: sink().path, LIVE_X_DRY_MEDIA_LINK: link });
    assert.equal(bad.status, 1, link);
    assert.ok(bad.report.checks.some((c: { what: string; ok: boolean }) => c.what === "post text" && !c.ok), link);
  }
});
