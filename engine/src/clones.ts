// Copy pools ("clones"): DNA pools that don't use DNA's hook. Anyone can open one (Uniswap v4 with no hook or another
// hook, Uniswap/Sushi/Pancake v2 pairs, Uniswap/Sushi/Pancake v3 pools) and nothing on chain can stop it; trades there pay
// nothing to DNA. Every 15 min, on finalized blocks:
//  - find: PoolManager Initialize with DNA on either side (except the hook pool) and the factories' PairCreated /
//    PoolCreated → one signed `clone` record per pool (the site lists them on /trade; one Telegram alert per run for the new ones);
//  - measure: DNA moved through the hook pool and through every known copy over the last ~day of blocks → one signed
//    `leakage` record (the fee loop's brief and /trade read it). Its toBlock is also where the next find resumes.
// Anyone can recompute both from eth_getLogs over the same blocks.
import { type AbiEvent, type Address, getAddress, type Hex, type Log, parseAbiItem, parseEventLogs } from "viem";
import { d } from "./config.ts";
import type { Handler } from "./jobs.ts";
import { isRangeError, nextRange } from "./lib.ts";
import type { z } from "zod";
import { type Clone as CloneSchema, type Leakage as LeakageSchema, record, trustedDocs } from "./records.ts";
import { alert } from "./telegram.ts";
import { pub } from "./tx.ts";

export type Clone = z.infer<typeof CloneSchema>;
export type Leakage = z.infer<typeof LeakageSchema>;
/** What a copy is a copy of: the token, the v4 PoolManager and the hook pool's id. */
export type Target = { token: Address; poolManager: Address; poolId: Hex };

// Ethereum mainnet factories (each checked on chain: v2 allPairsLength, v3 feeAmountTickSpacing)
const V2: Record<string, string> = {
  "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f": "Uniswap v2",
  "0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac": "SushiSwap v2",
  "0x1097053fd2ea711dad45caccc45eff7548fcb362": "PancakeSwap v2",
};
// v2 LP fee in pips: 0.3%, except PancakeSwap v2 (0.25%: its pairs check balances against 10,000 and 25)
const V2_FEE: Record<string, number> = { "0x1097053fd2ea711dad45caccc45eff7548fcb362": 2500 };
const V3: Record<string, string> = {
  "0x1f98431c8ad98523631ae4a59f267346ea31f984": "Uniswap v3",
  "0xbaceb8ec6b9355dfc0269c18bac9d6e2bdc29c4f": "SushiSwap v3",
  "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865": "PancakeSwap v3",
};
const DYNAMIC_FEE = 0x800000;
export const WINDOW_BLOCKS = 7200n; // leakage window: ~24 h of 12 s blocks
export const LEAK_STALE_BLOCKS = 600; // ~2 h: an older leakage record is not "now" for the fee loop

/** The leakage share the fee loop's brief shows at `block` (null: no record yet, or a stale one). */
export const leakageFor = (l: Leakage | undefined, block: number) => (l && block - l.toBlock <= LEAK_STALE_BLOCKS ? l.pct : null);

const INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const PAIR_CREATED = parseAbiItem("event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)");
const POOL_CREATED = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");
const V4_SWAP = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const V2_SWAP = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");
const V3_SWAP = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
const CAKE_SWAP = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)");

const lc = (a: string) => a.toLowerCase();
const abs = (x: bigint) => (x < 0n ? -x : x);
type Args = Record<string, unknown>;
type Decoded = Log & { eventName: string; args: Args };

/** The copies among creation logs: v4 pools with the token except `poolId`, and v2/v3 pools from the known factories. */
export function clonesFrom(logs: Log[], t: Target): Clone[] {
  const out = new Map<string, Clone>();
  const token = lc(t.token);
  for (const l of parseEventLogs({ abi: [INITIALIZE, PAIR_CREATED, POOL_CREATED], logs, strict: true }) as unknown as Decoded[]) {
    const a = l.args;
    const [x, y] = l.eventName === "Initialize" ? [a.currency0, a.currency1] : [a.token0, a.token1];
    if (lc(x as string) !== token && lc(y as string) !== token) continue;
    const other = getAddress((lc(x as string) === token ? y : x) as string);
    const at = { block: Number(l.blockNumber), tx: l.transactionHash! };
    const from = lc(l.address);
    if (l.eventName === "Initialize" && from === lc(t.poolManager) && lc(a.id as string) !== lc(t.poolId)) {
      const fee = Number(a.fee);
      out.set(lc(a.id as string), { id: lc(a.id as string), venue: "Uniswap v4", version: 4, other, fee: fee === DYNAMIC_FEE ? null : fee, hooks: getAddress(a.hooks as string), ...at });
    } else if (l.eventName === "PairCreated" && V2[from]) {
      out.set(lc(a.pair as string), { id: lc(a.pair as string), venue: V2[from], version: 2, other, fee: V2_FEE[from] ?? 3000, hooks: null, ...at });
    } else if (l.eventName === "PoolCreated" && V3[from]) {
      out.set(lc(a.pool as string), { id: lc(a.pool as string), venue: V3[from], version: 3, other, fee: Number(a.fee), hooks: null, ...at });
    }
  }
  return [...out.values()];
}

/** DNA moved (|DNA side| per swap, wei) through the hook pool and through each copy. A pool's currency0 is the lower
 *  address, so DNA is side 0 exactly when DNA < the other token (never in the hook pool: ETH is address 0). */
export function dnaVolume(logs: Log[], t: Target, clones: Clone[]) {
  const by = new Map(clones.map((c) => [c.id, c]));
  const byClone = new Map<string, bigint>();
  let canonical = 0n;
  const dnaIs0 = (other: string) => BigInt(t.token) < BigInt(other);
  for (const l of parseEventLogs({ abi: [V4_SWAP, V2_SWAP, V3_SWAP, CAKE_SWAP], logs, strict: true }) as unknown as Decoded[]) {
    const a = l.args;
    const v4 = "id" in a && lc(l.address) === lc(t.poolManager);
    const key = v4 ? lc(a.id as string) : lc(l.address);
    const c = by.get(key);
    const official = v4 && key === lc(t.poolId);
    if (!official && !(c && (c.version === 4) === v4)) continue;
    const zero = official ? false : dnaIs0(c!.other);
    const amt = "amount0In" in a
      ? (zero ? (a.amount0In as bigint) + (a.amount0Out as bigint) : (a.amount1In as bigint) + (a.amount1Out as bigint))
      : abs((zero ? a.amount0 : a.amount1) as bigint);
    if (official) canonical += amt;
    else byClone.set(key, (byClone.get(key) ?? 0n) + amt);
  }
  return { canonical, byClone };
}

/** The copies' share of DNA volume in percent, 2 decimals (0 when nothing traded). */
export const leakagePct = (canonical: bigint, clone: bigint) =>
  canonical + clone === 0n ? 0 : Number((Number((clone * 1_000_000n) / (canonical + clone)) / 10_000).toFixed(2));

export type GetLogs = (q: { address: Address | Address[]; event?: AbiEvent; events?: AbiEvent[]; args?: Args; fromBlock: bigint; toBlock: bigint }) => Promise<Log[]>;
/** One query over [from, to] in windows, halving the window on a provider range error (anything else throws). */
export async function windowed(get: GetLogs, q: Omit<Parameters<GetLogs>[0], "fromBlock" | "toBlock">, from: bigint, to: bigint, window = 10_000n) {
  const out: Log[] = [];
  while (from <= to) {
    const r = nextRange(from, to, window);
    try {
      out.push(...(await get({ ...q, fromBlock: r.from, toBlock: r.to })));
    } catch (e) {
      if (isRangeError(e) && window > 1n) { window /= 2n; continue; }
      throw e;
    }
    from = r.to + 1n;
  }
  return out;
}

/** Copies created in [from, to]: the token on either side of each creation event (topics can't OR across positions). */
export async function findClones(get: GetLogs, t: Target, from: bigint, to: bigint) {
  const qs = [
    ...["currency0", "currency1"].map((k) => ({ address: t.poolManager, event: INITIALIZE, args: { [k]: t.token } })),
    ...["token0", "token1"].map((k) => ({ address: Object.keys(V2) as Address[], event: PAIR_CREATED, args: { [k]: t.token } })),
    ...["token0", "token1"].map((k) => ({ address: Object.keys(V3) as Address[], event: POOL_CREATED, args: { [k]: t.token } })),
  ];
  return clonesFrom((await Promise.all(qs.map((q) => windowed(get, q, from, to)))).flat(), t);
}

/** Leakage over [from, to]: the hook pool's and the v4 copies' swaps from the PoolManager, the v2/v3 copies' from their
 *  own addresses. */
export async function measure(get: GetLogs, t: Target, clones: Clone[], from: bigint, to: bigint): Promise<Leakage> {
  const ids = [t.poolId, ...clones.filter((c) => c.version === 4).map((c) => c.id as Hex)];
  const pools = clones.filter((c) => c.version !== 4).map((c) => c.id as Address);
  const logs = [
    ...(await windowed(get, { address: t.poolManager, event: V4_SWAP, args: { id: ids } }, from, to)),
    ...(pools.length ? await windowed(get, { address: pools, events: [V2_SWAP, V3_SWAP, CAKE_SWAP] }, from, to) : []),
  ];
  const v = dnaVolume(logs, t, clones);
  const cloneDna = [...v.byClone.values()].reduce((a, b) => a + b, 0n);
  return {
    fromBlock: Number(from), toBlock: Number(to), canonicalDna: String(v.canonical), cloneDna: String(cloneDna), pct: leakagePct(v.canonical, cloneDna),
    byClone: [...v.byClone].filter(([, x]) => x > 0n).sort((a, b) => (b[1] > a[1] ? 1 : -1)).map(([id, x]) => ({ id, dna: String(x) })),
  };
}

// ---------------------------------------------------------------- the job

const get: GetLogs = (q) => pub.getLogs(q as never) as Promise<Log[]>;
const fmtFee = (c: Clone) => (c.fee === null ? "dynamic fee" : `${c.fee / 1e4}% LP fee`);
/** One alert for a run's new copies: the first three, then "and N more". */
export const alertText = (fresh: Clone[]) =>
  `New DNA pools without DNA's hook (they pay DNA nothing; listed on /trade): ${fresh.slice(0, 3).map((c) => `${c.venue}, ${fmtFee(c)}, ${c.id} (block ${c.block})`).join("; ")}${fresh.length > 3 ? `; and ${fresh.length - 3} more` : ""}.`;

/** Every known copy (newest record per pool; the enclave reads only records it signed). */
export async function knownClones() {
  const seen = new Map<string, Clone>();
  // simplification: up to 1,000 copy records read per run; page if a token ever collects more
  for (const r of await trustedDocs<Clone>("clone", undefined, 1000)) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

export const clonesHandler: Handler = {
  lane: "default",
  run: async () => {
    const t: Target = { token: d.token, poolManager: d.poolManager, poolId: d.poolId };
    const fin = (await pub.getBlock({ blockTag: "finalized" })).number;
    const last = (await trustedDocs<Leakage>("leakage"))[0];
    if (last && BigInt(last.toBlock) >= fin) return `block ${fin} already measured`;
    const from = last ? BigInt(last.toBlock) + 1n : BigInt(d.startBlock);
    const known = await knownClones();
    const ids = new Set(known.map((c) => c.id));
    const fresh = (await findClones(get, t, from, fin)).filter((c) => !ids.has(c.id));
    for (const c of fresh) await record("clone", c.id, c);
    if (fresh.length) await alert(alertText(fresh), `alert:clones:${fin}`); // one per run, deduped per finalized block
    const start = fin - WINDOW_BLOCKS + 1n > BigInt(d.startBlock) ? fin - WINDOW_BLOCKS + 1n : BigInt(d.startBlock);
    const lk = await measure(get, t, [...known, ...fresh], start, fin);
    await record("leakage", String(fin), lk);
    return { fresh: fresh.length, pct: lk.pct };
  },
};
