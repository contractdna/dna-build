// The live-trial harness (scripts/trial.ts) in --dry mode (the local fakes' synthetic answers, a synthetic swap set, no
// network), its trial budget, and its env refusal. Each run is a child process with a clean env.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/trial.ts", import.meta.url).pathname;
const run = (args: string[], env: Record<string, string> = {}) => {
  const out = mkdtempSync(join(tmpdir(), "trial-"));
  const r = spawnSync(process.execPath, [script, "--out", out, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 120_000 });
  const files = readdirSync(out);
  const json = files.find((f) => f.endsWith(".json"));
  return { ...r, files, report: json ? JSON.parse(readFileSync(join(out, json), "utf8")) : null, md: json ? readFileSync(join(out, json.replace(/json$/, "md")), "utf8") : "" };
};

test("trial --dry: every step runs through the production calls, booked in the in-memory ledger, and both reports are written", () => {
  const r = run(["--dry"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.files.length, 2);
  const j = r.report;
  assert.equal(j.engineMode, "dry_run");
  assert.match(j.mode, /^dry/);
  assert.deepEqual(j.steps.map((s: { name: string }) => s.name), ["market", "intake", "round", "build", "reward", "research", "hypothesis", "red-team", "note", "post", "tryout-intake", "tryout-brain"]);
  for (const s of j.steps) assert.equal(s.error, undefined, `${s.name}: ${s.error}`);
  // the brain's build happy path runs: every build spec gets a decision, none fails
  assert.deepEqual(j.failures.filter((f: { what: string }) => f.what.startsWith("brain build")), []);
  const builds = j.steps.find((s: { name: string }) => s.name === "build").output;
  assert.ok(builds.length > 0 && builds.every((b: { decision: { decision?: string } | null }) => b.decision?.decision === "build"));
  const intake = j.steps.find((s: { name: string }) => s.name === "intake").output;
  assert.equal(intake.rows.length, 30);
  assert.equal(intake.summary.injections, 5);
  // the pool id is the hook-less ETH/USDC 0.05% key's (hooks = 0)
  assert.equal(j.pool.poolId, "0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27");
  assert.ok(j.steps.find((s: { name: string }) => s.name === "market").output.stats.feeSwaps > 0);
  // routes as in production: grok on xAI direct, Claude via OpenRouter pinned to Anthropic
  const via = Object.fromEntries(j.calls.map((c: { agent: string; via: string }) => [c.agent, c.via]));
  for (const a of ["research", "intake", "idea-reader", "main", "x-writer"]) assert.equal(via[a], "xai", a);
  for (const a of ["brain", "redteam"]) assert.equal(via[a], "openrouter", a);
  assert.ok(j.calls.length >= 70);
  assert.ok(j.spentUsd > 0 && j.spentUsd <= j.budgetUsd);
  assert.equal(j.totals.refused, 0);
  for (const t of ["tryout-intake", "tryout-brain"]) assert.ok(j.steps.find((s: { name: string }) => s.name === t).output.cases > 0);
  for (const h of ["## Cost", "## Steps", "## Assessment data", "## Failures and refusals", "## Calls"]) assert.ok(r.md.includes(h), h);
  assert.ok(!r.md.includes("Bearer") && !JSON.stringify(j).includes("Bearer"), "no auth header in the report");
});

test("trial budget: a call whose worst case would cross it is refused before it is made", () => {
  const r = run(["--dry", "--budget", "0.001"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.calls.length, 0);
  assert.equal(r.report.spentUsd, 0);
  assert.ok(r.report.failures.length > 0 && r.report.failures.every((f: { refused: boolean }) => f.refused));
  assert.match(r.report.failures[0].error, /trial budget \$0\.001/);
});

test("env refusal: no wallet key, X or Telegram token or database URL; their values are never printed", () => {
  for (const [k, v] of [["DATABASE_URL", "postgres://u:hunter2@db/dna"], ["AGENT_PRIVATE_KEY", "0xdeadbeefsecret"], ["X_REFRESH_TOKEN", "xrt-secret"], ["TELEGRAM_BOT_TOKEN", "tg-secret"], ["LOG_SIGNING_KEY", "0xlogsecret"], ["PGPASSWORD", "pg-secret"]]) {
    const r = run(["--dry"], { [k]: v });
    assert.equal(r.status, 2, k);
    assert.match(r.stderr, new RegExp(`refusing to run with ${k}`));
    assert.ok(!r.stderr.includes(v) && !r.stdout.includes(v), `${k}'s value printed`);
    assert.equal(r.files.length, 0);
  }
  // live mode needs both model keys
  const live = run([], { OPENROUTER_API_KEY_ENGINE: "or-key" });
  assert.equal(live.status, 2);
  assert.match(live.stderr, /needs OPENROUTER_API_KEY_ENGINE and XAI_API_KEY/);
  assert.ok(!live.stderr.includes("or-key"));
});
