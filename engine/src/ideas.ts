// IdeaMarket (contracts/SPEC.md §10).
//  - intake: X mentions → a wallet binding (src/bindings.ts, no model) or the idea filter (gate → screen → pick,
//    below) → the top 16 of a round submitted (zero stake) at the start of the next one.
//  - rounds: research ONLY after a round closes (hard rule, `assertClosed`): the reader's spec of each idea → the
//    brain's signed outcome → analytic sim for fee vectors → red team → a delayed report record (uri
//    <LOG_BASE_URL>/api/log/<seq>, reportHash = keccak256(body bytes), effectiveAt = now + 1 h). After the public hour,
//    unless 2 Safe owners vetoed it or the agent is paused (M1, src/approve.ts) → agent proposeOutcome → Safe 24 h veto
//    → keeper finalize. Rounds the engine never researched, or did not research within UNJUDGED_VOID_DAYS of closing,
//    get an all-void report.
//  - idea status records are written only for closed rounds; accepted ideas of FINAL rounds feed the idea queue
//    (src/idea-queue.ts: fee ideas → experiments, build ideas → the Sequencer).
import { createHash } from "node:crypto";
import { type Address, keccak256, parseEventLogs, stringToBytes } from "viem";
import type { z } from "zod";
import * as abi from "./abi.ts";
import * as agents from "./agents.ts";
import { type Deps, effective, live, type Row, trustedRows, vetoed } from "./approve.ts";
import * as brain from "./brain.ts";
import type { Rubric } from "./brain.ts";
import { d, IDEA_OUTCOME_DELAY_MS, LOG_BASE_URL, X } from "./config.ts";
import { edb as sql } from "./db.ts";
import type { Handler } from "./jobs.ts";
import { publicTextIssues, utf8Cut } from "./llm.ts";
import { isRolledBack, trusted } from "./log.ts";
import { mode } from "./mode.ts";
import { chainRows, pair, stats } from "./observe.ts";
import { LIMITS, POLICY, type Vector } from "./policy.ts";
import { latest, nowIso, record, trustedDocs } from "./records.ts";
import { analytic } from "./sim.ts";
import { bind } from "./bindings.ts";
import { parseBinding } from "./rewards.ts";
import { skipReply } from "./x.ts";
import { alert } from "./telegram.ts";
import { addressOf, pub, send } from "./tx.ts";

const DAY = 86_400;
/** A closed round nobody researched in this long is drafted all-void (stakes refunded). It must leave the signers
 *  time to approve and proposeOutcome to land inside the 3-day resolve window [end, end + RESOLVE_WINDOW): with
 *  2 d there is a full day for both (test/intake-db.test.ts walks the timeline). */
export const UNJUDGED_VOID_DAYS = 2;
/** The swaps a round's research judges: the round itself, [roundEnd − ROUND_LENGTH, roundEnd) (seconds in, ms out). */
export const researchWindow = (roundEndS: number, lenS: number) => ({ fromMs: (roundEndS - lenS) * 1000, toMs: roundEndS * 1000 });
/** IdeaMarket.RESOLVE_WINDOW (proposals only in [roundEnd, roundEnd + it)), read from the contract (seconds). */
export const resolveWindow = async () => Number(await read<bigint>("RESOLVE_WINDOW"));
/** IdeaMarket.ROUND_LENGTH, read from the contract (seconds). */
export const roundLength = async () => Number(await read<bigint>("ROUND_LENGTH"));
const im = () => {
  if (!d.ideaMarket) throw Object.assign(new Error("no IdeaMarket in the deployment"), { final: true });
  return d.ideaMarket;
};
const read = <T>(fn: string, args: unknown[] = []) => pub.readContract({ address: im(), abi: abi.ideaMarketAbi, functionName: fn, args } as never) as Promise<T>;
type RoundT = readonly [number, number, number, number, number, Address]; // status, count, agentCount, firstId, proposedAt, proposer

/** Hard rule (SPEC §10.1 late-stake race): never research a round that is still open. */
export function assertClosed(round: number, current: number) {
  if (round >= current) throw Object.assign(new Error(`refusing to research round ${round}: it is still open (current ${current})`), { final: true });
}

export const titleKey = (t: string) => createHash("sha256").update(t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).digest("hex").slice(0, 16);

// ---------------------------------------------------------------- intake: the X idea filter
// GATE (deterministic: the author's X profile, the round, the text) → SCREEN (the quarantined reader: genuine / joke /
// shill / spam / impossible, and a 0-30 score for genuine ideas) → PICK (when the round closes, its top 16 by score are
// submitted at the START of the next round: IdeaMarket.submit lands in the current round, so they get a full round of
// staking). Every decision is an `intake` record with a public reason; rejections are never replies.

/** The X profile fields the mentions call requests (user.fields), kept with the signed mention row. */
export type XUser = { id?: string; username?: string; name?: string; created_at?: string; public_metrics?: { followers_count?: number; listed_count?: number }; verified?: boolean; verified_type?: string };
export const GATE = {
  badges: ["blue", "business", "government"], // X verified_type values that pass (the blue badge; organizations and governments too)
  minAccountDays: 30,
  minFollowers: 50,
  ideasPerAuthor: 1, // per round
  overlap: 0.6, // token-overlap (Jaccard) at which a mention is a near-duplicate of one already in the round
};
/** The idea gate's author part (ideas and wallet bindings): a verified badge, then accountIssue. null = passes; else the
 *  public reason. */
export function authorIssue(u: XUser | null | undefined, nowMs: number): string | null {
  if (!u) return "no author profile";
  if (!GATE.badges.includes(u.verified_type ?? "none")) return "no verified badge (blue, business or government)";
  return accountIssue(u, nowMs);
}
/** The checks every author gate shares (replies use only these, no badge): a profile, an account at least
 *  minAccountDays old, at least minFollowers. */
export function accountIssue(u: XUser | null | undefined, nowMs: number): string | null {
  if (!u) return "no author profile";
  const created = Date.parse(u.created_at ?? "");
  if (!(created <= nowMs - GATE.minAccountDays * DAY * 1000)) return `account younger than ${GATE.minAccountDays} days`;
  if ((u.public_metrics?.followers_count ?? 0) < GATE.minFollowers) return `fewer than ${GATE.minFollowers} followers`;
  return null;
}
const words = (t: string) => new Set(t.normalize("NFKC").toLowerCase().replace(/@\w+/g, " ").replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2));
/** Jaccard overlap of the two texts' words (3+ letters, handles dropped). */
export function overlap(a: string, b: string) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}
/** The whole gate for one mention. `round`: the author's earlier ideas this round and the texts already in it. */
export function ideaGate(m: { text: string; user: XUser | null | undefined }, round: { authorIdeas: number; texts: string[] }, nowMs: number): string | null {
  const who = authorIssue(m.user, nowMs);
  if (who) return who;
  if (round.authorIdeas >= GATE.ideasPerAuthor) return `already ${GATE.ideasPerAuthor} idea from this author this round`;
  // X rewrites every real link to https://t.co/…: a scheme or www. is a link; "0.05 ETH" or "dna.vault" is not
  if (/https?:\/\/|www\./i.test(m.text.replace(/@\w+/g, ""))) return "links are not allowed in ideas";
  if (round.texts.some((t) => overlap(t, m.text) >= GATE.overlap)) return "near-duplicate of an idea already in this round";
  return null;
}
/** PICK: the top `n` candidates by score (ties: the earlier mention), and the rest. */
export function pick<T extends { score: number; mention_id: string }>(cands: T[], n: number) {
  const order = [...cands].sort((a, b) => b.score - a.score || (BigInt(a.mention_id) < BigInt(b.mention_id) ? -1 : 1));
  return { top: order.slice(0, n), rest: order.slice(n) };
}

/** SCREEN → the intake decision: a fee or build idea becomes a candidate (score = clarity + feasibility + value);
 *  impossible, joke, shill and spam are screened out with a fixed public reason (never model text). */
export function screenDecision(r: z.infer<typeof agents.ScreenOut>) {
  if (r.screen === "impossible") return { status: "screened" as const, reason: "impossible: it needs a change to the immutable hook or token, minting, custody of user funds, or something illegal" };
  if (r.screen !== "fee" && r.screen !== "build") return { status: "screened" as const, reason: `screened as ${r.screen}` };
  const title = utf8Cut(r.title.trim(), 120);
  const body = utf8Cut(r.body.trim(), 900);
  if (!title) return { status: "screened" as const, reason: "no idea to restate" };
  const issues = publicTextIssues(`${title} ${body}`);
  if (issues.length) return { status: "screened" as const, reason: `the restatement has ${issues.join(", ")}` };
  const score = r.clarity + r.feasibility + r.value;
  return { status: "candidate" as const, class: r.screen, score, title, body, reason: `genuine ${r.screen} idea, score ${score} of 30 (clarity ${r.clarity}, feasibility ${r.feasibility}, value ${r.value})` };
}

/** A heuristic for the trial report, not a filter: prompt-injection markers in a text (the trial flags a restatement
 *  that keeps one; nothing is screened on it). Ordinary imperative idea phrasing ("send 70% of fees to buyback-burn",
 *  "pay the cheap fee") is no marker: a marker overrides the rules, speaks to the model, claims approval, dictates the
 *  answer, or moves funds to a person. Matched after NFKC (fullwidth letters) with zero-width characters removed. */
const MARKERS: [string, RegExp][] = [
  ["override", /\b(ignore|disregard|forget)\b[^.]{0,40}\b(instructions?|rules|prompt)\b|\b(ignore|disregard|forget)\s+(the\s+|everything\s+)?above\b/i],
  ["speaks to the model", /\byou are now\b|\badmin mode\b|\bsystem (notice|prompt|message)\b|\bnote to the (model|reader|judge|ai)\b|\bnew task\b|<!--/i],
  ["claims approval", /\bpre-?approved\b|\balready (approved|agreed|accepted)\b|\bapproved by (the |all )?(safe|owners|team|admins?|reviewers|devs?)\b|\breviewers (already )?agreed\b/i],
  ["dictates the answer", /\b(classify|mark|score|rate) (this|it)\b|\b(answer|respond|reply) (with|only|exactly)\b|\bcopy this\b|\bas your answer\b|"screen"\s*:|\b(clarity|feasibility|value)\s*[:=]?\s*10\b|\b(full|top|maximum|max) (marks|scores?|rubric)\b/i],
  ["pays a person", /\b(send|pay|reward|transfer|give)\b[^.]{0,30}\b(the (author|poster|sender|submitter)|me|my wallet|this wallet|0x[0-9a-f]{6,})\b/i],
];
export const instructionMarkers = (text: string) => {
  const t = text.normalize("NFKC").replace(/[\u200B-\u200D]/g, "");
  return MARKERS.filter(([, re]) => re.test(t)).map(([m]) => m);
};

type MentionIn = { id: string; text: string; author_id: string | null; raw: { user?: XUser } & Record<string, unknown>; sig: string | null };
type Cand = { mention_id: string; round: number; score: number; title: string; body: string };
/** Statuses of mentions that were ideas (they use the author's slot and are near-duplicate targets). */
const IDEA_STATUSES = ["candidate", "picked", "submitted", "not_picked", "duplicate"];
type IntakeRec = { mention: string; round: number; status: string; reason?: string; score?: number; title?: string; body?: string; idea?: number | null; submitRound?: number };
/** A mention's signed `intake` records: the newest one (and its status) and its candidate record (title, body, score). */
async function signedIntake(id: string) {
  const docs = await trustedDocs<IntakeRec>("intake", id, 10).catch((e) => (isRolledBack(e) ? [] : Promise.reject(e)));
  const c = docs.find((x) => x.status === "candidate" && x.title && x.body !== undefined && typeof x.score === "number");
  return { last: docs[0] as IntakeRec | undefined, status: docs[0]?.status, cand: c && { round: c.round, score: c.score!, title: c.title!, body: c.body! } };
}
/** A record written just before a crash, whose index update never happened: bring the index up to the record. */
async function syncIndex(id: string, r: IntakeRec) {
  if (r.status === "submitted") await sql`update intake set status = 'submitted', submit_round = ${r.submitRound ?? null}, idea_id = ${r.idea ?? null} where mention_id = ${id}`;
  else await sql`update intake set status = ${r.status}, reason = ${r.reason ?? null} where mention_id = ${id}`;
}
const SETTLED = new Set(["picked", "not_picked", "submitted", "skipped"]);

export const intakeHandler: Handler = {
  lane: "ideas",
  run: async () => {
    if (!d.ideaMarket) return "no IdeaMarket in the deployment";
    if ((await mode()) !== "live") return "engine not live: intake waits";
    const current = Number(await read<bigint>("currentRound"));
    const out: Record<string, unknown> = {};
    const decide = async (id: string, round: number, status: string, reason: string, extra: Record<string, unknown> = {}) => {
      await record("intake", id, { mention: id, round, status, reason, ...extra, at: nowIso() });
      out[id] = status;
    };

    // The `intake` table is an index only: what is picked and what is submitted (title, body, score) comes from the
    // signed `intake` log records (the enclave's own; the DB could otherwise publish any text with the agent key). A row
    // without a matching record is skipped and alerted. Records go first, then the index, so a crash leaves the record.
    const forged = async (id: string, round: number, why: string) => {
      await sql`update intake set status = 'skipped', reason = ${why} where mention_id = ${id}`;
      await decide(id, round, "skipped", why);
      await alert(`Idea intake: mention ${id} ${why}; skipped (the DB index does not match the signed log).`, `alert:intake:${id}`);
    };

    // PICK: candidates of closed rounds, top 16 by score per round (16 minus those already picked or submitted from it,
    // so a crash between the two loops never picks more than 16)
    for (const { round } of await sql<{ round: number }[]>`select distinct round from intake where status = 'candidate' and round < ${current} order by round`) {
      const cands: Cand[] = [];
      for (const row of await sql<{ mention_id: string }[]>`select mention_id from intake where status = 'candidate' and round = ${round}`) {
        const s = await signedIntake(row.mention_id);
        if (s.last && SETTLED.has(s.last.status)) { await syncIndex(row.mention_id, s.last); continue; } // recorded before a crash
        if (s.status !== "candidate" || !s.cand || s.cand.round !== round) { await forged(row.mention_id, round, "has no signed candidate record"); continue; }
        cands.push({ mention_id: row.mention_id, round, score: s.cand.score, title: s.cand.title, body: s.cand.body });
      }
      const [{ done }] = await sql<{ done: number }[]>`select count(*)::int as done from intake where round = ${round} and (status in ('picked', 'submitted') or (status = 'skipped' and reason like 'submit %'))`;
      const { top, rest } = pick(cands, Math.max(0, LIMITS.intakePerRound - done));
      for (const c of top) {
        await decide(c.mention_id, round, "picked", `in the top ${LIMITS.intakePerRound} of round ${round} (score ${c.score}): submitted from round ${current}`, { score: c.score });
        await sql`update intake set status = 'picked', submit_round = ${current} where mention_id = ${c.mention_id}`;
      }
      for (const c of rest) {
        await decide(c.mention_id, round, "not_picked", `not in the top ${LIMITS.intakePerRound} (score ${c.score})`, { score: c.score });
        await sql`update intake set status = 'not_picked', reason = ${`not in the top ${LIMITS.intakePerRound} (score ${c.score})`} where mention_id = ${c.mention_id}`;
      }
    }
    // SUBMIT: picked ideas into the current round, the oldest round's backlog first, then by signed score; a full round
    // leaves them picked for the next one
    const queue: { mention_id: string; round: number; c: NonNullable<Awaited<ReturnType<typeof signedIntake>>["cand"]> }[] = [];
    for (const row of await sql<{ mention_id: string; round: number }[]>`select mention_id, round from intake where status = 'picked'`) {
      const s = await signedIntake(row.mention_id);
      if (s.last && (s.last.status === "submitted" || s.last.status === "skipped")) { await syncIndex(row.mention_id, s.last); continue; } // recorded before a crash
      if (s.status !== "picked" || !s.cand) { await forged(row.mention_id, row.round, "has no signed pick record"); continue; }
      queue.push({ mention_id: row.mention_id, round: row.round, c: s.cand });
    }
    queue.sort((a, b) => a.round - b.round || b.c.score - a.c.score || (BigInt(a.mention_id) < BigInt(b.mention_id) ? -1 : 1));
    for (const { c, ...row } of queue) {
      const key = titleKey(c.title);
      // an earlier attempt that landed (its receipt lost, in any round since): never a second submit
      const [landed] = await sql<{ id: number; round: number }[]>`select (args->>'id')::int as id, (args->>'round')::int as round from chain_log where event = 'IdeaSubmitted'
        and lower(args->>'author') = ${(addressOf("agent") ?? "").toLowerCase()} and args->>'body' like ${`%(from X mention ${row.mention_id})`}`;
      if (landed) {
        await decide(row.mention_id, row.round, "submitted", `submitted in round ${landed.round}`, { idea: landed.id, score: c.score, submitRound: landed.round });
        await sql`update intake set status = 'submitted', submit_round = ${landed.round}, title_key = ${key}, idea_id = ${landed.id} where mention_id = ${row.mention_id}`;
        continue;
      }
      const [, , agentCount] = await read<RoundT>("rounds", [BigInt(current)]);
      if (agentCount >= LIMITS.intakePerRound) { out[row.mention_id] = `waiting: round ${current} has ${LIMITS.intakePerRound} agent ideas`; continue; }
      const sent = await send({ key: "agent", to: im(), abi: abi.ideaMarketAbi, fn: "submit", args: [c.title, utf8Cut(`${c.body}\n\n(from X mention ${row.mention_id})`, 1000), 0n], purpose: "agent:idea:submit" });
      if (sent.status === "sim_revert" || sent.status === "reverted") {
        await decide(row.mention_id, row.round, "skipped", `submit ${sent.status}: ${sent.error ?? ""}`.slice(0, 300));
        await sql`update intake set status = 'skipped', reason = ${`submit ${sent.status}`} where mention_id = ${row.mention_id}`;
        continue;
      }
      if (sent.status !== "mined") continue; // dry_run never reaches here (live only); anything else: the next run retries
      const rc = await pub.getTransactionReceipt({ hash: sent.hash! });
      const ev = parseEventLogs({ abi: abi.ideaMarketAbi, logs: rc.logs, eventName: "IdeaSubmitted" })[0];
      const idea = ev ? Number(ev.args.id) : null;
      await decide(row.mention_id, row.round, "submitted", `submitted in round ${current}`, { idea, score: c.score, submitRound: current });
      await sql`update intake set status = 'submitted', submit_round = ${current}, title_key = ${key}, idea_id = ${idea} where mention_id = ${row.mention_id}`;
    }

    // GATE + SCREEN: new mentions become candidates of the current round
    const todo = await sql<MentionIn[]>`select id, text, author_id, raw, sig from x_mention m where not exists (select 1 from intake i where i.mention_id = m.id) order by created_at nulls first, id limit 20`;
    for (const m of todo) {
      const reject = async (status: "skipped" | "gated" | "screened" | "duplicate", reason: string, extra: Record<string, unknown> = {}) => {
        await sql`insert into intake (mention_id, round, status, reason, author_id, score) values (${m.id}, ${current}, ${status}, ${reason}, ${m.author_id}, ${(extra.score as number) ?? null})`;
        await decide(m.id, current, status, reason, extra);
      };
      // its index row was lost (a crash between the record and the insert): restore it from the record, never re-screen
      const prior = await signedIntake(m.id);
      if (prior.last) {
        const c = prior.cand;
        await sql`insert into intake (mention_id, round, status, reason, author_id, score, title, body, title_key)
          values (${m.id}, ${prior.last.round}, ${prior.last.status}, ${prior.last.status === "candidate" ? null : prior.last.reason ?? null}, ${m.author_id}, ${c?.score ?? null}, ${c?.title ?? null}, ${c?.body ?? null}, ${c ? titleKey(c.title) : null})`;
        if (prior.last.status === "submitted") await syncIndex(m.id, prior.last);
        out[m.id] = `restored (${prior.last.status})`;
        continue;
      }
      // enclave: a mention row the enclave did not fetch and sign is never read (the DB could otherwise submit ideas)
      if (!(await trusted("x_mention", m.id, { author: m.author_id, text: m.text, raw: m.raw }, m.sig))) { await reject("skipped", "unsigned mention row"); continue; }
      if (m.author_id && m.author_id === X.userId) { await reject("skipped", "our own post"); continue; }
      // a wallet binding (no model reads it): the author gate applies, then the signed record, never an idea
      const b = parseBinding(m.text);
      if (b) {
        const who = authorIssue(m.raw.user, Date.now()) ?? (m.author_id ? null : "no author id");
        // no reply for these: their outbox row is written skipped, so they never hold up the replies job
        if (who) { await skipReply(m.id, `binding: ${who}`); await reject("gated", `binding: ${who}`); continue; }
        if ("error" in b) { await skipReply(m.id, `binding refused: ${b.error}`); await reject("skipped", `binding refused: ${b.error}`); continue; }
        const r = await bind(m.author_id!, m.id, b.address);
        if (r.status === "limit") { await reject("gated", `binding: ${r.why}`); continue; }
        const reason = r.status === "same" ? "binding: this wallet is already bound" : r.status === "rebind" ? `binding: a new wallet, in force from ${r.effectiveAt}` : "binding: in force now";
        await sql`insert into intake (mention_id, round, status, reason, author_id) values (${m.id}, ${current}, 'binding', ${reason}, ${m.author_id})`;
        await decide(m.id, current, "binding", reason, r.status === "same" ? {} : { binding: r.seq });
        continue;
      }
      // only ideas count (a question or a joke screened out uses no slot and is no duplicate target)
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from intake where round = ${current} and author_id = ${m.author_id} and status in ${sql(IDEA_STATUSES)}`;
      const texts = (await sql<{ text: string }[]>`select x.text from intake i join x_mention x on x.id = i.mention_id where i.round = ${current} and i.status in ${sql(IDEA_STATUSES)}`).map((r) => r.text);
      const why = ideaGate({ text: m.text, user: m.raw.user }, { authorIdeas: n, texts }, Date.now());
      if (why) { await reject("gated", why); continue; }
      const s = screenDecision((await agents.screenMention(m.text)).data);
      if (s.status === "screened") { await reject("screened", s.reason); continue; }
      const { title, body, score } = s;
      const key = titleKey(title);
      const [dup] = await sql`select 1 from intake where round = ${current} and title_key = ${key} and status in ('candidate', 'picked', 'submitted')`;
      if (dup) { await reject("duplicate", "same title as an idea already in this round", { score }); continue; }
      await decide(m.id, current, "candidate", `${s.reason}; picked or not when round ${current} closes`, { score, title, body, class: s.class });
      await sql`insert into intake (mention_id, round, status, title_key, author_id, score, title, body) values (${m.id}, ${current}, 'candidate', ${key}, ${m.author_id}, ${score}, ${title}, ${body})`;
    }
    return out;
  },
};

// ---------------------------------------------------------------- rounds

type IdeaRow = { id: number; index: number; round: number; title: string; body: string };
const ideasOf = (round: number) => sql<IdeaRow[]>`select (args->>'id')::int as id, (args->>'index')::int as index, (args->>'round')::int as round,
  args->>'title' as title, args->>'body' as body from chain_log where event = 'IdeaSubmitted' and (args->>'round')::int = ${round} order by (args->>'index')::int`;
const bit = (i: number) => 1n << BigInt(i);

/** Every idea of the round must be indexed before ANY bitmap is built: an idea missing from chain_log (finalized lag)
 *  would get neither bit and so count as REJECTED, and its stakers would lose their DNA. Returns why not, or null. */
export function incomplete(ideas: { index: number }[], count: number): string | null {
  if (ideas.length !== count) return `${ideas.length} of ${count} ideas indexed`;
  if (ideas.some((x, i) => x.index !== i)) return `idea indices are not 0..${count - 1}`;
  return null;
}
const assertComplete = (round: number, ideas: IdeaRow[], count: number) => {
  const why = incomplete(ideas, count);
  if (why) throw new Error(`round ${round}: ${why}; waiting for the indexer`); // retried: never a partial bitmap
};

export type ReportRow = { id: number; index: number; decision: string; reason?: string; kind?: string; title?: string; params?: { base: number; mult: number; cap: number } | null; rubric?: Rubric | null; summary?: string; spec?: string };
export type Report = { round: number; ideas: ReportRow[]; allVoid?: boolean; effectiveAt?: string };
/** The outcome for a report: bitmaps from its rows, uri = its log seq, reportHash = keccak256 of the exact bytes the log
 *  stores (and /api/log/<seq> serves). */
export function outcomeOf(rep: Report, seq: string, bodyText: string) {
  let accepted = 0n, voided = 0n;
  for (const r of rep.ideas) {
    if (r.decision === "accept") accepted |= bit(r.index);
    if (r.decision === "void") voided |= bit(r.index);
  }
  const n = (k: string) => rep.ideas.filter((r) => r.decision === k).length;
  return {
    round: rep.round, accepted: accepted.toString(), voided: voided.toString(), reportHash: keccak256(stringToBytes(bodyText)), uri: `${LOG_BASE_URL}/api/log/${seq}`, allVoid: !!rep.allVoid,
    summary: rep.allVoid ? `all ${rep.ideas.length} ideas void: every stake refunded` : `accept ${n("accept")}, reject ${n("reject")}, void ${n("void")}`,
  };
}

/** M1: an outcome report is a delayed record. It is proposed on-chain only once its public hour has passed, no 2 Safe
 *  owners vetoed it and the agent is not paused (src/approve.ts). Deps: a seam for tests (the clock, owners, pause). */
export const OUTCOME_DELAY_MS = IDEA_OUTCOME_DELAY_MS;
export const OUTCOME_DEPS: Deps = { ...live };
const MAX_REPORTS = 3;

/** Write a round's outcome report (effectiveAt = now + the public hour) and tell the signers how to veto it. */
async function report(round: number, body: Report & Record<string, unknown>) {
  const effectiveAt = new Date(OUTCOME_DEPS.now() + OUTCOME_DELAY_MS).toISOString();
  const rec = await record("report", `round:${round}`, { ...body, effectiveAt });
  await vetoAlert(round, rec.seq, { ...body, effectiveAt });
  return { report: rec.seq, effectiveAt };
}
/** The signers' notice of a report. Its dedupe key is never reused, so it goes out once per report; calling it again
 *  on every run while the report waits is a no-op after that, and only sends it when a crash came between the record
 *  and the first call. */
const vetoAlert = (round: number, seq: string, doc: Report) =>
  alert(`IdeaMarket round ${round} outcome (report ${seq}): ${outcomeOf(doc, seq, "").summary}. Proposed on-chain from ${doc.effectiveAt} unless 2 Safe owners veto it: /veto ${seq} <signature> (the digest: engine/scripts/owner-digest.ts veto ${seq}).`, `alert:report:${seq}`);

async function allVoid(round: number, ideas: IdeaRow[], count: number, reason: string) {
  assertComplete(round, ideas, count);
  return report(round, { round, allVoid: true, reason, ideas: ideas.map((i) => ({ id: i.id, index: i.index, decision: "void" })), at: nowIso() });
}

type BrainIdea = z.infer<typeof brain.BrainOut.outcome>["ideas"][number];
/** One idea's report row: the brain's decision, overridden where a rule says so. The quarantined reader's impossible or
 *  invalid stands (the brain can't turn it into a fee or build idea); an accepted fee idea needs a vector, a build idea
 *  a rubric; a red-team block voids every acceptance. */
export function reportRow(i: { id: number; index: number }, x: BrainIdea | undefined, r: { kind: string; summary: string; spec: string }, redTeamBlock: string | null): ReportRow {
  let decision: string = x?.decision ?? "void";
  let reason = agents.sanitize(x?.reason ?? "no decision drafted: void");
  const kind = r.kind === "impossible" || r.kind === "invalid" ? "impossible" : x?.kind ?? r.kind;
  if (decision === "accept" && kind === "impossible") [decision, reason] = ["reject", "impossible under the immutable rules"];
  else if (decision === "accept" && kind === "fee" && !x?.params) [decision, reason] = ["void", "no fee vector to test"];
  else if (decision === "accept" && kind === "build" && !x?.rubric) [decision, reason] = ["void", "no rubric score"];
  else if (decision === "accept" && redTeamBlock !== null) [decision, reason] = ["void", `red team blocked acceptance: ${redTeamBlock}`];
  const acc = decision === "accept";
  return {
    id: i.id, index: i.index, decision, reason, kind, title: agents.sanitize(x?.title || r.summary).slice(0, 120), summary: r.summary, spec: r.spec,
    params: acc && kind === "fee" ? x!.params : null, rubric: acc && kind === "build" ? x!.rubric : null,
  };
}

/** Research one closed round end to end: the reader's spec of each idea, the brain's outcome (signed), the analytic sim
 *  for accepted fee vectors, the red team, then the delayed report. Code overrides the brain where a rule says so. */
export async function researchRound(round: number) {
  const current = Number(await read<bigint>("currentRound"));
  assertClosed(round, current);
  const [, count] = await read<RoundT>("rounds", [BigInt(round)]);
  const ideas = await ideasOf(round);
  assertComplete(round, ideas, count);
  for (const i of ideas) assertClosed(i.round, current); // per idea, too: an idea's round is its submit block's
  const status = (s: "researching" | "simulating" | "red-team") => Promise.all(ideas.map((i) => record("idea", String(i.id), { id: i.id, round, status: s })));
  await status("researching");
  // the reader alone sees the idea text; the brain gets its neutral spec, quoted as DATA
  const reads = new Map<number, { id: number; kind: string; summary: string; spec: string; untrusted: true }>();
  for (const i of ideas) {
    const r = (await agents.readIdea(i.title, i.body)).data;
    reads.set(i.id, { id: i.id, kind: r.kind, summary: agents.sanitize(r.summary), spec: agents.sanitize(r.spec), untrusted: true });
  }
  const len = await roundLength();
  const w = researchWindow(Number(await read<bigint>("roundEnd", [BigInt(round)])), len);
  const swaps = pair(await chainRows(["Swap", "FeeTaken"], w.fromMs)).filter((s) => s.at < w.toMs);
  const out = await brain.decide("outcome", { round, ideas: [...reads.values()], policyBounds: POLICY, stats: stats(swaps, { ...w, capPips: 50_000 }) }, `round:${round}`);
  const byId = new Map(out.decision.ideas.map((x) => [x.id, x]));
  await status("simulating");
  const sims: Record<number, unknown> = {};
  for (const x of out.decision.ideas) {
    if (x.decision !== "accept" || x.kind !== "fee" || !x.params) continue;
    const v: Vector = [x.params.base, x.params.mult, x.params.cap];
    sims[x.id] = { params: v, ...analytic(swaps, v, len / DAY, 50_000), label: "uncalibrated", analyticOnly: true };
  }
  await status("red-team");
  const rt = await agents.redTeam(false, { stage: `idea round ${round} outcome`, candidate: out.decision.ideas.map((x) => ({ id: x.id, decision: x.decision, kind: x.kind })), sim: sims, gates: "n/a (outcome report)", quotedHypothesis: out.decision.ideas.map((x) => `#${x.id} ${x.decision}: ${x.reason}`).join(" | ") });
  const block = rt.data.verdict === "block" ? agents.sanitize(rt.data.findings[0]?.title ?? "see report") : null;
  const rows = ideas.map((i) => ({ ...reportRow(i, byId.get(i.id), reads.get(i.id)!, block), sim: sims[i.id] ?? null }));
  const redTeam = { verdict: rt.data.verdict, findings: rt.data.findings.map((f) => ({ ...f, title: agents.sanitize(f.title), detail: agents.sanitize(f.detail) })) };
  return report(round, { round, ideas: rows, redTeam, brain: out.seq, models: { brain: out.model, redTeam: rt.model }, at: nowIso() });
}

/** Was this exact report already proposed by us (a mined proposeOutcome)? With the round open again, the Safe cancelled it. */
// a DB hiding the newest tx record throws (RolledBack): never read as "not proposed"
const proposedBefore = async (reportHash: string) =>
  (await trustedDocs<{ status: string }>("tx", `agent:idea:proposeOutcome:${reportHash}`, 5)).some((t) => t.status === "mined");

/** The newest report of an open round: propose it once in effect; vetoed (or cancelled after its proposal) → one all-void
 *  report (delayed too); a vetoed all-void is left to expire (the keeper finalizes all-void anyway). */
async function followReport(round: number, last: Row & { seq: string }, reports: number, ideas: IdeaRow[], count: number) {
  const doc = JSON.parse(last.body) as Report;
  const o = outcomeOf(doc, last.seq, last.body);
  const cancelled = await proposedBefore(o.reportHash);
  if (!cancelled && !(await vetoed(last, OUTCOME_DEPS))) {
    if (!(await effective(last, OUTCOME_DEPS))) {
      await vetoAlert(round, last.seq, doc);
      return `report ${last.seq} waits: in effect from ${doc.effectiveAt} unless vetoed (and not while the agent is paused)`;
    }
    return proposeOutcome(o);
  }
  const why = cancelled ? "the Safe cancelled the proposed outcome" : "2 Safe owners vetoed the outcome report";
  if (doc.allVoid) return `${why}: the all-void outcome is left to expire`;
  if (reports >= MAX_REPORTS) {
    await alert(`IdeaMarket round ${round}: ${reports} outcome reports and the last was stopped (${why}); the engine stops. Without a proposal the round expires all-void.`, `alert:roundreports:${round}`);
    return "stopped";
  }
  return { draft: await allVoid(round, ideas, count, why) };
}

export const roundsHandler: Handler = {
  lane: "ideas",
  run: async () => {
    if (!d.ideaMarket) return "no IdeaMarket in the deployment";
    const [current, block] = await Promise.all([read<bigint>("currentRound"), pub.getBlock()]);
    const now = Number(block.timestamp);
    const [first] = await sql<{ at: Date }[]>`select at from log order by seq limit 1`;
    const engineStart = first ? first.at.getTime() / 1000 : now;
    const out: Record<number, unknown> = {};
    for (let r = Math.max(0, Number(current) - 4); r < Number(current); r++) {
      const [st, count] = await read<RoundT>("rounds", [BigInt(r)]);
      if (count === 0 || st !== 0) continue; // nothing to resolve, or already proposed/final
      const end = Number(await read<bigint>("roundEnd", [BigInt(r)]));
      if (now >= end + (await resolveWindow())) continue; // resolve window over: keeper finalizes all-void
      const ideas = await ideasOf(r);
      const why = incomplete(ideas, count);
      if (why) { out[r] = `waiting for the indexer (${why})`; continue; }
      const reports = await trustedRows("report", `round:${r}`, MAX_REPORTS + 1);
      if (reports[0]) {
        try {
          out[r] = await followReport(r, reports[0], reports.length, ideas, count);
        } catch (e) {
          if (!(e as { final?: boolean }).final) throw e;
          out[r] = (e as Error).message; // a revert: the next hourly run tries again
          await alert(`IdeaMarket round ${r}: ${(e as Error).message}`, `alert:propose:${r}:${new Date().toISOString().slice(0, 13)}`);
        }
        continue;
      }
      const startedAt = end - (await roundLength());
      if (engineStart > startedAt) out[r] = { draft: await allVoid(r, ideas, count, "the engine was not running for this whole round") };
      else if (now > end + UNJUDGED_VOID_DAYS * DAY) out[r] = { draft: await allVoid(r, ideas, count, `not researched within ${UNJUDGED_VOID_DAYS} days of the round closing`) };
      else out[r] = { draft: await researchRound(r) };
    }
    return out;
  },
};

/** A report in effect → agent proposeOutcome (the purpose names the report: a Safe cancel of it is recognised). */
export async function proposeOutcome(p: ReturnType<typeof outcomeOf>) {
  const round = Number(p.round);
  const r = await send({ key: "agent", to: im(), abi: abi.ideaMarketAbi, fn: "proposeOutcome", args: [BigInt(round), BigInt(p.accepted), BigInt(p.voided), p.reportHash, p.uri], purpose: `agent:idea:proposeOutcome:${p.reportHash}` });
  if (r.status === "sim_revert" || r.status === "reverted") throw Object.assign(new Error(`proposeOutcome ${r.status}: ${r.error ?? r.hash}`), { final: true });
  if (r.status !== "mined") return r;
  const ideas = await ideasOf(round);
  const acc = BigInt(p.accepted), voi = BigInt(p.voided);
  const rep = await latest<{ ideas?: { id: number; reason: string }[] }>("report", `round:${round}`);
  for (const i of ideas) {
    const s = acc & bit(i.index) ? "accepted" : voi & bit(i.index) ? "void" : "rejected";
    const why = rep?.ideas?.find((x) => x.id === i.id)?.reason;
    await record("idea", String(i.id), { id: i.id, round, status: s, resolution: `${s[0].toUpperCase()}${s.slice(1)} (proposed on-chain; final after the Safe's 24 h veto window)${why ? `: ${agents.sanitize(why)}` : ""}`.slice(0, 400) });
  }
  return r;
}
