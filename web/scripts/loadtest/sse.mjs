// SSE load test: N concurrent /api/stream clients held for HOLD_S, a probe NOTIFY every second (fan-out latency =
// receive time − the probe's `at`), then a reconnect storm: every client drops and reconnects (with its Last-Event-ID)
// at a random moment within STORM_S. Samples the server's RSS/CPU and Postgres connections every 5 s.
//   node scripts/loadtest/sse.mjs            (env: URL, N, HOLD_S, STORM_S, HOLD2_S, PG_ADMIN_URL, PORT_PID)
// Every 20 clients share one x-real-ip (as behind a carrier NAT): exercises the per-IP map, stays under SSE_PER_IP_MAX.
import http from "node:http";
import { execSync } from "node:child_process";
import postgres from "postgres";

const URL_ = new URL(process.env.URL ?? "http://127.0.0.1:3079/api/stream");
const N = Number(process.env.N ?? 5000);
const HOLD_S = Number(process.env.HOLD_S ?? 120);
const STORM_S = Number(process.env.STORM_S ?? 10);
const HOLD2_S = Number(process.env.HOLD2_S ?? 30);
const sql = postgres(process.env.PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:55435/dna", { max: 2 });
const serverPid = process.env.SERVER_PID ?? execSync(`lsof -ti tcp:${URL_.port} -sTCP:LISTEN`).toString().trim().split("\n")[0];

const PROBE = 9_000_000_000; // probe block numbers: never a real block
const lat = [];
const stats = { opened: 0, refused: {}, errors: 0, ended: 0, firstFrameMs: [], frames: 0 };
let phase = "hold";

function client(i) {
  const c = { lastId: undefined, req: undefined, open: false, gotFirst: false };
  c.connect = () => {
    const t0 = Date.now();
    const headers = { accept: "text/event-stream", "x-real-ip": `10.0.${Math.floor(i / 20) >> 8}.${Math.floor(i / 20) & 255}` };
    if (c.lastId) headers["last-event-id"] = c.lastId;
    c.gotFirst = false;
    c.req = http.get({ host: URL_.hostname, port: URL_.port, path: URL_.pathname, headers, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        stats.refused[res.statusCode] = (stats.refused[res.statusCode] ?? 0) + 1;
        res.resume();
        return;
      }
      stats.opened++;
      c.open = true;
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let k;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const msg = buf.slice(0, k);
          buf = buf.slice(k + 2);
          let data;
          for (const line of msg.split("\n")) {
            if (line.startsWith("id: ")) c.lastId = line.slice(4);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (!data) continue;
          stats.frames++;
          if (!c.gotFirst) { c.gotFirst = true; if (phase === "storm") stats.firstFrameMs.push(Date.now() - t0); }
          if (phase === "hold" && data.includes(`"block":${String(PROBE).slice(0, 4)}`)) {
            const e = JSON.parse(data);
            if (e.block >= PROBE) lat.push(Date.now() - Date.parse(e.at));
          }
        }
      });
      res.on("end", () => { c.open = false; if (phase !== "stopping" && phase !== "dropping") stats.ended++; });
      res.on("error", () => {});
    });
    c.req.on("error", () => { c.open = false; if (phase !== "stopping" && phase !== "dropping") stats.errors++; });
  };
  c.drop = () => { c.open = false; c.req?.destroy(); };
  return c;
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const summary = (a) => ({ n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: a.length ? a.reduce((m, x) => (x > m ? x : m)) : null });

let lastCpu;
async function sample(tag) {
  const [rss, cpu] = execSync(`ps -o rss=,time= -p ${serverPid}`).toString().trim().split(/\s+/);
  const [m, s] = cpu.split(":").map(Number);
  const cpuS = m * 60 + s, now = Date.now();
  const cpuPct = lastCpu ? (((cpuS - lastCpu.cpuS) / ((now - lastCpu.now) / 1000)) * 100).toFixed(0) : "-";
  lastCpu = { cpuS, now };
  const [db] = await sql`select count(*)::int as n, count(*) filter (where state = 'active')::int as active from pg_stat_activity where usename = 'dna_web'`;
  const open = clients.filter((c) => c.open).length;
  const line = { t: tag, open, rssMB: Math.round(Number(rss) / 1024), cpuPct, dbConns: db.n, dbActive: db.active };
  samples.push(line);
  console.log(JSON.stringify(line));
}

const samples = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`server pid ${serverPid}; baseline:`);
const clients = Array.from({ length: N }, (_, i) => client(i));
await sample("baseline");
const baseRss = samples[0].rssMB;

// ramp: 500 connections per second
for (let i = 0; i < N; i++) { clients[i].connect(); if (i % 500 === 499) await sleep(1000); }
let probe = 0;
const prober = setInterval(() => sql`select pg_notify('feed', ${JSON.stringify({ t: "head", block: PROBE + ++probe, at: new Date().toISOString() })})`.catch(() => {}), 1000);
const t0 = Date.now();
while (Date.now() - t0 < HOLD_S * 1000) { await sleep(5000); await sample(`hold ${Math.round((Date.now() - t0) / 1000)}s`); }
const held = clients.filter((c) => c.open).length;
const holdProbes = probe;
const holdStats = { ...stats, refused: { ...stats.refused }, firstFrameMs: undefined };
const peakRss = Math.max(...samples.map((s) => s.rssMB));

// storm: drop everything, reconnect each at a random moment within STORM_S (with Last-Event-ID)
phase = "dropping";
clients.forEach((c) => c.drop());
await sleep(500);
phase = "storm";
stats.opened = 0; stats.refused = {}; stats.errors = 0; stats.ended = 0;
const s0 = Date.now();
clients.forEach((c) => setTimeout(c.connect, Math.random() * STORM_S * 1000));
while (Date.now() - s0 < (STORM_S + HOLD2_S) * 1000) { await sleep(5000); await sample(`storm +${Math.round((Date.now() - s0) / 1000)}s`); }
phase = "stopping";
clearInterval(prober);
const result = {
  N, holdS: HOLD_S, probes: holdProbes,
  hold: { opened: holdStats.opened, stillOpenAtEnd: held, refused: holdStats.refused, errors: holdStats.errors, endedByServer: holdStats.ended, frames: holdStats.frames },
  fanoutLatencyMs: summary(lat),
  deliveredProbeFrames: lat.length, expectedProbeFrames: held * holdProbes,
  memory: { baselineMB: baseRss, peakMB: peakRss, perConnKB: Math.round(((peakRss - baseRss) * 1024) / Math.max(1, held)) },
  storm: { reconnected: stats.opened, refused: stats.refused, errors: stats.errors, timeToFirstFrameMs: summary(stats.firstFrameMs), openAtEnd: clients.filter((c) => c.open).length },
  peakDbConns: Math.max(...samples.map((s) => s.dbConns)),
  maxCpuPct: Math.max(...samples.map((s) => Number(s.cpuPct) || 0)),
};
console.log("RESULT " + JSON.stringify(result, null, 1));
clients.forEach((c) => c.drop());
await sql.end();
process.exit(0);
