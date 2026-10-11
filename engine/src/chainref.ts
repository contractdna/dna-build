// Chain inputs. The engine judges finalized chain_log rows the indexer wrote (the DB is not trusted), so every cycle
// record carries a reference to exactly what it judged: {fromBlock, toBlock, toBlockHash, eventsSha256} plus the RPC
// host set. Anyone can replay eth_getLogs over that range and recompute eventsSha256, so fabricated or dropped events
// are detectable after the fact. Gate and kill reads (keeper execute of an agent op, canary kill checks) go further in
// the enclave: the cursor's block hash and timestamp must equal what BOTH RPC providers return, the cursor must be
// fresh (≤ CURSOR.maxLag behind both providers' finalized head), and contract reads at that block must agree across
// both providers, or no decision is taken.
import { createHash } from "node:crypto";
import { createPublicClient, http, type PublicClient } from "viem";
import { d, RPC_URLS } from "./config.ts";
import { edb as sql } from "./db.ts";
import { ENCLAVE, hostsOf } from "./enclave.ts";
import { canonical } from "./log.ts";

type Ev = { block: number; log_index: number; tx: string; event: string; args: unknown };
/** sha256 over the canonical [block, logIndex, tx, event, args] list in chain order (args as the indexer decodes them). */
export const eventsSha256 = (rows: Ev[]) =>
  createHash("sha256").update(canonical([...rows].sort((a, b) => a.block - b.block || a.log_index - b.log_index).map((r) => [r.block, r.log_index, r.tx, r.event, r.args]))).digest("hex");

export const clients: PublicClient[] = RPC_URLS.map((url) => createPublicClient({ transport: http(url, { retryCount: 2 }) }));
const needTwo = (cs: unknown[]) => {
  if (ENCLAVE.on && cs.length < 2) throw new Error("the enclave needs two RPC providers to agree on chain reads");
};
type BlockReader = { getBlock: (a: { blockNumber: bigint } | { blockTag: "finalized" }) => Promise<{ hash: string | null; number: bigint | null; timestamp: bigint }> };
/** `block` (hash + timestamp) as every configured provider reports it; throws if they disagree (the enclave needs ≥ 2). */
export async function agreedBlock(block: number, cs: BlockReader[] = clients) {
  needTwo(cs);
  const bs = await Promise.all(cs.map((c) => c.getBlock({ blockNumber: BigInt(block) })));
  if (new Set(bs.map((b) => `${b.hash}@${b.timestamp}`)).size !== 1) throw new Error(`RPC providers disagree on block ${block}: ${bs.map((b) => b.hash).join(" ≠ ")}`);
  return bs[0];
}
export const agreedHash = async (block: number, cs: BlockReader[] = clients) => (await agreedBlock(block, cs)).hash;

/** The newest block every provider has: the lowest of their heads (a log read bounded to it means the same on all). */
export async function agreedHead(cs: Pick<PublicClient, "getBlockNumber">[] = clients) {
  return (await Promise.all(cs.map((c) => c.getBlockNumber()))).reduce((m, n) => (n < m ? n : m));
}

/** One read through every provider (the enclave: ≥ 2), e.g. pinned with `blockNumber`; throws unless all agree. */
export async function readAgreed<T>(read: (c: PublicClient) => Promise<T>, cs: PublicClient[] = clients) {
  needTwo(cs);
  const out = await Promise.all(cs.map(read));
  if (new Set(out.map(canonical)).size !== 1) throw new Error("RPC providers disagree on a gate/kill read: no decision");
  return out[0];
}

/** The cursor may trail both providers' finalized head by this many blocks (one mainnet epoch is 32). */
export const CURSOR = { maxLag: 50 };
/** The indexer cursor, checked against the providers in the enclave (the plain build trusts its own DB): same hash and
 *  timestamp for its block, and fresh, so a DB that stopped (or replays an old) chain_log can't hold a kill back. */
export async function cursorAgreed(cs: BlockReader[] = clients) {
  const [cur] = await sql<{ block: number; hash: string; at: Date }[]>`select block::int as block, hash, at from cursor`;
  if (!cur || !ENCLAVE.on) return cur;
  const b = await agreedBlock(cur.block, cs);
  if (!b.hash || b.hash.toLowerCase() !== cur.hash.toLowerCase()) throw new Error(`indexer cursor block ${cur.block} hash ${cur.hash} is not the providers' ${b.hash}: chain_log not trusted`);
  if (Number(b.timestamp) * 1000 !== cur.at.getTime()) throw new Error(`indexer cursor block ${cur.block} time ${cur.at.toISOString()} is not the block's (${b.timestamp}): chain_log not trusted`);
  const fin = Math.max(...(await Promise.all(cs.map(async (c) => Number((await c.getBlock({ blockTag: "finalized" })).number))))); // ≤ maxLag behind BOTH
  if (fin - cur.block > CURSOR.maxLag) throw new Error(`indexer cursor block ${cur.block} trails the providers' finalized ${fin} by more than ${CURSOR.maxLag}: chain_log is stale`);
  return cur;
}

/** The events a cycle judges and where they come from (src/indexer.ts): Swap from the PoolManager (this pool id), the
 *  rest from the hook. */
export const CYCLE_EVENTS = ["Swap", "FeeTaken", "ShadowFee", "ModuleFailed"];
/** The snapshot reference a cycle record carries: enough to replay eth_getLogs and recompute eventsSha256. */
export async function chainRef(rows: Ev[], toBlock: number, toBlockHash: string, fromMs?: number) {
  return {
    fromBlock: rows.length ? Math.min(...rows.map((r) => r.block)) : toBlock, toBlock, toBlockHash, eventsSha256: eventsSha256(rows), hosts: hostsOf(RPC_URLS),
    events: CYCLE_EVENTS, addresses: { Swap: d.poolManager, rest: d.hook }, poolId: d.poolId, fromMs: fromMs ?? null,
  };
}
