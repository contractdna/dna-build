// Staking's chain side, pure (no React, no network): the pinned ConvictionVault and DNA, the four calls the stake panel
// can send and the check every one of them passes before it reaches the wallet, the amount and term rules the form
// enforces, where each position stands, and the vault's refusals in plain words.
import { type Address, decodeErrorResult, decodeFunctionData, encodeFunctionData, formatEther, type Hex, parseAbi, parseEther } from "viem";

/** ConvictionVault on mainnet (engine/deployments/1.json `convictionVault`) and the keccak256 of its runtime code. The
 *  immutables (registry, Safe, initializer) are in that code, so the hash pins them too. DNA is the token the vault
 *  bound at launch; the panel reads `token()` before every send and refuses if it is anything else. */
export const STAKE_VAULT: Address = "0xd2EA5B439Cee3A00D1d5c8E33c9dfd387d84A07a";
export const STAKE_VAULT_CODEHASH: Hex = "0x12dd7c15e6107a72148fff483a840415a5a4cb0d4d14bc8a093d9bfc7332f374";
export const DNA: Address = "0x39772D019ed525f667a7cbBF8E64b07120378402";
export const MIN_LOCK = parseEther("10000"); // the vault's MIN_LOCK
/** The three terms (the vault's `term` and `tierMult`): the multiplier while the term runs, ×2 after it. */
export const TIERS = [
  { tier: 0, label: "12 hours", mult: "×2", secs: 12 * 3600 },
  { tier: 1, label: "3 days", mult: "×2.5", secs: 3 * 86400 },
  { tier: 2, label: "7 days", mult: "×3", secs: 7 * 86400 },
] as const;
/** At most this many positions in one withdraw or recommit (gas grows with each). */
export const MAX_BATCH = 50;

const calls = parseAbi([
  "function lock(uint256 amount, uint8 tier) returns (uint256 id)",
  "function withdraw(uint256[] ids) returns (uint256 total)",
  "function recommit(uint256[] ids, uint8 tier)",
]);
export const stakeAbi = parseAbi([
  "function lock(uint256 amount, uint8 tier) returns (uint256 id)",
  "function withdraw(uint256[] ids) returns (uint256 total)",
  "function recommit(uint256[] ids, uint8 tier)",
  "function token() view returns (address)",
  "function count() view returns (uint256)",
  "function safe() view returns (address)",
  "function registry() view returns (address)",
  "function excluded(address) view returns (bool)",
  "function positions(uint256 id) view returns ((address owner, uint8 tier, uint40 start, bool withdrawn, uint128 amount))",
  "function termAt(uint256 id, uint256 T) view returns (uint256 termStart, uint8 tier)",
  "error NotBound()", "error BadTier()", "error Excluded()", "error NotOwner()", "error TooEarly()", "error TooSmall()", "error TooLarge()", "error AlreadyWithdrawn()",
  // DNA is OZ ERC20: its transferFrom refusals surface through lock
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);
/** The registry's operator keys: the vault refuses them as stakers, like the Safe and the excluded team wallets. */
export const registryAbi = parseAbi(["function agent() view returns (address)", "function anchorKey() view returns (address)"]);
export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export type Tx = { to: Address; value: bigint; data: Hex };
const tx = (to: Address, data: Hex): Tx => ({ to, value: BigInt(0), data });
/** Approve exactly `amount` DNA to the vault, nothing more. */
export const approveCall = (token: Address, amount: bigint) => tx(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [STAKE_VAULT, amount] }));
export const lockCall = (amount: bigint, tier: number) => tx(STAKE_VAULT, encodeFunctionData({ abi: calls, functionName: "lock", args: [amount, tier] }));
export const withdrawCall = (ids: bigint[]) => tx(STAKE_VAULT, encodeFunctionData({ abi: calls, functionName: "withdraw", args: [ids] }));
export const recommitCall = (ids: bigint[], tier: number) => tx(STAKE_VAULT, encodeFunctionData({ abi: calls, functionName: "recommit", args: [ids, tier] }));

const tierOk = (t: number) => Number.isInteger(t) && t >= 0 && t < TIERS.length;
const idsOk = (ids: readonly bigint[]) => ids.length > 0 && ids.length <= MAX_BATCH && ids.every((id) => id > BigInt(0));

/** The only transactions the stake panel sends, all with no value: the approval of exactly `amount` DNA to the vault
 *  (`token` is DNA), lock(amount, tier), withdraw(ids) or recommit(ids, tier) on the vault, with a real term, 1 to
 *  MAX_BATCH ids and nothing after the arguments. `amount` is the one the visitor typed (null: no approval or lock). */
export function checkTx(t: Tx, token: Address | null, amount: bigint | null): boolean {
  if (t.value !== BigInt(0)) return false;
  const to = t.to.toLowerCase(), data = t.data.toLowerCase();
  if (token && to === token.toLowerCase()) return amount !== null && amount >= MIN_LOCK && data === approveCall(token, amount).data.toLowerCase();
  if (to !== STAKE_VAULT.toLowerCase()) return false;
  let d;
  try {
    d = decodeFunctionData({ abi: calls, data: t.data });
  } catch {
    return false;
  }
  // the canonical encoding of what was decoded must be the whole calldata: no trailing or reshaped bytes
  if (d.functionName === "lock") {
    const [a, tier] = d.args;
    return amount !== null && a === amount && amount >= MIN_LOCK && tierOk(tier) && data === lockCall(a, tier).data.toLowerCase();
  }
  if (d.functionName === "withdraw") return idsOk(d.args[0]) && data === withdrawCall([...d.args[0]]).data.toLowerCase();
  const [ids, tier] = d.args;
  return idsOk(ids) && tierOk(tier) && data === recommitCall([...ids], tier).data.toLowerCase();
}

/** A typed DNA amount: whole or with up to 18 decimals; commas, spaces and underscores are ignored. */
export function parseAmount(v: string): bigint | null {
  const s = v.replace(/[,\s_]/g, "");
  if (!/^\d+(\.\d{0,18})?$/.test(s)) return null;
  return parseEther(s.endsWith(".") ? s.slice(0, -1) : s);
}

/** An exact DNA amount from wei, with thousands separators and no rounding (a label must match what is signed). */
export function fmtDna(wei: bigint): string {
  const [whole, frac] = formatEther(wei).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

/** Why an amount can't be staked from a wallet holding `balance` (null: unknown yet), or null when it can. */
export function amountProblem(amount: bigint | null, balance: bigint | null): string | null {
  if (amount === null) return "Enter an amount of DNA.";
  if (amount < MIN_LOCK) return "The minimum stake is 10,000 DNA.";
  if (balance !== null && amount > balance) return "That is more DNA than this wallet holds.";
  return null;
}

export type Position = { id: bigint; amount: bigint; tier: number; start: number; withdrawn: boolean; termStart: number; termTier: number };
/** Where a position stands at `now` (unix seconds): the term in force (the first one, or the latest recommit), when
 *  it ends, and whether it can be withdrawn or recommitted (term over, not withdrawn). */
export function stateOf(p: Position, now: number): { term: (typeof TIERS)[number]; unlock: number; open: boolean; label: string } {
  const term = TIERS[p.termTier] ?? TIERS[2];
  const unlock = p.termStart + term.secs;
  const open = !p.withdrawn && now >= unlock;
  const label = p.withdrawn ? "Withdrawn" : open ? "Term over: counts at least ×2 until you withdraw" : `In term: counts ${term.mult}`;
  return { term, unlock, open, label };
}

/** The vault's (or DNA's) custom error inside a failed call, in plain words with its name; null when there is none. */
export function refusal(e: unknown): string | null {
  for (let x = e as { data?: unknown; cause?: unknown } | undefined, i = 0; x && i < 8; x = x.cause as typeof x, i++) {
    const raw = typeof x.data === "string" ? x.data : typeof (x.data as { data?: unknown })?.data === "string" ? (x.data as { data: string }).data : null;
    if (!raw || !/^0x[0-9a-fA-F]{8}/.test(raw)) continue;
    try {
      const { errorName } = decodeErrorResult({ abi: stakeAbi, data: raw as Hex });
      return `${PLAIN[errorName] ?? "The vault refused it."} (${errorName})`;
    } catch {
      return null;
    }
  }
  return null;
}
const PLAIN: Record<string, string> = {
  Excluded: "This wallet can't stake: the vault refuses team and operator wallets.",
  NotBound: "Staking isn't open yet.",
  BadTier: "Pick one of the three terms.",
  TooSmall: "The minimum stake is 10,000 DNA.",
  TooLarge: "That amount is larger than the vault takes.",
  NotOwner: "One of these positions isn't this wallet's.",
  TooEarly: "A position's term isn't over yet.",
  AlreadyWithdrawn: "A position was already withdrawn.",
  ERC20InsufficientAllowance: "The approval is smaller than the amount.",
  ERC20InsufficientBalance: "This wallet holds less DNA than that.",
};
