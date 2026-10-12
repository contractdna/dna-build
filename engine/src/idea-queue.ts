// The idea queue: accepted ideas of FINAL IdeaMarket rounds (RoundFinalized, not expired, the accepted bit; details from
// the report the round's OutcomeProposed names by hash). Rows are enclave-signed state (table idea_queue).
//  - fee ideas → loop.queueCandidate, the same gates as the AI's own candidates (one experiment at a time; a reason
//    that passes with time keeps the idea queued) → the experiment closes: kept → a reward; else not kept.
//  - build ideas → wait for the Sequencer, highest rubric score first (buildQueue / setBuildStatus / rewardShipped).
//  - rewards (basis: a kept experiment, or a shipped build via rewardShipped): the brain picks the amount inside the
//    on-chain caps (signed `brain` record); the payee is the IdeaMarket submitter (its on-chain IdeaSubmitted) or the X
//    author's binding in force (none while a wallet change is about to take effect); every GamePot.queueReward check is
//    read on-chain first, conservatively, so the queue never reverts. No binding or no room: the reward waits,
//    REWARD_HOLD_DAYS at most, then is dropped (the money stays in the reserve). Then the signed `reward` record →
//    anchored (root = its enclave hash, mined; never rebuilt after) → queueReward(to, amount, root): one per idea, ever
//    (every attempt is a tx record under one purpose; a crashed attempt is resolved on-chain before anything is re-sent).
// The indexer's chain_log only says where to look: final rounds and submitters are read back on-chain before use.
import { type AbiEvent, type Address, getAbiItem, getAddress, type Hex, keccak256, parseEther, type PublicClient, stringToBytes } from "viem";
import * as abi from "./abi.ts";
import { announce } from "./announce.ts";
import { trustedRows } from "./approve.ts";
import { bindingsOf } from "./bindings.ts";
import { type Rubric } from "./brain.ts";
import { agreedHead, readAgreed } from "./chainref.ts";
import { d, LOG_BASE_URL } from "./config.ts";
import { edb as sql } from "./db.ts";
import type { Report } from "./ideas.ts";
import { Defer, type Handler } from "./jobs.ts";
import { append, canonical, type EnclaveRow, stateSig, trusted, trustedRecord } from "./log.ts";
import { mode } from "./mode.ts";
import { REWARD_HOLD_DAYS, type Vector } from "./policy.ts";
import { trustedDocs } from "./records.ts";
import { bindingAt, type RewardRecord } from "./rewards.ts";
import { alert } from "./telegram.ts";
import { getLogsChunked } from "./ticket-source.ts";
import { addressOf, pub, send } from "./tx.ts";
import { feeFacts } from "./voice.ts";

const DAY_MS = 86_400_000;
export type IdeaSource = { source: "ideamarket"; author: Address } | { source: "x"; authorId: string; postId: string };
export type Basis = { kind: "kept" | "ship"; seq: string };
export type QueueData = {
  idea: number; round: number; index: number; report: string; title: string; summary: string; spec: string;
  source: IdeaSource | null; // null: an agent-submitted idea with no X author on record (nobody to pay)
  params?: { base: number; mult: number; cap: number }; rubric?: Rubric;
  variant?: { of: string; target: "game" | "site" | "module" }; // a buildable version of the author's idea (`of`: its title), credited to them
  rejudged?: true; // judged again after the pre-2b judge rejected it (src/ideas.ts REJUDGE)
  thread?: string; opId?: string; why?: string; // fee: its experiment, or why it waits / was skipped
  basis?: Basis; since?: string; // reward: what it rests on, and since when it waits
  reward?: { brain: string; amountWei: string; reason: string; record?: { seq: string; root: Hex; to: Address; amount: string; block?: number }; anchored?: boolean; tx?: string };
};
type Kind = "fee" | "build";
export type QueueRow = { id: string; kind: Kind; status: string; score: number; data: QueueData };

// ---------------------------------------------------------------- pure rules

/** GamePot's reward state, read before queueReward. queueReward syncs first: arrivals only raise ideaReserve, but a
 *  reserve above RESERVE_CAP (after a Safe cancel) is cut to the cap. min(ideaReserve, RESERVE_CAP) is never above what
 *  queueReward will see, so every check below is conservative. */
export type Pot = { canPropose: boolean; excluded: boolean; minReward: bigint; maxBps: bigint; reserve: bigint; reserveCap: bigint; budgetStart: bigint; dayBudget: bigint; daySpent: bigint };
const DAY_S = 86_400n;
const reserveOf = (p: Pot) => (p.reserve < p.reserveCap ? p.reserve : p.reserveCap);
const budgetLeft = (p: Pot, nowS: number) => (BigInt(nowS) >= p.budgetStart + DAY_S ? (reserveOf(p) * p.maxBps) / 10_000n : p.dayBudget > p.daySpent ? p.dayBudget - p.daySpent : 0n);
/** The amount range a reward may take now: [MIN_REWARD, min(25% of the reserve, what is left of the rolling day)]. */
export const rewardCaps = (p: Pot, nowS: number) => {
  const pct = (reserveOf(p) * p.maxBps) / 10_000n;
  const left = budgetLeft(p, nowS);
  return { min: p.minReward, max: pct < left ? pct : left };
};
/** Why queueReward(to, amount) would revert now, or null: every check it makes, in its order. */
export function rewardRoom(p: Pot, amount: bigint, nowS: number): string | null {
  if (!p.canPropose) return "the agent can't queue (paused, level below 5, or not the registry's agent)";
  if (p.excluded) return "the payee is excluded on GamePot";
  if (amount < p.minReward) return "below MIN_REWARD";
  if (amount * 10_000n > reserveOf(p) * p.maxBps) return "over 25% of the idea reserve";
  if (amount > budgetLeft(p, nowS)) return "over the rolling day's budget";
  return null;
}
/** The brain's amount inside the caps: down to the cap; below MIN_REWARD it is no reward (0). */
export const clampReward = (wei: bigint, caps: { min: bigint; max: bigint }) => {
  const v = wei > caps.max ? caps.max : wei;
  return v < caps.min ? 0n : v;
};
/** The X mention an agent-submitted idea came from (src/ideas.ts appends this suffix), or null. */
export const xMentionOf = (body: string) => body.match(/\(from X mention (\d{1,20})\)$/)?.[1] ?? null;
/** A "not queued" reason that passes with time (the idea stays queued); anything else skips it. */
export const transient = (why: string) => /already running|no free|pending ops|autonomy level/.test(why);

// ---------------------------------------------------------------- rows (signed state)

const valueOf = (r: QueueRow) => ({ kind: r.kind, status: r.status, score: r.score, data: r.data });
async function save(r: QueueRow) {
  const value = JSON.parse(JSON.stringify(valueOf(r))) as ReturnType<typeof valueOf>;
  await sql`insert into idea_queue (id, kind, status, score, data, sig) values (${r.id}, ${r.kind}, ${r.status}, ${r.score}, ${sql.json(value.data as never)}, ${await stateSig("idea_queue", r.id, value)})
    on conflict (id) do update set status = excluded.status, score = excluded.score, data = excluded.data, sig = excluded.sig, updated_at = now()`;
}
/** Rows of a kind and status, in queue order (build: score first), enclave-signed ones only. */
async function rows(kind: Kind, status: string, limit = 50): Promise<QueueRow[]> {
  const rs = await sql<(QueueRow & { sig: string | null })[]>`select id, kind, status, score, data, sig from idea_queue where kind = ${kind} and status = ${status}
    order by score desc, created_at, id limit ${limit}`;
  const out: QueueRow[] = [];
  for (const r of rs) if (await trusted("idea_queue", r.id, valueOf(r), r.sig)) out.push({ id: r.id, kind: r.kind, status: r.status, score: r.score, data: r.data });
  return out;
}

// ---------------------------------------------------------------- the Sequencer's interface (W4)

export type BuildIdea = { id: string; idea: number; round: number; title: string; summary: string; spec: string; rubric: Rubric; score: number; source: IdeaSource | null; report: string };
/** Build ideas waiting for the Sequencer, highest rubric score first (then the oldest). Only the reader's neutral spec
 *  and the brain's title: never the idea's raw text. */
export async function buildQueue(limit = 10): Promise<BuildIdea[]> {
  return (await rows("build", "queued", limit)).map((r) => ({ id: r.id, idea: r.data.idea, round: r.data.round, title: r.data.title, summary: r.data.summary, spec: r.data.spec, rubric: r.data.rubric!, score: r.score, source: r.data.source, report: r.data.report }));
}
/** A build idea's status, from its enclave-signed row (null: no such row, or not ours). */
export async function buildStatusOf(id: string): Promise<string | null> {
  const [r] = await sql<(QueueRow & { sig: string | null })[]>`select id, kind, status, score, data, sig from idea_queue where id = ${id} and kind = 'build'`;
  return r && (await trusted("idea_queue", r.id, valueOf(r), r.sig)) ? r.status : null;
}
export type BuildStatus = "queued" | "building" | "shipped" | "killed";
/** Build ideas killed with a reason that starts with `why`, back in the queue (once: the note replaces that reason). */
export async function requeueKilled(why: string, note: string): Promise<string[]> {
  const back = (await rows("build", "killed", 500)).filter((r) => String(r.data.why ?? "").startsWith(why));
  for (const r of back) await save({ ...r, status: "queued", data: { ...r.data, why: note } });
  return back.map((r) => r.id);
}
/** The Sequencer moves a build idea along (a note: its build ref or why). */
export async function setBuildStatus(id: string, from: BuildStatus, to: BuildStatus, note?: string) {
  const [r] = await rows("build", from, 500).then((rs) => rs.filter((x) => x.id === id));
  if (!r) throw Object.assign(new Error(`no ${from} build idea ${id}`), { final: true });
  await save({ ...r, status: to, data: { ...r.data, why: note ?? r.data.why } });
}
/** The ship hook (W4): a shipped build idea's reward, resting on the brain's signed `ship` verdict record. */
export async function rewardShipped(id: string, verdictSeq: string) {
  const [r] = await rows("build", "shipped", 500).then((rs) => rs.filter((x) => x.id === id));
  if (!r) throw Object.assign(new Error(`no shipped build idea ${id}`), { final: true });
  await save({ ...r, status: "reward", data: { ...r.data, basis: { kind: "ship", seq: verdictSeq }, since: new Date().toISOString() } });
}

// ---------------------------------------------------------------- ingest: accepted ideas of final rounds

const EVENTS = abi.ideaMarketAbi.filter((x) => x.type === "event") as unknown as AbiEvent[];
const ev = (name: string) => EVENTS.find((e) => e.name === name)!;
/** The IdeaMarket logs of one event at the blocks the indexer named, read on-chain (every provider must agree): the DB
 *  only says where to look. Plain values, so the providers' answers compare. */
const logsAt = (name: string, args: Record<string, unknown>, from: number, to: number) =>
  readAgreed(async (c) => (await c.getLogs({ address: d.ideaMarket!, event: ev(name), args, fromBlock: BigInt(from), toBlock: BigInt(to) } as never))
    .map((l) => ({ block: Number((l as unknown as { blockNumber: bigint }).blockNumber), args: JSON.parse(canonical((l as unknown as { args: unknown }).args)) as Record<string, string | boolean> })));

/** An IdeaMarket idea as the chain has it (its IdeaSubmitted at the block the indexer named, every provider agreeing):
 *  null when the indexer has no such idea. */
export async function ideaOnChain(ideaId: number) {
  const [hint] = await sql<{ block: number }[]>`select block::int as block from chain_log where event = 'IdeaSubmitted' and args->>'id' = ${String(ideaId)} limit 1`;
  if (!hint) return null;
  const [s] = await logsAt("IdeaSubmitted", { id: BigInt(ideaId) }, hint.block, hint.block);
  if (!s) throw new Error(`IdeaSubmitted ${ideaId} is not on-chain at block ${hint.block}: chain_log not trusted`);
  return { author: getAddress(String(s.args.author)), round: Number(s.args.round), index: Number(s.args.index), title: String(s.args.title ?? ""), body: String(s.args.body ?? "") };
}

/** Who submitted an IdeaMarket idea, from its on-chain IdeaSubmitted (indexed by id): a person (the author), or, for the
 *  agent's X intake, the X author of the mention its on-chain body names. */
async function sourceOf(ideaId: number): Promise<IdeaSource | null> {
  const s = await ideaOnChain(ideaId);
  if (!s) return null;
  const author = s.author;
  if (author.toLowerCase() !== addressOf("agent")?.toLowerCase()) return { source: "ideamarket", author };
  const m = xMentionOf(s.body);
  return m ? xSourceOf(m) : null;
}
/** The X author of a mention, from its enclave-signed row (null: no such row, no author, or not ours). */
export async function xSourceOf(mention: string): Promise<IdeaSource | null> {
  const [x] = await sql<{ id: string; author_id: string | null; text: string; raw: unknown; sig: string | null }[]>`select id, author_id, text, raw, sig from x_mention where id = ${mention}`;
  if (!x?.author_id || !(await trusted("x_mention", x.id, { author: x.author_id, text: x.text, raw: x.raw }, x.sig))) return null;
  return { source: "x", authorId: x.author_id, postId: x.id };
}

/** A finalized round as the chain has it: its RoundFinalized at the hinted block (not expired, the accepted bitmap) and
 *  the one OutcomeProposed it applied (the last proposal before it: its report hash). null = not a usable final round. */
async function finalOnChain(round: string, finBlock: number) {
  const [fin] = await logsAt("RoundFinalized", { round: BigInt(round) }, finBlock, finBlock);
  if (!fin) throw new Error(`RoundFinalized ${round} is not on-chain at block ${finBlock}: chain_log not trusted`);
  if (fin.args.expired === true || BigInt(String(fin.args.accepted)) === 0n) return null;
  const [hint] = await sql<{ block: number }[]>`select block::int as block from chain_log where event = 'OutcomeProposed' and args->>'round' = ${round} and block <= ${finBlock} order by block desc, log_index desc limit 1`;
  if (!hint) return null;
  const props = await logsAt("OutcomeProposed", { round: BigInt(round) }, hint.block, finBlock);
  const p = props.at(-1);
  if (!p || p.block !== hint.block) throw new Error(`the last OutcomeProposed of round ${round} is not the indexer's: chain_log not trusted`);
  if (String(p.args.accepted) !== String(fin.args.accepted)) throw new Error(`round ${round}: the finalized bitmap is not the proposal's`);
  return { accepted: BigInt(String(fin.args.accepted)), reportHash: String(p.args.reportHash).toLowerCase() };
}

/** The ingest cursor (signed state): the last RoundFinalized block taken in. */
async function cursor() {
  const [r] = await sql<{ value: { block: number }; sig: string | null }[]>`select value, sig from state where key = 'idea_ingest'`;
  return r && (await trusted("state", "idea_ingest", r.value, r.sig)) ? r.value.block : -1;
}
const setCursor = async (block: number) =>
  sql`insert into state (key, block, value, sig) values ('idea_ingest', ${block}, ${sql.json({ block })}, ${await stateSig("state", "idea_ingest", { block })})
    on conflict (key) do update set block = excluded.block, value = excluded.value, sig = excluded.sig, updated_at = now()`;

/** Every round finalized after the cursor's block, in chain order: its accepted fee and build ideas enter the queue. An
 *  RPC or verification error stops here (the cursor stays before that block: the next run retries it whole). */
export async function ingest() {
  let added = 0;
  const from = await cursor();
  const fin = await sql<{ round: string; block: number }[]>`select args->>'round' as round, block::int as block from chain_log where event = 'RoundFinalized' and block > ${from} order by block, log_index`;
  for (const [k, f] of fin.entries()) {
    const o = await finalOnChain(f.round, f.block);
    const rep = o && (await trustedRows("report", `round:${f.round}`, 10)).find((r) => keccak256(stringToBytes(r.body)) === o.reportHash);
    if (o && !rep) await alert(`Idea queue: round ${f.round} finalized, but no signed report matches its proposed hash.`, `alert:ingest:${f.round}`);
    if (o && rep) {
      const doc = JSON.parse(rep.body) as Report;
      for (const i of doc.ideas) {
        if (i.decision !== "accept" || !((o.accepted >> BigInt(i.index)) & 1n) || (i.kind !== "fee" && i.kind !== "build")) continue;
        if (i.kind === "fee" ? !i.params : !i.rubric) continue;
        const id = `im:${i.id}`;
        if ((await sql`select 1 from idea_queue where id = ${id}`).length) continue;
        const r = i.rubric;
        await save({
          id, kind: i.kind, status: "queued", score: r ? r.value + r.fit + r.clarity + r.originality : 0,
          data: { idea: i.id, round: doc.round, index: i.index, report: rep.seq, title: i.title ?? "", summary: i.summary ?? "", spec: i.spec ?? "", source: await sourceOf(i.id), ...(i.params ? { params: i.params } : {}), ...(r ? { rubric: r } : {}) },
        });
        added++;
      }
    }
    // the cursor passes a block only once every round finalized in it went through (ingest is idempotent: a block cut
    // short by an error is read again whole)
    if (fin[k + 1]?.block !== f.block) await setCursor(f.block);
  }
  return added;
}

// ---------------------------------------------------------------- live mode (config.ts IDEA_MODE): queued at once

/** The first number an X idea gets in live mode (it never went on-chain, so it has no IdeaMarket id): far above any
 *  IdeaMarket id, so a build id or a game's folder never names both. */
export const X_IDEA_BASE = 1_000_000;
/** A queued idea's signed row by id, whatever its kind and status (null: none, or not ours). */
export async function queuedRow(id: string): Promise<QueueRow | null> {
  const [r] = await sql<(QueueRow & { sig: string | null })[]>`select id, kind, status, score, data, sig from idea_queue where id = ${id}`;
  return r && (await trusted("idea_queue", r.id, valueOf(r), r.sig)) ? { id: r.id, kind: r.kind, status: r.status, score: r.score, data: r.data } : null;
}
/** A judged idea into the queue (live mode), once per id: its number (an X idea's: the next one after X_IDEA_BASE; the
 *  ideas lane runs one job at a time). An id already queued keeps its row and its number. */
export async function queueLive(id: string, kind: Kind, data: Omit<QueueData, "idea"> & { idea?: number }): Promise<number> {
  const had = await queuedRow(id);
  if (had) return had.data.idea;
  const idea = data.idea ?? X_IDEA_BASE + 1 + (await sql<{ n: number }[]>`select count(*)::int as n from idea_queue where id like 'x:%'`)[0].n;
  const r = data.rubric;
  await save({ id, kind, status: "queued", score: r ? r.value + r.fit + r.clarity + r.originality : 0, data: { ...data, idea } });
  return idea;
}

// ---------------------------------------------------------------- fee ideas → the experiment pipeline

/** loop.ts behind a seam (tests stand in for the experiment pipeline and the brain). */
export const QUEUE_DEPS = {
  queueCandidate: async (...a: Parameters<typeof import("./loop.ts").queueCandidate>) => (await import("./loop.ts")).queueCandidate(...a),
  openRun: async () => (await import("./loop.ts")).openRun(),
  decide: async (input: unknown, ref: string) => (await import("./brain.ts")).decide("reward", input, ref),
  pot: (to: Address) => potOf(to),
};

/** A closed experiment's thread row (signed) and, when kept, its memory entry's seq. */
async function closed(thread: string) {
  const [t] = await sql<{ id: string; stage: string; data: { outcome?: string }; sig: string | null }[]>`select id, stage, data, sig from thread where id = ${thread}`;
  if (!t || t.stage !== "closed" || !(await trusted("thread", t.id, t.data, t.sig))) return null;
  if (t.data.outcome !== "accepted") return { kept: false as const };
  const mem = await sql<(EnclaveRow & { seq: string })[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where kind = 'memory'
    and doc->'refs' @> ${sql.json([{ label: "thread", ref: thread }] as never)} order by log.seq desc limit 5`;
  for (const m of mem) if (await trustedRecord(m, "memory record")) return { kept: true as const, seq: m.seq };
  return null; // the memory entry is not written yet
}

/** An experiment this idea already started (open or closed: a long outage can hide both from the open-run check). */
async function runOf(source: string) {
  const ts = await sql<{ id: string; data: { source?: string; ops?: string[]; allOps?: string[] }; sig: string | null }[]>`select id, data, sig from thread where kind = 'fee' and data->>'source' = ${source} order by created_at`;
  for (const t of ts) if (await trusted("thread", t.id, t.data, t.sig)) return { thread: t.id, opId: t.data.allOps?.[0] ?? t.data.ops?.[0] };
  return undefined;
}

export async function feeStep() {
  const out: Record<string, string> = {};
  for (const r of await rows("fee", "testing")) {
    const c = await closed(r.data.thread!);
    if (!c) continue;
    if (c.kept) await save({ ...r, status: "reward", data: { ...r.data, basis: { kind: "kept", seq: c.seq }, since: new Date().toISOString() } });
    else await save({ ...r, status: "not_kept" });
    out[r.id] = c.kept ? "kept: reward next" : "not kept";
  }
  const [next] = await rows("fee", "queued", 1);
  if (!next) return out;
  const source = `idea ${next.data.idea}`;
  // its own experiment, started before a crash or a Defer cut the last run short: never a second one
  let res: { thread?: string; opId?: string; why?: string } = (await runOf(source)) ?? {};
  if (!res.thread) {
    if (await QUEUE_DEPS.openRun()) { out[next.id] = "waiting: an experiment is running"; return out; }
    const v = next.data.params!;
    res = await QUEUE_DEPS.queueCandidate({ title: `Idea #${next.data.idea}: ${next.data.title}`.slice(0, 200), hypothesis: `An accepted community idea (${next.data.idea > X_IDEA_BASE ? "from X" : "IdeaMarket"} #${next.data.idea}): ${next.data.summary}`.slice(0, 300), vector: [v.base, v.mult, v.cap] as Vector, source });
  }
  if (res.thread) {
    await save({ ...next, status: "testing", data: { ...next.data, thread: res.thread, opId: res.opId, why: undefined } });
    const run = await QUEUE_DEPS.openRun();
    await announce(`idea_testing:${next.data.idea}`, { event: "idea_testing", idea: next.data.idea, plate: run?.id === res.thread ? run.label : "?", fee: feeFacts([next.data.params!.base, next.data.params!.mult, next.data.params!.cap]) });
    out[next.id] = `testing (${res.thread})`;
  } else {
    const why = (res.why ?? "not queued").slice(0, 300);
    await save({ ...next, status: transient(why) ? "queued" : "skipped", data: { ...next.data, why } });
    out[next.id] = transient(why) ? `waiting: ${why}` : `skipped: ${why}`;
  }
  return out;
}

// ---------------------------------------------------------------- rewards

const gp = <T>(fn: string, args: unknown[] = []) => pub.readContract({ address: d.gamePot!, abi: abi.gamePotAbi, functionName: fn, args } as never) as Promise<T>;
const reg = <T>(fn: string) => pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: fn } as never) as Promise<T>;
/** GamePot's reward state and the agent's standing, read now (head). */
export async function potOf(to: Address): Promise<Pot> {
  const [minReward, maxBps, reserve, reserveCap, budgetStart, dayBudget, daySpent, excluded, agent, paused, level] = await Promise.all([
    gp<bigint>("MIN_REWARD"), gp<bigint>("MAX_REWARD_BPS"), gp<bigint>("ideaReserve"), gp<bigint>("RESERVE_CAP"), gp<number>("budgetStart"), gp<bigint>("dayBudget"), gp<bigint>("daySpent"), gp<boolean>("isExcluded", [to]),
    reg<Address>("agent"), reg<boolean>("agentPaused"), reg<number>("level"),
  ]);
  return { canPropose: agent.toLowerCase() === addressOf("agent")?.toLowerCase() && !paused && Number(level) >= 5, excluded, minReward, maxBps, reserve, reserveCap, budgetStart: BigInt(budgetStart), dayBudget, daySpent };
}

/** What the brain may know of the basis: the kept experiment's memory entry (or the ship verdict), its own fields only. */
async function basisFacts(b: Basis) {
  const [r] = await sql<(EnclaveRow & { doc: Record<string, unknown> })[]>`select kind, ref, body, eprev, ehash, esig, doc from log where seq = ${b.seq}`;
  if (!r || !(await trustedRecord(r, `${b.kind} record`))) return null;
  const pick = ["title", "result", "decision", "verdict", "reason"].filter((k) => r.doc[k] !== undefined);
  return Object.fromEntries(pick.map((k) => [k, r.doc[k]]));
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Every queueReward attempt of an idea is a `tx` record under this one purpose: one reward per idea, ever. */
const purposeOf = (idea: number) => `agent:reward:idea:${idea}`;
/** No reward is queued while the author's wallet change takes effect within this: the watchdog judges the payee at the
 *  queue's block, so the binding in force must not change in between. */
export const REBIND_GUARD_MS = 2 * 3600_000;
type Rec = NonNullable<NonNullable<QueueData["reward"]>["record"]>;
type TxDoc = { status: string; nonce?: number; maxFee?: string; tip?: string; hashes?: Hex[] };
const queuedEvent = getAbiItem({ abi: abi.gamePotAbi, name: "RewardQueued" });
const anchoredEvent = getAbiItem({ abi: abi.registryAbi, name: "Anchored" });

/** The brain's amount (ETH, a JS number) in wei inside the caps: clamped as a number first (a huge or tiny float never
 *  reaches parseEther in exponent form), then exactly; below MIN_REWARD it is no reward (0). */
export function rewardWei(amountEth: number, caps: { min: bigint; max: bigint }) {
  const x = Math.min(Number.isFinite(amountEth) && amountEth > 0 ? amountEth : 0, Number(caps.max) / 1e18);
  return clampReward(parseEther(x.toFixed(9)), caps); // to the gwei: a float carries noise past ~15 digits
}

/** On-chain reads every provider agrees on, bounded to `toBlock` (a block read before the caller's nonce read). */
const agreedLogs = <T>(get: (c: PublicClient, from: bigint, to: bigint) => Promise<T[]>, from: bigint, toBlock: bigint) =>
  readAgreed(async (c) => JSON.parse(canonical(await getLogsChunked((f, t) => get(c, f, t), from, toBlock))) as T[]);
/** The RewardQueued for this exact record, if one landed by `toBlock`: its tx hash. */
async function queuedOnChain(rec: Rec, toBlock: bigint) {
  const logs = await agreedLogs((c, from, to) => c.getLogs({ address: d.gamePot!, event: queuedEvent, args: { to: rec.to }, fromBlock: from, toBlock: to }), BigInt(rec.block ?? d.startBlock), toBlock);
  return (logs as { args: { ideaRef: string }; transactionHash: Hex }[]).find((l) => same(l.args.ideaRef, rec.root))?.transactionHash ?? null;
}
/** Is this root already anchored (a crash after an anchor tx, before its row was saved)? */
async function anchoredOnChain(rec: Rec) {
  const toBlock = await agreedHead();
  return (await agreedLogs((c, from, to) => c.getLogs({ address: d.registry, event: anchoredEvent, args: { root: rec.root }, fromBlock: from, toBlock: to }), BigInt(rec.block ?? d.startBlock), toBlock)).length > 0;
}

type Settled = { landed: Hex } | { replaces?: { nonce: number; maxFee: string; tip: string } };
/** Where the idea's queueReward attempts stand on-chain, before anything is (re)sent. In order: the providers' agreed
 *  head, the agent nonce, then the agreed RewardQueued logs up to that block, then the receipt of every hash of the newest attempt. A
 *  receipt or a log of this record → landed. A pending attempt whose nonce is still open is re-sent AT THAT NONCE (only
 *  one of them can be mined); one whose nonce went elsewhere, with no receipt and no log, is marked dropped (only after
 *  both reads). GamePot refuses a second queue on the same record anyway (RefUsed). */
async function settle(idea: number, rec: Rec, last: TxDoc | undefined): Promise<Settled> {
  const toBlock = await agreedHead(); // every provider has it: the agreed log read means the same on all of them
  const nonceNow = await pub.getTransactionCount({ address: addressOf("agent")!, blockTag: "latest" });
  const landed = await queuedOnChain(rec, toBlock);
  if (landed) return { landed };
  if (last?.status !== "pending" || last.nonce === undefined) return {};
  for (const hash of last.hashes ?? []) {
    const rc = await pub.getTransactionReceipt({ hash }).catch(() => null);
    if (rc?.status === "success") return { landed: hash };
    if (rc) { await append("tx", purposeOf(idea), { key: "agent", mode: "live", status: "dropped", nonce: last.nonce, hash, note: "the attempt reverted" }); return {}; }
  }
  if (nonceNow > last.nonce) {
    await append("tx", purposeOf(idea), { key: "agent", mode: "live", status: "dropped", nonce: last.nonce, note: "its nonce went to another tx; no receipt and no RewardQueued for this record" });
    return {};
  }
  return { replaces: { nonce: last.nonce, maxFee: String(last.maxFee), tip: String(last.tip) } };
}

async function rewarded(r: QueueRow, hash: Hex | undefined) {
  await save({ ...r, status: "rewarded", data: { ...r.data, ...(hash ? { reward: { ...r.data.reward!, tx: hash } } : {}) } });
  return "rewarded";
}

/** Send the anchored record's exact call (at the replaced nonce, if any), once its on-chain room is there. */
async function sendQueue(r: QueueRow, rec: Rec, replaces: { nonce: number; maxFee: string; tip: string } | undefined, nowS: number): Promise<string> {
  const why = rewardRoom(await QUEUE_DEPS.pot(rec.to), BigInt(rec.amount), nowS);
  if (why) return `waiting: ${why}`;
  const q = await send({ key: "agent", to: d.gamePot!, abi: abi.gamePotAbi, fn: "queueReward", args: [rec.to, BigInt(rec.amount), rec.root], purpose: purposeOf(r.data.idea), replaces });
  if (q.status === "mined") return rewarded(r, q.hash);
  if (q.status === "dry_run") return "dry run";
  await alert(`Idea reward for idea #${r.data.idea}: queueReward ${q.status} (${q.error ?? q.hash}) although the caps were read first.`, `alert:reward:${r.data.idea}:${new Date().toISOString().slice(0, 13)}`);
  return `queueReward ${q.status}`;
}

async function rewardOne(r: QueueRow, nowMs: number, expired: boolean): Promise<string> {
  const data = r.data;
  if (!data.source) { await save({ ...r, status: "no_reward", data: { ...data, why: "no author to pay" } }); return "no author to pay"; }
  // every attempt of this idea (a DB hiding the newest one throws: never read as "no attempt")
  const attempts = await trustedDocs<TxDoc>("tx", purposeOf(data.idea), 20);
  if (attempts.some((t) => t.status === "mined")) return rewarded(r, undefined);
  const nowS = Math.floor(nowMs / 1000);
  // the payee: the submitter, or the binding in force, and none while a wallet change is about to take effect
  let payee: { to: Address; binding?: string } | undefined;
  let soon = false;
  if (data.source.source === "ideamarket") payee = { to: data.source.author };
  else {
    const { cur, pending } = bindingAt(await bindingsOf(data.source.authorId), nowMs);
    soon = !!pending && Date.parse(pending.effectiveAt) <= nowMs + REBIND_GUARD_MS;
    if (cur) payee = { to: cur.address, binding: cur.seq };
  }
  const rec = data.reward?.record;
  // anchored: never rebuilt. Its attempts are settled on-chain first; then it is (re)sent only while the payee it names
  // is still the binding in force and no wallet change is about to take effect, and dropped after the hold
  if (rec && data.reward!.anchored) {
    const s = await settle(data.idea, rec, attempts[0]);
    if ("landed" in s) return rewarded(r, s.landed);
    if (expired && !s.replaces) {
      await save({ ...r, status: "reward_dropped", data: { ...data, why: `not paid within ${REWARD_HOLD_DAYS} days; the money stays in the reserve` } });
      return "dropped";
    }
    if (soon || !payee || !same(payee.to, rec.to)) return "waiting: the anchored record's payee is not the binding in force (or a wallet change takes effect soon)";
    return sendQueue(r, rec, s.replaces, nowS);
  }
  const pot = await QUEUE_DEPS.pot(payee?.to ?? ZERO);
  const caps = rewardCaps(pot, nowS);
  // the brain decides once, inside the caps of the day it decides
  if (!data.reward) {
    if (caps.max < caps.min) return "waiting: no room under the caps to decide a reward";
    const input = { basis: data.basis!.kind, idea: { title: data.title, summary: data.summary, spec: data.spec, untrusted: true }, result: await basisFacts(data.basis!), capsEth: { min: Number(caps.min) / 1e18, max: Number(caps.max) / 1e18 } };
    const out = await QUEUE_DEPS.decide(input, `reward:idea:${data.idea}`);
    const wei = rewardWei(out.decision.amountEth, caps);
    const reward = { brain: String(out.seq), amountWei: String(wei), reason: out.decision.reason.slice(0, 400) };
    if (wei === 0n) { await save({ ...r, status: "no_reward", data: { ...data, reward } }); return "the brain gave no reward"; }
    data.reward = reward;
    await save({ ...r, data });
  }
  if (soon) return "waiting: a wallet change of the author takes effect soon";
  if (!payee) return "waiting for the author's X binding";
  let amount = BigInt(data.reward.amountWei);
  if (amount > caps.max) amount = caps.max; // the reserve or the day's budget shrank since the decision
  const why = rewardRoom(pot, amount, nowS);
  if (why) return `waiting: ${why}`;
  // the signed record the watchdog checks (rebuilt only before it is anchored)
  let next = data.reward.record;
  if (!next || !same(next.to, payee.to) || next.amount !== String(amount)) {
    const idea: RewardRecord["idea"] = data.source.source === "x" ? { source: "x", authorId: data.source.authorId, postId: data.source.postId } : { source: "ideamarket", id: String(data.idea) };
    const body: RewardRecord & { brain: string; reason: string } = { kind: "reward", idea, to: payee.to, amount: String(amount), basis: data.basis!, ...(payee.binding ? { binding: payee.binding } : {}), brain: data.reward.brain, reason: data.reward.reason };
    const block = Number(await pub.getBlockNumber());
    const a = await append("reward", `idea:${data.idea}`, body);
    next = { seq: a.seq, root: `0x${a.ehash ?? a.hash}` as Hex, to: payee.to, amount: String(amount), block };
    data.reward = { ...data.reward, record: next, anchored: false };
    await save({ ...r, data });
  }
  // anchored before the queue, once (a crash after the anchor tx finds it on-chain)
  if (!(await anchoredOnChain(next))) {
    const s = await send({ key: "anchor", to: d.registry, abi: abi.registryAbi, fn: "anchor", args: [next.root, `${LOG_BASE_URL}/api/log/${next.seq}`], purpose: `anchor:reward:${next.seq}` });
    if (s.status !== "mined" && s.status !== "dry_run") throw new Error(`reward anchor ${s.status}: ${s.error ?? s.hash}`);
    if (s.status === "dry_run") return "dry run: anchor and queue simulated";
  }
  data.reward = { ...data.reward, anchored: true };
  await save({ ...r, data });
  const s = await settle(data.idea, next, attempts[0]);
  if ("landed" in s) return rewarded(r, s.landed);
  return sendQueue(r, next, s.replaces, nowS);
}

export async function rewardStep(nowMs = Date.now()) {
  if (!d.gamePot) return { skipped: "no GamePot in the deployment" };
  const out: Record<string, string> = {};
  for (const kind of ["fee", "build"] as const) {
    for (const r of await rows(kind, "reward")) {
      const expired = nowMs - Date.parse(r.data.since ?? "") > REWARD_HOLD_DAYS * DAY_MS;
      // an anchored record is settled by rewardOne (an attempt that may still land is resolved first)
      if (expired && !r.data.reward?.anchored) {
        await save({ ...r, status: "reward_dropped", data: { ...r.data, why: `not paid within ${REWARD_HOLD_DAYS} days (no binding or no room); the money stays in the reserve` } });
        out[r.id] = "dropped";
        continue;
      }
      // one row's trouble (an RPC error, a tx not mined in time, a bad brain answer) never holds up the others
      try {
        out[r.id] = await rewardOne(r, nowMs, expired);
      } catch (e) {
        // a Defer (gas guard, daily cap, halted, LLM cap) is a wait, not trouble: the next run picks the row up again
        if (e instanceof Defer) { out[r.id] = `deferred: ${e.message.slice(0, 300)}`; continue; }
        out[r.id] = `error: ${(e as Error).message.slice(0, 300)}`;
        await alert(`Idea reward for ${r.id}: ${(e as Error).message.slice(0, 300)}`, `alert:reward:${r.id}:${new Date().toISOString().slice(0, 13)}`);
      }
    }
  }
  return out;
}

export const ideaLoopHandler: Handler = {
  lane: "ideas",
  run: async () => {
    const added = await ingest();
    if ((await mode()) !== "live") return { added, waits: "engine not live: experiments and rewards wait" };
    return { added, fee: await feeStep(), rewards: await rewardStep() };
  },
};
