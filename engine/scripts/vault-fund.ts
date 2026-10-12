// Write the Safe Transaction Builder file that funds the GenomeVaults with half of the treasury's fee share in the
// window the contract has not covered yet:
//   node scripts/vault-fund.ts --vaults <address> --out <file.json> [--rpc <url>] [--deployment deployments/1.json]
// Reads `fundedThrough()` from the vaults and the last finalized block (never the unfinalized head: a reorg past the
// window would leave the counted inflows wrong while the contract's cursor still moves past them), sums FeeVault's Distributed logs (their `treasury` part
// is what the Safe received) in blocks fundedThrough + 1 .. head, halves the sum and writes one
// `fund(fundedThrough, head)` transaction for the Safe to import and sign. If another fund runs first, the contract
// rejects this one (stale window): rerun the script. Never sends anything.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicClient, formatEther, getAddress, http } from "viem";
import { getLogsChunked } from "../src/ticket-source.ts";
import { DISTRIBUTED, fundBatch, halfOf, treasuryIn, VAULTS_ABI, windowOf } from "../src/vault-fund.ts";

const { values: a } = parseArgs({ options: { vaults: { type: "string" }, out: { type: "string" }, rpc: { type: "string" }, deployment: { type: "string" } } });
if (!a.vaults || !a.out) throw new Error("--vaults <address> and --out <file.json> are required");
const vaults = getAddress(a.vaults);
const dep = JSON.parse(readFileSync(a.deployment ?? new URL("../deployments/1.json", import.meta.url), "utf8")) as { feeVault: `0x${string}`; safe: `0x${string}` };
const c = createPublicClient({ transport: http((a.rpc ?? process.env.RPC_URL ?? "http://127.0.0.1:8545").split(",")[0].trim(), { retryCount: 3 }) });

const [head, fundedThrough, live] = await Promise.all([
  c.getBlock({ blockTag: "finalized" }).then((b) => b.number),
  c.readContract({ address: vaults, abi: VAULTS_ABI, functionName: "fundedThrough" }),
  c.readContract({ address: vaults, abi: VAULTS_ABI, functionName: "liveCount" }),
]);
const w = windowOf(BigInt(fundedThrough), head);
console.log(`funded through block ${fundedThrough}; finalized ${head}; live vaults ${live}`);
if (!w) { console.log("nothing finalized past the last fund yet"); process.exit(1); }
const dists = (await getLogsChunked((lo, hi) => c.getLogs({ address: dep.feeVault, event: DISTRIBUTED, fromBlock: lo, toBlock: hi }), w.first, w.last))
  .map((l) => ({ block: l.blockNumber!, treasury: l.args.treasury! }));
const { total, count } = treasuryIn(dists, w.first, w.last);
const value = halfOf(total);
console.log(`${count} distributions in blocks ${w.first}-${w.last}: ${formatEther(total)} ETH to the Safe; half = ${formatEther(value)} ETH`);
if (value === 0n) { console.log("nothing to fund"); process.exit(1); }
if (live === 0n) { console.log("fund() reverts with no live vault: wait for the first mint"); process.exit(1); }
writeFileSync(a.out, fundBatch(dep.safe, vaults, value, BigInt(fundedThrough), head, Date.now(), `${count} distributions`) + "\n");
console.log(`wrote ${a.out}: fund(${fundedThrough}, ${head}) with ${formatEther(value)} ETH from ${dep.safe} (import it in the Safe Transaction Builder)`);
