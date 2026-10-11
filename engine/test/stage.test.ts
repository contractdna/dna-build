// The staging runs (scripts/stage-*.ts) in --dry mode against the local fakes: each walks the production code end to
// end and writes its report; each refuses an env that could write anywhere. Each run is a child process with a clean env.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  const out = mkdtempSync(join(tmpdir(), "stage-"));
  const r = spawnSync(process.execPath, [new URL(`../scripts/${script}`, import.meta.url).pathname, "--out", out, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 120_000 });
  const report = existsSync(join(out, "report.json")) ? JSON.parse(readFileSync(join(out, "report.json"), "utf8")) : null;
  return { ...r, out, report };
};

test("stage-images --dry: every art event through the studio's gate, the enclave's re-check, the card and the plate; a contact sheet", () => {
  const r = run("stage-images.ts", ["--dry"]);
  assert.equal(r.status, 0, r.stderr);
  const j = r.report;
  assert.deepEqual(j.results.map((x: { event: string }) => x.event), ["outcome", "jackpot_drawn", "ballot_result", "mystery_result", "digest"]);
  assert.equal(j.totals.ready, 5);
  assert.equal(j.candidates.length, 15); // one round of 3 per event: the first round passes
  for (const x of j.results) {
    assert.equal(x.art.enclave, null, x.event);
    assert.ok(x.card.bytes > 0 && !x.card.overLimit);
    assert.ok(existsSync(join(r.out, x.card.file)) && existsSync(join(r.out, x.plate.file)));
    assert.equal(j.candidates.filter((c: { event: string; chosen: boolean }) => c.event === x.event && c.chosen).length, 1);
    assert.ok(x.art.file.startsWith(`cand-${x.event}-`));
  }
  assert.equal(j.visionCalls.length, 5); // the in-enclave check ran on every studio winner, booked in the ledger
  assert.ok(j.visionCalls.every((c: { agent: string; via: string }) => c.agent === "media-check" && c.via === "openrouter"));
  assert.ok(readFileSync(join(r.out, "index.html"), "utf8").includes("card-digest.png"));
});

test("stage-images: the studio's round cap bounds the images; a cap hit is reported, never a crash", () => {
  const r = run("stage-images.ts", ["--dry", "--max-images", "6"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.candidates.length, 6);
  assert.equal(r.report.totals.ready, 2);
  assert.match(JSON.stringify(r.report.results[2].meta.reasons), /daily cap of 2 rounds/);
});

test("stage-x --dry: every event and reply category through the writer and the production filter with the real suffix; reader and scout", () => {
  const r = run("stage-x.ts", ["--dry", "--n", "1", "--mentions", "--scout"]);
  assert.equal(r.status, 0, r.stderr);
  const j = r.report;
  assert.equal(j.events.length, 31);
  assert.equal(j.summary.missedCalls, 0);
  // the synthetic writer's first candidate fails on purpose (a number not in the facts): the filter saw it
  assert.ok(j.summary.issues.some(([k]: [string]) => k === "number N"));
  const drawn = j.events.find((e: { event: string }) => e.event === "jackpot_drawn");
  assert.match(drawn.calls[0].posted, /\nproof \S+\/play\/draw\/12\nhttps:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}$/);
  const reply = j.events.find((e: { event: string }) => e.event === "reply idea");
  assert.equal(reply.suffix, null); // replies carry no link
  assert.equal(j.mentions.rows.length, 16);
  assert.deepEqual(j.mentions.code.map((c: { optOut?: boolean }) => c.optOut), [true, true, false, undefined]);
  assert.ok(j.tone.dropped > 0 && j.tone.kept.length > 0);
  assert.ok(j.spentUsd > 0 && j.spentUsd <= 3);
  assert.ok(readFileSync(join(r.out, "report.md"), "utf8").includes("## What would be posted"));
});

test("staging budget: a model call whose worst case would cross it is refused before it is made", () => {
  const r = run("stage-x.ts", ["--dry", "--n", "1", "--events", "queued", "--budget", "0.0001"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.calls.length, 0);
  assert.ok(r.report.failures.length && r.report.failures.every((f: { refused: boolean }) => f.refused));
});

test("stage-telegram --dry: bot, group and signers checked; alert and a draft through the engine's senders; a press and /ping through its checks", () => {
  const r = run("stage-telegram.ts", ["--dry", "--wait", "1"]);
  assert.equal(r.status, 0, r.stderr);
  const j = r.report;
  assert.equal(j.failed, 0, JSON.stringify(j.checks.filter((c: { ok: boolean }) => !c.ok)));
  assert.deepEqual(j.seen, { press: true, stranger: true, ping: true, keyboardRemoved: true });
  for (const s of ["no webhook (getUpdates works)", "text draft with keyboard delivered", "a press from an id not on the allowlist is refused", "editMessageReplyMarkup without reply_markup removes the keyboard"]) {
    assert.ok(j.checks.some((c: { step: string; ok: boolean }) => c.step === s && c.ok), s);
  }
  // a run that needs the bot token may have it; it still refuses everything else
  const x = run("stage-telegram.ts", ["--dry"], { TELEGRAM_BOT_TOKEN: "tg", X_REFRESH_TOKEN: "xrt-secret" });
  assert.equal(x.status, 2);
  assert.match(x.stderr, /refusing to run with X_REFRESH_TOKEN set/);
});

test("staging env refusal: no wallet key, database URL or token it does not need; values never printed", () => {
  for (const script of ["stage-images.ts", "stage-x.ts"]) {
    for (const [k, v] of [["DATABASE_URL", "postgres://u:hunter2@db/dna"], ["KEEPER_PRIVATE_KEY", "0xdeadbeefsecret"], ["X_REFRESH_TOKEN", "xrt-secret"], ["TELEGRAM_BOT_TOKEN", "tg-secret"], ["STUDIO_TOKEN", "st-secret"], ["PGPASSWORD", "pg-secret"]]) {
      const r = run(script, ["--dry"], { [k]: v });
      assert.equal(r.status, 2, `${script} ${k}`);
      assert.match(r.stderr, new RegExp(`refusing to run with ${k}`));
      assert.ok(!r.stderr.includes(v) && !r.stdout.includes(v));
    }
  }
});
