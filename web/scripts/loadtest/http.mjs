// Page/API load: open-model arrivals (requests are started on schedule whether or not earlier ones finished, so a slow
// server shows up as latency, not as a politely lower rate), ramping 0 → RATE req/s over RAMP_S, then RATE for HOLD_S.
// Mixed across PATHS (round-robin). Reports p50/p95/p99 per path, errors, achieved rate, server RSS/CPU, DB connections.
//   node scripts/loadtest/http.mjs          (env: BASE, RATE, RAMP_S, HOLD_S, PATHS, PG_ADMIN_URL, TIMEOUT_MS)
import http from "node:http";
import { execSync } from "node:child_process";
import postgres from "postgres";

const BASE = new URL(process.env.BASE ?? "http://127.0.0.1:3079");
const RATE = Number(process.env.RATE ?? 300);
const RAMP_S = Number(process.env.RAMP_S ?? 30);
const HOLD_S = Number(process.env.HOLD_S ?? 120);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 10_000);
const PATHS = (process.env.PATHS ?? "/,/modules,/treasury,/proposals,/api/core").split(",");
const sql = postgres(process.env.PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:55435/dna", { max: 2 });
const serverPid = process.env.SERVER_PID ?? execSync(`lsof -ti tcp:${BASE.port} -sTCP:LISTEN`).toString().trim().split("\n")[0];
const agent = new http.Agent({ keepAlive: true, maxSockets: 2000 });

const lat = Object.fromEntries(PATHS.map((p) => [p, []]));
const errors = {};
let sent = 0, done = 0, inflight = 0, maxInflight = 0;

function hit(path) {
  const t0 = performance.now();
  sent++; inflight++; maxInflight = Math.max(maxInflight, inflight);
  const fin = (err) => {
    inflight--; done++;
    if (err) errors[err] = (errors[err] ?? 0) + 1;
    else lat[path].push(performance.now() - t0);
  };
  const req = http.get({ host: BASE.hostname, port: BASE.port, path, agent, timeout: TIMEOUT_MS }, (res) => {
    res.resume();
    res.on("end", () => fin(res.statusCode === 200 ? null : `HTTP ${res.statusCode}`));
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => fin(e.message.slice(0, 40)));
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };
const samples = [];
let lastCpu;
async function sample(tag) {
  const [rss, cpu] = execSync(`ps -o rss=,time= -p ${serverPid}`).toString().trim().split(/\s+/);
  const [m, s] = cpu.split(":").map(Number);
  const cpuS = m * 60 + s, now = Date.now();
  const cpuPct = lastCpu ? Math.round(((cpuS - lastCpu.cpuS) / ((now - lastCpu.now) / 1000)) * 100) : null;
  lastCpu = { cpuS, now };
  const [db] = await sql`select count(*)::int as n from pg_stat_activity where usename = 'dna_web'`;
  const line = { t: tag, sent, done, inflight, rssMB: Math.round(Number(rss) / 1024), cpuPct, dbConns: db.n };
  samples.push(line);
  console.log(JSON.stringify(line));
}

await sample("start");
const t0 = performance.now();
const total = RAMP_S + HOLD_S;
let i = 0, credit = 0, lastTick = t0;
const sampler = setInterval(() => void sample(`${Math.round((performance.now() - t0) / 1000)}s`), 5000);
// 5 ms ticks: the rate is integrated tick by tick (linear ramp, then flat)
await new Promise((resolve) => {
  const tick = setInterval(() => {
    const now = performance.now(), el = (now - t0) / 1000;
    if (el >= total) { clearInterval(tick); return resolve(); }
    const rate = el < RAMP_S ? (RATE * el) / RAMP_S : RATE;
    credit += (rate * (now - lastTick)) / 1000;
    lastTick = now;
    while (credit >= 1) { hit(PATHS[i++ % PATHS.length]); credit--; }
  }, 5);
});
const holdSent = sent;
while (inflight > 0) await new Promise((r) => setTimeout(r, 100));
clearInterval(sampler);
await sample("end");
const all = Object.values(lat).flat();
const result = {
  rate: RATE, rampS: RAMP_S, holdS: HOLD_S, sent: holdSent, ok: all.length, errors,
  achievedRps: Math.round(holdSent / total), heldRps: RATE, maxInflight,
  all: { p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), max: Math.round(all.reduce((m, x) => (x > m ? x : m), 0)) },
  byPath: Object.fromEntries(Object.entries(lat).map(([p, a]) => [p, { n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99) }])),
  peakRssMB: Math.max(...samples.map((s) => s.rssMB)), maxCpuPct: Math.max(...samples.map((s) => s.cpuPct ?? 0)),
  peakDbConns: Math.max(...samples.map((s) => s.dbConns)),
};
console.log("RESULT " + JSON.stringify(result, null, 1));
await sql.end();
process.exit(0);
