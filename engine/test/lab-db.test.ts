// The lab job against a real Postgres: the window's signed experiment, sim, red-team and research records become one
// lab post (the site's record and the X outbox row, once per window); a stale run and a quiet window post nothing.
// Needs TEST_DATABASE_URL (CI).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const HOUR = 3600_000;
const dbName = `dna_lab_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  // a launch day: a lab window every 2 h (launched 25 h ago, so every window checked below is on a launch day at any UTC hour)
  Object.assign(process.env, { DATABASE_URL: u.href, ENGINE_MODE: "live", LLM_LAUNCH_AT: new Date(Date.now() - 25 * HOUR).toISOString() });
}
const { edb: sql, migrate } = await import("../src/db.ts");
const { record } = await import("../src/records.ts");
const { append } = await import("../src/log.ts");
const lab = await import("../src/lab.ts");

before(async () => { if (ADMIN) await migrate(); });
after(async () => {
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
});

const job = (payload: Record<string, unknown>) => ({ id: "0", kind: "x:lab", payload, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null }) as never;
const sim = (id: string, params: [number, number, number]) => record("sim", id, { id, thread: "T-0001", label: "uncalibrated", harness: "h", plate: "A", params, forkBlock: 1, replayed: 50,
  safety: null, baseline: { projectEthPerDay: 13.5, swapsPerDay: 4000, meanPips: 23800, atCapShare: 0 }, candidate: { meanPips: 24000, atCapShare: 0 }, elasticity: [] });
const exp = (id: string, simId: string, eth: number, swaps: number, note: string, status = "rejected") => record("experiment", id, { id, bench: "1", module: "adaptive-fee plate A", status, sim: simId, thread: "T-0001",
  metrics: [{ name: "project ETH/day (ε=1)", delta: eth, unit: "%" }, { name: "swap retention (ε=1)", delta: swaps, unit: "%" }, { name: "fee at cap", delta: 0, unit: "%" }], note });

test("x:lab: one post per window from the signed records, linking the lab; once per key; stale or quiet: nothing", { skip }, async () => {
  // the window that holds now: it ends at the next even UTC hour, the job is due 5 min later
  const to = Math.ceil((Date.now() + 1) / (2 * HOUR)) * 2 * HOUR, due = new Date(to + lab.LAB.lagMs).toISOString();
  assert.equal(await lab.labHandler.run(job({ due })), "nothing simulated in the window: no lab post");
  await sim("sim #1", [25000, 1000, 32000]);
  await sim("sim #2", [21000, 1200, 30000]);
  await exp("E-0001", "sim #1", 1.15, -8.21, "base 2.50%, multiplier 0.10×, cap 3.20% · Main said no-go: retention fell 8.21%");
  await exp("E-0002", "sim #2", -0.57, 5.49, "base 2.10%, multiplier 0.12×, cap 3.00% · gates failed: project ETH/day at ε=1 13.49 < baseline 13.57");
  // a run that went on-chain (queued: shadow, then killed live) is never a simulated candidate, however good its sim
  await exp("E-0003", "sim #1", 9.9, 0, "base 2.50%, multiplier 0.10×, cap 3.20% · uncalibrated", "shadow");
  await exp("E-0003", "sim #1", 9.9, 0, "base 2.50%, multiplier 0.10×, cap 3.20% · kill condition: swaps fell", "rejected");
  await exp("E-0004", "sim #1", 9.8, 0, "base 2.50%, multiplier 0.10×, cap 3.20% · uncalibrated", "canary");
  await record("security", "R-0001", { id: "R-0001", kind: "red-team", title: "t", severity: "medium", status: "open", detail: "d", date: new Date().toISOString().slice(0, 19) + "Z" });
  await append("research", "fee", { at: new Date().toISOString(), findings: [{ claim: "a", source: "s" }, { claim: "b", source: "s" }] });
  const key = `lab:${new Date(to - 2 * HOUR).toISOString().slice(0, 13)}`;
  assert.deepEqual(await lab.labHandler.run(job({ due })), { [key]: true });
  const [o] = await sql<{ link: string; event: Record<string, unknown> }[]>`select link, event from x_outbox where event_key = ${key}`;
  assert.match(o.link, /\/lab\/experiments$/);
  assert.deepEqual(o.event, { event: "lab", hours: 2, tested: 2, rejected: 2, best: { fee: { basePct: 2.5, multiplier: 0.1, capPct: 3.2 }, ethUpPct: 1.15, swapsDownPct: 8.21, verdict: "the brain said no-go" },
    redTeamFindings: 1, redTeamOpen: 1, researchFindings: 2 });
  const [a] = await sql<{ title: string }[]>`select doc->>'title' as title from log where kind = 'announce' and ref = ${key}`;
  assert.match(a.title, /^Lab, last 2 h: 2 fee candidates simulated, 2 rejected; best in simulation/);
  assert.deepEqual(await lab.labHandler.run(job({ due })), { [key]: false }, "a second run queues nothing new");
  assert.match(String(await lab.labHandler.run(job({ due: new Date(Date.now() - 2 * HOUR).toISOString() }))), /^missed the lab hour/);
  // an odd hour on a launch day is no window
  assert.match(String(await lab.labHandler.run(job({ due: new Date(to - HOUR + lab.LAB.lagMs).toISOString() }))), /not a lab hour: one every 2 h/);
});
