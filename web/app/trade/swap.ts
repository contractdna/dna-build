// The swap box's chain side, plain TypeScript (no React) so web/test runs it. Exact-input buys and sells of DNA in the
// hook pool through Uniswap's Universal Router, in the one call shape the contracts' mainnet fork suite proves
// (V4_SWAP[SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL] + SWEEP, empty hookData, output taken straight to the sender;
// contracts/test/URCalldata.t.sol pins the bytes). Quotes come from Uniswap's v4 Quoter (the fork suite checks a quote
// equals the router's payout). Sells approve token → Permit2 → router, each bounded to the amount being sold.
import { type Address, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodePacked, type Hex, isAddressEqual, keccak256, parseAbi, zeroAddress } from "viem";

/** Uniswap's Universal Router the fork suite pins (address + runtime code hash), Permit2, and the v4 Quoter (mainnet). */
export const UR: Address = "0xd92A36B0000531EF3063dEd4De20A0783308446C";
export const UR_CODEHASH: Hex = "0x41ccd905c8e4de29ce9536ff49233b79e3085a0987d490664e703ee1e7b1dc49";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const QUOTER: Address = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203";

const V4_SWAP = 0x10, SWEEP = 0x04, SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f;
const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001"; // the router's ActionConstants.MSG_SENDER
const DYNAMIC_FEE = 0x800000;
const MAX_U128 = BigInt(2) ** BigInt(128) - BigInt(1);

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
/** The hook pool: ETH (currency0) / DNA, dynamic fee, tick spacing 1, DNA's hook. The hook accepts no other pool. */
export const poolKey = (token: Address, hook: Address): PoolKey => ({ currency0: zeroAddress, currency1: token, fee: DYNAMIC_FEE, tickSpacing: 1, hooks: hook });

const KEY = [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
] as const;
export const poolId = (k: PoolKey): Hex => keccak256(encodeAbiParameters([{ type: "tuple", components: KEY }], [k]));

// the router's "V2_0" exact-in single params (no minHopPriceX36), as in the fork suite
const SINGLE = [{ type: "tuple", components: [{ name: "poolKey", type: "tuple", components: KEY }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }] as const;
const CUR_AMT = [{ type: "address" }, { type: "uint256" }] as const;
const urAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
export const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
export const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

export type Tx = { from?: Address; to: Address; data: Hex; value: bigint };

/** One exact-in swap: a buy spends `amountIn` wei of ETH, a sell `amountIn` DNA; at least `minOut` comes back. */
export function swapCall(k: PoolKey, buy: boolean, amountIn: bigint, minOut: bigint, deadline: bigint): Tx {
  if (amountIn <= BigInt(0) || amountIn > MAX_U128 || minOut < BigInt(0) || minOut > MAX_U128) throw new Error("amount too large or not positive");
  const [tokenIn, tokenOut] = buy ? [k.currency0, k.currency1] : [k.currency1, k.currency0];
  const params = [
    encodeAbiParameters(SINGLE, [{ poolKey: k, zeroForOne: buy, amountIn, amountOutMinimum: minOut, hookData: "0x" }]),
    encodeAbiParameters(CUR_AMT, [tokenIn, amountIn]),
    encodeAbiParameters(CUR_AMT, [tokenOut, minOut]),
  ];
  const actions = encodePacked(["uint8", "uint8", "uint8"], [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const inputs = [
    encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]),
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [zeroAddress, MSG_SENDER, BigInt(0)]),
  ];
  const commands = encodePacked(["uint8", "uint8"], [V4_SWAP, SWEEP]);
  return { to: UR, value: buy ? amountIn : BigInt(0), data: encodeFunctionData({ abi: urAbi, functionName: "execute", args: [commands, inputs, deadline] }) };
}

/** A sell's two approvals, each bounded to the amount sold: DNA → Permit2, then Permit2 → the router until `expiration`. */
export const approveCall = (token: Address, amount: bigint): Tx => ({ to: token, value: BigInt(0), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, amount] }) });
export const permit2Call = (token: Address, amount: bigint, expiration: number): Tx =>
  ({ to: PERMIT2, value: BigInt(0), data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token, UR, amount, expiration] }) });

/** eth_call to the v4 Quoter for the same swap (its amountOut is what the router pays at the same state). */
export const quoteCall = (k: PoolKey, buy: boolean, amountIn: bigint) =>
  ({ to: QUOTER, data: encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey: k, zeroForOne: buy, exactAmount: amountIn, hookData: "0x" }] }) });
export const readQuote = (ret: Hex) => decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], ret)[0];
/** The least the swap may return: the quote less `slippageBps`, rounded down. */
export const minOut = (quote: bigint, slippageBps: number) => (quote * BigInt(10_000 - slippageBps)) / BigInt(10_000);
/** The minimum the signed swap accepts, from the quote the visitor saw (never from a newer one they didn't). null: the
 *  fresh quote just before sending is already under it, so the price moved: show the new quote and stop. */
export function floorFor(shown: bigint, fresh: bigint, slippageBps: number): bigint | null {
  const floor = minOut(shown, slippageBps);
  return fresh < floor ? null : floor;
}

/** The swap box's own check before anything reaches the wallet: null, or why the transaction is refused. Allowed:
 *  the router swap in this pool rebuilt byte for byte (ETH only for a buy, exactly amountIn), DNA approve(Permit2) and
 *  Permit2 approve(DNA, router), both without ETH. */
export function checkTx(t: Tx, k: PoolKey): string | null {
  try {
    if (isAddressEqual(t.to, UR)) {
      const { args } = decodeFunctionData({ abi: urAbi, data: t.data });
      const [, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], args[1][0]);
      const [p] = decodeAbiParameters(SINGLE, params[0]);
      const again = swapCall(k, p.zeroForOne, p.amountIn, p.amountOutMinimum, args[2]);
      return again.data === t.data && again.value === t.value ? null : "not a swap in DNA's pool";
    }
    if (t.value !== BigInt(0)) return "an approval sends no ETH";
    if (isAddressEqual(t.to, k.currency1)) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: t.data });
      return functionName === "approve" && isAddressEqual(args[0], PERMIT2) ? null : "only an approval to Permit2";
    }
    if (isAddressEqual(t.to, PERMIT2)) {
      const { functionName, args } = decodeFunctionData({ abi: permit2Abi, data: t.data });
      return functionName === "approve" && isAddressEqual(args[0], k.currency1) && isAddressEqual(args[1], UR) ? null : "only a Permit2 approval of DNA to the router";
    }
  } catch {
    return "unreadable call";
  }
  return "unknown destination";
}

/** LIVE, while the deployment manifest (the pool key) cannot be read. */
export const UNREAD = "The pool's address can't be read right now. Try again in a minute.";
