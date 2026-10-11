// Full check of a posted jackpot list, shared by the watchdog (scripts/watchdog.ts) and the CLI
// (scripts/verify-draw.ts). Needs only RPCs (≥ 2 for the watchdog) and the public log API; no DB, no keys.
//  1. the list record (ListPosted's uri): keccak256(body) = dataHash; body is canonical JSON; root / total / holders /
//     window / params equal the event's; enclave records: ehash recomputes and esig recovers to the log signer
//  2. the params record it names: same window and params, the exchange list matches its hash, and it was anchored
//     on-chain (Anchored(root = its ehash or hash)) in a block BEFORE the window started
//  3. the window's bounds = WindowRolled's; {startBlock, endBlock, endBlockHash} = what every provider reports
//  4. a full rebuild from each provider's Transfer + vault history: same bytes (dataHash) and root
//  5. the list's own shape: sorted, contiguous, Σ = total, nobody excluded, nobody above the cap
import { getAbiItem, type Hex, keccak256, parseEventLogs, type PublicClient, stringToHex } from "viem";
import * as abi from "./abi.ts";
import { canonical } from "./canonical.ts";
import { checkRecord, type SignedRecord } from "./proof.ts";
import { type Dep, exclusionSet, fromRpc, getLogsChunked, windowBlocks } from "./ticket-source.ts";
import { accumulate, buildList, capForWindow, candidates, checkList, type DrawList, excludedHash, leafHash, pickWinners, proofOf, toLeaf, tree, verifyProof, WINNERS } from "./tickets.ts";

/** The cap input must be read at most this many blocks (~1 h) before the params are anchored: fresh, not cherry-picked. */
export const CAP_INPUT_MAX_AGE = 300n;
export type Posted = { window: bigint; capBps: bigint; minBalance: bigint; root: Hex; totalTickets: bigint; holders: bigint; uri: string; dataHash: Hex; eta: bigint; blockNumber: bigint };
type Rec = SignedRecord & { seq: string; hash: string };
export type Fetch = (url: string) => Promise<unknown>;
export const fetchJson: Fetch = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
};

export const listPostedEvent = getAbiItem({ abi: abi.gamePotAbi, name: "ListPosted" });
/** Every ListPosted in [fromBlock, toBlock] (one provider; the check itself reads through all of them). */
export async function postedLists(c: PublicClient, dep: Dep, fromBlock: bigint, toBlock: bigint): Promise<Posted[]> {
  const logs = await getLogsChunked((from, to) => c.getLogs({ address: dep.gamePot, event: listPostedEvent, fromBlock: from, toBlock: to }), fromBlock, toBlock);
  return logs.map((l) => ({ ...(l.args as Omit<Posted, "blockNumber">), blockNumber: l.blockNumber! }));
}

/** All five checks. `problems` empty = verified. Throws only when it could not check (RPC / HTTP trouble). */
export async function verifyPosted(o: { clients: PublicClient[]; dep: Dep; posted: Posted; fetch?: Fetch; logSigner?: string | null }) {
  const { clients: cs, dep, posted: ev } = o;
  const get = o.fetch ?? fetchJson;
  const problems: string[] = [];
  const w = Number(ev.window);
  // 1. the list record
  const rec = (await get(ev.uri)) as Rec;
  if (keccak256(stringToHex(rec.body)) !== ev.dataHash.toLowerCase()) problems.push("the list record's bytes do not hash to the posted dataHash");
  const list = JSON.parse(rec.body) as DrawList;
  if (canonical(list) !== rec.body) problems.push("the list record is not canonical JSON");
  if (rec.ref !== `jackpot:list:${w}`) problems.push(`the list record is ${rec.kind} ${rec.ref}, not jackpot:list:${w}`);
  const same = (a: unknown, b: unknown, what: string) => String(a).toLowerCase() !== String(b).toLowerCase() && problems.push(`${what}: list ${a}, chain ${b}`);
  same(list.window, ev.window, "window"); same(list.root, ev.root, "root"); same(list.totalTickets, ev.totalTickets, "total tickets"); same(list.holders, ev.holders, "holders");
  same(list.capBps, ev.capBps, "capBps"); same(list.minBalance, ev.minBalance, "minBalance");
  if (rec.esig) {
    const s = await checkRecord(rec);
    if (!s.ehashOk) problems.push("the list record's enclave hash does not recompute");
    if (o.logSigner && s.signer?.toLowerCase() !== o.logSigner.toLowerCase()) problems.push(`the list record is signed by ${s.signer}, not the log signer ${o.logSigner}`);
  }
  // 2. the params record, anchored before the window started
  const base = ev.uri.replace(/\/api\/log\/\d+$/, "");
  const pr = list.paramsSeq ? ((await get(`${base}/api/log/${list.paramsSeq}`)) as Rec) : undefined;
  const params = pr ? (JSON.parse(pr.body) as { window: number; capBps: number; minBalance: string; cex: string[]; cexHash: Hex; capInput?: { asOfBlock: number; lastList: { window: number; holders: number; block: number } | null } }) : undefined;
  if (!pr || !params) problems.push("the list names no params record");
  else {
    if (params.window !== w || params.capBps !== list.capBps || params.minBalance !== list.minBalance) problems.push("the posted params differ from the params announced before the window");
    if (excludedHash(params.cex) !== params.cexHash) problems.push("the params record's exchange list does not match its hash");
    if (pr.esig && o.logSigner) {
      const s = await checkRecord(pr);
      if (!s.ehashOk || s.signer?.toLowerCase() !== o.logSigner.toLowerCase()) problems.push("the params record is not signed by the log signer");
    }
    const roots = [pr.ehash, pr.hash].filter((x): x is string => !!x).map((x) => (x.startsWith("0x") ? x : `0x${x}`) as Hex);
    const anchors = (await Promise.all(roots.map((root) => getLogsChunked((from, to) => cs[0].getLogs({ address: dep.registry, event: getAbiItem({ abi: abi.registryAbi, name: "Anchored" }), args: { root }, fromBlock: from, toBlock: to }), BigInt(dep.startBlock), ev.blockNumber)))).flat();
    const times = await Promise.all(anchors.map(async (l) => Number((await cs[0].getBlock({ blockNumber: l.blockNumber! })).timestamp)));
    if (!times.some((t) => t < list.start)) problems.push("the params record was not anchored on-chain before the window started");
    // the cap policy, recomputed from the chain: the newest ListPosted at or before the record's asOfBlock (itself before
    // the anchor) → capFor(holders); the record's input, its cap and the posted cap must all agree
    const firstAnchor = anchors.length ? anchors.map((l) => l.blockNumber!).reduce((a, b) => (a < b ? a : b)) : 0n;
    const ci = params.capInput;
    if (!ci || !Number.isInteger(ci.asOfBlock) || BigInt(ci.asOfBlock) >= firstAnchor) problems.push("the params record has no cap input read before its anchor");
    else if (firstAnchor - BigInt(ci.asOfBlock) > CAP_INPUT_MAX_AGE) problems.push("the cap input was read more than ~1 h before the anchor");
    else {
      const prior = await getLogsChunked((from, to) => cs[0].getLogs({ address: dep.gamePot, event: listPostedEvent, fromBlock: from, toBlock: to }), BigInt(dep.startBlock), BigInt(ci.asOfBlock));
      const last = prior.at(-1);
      const onChain = last ? { window: Number(last.args.window), holders: Number(last.args.holders), block: Number(last.blockNumber) } : null;
      if (canonical(onChain) !== canonical(ci.lastList)) problems.push(`the cap input is not the chain's: the newest ListPosted by block ${ci.asOfBlock} is ${JSON.stringify(onChain)}`);
      const cap = capForWindow(w, onChain);
      if (cap !== params.capBps || cap !== list.capBps) problems.push(`the cap policy gives ${cap / 100}% (last posted draw ${onChain?.holders ?? "none"}), the params say ${params.capBps / 100}%`);
    }
    if (list.capBps < 50 || list.capBps > 200) problems.push("capBps outside [50, 200]");
  }
  // 3. the window and its blocks
  const rolled = await getLogsChunked((from, to) => cs[0].getLogs({ address: dep.gamePot, event: getAbiItem({ abi: abi.gamePotAbi, name: "WindowRolled" }), args: { window: ev.window }, fromBlock: from, toBlock: to }), BigInt(dep.startBlock), ev.blockNumber);
  const r0 = rolled[0]?.args as { start: bigint; end: bigint } | undefined;
  if (!r0 || Number(r0.start) !== list.start || Number(r0.end) !== list.end) problems.push(`the list's window [${list.start}, ${list.end}) is not window ${w} on chain`);
  const blocks = await windowBlocks(cs, list.start, list.end, dep.startBlock);
  if (!blocks) throw new Error("the window's end is not finalized on every provider yet");
  if (blocks.startBlock !== list.startBlock || blocks.endBlock !== list.endBlock || blocks.endBlockHash.toLowerCase() !== list.endBlockHash.toLowerCase()) problems.push("the list's blocks are not the window's blocks");
  // 4. rebuild through every provider
  let excluded: string[] = [];
  for (const c of cs) {
    const { transfers, vaultEvents } = await fromRpc(c, dep, blocks.endBlock);
    const acc = accumulate(transfers, vaultEvents, dep.convictionVault, list);
    excluded = await exclusionSet(c, dep, blocks.endBlock, candidates(acc), params?.cex ?? []);
    const built = buildList({ window: w, start: list.start, end: list.end, capBps: list.capBps, minBalance: BigInt(list.minBalance), ...blocks, paramsSeq: list.paramsSeq }, acc, excluded);
    if ("skip" in built) { problems.push(`a rebuild finds no list: ${built.skip}`); continue; }
    if (built.dataHash !== ev.dataHash.toLowerCase() || built.list.root !== ev.root.toLowerCase()) problems.push(`a rebuild from ${hostOf(c)} gives root ${built.list.root}, data ${built.dataHash}`);
  }
  // 5. shape
  problems.push(...checkList(list, excluded));
  return { window: w, problems, list, holders: list.holders, totalTickets: list.totalTickets };
}
const hostOf = (c: PublicClient) => { try { return new URL((c.transport as { url?: string }).url ?? "").host; } catch { return "an RPC"; } };

/** What a settle logged: Drawn's fields, its Winner rows, and every WinnerExcluded with isExcluded read at the
 *  settle block. */
export type Settled = {
  rand: bigint; prize: bigint; share: bigint; winners: bigint; ticketsUsed: bigint;
  paid: { rank: bigint; account: string; share: bigint; prizeId?: bigint }[];
  excluded: { account: string; onChain: boolean }[];
};
export const drawnEvent = getAbiItem({ abi: abi.gamePotAbi, name: "Drawn" });
export type Drawn = { window: bigint; rand: bigint; prize: bigint; share: bigint; winners: bigint; ticketsUsed: bigint; transactionHash: Hex; blockNumber: bigint };
/** Every Drawn in [fromBlock, toBlock] (one provider), optionally for one window. */
export async function drawnLogs(c: PublicClient, dep: Dep, fromBlock: bigint, toBlock: bigint, window?: bigint): Promise<Drawn[]> {
  const logs = await getLogsChunked((from, to) => c.getLogs({ address: dep.gamePot, event: drawnEvent, args: window === undefined ? undefined : { window }, fromBlock: from, toBlock: to }), fromBlock, toBlock);
  return logs.map((l) => ({ ...(l.args as Omit<Drawn, "transactionHash" | "blockNumber">), transactionHash: l.transactionHash!, blockNumber: l.blockNumber! }));
}
/** Reads a settle's Settled from its receipt (the CLI and the watchdog both check it with checkWinners). */
export async function settledOf(c: PublicClient, dep: Dep, d: Drawn): Promise<Settled> {
  const rc = await c.getTransactionReceipt({ hash: d.transactionHash });
  const logs = parseEventLogs({ abi: abi.gamePotAbi, logs: rc.logs.filter((l) => l.address.toLowerCase() === dep.gamePot.toLowerCase()) });
  const paid = logs.filter((l) => l.eventName === "Winner").map((l) => l.args as { rank: bigint; account: string; share: bigint; prizeId: bigint });
  const excluded = await Promise.all(logs.filter((l) => l.eventName === "WinnerExcluded").map(async (l) => {
    const account = (l.args as { winner: Hex }).winner;
    return { account, onChain: (await c.readContract({ address: dep.gamePot, abi: abi.gamePotAbi, functionName: "isExcluded", args: [account], blockNumber: rc.blockNumber })) as boolean };
  }));
  return { rand: d.rand, prize: d.prize, share: d.share, winners: d.winners, ticketsUsed: d.ticketsUsed, paid, excluded };
}
/** A settled draw, recomputed: the walk over the verified list from the on-chain word (tickets keccak256(rand, j) mod
 *  total, duplicates skipped). A skip for exclusion is valid only when the settle logged WinnerExcluded for that account
 *  AND isExcluded was true at the settle block; the logged skips must be exactly the walk's. Drawn's counts, the share
 *  and every Winner (rank, account, share) must match, and every walked leaf's proof must verify. */
export function checkWinners(list: DrawList, d: Settled) {
  const problems: string[] = [];
  for (const x of d.excluded) if (!x.onChain) problems.push(`${x.account} was skipped as excluded, but isExcluded was false at the settle block`);
  const walk = pickWinners(list, d.rand, new Set(d.excluded.filter((x) => x.onChain).map((x) => x.account.toLowerCase())));
  const skipped = walk.used.filter((u) => u.skip === "excluded").map((u) => u.account.toLowerCase()).sort().join();
  if (skipped !== d.excluded.map((x) => x.account.toLowerCase()).sort().join()) problems.push("the WinnerExcluded logs are not the walk's excluded skips");
  if (d.ticketsUsed !== BigInt(walk.used.length)) problems.push(`ticketsUsed ${d.ticketsUsed}, the walk uses ${walk.used.length}`);
  if (d.winners !== BigInt(walk.winners.length)) problems.push(`winners ${d.winners}, the walk finds ${walk.winners.length}`);
  if (d.share !== d.prize / BigInt(WINNERS)) problems.push(`share ${d.share} ≠ prize / ${WINNERS}`);
  if (d.paid.length !== walk.winners.length) problems.push(`${d.paid.length} Winner logs for ${walk.winners.length} winners`);
  walk.winners.forEach((w, i) => {
    const p = d.paid.find((x) => x.rank === BigInt(i));
    if (!p || p.account.toLowerCase() !== w.toLowerCase()) problems.push(`rank ${i}: the walk picks ${w}, the chain paid ${p?.account ?? "nobody"}`);
    else if (p.share !== d.share) problems.push(`rank ${i}: share ${p.share} ≠ ${d.share}`);
  });
  const layers = tree(list.leaves.map((l) => leafHash(toLeaf(l))));
  for (const u of walk.used) if (!verifyProof(proofOf(layers, u.index), list.root, leafHash(toLeaf(list.leaves[u.index])))) problems.push(`leaf ${u.index}'s proof does not verify`);
  return { problems, walk };
}
