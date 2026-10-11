// The swap box's chain side (app/trade/swap.ts): the router calldata it builds must be the bytes the contracts suite
// pins (contracts/test/URCalldata.t.sol, the call shape the mainnet fork suite proves), and its wallet check must let
// through only the three calls a swap needs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from "viem";
import { approveCall, checkTx, floorFor, minOut, PERMIT2, permit2Call, poolId, poolKey, quoteCall, readQuote, swapCall, UR } from "../app/trade/swap.ts";

const sol = readFileSync(new URL("../../contracts/test/URCalldata.t.sol", import.meta.url), "utf8");
const pinned = (name) => `0x${sol.match(new RegExp(`bytes constant ${name} =\\s*hex"([0-9a-f]*)"`))[1]}`;
const TOKEN = "0x1111111111111111111111111111111111111111";
const HOOK = "0x2222222222222222222222222222222222223fFf";
const DEADLINE = 1_800_000_000n;
const key = poolKey(TOKEN, HOOK);

test("buy and sell calldata equal the bytes the contracts suite pins", () => {
  const buy = swapCall(key, true, 10n ** 17n, 380_000n * 10n ** 18n, DEADLINE);
  assert.equal(buy.to, UR);
  assert.equal(buy.value, 10n ** 17n, "a buy sends exactly amountIn");
  assert.equal(buy.data, pinned("BUY"));
  const sell = swapCall(key, false, 1_000_000n * 10n ** 18n, 25n * 10n ** 16n, DEADLINE);
  assert.equal(sell.value, 0n);
  assert.equal(sell.data, pinned("SELL"));
  assert.ok(pinned("BUY").length > 1000, "the pinned bytes are filled in");
});

test("pool key and id: (ETH, DNA, dynamic fee, tick spacing 1, the hook)", () => {
  assert.deepEqual(key, { currency0: "0x0000000000000000000000000000000000000000", currency1: TOKEN, fee: 0x800000, tickSpacing: 1, hooks: HOOK });
  const KEY = [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }];
  assert.equal(poolId(key), keccak256(encodeAbiParameters(KEY, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks])));
});

test("quotes: the v4 Quoter's exact-in single call, amountOut read back; min out rounds down", () => {
  const q = quoteCall(key, false, 5n);
  const abi = parseAbi(["struct K { address c0; address c1; uint24 fee; int24 ts; address hooks; }", "struct P { K key; bool zeroForOne; uint128 exactAmount; bytes hookData; }", "function quoteExactInputSingle(P params) returns (uint256, uint256)"]);
  const { args } = decodeFunctionData({ abi, data: q.data });
  assert.deepEqual([args[0].zeroForOne, args[0].exactAmount, args[0].hookData, args[0].key.hooks], [false, 5n, "0x", HOOK]);
  const out = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [123n, 456n]);
  assert.equal(readQuote(out), 123n);
  assert.equal(minOut(10_000n, 100), 9_900n);
  assert.equal(minOut(999n, 100), 989n);
  assert.throws(() => swapCall(key, true, 2n ** 128n, 1n, DEADLINE), /too large/);
});

test("the signed minimum comes from the quote the visitor saw; a fresh quote under it stops the swap", () => {
  assert.equal(floorFor(10_000n, 10_000n, 100), 9_900n);
  assert.equal(floorFor(10_000n, 12_000n, 100), 9_900n, "a better fresh quote never raises the minimum the visitor agreed to");
  assert.equal(floorFor(10_000n, 9_900n, 100), 9_900n, "exactly at the floor still goes");
  assert.equal(floorFor(10_000n, 9_899n, 100), null, "under the floor: the quote moved");
  assert.equal(floorFor(10_000n, 1n, 100), null);
});

test("wallet check: only the router swap, the bounded token → Permit2 approval and Permit2 → router", () => {
  const me = "0x3333333333333333333333333333333333333333";
  const erc20 = parseAbi(["function approve(address, uint256)", "function transfer(address, uint256)"]);
  const p2 = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
  const ok = [
    { ...swapCall(key, true, 1n, 1n, DEADLINE), from: me },
    { ...swapCall(key, false, 1n, 1n, DEADLINE), from: me },
    approveCall(TOKEN, 5n),
    permit2Call(TOKEN, 5n, 1),
  ];
  for (const t of ok) assert.equal(checkTx(t, key), null);
  const bad = [
    { from: me, to: TOKEN, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [me, 5n] }) },
    { from: me, to: TOKEN, value: 0n, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [me, 5n] }) },
    { from: me, to: PERMIT2, value: 0n, data: encodeFunctionData({ abi: p2, functionName: "approve", args: [TOKEN, me, 5n, 1n] }) },
    { from: me, to: PERMIT2, value: 0n, data: encodeFunctionData({ abi: p2, functionName: "approve", args: [me, UR, 5n, 1n] }) },
    { from: me, to: me, value: 1n, data: "0x" },
    { ...swapCall(poolKey(TOKEN, me), true, 1n, 1n, DEADLINE), from: me }, // another pool
    { ...swapCall(key, true, 1n, 1n, DEADLINE), value: 2n, from: me }, // more ETH than the swap takes
    { ...swapCall(key, false, 1n, 1n, DEADLINE), value: 1n, from: me },
    { from: me, to: TOKEN, value: 1n, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [PERMIT2, 5n] }) },
  ];
  for (const t of bad) assert.notEqual(checkTx(t, key), null, JSON.stringify(t, (_, v) => (typeof v === "bigint" ? String(v) : v)));
});
