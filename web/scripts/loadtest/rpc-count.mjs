// Counting JSON-RPC proxy: point the indexer/engine's RPC_URL at it to measure calls per method and the Alchemy /
// dRPC compute units they would cost (docs/CAPACITY.md). Prints a running total every REPORT_S and on Ctrl-C.
//   TARGET=http://127.0.0.1:18555 PORT=18600 node web/scripts/loadtest/rpc-count.mjs
import http from "node:http";

const TARGET = new URL(process.env.TARGET ?? "http://127.0.0.1:18555");
const PORT = Number(process.env.PORT ?? 18600);
const REPORT_S = Number(process.env.REPORT_S ?? 60);
// alchemy.com/docs/reference/compute-unit-costs (Oct 2026); dRPC paid tier: a flat 20 CU per call
const ALCHEMY = { eth_blockNumber: 10, eth_getBlockByNumber: 20, eth_getLogs: 60, eth_call: 26, eth_getBalance: 20, eth_estimateGas: 20, eth_maxPriorityFeePerGas: 10, eth_feeHistory: 10, eth_gasPrice: 20, eth_getTransactionReceipt: 20, eth_getTransactionByHash: 20, eth_getTransactionCount: 20, eth_sendRawTransaction: 40, eth_getStorageAt: 20, eth_getCode: 20, eth_chainId: 0 };
const counts = {};
let maxPerSec = 0, secCu = 0, sec = 0;
const t0 = Date.now();

function count(method) {
  counts[method] = (counts[method] ?? 0) + 1;
  const s = Math.floor(Date.now() / 1000);
  if (s !== sec) { sec = s; secCu = 0; }
  secCu += ALCHEMY[method] ?? 20;
  maxPerSec = Math.max(maxPerSec, secCu);
}

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    try { const j = JSON.parse(body); for (const m of Array.isArray(j) ? j : [j]) count(m.method); } catch {}
    const up = http.request({ host: TARGET.hostname, port: TARGET.port, path: TARGET.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": body.length } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    up.end(body);
  });
}).listen(PORT);

function report() {
  const mins = (Date.now() - t0) / 60_000;
  const calls = Object.values(counts).reduce((a, b) => a + b, 0);
  const cu = Object.entries(counts).reduce((t, [m, n]) => t + n * (ALCHEMY[m] ?? 20), 0);
  console.log(JSON.stringify({ minutes: Number(mins.toFixed(2)), calls, alchemyCu: cu, drpcCu: calls * 20, alchemyCuPerDay: Math.round((cu / mins) * 1440), callsPerDay: Math.round((calls / mins) * 1440), peakAlchemyCuPerSec: maxPerSec, byMethod: counts }));
}
setInterval(report, REPORT_S * 1000);
process.on("SIGINT", () => { report(); process.exit(0); });
process.on("SIGTERM", () => { report(); process.exit(0); });
console.log(`rpc-count: :${PORT} → ${TARGET.href}`);
