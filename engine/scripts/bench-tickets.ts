// The CPU side of a jackpot list rebuild (src/tickets.ts), on a synthetic history: N transfers among H holders over a
// day-long window. The RPC side (getLogs + one getBlock per block with logs) is measured on a mainnet fork
// (`time node scripts/verify-draw.ts`). Usage: node scripts/bench-tickets.ts [transfers] [holders]
import { type Address } from "viem";
import { accumulate, buildList, type Transfer, ZERO } from "../src/tickets.ts";

const N = Number(process.argv[2] ?? 1_000_000), Hs = Number(process.argv[3] ?? 50_000);
const E = 10n ** 18n, start = 1_800_000_000, end = start + 86_400;
const acct = (i: number) => `0x${(0x10000 + i).toString(16).padStart(40, "0")}` as Address;
let seed = 1;
const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
const tr: Transfer[] = Array.from({ length: Hs }, (_, i) => ({ at: start - 10, from: ZERO as Address, to: acct(i), value: 10_000n * E }));
for (let k = 0; k < N; k++) tr.push({ at: start - 86_400 * 30 + Math.floor((k / N) * 86_400 * 31), from: acct(Math.floor(rnd() * Hs)), to: acct(Math.floor(rnd() * Hs)), value: E });
const t0 = performance.now();
const acc = accumulate(tr, [], acct(999_999), { window: 1, start, end });
const t1 = performance.now();
const b = buildList({ window: 1, start, end, capBps: 100, minBalance: 1_000n * E, startBlock: 0, endBlock: 1, endBlockHash: `0x${"0".repeat(64)}`, paramsSeq: null }, acc, []);
const t2 = performance.now();
console.log(JSON.stringify({ transfers: tr.length, holders: "skip" in b ? 0 : b.list.holders, accumulateMs: Math.round(t1 - t0), buildMs: Math.round(t2 - t1), heapMb: Math.round(process.memoryUsage().heapUsed / 2 ** 20) }));
