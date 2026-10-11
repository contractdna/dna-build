// Copy pools (src/clones.ts): detection and leakage on fixture logs. The v4 fixtures are real mainnet logs around
// another hook token's launch (October 2026): its official pool, its first hookless copy 37 blocks later, a copy
// against USDC where the token is currency0, and two unrelated pools in the same blocks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, type Log, parseAbiItem, zeroAddress } from "viem";
import { alertText, type Clone, clonesFrom, dnaVolume, findClones, type GetLogs, leakagePct, measure, type Target, windowed } from "../src/clones.ts";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`fixtures/clones/${f}`, import.meta.url), "utf8")) as Log[];
const PM: Address = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const REF: Target = { token: "0x1b54E762aa34CF6E28E9C082F2848e28E45DA6b8", poolManager: PM, poolId: "0xfaa42866f7667e3a1a10d783f3b629171febd45f056336b8df766d74afc0f0f7" };
const ETH_COPY = "0x5c0b4298f91daff1f2084172b58f1032e4a3eb6d28cec11b7f25072fe104185d";
const USDC_COPY = "0xbc0ed7416ffa4ef78a4316a518fdeed2b4f6db3d956ece4cb44571a2b9eb71b0";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

test("v4: every pool with the token except the official one, on real logs", () => {
  const c = clonesFrom(fixture("v4-initialize-26121990-26122040.json"), REF);
  assert.deepEqual(c.map((x) => x.id), [ETH_COPY, USDC_COPY]);
  assert.deepEqual(c[0], { id: ETH_COPY, venue: "Uniswap v4", version: 4, other: zeroAddress, fee: 200_000, hooks: zeroAddress, block: 26_122_033, tx: c[0].tx });
  assert.equal(c[1].other, USDC, "the token as currency0: the other side is currency1");
  // a different official pool id: the real official pool becomes a copy too (it is only excluded by id)
  assert.equal(clonesFrom(fixture("v4-initialize-26121990-26122040.json"), { ...REF, poolId: ETH_COPY }).map((x) => x.id).includes(REF.poolId), true);
});

// v2/v3 factory events, synthesized (DNA has no pools yet)
const PAIR = parseAbiItem("event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)");
const POOL = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");
const DNA: Address = "0x00000000000000000000000000000000000d0a00";
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const T: Target = { token: DNA, poolManager: PM, poolId: `0x${"ab".repeat(32)}` };
const log = (address: Address, topics: Hex[], data: Hex, block = 100): Log =>
  ({ address, topics, data, blockNumber: BigInt(block), transactionHash: `0x${"cd".repeat(32)}`, logIndex: 0 }) as unknown as Log;
const pairCreated = (factory: Address, pair: Address) =>
  log(factory, encodeEventTopics({ abi: [PAIR], eventName: "PairCreated", args: { token0: DNA, token1: WETH } }) as Hex[], encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [pair, 1n]));
const poolCreated = (factory: Address, pool: Address, fee: number, a = DNA, b = WETH) =>
  log(factory, encodeEventTopics({ abi: [POOL], eventName: "PoolCreated", args: { token0: a, token1: b, fee } }) as Hex[], encodeAbiParameters([{ type: "int24" }, { type: "address" }], [60, pool]));

test("v2/v3: pairs and pools from the known factories only", () => {
  const p1: Address = "0x1000000000000000000000000000000000000001", p2: Address = "0x2000000000000000000000000000000000000002", p3: Address = "0x3000000000000000000000000000000000000003", p4: Address = "0x4000000000000000000000000000000000000004";
  const c = clonesFrom([
    pairCreated("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", p1),
    poolCreated("0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", p2, 2500),
    pairCreated("0x9999999999999999999999999999999999999999", p3), // same event from an unknown contract
    poolCreated("0x1F98431c8aD98523631AE4a59f267346ea31F984", p3, 10_000, WETH, USDC), // another token's pool
    pairCreated("0x1097053Fd2ea711dad45caCcc45EfF7548fCB362", p4),
  ], T);
  assert.deepEqual(c.map((x) => [x.venue, x.version, x.id, x.fee, x.other, x.hooks]), [
    ["Uniswap v2", 2, p1.toLowerCase(), 3000, WETH, null],
    ["PancakeSwap v3", 3, p2.toLowerCase(), 2500, WETH, null],
    ["PancakeSwap v2", 2, p4.toLowerCase(), 2500, WETH, null],
  ]);
});

test("alerts: one per run, the first three copies, then a count", () => {
  const c = (n: number) => ({ id: `0x${String(n).repeat(40).slice(0, 40)}`, venue: "Uniswap v2", version: 2 as const, other: WETH, fee: 3000, hooks: null, block: n, tx: "0x" });
  assert.equal(alertText([c(1)]), `New DNA pools without DNA's hook (they pay DNA nothing; listed on /trade): Uniswap v2, 0.3% LP fee, ${c(1).id} (block 1).`);
  const five = alertText([1, 2, 3, 4, 5].map(c));
  assert.match(five, /\(block 3\); and 2 more\.$/);
  assert.ok(!five.includes(c(4).id));
});

test("leakage: DNA moved through the official pool vs its copies, on real swap logs", () => {
  const copies = clonesFrom(fixture("v4-initialize-26121990-26122040.json"), REF);
  const v = dnaVolume(fixture("v4-swap-26122033-26122046.json"), REF, copies);
  // sums of |amount1| (the token is currency1 in both pools), computed independently from the raw log data
  assert.equal(v.canonical, 308_333_219_797_681_260_575_110_775n);
  assert.deepEqual([...v.byClone], [[ETH_COPY, 143_221_700_805_464_274_073_232n]]);
  assert.equal(leakagePct(v.canonical, 143_221_700_805_464_274_073_232n), 0.05);
  assert.equal(leakagePct(0n, 0n), 0);
  assert.equal(leakagePct(1n, 3n), 75);
});

test("leakage: v2, v3 and PancakeSwap v3 swaps count the DNA side", () => {
  const V2 = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");
  const V3 = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
  const CAKE = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)");
  const a: Address = "0x1000000000000000000000000000000000000001", b: Address = "0x2000000000000000000000000000000000000002", c: Address = "0x3000000000000000000000000000000000000003";
  const clones = [
    { id: a.toLowerCase(), venue: "Uniswap v2", version: 2 as const, other: WETH, fee: 3000, hooks: null, block: 1, tx: "0x" },
    { id: b.toLowerCase(), venue: "Uniswap v3", version: 3 as const, other: USDC, fee: 500, hooks: null, block: 1, tx: "0x" }, // DNA < USDC: DNA is token0
    { id: c.toLowerCase(), venue: "PancakeSwap v3", version: 3 as const, other: WETH, fee: 2500, hooks: null, block: 1, tx: "0x" },
  ];
  const t = (abi: typeof V2 | typeof V3 | typeof CAKE) => encodeEventTopics({ abi: [abi], eventName: "Swap", args: {} as never }) as Hex[];
  const pad = (topics: Hex[]) => [topics[0], `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`] as Hex[]; // topic0 + the two indexed addresses
  const logs = [
    log(a, pad(t(V2)), encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [7n, 0n, 0n, 1n])), // sells 7 DNA (DNA = token0 < WETH)
    log(b, pad(t(V3)), encodeAbiParameters([{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }], [-11n, 5n, 1n, 1n, 0])),
    log(c, pad(t(CAKE)), encodeAbiParameters([{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint128" }, { type: "uint128" }], [13n, -2n, 1n, 1n, 0, 0n, 0n])),
    log("0x4000000000000000000000000000000000000004", pad(t(V2)), encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [99n, 0n, 0n, 1n])), // not a known copy
  ];
  const v = dnaVolume(logs, T, clones);
  assert.equal(v.canonical, 0n);
  assert.deepEqual(Object.fromEntries(v.byClone), { [a.toLowerCase()]: 7n, [b.toLowerCase()]: 11n, [c.toLowerCase()]: 13n });
});

test("fetching: windows of the range, halved on a provider range error; the six creation queries; measure", async () => {
  const seen: [bigint, bigint][] = [];
  const get = async (q: { fromBlock: bigint; toBlock: bigint }) => {
    if (q.toBlock - q.fromBlock + 1n > 3n) throw new Error("query exceeds max block range 3");
    seen.push([q.fromBlock, q.toBlock]);
    return [];
  };
  await windowed(get, { address: PM }, 0n, 9n, 10n);
  assert.deepEqual(seen, [[0n, 1n], [2n, 3n], [4n, 5n], [6n, 7n], [8n, 9n]]); // 10 → 5 → 2 blocks a query
  await assert.rejects(windowed(async () => { throw new Error("rate limited"); }, { address: PM }, 0n, 1n), /rate limited/);

  const asked: { address: Address | Address[]; args?: Record<string, unknown> }[] = [];
  const all = fixture("v4-initialize-26121990-26122040.json");
  const found = await findClones(async (q) => { asked.push(q); return q.args?.currency1 || q.args?.currency0 ? all : []; }, REF, 1n, 2n);
  assert.equal(asked.length, 6);
  assert.deepEqual(found.map((x) => x.id), [ETH_COPY, USDC_COPY], "the same log from two queries is one copy");

  const swaps = fixture("v4-swap-26122033-26122046.json");
  const lk = await measure(async () => swaps, REF, found, 26_122_033n, 26_122_046n);
  assert.deepEqual(lk, { fromBlock: 26_122_033, toBlock: 26_122_046, canonicalDna: "308333219797681260575110775", cloneDna: "143221700805464274073232", pct: 0.05, byClone: [{ id: ETH_COPY, dna: "143221700805464274073232" }] });

  // v2/v3 copies: their own addresses, filtered to the three swap events (no Sync / Mint / Transfer traffic)
  const qs: Parameters<GetLogs>[0][] = [];
  const v2: Clone = { id: "0x1000000000000000000000000000000000000001", venue: "Uniswap v2", version: 2, other: WETH, fee: 3000, hooks: null, block: 1, tx: "0x" };
  await measure(async (q) => { qs.push(q); return []; }, T, [v2], 1n, 2n);
  assert.equal(qs.length, 2);
  assert.deepEqual(qs[1].address, [v2.id]);
  assert.deepEqual(qs[1].events?.map((e) => `${e.name}/${e.inputs.length}`), ["Swap/6", "Swap/7", "Swap/9"]);
});
