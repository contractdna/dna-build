// The holder jackpot, engine side. Agent tasks (hourly, agent lane, live, level ≥ 5):
//  - params: for the next window that has not started (≥ PARAMS_MARGIN ahead), record {capBps, minBalance, the exchange
//    wallets + their hash, the reasoning}, then anchor that record on-chain and wait for it to be MINED before the window
//    starts ("announced before the window"); a follow-up record keeps the anchor tx and its block time.
//  - list: for the latest closed window (within LIST_GRACE, not drawn, no draw in flight), once its end is finalized on
//    both providers and the indexer has it: skip unless its params were anchored before its start and the pot covers
//    MIN_PRIZE + the VRF top-up; build the list (src/tickets.ts) from chain_log, record it (`draw-list`: the record body
//    IS the canonical list, so dataHash = keccak256(body)), then postList (anchored first in the enclave: agentCall).
// The keeper side (rollWindow, requestDraw, settle with the walk's leaves from that record, voidDraw) is in games.ts.
import { type Address, getAbiItem, type Hex, keccak256, type PublicClient, stringToHex } from "viem";
import * as abi from "./abi.ts";
import { cursorAgreed, clients, readAgreed } from "./chainref.ts";
import { d, LOG_BASE_URL } from "./config.ts";
import { CAP_INPUT_MAX_AGE } from "./draw-verify.ts";
import { edb as sql } from "./db.ts";
import { agentCall } from "./keepers.ts";
import { canonical } from "./log.ts";
import { latest, nowIso, record } from "./records.ts";
import { type Dep, exclusionSet, vaultEvent, windowBlocks } from "./ticket-source.ts";
import { accumulate, buildList, CAP_POLICY, capFor, capForWindow, candidates, recentList, type DrawList, excludedHash, leafHash, MAX_TICKETS, pickWinners, proofOf, ticketAt, toLeaf, type Transfer, tree, type VaultEvent, winnerOf } from "./tickets.ts";
import { pub, send } from "./tx.ts";

const H = 3600;
/** GamePot constants (contracts/SPEC.md §12; engine/test/games.test.ts checks them against the source). */
export const J = { LIST_DELAY: H, LIST_GRACE: 24 * H, DRAW_SETTLE_WINDOW: 7 * 86_400, MIN_PRIZE: 25n * 10n ** 16n, CAP_BPS: [50, 200], MIN_BALANCE: [100n * 10n ** 18n, 1_000_000n * 10n ** 18n] } as const;
/** Engine policy (published; the contract bounds are the hard limits). capBps 100 = the 1% cap, used while a recent posted draw had ≥ 100 wallets (capForWindow). */
export const JACKPOT_POLICY = { capBps: 100, minBalance: 1_000n * 10n ** 18n, paramsMarginS: 30 * 60 };
/** Exchange hot wallets kept out of the list: maintained here by the team and the AI, pinned by hash in
 *  each window's params record, so a change only applies to windows that start after it is announced. Empty until
 *  DNA lists on an exchange. */
export const CEX_WALLETS: Address[] = [];

/** capInput: the cap policy's on-chain input (the newest ListPosted at or before asOfBlock), so anyone can recompute
 *  capBps (src/draw-verify.ts). */
export type ParamsRec = { kind: "jackpot-params"; window: number; start: number; capBps: number; minBalance: string; cex: string[]; cexHash: Hex;
  capInput: { asOfBlock: number; lastList: { window: number; holders: number; block: number } | null }; reasoning: string; at: string };
export type ParamsAnchor = { kind: "jackpot-params-anchor"; window: number; paramsSeq: string; root: Hex; tx: Hex | null; status: string; blockTime: number | null; at: string };

const rd = <T>(fn: string, args: unknown[] = []) => pub.readContract({ address: d.gamePot!, abi: abi.gamePotAbi, functionName: fn, args } as never) as Promise<T>;
const dep = (): Dep => ({ ...(d as unknown as Dep), gamePot: d.gamePot!, convictionVault: d.convictionVault! });

/** Test seams: block ranges and the exclusion set read through both RPC providers; reads at a past block. */
export const JACKPOT_DEPS = {
  windowBlocks: (start: number, end: number) => windowBlocks(clients, start, end, d.startBlock),
  exclusions: (block: number, accounts: string[], extra: string[]) => readAgreed((c) => exclusionSet(c, dep(), block, accounts, extra)),
  potAt: (block: number) => readAgreed((c) => potState(c, BigInt(block))),
  cancelled: async (w: number, fromBlock: number) =>
    (await sql`select 1 from chain_log where event = 'ListCancelled' and address = ${d.gamePot!.toLowerCase()} and args->>'window' = ${String(w)} limit 1`).length > 0
    || (await readAgreed((c) => c.getLogs({ address: d.gamePot!, event: getAbiItem({ abi: abi.gamePotAbi, name: "ListCancelled" }), args: { window: BigInt(w) }, fromBlock: BigInt(fromBlock) }))).length > 0,
};

// ---------------------------------------------------------------- pure (unit-tested)

/** GamePot._sync without sending it: arrivals above every liability (queued idea rewards included) split 70/30, the
 *  jackpot capped at POT_CAP.
 *  The engine reads the pot it will hold from this without a sync() (requestDraw syncs first); the keeper still syncs
 *  small arrivals hourly (games.ts potActions) because the site shows the on-chain jackpotPot. */
export function syncedPot(v: { claims: bigint; eth: bigint; jackpotPot: bigint; ideaReserve: bigint; queuedRewards: bigint; escrow: bigint; owed: bigint; potCap: bigint; jackpotBps: bigint }) {
  const assets = v.claims + v.eth;
  const liab = v.jackpotPot + v.ideaReserve + v.queuedRewards + v.escrow + v.owed;
  const arrived = assets > liab ? assets - liab : 0n;
  const jp = v.jackpotPot + (arrived * v.jackpotBps) / 10_000n;
  return { arrived, jackpotPot: jp > v.potCap ? v.potCap : jp, overCap: jp > v.potCap };
}

/** The next window whose params can still be anchored and mined before it starts (a late roll never moves a start:
 *  window w + 1 starts at the open window's end, later ones every drawInterval after). */
export function nextParamsWindow(s: { windowId: number; windowEnd: number; drawInterval: number }, now: number, margin = JACKPOT_POLICY.paramsMarginS) {
  let window = s.windowId + 1, start = s.windowEnd;
  while (start - now < margin) { window++; start += s.drawInterval; }
  return { window, start };
}
/** The latest closed window as GamePot.latestClosedWindow says (window 0 = none). */
export const latestClosed = (s: { windowId: number; windowStart: number; windowEnd: number }, now: number) =>
  s.windowId !== 0 && now >= s.windowEnd ? { window: s.windowId, end: s.windowEnd } : { window: Math.max(0, s.windowId - 1), end: s.windowStart };
/** Why window `w`'s list can't be posted now (null = it can). */
export function listBlocked(s: { now: number; end: number; window: number; lastDrawnWindow: number; draw: { window: number; reqId: bigint; fulfilledAt: number } }) {
  if (s.window === 0) return "no closed window yet";
  if (s.now > s.end + J.LIST_GRACE) return "the list grace for this window is over";
  if (s.window <= s.lastDrawnWindow) return "this window was drawn";
  if (s.draw.reqId !== 0n || s.draw.fulfilledAt !== 0) return "a draw is in flight";
  if (s.draw.window >= s.window) return "this window's list is posted";
  return null;
}
/** The params text the post and the record carry (numbers only from the params). */
export const reasoningOf = (p: { capBps: number; minBalance: bigint; cex: number; lastHolders?: number | null }) =>
  `Per-wallet cap ${p.capBps / 100}%, water-filled so no wallet's odds exceed it${p.capBps > CAP_POLICY.normal ? ` (${p.lastHolders != null ? `the last posted draw had ${p.lastHolders} wallets, fewer than the ${10_000 / CAP_POLICY.normal} a ${CAP_POLICY.normal / 100}% cap needs, so ${p.capBps / 100}% until a draw has more` : `no draw was posted in the last ${CAP_POLICY.lookback} windows; a ${CAP_POLICY.normal / 100}% cap needs a recent draw with at least ${10_000 / CAP_POLICY.normal} wallets, so ${p.capBps / 100}% until one has them`})` : ""}; minimum average balance ${(p.minBalance / 10n ** 18n).toLocaleString("en-US")} DNA so dust wallets don't dilute holders; ${p.cex} exchange wallets excluded. Stakers count ×2 to ×4.`;
export { capFor, capForWindow };
/** The cap policy's input, on chain: the newest ListPosted (indexed, finalized) at or before the agreed cursor block. */
async function capInput() {
  const cur = await cursorAgreed();
  const asOfBlock = Number(cur?.block ?? 0);
  const [l] = await sql<{ args: { window: string; holders: string }; block: number }[]>`select args, block::int as block from chain_log where event = 'ListPosted'
    and address = ${d.gamePot!.toLowerCase()} and block <= ${asOfBlock} order by block desc, log_index desc limit 1`;
  return { asOfBlock, lastList: l ? { window: Number(l.args.window), holders: Number(l.args.holders), block: l.block } : null };
}

// ---------------------------------------------------------------- chain reads

const COORD = [{ type: "function", name: "getSubscription", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint96" }, { type: "uint96" }, { type: "uint64" }, { type: "address" }, { type: "address[]" }] }] as const;
/** The pot as GamePot would hold it after a sync, the arrivals waiting for one, and the VRF top-up a request would take
 *  (at `blockNumber`, or latest). */
export async function potState(c: Pick<PublicClient, "readContract" | "getBalance">, blockNumber?: bigint) {
  const g = d.gamePot!;
  const at = { address: g, abi: abi.gamePotAbi, ...(blockNumber === undefined ? {} : { blockNumber }) } as const;
  const r = <T>(functionName: string) => c.readContract({ ...at, functionName } as never) as Promise<T>;
  const [claims, eth, jackpotPot, ideaReserve, queuedRewards, draw, owed, potCap, jackpotBps, subId, subMin, coord] = await Promise.all([
    c.readContract({ address: d.poolManager, abi: abi.poolManagerAbi, functionName: "balanceOf", args: [g, 0n], ...(blockNumber === undefined ? {} : { blockNumber }) }) as Promise<bigint>,
    c.getBalance({ address: g, ...(blockNumber === undefined ? {} : { blockNumber }) }), r<bigint>("jackpotPot"), r<bigint>("ideaReserve"), r<bigint>("queuedRewards"), r<readonly unknown[]>("draw"), r<bigint>("owedTotal"),
    r<bigint>("POT_CAP"), r<bigint>("JACKPOT_BPS"), r<bigint>("subId"), r<bigint>("SUB_MIN"), r<Address>("coordinator"),
  ]);
  const sub = await c.readContract({ address: coord, abi: COORD, functionName: "getSubscription", args: [subId], ...(blockNumber === undefined ? {} : { blockNumber }) });
  const s = syncedPot({ claims, eth, jackpotPot, ideaReserve, queuedRewards, escrow: draw[4] as bigint, owed, potCap, jackpotBps });
  return { ...s, topUp: subMin > sub[1] ? subMin - sub[1] : 0n };
}

// ---------------------------------------------------------------- records + anchors

/** Anchor one record on-chain (root = its enclave-chain hash, else its log hash; uri = the record) and wait for it. */
async function anchorRecord(a: { seq: string; hash: string; ehash?: string | null }, purpose: string) {
  const root = `0x${a.ehash ?? a.hash}` as Hex;
  const r = await send({ key: "anchor", to: d.registry, abi: abi.registryAbi, fn: "anchor", args: [root, `${LOG_BASE_URL}/api/log/${a.seq}`], purpose });
  let blockTime: number | null = null;
  if (r.status === "mined" && r.hash) {
    const rc = await pub.getTransactionReceipt({ hash: r.hash });
    blockTime = Number((await pub.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  }
  return { root, tx: r.hash ?? null, status: r.status, blockTime };
}

export async function paramsTask(now: number) {
  const [windowId, windowEnd, drawInterval] = await Promise.all([rd<bigint>("windowId"), rd<number>("windowEnd"), rd<number>("drawInterval")]);
  if (windowId === 0n) return "GamePot not initialized";
  const { window, start } = nextParamsWindow({ windowId: Number(windowId), windowEnd: Number(windowEnd), drawInterval: Number(drawInterval) }, now);
  // only a mined (or dry-run) anchor counts; a reverted or never-sent one falls through to anchor the record again
  const anc = await latest<ParamsAnchor>("game", `jackpot:params-anchor:${window}`);
  if (anc && (anc.status === "mined" || anc.status === "dry_run")) return `params for window ${window} anchored`;
  let rec: Awaited<ReturnType<typeof latest<ParamsRec>>> | undefined = await latest<ParamsRec>("game", `jackpot:params:${window}`);
  // a record whose cap input has aged past half the verifier's bound (an anchor deferred by gas or reverted) is re-issued
  // with a fresh read, never re-anchored: otherwise the anchor lands > CAP_INPUT_MAX_AGE after asOfBlock and every honest
  // list for the window fails verifyPosted
  const fresh = await capInput();
  if (rec && BigInt(fresh.asOfBlock - rec.capInput.asOfBlock) > CAP_INPUT_MAX_AGE / 2n) rec = undefined;
  let seq = rec?._seq;
  let appended: { seq: string; hash: string; ehash?: string | null } | undefined;
  if (!rec) {
    const input = fresh;
    const lastHolders = recentList(window, input.lastList)?.holders ?? null;
    const p = { capBps: capForWindow(window, input.lastList), minBalance: JACKPOT_POLICY.minBalance, cex: [...new Set(CEX_WALLETS.map((a) => a.toLowerCase()))].sort() };
    const body: ParamsRec = { kind: "jackpot-params", window, start, capBps: p.capBps, minBalance: p.minBalance.toString(), cex: p.cex, cexHash: excludedHash(p.cex),
      capInput: input, reasoning: reasoningOf({ ...p, cex: p.cex.length, lastHolders }), at: nowIso() };
    appended = await record("game", `jackpot:params:${window}`, body);
    rec = { ...body, _seq: appended.seq, _at: new Date() };
    seq = appended.seq;
  } else {
    // a crash between the record and its anchor: anchor the same record (its hashes from the log)
    const [row] = await sql<{ hash: string; ehash: string | null }[]>`select encode(hash, 'hex') as hash, encode(ehash, 'hex') as ehash from log where seq = ${seq!}`;
    appended = { seq: seq!, hash: row.hash, ehash: row.ehash };
  }
  const a = await anchorRecord(appended, `anchor:jackpot-params:${window}`);
  await record("game", `jackpot:params-anchor:${window}`, { kind: "jackpot-params-anchor", window, paramsSeq: seq!, ...a, at: nowIso() } satisfies ParamsAnchor);
  if (a.status === "mined" || a.status === "dry_run") {
    const { publishEvent } = await import("./x.ts");
    await publishEvent(`jackpot-params:${window}`, { event: "jackpot_params", window, capPct: rec.capBps / 100, minBalance: Number(BigInt(rec.minBalance) / 10n ** 18n), exchangesExcluded: rec.cex.length, startsAt: new Date(start * 1000).toISOString(), reasoning: rec.reasoning },
      `${LOG_BASE_URL}/api/log/${seq}`);
  }
  return { window, start, anchor: a.status };
}

/** The params record of window w and whether its anchor was mined before the window started. */
export async function paramsOf(window: number, start: number) {
  const [rec, anc] = await Promise.all([latest<ParamsRec>("game", `jackpot:params:${window}`), latest<ParamsAnchor>("game", `jackpot:params-anchor:${window}`)]);
  if (!rec || !anc || anc.paramsSeq !== rec._seq) return { rec: undefined, why: "no params were announced for this window" };
  if (anc.status === "dry_run") return { rec, why: null }; // a dry run only rehearses
  if (anc.status !== "mined" || anc.blockTime === null || anc.blockTime >= start) return { rec: undefined, why: "its params were not anchored before the window started" };
  return { rec, why: null };
}

/** chain_log → the builder's inputs, up to `endBlock` (DNA Transfers and the vault's position events).
 *  simplification: the whole history every window (one query, one pass); past a few million transfers keep an enclave-signed
 *  running balance snapshot per window end instead. */
export async function chainInputs(endBlock: number) {
  const rows = await sql<{ event: string; at: Date; args: Record<string, unknown>; address: string }[]>`select event, at, args, address from chain_log
    where block <= ${endBlock} and ((event = 'Transfer' and address = ${d.token.toLowerCase()}) or (event in ('Locked', 'Recommitted', 'Withdrawn') and address = ${d.convictionVault!.toLowerCase()}))
    order by block, log_index`;
  const transfers: Transfer[] = [];
  const vaultEvents: VaultEvent[] = [];
  for (const r of rows) {
    const at = Math.floor(r.at.getTime() / 1000);
    if (r.event === "Transfer") transfers.push({ at, from: r.args.from as Address, to: r.args.to as Address, value: BigInt(String(r.args.value)) });
    else vaultEvents.push(vaultEvent(r.event, at, r.args));
  }
  return { transfers, vaultEvents };
}

const once = async (ref: string, body: Record<string, unknown>) => {
  const [done] = await sql`select 1 from log where kind = 'game' and ref = ${ref}`;
  if (!done) await record("game", ref, { ...body, at: nowIso() });
};

export async function listTask(since: Date, now: number) {
  const [windowId, windowStart, windowEnd, lastDrawn, draw] = await Promise.all([
    rd<bigint>("windowId"), rd<number>("windowStart"), rd<number>("windowEnd"), rd<bigint>("lastDrawnWindow"),
    rd<readonly [bigint, number, number, number, bigint, bigint, Hex, bigint, bigint, bigint]>("draw"),
  ]);
  const { window: w, end } = latestClosed({ windowId: Number(windowId), windowStart: Number(windowStart), windowEnd: Number(windowEnd) }, now);
  const blocked = listBlocked({ now, end, window: w, lastDrawnWindow: Number(lastDrawn), draw: { window: Number(draw[0]), reqId: draw[5], fulfilledAt: Number(draw[3]) } });
  if (blocked) return blocked;
  const [rolled] = await sql<{ args: { start: string } }[]>`select args from chain_log where event = 'WindowRolled' and address = ${d.gamePot!.toLowerCase()} and args->>'window' = ${String(w)} limit 1`;
  if (!rolled) return "waiting for the indexer (window start)";
  const start = Number(rolled.args.start);
  const params = await paramsOf(w, start);
  if (!params.rec) { await once(`jackpot:list-skip:${w}`, { kind: "jackpot-list-skip", window: w, reason: params.why }); return params.why; }
  const blocks = await JACKPOT_DEPS.windowBlocks(start, end);
  if (!blocks) return "waiting for the window's end to finalize";
  const cur = await cursorAgreed();
  if (!cur || cur.block < blocks.endBlock) return "waiting for the indexer";
  const pot = await JACKPOT_DEPS.potAt(blocks.endBlock);
  if (pot.jackpotPot < J.MIN_PRIZE + pot.topUp) { await once(`jackpot:list-skip:${w}`, { kind: "jackpot-list-skip", window: w, reason: "the pot was below the minimum prize at the window's end" }); return "pot below the minimum prize"; }
  const { transfers, vaultEvents } = await chainInputs(blocks.endBlock);
  const acc = accumulate(transfers, vaultEvents, d.convictionVault!, { window: w, start, end });
  const excluded = await JACKPOT_DEPS.exclusions(blocks.endBlock, candidates(acc), params.rec.cex);
  const built = buildList({ window: w, start, end, capBps: params.rec.capBps, minBalance: BigInt(params.rec.minBalance), ...blocks, paramsSeq: params.rec._seq }, acc, excluded);
  if ("skip" in built) {
    await once(`jackpot:list-skip:${w}`, { kind: "jackpot-list-skip", window: w, reason: built.skip, eligible: built.eligible });
    return built.skip;
  }
  // a list the Safe cancelled is never re-posted unchanged: the indexed log, and the live chain through both providers
  // (a cancel can be newer than the finalized cursor)
  const prior = await latest<DrawList>("game", `jackpot:list:${w}`);
  const same = prior && canonical(stripMeta(prior)) === built.bytes;
  if (same && (await JACKPOT_DEPS.cancelled(w, blocks.endBlock))) return "the Safe cancelled this list; not re-posting it unchanged";
  const seq = same ? prior._seq : (await record("game", `jackpot:list:${w}`, built.list)).seq;
  if (keccak256(stringToHex(canonical(built.list))) !== built.dataHash) throw new Error("list bytes drifted from its dataHash");
  const last = built.list.leaves[built.list.leaves.length - 1];
  const args = [BigInt(w), { capBps: BigInt(built.list.capBps), minBalance: BigInt(built.list.minBalance) }, built.list.root, BigInt(built.list.totalTickets), BigInt(built.list.holders),
    toLeaf(last), proofOf(built.layers, last.index), `${LOG_BASE_URL}/api/log/${seq}`, built.dataHash];
  const r = await agentCall({ to: d.gamePot!, abi: abi.gamePotAbi, fn: "postList", args, purpose: "agent:game:postList", since });
  return { window: w, holders: built.list.holders, totalTickets: built.list.totalTickets, status: r.status };
}
const stripMeta = <T extends object>(x: T) => Object.fromEntries(Object.entries(x).filter(([k]) => !k.startsWith("_")));

/** settle(leaves, proofs) for the draw on chain, from our own list record (it must match the draw's root): the walk's
 *  every ticket in order (GamePot accepts exactly that prefix). `isExcluded` is read for every account the walk can
 *  reach, as settle reads it. */
export async function settleArgs(window: number, root: Hex, rand: bigint, isExcluded: (a: Address) => Promise<boolean>) {
  const list = await latest<DrawList>("game", `jackpot:list:${window}`);
  if (!list || list.root.toLowerCase() !== root.toLowerCase()) return null; // not our list (the Safe posted it)
  const reach = [...new Set(Array.from({ length: MAX_TICKETS }, (_, j) => winnerOf(list, ticketAt(rand, j, BigInt(list.totalTickets))).account))];
  const excluded = new Set((await Promise.all(reach.map(async (a) => ((await isExcluded(a)) ? a.toLowerCase() : null)))).filter((a): a is string => !!a));
  const { used, winners } = pickWinners(list, rand, excluded);
  const layers = tree(list.leaves.map((l) => leafHash(toLeaf(l))));
  return { leaves: used.map((u) => ({ ...toLeaf(list.leaves[u.index]), index: BigInt(u.index) })), proofs: used.map((u) => proofOf(layers, u.index)), winners };
}
