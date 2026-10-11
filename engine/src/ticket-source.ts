// Chain inputs for the holder-jackpot ticket list, read straight from an RPC: what the watchdog
// (scripts/watchdog.ts) and the CLI (scripts/verify-draw.ts) rebuild from, and the engine's block-range and exclusion
// reads (src/jackpot.ts; its transfers come from the indexer's chain_log). No DB, no keys, no engine config.
import { type Address, getAbiItem, type Hex, parseEventLogs, type PublicClient } from "viem";
import * as abi from "./abi.ts";
import { isRangeError } from "./lib.ts";
import { DEAD, type Transfer, type VaultEvent, ZERO } from "./tickets.ts";

export type Dep = {
  startBlock: number; token: Address; convictionVault: Address; gamePot: Address; registry: Address; safe: Address; poolManager: Address; hook: Address;
  feeVault: Address; buybackBurn: Address; liquidityVault: Address; platformRevenue: Address; bootstrap?: Address; ideaMarket?: Address;
};
type BlockReader = Pick<PublicClient, "getBlock">;

/** {startBlock, endBlock, endBlockHash} for a window: the first block with timestamp ≥ start, the last with timestamp
 *  < end. Every client must report the same hash and time for each block it reads (the enclave reads through two
 *  providers); null while the window's end is not finalized on all of them. */
export async function windowBlocks(cs: BlockReader[], start: number, end: number, fromBlock: number) {
  const fin = Math.min(...(await Promise.all(cs.map(async (c) => Number((await c.getBlock({ blockTag: "finalized" })).number)))));
  const memo = new Map<number, { hash: Hex; ts: number }>();
  const at = async (n: number) => {
    if (!memo.has(n)) {
      const bs = await Promise.all(cs.map((c) => c.getBlock({ blockNumber: BigInt(n) })));
      if (new Set(bs.map((b) => `${b.hash}@${b.timestamp}`)).size !== 1) throw new Error(`RPC providers disagree on block ${n}`);
      memo.set(n, { hash: bs[0].hash!, ts: Number(bs[0].timestamp) });
    }
    return memo.get(n)!;
  };
  if ((await at(fin)).ts < end) return null;
  const first = async (x: number) => {
    let lo = fromBlock, hi = fin;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((await at(mid)).ts >= x) hi = mid; else lo = mid + 1;
    }
    return lo;
  };
  const startBlock = await first(start);
  const endBlock = (await first(end)) - 1;
  if (endBlock < fromBlock) throw new Error(`window [${start}, ${end}) ends before block ${fromBlock}`);
  return { startBlock, endBlock, endBlockHash: (await at(endBlock)).hash };
}

/** eth_getLogs over [from, to] in windows, halving a window a provider refuses as too large (its range or result
 *  limit), so a scan from the deployment block works on any provider. */
export async function getLogsChunked<T>(get: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to: bigint, window = 10_000n): Promise<T[]> {
  const out: T[] = [];
  for (let lo = from; lo <= to;) {
    const hi = lo + window - 1n < to ? lo + window - 1n : to;
    try {
      out.push(...(await get(lo, hi)));
      lo = hi + 1n;
    } catch (e) {
      if (!isRangeError(e) || window <= 1n) throw e;
      window /= 2n;
    }
  }
  return out;
}
/** `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  }));
  return out;
}
export const RPC_CONCURRENCY = 8;

const VAULT_EVENTS = ["Locked", "Recommitted", "Withdrawn"] as const;
/** Every DNA Transfer and vault position event since the deployment block up to `toBlock`, chain order, with block
 *  timestamps (fetched for each block with logs, RPC_CONCURRENCY at a time). */
export async function fromRpc(c: PublicClient, dep: Dep, toBlock: number, window = 10_000) {
  const transferEvent = getAbiItem({ abi: abi.tokenAbi, name: "Transfer" });
  const [tr, vl] = await Promise.all([
    getLogsChunked((fromBlock, to) => c.getLogs({ address: dep.token, event: transferEvent, fromBlock, toBlock: to }), BigInt(dep.startBlock), BigInt(toBlock), BigInt(window)),
    getLogsChunked((fromBlock, to) => c.getLogs({ address: dep.convictionVault, fromBlock, toBlock: to }), BigInt(dep.startBlock), BigInt(toBlock), BigInt(window)),
  ]);
  const vault = parseEventLogs({ abi: abi.convictionVaultAbi, logs: vl }).filter((l) => (VAULT_EVENTS as readonly string[]).includes(l.eventName));
  const blocks = [...new Set([...tr, ...vault].map((l) => l.blockNumber!))];
  const ts = new Map((await mapLimit(blocks, RPC_CONCURRENCY, async (n) => [n, Number((await c.getBlock({ blockNumber: n })).timestamp)] as const)));
  const transfers: Transfer[] = tr.map((l) => ({ at: ts.get(l.blockNumber!)!, from: l.args.from!, to: l.args.to!, value: l.args.value! }));
  const vaultEvents = vault.map((l) => vaultEvent(l.eventName, ts.get(l.blockNumber!)!, l.args as Record<string, unknown>));
  return { transfers, vaultEvents };
}

/** A vault event row (chain_log args or decoded log args) → the builder's shape. */
export function vaultEvent(event: string, at: number, a: Record<string, unknown>): VaultEvent {
  if (event === "Locked") return { at, event, id: Number(a.id), owner: String(a.owner) as Address, amount: BigInt(String(a.amount)), tier: Number(a.tier) };
  if (event === "Recommitted") return { at, event, id: Number(a.id), tier: Number(a.tier), termStart: Number(a.termStart) };
  return { at, event: "Withdrawn", id: Number(a.id) };
}

/** Never in a list: GamePot's on-chain set (read at `blockNumber`: the Safe, the agent and anchor keys, the vault's team
 *  list for these candidates, the protocol contracts, 0x0, 0x…dEaD) + PlatformRevenue + Bootstrap + `extra` (the
 *  exchange wallets pinned in the window's params record). Lowercase, sorted, unique. */
export async function exclusionSet(c: PublicClient, dep: Dep, blockNumber: number, candidates: string[], extra: string[]) {
  const bn = BigInt(blockNumber);
  const [agent, anchorKey] = await Promise.all(["agent", "anchorKey"].map((f) => c.readContract({ address: dep.registry, abi: abi.registryAbi, functionName: f as "agent", blockNumber: bn })));
  const team: string[] = [];
  for (let i = 0; i < candidates.length; i += 500) {
    const part = candidates.slice(i, i + 500);
    const flags = (await c.multicall({
      deployless: true, allowFailure: false, blockNumber: bn,
      contracts: part.map((a) => ({ address: dep.convictionVault, abi: abi.convictionVaultAbi, functionName: "excluded", args: [a as Address] })),
    } as never)) as unknown as boolean[];
    part.forEach((a, k) => flags[k] && team.push(a));
  }
  const all = [ZERO, DEAD, dep.safe, agent, anchorKey, dep.poolManager, dep.hook, dep.feeVault, dep.buybackBurn, dep.liquidityVault, dep.convictionVault, dep.gamePot,
    dep.platformRevenue, dep.bootstrap, ...team, ...extra].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  return [...new Set(all)].sort();
}
