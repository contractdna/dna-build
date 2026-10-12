// The social layer on X: the people who give ideas hear how their idea moves (a reply in our own thread, tagging them),
// the day's best idea gets a post crediting its author, the week's top idea-givers get a playful title, and a
// competitor or an important account that speaks up in a thread we are in gets a turn. Every text goes through the
// writer and the filters like any other post or reply; code appends every handle and link.
import { LOG_BASE_URL, X } from "./config.ts";
import { edb as sql } from "./db.ts";
import { Defer, type Handler } from "./jobs.ts";
import { trusted } from "./log.ts";
import { type QueueRow, queuedRow } from "./idea-queue.ts";
import type { XUser } from "./ideas.ts";
import { COMPETITOR_NAMES, impersonator, injection, isAlly, linksOut, phishing, replyPath, spamShape, summoned, tierOf } from "./tiers.ts";
import { classifyMention, questionOf, SCRIPTS } from "./voice.ts";
import { ideaShip } from "./sequencer.ts";
import { braked, enqueueX, LOOSE_ADDRESS, MENTION_FIELDS, type Mention, overCeiling, statusUrl, xApi } from "./x.ts";

const HANDLE = /^\w{1,15}$/;
/** A stored mention whose signature holds (the author's profile is part of it), else null. */
async function mentionOf(id: string) {
  const [m] = await sql<{ id: string; author_id: string | null; text: string; raw: Mention; sig: string | null }[]>`select id, author_id, text, raw, sig from x_mention where id = ${id}`;
  return m && (await trusted("x_mention", m.id, { author: m.author_id, text: m.text, raw: m.raw }, m.sig)) ? m : null;
}
const userOf = (m: { author_id: string | null; raw: Mention }): XUser | null => (m.raw.user ? { id: m.author_id ?? undefined, ...m.raw.user } : null);
const handleOf = (u: XUser | null) => (u?.username && HANDLE.test(u.username) ? u.username : null);
/** Our replies in a conversation (each joined through the mention it answers or tags: a first read, an idea update, a
 *  thread turn), newest first; `free`: no reply of ours under it yet (one reply per tweet: x_outbox_one_reply).
 *  `mention`: that mention counts as in the conversation even when its row has no conversation_id. */
const oursIn = (conv: string, mention = "") => sql<{ status: string; tweet_id: string | null; free: boolean }[]>`select o.status, o.tweet_id,
  not exists (select 1 from x_outbox u where u.reply_to = o.tweet_id) as free from x_outbox o join x_mention x on x.id = coalesce(o.event->>'mention', o.reply_to)
  where o.type = 'reply' and (x.raw->>'conversation_id' = ${conv} or x.id = ${mention}) order by o.updated_at desc`;
const PENDING = ["queued", "held", "attempt"];

// ---------------------------------------------------------------- an idea's progress, told to its author

/** A queue status → the step its author hears about (fee ideas: tested on-chain, kept or not). */
export const IDEA_STEPS: Record<string, string> = { queued: "picked", building: "building", testing: "testing", shipped: "shipped", reward: "shipped", killed: "killed", not_kept: "killed" };
const STEP_LINK = new Set(["building", "merged", "shipped"]);

/** Every X idea that moved in the last day: a reply under our latest free posted reply in its conversation (the first
 *  read, the last update, or a thread turn there), tagging its author. One per idea and step; it waits while a reply of
 *  ours there is not out yet, and an idea we never answered gets none (X takes replies only to posts that summoned
 *  us, or in our own thread). A shipped build says shipped only once it is live: a module, or a site change the site
 *  does not serve yet (sequencer.ts ideaShip), is told as merged. */
export const ideaUpdatesHandler: Handler = {
  lane: "x",
  run: async () => {
    const moved = await sql<{ id: string }[]>`select id from idea_queue where data->'source'->>'source' = 'x' and updated_at > now() - interval '1 day' order by updated_at desc limit 20`;
    const out: Record<string, string> = {};
    for (const { id } of moved) {
      if (await overCeiling()) { out[id] = "the reply ceilings"; break; }
      const r = await queuedRow(id);
      const step = r && IDEA_STEPS[r.status];
      if (!r || !step || r.data.source?.source !== "x") continue;
      out[id] = await ideaUpdate(r, step, r.data.source.postId);
    }
    return out;
  },
};
async function ideaUpdate(r: QueueRow, step: string, postId: string) {
  // a built idea's shipped means live: a module waits on the Safe, a site change on its public hour and then on the site
  // serving it (both: merged). A fee idea is shipped when its rule is kept (no build behind it)
  let ship: { target: string; vetoable: boolean } | undefined;
  if (step === "shipped" && r.kind === "build") {
    const s = await ideaShip(r.id);
    if (!s) return "waiting: no signed build for it";
    if (!s.live && s.target === "game") return "waiting: the game is not live yet";
    if (!s.live) { step = "merged"; ship = { target: s.target, vetoable: s.target === "site" }; }
  }
  const key = `idea_update:${r.id}:${step}`;
  if ((await sql`select 1 from x_outbox where event_key = ${key}`).length) return "told";
  const m = await mentionOf(postId);
  const handle = m && handleOf(userOf(m));
  if (!m || !handle) return "no signed mention with a handle";
  const chain = await oursIn(/^\d{1,20}$/.test(m.raw.conversation_id ?? "") ? m.raw.conversation_id! : postId, postId);
  if (chain.some((c) => PENDING.includes(c.status))) return "waiting: a reply of ours in that thread is not out yet";
  const last = chain.find((c) => c.status === "posted" && c.tweet_id && c.free);
  if (!last) return "no free posted reply of ours to thread under";
  // the first read went out after the idea was queued: it already said so
  if (step === "picked" && (await sql`select 1 from x_outbox where event_key = ${`reply:${postId}`} and status = 'posted' and updated_at > (select created_at from idea_queue where id = ${r.id})`).length) return "the first reply said it";
  const id = await enqueueX(key, "reply", { event: "idea_update", step, ...ship, ...(step === "picked" && r.data.rejudged ? { again: true } : {}), title: r.data.title, self: true, mention: postId, author: m.author_id, lead: `@${handle}`, tier: tierOf(userOf(m)) },
    { replyTo: last.tweet_id!, ...(STEP_LINK.has(step) ? { link: `${LOG_BASE_URL}/sequencer` } : {}) });
  return id ? step : "waiting: that reply of ours was just taken";
}

// ---------------------------------------------------------------- idea of the day, the weekly shoutout

/** A rubric total's ceiling (4 marks of 0..5, src/brain.ts Rubric). */
export const SCORE_OF = 20;
/** X ideas the queue took in since `since` (signed rows), with their author's signed mention. */
async function xIdeas(since: Date) {
  const rs = await sql<{ id: string }[]>`select id from idea_queue where data->'source'->>'source' = 'x' and created_at > ${since} order by score desc, created_at`;
  const out: { r: QueueRow; author: string; handle: string; postId: string }[] = [];
  for (const { id } of rs) {
    const r = await queuedRow(id);
    if (r?.data.source?.source !== "x") continue;
    const m = await mentionOf(r.data.source.postId);
    const handle = m && handleOf(userOf(m));
    if (m?.author_id && handle && !(await sql`select 1 from x_optout where author_id = ${m.author_id}`).length) out.push({ r, author: m.author_id, handle, postId: m.id });
  }
  return out;
}

/** Daily: the best idea the queue took from X in the last day (by its rubric score), never one featured before. The
 *  writer gets its title and score; code appends "idea by @handle" and the link to their post. */
export const ideaOfDayHandler: Handler = {
  lane: "x",
  run: async () => {
    const key = `idea_of_day:${new Date().toISOString().slice(0, 10)}`;
    if ((await sql`select 1 from x_outbox where event_key = ${key}`).length) return "posted today";
    const done = new Set((await sql<{ idea: string }[]>`select event->>'idea' as idea from x_outbox where event->>'event' = 'idea_of_day'`).map((x) => x.idea));
    const best = (await xIdeas(new Date(Date.now() - 86_400_000))).find((i) => !done.has(i.r.id));
    if (!best) return "no new idea from X today";
    await enqueueX(key, "post", { event: "idea_of_day", idea: best.r.id, kind: best.r.kind, title: best.r.data.title, score: best.r.score, scoreOf: SCORE_OF, append: `idea by @${best.handle}` }, { link: statusUrl(best.postId) });
    return { idea: best.r.id };
  },
};

/** The weekly shoutout's titles, best first. */
export const SHOUTOUT_TITLES = ["Chief Mutation Officer", "Head of Gene Splicing", "Senior Mutagen"];
/** The week's top idea-givers (the sum of their ideas' rubric scores, then how many): up to 3, each with a title. */
export function topGivers(ideas: { author: string; handle: string; r: { score: number } }[]) {
  const by = new Map<string, { handle: string; score: number; ideas: number }>();
  for (const i of ideas) {
    const g = by.get(i.author) ?? { handle: i.handle, score: 0, ideas: 0 };
    by.set(i.author, { ...g, score: g.score + i.r.score, ideas: g.ideas + 1 });
  }
  return [...by.values()].sort((a, b) => b.score - a.score || b.ideas - a.ideas).slice(0, SHOUTOUT_TITLES.length).map((g, k) => ({ ...g, title: SHOUTOUT_TITLES[k] }));
}
/** Weekly (Sundays 17:00 UTC, before the recap): the top idea-givers of the week, each with a playful title. */
export const shoutoutHandler: Handler = {
  lane: "x",
  run: async () => {
    const ideas = await xIdeas(new Date(Date.now() - 7 * 86_400_000));
    const top = topGivers(ideas);
    if (!top.length) return "no ideas from X this week";
    await enqueueX(`shoutout:${new Date().toISOString().slice(0, 10)}`, "post", { event: "shoutout", givers: top.length, ideas: ideas.length, append: top.map((g) => `${g.title}: @${g.handle}`).join("\n") });
    return { top: top.map((g) => g.handle) };
  },
};

// ---------------------------------------------------------------- thread presence

/** Our turns in one conversation for posts that did not summon us, and the conversations read per run. */
export const THREAD = { turns: 2, conversations: 10 };
type Found = Mention & { user?: XUser | null };
/** Every 30 min: the conversations we replied in during the last day are read (X search by conversation_id); a post
 *  there from a competitor or an important account that did not summon us (one that did is a mention, answered the
 *  usual way) gets a reply under our latest reply in that thread, tagging them. THREAD.turns per conversation, one per
 *  run; the hard lines (an impersonator, phishing, injection, slurs or harassment, opted out) get nothing. */
export const threadsHandler: Handler = {
  lane: "x",
  run: async () => {
    if (!X.userId) return "X_USER_ID unset";
    if (replyPath("competitor") === "off" && replyPath("important") === "off") return "AI replies are off until X approves them";
    const convs = await sql<{ conv: string; mention: string }[]>`select conv, mention from (select distinct on (x.raw->>'conversation_id') x.raw->>'conversation_id' as conv, x.id as mention, o.updated_at
      from x_outbox o join x_mention x on x.id = coalesce(o.event->>'mention', o.reply_to) where o.type = 'reply' and o.status = 'posted' and o.updated_at > now() - interval '1 day'
      and x.raw->>'conversation_id' ~ '^[0-9]{1,20}$' order by x.raw->>'conversation_id', o.updated_at desc) c order by updated_at desc limit ${THREAD.conversations}`;
    // X bills each post it returns: each conversation is read from the newest post seen last time (its since_id)
    const [st] = await sql<{ value: Record<string, string> }[]>`select value from state where key = 'x_threads'`;
    const seen: Record<string, string> = Object.fromEntries(convs.flatMap((c) => (st?.value[c.conv] ? [[c.conv, st.value[c.conv]]] : [])));
    const save = () => sql`insert into state (key, block, value) values ('x_threads', 0, ${sql.json(seen)}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
    const out: Record<string, string> = {};
    for (const c of convs) {
      if (await overCeiling()) { out[c.conv] = "the reply ceilings"; break; }
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from x_outbox where starts_with(event_key, 'thread:') and event->>'conv' = ${c.conv} and status <> 'skipped'`;
      if (n >= THREAD.turns) continue;
      // our latest posted tweet in this thread (a reply, an idea update, a turn) with no reply of ours under it yet
      const ours = (await oursIn(c.conv)).find((o) => o.status === "posted" && o.tweet_id && o.free);
      if (!ours) continue;
      const r = await xApi<{ data?: Found[]; includes?: { users?: (XUser & { id: string })[] }; meta?: { newest_id?: string } }>("GET", `/2/tweets/search/recent?${new URLSearchParams({ query: `conversation_id:${c.conv}`, max_results: "100", ...(seen[c.conv] ? { since_id: seen[c.conv] } : {}), ...MENTION_FIELDS })}`);
      if (r.status === 429) throw new Defer(15 * 60_000, "X rate limit (429)");
      if (r.status !== 200) { out[c.conv] = `X search ${r.status}`; continue; }
      const users = new Map((r.body.includes?.users ?? []).map((u) => [u.id, u]));
      const posts = (r.body.data ?? []).map((p) => ({ ...p, user: p.author_id ? users.get(p.author_id) ?? null : null })).reverse(); // oldest first
      out[c.conv] = (await threadTurn(c, posts, ours.tweet_id!)) ?? "nothing to answer";
      // simplification: posts after the one that got a turn, or past the anti-loop brake, are passed over (≤ 1 turn a
      // run, THREAD.turns a thread)
      if (r.body.meta?.newest_id) { seen[c.conv] = r.body.meta.newest_id; await save(); }
    }
    await save();
    return out;
  },
};
/** The first post in `posts` worth a turn, enqueued (its why), or null. */
async function threadTurn(c: { conv: string; mention: string }, posts: Found[], replyTo: string): Promise<string | null> {
  for (const p of posts) {
    const u = p.user ? { ...p.user, id: p.author_id } : null;
    const tier = tierOf(u);
    if (tier === "normal" || replyPath(tier) === "off" || !p.author_id || p.author_id === X.userId || summoned(p, X.userId)) continue;
    if ((await sql`select 1 from x_outbox where event_key = ${`thread:${p.id}`}`).length) continue;
    const handle = handleOf(u);
    const urls = p.entities ? (p.entities.urls ?? []).map((x) => x.expanded_url) : undefined;
    if (!handle || impersonator(u) || LOOSE_ADDRESS.test(p.text) || phishing(p.text, urls) || injection(p.text) || (!isAlly(p.author_id) && spamShape(p.text))) continue;
    if ((await sql`select 1 from x_optout where author_id = ${p.author_id}`).length || (await braked(p.author_id))) continue;
    const r = (await classifyMention(p.text)).data; // the quarantined reader; a Defer waits for the next run
    if (r.kind === "scam" || r.kind === "abuse") { // recorded, so the reader never sees it again
      await sql`insert into x_outbox (type, event_key, event, status, error) values ('reply', ${`thread:${p.id}`}, '{}', 'skipped', ${r.kind === "scam" ? "scam or phishing" : "slurs or harassment"}) on conflict do nothing`;
      continue;
    }
    const relationship = isAlly(p.author_id) ? "ally" : tier === "competitor" ? "competitor" : undefined;
    // bait (shilling, collab asks), a friendly word with a link off X, and an idea or a contract ask (a thread turn never
    // takes an idea in or gives the fixed line) get nothing: recorded like a hard line
    const linked = linksOut(p.text, urls);
    const none = relationship ? null : r.kind === "bait" ? (linked ? "bait with a link" : "bait") : r.kind === "thanks" && linked ? "bait with a link" : null;
    const skip = none ?? (["idea", "official_contract"].includes(r.kind) ? "an idea or a contract ask in a thread" : null);
    if (skip) {
      await sql`insert into x_outbox (type, event_key, event, status, error) values ('reply', ${`thread:${p.id}`}, '{}', 'skipped', ${skip}) on conflict do nothing`;
      continue;
    }
    const rival = relationship === "competitor" ? COMPETITOR_NAMES[p.author_id] : undefined;
    const kind = (r.kind === "bait" || r.kind === "thanks") && relationship ? "greeting" : r.kind;
    const lang = r.lang in SCRIPTS ? r.lang : undefined;
    const question = questionOf(r.question);
    const id = await enqueueX(`thread:${p.id}`, "reply", { event: "reply", category: kind, topic: kind === "thanks" ? "other" : r.topic, ...(question && kind !== "thanks" ? { question } : {}), tier, ...(relationship ? { relationship } : {}), ...(rival ? { rival } : {}),
      ...(lang ? { lang } : {}), self: true, mention: c.mention, conv: c.conv, author: p.author_id, lead: `@${handle}` }, { replyTo });
    if (id) return `${tier} @${handle}: ${kind}`;
  }
  return null;
}
