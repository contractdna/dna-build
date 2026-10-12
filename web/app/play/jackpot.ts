// The jackpot's draw rules as the engine and GamePot apply them, for /play (no I/O: tested in test/jackpot.test.mjs).

/** GamePot.SUB_MIN: 200 gwei × (200,000 + 300,000 + 50,000) gas × 124% = 0.1364 ETH. */
export const SUB_MIN = BigInt("136400000000000000");
export const MIN_PRIZE = BigInt("250000000000000000"); // GamePot.MIN_PRIZE (0.25 ETH)
export const PRIZE_CAP = BigInt("3000000000000000000"); // GamePot.PRIZE_CAP (3 ETH)

/** What requestDraw moves from the pot to the VRF subscription: up to SUB_MIN. Unknown balance: the whole SUB_MIN. */
export const topUpOf = (subBalance?: bigint) => subBalance === undefined ? SUB_MIN : subBalance < SUB_MIN ? SUB_MIN - subBalance : BigInt(0);

/** GamePot.requestDraw: the prize is min(pot − top-up, 3 ETH); the draw waits while the pot is under top-up + 0.25 ETH. */
export function prizeOf(pot: bigint, topUp: bigint) {
  const gate = topUp + MIN_PRIZE;
  return { gate, prize: pot < gate ? null : pot - topUp < PRIZE_CAP ? pot - topUp : PRIZE_CAP };
}

export type ParamsRec = { _seq: string };
export type ParamsAnchor = { paramsSeq: string; status: string; blockTime: number | null };
/** engine/src/jackpot.ts paramsOf: a window is drawn only if its params record was anchored (mined) before it started. */
export function drawable(rec: ParamsRec | undefined, anc: ParamsAnchor | undefined, start: number) {
  if (!rec || !anc || anc.paramsSeq !== rec._seq) return false;
  if (anc.status === "dry_run") return true; // a dry run only rehearses
  return anc.status === "mined" && anc.blockTime !== null && anc.blockTime < start;
}
