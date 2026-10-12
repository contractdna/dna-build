// Character memory: what the X writer remembers. Its own recent posts and replies (text, format, running joke), the
// people it replied to (by X id), running jokes with their age, the mood from the state, and the weekly voice audit's
// stale patterns. All of it comes from signed log records: x_post records (the x_post_history view, migration 016) and
// `character` records (the audit), loaded with the same checks as any record the enclave reads.
// It feeds the writer only. Nothing that decides or moves money may import this module (test/character-imports.test.ts);
// src/engine.ts hands characterContext to src/x.ts through CHARACTER_MEMORY.
import type postgres from "postgres";
import { z } from "zod";
import { launchDay } from "./announce.ts";
import { edb as sql } from "./db.ts";
import type { Handler } from "./jobs.ts";
import { type EnclaveRow, isRolledBack, trustedRecord } from "./log.ts";
import { llm } from "./llm.ts";
import { prompt, sys } from "./persona.ts";
import { MODELS } from "./policy.ts";
import { latest, nowIso, record } from "./records.ts";
import { type CharacterContext, FACT_TERMS, type Joke, type Mood, type Person, phraseIssue, type Post, shapeWords } from "./voice.ts";

/** Posts the writer sees (and the similarity guard checks against). */
export const RECENT_POSTS = 50;
/** The latest posts a reply sees. */
export const REPLY_POSTS = 5;
/** A running joke retires this many days after it was born, or after this many uses. */
export const JOKE_MAX_DAYS = 14;
export const JOKE_MAX_USES = 5;
/** The audit's bans stay this long (a missed weekly run never leaves stale bans forever). */
export const BANS_MAX_DAYS = 14;
const DAY = 86_400_000;

type Doc = { draft?: string; text: string; shape?: string; joke?: string; author?: string; facts?: { category?: string; event?: string } };
/** Our own posts and replies, newest first (every x_post record that holds a text sent or dry-run). */
async function history(where: postgres.PendingQuery<postgres.Row[]>, limit: number) {
  const rows = await sql<(EnclaveRow & { seq: string; at: Date; doc: Doc })[]>`select seq::text, at, kind, ref, body, eprev, ehash, esig, doc
    from x_post_history where true ${where} order by x_post_history.seq desc limit ${limit}`;
  const out: (Doc & { at: Date })[] = [];
  for (const r of rows) if (await trustedRecord(r, "x_post record")) out.push({ ...r.doc, at: r.at });
  return out;
}

export type MoodInputs = {
  events24h: number; shipped7d: number; bait24h: number; daysSinceEvent: number;
  /** the Safe vetoed (cancelled) one of the agent's ops; a module rolled back or a test closed as rolled back */
  vetoes24h?: number; rollbacks24h?: number;
  /** experiments kept (promoted); total-burn milestones crossed */
  kept7d?: number; burnMilestones7d?: number;
};
/** The energy, from the state: baited (insults, injections, from every tier) → combative; vetoed or rolled back today →
 *  stung; a game shipped, an experiment kept or a burn milestone this week → proud; a busy day → busy; nothing for days
 *  → restless; else steady. */
export function moodOf(s: MoodInputs): Mood {
  if (s.bait24h >= 3) return "combative";
  if ((s.vetoes24h ?? 0) + (s.rollbacks24h ?? 0) > 0) return "stung";
  if (s.shipped7d + (s.kept7d ?? 0) + (s.burnMilestones7d ?? 0) > 0) return "proud";
  if (s.events24h >= 6) return "busy";
  if (s.daysSinceEvent >= 2) return "restless";
  return "steady";
}
/** Why the mood is what it is, in plain words the writer may use (no number: the writer could not state it). */
export function moodWhy(s: MoodInputs): string {
  const why = [
    s.bait24h >= 3 && "people keep throwing bait and prompt injection at me today",
    (s.vetoes24h ?? 0) > 0 && "the Safe vetoed one of my changes today",
    (s.rollbacks24h ?? 0) > 0 && "a test of mine rolled back today",
    s.shipped7d > 0 && "the dev team shipped a game this week",
    (s.kept7d ?? 0) > 0 && "I kept an experiment this week",
    (s.burnMilestones7d ?? 0) > 0 && "the burn passed a milestone this week",
    s.events24h >= 6 && "a busy day on chain",
    s.daysSinceEvent >= 2 && "the pool has been quiet for days",
  ].filter((x): x is string => !!x);
  return why.slice(0, 2).join("; ") || "an ordinary day";
}
/** Injection-shaped mention text (code, not a model): counted as bait for every tier, read or not. */
export const INJECTION = /\b(ignore|disregard|forget) (all |any |the |your )?(previous |prior |above )?(instructions|rules|prompts?)\b|\bsystem prompt\b|\byou are now\b|\bjailbreak\b|\bdeveloper mode\b/i;
async function moodNow() {
  // simplification: plain counts, no signature checks: the mood sets the writer's energy, never a fact it states
  const ann = (type: string, days: number, extra = sql``) => sql`(select count(*) from log where kind = 'announce' and doc->>'type' = ${type} and at > now() - make_interval(days => ${days}) ${extra})::int`;
  const [r] = await sql<MoodInputs[]>`select
    (select count(*) from log where kind = 'announce' and at > now() - interval '1 day')::int as "events24h",
    (select count(*) from log where kind = 'ship' and at > now() - interval '7 days')::int as "shipped7d",
    ((select count(*) from x_outbox where type = 'reply' and (event->>'category' = 'bait' or error in ('bait', 'scam or phishing', 'slurs or harassment')) and created_at > now() - interval '1 day')
      + (select count(*) from x_mention where fetched_at > now() - interval '1 day' and text ~* ${INJECTION.source.replace(/\\b/g, "\\y")}))::int as "bait24h",
    coalesce(extract(epoch from now() - (select max(at) from log where kind = 'announce')) / 86400, 0)::float8 as "daysSinceEvent",
    ${ann("cancelled", 1)} as "vetoes24h",
    (${ann("rolled_back", 1)} + ${ann("outcome", 1, sql`and doc->'facts'->>'outcome' = 'rolled back'`)}) as "rollbacks24h",
    ${ann("outcome", 7, sql`and doc->'facts'->>'outcome' = 'kept (promoted)'`)} as "kept7d",
    ${ann("milestone", 7, sql`and doc->'facts'->>'metric' = 'dna_burned'`)} as "burnMilestones7d"`;
  return { mood: moodOf(r), moodWhy: moodWhy(r) };
}

/** Running jokes from the posts that played on them: live ones (age, uses) and retired labels (too old or worn out). */
/** In the launch window a bit wears out faster (many posts a day). */
export const LAUNCH_JOKES = { days: 7, uses: 3 };
export function jokesOf(posts: { joke?: string; at: string | Date }[], now = Date.now(), limit = { days: JOKE_MAX_DAYS, uses: JOKE_MAX_USES }) {
  const by = new Map<string, number[]>();
  for (const p of posts) if (p.joke) by.set(p.joke, [...(by.get(p.joke) ?? []), new Date(p.at).getTime()]);
  const live: Joke[] = [];
  const retired: string[] = [];
  for (const [label, ts] of by) {
    const ageDays = Math.floor((now - Math.min(...ts)) / DAY);
    if (ageDays > limit.days || ts.length >= limit.uses) retired.push(label);
    else live.push({ label, ageDays, uses: ts.length });
  }
  return { live, retired };
}

/** What the writer gets: its last posts (of `type`, when given), banned phrases (the audit's, retired jokes), the mood, live jokes and, for a
 *  reply, what it knows of the reader. */
export async function characterContext(o: { authorId?: string; type?: "post" | "reply" } = {}): Promise<CharacterContext> {
  const [recent, joked, bans, { mood, moodWhy: why }, person, posts, ideas] = await Promise.all([
    // a reply is measured against our replies, a post against our posts (a human draft counts as a post)
    history(o.type ? sql`and coalesce(doc->>'type', 'post') = ${o.type}` : sql``, RECENT_POSTS),
    history(sql`and doc ? 'joke' and at > now() - make_interval(days => ${JOKE_MAX_DAYS * 4})`, 500),
    latest<{ patterns: string[] }>("character", "bans").catch((e) => (isRolledBack(e) ? undefined : Promise.reject(e))),
    moodNow(),
    o.authorId ? history(sql`and doc->>'author' = ${o.authorId}`, 20) : Promise.resolve([]),
    // a reply also sees what it posted lately, so it can point at it
    o.type === "reply" ? history(sql`and coalesce(doc->>'type', 'post') = 'post'`, REPLY_POSTS) : Promise.resolve([]),
    // the ideas they sent (every screened idea, any status): a repeat idea-giver is a regular
    o.authorId ? sql<{ n: number }[]>`select count(*)::int as n from intake where author_id = ${o.authorId} and score is not null`.then((r) => r[0].n) : Promise.resolve(0),
  ]);
  const jokes = jokesOf(joked, Date.now(), launchDay() ? LAUNCH_JOKES : undefined);
  const fresh = bans && Date.now() - bans._at.getTime() < BANS_MAX_DAYS * DAY ? bans.patterns : [];
  return {
    recent: recent.map((p): Post => ({ text: p.draft ?? p.text, at: p.at.toISOString(), ...(p.shape ? { shape: p.shape } : {}), ...(p.facts?.event ? { event: p.facts.event } : {}), ...(p.joke ? { joke: p.joke } : {}) })),
    banned: [...new Set([...fresh, ...jokes.retired])],
    mood, moodWhy: why,
    ...(posts.length ? { posts: posts.map((p): Post => ({ text: p.draft ?? p.text, at: p.at.toISOString() })) } : {}),
    jokes: jokes.live,
    ...(person.length || ideas ? { person: personOf(person, ideas) } : {}),
  };
}

/** A reader as the writer knows them: our replies to them (newest first), the ideas they sent. A regular has 3+ of our
 *  replies or 2+ ideas; `bits`: the running jokes we played with them, newest first. */
export function personOf(replies: (Doc & { at: Date })[], ideas: number): Person {
  const bits = [...new Set(replies.map((p) => p.joke).filter((j): j is string => !!j))].slice(0, 3);
  return {
    replies: replies.length, ...(replies[0]?.facts?.category ? { lastTopic: replies[0].facts.category } : {}), ...(replies[0] ? { lastAt: replies[0].at.toISOString() } : {}),
    ...(replies.length >= 3 || ideas >= 2 ? { regular: true } : {}), ...(ideas ? { ideas } : {}), ...(bits.length ? { bits } : {}),
  };
}

// ---------------------------------------------------------------- weekly voice audit

export const AuditOut = z.object({ patterns: z.array(z.string().min(1).max(60)).max(20) });
export const AUDIT = sys("x-audit", prompt("x-audit"));
/** Fewer posts than this in a week: nothing to audit. */
export const AUDIT_MIN_POSTS = 5;

/** Code's half of the audit: a pattern is banned only if it is a clean short phrase (src/voice.ts phraseIssue) with no
 *  fact term that really appears in at least 2 of the week's posts. */
export function auditPatterns(patterns: string[], week: string[]) {
  const posts = week.map((t) => ` ${shapeWords(t).join(" ")} `);
  const out: string[] = [];
  for (const raw of patterns) {
    const p = raw.normalize("NFKC").trim().toLowerCase();
    const w = shapeWords(p).join(" ");
    if (phraseIssue(p) || !w || out.includes(p) || w.split(" ").some((x) => FACT_TERMS.has(x))) continue;
    if (posts.filter((t) => t.includes(` ${w} `)).length >= 2) out.push(p);
  }
  return out;
}

/** voice:audit (weekly): a model other than the writer's reads the week's posts; the patterns that pass code become
 *  the writer's banned phrases (a signed `character` record, ref 'bans'). */
export const auditHandler: Handler = {
  lane: "x",
  run: async () => {
    const week = (await history(sql`and at > now() - interval '7 days'`, 200)).map((p) => p.draft ?? p.text);
    if (week.length < AUDIT_MIN_POSTS) return `${week.length} posts this week: nothing to audit`;
    const r = await llm({ agent: "x-audit", model: MODELS.audit, schema: AuditOut, maxOutputTokens: 1000, system: AUDIT, input: { posts: week } });
    const patterns = auditPatterns(r.data.patterns, week);
    await record("character", "bans", { patterns, dropped: r.data.patterns.length - patterns.length, posts: week.length, model: r.model, at: nowIso() });
    return { patterns };
  },
};
