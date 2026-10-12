// GenomeVaults funding, the pure part (scripts/vault-fund.ts drives it). The treasury's share of the project fee always
// lands in the Safe (FeeVault's destinations are immutable); half of what arrived in the window the contract has not
// covered yet is what the Safe sends on with `fund(fromBlock, toBlock)`. The window is `(fundedThrough, head]`:
// blocks fundedThrough + 1 to head, both included; the contract then sets fundedThrough = head, so a batch prepared
// before another one ran reverts (stale window) and nothing between two funds is ever skipped or paid twice. Nothing
// here sends: the output is a Safe Transaction Builder file for the signers.
import { type Address, encodeFunctionData, type Hex, keccak256, parseAbi, parseAbiItem, stringToBytes } from "viem";

export const VAULTS_ABI = parseAbi([
  "function fund(uint64 fromBlock, uint64 toBlock) payable",
  "function liveCount() view returns (uint256)",
  "function fundedThrough() view returns (uint64)",
]);
export const DISTRIBUTED = parseAbiItem("event Distributed(uint256 amount, uint256 buyback, uint256 lp, uint256 treasury, uint256 game, bool baseline)");
export const fundData = (fromBlock: bigint, toBlock: bigint): Hex => encodeFunctionData({ abi: VAULTS_ABI, functionName: "fund", args: [fromBlock, toBlock] });

/** The window a fund prepared now covers: `(fundedThrough, head]`, as the first and last block to scan (both
 *  included); null when nothing is mined past fundedThrough yet. */
export function windowOf(fundedThrough: bigint, head: bigint): { first: bigint; last: bigint } | null {
  return head > fundedThrough ? { first: fundedThrough + 1n, last: head } : null;
}

/** Treasury ETH the FeeVault paid the Safe in blocks `first..last` (both included). */
export function treasuryIn(dists: { block: bigint; treasury: bigint }[], first: bigint, last: bigint): { total: bigint; count: number } {
  const counted = dists.filter((d) => d.block >= first && d.block <= last);
  return { total: counted.reduce((a, d) => a + d.treasury, 0n), count: counted.length };
}

/** The vaults' part: half, rounded down. */
export const halfOf = (x: bigint) => x / 2n;

/** Safe Transaction Builder batch file (tx-builder 1.18.x) with the checksum the app verifies on import: keccak of a
 *  key-sorted serialization with meta.name = null (apps/tx-builder/src/lib/checksum.ts). The same bytes
 *  contracts/script/GenomeVaultsDeploy.s.sol writes (its test pins the same vector as test/vault-fund.test.ts). */
export function batchJson(o: { safe: Address; txs: { to: Address; value: bigint; data: Hex }[]; name: string; description: string; createdAtMs: number }): string {
  const q = (s: string) => JSON.stringify(s);
  const lower = (a: string) => a.toLowerCase();
  const txJson = o.txs.map((t) => `{"to":${q(lower(t.to))},"value":${q(t.value.toString())},"data":${q(lower(t.data))}}`).join(",");
  const txSer = o.txs.map((t) => `{["data","to","value"]${q(lower(t.data))},${q(lower(t.to))},${q(t.value.toString())},}`).join(",");
  const safe = q(lower(o.safe));
  const ser = `{["chainId","createdAt","meta","transactions","version"]"1",${o.createdAtMs},{["createdFromSafeAddress","description","name","txBuilderVersion"]${safe},${q(o.description)},null,"1.18.3",},[${txSer}],"1.0",}`;
  const checksum = keccak256(stringToBytes(ser));
  return `{"version":"1.0","chainId":"1","createdAt":${o.createdAtMs},"meta":{"name":${q(o.name)},"description":${q(o.description)},"txBuilderVersion":"1.18.3","createdFromSafeAddress":${safe},"checksum":${q(checksum)}},"transactions":[${txJson}]}`;
}

/** The one-transaction batch: `vaults.fund(fundedThrough, head)` with `value` from the Safe. */
export const fundBatch = (safe: Address, vaults: Address, value: bigint, fundedThrough: bigint, head: bigint, createdAtMs: number, note: string) =>
  batchJson({
    safe, txs: [{ to: vaults, value, data: fundData(fundedThrough, head) }], createdAtMs,
    name: "DNA Genome Vaults: fund",
    description: `Half of the treasury's fee share in blocks ${fundedThrough + 1n}-${head}: ${note}`,
  });
