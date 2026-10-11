// Rebuild and check a holder-jackpot draw from any RPC, the same checks as the watchdog:
//   node scripts/verify-draw.ts --window <w>  [--rpc <url[,url2]>] [--deployment deployments/1.json] [--signer <log signer address>]
// The latest list posted for that window (record hash, params anchored before the window, block range, a full rebuild
// from the DNA Transfer history, shape); once the window is drawn, also the 10 winners: the walk from the VRF word over
// the list, every Winner and WinnerExcluded the settle logged (an exclusion counts only if isExcluded was true at the
// settle block), Drawn's counts and share. Prints PASS/FAIL lines; exit 1 on any failure. A full rebuild scans every
// Transfer since the mint: give it an RPC without tight getLogs limits.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicClient, http } from "viem";
import { checkWinners, drawnLogs, postedLists, settledOf, verifyPosted } from "../src/draw-verify.ts";
import type { Dep } from "../src/ticket-source.ts";

const { values: a } = parseArgs({ options: { window: { type: "string" }, rpc: { type: "string" }, deployment: { type: "string" }, signer: { type: "string" } } });
if (!a.window) throw new Error("--window <w> is required");
const dep = JSON.parse(readFileSync(a.deployment ?? new URL("../deployments/1.json", import.meta.url), "utf8")) as Dep;
const cs = (a.rpc ?? process.env.RPC_URL ?? "http://127.0.0.1:8545").split(",").map((u) => createPublicClient({ transport: http(u.trim(), { retryCount: 3 }) }));
let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };

const head = await cs[0].getBlockNumber();
const window = BigInt(a.window);
const posted = (await postedLists(cs[0], dep, BigInt(dep.startBlock), head)).filter((p) => p.window === window);
if (!posted.length) throw new Error(`no list posted for window ${window}`);
const r = await verifyPosted({ clients: cs, dep, posted: posted[posted.length - 1], logSigner: a.signer ?? null });
console.log(`window ${r.window}: ${r.holders} holders, ${r.totalTickets} tickets`);
check(r.problems.length === 0, `list ${r.problems.length ? r.problems.join("; ") : "rebuilt and checked"}`);

const [drawn] = await drawnLogs(cs[0], dep, posted[0].blockNumber, head, window);
if (!drawn) console.log(`window ${window} is not drawn yet`);
else {
  // the settle's own logs (Winner, WinnerExcluded) and isExcluded at its block
  const d = await settledOf(cs[0], dep, drawn);
  console.log(`window ${window} drawn: ${d.winners} winners × ${Number(d.share) / 1e18} ETH (prize ${Number(d.prize) / 1e18} ETH), ${d.ticketsUsed} tickets walked, tx ${drawn.transactionHash}`);
  for (const p of d.paid) console.log(`  #${Number(p.rank) + 1} ${p.account} ${p.prizeId === 0n ? "paid" : `claimable (prize ${p.prizeId})`}`);
  const w = checkWinners(r.list, d);
  check(w.problems.length === 0, `winners ${w.problems.length ? w.problems.join("; ") : `the walk over ${w.walk.used.length} tickets gives the same ${w.walk.winners.length} accounts`}`);
}
process.exit(failed ? 1 : 0);
