// Collecting a jackpot share or an idea reward that GamePot could not push (the winning wallet refused the ETH): the
// record sits in GamePot.prizes for 7 days, and only its winner can pull it, to any address (GamePot.claim).
import { type Address, decodeErrorResult, encodeFunctionData, type Hex, isAddress, parseAbi, zeroAddress } from "viem";

export const GAME_POT: Address = "0xD7791D44db6f205183e9084671B95a4BE26ea6bb";
export const GAME_POT_CODEHASH: Hex = "0x225024f8eaf9b9b458075540cb90f8aa093522c18be0e81fdc1342be107c480b";
export const CLAIM_WINDOW = 7 * 86_400; // GamePot.CLAIM_WINDOW
export const MAX_COLLECT = 50; // ids per transaction

export const potAbi = parseAbi([
  "function drawCount() view returns (uint256)",
  "function prizes(uint256) view returns (address winner, uint64 amount, uint32 wonAt)",
  "function claim(uint256[] drawIds, address to) returns (uint256 total)",
  "error NotWinner()",
  "error AlreadyClaimed()",
]);

export type Owed = { id: bigint; amount: bigint; wonAt: number };
type Row = { id: bigint; winner: Address; amount: bigint; wonAt: number };

/** The records `account` can still collect: its own, amount still on-chain. claim has no deadline: after wonAt + 7 days
 *  anyone may expireClaim it (amount → 0), so a late record is still shown, marked as at risk, until that happens. */
export const collectable = (rows: Row[], account: Address): Owed[] =>
  rows.filter((r) => r.winner.toLowerCase() === account.toLowerCase() && r.amount > BigInt(0))
    .map(({ id, amount, wonAt }) => ({ id, amount, wonAt }));

/** Why `to` can't receive a collected prize (null = fine). 0x0 would burn it and the pot would take it back as new
 *  jackpot money: both pass the simulation, so they are refused here. */
export const destProblem = (to: string): string | null => !isAddress(to) ? "enter the address to send it to"
  : to.toLowerCase() === zeroAddress || to.toLowerCase() === GAME_POT.toLowerCase() ? "that address would lose the prize: pick a wallet you own" : null;

export const collectCall = (ids: bigint[], to: Address) =>
  ({ to: GAME_POT, value: BigInt(0), data: encodeFunctionData({ abi: potAbi, functionName: "claim", args: [ids, to] }) });

const PLAIN: Record<string, string> = {
  NotWinner: "One of these isn't this wallet's.",
  AlreadyClaimed: "It was already collected, or it expired.",
};
export function potRefusal(e: unknown): string | null {
  for (let x = e as { data?: unknown; cause?: unknown } | undefined, i = 0; x && i < 8; x = x.cause as typeof x, i++) {
    const raw = typeof x.data === "string" ? x.data : typeof (x.data as { data?: unknown })?.data === "string" ? (x.data as { data: string }).data : null;
    if (!raw || !/^0x[0-9a-fA-F]{8}/.test(raw)) continue;
    try {
      const { errorName } = decodeErrorResult({ abi: potAbi, data: raw as Hex });
      return `${PLAIN[errorName] ?? "The pot refused it."} (${errorName})`;
    } catch {
      return null;
    }
  }
  return null;
}
