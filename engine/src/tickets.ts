// Holder-jackpot ticket list: pure and deterministic, shared by the engine (inside the enclave),
// the watchdog (scripts/watchdog.ts), the CLI (scripts/verify-draw.ts) and the web's draw page. Integer math only.
//  - Balances: every DNA Transfer since the single mint; an end-of-block balance holds from that block's timestamp to
//    the next change (intra-block order is irrelevant), clipped to [start, end). The vault's own balance is excluded.
//  - Staked DNA counts for the position's owner from Locked to Withdrawn at ConvictionVault's weight, evaluated
//    piecewise (term ends and streak steps are breakpoints); held DNA counts ×1.
//  - twab = Σ(balance × seconds × mult) / (window seconds × 10_000) with mult in 1/10_000 (the vault's own unit, so
//    ×2.5 × ×1.25 = ×3.125 stays exact); raw tickets = floor(twab / 1e18) whole weighted DNA. Eligible when the
//    unweighted average balance (held + staked) ≥ minBalance.
//  - The per-wallet cap is water-filled: every wallet above a level L gets exactly L, L / Σtickets ≤ capBps / 10_000.
//  - Leaves sorted by account; leaf = keccak256(keccak256(abi.encode(index, account, cumStart, tickets))) (OZ double
//    hash), sorted-pair tree with an odd node promoted, so OZ MerkleProof.verify accepts every proof.
import { type Address, concat, encodeAbiParameters, type Hex, keccak256, stringToHex } from "viem";
import { canonical } from "./canonical.ts";

const H = 3600, DAY = 86_400;
export const ZERO = "0x0000000000000000000000000000000000000000" as const;
export const DEAD = "0x000000000000000000000000000000000000dead" as const;

// ---------------------------------------------------------------- ConvictionVault weights

const TERM = [12 * H, 3 * DAY, 7 * DAY];
const TIER_MULT = [200, 250, 300]; // hundredths, while the term runs
const AFTER_TERM = 200; // ×2 once the term is over, still locked
const STREAK = [[10 * DAY, 200], [5 * DAY, 150], [2 * DAY, 125]] as const;
export const MAX_MULT = 40_000; // ×4, in 1/10_000
export const STREAK_STEPS = [2 * DAY, 5 * DAY, 10 * DAY];
export const streakMult = (age: number) => STREAK.find(([s]) => age >= s)?.[1] ?? 100;
export type Position = { id: number; owner: Address; amount: bigint; start: number; terms: { termStart: number; tier: number }[]; withdrawnAt: number | null };
/** ConvictionVault._weight's multiplier at T in 1/10_000 (terms: the first at `start`, then every recommit). */
export function multAt(p: Position, T: number) {
  const t = [...p.terms].reverse().find((x) => x.termStart <= T) ?? p.terms[0];
  const tier = T - t.termStart < TERM[t.tier] ? TIER_MULT[t.tier] : AFTER_TERM;
  return Math.min(tier * streakMult(Math.max(0, T - p.start)), MAX_MULT);
}
/** Every time the multiplier can change. */
const breakpoints = (p: Position) => [...STREAK_STEPS.map((s) => p.start + s), ...p.terms.flatMap((t) => [t.termStart, t.termStart + TERM[t.tier]])];

// ---------------------------------------------------------------- inputs

export type Transfer = { at: number; from: Address; to: Address; value: bigint }; // in chain order
export type VaultEvent =
  | { at: number; event: "Locked"; id: number; owner: Address; amount: bigint; tier: number }
  | { at: number; event: "Recommitted"; id: number; tier: number; termStart: number }
  | { at: number; event: "Withdrawn"; id: number };
export type Params = { capBps: number; minBalance: bigint };
export type Window = { window: number; start: number; end: number };

export function positionsOf(evs: VaultEvent[]): Position[] {
  const ps = new Map<number, Position>();
  for (const e of evs) {
    if (e.event === "Locked") ps.set(e.id, { id: e.id, owner: e.owner.toLowerCase() as Address, amount: e.amount, start: e.at, terms: [{ termStart: e.at, tier: e.tier }], withdrawnAt: null });
    const p = ps.get(e.id);
    if (!p) continue;
    if (e.event === "Recommitted") p.terms.push({ termStart: e.termStart, tier: e.tier });
    if (e.event === "Withdrawn") p.withdrawnAt = e.at;
  }
  return [...ps.values()];
}

// ---------------------------------------------------------------- TWAB

const overlap = (a: number, b: number, w: Window) => Math.max(0, Math.min(b, w.end) - Math.max(a, w.start));
export type Acc = { weighted: bigint; plain: bigint }; // Σ wei·s·mult(1e4), Σ wei·s

/** Per account: Σ balance·seconds·mult and Σ balance·seconds over the window (held ×1 + staked at its weight). */
export function accumulate(transfers: Transfer[], vaultEvents: VaultEvent[], vault: Address, w: Window) {
  const acc = new Map<string, Acc>();
  const add = (a: string, wei: bigint, secs: number, mult: number) => {
    if (secs <= 0 || wei === 0n) return;
    const x = acc.get(a) ?? { weighted: 0n, plain: 0n };
    x.weighted += wei * BigInt(secs) * BigInt(mult);
    x.plain += wei * BigInt(secs);
    acc.set(a, x);
  };
  const bal = new Map<string, { wei: bigint; since: number }>();
  const move = (a: string, d: bigint, at: number) => {
    const b = bal.get(a) ?? { wei: 0n, since: at };
    add(a, b.wei, overlap(b.since, at, w), 10_000);
    bal.set(a, { wei: b.wei + d, since: at });
  };
  for (const t of transfers) { // a transfer at or after `end` adds nothing (clipped); a self-transfer nets to zero
    const from = t.from.toLowerCase(), to = t.to.toLowerCase();
    if (from !== ZERO) move(from, -t.value, t.at);
    if (to !== ZERO) move(to, t.value, t.at);
  }
  for (const [a, b] of bal) add(a, b.wei, overlap(b.since, w.end, w), 10_000);
  acc.delete(vault.toLowerCase()); // staked DNA counts for its owners below, never twice
  for (const p of positionsOf(vaultEvents.filter((e) => e.at < w.end))) {
    const until = p.withdrawnAt ?? Infinity;
    const cuts = [...new Set([p.start, ...breakpoints(p), until, w.start, w.end].filter((x) => x >= p.start && x <= until && Number.isFinite(x)))].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) add(p.owner, p.amount, overlap(cuts[i], cuts[i + 1], w), multAt(p, cuts[i]));
  }
  return acc;
}

// ---------------------------------------------------------------- the cap

export type Raw = { account: string; raw: bigint };
/** Water-filling: the k largest get exactly L = floor(cap·S_k / (10_000 − cap·k)) (S_k = Σ of the rest), the first k
 *  for which the next one is ≤ L. Then L·10_000 ≤ cap·Σtickets. null = no level exists (fewer wallets than 1/cap).
 *  Ties are ordered by account, so the result is deterministic. */
export function waterfill(rows: Raw[], capBps: number): { account: string; tickets: bigint }[] | null {
  const s = rows.filter((r) => r.raw > 0n).sort((a, b) => (a.raw === b.raw ? (a.account < b.account ? -1 : 1) : a.raw > b.raw ? -1 : 1));
  const cap = BigInt(capBps);
  const suffix = Array<bigint>(s.length + 1).fill(0n);
  for (let i = s.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + s[i].raw;
  for (let k = 0; k < s.length; k++) {
    const denom = 10_000n - cap * BigInt(k);
    if (denom <= 0n) return null;
    const L = (cap * suffix[k]) / denom;
    if (s[k].raw > L) continue;
    if (L === 0n) return null;
    return s.map((r, i) => ({ account: r.account, tickets: i < k ? L : r.raw }));
  }
  return null;
}

// ---------------------------------------------------------------- tree

export type Leaf = { index: number; account: Address; cumStart: bigint; tickets: bigint };
const LEAF = [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }] as const;
export const leafHash = (l: Leaf) => keccak256(keccak256(encodeAbiParameters(LEAF, [BigInt(l.index), l.account, l.cumStart, l.tickets])));
const hashPair = (a: Hex, b: Hex) => keccak256(a.toLowerCase() < b.toLowerCase() ? concat([a, b]) : concat([b, a]));

/** Layers bottom-up; an odd node is promoted unchanged. */
export function tree(hashes: Hex[]): Hex[][] {
  if (!hashes.length) throw new Error("empty tree");
  const layers = [hashes];
  while (layers[layers.length - 1].length > 1) {
    const l = layers[layers.length - 1];
    layers.push(Array.from({ length: Math.ceil(l.length / 2) }, (_, i) => (2 * i + 1 < l.length ? hashPair(l[2 * i], l[2 * i + 1]) : l[2 * i])));
  }
  return layers;
}
export const rootOf = (layers: Hex[][]) => layers[layers.length - 1][0];
export function proofOf(layers: Hex[][], index: number): Hex[] {
  const out: Hex[] = [];
  for (let i = index, d = 0; d < layers.length - 1; d++, i >>= 1) {
    const sib = i ^ 1;
    if (sib < layers[d].length) out.push(layers[d][sib]);
  }
  return out;
}
/** OZ MerkleProof.verify. */
export const verifyProof = (proof: Hex[], root: Hex, leaf: Hex) => proof.reduce((h, p) => hashPair(h, p), leaf).toLowerCase() === root.toLowerCase();

// ---------------------------------------------------------------- the cap policy

/** The per-wallet cap: 1% if the newest POSTED draw (ListPosted's `holders`, on chain) is RECENT and had ≥ 100
 *  wallets; else 2% (needs 50 wallets with tickets; below that the window is skipped). Recent = one of the last
 *  `lookback` (2) windows that can have a posted list when window w's params are read: w−2 and w−3 (w−1 is still open
 *  then). So no posted draw, or only an old one, = 2%: a pool that shrinks below 100 wallets draws again after two
 *  skipped windows. Recomputable by anyone from the chain (src/draw-verify.ts). Both caps are inside GamePot's
 *  0.5–2% range. */
export const CAP_POLICY = { normal: 100, small: 200, lookback: 2 } as const;
export const capFor = (lastHolders: number | null | undefined) => (lastHolders != null && lastHolders >= 10_000 / CAP_POLICY.normal ? CAP_POLICY.normal : CAP_POLICY.small);
/** The newest posted list if it counts for window w's cap (recent, see CAP_POLICY), else null. */
export const recentList = <T extends { window: number }>(w: number, last: T | null | undefined) => (last && last.window >= w - 1 - CAP_POLICY.lookback ? last : null);
export const capForWindow = (w: number, last: { window: number; holders: number } | null | undefined) => capFor(recentList(w, last)?.holders);

// ---------------------------------------------------------------- the list

/** What a list is built from, besides the chain: the window, its announced params, the blocks both providers agreed on. */
export type ListMeta = Window & Params & { startBlock: number; endBlock: number; endBlockHash: Hex; paramsSeq: string | null };
/** The published list (the `draw-list` record's body, canonical JSON; dataHash = keccak256 of exactly those bytes). */
export type DrawList = Window & {
  capBps: number; minBalance: string; startBlock: number; endBlock: number; endBlockHash: Hex; paramsSeq: string | null; excludedHash: Hex;
  totalTickets: string; holders: number; root: Hex; leaves: { index: number; account: Address; cumStart: string; tickets: string }[];
};
export type Built = { list: DrawList; bytes: string; dataHash: Hex; layers: Hex[][] } | { skip: string; eligible: number };
/** Accounts that held anything in the window (the exclusion reads only need these). */
export const candidates = (acc: Map<string, { plain: bigint }>) => [...acc].filter(([, a]) => a.plain > 0n).map(([k]) => k);

/** keccak256 of a sorted, lowercase exclusion list: what the params record pins. */
export const excludedHash = (accounts: string[]) => keccak256(stringToHex(canonical([...new Set(accounts.map((a) => a.toLowerCase()))].sort())));

/** The whole list for one window. `excluded`: the on-chain set + PlatformRevenue + Bootstrap + the announced exchange
 *  wallets (lowercase). Canonical JSON (sorted keys, decimal strings, lowercase hex); dataHash = keccak256(bytes). */
export function buildList(meta: ListMeta, acc: Map<string, Acc>, excluded: string[]): Built {
  const W = BigInt(meta.end - meta.start);
  const ex = new Set(excluded.map((a) => a.toLowerCase()));
  const raw: Raw[] = [];
  for (const [account, a] of acc) {
    if (ex.has(account) || a.plain / W < meta.minBalance) continue; // unweighted average balance ≥ minBalance
    raw.push({ account, raw: a.weighted / (W * 10_000n) / 10n ** 18n });
  }
  const capped = waterfill(raw, meta.capBps);
  // eligible = wallets with tickets (raw > 0): the same count a posted list's `holders` is
  const eligible = raw.filter((r) => r.raw > 0n).length;
  if (!capped) return { skip: `no ticket level fits a ${meta.capBps / 100}% cap with ${eligible} eligible wallets`, eligible };
  capped.sort((a, b) => (a.account < b.account ? -1 : 1));
  let cum = 0n;
  const leaves = capped.map((c, index) => {
    const l = { index, account: c.account as Address, cumStart: cum, tickets: c.tickets };
    cum += c.tickets;
    return l;
  });
  const layers = tree(leaves.map(leafHash));
  const list: DrawList = {
    window: meta.window, start: meta.start, end: meta.end, capBps: meta.capBps, minBalance: meta.minBalance.toString(), startBlock: meta.startBlock, endBlock: meta.endBlock,
    endBlockHash: meta.endBlockHash.toLowerCase() as Hex, paramsSeq: meta.paramsSeq, excludedHash: excludedHash([...ex]), totalTickets: cum.toString(), holders: leaves.length, root: rootOf(layers),
    leaves: leaves.map((l) => ({ index: l.index, account: l.account, cumStart: l.cumStart.toString(), tickets: l.tickets.toString() })),
  };
  const bytes = canonical(list);
  return { list, bytes, dataHash: keccak256(stringToHex(bytes)), layers };
}

/** The leaf (and its proof) holding `ticket`: binary search over cumStart. */
export function winnerOf(list: DrawList, ticket: bigint) {
  let lo = 0, hi = list.leaves.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (BigInt(list.leaves[mid].cumStart) <= ticket) lo = mid; else hi = mid - 1;
  }
  const l = list.leaves[lo];
  return { index: lo, account: l.account, cumStart: BigInt(l.cumStart), tickets: BigInt(l.tickets) };
}
/** GamePot.WINNERS, GamePot.MAX_TICKETS. */
export const WINNERS = 10, MAX_TICKETS = 32;
/** GamePot.ticketAt: the j-th ticket from one VRF word, keccak256(abi.encode(rand, j)) mod total. */
export const ticketAt = (rand: bigint, j: number, total: bigint) =>
  BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [rand, BigInt(j)]))) % total;
export type Pick = { j: number; ticket: bigint; index: number; account: Address; skip?: "duplicate" | "excluded" };
/** GamePot.settle's walk: tickets j = 0, 1, … while j < MAX_TICKETS and fewer than WINNERS accounts are picked; a ticket
 *  whose account was already picked, or is in `excluded` (lowercase; isExcluded at settle time), is skipped. `used` is
 *  every walked ticket in order (settle's exact input), `winners` the accounts by rank. */
export function pickWinners(list: DrawList, rand: bigint, excluded: Set<string> = new Set()) {
  const total = BigInt(list.totalTickets);
  const used: Pick[] = [];
  const winners: Address[] = [];
  for (let j = 0; j < MAX_TICKETS && winners.length < WINNERS; j++) {
    const ticket = ticketAt(rand, j, total);
    const h = winnerOf(list, ticket);
    const a = h.account.toLowerCase();
    const skip = winners.some((w) => w.toLowerCase() === a) ? "duplicate" : excluded.has(a) ? "excluded" : undefined;
    used.push({ j, ticket, index: h.index, account: h.account, skip });
    if (!skip) winners.push(h.account);
  }
  return { used, winners };
}
export const toLeaf = (l: DrawList["leaves"][number]): Leaf => ({ index: l.index, account: l.account, cumStart: BigInt(l.cumStart), tickets: BigInt(l.tickets) });

/** Everything a verifier checks on a list besides rebuilding it: sorted unique accounts, contiguous ranges from 0,
 *  Σ = total, nobody excluded, every wallet ≤ the cap, the water-filling shape, the root. Returns the problems. */
export function checkList(list: DrawList, excluded: string[]): string[] {
  const bad: string[] = [];
  const ex = new Set(excluded.map((a) => a.toLowerCase()));
  let cum = 0n, max = 0n;
  list.leaves.forEach((l, i) => {
    if (l.index !== i) bad.push(`leaf ${i} has index ${l.index}`);
    if (i && list.leaves[i - 1].account >= l.account) bad.push(`leaf ${i} not sorted by account`);
    if (l.account !== l.account.toLowerCase()) bad.push(`leaf ${i} account not lowercase`);
    if (BigInt(l.cumStart) !== cum) bad.push(`leaf ${i} range not contiguous`);
    if (BigInt(l.tickets) <= 0n) bad.push(`leaf ${i} has no tickets`);
    if (ex.has(l.account.toLowerCase())) bad.push(`leaf ${i} is excluded (${l.account})`);
    cum += BigInt(l.tickets);
    if (BigInt(l.tickets) > max) max = BigInt(l.tickets);
  });
  if (cum.toString() !== list.totalTickets) bad.push(`Σ tickets ${cum} ≠ total ${list.totalTickets}`);
  if (list.holders !== list.leaves.length) bad.push(`holders ${list.holders} ≠ ${list.leaves.length} leaves`);
  if (max * 10_000n > BigInt(list.capBps) * cum) bad.push(`a wallet holds ${max} of ${cum} tickets, over the ${list.capBps / 100}% cap`);
  if (list.leaves.length && rootOf(tree(list.leaves.map((l) => leafHash(toLeaf(l))))).toLowerCase() !== list.root.toLowerCase()) bad.push("root does not match the leaves");
  return bad;
}
