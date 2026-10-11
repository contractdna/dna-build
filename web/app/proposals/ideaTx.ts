// The idea forms' chain side, plain TypeScript (no React) so web/test and the fork check run it. Two calls to
// IdeaMarket (contracts/src/IdeaMarket.sol), each after one DNA approval bounded to exactly what the call pulls:
//  - submit(title, body, amount): pulls `amount` (the opening stake, transferFrom) and burns SUBMIT_FEE (burnFrom),
//    both from the market's allowance, so the approval is amount + fee;
//  - stake(id, amount): pulls `amount`.
import { type Address, decodeErrorResult, encodeFunctionData, erc20Abi, type Hex, parseAbi, parseEther } from "viem";

export const ideaMarketAbi = parseAbi([
  "function submit(string title, string body, uint256 amount) returns (uint256 id)",
  "function stake(uint256 id, uint256 amount)",
  "function token() view returns (address)",
  "function ideas(uint256) view returns (uint32 round, uint8 index, uint128 staked)",
  "function stakeOf(uint256, address) view returns (uint256)",
  "error BadText()", "error Operator()", "error Unauthorized()", "error RoundFull()", "error TooSmall()", "error CapExceeded()",
  "error UnknownIdea()", "error NotCurrentRound()",
  "event IdeaSubmitted(uint256 indexed id, uint256 indexed round, address indexed author, uint256 index, uint256 stake, string title, string body)",
]);

// IdeaMarket constants (SPEC §10.2), in wei
export const MIN_SUBMIT = parseEther("10000"), SUBMIT_FEE = parseEther("1000"), MIN_STAKE = parseEther("1000");
export const TITLE_MAX = 120, BODY_MAX = 1_000;

export type Call = { to: Address; data: Hex };
export const approveCall = (token: Address, market: Address, amount: bigint): Call =>
  ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [market, amount] }) });
export const submitCall = (market: Address, title: string, body: string, amount: bigint): Call =>
  ({ to: market, data: encodeFunctionData({ abi: ideaMarketAbi, functionName: "submit", args: [title, body, amount] }) });
export const stakeCall = (market: Address, id: bigint, amount: bigint): Call =>
  ({ to: market, data: encodeFunctionData({ abi: ideaMarketAbi, functionName: "stake", args: [id, amount] }) });
/** What a submit pulls from the market's allowance: the opening stake plus the burned fee. */
export const submitNeeds = (amount: bigint) => amount + SUBMIT_FEE;

/** A whole or decimal DNA amount typed by the visitor, in wei; null when it isn't a positive number. */
export function dnaOf(v: string): bigint | null {
  try {
    const a = parseEther(v.trim());
    return a > BigInt(0) ? a : null;
  } catch {
    return null;
  }
}

/** IdeaMarket's custom errors in plain words (anything else: the wallet's or node's own message). */
export const PLAIN: Record<string, string> = {
  BadText: "the title must be 1 to 120 bytes and the text at most 1,000",
  Operator: "this address runs DNA (Safe, agent or anchor key) and can't submit or stake",
  Unauthorized: "this address can't do that",
  RoundFull: "this round is full: 112 public ideas",
  TooSmall: "under the minimum: 10,000 DNA to submit, 1,000 DNA to stake",
  CapExceeded: "over a cap: 1,000,000 DNA per address per round, 2,000,000 DNA per idea",
  UnknownIdea: "no idea with this number",
  NotCurrentRound: "this idea's round has closed; stakes go only to ideas in the open round",
};
/** The plain reason for an IdeaMarket revert inside an error (viem's, or a wallet's: the revert data somewhere in its
 *  cause chain), else null. */
export function plainError(e: unknown): string | null {
  let x = e as { data?: unknown; cause?: unknown } | undefined;
  for (let i = 0; x && i < 8; x = x.cause as typeof x, i++) {
    const d = typeof x.data === "string" ? x.data : (x.data as { data?: unknown } | undefined)?.data;
    if (typeof d !== "string" || !/^0x[0-9a-f]{8}/i.test(d)) continue;
    try {
      const name = decodeErrorResult({ abi: ideaMarketAbi, data: d as Hex }).errorName;
      if (PLAIN[name]) return PLAIN[name];
    } catch { /* not one of IdeaMarket's errors */ }
  }
  return null;
}
