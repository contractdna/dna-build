// The idea replay (scripts/replay-ideas.ts) in --dry mode: the live idea path offline over a small export, the table
// written to --out, and its env refusal. Each run is a child process with a clean env.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/replay-ideas.ts", import.meta.url).pathname;
const user = { id: "1", username: "a", created_at: "2026-10-01T00:00:00.000Z" };
const at = "2026-10-10T10:00:00.000Z";
const mentions = [
  { id: "11", author_id: "1", username: "a", text: "@contractdna build a daily trivia game about the burn", at, user, status: "rejected", reason: "void: duplicate" },
  { id: "12", author_id: "1", username: "a", text: "@contractdna build a weekly leaderboard page for top swappers", at: "2026-10-10T11:00:00.000Z", user },
  { id: "13", author_id: "2", username: "b", text: "@contractdna mint a holder NFT for big holders", at, user: { ...user, id: "2" } },
  { id: "14", author_id: "3", username: "c", text: "@contractdna look https://t.co/x", at, user: { ...user, id: "3" } },
  { id: "15", author_id: "4", username: "d", text: "@contractdna How much dna burning so far?", at, user: { ...user, id: "4" }, status: "screened", reason: "screened as spam" },
];
const run = (args: string[], env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  writeFileSync(join(dir, "in.json"), JSON.stringify({ mentions }));
  const out = join(dir, "replay.md");
  const r = spawnSync(process.execPath, [script, "--input", join(dir, "in.json"), "--out", out, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 120_000 });
  let md = "";
  try { md = readFileSync(out, "utf8"); } catch {}
  return { ...r, md };
};

test("replay --dry: gate, screen, daily cap, judge with the buildable version and the reply, written to --out", () => {
  const r = run(["--dry"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.md, /^# Idea replay/);
  assert.match(r.md, /## Ideas/);
  const line = (id: string) => r.md.split("\n").find((l) => l.includes(mentions.find((m) => m.id === id)!.text.slice(13, 40))) ?? "";
  assert.match(line("11"), /\*\*in\*\*/);
  assert.match(line("12"), /held back \(already 1 idea from this author the same UTC day\)/);
  assert.match(line("13"), /\*\*buildable version\*\* \| game: Synthetic game version/);
  assert.match(line("14"), /held back \(links are not allowed in ideas\)/);
  assert.match(line("15"), /not an idea \(question\)/);
  assert.match(r.md, /## Failures and refusals\n\nnone/);
  // each mention is in one table only
  for (const m of mentions) assert.equal(r.md.split(m.text.slice(13, 40)).length - 1, 1, m.id);
});

test("replay: refuses a database URL or a wallet key, and needs --out", () => {
  for (const env of [{ DATABASE_URL: "postgres://u:hunter2@db/x" }, { AGENT_PRIVATE_KEY: "0xsecret" }] as Record<string, string>[]) {
    const r = run(["--dry"], env);
    assert.equal(r.status, 2);
    assert.ok(!r.stderr.includes("hunter2") && !r.stderr.includes("0xsecret"));
  }
  const r = spawnSync(process.execPath, [script, "--dry"], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--out/);
});
