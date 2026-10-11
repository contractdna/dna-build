// The jackpot list's tree, in the browser: the same rules as engine/src/tickets.ts (the engine builds it, the watchdog and
// scripts/verify-draw.ts rebuild it). web/test/draw.test.mjs pins the golden vector contracts/test/GamePot.t.sol and
// engine/test/tickets.test.ts check. leaf = keccak256(keccak256(abi.encode(index, account, cumStart, tickets))),
// sorted-pair keccak, an odd node promoted: OZ MerkleProof.verify accepts every proof.
import { concat, encodeAbiParameters, type Hex, keccak256 } from "viem";

export type ListLeaf = { index: number; account: string; cumStart: string; tickets: string };
export type DrawList = { window: number; start: number; end: number; capBps: number; minBalance: string; totalTickets: string; holders: number; root: Hex; leaves: ListLeaf[] };

const LEAF = [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }] as const;
export const leafHash = (l: ListLeaf) => keccak256(keccak256(encodeAbiParameters(LEAF, [BigInt(l.index), l.account as Hex, BigInt(l.cumStart), BigInt(l.tickets)])));
const pair = (a: Hex, b: Hex) => keccak256(a.toLowerCase() < b.toLowerCase() ? concat([a, b]) : concat([b, a]));

export function tree(hashes: Hex[]): Hex[][] {
  const layers = [hashes];
  while (layers[layers.length - 1].length > 1) {
    const l = layers[layers.length - 1];
    layers.push(Array.from({ length: Math.ceil(l.length / 2) }, (_, i) => (2 * i + 1 < l.length ? pair(l[2 * i], l[2 * i + 1]) : l[2 * i])));
  }
  return layers;
}
export const rootOf = (layers: Hex[][]) => layers[layers.length - 1][0];
export function proofOf(layers: Hex[][], index: number): Hex[] {
  const out: Hex[] = [];
  for (let i = index, d = 0; d < layers.length - 1; d++, i >>= 1) if ((i ^ 1) < layers[d].length) out.push(layers[d][i ^ 1]);
  return out;
}
export const verifyProof = (proof: Hex[], root: Hex, leaf: Hex) => proof.reduce((h, p) => pair(h, p), leaf).toLowerCase() === root.toLowerCase();

/** The leaf whose [cumStart, cumStart + tickets) holds `ticket`. */
export function holderOf(list: Pick<DrawList, "leaves">, ticket: bigint) {
  let lo = 0, hi = list.leaves.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (BigInt(list.leaves[mid].cumStart) <= ticket) lo = mid; else hi = mid - 1;
  }
  return list.leaves[lo];
}

/** GamePot.WINNERS, GamePot.MAX_TICKETS. */
export const WINNERS = 10, MAX_TICKETS = 32;
/** GamePot.ticketAt: the j-th ticket from one VRF word, keccak256(abi.encode(rand, j)) mod total. */
export const ticketAt = (rand: bigint, j: number, total: bigint) =>
  BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [rand, BigInt(j)]))) % total;
/** GamePot.settle's walk (engine/src/tickets.ts pickWinners): tickets j = 0, 1, … while j < MAX_TICKETS and fewer than
 *  WINNERS accounts are picked; an account already picked, or in `excluded` (lowercase), is skipped. */
export function walk(list: Pick<DrawList, "leaves" | "totalTickets">, rand: bigint, excluded: Set<string> = new Set()) {
  const used: { j: number; ticket: bigint; leaf: ListLeaf; skip?: "duplicate" | "excluded" }[] = [];
  const winners: string[] = [];
  for (let j = 0; j < MAX_TICKETS && winners.length < WINNERS; j++) {
    const ticket = ticketAt(rand, j, BigInt(list.totalTickets));
    const leaf = holderOf(list, ticket);
    const a = leaf.account.toLowerCase();
    const skip = winners.includes(a) ? "duplicate" : excluded.has(a) ? "excluded" : undefined;
    used.push({ j, ticket, leaf, skip });
    if (!skip) winners.push(a);
  }
  return { used, winners };
}
