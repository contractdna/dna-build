// Idea rewards off-chain: the records a payment rests on, and the watchdog's check of every RewardQueued against them.
// The records are written elsewhere (the brain's reward decision, the build verdict, the X binding intake); this file
// defines their shape and checks them. Read-only: RPC + the public log API, no keys, no DB.
//
// The chain of evidence for `queueReward(to, amount, ideaRef)`:
//  1. ideaRef = the enclave hash of a signed `reward` record, anchored on-chain (registry.anchor) before the queue;
//  2. that record names the same `to` and `amount`, and its basis: a shipped build (a signed `ship` verdict) or a kept
//     fee experiment (its memory entry, decision "accepted"; never a rolled-back one), written before the reward;
//  3. the payee: an IdeaMarket idea pays its on-chain submitter (IdeaSubmitted.author); an X idea pays the address its
//     author bound: of every signed `binding` record of that X user id, the one in force at the queue, which the reward cites;
//  4. `to` is not excluded on GamePot, and the record backs no other reward that was paid or is still open (a reward the
//     Safe cancelled frees its record for a new queue).
// Every log read is bounded to the watchdog's lookback before the queue (except the IdeaMarket submission, filtered by
// its indexed id): a record anchored or reused further back than that is not seen.
// Any mismatch pages the Safe signers to cancelReward(id) inside the public hour.
import { type Address, getAbiItem, getAddress, type Hex, isAddress, type PublicClient } from "viem";
import * as abi from "./abi.ts";
import { type Fetch, fetchJson } from "./draw-verify.ts";
import { checkRecord, type SignedRecord } from "./proof.ts";
import { type Dep, getLogsChunked } from "./ticket-source.ts";

/** The brain's signed decision to pay an idea's author. Its enclave hash is queueReward's `ideaRef`. */
export type RewardRecord = {
  kind: "reward";
  idea: { source: "ideamarket"; id: string } | { source: "x"; authorId: string; postId: string };
  to: Address;
  amount: string; // wei, as queued
  basis: { kind: "ship" | "kept"; seq: string }; // the shipped build's verdict record, or the kept experiment's memory entry
  binding?: string; // X ideas: the seq of the author's binding record
};
/** An X account's wallet, keyed by the X user id (never the handle), log ref `x:<xUserId>`. `at` = when it was written. */
export type BindingRecord = { kind: "binding"; xUserId: string; address: Address; postId: string; at: string; effectiveAt: string };

/** The account a binding mention tags, the delay of a rebinding, and the one reply a binding gets. */
export const BOT_HANDLE = "contractdna";
export const REBIND_DELAY_MS = 48 * 3600_000;
export const BINDING_REPLY = "This links your X account to this wallet publicly; use a fresh wallet if you want.";

/** Deterministic (no model): a mention of @contractdna that is only @handles and one 0x address (nothing else) binds it.
 *  Any other words make it no binding at all ("send me ETH 0x…" is not a request to link a wallet). Mixed case must
 *  pass its EIP-55 checksum. null = not a binding; `error` = a binding attempt that is refused. */
export function parseBinding(text: string): { address: Address } | { error: string } | null {
  if (!new RegExp(`(^|[^\\w])@${BOT_HANDLE}(?!\\w)`, "i").test(text)) return null;
  const found = [...new Set((text.match(/(?<![0-9a-z])0x[0-9a-f]{40}(?![0-9a-z])/gi) ?? []))];
  if (!found.length) return null;
  if (text.replace(/@\w+/g, " ").replace(/(?<![0-9a-z])0x[0-9a-f]{40}(?![0-9a-z])/gi, " ").trim()) return null;
  if (new Set(found.map((a) => a.toLowerCase())).size > 1) return { error: "more than one address" };
  const mixed = found.find((a) => /[a-f]/.test(a.slice(2)) && /[A-F]/.test(a.slice(2)));
  if (mixed && !isAddress(mixed, { strict: true })) return { error: "the address fails its checksum (EIP-55)" };
  const address = getAddress(found[0].toLowerCase());
  if (BigInt(address) === 0n) return { error: "the zero address" };
  return { address };
}

/** The binding in force for one X user id at `t` (ms), and a rebinding still waiting. Records in seq order: the first
 *  is in force at once; a different address waits REBIND_DELAY_MS (its effectiveAt); a newer record replaces a waiting
 *  one; binding back to the address in force cancels it. Only records written by `t` count. */
export function bindingAt<B extends BindingRecord & { seq: string }>(records: B[], t: number): { cur?: B; pending?: B } {
  let cur: B | undefined, pending: B | undefined;
  for (const r of [...records].sort((x, y) => (BigInt(x.seq) < BigInt(y.seq) ? -1 : 1))) {
    const at = Date.parse(r.at);
    if (!(at <= t)) break;
    if (pending && Date.parse(pending.effectiveAt) <= at) [cur, pending] = [pending, undefined];
    if (!cur) cur = r;
    else pending = same(r.address, cur.address) ? undefined : r;
  }
  if (pending && Date.parse(pending.effectiveAt) <= t) [cur, pending] = [pending, undefined];
  return { cur, pending };
}
/** The part of a build verdict a reward needs: the brain shipped it. */
export type ShipRecord = { verdict: "ship" };

export type Queued = { id: bigint; to: Address; amount: bigint; ideaRef: Hex; eta: bigint; blockNumber: bigint };
type Rec = SignedRecord & { seq: string };

const rewardQueuedEvent = getAbiItem({ abi: abi.gamePotAbi, name: "RewardQueued" });
const rewardPaidEvent = getAbiItem({ abi: abi.gamePotAbi, name: "RewardPaid" });
const rewardCancelledEvent = getAbiItem({ abi: abi.gamePotAbi, name: "RewardCancelled" });
const anchoredEvent = getAbiItem({ abi: abi.registryAbi, name: "Anchored" });
const ideaSubmittedEvent = getAbiItem({ abi: abi.ideaMarketAbi, name: "IdeaSubmitted" });
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const hex = (h: string | null | undefined) => (h ? (h.startsWith("0x") ? h : `0x${h}`).toLowerCase() : null);

/** Every RewardQueued in [fromBlock, toBlock]. */
export async function queuedRewards(c: PublicClient, dep: Dep, fromBlock: bigint, toBlock: bigint): Promise<Queued[]> {
  const logs = await getLogsChunked((from, to) => c.getLogs({ address: dep.gamePot, event: rewardQueuedEvent, fromBlock: from, toBlock: to }), fromBlock, toBlock);
  return logs.map((l) => ({ ...(l.args as Omit<Queued, "blockNumber">), blockNumber: l.blockNumber! }));
}

/** Every check above, from chain logs and the public records alone (nothing kept between runs). `problems` empty = the
 *  reward is backed. `head` = the newest block read; logs before the queue are read back `lookback` blocks. Throws only
 *  when it could not check (RPC / HTTP trouble). */
export async function checkReward(o: { client: PublicClient; dep: Dep; q: Queued; head: bigint; lookback: bigint; fetch?: Fetch; logSigner?: string | null }): Promise<string[]> {
  const { client: c, dep, q } = o;
  const start = BigInt(dep.startBlock);
  const from = q.blockNumber > start + o.lookback ? q.blockNumber - o.lookback : start;
  const get = o.fetch ?? fetchJson;
  const problems: string[] = [];
  const parse = <T>(r: Rec, what: string): T | undefined => {
    try { return JSON.parse(r.body) as T; } catch { problems.push(`the ${what} record is not JSON`); return undefined; }
  };
  const signed = async (r: Rec, what: string) => {
    const s = await checkRecord(r);
    if (!s.ehashOk) problems.push(`the ${what} record's enclave hash does not recompute`);
    else if (o.logSigner && !same(s.signer, o.logSigner)) problems.push(`the ${what} record is not signed by the log signer`);
  };
  // 1. the reward record, through its anchor
  const anchors = await getLogsChunked((from, to) => c.getLogs({ address: dep.registry, event: anchoredEvent, args: { root: q.ideaRef }, fromBlock: from, toBlock: to }), from, q.blockNumber);
  const uri = anchors[0]?.args.uri;
  if (!uri) return [`no reward record anchored for ideaRef ${q.ideaRef} before the queue`];
  // the record backs no other reward that was paid or is still open (GamePot refuses a used ideaRef, RefUsed: this
  // stays as defense in depth)
  const earlier = (await queuedRewards(c, dep, from, q.blockNumber)).filter((e) => e.id !== q.id && e.ideaRef.toLowerCase() === q.ideaRef.toLowerCase());
  for (const e of earlier) {
    const closed = async (event: typeof rewardPaidEvent | typeof rewardCancelledEvent) =>
      (await getLogsChunked((f, t) => c.getLogs({ address: dep.gamePot, event, args: { id: e.id }, fromBlock: f, toBlock: t }), e.blockNumber, o.head)).length > 0;
    if (await closed(rewardCancelledEvent)) continue; // vetoed: the record is free again
    problems.push(`its reward record already backs reward #${e.id} (${(await closed(rewardPaidEvent)) ? "paid" : "still open"})`);
  }
  const rec = (await get(uri)) as Rec;
  if (hex(rec.ehash) !== q.ideaRef.toLowerCase()) problems.push("the anchored record is not the one ideaRef names");
  await signed(rec, "reward");
  const r = parse<RewardRecord>(rec, "reward");
  if (!r) return problems;
  if (r.kind !== "reward") return [...problems, `the anchored record is a ${String(r.kind)} record, not a reward`];
  if (!same(r.to, q.to)) problems.push(`the record pays ${r.to}, the queue pays ${q.to}`);
  if (String(r.amount) !== String(q.amount)) problems.push(`the record says ${r.amount} wei, the queue ${q.amount} wei`);
  const base = uri.replace(/\/api\/log\/\d+$/, "");
  const before = (x: Rec, what: string) => {
    if (!(BigInt(x.seq) < BigInt(rec.seq))) problems.push(`the ${what} record comes after the reward decision`);
  };
  // 2. the basis: a shipped build or a kept fee experiment
  if (!r.basis?.seq || (r.basis.kind !== "ship" && r.basis.kind !== "kept")) problems.push("the reward names no shipped build or kept experiment");
  else {
    const b = (await get(`${base}/api/log/${r.basis.seq}`)) as Rec;
    await signed(b, r.basis.kind);
    before(b, r.basis.kind);
    const body = parse<{ verdict?: string; decision?: string }>(b, r.basis.kind);
    if (body && r.basis.kind === "ship" && body.verdict !== "ship") problems.push(`the build verdict is ${body.verdict ?? "missing"}, not ship`);
    if (body && r.basis.kind === "kept" && (b.kind !== "memory" || body.decision !== "accepted")) problems.push(`the experiment was not kept (${b.kind} ${body.decision ?? "without a decision"})`);
  }
  // 3. the payee
  if (r.idea?.source === "ideamarket") {
    if (!dep.ideaMarket) problems.push("no IdeaMarket in the deployment to check the submitter");
    else {
      const id = BigInt(r.idea.id);
      const subs = await getLogsChunked((from, to) => c.getLogs({ address: dep.ideaMarket!, event: ideaSubmittedEvent, args: { id }, fromBlock: from, toBlock: to }), BigInt(dep.startBlock), q.blockNumber);
      const author = subs[0]?.args.author;
      if (!author) problems.push(`IdeaMarket idea ${r.idea.id} was never submitted`);
      else if (!same(author, q.to)) problems.push(`IdeaMarket idea ${r.idea.id} was submitted by ${author}, not ${q.to}`);
    }
  } else if (r.idea?.source === "x") {
    if (!r.binding) problems.push("an X idea with no binding record");
    else {
      // every binding of the author's X user id (/api/log/binding/<id>): the one in force at the queue must be the payee
      // (a rebinding since the reward was decided pages), and it must be the one the reward cites
      const list = (await get(`${base}/api/log/binding/${encodeURIComponent(r.idea.authorId)}`)) as { records?: Rec[] };
      const recs: (BindingRecord & { seq: string })[] = [];
      for (const b of list.records ?? []) {
        const n = problems.length;
        await signed(b, "binding");
        const bd = problems.length === n ? parse<BindingRecord>(b, "binding") : undefined;
        if (b.kind === "binding" && bd?.kind === "binding" && bd.xUserId === r.idea.authorId) recs.push({ ...bd, seq: b.seq });
      }
      const at = Number((await c.getBlock({ blockNumber: q.blockNumber })).timestamp) * 1000;
      const { cur } = bindingAt(recs, at);
      const cited = recs.find((x) => x.seq === String(r.binding));
      if (!cited) problems.push(`the cited binding ${r.binding} is not a signed binding of X user ${r.idea.authorId}`);
      else before(cited as unknown as Rec, "binding");
      if (!cur) problems.push("no binding of the author was in force at the queue");
      else {
        if (!same(cur.address, q.to)) problems.push(`the binding in force at the queue pays ${cur.address}, the queue pays ${q.to}`);
        if (cited && cited.seq !== cur.seq) problems.push(`the reward cites binding ${cited.seq}, the one in force at the queue is ${cur.seq}`);
      }
    }
  } else problems.push("the reward names no idea source");
  // 4. never an excluded address (the contract refuses it too; a mismatch here means the set moved)
  if (await c.readContract({ address: dep.gamePot, abi: abi.gamePotAbi, functionName: "isExcluded", args: [q.to], blockNumber: q.blockNumber })) problems.push(`${q.to} is excluded`);
  return problems;
}

type Watch = { q: Queued; seen: number; paged: boolean; running?: Promise<void>; lastError?: string; failures: number; nextTry: number };

/** The watchdog's reward loop. A tick only reads the new RewardQueued logs and starts each check in the background (one
 *  running promise per reward, like the list rebuilds), so a slow fetch never holds back the jackpot list checks. Each
 *  reward is checked once, retried with backoff on RPC / HTTP trouble. A mismatch, or no answer within the deadline,
 *  pages the signers with the cancelReward deadline; once payable there is nothing left to veto and it is dropped. */
export function rewardWatch(o: {
  clients: PublicClient[]; dep: Dep; page: (text: string) => Promise<void>; logSigner?: string | null; fetch?: Fetch; now: () => number;
  cfg: { pollMs: number; repeatMs: number; verifyDeadlineS: number; lookbackBlocks: bigint }; check?: typeof checkReward;
}) {
  const check = o.check ?? checkReward;
  const open = new Map<string, Watch>();
  const running = new Set<Promise<void>>();
  const veto = (q: Queued) => `Safe: cancelReward(${q.id}) on GamePot ${o.dep.gamePot} before ${new Date(Number(q.eta) * 1000).toISOString()}.`;
  function start(k: string, w: Watch, head: bigint) {
    const { q } = w;
    const p: Promise<void> = check({ client: o.clients[0], dep: o.dep, q, head, lookback: o.cfg.lookbackBlocks, fetch: o.fetch, logSigner: o.logSigner }).then(async (problems) => {
      open.delete(k);
      await o.page(problems.length
        ? `🚨 IDEA REWARD #${q.id} MISMATCH — ${problems.join("; ")}. ${veto(q)}`
        : `Idea reward #${q.id} checked${w.paged ? " (late)" : ""}: the signed record, its basis and the payee match the queue.`);
    }, (e) => {
      w.lastError = (e as Error).message.slice(0, 300);
      w.failures++;
      w.nextTry = o.now() + Math.min(o.cfg.pollMs * 2 ** w.failures, o.cfg.repeatMs);
    }).finally(() => { w.running = undefined; running.delete(p); });
    w.running = p;
    running.add(p);
  }
  return {
    open: () => [...open.values()].map((w) => Number(w.q.id)),
    /** Tests: wait for the background checks. */
    settled: () => Promise.all([...running]),
    async tick(fromBlock: bigint, toBlock: bigint) {
      for (const q of await queuedRewards(o.clients[0], o.dep, fromBlock, toBlock)) {
        if (!open.has(String(q.id))) open.set(String(q.id), { q, seen: o.now(), paged: false, failures: 0, nextTry: 0 });
      }
      for (const [k, w] of open) {
        if (!w.running && o.now() >= w.nextTry) start(k, w, toBlock);
        if (!w.paged && o.now() - w.seen >= o.cfg.verifyDeadlineS * 1000) {
          w.paged = true;
          await o.page(`🚨 IDEA REWARD #${w.q.id} NOT VERIFIED IN 30 MIN — ${w.lastError ?? "the check is still running"}. ${veto(w.q)}`);
        }
        if (!w.running && o.now() / 1000 > Number(w.q.eta)) open.delete(k); // payable now: nothing left to veto
      }
    },
  };
}
