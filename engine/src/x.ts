// X API v2 over fetch (OAuth 2.0 user context, docs.x.com) and the posting pipeline:
//  - token refresh: POST /2/oauth2/token, grant_type=refresh_token (confidential clients send Basic auth). Access tokens
//    last 2 h. Every rotated refresh_token is SEALED (src/sealed.ts, purpose 'x-token') before it reaches `secret`, with
//    the sha256 of the X_REFRESH_TOKEN seed it descends from: a new seed (an operator re-auth) wins over the stored chain.
//  - mentions: stored only (UNTRUSTED), polled every minute. The quarantined reader is the only model that sees the
//    text; the writer gets its category. A reply goes only to a post that @mentioned or quoted us (src/tiers.ts
//    summoned, checked again right before the API call); threads continue post by post per the author's tier, until a
//    stop rule fires. Until X approves AI replies (or with X_HOLD_IMPORTANT=1), an important account's reply waits for a
//    signer's Send tap; approved, every eligible author's reply goes out on its own.
//  - media (scope media.write): an image is one multipart upload, a video is chunked (initialize, append, finalize,
//    then STATUS polls while processing). Media ids expire (24 h): every post uploads its media again.
// Pipeline: chain events and closed experiments → x_outbox (one row per event key; one reply per mention id) →
// x:send (one item per run: posts ≥ X_POST_SPACING_MIN apart and ≤ X_DAILY_POSTS a UTC day, the launch window's
// X_LAUNCH_* in the first X_LAUNCH_WINDOW_H after LLM_LAUNCH_AT; replies ≤ X_DAILY_REPLIES)
// → fact sheet → writer (no tools) → filter → pick → code appends the tx link → post. At-most-once: an `attempt` record
// precedes the POST; a 5xx or a network error after it leaves the item "attempted" (never retried) and alerts.
// Telegram /mute drops the queue and stops posting until /unmute. Not live: dry_run writes and filters, never posts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Address, type Hex } from "viem";
import { d, IDEAS_LIVE, LLM, LOG_BASE_URL, MEDIA, X } from "./config.ts";
import { edb as sql } from "./db.ts";
import { Defer, type Handler } from "./jobs.ts";
import { decodeOp, OPS } from "./lib.ts";
import { append, type EnclaveRow, isRolledBack, stateSig, trusted, trustedRecord } from "./log.ts";
import { mode } from "./mode.ts";
import type { Vector } from "./policy.ts";
import { latest, nowIso, record, trustedDocs } from "./records.ts";
import { ENCLAVE } from "./enclave.ts";
import { PERSONA } from "./persona.ts";
import { bundleHits } from "./anonymity.ts";
import { seal, unseal } from "./sealed.ts";
import { alert, type ReplyButton, say } from "./telegram.ts";
import { addressOf, pub } from "./tx.ts";
import { hookAbi } from "./abi.ts";
import { allyIssues, appendWeight, type Category, claimFacts, claimIssues, classifyMention, factNumbers, factSheet, feeFacts, linkIssues, OFFICIAL_REPLY, optOutRequest, postFilter, promiseIssue, SCOUT, screenLine, SCRIPTS, TRANSLATE, Translated, nonAscii, scoutTone, toneBrief, TX_URL, weightedLength, WRITER, type CharacterContext, chooseShapes, draftInCharacter, type Drafted, judgeCall, type JudgeOut, parrotIssue, pickBest, shapesFor, voiceIssues } from "./voice.ts";
import { llm, untrustedCall } from "./llm.ts";
import { ballotsOpen, GAME_X_EVENTS, gameFacts, reasonOf, VOTES_CLOSED } from "./games.ts";
import { announce, ANNOUNCEMENTS_URL, bucketOf, eventPosts, postCaps, priorityOf, proofOf, typeOf } from "./announce.ts";
import { GATE, IDEA_STATUSES, overlap, type XUser } from "./ideas.ts";
import { COMPETITOR_NAMES, impersonator, isAlly, phishing, type Post, replyPath, stopRule, summoned, type Tier, tierOf, TIERS } from "./tiers.ts";
import { BINDING_REPLY, parseBinding } from "./rewards.ts";
import { type Card, cardFor, mediaRecord, requestArtFor } from "./card.ts";
import { jsonSafe } from "./lib.ts";
import { dayOfLife, mindNow, pendingNow, storyNow } from "./life.ts";
import { GUARD_ABI, hasLaunchGuard, mechanicsFor, type Topic } from "./mechanics.ts";
import { flatTake, intentOf, MIND_EVENTS, oldTokenTalk, questionOf, writerSystem } from "./voice.ts";

export { weightedLength };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hour = () => new Date().toISOString().slice(0, 13);

/** Refuses a text that shares an 8-word run with the private bundle (an echo of the persona or a prompt): checked on
 *  every draft before any record or post. `shingles`: the loaded bundle's, built once at load (src/persona.ts). */
export const bundleIssues = (text: string, shingles = PERSONA.shingles) => (bundleHits(text, shingles).length ? ["bundle text"] : []);
/** The record's candidates (the log is public, /api/log): a refused draft is kept only as its sha256 and its reasons,
 *  since a refusal may be the very text that must never publish; a draft that passed every check stays as written. */
export const publicCandidates = (cands: Drafted["candidates"]) => cands.map((c) => (c.issues.length ? { sha256: sha(c.text), issues: c.issues } : c));

// ---------------------------------------------------------------- auth

let access: { token: string; until: number } | undefined;
let refreshing: Promise<string> | undefined;

/** Access token; concurrent callers share one refresh (a second refresh would spend the single-use refresh token). */
export async function token() {
  if (access && Date.now() < access.until) return access.token;
  return (refreshing ??= refresh().finally(() => { refreshing = undefined; }));
}
export const resetToken = () => { access = undefined; };
/** An access token obtained elsewhere (scripts/live-x.ts refreshes and hands the rotated token to its operator). */
export const useAccessToken = (token: string, ttlS = 3600) => { access = { token, until: Date.now() + ttlS * 1000 }; };

/** The refresh token to use: the stored (sealed, rotated) one while it descends from the current seed, else the seed. */
export async function refreshTokenOf(stored: string | undefined, seed = X.refreshToken) {
  const seedSha = seed ? sha(seed) : null;
  const open = stored ? await unseal("x-token", stored) : null;
  const s = open ? (JSON.parse(open) as { token: string; seed: string | null }) : null;
  if (s && (s.seed === seedSha || !seed)) return { token: s.token, seed: s.seed };
  return seed ? { token: seed, seed: seedSha } : null;
}

/** POST /2/oauth2/token with a refresh token (confidential client: Basic auth) → the access token, the ROTATED refresh
 *  token (the one sent is spent), its lifetime, the granted scopes. Throws with `status` (never the body: it may hold tokens). */
export async function exchangeRefreshToken(refreshToken: string, clientId = X.clientId, clientSecret = X.clientSecret) {
  if (!clientId) throw new Error("X_CLIENT_ID unset");
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  else form.set("client_id", clientId);
  const res = await fetch(`${X.api}/2/oauth2/token`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!res.ok || !body.access_token) throw Object.assign(new Error(`X token refresh ${res.status}`), { status: res.status });
  return body as typeof body & { access_token: string };
}

async function refresh() {
  if (!X.clientId) throw new Error("X_CLIENT_ID unset");
  const [stored] = await sql<{ value: string }[]>`select value from secret where key = 'x_refresh_token'`;
  const cur = await refreshTokenOf(stored?.value);
  if (!cur) throw new Error("no X refresh token (X_REFRESH_TOKEN seeds it)");
  // the refresh token is single-use: never spend it unless the rotated one can be sealed and stored afterwards
  await seal("x-token", "probe");
  let body: Awaited<ReturnType<typeof exchangeRefreshToken>>;
  try {
    body = await exchangeRefreshToken(cur.token);
  } catch (e) {
    // 400/401 = revoked or spent: only a human re-auth fixes it
    const st = (e as { status?: number }).status;
    if (st === 400 || st === 401) await alert(`X token refresh ${st}: the token is revoked or spent. Re-auth: the operator runs OAuth PKCE and sets a new X_REFRESH_TOKEN (sealed env).`, `alert:xauth:${hour()}`);
    throw e;
  }
  if (body.refresh_token) {
    const value = await seal("x-token", JSON.stringify({ token: body.refresh_token, seed: cur.seed }));
    await sql`insert into secret (key, value) values ('x_refresh_token', ${value})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }
  access = { token: body.access_token, until: Date.now() + ((body.expires_in ?? 7200) - 300) * 1000 };
  return access.token;
}

async function x<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${X.api}${path}`, {
    method, headers: { authorization: `Bearer ${await token()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) access = undefined;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T, headers: res.headers };
}
/** The authed X call the pipeline uses (scripts/live-x.ts). */
export const xApi = x;

// ---------------------------------------------------------------- media upload (never cached: ids expire)

const SEGMENT = 5 * 1024 * 1024;
/** Test seam: how long to wait between status polls (X says check_after_secs). */
export const MEDIA_WAIT = { sleep: (s: number) => new Promise((r) => setTimeout(r, s * 1000)), maxPolls: 20 };
async function xForm<T = unknown>(path: string, form: FormData): Promise<{ status: number; body: T }> {
  const res = await fetch(`${X.api}${path}`, { method: "POST", headers: { authorization: `Bearer ${await token()}` }, body: form, signal: AbortSignal.timeout(120_000) });
  if (res.status === 401) access = undefined;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
/** One image (≤ 5 MB) → a fresh media id: multipart/form-data (media binary, media_category, media_type). The type is
 *  read from the bytes (a studio draft is JPEG, a composed card PNG). */
export async function uploadImage(img: Buffer) {
  const jpeg = img[0] === 0xff && img[1] === 0xd8 && img[2] === 0xff;
  const type = jpeg ? "image/jpeg" : "image/png";
  const form = new FormData();
  form.set("media_category", "tweet_image");
  form.set("media_type", type);
  form.set("media", new Blob([new Uint8Array(img)], { type }), jpeg ? "card.jpg" : "card.png");
  const r = await xForm<{ data?: { id: string } }>("/2/media/upload", form);
  if (r.status >= 300 || !r.body.data?.id) throw new Error(`X media upload ${r.status}`);
  return r.body.data.id;
}
/** A video, chunked (5 MB segments), finalized, polled until X has processed it → a fresh media id. */
export async function uploadVideo(buf: Buffer) {
  const init = await x<{ data?: { id: string } }>("POST", "/2/media/upload/initialize", { media_type: "video/mp4", total_bytes: buf.length, media_category: "tweet_video" });
  const id = init.body.data?.id;
  if (init.status >= 300 || !id) throw new Error(`X media initialize ${init.status}`);
  for (let i = 0; i * SEGMENT < buf.length; i++) {
    const form = new FormData();
    form.set("segment_index", String(i));
    form.set("media", new Blob([new Uint8Array(buf.subarray(i * SEGMENT, (i + 1) * SEGMENT))], { type: "application/octet-stream" }), "segment");
    const { status: st } = await xForm(`/2/media/upload/${id}/append`, form);
    if (st >= 300) throw new Error(`X media append ${i}: ${st}`);
  }
  type Info = { data?: { processing_info?: { state: string; check_after_secs?: number; error?: { message?: string } } } };
  let r = await x<Info>("POST", `/2/media/upload/${id}/finalize`);
  if (r.status >= 300) throw new Error(`X media finalize ${r.status}`);
  for (let n = 0; ; n++) {
    const info = r.body.data?.processing_info;
    if (!info || info.state === "succeeded") return id;
    if (info.state === "failed") throw new Error(`X media processing failed: ${info.error?.message ?? ""}`.slice(0, 200));
    if (n >= MEDIA_WAIT.maxPolls) throw new Error("X media still processing");
    await MEDIA_WAIT.sleep(Math.min(info.check_after_secs ?? 1, 10));
    r = await x<Info>("GET", `/2/media/upload?command=STATUS&media_id=${id}`);
    if (r.status >= 300) throw new Error(`X media status ${r.status}`);
  }
}
/** Upload a card's media; null on failure (the post goes out text-only, the error in its record). */
async function uploadCard(c: Card | null): Promise<{ id: string | null; error?: string }> {
  if (!c || c.kind === "none") return { id: null };
  try {
    return { id: c.kind === "video" ? await uploadVideo(c.buf) : await uploadImage(c.png) };
  } catch (e) {
    return { id: null, error: (e as Error).message.slice(0, 300) };
  }
}

/** A human draft's media: a file pinned in the image's media/ dir (the logo MP4, a plate), never an arbitrary path. */
export function draftMedia(name: unknown): Card | null {
  if (name === undefined || name === null) return null;
  if (typeof name !== "string" || !/^[\w.-]+(\/[\w.-]+)?$/.test(name) || name.includes("..")) throw Object.assign(new Error(`media ${String(name)}: not a file in media/`), { final: true });
  const buf = readFileSync(new URL(name, MEDIA.dir));
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (name.endsWith(".mp4")) return { kind: "video", buf, sha256, source: "logo" };
  return { kind: "image", png: buf, sha256, source: "plate", plate: name, layer: { badge: "", headline: "", figures: [] } };
}

// ---------------------------------------------------------------- mentions (stored, untrusted)

type Ref = { type: string; id: string };
export type Mention = { id: string; text: string; author_id?: string; created_at?: string; referenced_tweets?: Ref[]; conversation_id?: string; user?: XUser | null;
  entities?: { mentions?: { id?: string | null; username?: string | null }[]; urls?: { expanded_url?: string }[] } };
type Mentions = { data?: Mention[]; includes?: { users?: (XUser & { id: string; username: string })[] }; meta?: { newest_id?: string } };

/** Mentions (or quotes) as X returned them, each stored once. Signed in the enclave: a mention row the DB made up (to
 *  steer a reply at any tweet id) is never answered; the author's profile is part of it (a DB can't hand a gate-failing
 *  author a badge). */
async function storeMentions(b: Mentions) {
  const users = new Map((b.includes?.users ?? []).map((u) => [u.id, u]));
  for (const m of b.data ?? []) {
    const u = m.author_id ? users.get(m.author_id) : undefined;
    const raw = JSON.parse(JSON.stringify({ ...m, user: u ?? null })) as Mention;
    await sql`insert into x_mention (id, author_id, author_username, text, created_at, raw, sig)
      values (${m.id}, ${m.author_id ?? null}, ${u?.username ?? null}, ${m.text}, ${m.created_at ?? null}, ${sql.json(raw as never)}, ${await stateSig("x_mention", m.id, { author: m.author_id ?? null, text: m.text, raw })})
      on conflict (id) do nothing`;
  }
}
export const MENTION_FIELDS = { expansions: "author_id", "user.fields": "username,created_at,public_metrics,verified,verified_type", "tweet.fields": "created_at,referenced_tweets,conversation_id,entities" };
/** Quotes of our own posts of the last 2 days that do not @mention us (X's mentions list misses them): stored like
 *  mentions, so an idea posted as a quote goes through the same gate and screen (and the same reply rules: a quote of
 *  our post summons us, isSummoned). One call per post, hourly, in live idea mode. */
export const quotesHandler: Handler = {
  lane: "x",
  run: async () => {
    if (!X.userId) return "X_USER_ID unset";
    const ours = await sql<{ id: string }[]>`select distinct doc->>'tweetId' as id from log where kind = 'x_post' and doc->>'status' = 'posted'
      and at >= now() - interval '2 days' and doc->>'tweetId' ~ '^[0-9]{1,20}$' order by 1 desc limit 40`;
    let n = 0;
    for (const p of ours) {
      const r = await x<Mentions>("GET", `/2/tweets/${p.id}/quote_tweets?${new URLSearchParams({ max_results: "100", ...MENTION_FIELDS })}`);
      if (r.status !== 200) throw new Error(`X quotes of ${p.id}: ${r.status}`);
      await storeMentions(r.body);
      n += r.body.data?.length ?? 0;
    }
    return `${n} quotes of ${ours.length} posts`;
  },
};

export const mentionsHandler: Handler = {
  lane: "x",
  run: async () => {
    if (!X.userId) return "X_USER_ID unset";
    const [s] = await sql<{ value: { sinceId?: string } }[]>`select value from state where key = 'engine_x'`;
    // the author's profile feeds the idea and binding gates (src/ideas.ts ideaGate, authorIssue) and the reply tiers (src/tiers.ts tierOf)
    const q = new URLSearchParams({ max_results: "100", ...MENTION_FIELDS });
    if (s?.value.sinceId) q.set("since_id", s.value.sinceId);
    // simplification: one page per poll (≤ 100 mentions a minute); follow meta.next_token if the bot gets busier
    const r = await x<Mentions>("GET", `/2/users/${X.userId}/mentions?${q}`);
    if (r.status !== 200) throw new Error(`X mentions ${r.status}`);
    await storeMentions(r.body);
    if (r.body.meta?.newest_id) {
      await sql`insert into state (key, block, value) values ('engine_x', 0, ${sql.json({ sinceId: r.body.meta.newest_id })})
        on conflict (key) do update set value = excluded.value, updated_at = now()`;
    }
    return `${r.body.data?.length ?? 0} mentions`;
  },
};

// ---------------------------------------------------------------- human-approved drafts (Telegram)

/** Pure: why a human-approved draft can't be posted ([] = ok). Drafts are exact human text: no number rule. */
export function postIssues(text: string): string[] {
  const issues = [...linkIssues(text.normalize("NFKC")), ...bundleIssues(text)];
  if (!text.trim()) issues.push("empty");
  if (weightedLength(text) > 280) issues.push("over 280 weighted chars");
  return issues;
}

/** Posts (drafts + pipeline) and replies attempted today (UTC), and when the last post went out. dry_run counts too,
 *  so a dry run paces exactly like live. */
export async function usedToday() {
  // the spacing is measured on the DB's clock (the records' `at` is the DB's now()), never against Node's
  const [r] = await sql<{ post: number; reply: number; since: number | null }[]>`select
    count(*) filter (where coalesce(doc->>'type', 'post') = 'post')::int as post,
    count(*) filter (where doc->>'type' = 'reply')::int as reply,
    (extract(epoch from now() - max(at) filter (where coalesce(doc->>'type', 'post') = 'post')) * 1000)::float8 as since
    from log where kind = 'x_post' and doc->>'status' in ('attempt', 'dry_run') and at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`;
  return { post: r.post, reply: r.reply, sinceLastMs: r.since ?? Infinity };
}

/** Draft handler for kind 'x_post' (a one-off human-approved post, e.g. the pinned "only account" notice). At-most-
 *  once: an `attempt` record is written before the POST; a retry that finds one stops and asks a human. */
export async function postDraft(payload: Record<string, unknown>, draftId: string) {
  const text = String(payload.text);
  const fail = (msg: string) => Object.assign(new Error(msg), { final: true });
  const issues = postIssues(text);
  if (issues.length) throw fail(`not postable: ${issues.join(", ")}`);
  const card = draftMedia(payload.media);
  const m = await mode();
  if (m !== "live") {
    await append("x_post", draftId, { draftId, text, mode: m, status: "skipped" });
    return { skipped: m };
  }
  if (await muted()) throw fail("X posting is muted (/unmute first)");
  const cap = postCaps().daily;
  if ((await usedToday()).post >= cap) throw fail(`daily post cap ${cap} reached`);
  const [prior] = await sql`select 1 from log where kind = 'x_post' and ref = ${draftId} and doc->>'status' = 'attempt'`;
  if (prior) throw fail(`draft ${draftId} was already attempted: check X before re-drafting`);
  await append("x_post", draftId, { draftId, text, mode: m, type: "post", status: "attempt", media: mediaRecord(card) });
  const up = await uploadCard(card);
  const stop = await stopped();
  if (stop) {
    await append("x_post", draftId, { draftId, status: "dropped", why: stop });
    throw fail(`not posted: ${stop} while it was being sent`);
  }
  const r = await x<{ data?: { id: string } }>("POST", "/2/tweets", { text, ...(up.id ? { media: { media_ids: [up.id] } } : {}) });
  if (r.status !== 201 || !r.body.data?.id) throw fail(`X post ${r.status}`);
  await append("x_post", draftId, { draftId, tweetId: r.body.data.id, status: "posted", mediaId: up.id, mediaError: up.error ?? null });
  return { tweetId: r.body.data.id };
}

// ---------------------------------------------------------------- mute (Telegram kill switch)

/** Muted? Enclave: the newest verified 'mode' x_mute record decides (none = muted: fail closed, the DB can only
 *  silence the account; a fresh enclave posts after a signer's /unmute). Plain build: the state row. */
export async function muted() {
  if (ENCLAVE.on) return (await trustedDocs<{ muted: boolean }>("mode", "x_mute").catch((e) => (isRolledBack(e) ? [{ muted: true }] : Promise.reject(e))))[0]?.muted ?? true;
  const [r] = await sql<{ value: { muted: boolean } }[]>`select value from state where key = 'x_mute'`;
  return !!r?.value.muted;
}
/** Why nothing may go to X right now (null = it may): the engine is not live, or posting is muted. Checked once more
 *  right before every POST, so a /mute or /halt that lands while a post is being written or uploaded drops it. */
export async function stopped(): Promise<string | null> {
  const m = await mode();
  if (m !== "live") return m;
  return (await muted()) ? "muted" : null;
}
export async function setMuted(on: boolean, by: string) {
  const value = { muted: on, by };
  await sql.begin(async (tx) => {
    await tx`insert into state (key, block, value) values ('x_mute', 0, ${tx.json(value)})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
    await append("mode", "x_mute", { muted: on, by }, tx);
    if (on) await tx`update x_outbox set status = 'skipped', error = 'muted', updated_at = now() where status in ('queued', 'held')`;
  });
}

// ---------------------------------------------------------------- delete (Telegram brake)

/** Telegram `/delete <tweet id>` (an allowlisted signer). A brake like /mute: it removes one of this account's own
 *  posts (a tweet id in a signed `posted` record) and can do nothing else. It never posts, an id the log doesn't name as
 *  ours never reaches X, and it works in every mode. A signed record says who deleted what. Returns the reply text. */
export async function deletePost(id: string | undefined, by: string) {
  if (!id || !/^\d{1,20}$/.test(id)) return "usage: /delete <tweet id> (one of this account's own posts)";
  const rows = await sql<(EnclaveRow & { doc: { status: string } })[]>`select doc, kind, ref, body, eprev, ehash, esig from log
    where kind = 'x_post' and doc->>'tweetId' = ${id} and doc->>'status' in ('posted', 'deleted') order by log.seq desc`;
  const ours: (EnclaveRow & { doc: { status: string } })[] = [];
  for (const r of rows) if (await trustedRecord(r, "x_post record")) ours.push(r);
  const posted = ours.find((r) => r.doc.status === "posted");
  if (!posted?.ref) return `not one of our posts: ${id}`;
  if (ours.some((r) => r.doc.status === "deleted")) return `post ${id} was already deleted`;
  let r: { status: number; body: { data?: { deleted?: boolean } } };
  try {
    r = await x("DELETE", `/2/tweets/${id}`);
  } catch (e) {
    return `X delete failed: ${(e as Error).message.slice(0, 200)}`;
  }
  if (r.status !== 200 || !r.body.data?.deleted) return `X refused to delete ${id}: ${r.status}`;
  await append("x_post", posted.ref, { status: "deleted", tweetId: id, by });
  return `deleted post ${id}`;
}

/** Why the idea gate held an idea back, and what the person can do, in plain words (code's, by the gate's reason). */
const GATE_SAYS: [RegExp, string, string][] = [
  [/^links are not allowed/, "ideas can't include links", "post it again with the idea written out and no link"],
  [/^already \d+ idea from this author the same UTC day/, "it's one idea per person per day (UTC), and they had already sent one that day", "post it again on another day (UTC)"],
  [/^already \d+ idea from this author this round/, "it's one idea per person per round, and they already sent one this round", "post it again in the next round"],
  [/^no author profile/, "X didn't send their profile with the post", "post it again"],
];
/** What a reply to an idea may say about it, in plain parts (code's words, the judge's plain sentences screened):
 *  `understood` (what we took the idea to be), `verdict` (in, a buildable version, out, held back, being judged, logged),
 *  `why` (the reason in one plain sentence), `next` (what happens now) and `instead` (the version that is built). */
export async function intakeFact(mention: string): Promise<Record<string, unknown>> {
  const [r] = await sql<IntakeIndex[]>`select status, score, reason, title from intake where mention_id = ${mention}`;
  if (!r) return {};
  // the quick first read (the screen's class and score) and the judge's plain words, from the newest intake record
  // simplification: read unsigned, like the class always was; every model-written line is screened (screenLine)
  const [c] = await sql<IntakeWords[]>`select
    (select doc->>'class' from log where kind = 'intake' and ref = ${mention} and doc ? 'class' order by seq desc limit 1) as cls,
    doc->>'understood' as understood, doc->>'plain' as plain, doc->>'instead' as instead from log where kind = 'intake' and ref = ${mention} order by seq desc limit 1`;
  return intakeFactOf(r, c, IDEAS_LIVE);
}
type IntakeIndex = { status: string; score: number | null; reason: string | null; title: string | null };
type IntakeWords = { cls: string | null; understood: string | null; plain: string | null; instead: string | null };
/** intakeFact's facts from the intake index row `r` and the newest intake record's words `c` (no DB: the replay uses it). */
export function intakeFactOf(r: IntakeIndex, c: IntakeWords | undefined, live: boolean): Record<string, unknown> {
  const read = { ...(r.score !== null ? { ideaScore: r.score, ideaScoreOf: 30 } : {}), ...(c?.cls === "fee" || c?.cls === "build" ? { ideaClass: c.cls } : {}) };
  const understood = screenLine(c?.understood ?? r.title ?? undefined, 200);
  const base = { ...(understood ? { understood } : {}), ...read };
  const repeat = r.status === "duplicate" || /near-duplicate/.test(r.reason ?? "");
  if (repeat) return { intake: "their idea repeats one someone already sent this week, which is judged on its own", verdict: "a repeat", why: "the same idea was already sent this week", next: "nothing to do: the earlier one is judged on its own", ...base };
  if (r.status === "gated") {
    const g = GATE_SAYS.find(([re]) => re.test(r.reason ?? ""));
    return { intake: `the idea gate held it back: ${r.reason ?? "see the site"}`, verdict: "held back", why: g?.[1] ?? screenLine(r.reason ?? undefined, 120) ?? "the idea gate held it back", next: g?.[2] ?? "the reason is on the site", ...base };
  }
  if (r.status === "screened") return { intake: `the screen did not read it as an idea (${(r.reason ?? "").slice(0, 120)})`, verdict: "not read as an idea", why: "it didn't read as an idea to build", next: "to send an idea, say what should change or be built, in plain words" };
  if (!live) return ["candidate", "picked"].includes(r.status) ? { intake: "their idea is logged for the open round; when it closes the top ideas go on-chain to be staked on", verdict: "logged", next: "when the round closes, the top ideas go on-chain to be staked on", ...base } : base;
  // the judge's plain reason (model-written: screened, left out when it does not pass)
  const why = screenLine(c?.plain ?? undefined, 200);
  // a variant was queued (its record names it); its title is said only when it passes the screen (no digits)
  const variant = r.status === "queued" && !!c?.instead;
  const instead = variant ? screenLine(c?.instead ?? undefined, 120) : undefined;
  const say: Record<string, Record<string, string>> = {
    candidate: { intake: "their idea passed the screen and is being judged now; the verdict goes on the site within minutes", verdict: "being judged", next: "the verdict goes on the site within minutes" },
    queued: variant
      ? { intake: "their idea can't be built as written; its closest buildable version is queued for the sequencer, credited to them", verdict: "a buildable version", ...(instead ? { instead } : {}), next: "the sequencer builds the best queued idea when it's free; they get the credit and are tagged as it moves" }
      : { intake: "their idea was judged and accepted: it is queued for the sequencer", verdict: "in", next: "the sequencer builds the best queued idea when it's free; they are tagged as it moves" },
    rejected: { intake: "their idea was judged and not taken", verdict: "out", next: "the full reason is on the site; a new idea is welcome tomorrow (UTC)" },
  };
  return say[r.status] ? { ...say[r.status], ...(why ? { why } : {}), ...base } : base;
}

// ---------------------------------------------------------------- the outbox

type Kind = "post" | "reply";
/** One row per event key (a chain log, a closed experiment, a mention): a replayed watcher range never posts twice. */
export async function enqueueX(eventKey: string, type: Kind, event: Record<string, unknown>, o: { replyTo?: string; link?: string } = {}) {
  const ev = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
  const sig = await stateSig("x_outbox", eventKey, outboxValue(type, ev, o.replyTo ?? null, o.link ?? null));
  const [r] = await sql<{ id: string }[]>`insert into x_outbox (type, event_key, event, reply_to, link, sig)
    values (${type}, ${eventKey}, ${sql.json(ev as never)}, ${o.replyTo ?? null}, ${o.link ?? null}, ${sig}) on conflict do nothing returning id::text`;
  return r?.id;
}
/** What an outbox row's signature covers (enclave): a row the DB made up never reaches the writer. */
const outboxValue = (type: string, event: unknown, replyTo: string | null, link: string | null) => ({ type, event, replyTo, link });

type RunRow = { id: string; data: { id: string; label: string; vector: Vector; active?: string }; sig: string | null };
const runOfOp = async (id: string) => {
  const [r] = await sql<RunRow[]>`select id, data, sig from thread where kind = 'fee' and (data->'allOps' ? ${id} or data->'ops' ? ${id}) order by created_at desc limit 1`;
  return r && (await trusted("thread", r.id, r.data, r.sig)) ? r.data : undefined;
};

type ChainEv = { eventName: string; args: Record<string, unknown>; transactionHash: Hex; logIndex?: number | null };
/** Watcher hook (head): the agent's own queued ops, tests going live, Safe vetoes of agent ops, rollbacks. */
export async function onChainEvent(e: ChainEv) {
  const key = `${e.eventName}:${e.transactionHash}:${e.logIndex ?? 0}`;
  const link = `${TX_URL}${e.transactionHash}`;
  const a = e.args;
  // the Safe's changes, its cancels of game steps, a draw interval proposal, a pause (src/upgrades.ts)
  if (await (await import("./upgrades.ts")).onOwnerChange(e)) return;
  switch (e.eventName) {
    case "Queued":
      if (String(a.proposer).toLowerCase() !== addressOf("agent")?.toLowerCase()) return;
      return publish(key, { event: "queued", opId: String(a.id), op: Number(a.op), data: a.data, eta: String(a.eta), proposer: a.proposer }, link);
    case "Executed":
      if (Number(a.op) !== 1 && Number(a.op) !== 2) return; // SetShadow / SetCanary: a test goes live
      return publish(key, { event: "test_live", opId: String(a.id), op: Number(a.op) }, link);
    case "Cancelled":
      return publish(key, { event: "cancelled", opId: String(a.id) }, link);
    case "RolledBack":
      return publish(key, { event: "rolled_back", route: Number(a.kind) === 0 ? "fee" : "split" }, link);
    // module code the Safe approved by hash: it can be registered (level 10) and tested; nothing goes live by this
    case "CodehashApproved":
      return publish(key, { event: "module_approved", codehash: String(a.codehash), kind: Number(a.kind) === 0 ? "fee" : "split" }, link);
  }
  // the game layer and the idea market: ballots, jackpot draws / claims / expiries, idea rewards, mysteries, idea rounds
  if (GAME_X_EVENTS.has(e.eventName)) return publish(key, { event: "game", name: e.eventName, args: jsonSafe(a) as Record<string, unknown> }, link);
}

/** An event the public should see: on the site at once (an `announce` record, src/announce.ts), on X by priority. */
async function publish(key: string, ev: Record<string, unknown>, link: string) {
  const id = await enqueueX(key, "post", ev, { link });
  const raw = await announceEvent(key, ev, link);
  if (id && raw) await requestArtFor(key, factSheet(raw)); // the studio starts now, not when the post is due
  return id;
}
/** An engine event that is not a chain log (the jackpot's params): published the same way. */
export const publishEvent = publish;
/** Resolve an outbox event now and record it for the site (best effort: one that can't be resolved yet is recorded
 *  when it is sent or rolled into the digest). */
async function announceEvent(key: string, ev: Record<string, unknown>, link: string | null) {
  try {
    const raw = await resolve(ev);
    if (raw) await announce(key, raw, { raw: ev, tx: link, proof: proofOf(raw.append) });
    return raw;
  } catch (err) {
    console.error(`announce ${key}:`, (err as Error).message);
    return null;
  }
}

/** A closed experiment that ran on-chain (loop.ts): kept / killed / rolled back, with the sample size, the reason (a
 *  fixed phrase), where it came from (a ballot, a mystery) and the tx of its last executed op when indexed. */
export async function enqueueOutcome(run: { id: string; label: string; vector: Vector; outcome?: string; reason?: string; source?: string; allOps?: string[]; ops?: string[] }, samples: number) {
  const ops = run.allOps ?? run.ops ?? [];
  const [ex] = ops.length ? await sql<{ tx: string }[]>`select tx from chain_log where event = 'Executed' and args->>'id' = any(${ops}) order by block desc, log_index desc limit 1` : [];
  const ev = { event: "outcome", outcome: run.outcome === "accepted" ? "kept (promoted)" : run.outcome === "rolled_back" ? "rolled back" : "killed", plate: run.label, fee: feeFacts(run.vector), samples,
    reason: run.outcome === "accepted" ? "promoted to the live fee" : reasonOf(run.reason ?? ""), source: run.source ?? (await aiPick()) };
  return publish(`outcome:${run.id}`, ev, ex ? `${TX_URL}${ex.tx}` : `${LOG_BASE_URL}/lab/experiments`);
}

/** The nightly reflection (after the day's journal, 00:05 UTC, once a day): what it learned and what comes next, from
 *  the journal's own lines (src/voice.ts factSheet screens them; the next step said only as the journal or the brain has
 *  it), linking the journal. */
export const enqueueReflection = (date: string, j: { learned: string; tomorrow: string }) =>
  publish(`reflection:${date}`, { event: "reflection", date, learned: j.learned, tomorrow: j.tomorrow }, `${LOG_BASE_URL}/journal`);

/** The AI's own experiments while holders can't vote yet (< 1% staked, from the indexer's snapshot). */
async function aiPick() {
  const [c] = await sql<{ locked: string | null; supply: string | null }[]>`select value->'game'->'vault'->>'totalLocked' as locked, value->>'totalSupply' as supply from state where key = 'chain'`;
  return c?.locked != null && c.supply != null && !ballotsOpen(BigInt(c.locked), BigInt(c.supply)) ? VOTES_CLOSED : undefined;
}

const utc = (s: bigint) => { const d = new Date(Number(s) * 1000); return { utcHour: d.getUTCHours(), utcMinute: d.getUTCMinutes() }; };

/** Raw outbox event → the raw fact input (resolved at send time: the run saves its op ids after the receipt, so a
 *  head event can be seen first). null = not ours to post (an op no experiment of the agent owns). */
export async function resolve(ev: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const run = ev.opId ? await runOfOp(String(ev.opId)) : undefined;
  switch (ev.event) {
    case "queued": {
      const op = decodeOp(Number(ev.op), ev.data as Hex);
      // a test's own op (SetShadow, SetCanary) states the fee it tests: its experiment's vector
      const fee = op.name === "SetParams" ? feeFacts((op.args[1] as Hex[]).slice(0, 3).map((w) => Number(BigInt(w))) as Vector) : run ? feeFacts(run.vector) : undefined;
      // SetParams on the experiment's active module tunes the live fee; on any other plate it sets a test's fee (unknown
      // without the run: then the post says nothing about who pays)
      const target = op.name === "SetParams" && run ? (run.active && String(op.args[0]).toLowerCase() === run.active.toLowerCase() ? "live" : "test") : undefined;
      // a live tune sets the active module, not the experiment's plate: no plate label then
      return { event: "queued", op: op.name, opId: Number(ev.opId), plate: target === "live" ? undefined : run?.label, fee, activatesAt: utc(BigInt(String(ev.eta))), ...(target ? { target } : {}) };
    }
    case "test_live":
      if (!run) return null;
      return { event: "test_live", op: ev.op === 1 ? "SetShadow" : "SetCanary", plate: run.label, fee: feeFacts(run.vector) };
    case "cancelled": {
      // finalized chain_log may not hold a Queued vetoed within ~13 min: an experiment's op is ours either way
      const [q] = await sql<{ op: number; proposer: Address }[]>`select (args->>'op')::int as op, args->>'proposer' as proposer from chain_log where event = 'Queued' and args->>'id' = ${String(ev.opId)}`;
      if (!run && q?.proposer.toLowerCase() !== addressOf("agent")?.toLowerCase()) return null; // the Safe cancelling its own op
      // a veto: the Safe's owners said no to one of the agent's ops
      return { event: "cancelled", opId: Number(ev.opId), plate: run?.label, op: q ? OPS[q.op] : undefined, by: "the Safe owners" };
    }
    case "reply": {
      // the asked topic's mechanics (code's lines; the launch guard's only on a hook that has it)
      const topic = typeof ev.topic === "string" ? (ev.topic as Topic) : undefined;
      const mechanics = topic ? mechanicsFor(topic, await hasLaunchGuard(HOOK_READ.launchGuard)) : [];
      // lang: the reader's (SCRIPTS); lead: code's "@handle" before a reply in our own thread (a thread presence turn)
      return { event: "reply", category: ev.category, topic, question: ev.question, state: await stateFacts(), relationship: ev.relationship, ...(mechanics.length ? { mechanics } : {}), ...(typeof ev.rival === "string" ? { rival: ev.rival } : {}),
        ...(typeof ev.lang === "string" && ev.lang in SCRIPTS ? { lang: ev.lang } : {}), ...(typeof ev.lead === "string" ? { lead: ev.lead } : {}) };
    }
    case "game": {
      const g = await gameFacts(ev);
      return g && { ...g.facts, append: g.append };
    }
    // a code update, an owner change (src/upgrades.ts)
    case "update_queued": case "update_allowed": case "update_running": case "update_cancelled": case "change_queued": case "change_cancelled": case "change_done":
      return (await import("./upgrades.ts")).resolveChange(ev);
    // never an empty day about ourselves: the day's changelog (src/upgrades.ts) replaced it, a stray row is skipped
    case "seq_nothing_today":
      return null;
    default:
      return ev;
  }
}

/** The hook's `baselineFee()` now, in pips: 3% at the pool's initialization sliding to 2.2% over the first hour, then
 *  2.2%; a hook with the launch guard returns its launch tax for its first blocks. Test seam. */
export const HOOK_READ = {
  baselineFee: async () => Number(await pub.readContract({ address: d.hook, abi: hookAbi, functionName: "baselineFee" })),
  // a hook without the launch guard has no such view: the read reverts and no guard line is told
  launchGuard: () => pub.readContract({ address: d.hook, abi: GUARD_ABI, functionName: "launchGuard" }),
};
type LiveRoute = { active: string; activeParams: Hex[] };
/** The live fee a post states: the active module's parameters, or with none the hook's baseline as `read` returns it
 *  (pips). A failed read states nothing ({}): never a guessed number. */
export async function liveFee(r: LiveRoute | undefined, read: () => Promise<number> = HOOK_READ.baselineFee): Promise<Record<string, number>> {
  if (r && !/^0x0{40}$/i.test(r.active)) return feeFacts(r.activeParams.slice(0, 3).map((w) => Number(BigInt(w))) as Vector);
  return read().then((pips) => ({ basePct: pips / 1e4 }), () => ({}));
}

/** Public live state for replies: level, the live fee, the open test's stage and plate (all on-chain). */
export async function stateFacts() {
  const [chain] = await sql<{ value: { level?: number; route?: LiveRoute } }[]>`select value from state where key = 'chain'`;
  const [row] = await sql<(RunRow & { stage: string })[]>`select id, stage, data, sig from thread where kind = 'fee' and stage <> 'closed' order by created_at limit 1`;
  const open = row && (await trusted("thread", row.id, row.data, row.sig)) ? row : undefined;
  const live = await liveFee(chain?.value.route);
  return {
    level: chain?.value.level, liveFee: live,
    testing: open ? { stage: /shadow/.test(open.stage) ? "shadow" : "canary", plate: open.data.label } : undefined,
  };
}

type Outbox = { id: string; type: Kind; event_key: string; event: Record<string, unknown>; reply_to: string | null; link: string | null; created_at: Date; errors: number; sig: string | null; status?: string };
/** Events that set the milestone mood (a first, a record, the run's opening moments). */
/** A mention asking which contract is real: with a 0x address in it, it still gets the official line. */
const CONTRACT_ASK = /\b(contract|ca|real|official|legit|scam|fake|genuine|right one|the one)\b/i;
const MILESTONE_MOOD = new Set(["online", "contracts_connected", "keys_handed", "first_idea_round", "first_burn", "milestone", "seq_online"]);
/** Posts that carry what the engine waits on (a status, the opening post, a reply). */
const PENDING_EVENTS = new Set(["status", "online", "reply"]);
/** Events whose first ever is marked `first` (a first experiment, test, result, build, ship, draw, round, reward). */
const FIRST_EVENTS = new Set(["queued", "test_live", "outcome", "seq_started", "seq_shipped", "seq_released", "jackpot_drawn", "idea_round", "reward_paid", "ballot_result", "mystery_result", "module_approved"]);
/** Writer failures (not an LLM-cap Defer) an item may have before it is dropped: no Grok call every minute for 6 h. */
/** Writer failures (an invalid answer; a provider's 429 or 5xx is a wait, not a failure: src/llm.ts TRANSIENT) before a
 *  post rolls into the digest; the item waits 2^errors minutes after each (2, 4, 8, 16, 32: about an hour in all). */
export const MAX_WRITER_ERRORS = 6;
const setStatus = (id: string, status: string, extra: { error?: string; tweetId?: string } = {}) =>
  sql`update x_outbox set status = ${status}, error = ${extra.error ?? null}, tweet_id = ${extra.tweetId ?? null}, updated_at = now() where id = ${id}`;

/** The newest tone brief (≤ 48 h old), else none. */
export async function currentTone(): Promise<string[]> {
  const t = await latest<{ phrases: string[] }>("tone", "brief");
  return t && Date.now() - t._at.getTime() < 48 * 3600_000 ? t.phrases : [];
}

/** The writer's character memory (src/character.ts characterContext). Only the process entry point (src/engine.ts) fills
 *  this slot, so no module that decides or moves money imports that memory; left empty, the writer runs without it. */
export const CHARACTER_MEMORY: { context: (o: { authorId?: string; type?: "post" | "reply" }) => Promise<CharacterContext | null> } = { context: async () => null };

export const sendHandler: Handler = {
  lane: "x",
  run: async () => {
    const m = await mode();
    if (m === "halted") return "halted";
    // an 'attempt' older than 5 min: the process died between the attempt record and the outcome. It may be on X
    for (const s of await sql<Outbox[]>`select id::text, type, event_key, event, reply_to, link, created_at, errors, sig from x_outbox where status = 'attempt' and updated_at < now() - interval '5 minutes'`) {
      await attempted(s, "process died mid-post");
    }
    // a post queued too long rolls into the daily digest (never dropped); only a stale reply is skipped. Cutoffs on the
    // DB's clock
    const stale = sql`created_at < now() - make_interval(secs => ${X.staleMs / 1000})`;
    await sql`update x_outbox set status = 'digest', error = 'rolled into the digest: stale', updated_at = now() where status = 'queued' and type = 'post' and ${stale} and event->>'event' not in ('digest', 'ct')`;
    // an idea author's reply never goes stale (it still goes out once, under the ceilings)
    await sql`update x_outbox set status = 'skipped', error = 'stale', updated_at = now() where status in ('queued', 'held') and type = 'reply' and ${stale}
      and event->>'category' is distinct from 'idea'`;
    // a digest not out within the stale window never takes a slot the next day (the next digest counts anew)
    await sql`update x_outbox set status = 'skipped', error = 'stale digest', updated_at = now() where status = 'queued' and type = 'post' and event->>'event' = 'digest' and ${stale}`;
    // a held reply whose Send / Skip message never reached Telegram: shown again
    for (const h of await sql<Outbox[]>`select id::text, type, event_key, event, reply_to, link, created_at, errors, sig from x_outbox where status = 'held' and error = ${KEYBOARD_MISSING}`) {
      const rec = await latest<{ status: string; text?: string }>("x_post", h.event_key).catch(() => undefined);
      if (rec?.status === "held" && typeof rec.text === "string") await showHeld(h, rec.text);
    }
    // by rank (the digest's last slot 0, money 1 > ballot / mystery results 2 > experiments 3 > the rest and replies 4),
    // then in order
    const queued = (await sql<Outbox[]>`select id::text, type, event_key, event, reply_to, link, created_at, errors, sig from x_outbox where status = 'queued'
      and (errors = 0 or updated_at < now() - make_interval(mins => power(2, errors)::int)) order by id`)
      .sort((a, b) => rankOf(a) - rankOf(b) || Number(a.id) - Number(b.id));
    if (!queued.length) return "nothing queued";
    if (await muted()) {
      await sql`update x_outbox set status = 'skipped', error = 'muted', updated_at = now() where status in ('queued', 'held')`;
      return "muted";
    }
    const used = await usedToday();
    const caps = postCaps(); // the launch window's, or the normal ones
    // events take all but the day's last post, which is the digest's
    const room = (i: Outbox) => used.post < (i.event.event === "digest" ? caps.daily : eventPosts());
    // replies wait (stay queued) for an hour after X refused one
    const paused = await repliesPaused();
    // the first post is "online": once the Safe's initialize is indexed, every other post waits for it (replies go)
    const first = m === "live" && (await onlineAhead());
    const ready = queued.filter((i) => (i.type === "reply" ? !paused && used.reply < X.dailyReplies : (!first || i.event_key === "online") && room(i) && used.sinceLastMs >= caps.spacingMs));
    if (!ready.length) return `waiting: posts ${used.post}/${caps.daily} (spacing ${caps.spacingMs / 60_000} min), replies ${used.reply}/${X.dailyReplies}${paused ? ", replies paused after a 403" : ""}${first ? ", posts after the online post" : ""}`;
    // queue-not-wait: an item whose image isn't ready stays queued and the next one goes (never a wait in-process)
    for (const item of ready) {
      const r = await sendOne(item, m);
      if (r !== WAIT) return r;
    }
    return `waiting for images: ${ready.map((i) => i.event_key).join(", ")}`;
  },
};
const WAIT = Symbol("wait");
/** How long an idea reply waits for the intake's first read before it goes without one. */
export const IDEA_READ_WAIT_MS = 5 * 60_000;

/** True while the launch has begun (the registry's Initialized is indexed) and the "online" post is not out yet: not
 *  queued by x:launch, queued, mid-attempt, or skipped by a /mute (x:launch queues it again). Once it is posted, rolled
 *  into the digest or failed, nothing waits on it. */
export async function onlineAhead() {
  const [init] = await sql`select 1 from chain_log where event = 'Initialized' and address = ${d.registry.toLowerCase()} limit 1`;
  if (!init) return false;
  const [o] = await sql<{ status: string }[]>`select status from x_outbox where event_key = 'online'`;
  return !o || ["queued", "attempt", "skipped"].includes(o.status);
}

/** The outbox order: posts by priority, replies with the rest. */
export const rankOf = (i: { type: string; event: Record<string, unknown> }) => (i.type === "reply" ? 4 : priorityOf(i.event));
/** A post the writer could not produce rolls into the digest (never dropped); a reply or the digest itself fails. */
async function giveUp(item: Outbox, status: "skipped" | "failed", error: string) {
  // a take on crypto Twitter (src/ct.ts) is of its moment: dropped, never digested
  if (item.type === "post" && item.event.event !== "digest" && item.event.event !== "ct") return setStatus(item.id, "digest", { error: `rolled into the digest: ${error}` });
  await setStatus(item.id, status, { error });
  if (item.event.event === "digest") await alert(`The daily digest ${item.event_key} was not posted: ${error}.`, `alert:digest:${item.event_key}`);
}

async function sendOne(item: Outbox, m: string): Promise<unknown> {
  if (!(await trusted("x_outbox", item.event_key, outboxValue(item.type, item.event, item.reply_to, item.link), item.sig))) {
    await setStatus(item.id, "skipped", { error: "unsigned outbox row" });
    return "skipped";
  }
  const block = item.type === "reply" ? await replyBlock(item) : null;
  if (block) { await setStatus(item.id, "skipped", { error: block }); return "skipped"; }
  let raw: Record<string, unknown> | null;
  try {
    raw = await resolve(item.event);
  } catch (e) {
    if (!(e instanceof Defer)) throw e;
    // a fact this post needs can't be read yet (an update's release record): it stays queued for the next run, the
    // rest go now; a signers' note once it has waited 2 h
    if (Date.now() - new Date(item.created_at).getTime() > 2 * 3600_000) await alert(`X post ${item.event_key} still waits after 2 h: ${e.message}`, `alert:x:deferred:${item.event_key}`);
    return WAIT;
  }
  if (!raw) { await setStatus(item.id, "skipped", { error: "not an agent op" }); return "skipped"; }
  if (item.type === "post" && raw.event !== "digest" && raw.event !== "ct") await announce(item.event_key, raw, { raw: item.event, tx: item.link, proof: proofOf(raw.append) }); // if not yet
  // the run's day on every post; the mind (src/life.ts; screened by factSheet) on the posts about its work; what it
  // waits on where someone may ask; the first of a kind marked
  const ev = String(raw.event);
  // an idea reply waits (≤ 5 min) for the intake's first read (src/ideas.ts runs every minute): its class and score
  if (item.type === "reply" && raw.category === "idea" && item.reply_to && Date.now() - new Date(item.created_at).getTime() < IDEA_READ_WAIT_MS
    && !(await sql`select 1 from intake where mention_id = ${item.reply_to}`).length) return WAIT;
  const facts = factSheet({
    ...raw, day: await dayOfLife(), ...(await storyNow(item.event_key, ev)), ...(MIND_EVENTS.has(ev) ? { mind: await mindNow() } : {}), ...(PENDING_EVENTS.has(ev) ? { pending: await pendingNow(Date.now(), ev) } : {}),
    ...(FIRST_EVENTS.has(ev) && !(await sql`select 1 from log where kind = 'announce' and doc->>'type' = ${ev} and ref <> ${item.event_key} limit 1`).length ? { first: true } : {}),
    // an idea the intake took in: the reply says it is logged (live idea mode: where its verdict stands)
    ...(item.type === "reply" && raw.category === "idea" && item.reply_to ? await intakeFact(item.reply_to) : {}),
  });
  // the mention a reply answers (code's check only: the writer never sees it)
  const mention = item.type === "reply" && item.reply_to ? (await sql<{ text: string }[]>`select text from x_mention where id = ${item.reply_to}`)[0]?.text : undefined;
  // the image: generated art (re-checked here, approved while approvals are on), a plate, the logo, or none
  let card: Card | null = null;
  if (item.type === "post") {
    const c = await cardFor(item.event_key, item.created_at, { ...item.event, link: item.link }, facts);
    if (c === "wait") return WAIT;
    card = c;
  }
  const allowed = factNumbers(facts);
  const tone = await currentTone();
  // code appends: game text (a winner's short address, a commitment), then the tx link
  const suffix = [raw.append, item.link].filter(Boolean).join("\n");
  // code's "@handle" before the writer's text: a reply in our own thread that tags the person it is for (an idea's
  // progress, a thread presence turn); the writer never writes a handle
  const lead = typeof raw.lead === "string" && /^@\w{1,15}$/.test(raw.lead) ? raw.lead : "";
  const extra = appendWeight(suffix) + (lead ? weightedLength(lead) + 1 : 0);
  // a binding and the official-contract answer get one fixed text each (code, never the writer)
  const fixed = raw.event === "binding_reply" ? BINDING_REPLY : raw.event === "official_reply" ? OFFICIAL_REPLY : String(raw.event).startsWith("update_") && typeof raw.fixed === "string" ? raw.fixed : null;
  const author = item.type === "reply" && typeof item.event.author === "string" ? item.event.author : undefined;
  const memory = fixed ? null : await CHARACTER_MEMORY.context({ authorId: author, type: item.type });
  // a first or a milestone is an event: the mood says so; 4 shapes, never the one this event used last time
  const mood = memory && (facts.first === true || MILESTONE_MOOD.has(ev)) ? "milestone" as const : memory?.mood;
  const shapes = chooseShapes(shapesFor(item.type, facts, mood), memory?.recent ?? [], ev);
  // in a thread, a draft that repeats one of our earlier replies there adds no new fact: it is not sent
  const before = item.type === "reply" ? (await ourThread(item.event.self === true ? String(item.event.mention ?? "") : item.reply_to)).map((p) => p.text) : [];
  // a fixed text already sent in this thread adds nothing: never repeated there
  if (fixed && before.includes(fixed)) { await setStatus(item.id, "skipped", { error: "the same fixed text is already in this thread" }); return "skipped"; }
  // an event that shipped nothing never reads as shipped, live, fixed, merged or approved (src/voice.ts claimIssues)
  // a draft that only restates code's stage text is refused (parrotIssue); an echo of the private bundle too (bundleIssues)
  // a reply in the reader's language (facts.lang) may use that language's letters (SCRIPTS)
  const script = typeof facts.lang === "string" ? SCRIPTS[facts.lang] : undefined;
  const filter = (text: string) => [...postFilter(text, allowed, extra, { intent: intentOf(facts), priceJoke: facts.category === "price_fud", claim: claimFacts(facts), script }), ...(before.some((b) => overlap(b, text) >= GATE.overlap) ? ["no new fact"] : []), ...claimIssues(facts, text), ...allyIssues(facts, text), ...promiseIssue(text), ...voiceIssues(facts, text, { linked: !!item.link, mention }), ...[parrotIssue(facts, text)].filter((x): x is string => !!x), ...bundleIssues(text)];
  let w: Drafted;
  try {
    w = fixed ? { model: "code", candidates: [{ text: fixed, issues: [] }], redraft: false }
      : await draftInCharacter(facts, tone, filter, memory ? { ...memory, mood: mood ?? memory.mood, shapes, card: card?.kind === "image", ...(before.length ? { thread: before.slice(-5) } : {}) } : null, undefined, shapes);
  } catch (e) {
    return writerFailed(item, e);
  }
  const candidates = w.candidates;
  // the judge orders what passed every filter (2 or more); it never decides what is safe: on any failure, the first
  const passing = candidates.filter((c) => !c.issues.length);
  let judged: (JudgeOut & { model: string }) | null = null;
  // a take on crypto Twitter (src/ct.ts) is judged even alone: the judge decides whether it is worth posting (flatTake)
  if (passing.length >= 2 || (facts.event === "ct" && passing.length)) {
    try {
      const j = await llm(judgeCall(facts, passing.map((c) => c.text), (memory?.recent ?? []).map((p) => p.text)));
      judged = { ...j.data, model: j.model };
    } catch (e) {
      console.error(`x judge ${item.event_key}:`, (e as Error).message.slice(0, 200));
    }
  }
  const best = pickBest(candidates, judged);
  const flat = facts.event === "ct" && best ? flatTake(judged, passing.indexOf(best), passing.length) : null;
  const pick = flat ? undefined : best;
  // character memory reads these back (src/character.ts): the shape, mood, the running joke, the reader's X id
  const character = memory ? { shape: pick?.shape, mood: mood ?? memory.mood, redraft: w.redraft, ...(author ? { author } : {}) } : {};
  const rec = { type: item.type, outbox: item.id, event: item.event_key, facts, promptHash: sha(writerSystem(facts)), personaSha256: PERSONA.sha256, model: w.model, tone, candidates: publicCandidates(candidates), shapes, ...(judged ? { judge: judged } : {}), mode: m, media: mediaRecord(card), ...character };
  if (!pick) {
    await append("x_post", item.event_key, { ...rec, status: "miss", ...(flat ? { why: flat } : {}) });
    await giveUp(item, "skipped", flat ?? "no candidate passed the filter");
    return "miss";
  }
  const draft = pick.text.normalize("NFKC").trim();
  // code's lexicon is English: a reply in another language (even one that happens to be plain ASCII) is read back in
  // English by a call that never saw the facts or the mention, and that reading must pass the same checks (its length
  // aside), or the writer tries again later
  if (script) {
    try {
      const english = (await llm(untrustedCall("x-translate", TRANSLATE, draft, Translated))).data.english;
      const issues = filter(english).filter((i) => i !== "over 280 weighted chars");
      if (issues.length) throw new Error(`the English reading of the draft: ${issues.join(", ")}`);
    } catch (e) {
      return writerFailed(item, e);
    }
  }
  const text = `${lead ? `${lead} ` : ""}${draft}${suffix ? `\n${suffix}` : ""}`;
  // the writer's own text and joke ride in the record, so a held reply sent by a tap carries them too
  const sent = { ...rec, draft, ...(pick.joke ? { joke: pick.joke } : {}) };
  if (m !== "live") {
    await append("x_post", item.event_key, { ...sent, text, status: "dry_run" });
    await setStatus(item.id, "dry_run");
    return { dryRun: text };
  }
  // an important or competitor mention: the signers' alert carries the exact reply (its Plan)
  const held = item.type === "reply" && HELD_EVENTS.has(String(item.event.event)) && replyPath(tierOfItem(item)) === "hold";
  if (item.type === "reply" && tierOfItem(item) !== "normal") await replyAlert(item, held ? `this reply, held for a Send tap:\n${text}` : `this reply, going out now:\n${text}`).catch(() => {});
  // the official-contract answer to an important account waits for the tap like any reply to one (X_HOLD_IMPORTANT)
  if (held) return hold(item, { ...sent, text });
  return deliver(item, text, card, sent);
}

/** A writer failure (an invalid answer, or a draft whose English reading fails): tried again after a backoff, up to
 *  MAX_WRITER_ERRORS; the LLM cap (Defer) leaves the item queued. */
async function writerFailed(item: Outbox, e: unknown) {
  if (e instanceof Defer) throw e; // the LLM cap: the item stays queued until tomorrow
  const n = item.errors + 1;
  await sql`update x_outbox set errors = ${n}, error = ${(e as Error).message.slice(0, 300)}, updated_at = now() where id = ${item.id}`;
  if (n >= MAX_WRITER_ERRORS) {
    await giveUp(item, "failed", `writer failed ${n} times: ${(e as Error).message.slice(0, 200)}`);
    await alert(`X writer failed ${n} times on ${item.event_key} (${item.type}); ${item.type === "post" ? "it rolled into the digest" : "no reply"}. Last error: ${(e as Error).message.slice(0, 200)}`, `alert:xwriter:${item.event_key}`);
  }
  return `writer failed (${n}/${MAX_WRITER_ERRORS})`;
}

/** The POST, at most once: the signed `attempt` record (text, media sha256 + provenance) precedes the upload and the
 *  call. `held`: a signer's Send on a held reply (a rate limit puts it back on hold instead of the queue). */
async function deliver(item: Outbox, text: string, card: Card | null, rec: Record<string, unknown>, held = false): Promise<unknown> {
  await token(); // a refresh that fails here leaves the item queued: no attempt record, no false "may have posted"
  // the exact text (and the media's sha256 + provenance) is in this signed record BEFORE the upload and the POST: /proof
  // finds it by the tweet id the `posted` record links
  await append("x_post", item.event_key, { ...rec, text, status: "attempt" });
  await setStatus(item.id, "attempt");
  const up = await uploadCard(card);
  const stop = await stopped();
  if (stop) {
    // X was never called: nothing may be on X, so the item is dropped (a held reply too), never "attempted"
    await append("x_post", item.event_key, { type: item.type, outbox: item.id, status: "dropped", why: stop });
    await setStatus(item.id, "skipped", { error: stop });
    return stop;
  }
  let r: { status: number; body: { data?: { id: string } } };
  try {
    r = await x("POST", "/2/tweets", { text, ...(item.reply_to ? { reply: { in_reply_to_tweet_id: item.reply_to } } : {}), ...(up.id ? { media: { media_ids: [up.id] } } : {}) });
  } catch (e) {
    return attempted(item, `network error after the attempt: ${(e as Error).message}`);
  }
  if (r.status === 201 && r.body.data?.id) {
    await append("x_post", item.event_key, { type: item.type, outbox: item.id, tweetId: r.body.data.id, status: "posted", mediaId: up.id, mediaError: up.error ?? null });
    await setStatus(item.id, "posted", { tweetId: r.body.data.id });
    // the owners see each post as it goes out; a note that fails to queue never touches the post
    await alert(postedNote(item, r.body.data.id, text), `posted:${item.id}`).catch(() => {});
    return { tweetId: r.body.data.id };
  }
  if (r.status >= 500) return attempted(item, `X ${r.status} after the attempt`);
  if (r.status === 429 && held) {
    await append("x_post", item.event_key, { ...rec, text, status: "held" }); // X posted nothing: Send works again later
    await setStatus(item.id, "held");
    return "X rate limit (429): tap Send again later";
  }
  if (r.status === 429) { await setStatus(item.id, "queued"); throw new Defer(15 * 60_000, "X rate limit (429)"); }
  await append("x_post", item.event_key, { type: item.type, outbox: item.id, status: "failed", http: r.status });
  await setStatus(item.id, "failed", { error: `X ${r.status}` });
  // a refused reply ends its thread and pauses replies for an hour (repliesPaused): never a run of 403s
  if (item.type === "reply" && r.status === 403) {
    await alert(`X refused reply #${item.id} to ${statusUrl(item.reply_to ?? "")} (403: not summoned, blocked, or the app is limited). The thread stops; replies pause for an hour.`, `alert:xreply403:${hour()}`);
    return "failed 403";
  }
  await alert(r.status === 401 || r.status === 403
    ? `X post ${r.status}: the token is revoked or lacks scope. Re-auth: the operator runs OAuth PKCE and sets a new X_REFRESH_TOKEN (sealed env).`
    : `X post ${item.event_key} failed: ${r.status}.`, `alert:xpost:${item.id}`);
  return `failed ${r.status}`;
}

/** The post may or may not be on X: never retried, a human checks. */
async function attempted(item: Outbox, why: string) {
  await append("x_post", item.event_key, { type: item.type, outbox: item.id, status: "attempted", error: why.slice(0, 300) });
  await setStatus(item.id, "attempted", { error: why.slice(0, 300) });
  await alert(`X ${item.type} #${item.id} (${item.event_key}) may have posted: ${why}. Not retried: check the account.`, `alert:xattempted:${item.id}`);
  return "attempted";
}

// ---------------------------------------------------------------- replies

/** This mention gets no reply (its one outbox row, skipped): it never comes back to the replies job. */
export const skipReply = (mentionId: string, why: string) =>
  sql`insert into x_outbox (type, event_key, event, reply_to, status, error) values ('reply', ${`reply:${mentionId}`}, '{}', ${mentionId}, 'skipped', ${why}) on conflict do nothing`;

/** A mention the intake takes again (live idea mode's backfill) gets its one reply after all: a skip from before (an
 *  old gate) is cleared, so the replies job weighs it anew under today's rules and hard lines. A reply that went out,
 *  or one in flight, stays the only one; a skip while muted, or a signer's Skip tap, stays. */
export const reopenReply = (mentionId: string) =>
  sql`delete from x_outbox where event_key = ${`reply:${mentionId}`} and status = 'skipped' and error is distinct from 'muted' and coalesce(error, '') not like 'skipped by %'`;

type MentionRow = { id: string; author_id: string | null; text: string; raw: Mention; sig: string | null };
export const statusUrl = (id: string) => `https://x.com/i/status/${id}`;
/** The owners' Telegram note for a post that went out: what it was (a reply names the post it answered), where, the text. */
export const postedNote = (item: Pick<Outbox, "type" | "event_key" | "reply_to">, tweetId: string, text: string) =>
  `Posted: ${item.type === "reply" && item.reply_to ? `reply to ${statusUrl(item.reply_to)}` : item.event_key}\n${statusUrl(tweetId)}\n${text.slice(0, 280)}`;
const signedMention = async (m: MentionRow | undefined) => !!m && (await trusted("x_mention", m.id, { author: m.author_id, text: m.text, raw: m.raw }, m.sig));
const parentOf = (m: Mention) => m.referenced_tweets?.find((r) => r.type === "replied_to")?.id;

/** X's summon test on a stored mention: it @mentions us, or quotes one of our posts (our signed `posted` records). */
async function isSummoned(m: Mention) {
  const quoted = (m.referenced_tweets ?? []).filter((r) => r.type === "quoted").map((r) => r.id);
  // simplification: the plain log row, not a verified record: a forged one only costs a refused reply (a 403 pauses replies)
  const ours = quoted.length ? await sql<{ id: string }[]>`select doc->>'tweetId' as id from log where kind = 'x_post' and doc->>'status' = 'posted' and doc->>'tweetId' = any(${quoted})` : [];
  return summoned(m, X.userId, new Set(ours.map((r) => r.id)));
}

/** Our posted replies in the conversation of this mention (or of `conv`): the text we sent and when it went out. */
async function ourThread(mentionId: string | null, conv?: string): Promise<Post[]> {
  conv ??= mentionId ? (await sql<{ conv: string | null }[]>`select raw->>'conversation_id' as conv from x_mention where id = ${mentionId}`)[0]?.conv ?? undefined : undefined;
  if (!conv) return [];
  return sql<Post[]>`select o.tweet_id as id, l.doc->>'text' as text, (extract(epoch from o.updated_at) * 1000)::float8 as at from x_outbox o
    join x_mention x on x.id = o.reply_to join log l on l.kind = 'x_post' and l.ref = o.event_key and l.doc->>'status' = 'attempt'
    where o.type = 'reply' and o.status = 'posted' and x.raw->>'conversation_id' = ${conv}`;
}
/** The author's earlier posts in this conversation, newest first. */
const theirThread = async (m: MentionRow, conv: string): Promise<Post[]> =>
  (await sql<MentionRow[]>`select id, author_id, text, raw, sig from x_mention where raw->>'conversation_id' = ${conv} and author_id = ${m.author_id}
    and (length(id), id) < (length(${m.id}::text), ${m.id}::text) order by length(id) desc, id desc limit 50`).map((r) => ({ id: r.id, text: r.text, parent: parentOf(r.raw) }));

/** The anti-loop brake: X.repliesPerAuthorHour of our replies (any kind) to one account in the last hour. */
export const braked = async (author: string) => (await sql<{ mine: number }[]>`select count(*)::int as mine from x_outbox o where o.type = 'reply'
  and o.status <> 'skipped' and o.event->>'author' = ${author} and o.created_at > now() - interval '1 hour'`)[0].mine >= X.repliesPerAuthorHour;
/** An address in a post's text: outside a binding or a contract question, it gets nothing (a scam's "send to 0x…"). */
export const LOOSE_ADDRESS = /0x[0-9a-f]{40}/i;

/** Reply events that follow the tier's reply path (auto, held for the Send tap, off); the binding notice always goes. */
const HELD_EVENTS = new Set(["reply", "official_reply", "idea_update"]);
const tierOfItem = (item: Outbox): Tier => (["important", "competitor"].includes(String(item.event.tier)) ? item.event.tier as Tier : "normal");

/** X refused a reply (403) in the last hour: replies wait (they stay queued or held), none is sent. */
const repliesPaused = async () => (await sql`select 1 from x_outbox where type = 'reply' and status = 'failed' and error = 'X 403' and updated_at > now() - interval '1 hour' limit 1`).length > 0;

/** The reply ceilings: X.dailyReplies a UTC day and X.hourlyReplies in the last 60 minutes (across midnight too), over
 *  every reply that holds a slot. `except`: the reply asking (a held one already holds its own). */
export async function overCeiling(except?: string) {
  const now = Date.now();
  const [{ n, hour }] = await sql<{ n: number; hour: number }[]>`select count(*) filter (where created_at >= ${new Date(now - (now % 86_400_000))})::int as n,
    count(*) filter (where created_at > ${new Date(now - 3600_000)})::int as hour from x_outbox where type = 'reply' and status <> 'skipped'
    and created_at > ${new Date(now - 86_400_000 - 3600_000)} ${except ? sql`and id <> ${except}` : sql``}`;
  return n >= X.dailyReplies || hour >= X.hourlyReplies;
}

/** Why a queued or held reply may not go out (null = it may): checked before the writer runs and again at a Send tap,
 *  so the reply API is never called for a post that did not summon us. */
async function replyBlock(item: Outbox): Promise<string | null> {
  // a reply in our own thread (`self`: an idea's progress, a thread presence turn) answers our own posted reply; the
  // signed mention that summoned us there is `event.mention`, and the person it tags (`event.author`) may have opted out
  const self = item.event.self === true;
  if (self && !(await ourPostedReply(item.reply_to))) return "not a reply to our own posted reply";
  const [m] = await sql<MentionRow[]>`select id, author_id, text, raw, sig from x_mention where id = ${self ? String(item.event.mention ?? "") : item.reply_to}`;
  if (!(await signedMention(m))) return "no signed mention";
  if (!(await isSummoned(m.raw))) return "not summoned (no @mention or quote of us)";
  for (const a of new Set([m.author_id, self && typeof item.event.author === "string" ? item.event.author : null])) {
    if (a && (await sql`select 1 from x_optout where author_id = ${a}`).length) return "opted out";
  }
  if (HELD_EVENTS.has(String(item.event.event)) && replyPath(tierOfItem(item)) === "off") return "AI replies are off until X approves them";
  return null;
}

/** A tweet of ours: a reply whose signed `posted` record names it (the outbox row's tweet_id alone is not signed). */
async function ourPostedReply(tweetId: string | null) {
  if (!tweetId) return false;
  const rs = await sql<EnclaveRow[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where kind = 'x_post' and doc->>'status' = 'posted'
    and doc->>'type' = 'reply' and doc->>'tweetId' = ${tweetId} order by seq desc limit 3`;
  for (const r of rs) if (await trustedRecord(r, "x_post record")) return true;
  return false;
}

/** An important account's reply before X approves AI replies: the exact text is signed as `held` and shown to the
 *  signers with Send / Skip; nothing goes to X until a Send tap (pressReply). */
async function hold(item: Outbox, rec: Record<string, unknown> & { text: string }) {
  await append("x_post", item.event_key, { ...rec, status: "held" });
  await setStatus(item.id, "held");
  await showHeld(item, rec.text);
  return { held: item.id };
}
/** Marks a held reply whose Send / Skip message Telegram did not take: x:send shows it again. */
const KEYBOARD_MISSING = "Send / Skip not shown yet";
/** The Send / Skip message. When Telegram fails, the row is marked (x:send retries) and a queued alert names the reply. */
async function showHeld(item: Outbox, text: string) {
  // a reply in our own thread tags its person (`lead`) under our own tweet
  const self = item.event.self === true && typeof item.event.lead === "string";
  const [m] = self ? [{ author_username: String(item.event.lead).slice(1) }] : await sql<{ author_username: string | null }[]>`select author_username from x_mention where id = ${item.reply_to}`;
  try {
    await say(`Reply draft #${item.id} for @${m?.author_username ?? "?"} (important account). Send posts exactly this as a reply to ${statusUrl(item.reply_to ?? "")}${self ? " (our own reply in their thread)" : ""}\n\n${text}`,
      { reply_markup: { inline_keyboard: [[{ text: "Send", callback_data: `x:${item.id}:s` }, { text: "Skip", callback_data: `x:${item.id}:k` }]] } });
    await sql`update x_outbox set error = null where id = ${item.id} and status = 'held'`;
  } catch (e) {
    await sql`update x_outbox set error = ${KEYBOARD_MISSING} where id = ${item.id} and status = 'held'`;
    await alert(`Reply draft #${item.id} is held, but Telegram did not take its Send / Skip message (${(e as Error).message.slice(0, 200)}). The next x:send run shows it again.`, `alert:xheld:${item.id}`);
  }
}

/** A signer's tap on a held reply. Send posts exactly the signed held text, once (the claim held → attempt is one
 *  statement: a second tap, or a Skip racing it, finds nothing to claim), after the pipeline's checks (mode, mute,
 *  summoned, opt-out, the 403 pause, the reply ceilings); Skip drops it. A pause or a ceiling leaves it held. */
export const pressReply: ReplyButton = async (id, send, by) => {
  const notWaiting = (status?: string) => `Reply #${id} is not waiting for a tap (${status ?? "unknown"}).`;
  const [item] = await sql<Outbox[]>`select id::text, type, event_key, event, reply_to, link, created_at, errors, sig, status from x_outbox where id = ${id} and type = 'reply'`;
  if (item?.status !== "held") return notWaiting(item?.status);
  if (!(await trusted("x_outbox", item.event_key, outboxValue(item.type, item.event, item.reply_to, item.link), item.sig))) return `Reply #${id}: unsigned outbox row.`;
  const draft = await latest<{ status: string; text?: string } & Record<string, unknown>>("x_post", item.event_key).catch((e) => (isRolledBack(e) ? undefined : Promise.reject(e)));
  if (draft?.status !== "held" || typeof draft.text !== "string") return `Reply #${id}: no signed draft to send.`;
  const { _seq, _at, status: _s, text, ...rec } = draft as typeof draft & { _seq: string; _at: Date; text: string };
  const claim = (status: string, error: string | null = null) =>
    sql`update x_outbox set status = ${status}, error = ${error}, updated_at = now() where id = ${id} and status = 'held' returning id`.then((r) => r.length > 0);
  if (!send) {
    if (!(await claim("skipped", `skipped by ${by}`))) return notWaiting("already taken");
    await append("x_post", item.event_key, { type: "reply", outbox: item.id, status: "skipped", by });
    return `Reply #${id} skipped.`;
  }
  const m = await mode();
  if (m !== "live") return `Reply #${id} not sent: the mode is ${m}.`;
  if (await muted()) return `Reply #${id} not sent: X posting is muted.`;
  const block = await replyBlock(item);
  if (block) return (await claim("skipped", block)) ? `Reply #${id} not sent: ${block}.` : notWaiting("already taken");
  if (await repliesPaused()) return `Reply #${id} not sent yet: X refused a reply in the last hour. Tap Send again after the pause.`;
  if (await overCeiling(id)) return `Reply #${id} not sent yet: the reply ceilings are reached. Tap Send again later.`;
  await token(); // before the claim: a failed refresh leaves the reply held, not a dead attempt
  if (!(await claim("attempt"))) return notWaiting("already taken");
  const r = await deliver(item, text, null, { ...rec, by }, true);
  return (r as { tweetId?: string })?.tweetId ? `Reply #${id} sent: ${statusUrl((r as { tweetId: string }).tweetId)}` : `Reply #${id}: ${String(r)}`;
};

/** Replies to one person's same question (its words, mentions, links and punctuation aside) before it is left alone. */
export const SAME_ASK = 2;
export const sameAsk = (a: string, b: string) => {
  const n = (t: string) => t.normalize("NFKC").toLowerCase().replace(/https?:\/\/\S+|@\w+/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return n(a) === n(b) && n(a) !== "";
};
type Decision = { skip: string } | { wait: string } | { later: string } | { kind: Category; topic: Topic; question?: string; lang?: string };
/** Reader failures per mention (an invalid answer): tried again on later runs, skipped after READER_TRIES.
 *  simplification: in memory; a restart gives a mention its tries again (it is still left alone after a day). */
const READER_FAILS = new Map<string, number>();
export const READER_TRIES = 3;
/** One mention → skip (with the reason), wait (a ceiling or the reader's budget: the next run tries again) or reply. */
async function decide(m: MentionRow, tier: Tier): Promise<Decision> {
  if (!(await isSummoned(m.raw))) return { skip: "not summoned (no @mention or quote of us)" };
  // no author gate (age, followers, badge): every person who summons us is answered, under the caps below
  if (replyPath(tier) === "off") return { skip: "AI replies are off until X approves them" };
  const lim = TIERS[tier];
  // the same post from the same person: once within the hour (duplicate spam), twice a week, then left alone
  const asked = await sql<{ text: string; hour: boolean }[]>`select x.text, o.created_at > now() - interval '1 hour' as hour from x_outbox o join x_mention x on x.id = o.reply_to
    where o.type = 'reply' and o.status <> 'skipped' and x.author_id = ${m.author_id} and o.created_at > now() - interval '7 days'`;
  const same = asked.filter((a) => sameAsk(a.text, m.text));
  if (same.some((a) => a.hour)) return { skip: "duplicate: the same post answered within the hour" };
  if (same.length >= SAME_ASK) return { skip: `the same question answered ${SAME_ASK} times` };
  const conv = m.raw.conversation_id;
  const parent = parentOf(m.raw);
  if (conv) {
    // a thread (every tier, replies to our replies too): one turn per new post of theirs, while it runs
    const [t] = await sql<{ turns: number; open: number; stopped: number }[]>`select count(*) filter (where o.status <> 'skipped')::int as turns,
      count(*) filter (where o.status in ('queued', 'held', 'attempt'))::int as open, count(*) filter (where o.error like 'stop:%' or o.error = 'X 403')::int as stopped
      from x_outbox o join x_mention x on x.id = o.reply_to where o.type = 'reply' and x.raw->>'conversation_id' = ${conv} and x.author_id = ${m.author_id}`;
    if (t.stopped) return { skip: "thread stopped" };
    if (t.turns >= lim.perConversation) return { skip: `${lim.perConversation} turns in this conversation` };
    if (t.open) return { later: "our previous reply in this thread is not out yet" }; // their next turn waits for ours
  }
  const stop = stopRule({ id: m.id, text: m.text, parent }, conv ? await theirThread(m, conv) : [], conv ? await ourThread(null, conv) : [], Date.now());
  if (stop) return { skip: `stop: ${stop}` };
  // the anti-loop brake: X.repliesPerAuthorHour replies to one account an hour (no daily cap per person); a post past it
  // waits for the hour to roll (tried again next run, for up to a day)
  if (await braked(m.author_id ?? "")) return { later: `${X.repliesPerAuthorHour} replies to this account in the last hour` };
  if (await overCeiling()) return { wait: "the reply ceilings" }; // later mentions wait (≤ 1 day)
  // a relaunch, an old or other token, a migration: code reads it and only the official line answers (no model)
  if (oldTokenTalk(m.text)) return { kind: "official_contract", topic: "other" };
  try {
    const r = (await classifyMention(m.text)).data;
    // hard lines: phishing and abuse get nothing
    if (r.kind === "scam") return { skip: "scam or phishing" };
    if (r.kind === "abuse") return { skip: "slurs or harassment" };
    // bait never ends a reply, whatever the tier: an ally's hello and a competitor's jab are answered as greetings;
    // anyone else's bait (hype, lfg, collab asks, shilling) gets a short in-voice line (the writer never sees their
    // links, tickers or handles)
    const lang = r.lang in SCRIPTS ? r.lang : undefined;
    if (r.kind === "bait" && (isAlly(m.author_id) || tier === "competitor")) return { kind: "greeting", topic: r.topic, lang };
    return oldTokenTalk(r.question) ? { kind: "official_contract", topic: r.topic } : { kind: r.kind, topic: r.topic, question: questionOf(r.question), lang };
  } catch (e) {
    if (e instanceof Defer) return { wait: `the reader: ${e.message.slice(0, 120)}` }; // the LLM cap or provider trouble: next run
    const n = (READER_FAILS.get(m.id) ?? 0) + 1;
    READER_FAILS.set(m.id, n);
    if (n < READER_TRIES) return { later: `reader failed (${n}/${READER_TRIES}), tried again next run` };
    READER_FAILS.delete(m.id);
    return { skip: `reader failed ${n} times: ${(e as Error).message.slice(0, 200)}` };
  }
}

/** The mention alert for a reply that is written: its Plan is the reply's exact text (one per reply, never deduped
 *  away by an earlier alert about the same author). */
async function replyAlert(item: Outbox, plan: string) {
  // a turn in a thread we are in, for a post that did not summon us: the person it tags and the thread
  if (item.event.self === true && typeof item.event.conv === "string") return alert(`${tierOfItem(item) === "important" ? "Important" : "Competitor"} account in our thread: ${String(item.event.lead)}\n${statusUrl(item.event.conv)}\nPlan: ${plan}`, `alert:xmention:reply:${item.id}`);
  const [m] = await sql<MentionRow[]>`select id, author_id, text, raw, sig from x_mention where id = ${String(item.event.mention ?? item.reply_to)}`;
  if (m) await alertMention(m, tierOfItem(item), plan, `alert:xmention:reply:${item.id}`);
}

/** Signers hear about every mention from an important (or competitor) account, with what the engine does about it. */
function alertMention(m: MentionRow, tier: Tier, plan: string, key?: string) {
  const u = m.raw.user;
  const pm = u?.public_metrics ?? {};
  const who = `@${u?.username ?? m.author_id} (${pm.followers_count ?? 0} followers, ${pm.listed_count ?? 0} lists, ${u?.verified_type ?? "no"} badge)`;
  // a skip or a wait: one alert per author per 6 h; a written reply: one per reply (`key`)
  return alert(`${tier === "important" ? "Important" : "Competitor"} account mentioned us: ${who}\n${statusUrl(m.id)}\nTheir post (untrusted): ${JSON.stringify(m.text.slice(0, 280))}\nPlan: ${plan}`,
    key ?? `alert:xmention:${m.author_id}:${Math.floor(Date.now() / (6 * 3600_000))}`);
}

/** Mentions → replies (src/tiers.ts). Only to a post that @mentions or quotes us, from any author (no age, follower or
 *  badge gate); every tier a turn per new post of theirs in a thread (no daily cap per person; X.repliesPerAuthorHour an hour to one account)
 *  until a stop rule fires; all under ceilings of X.dailyReplies a day and X.hourlyReplies an hour. One reply per
 *  mention id (x_outbox unique reply_to); bait gets a short in-voice line. Never to our own posts, an opted-out author,
 *  an impersonator, phishing, slurs or harassment, injection, or the same post again within the hour. Until X approves AI replies, only important
 *  accounts get one, held for a Send tap; approved, every tier's reply is sent without a tap (X_HOLD_IMPORTANT=1 holds
 *  an important account's). The mention text reaches only the quarantined reader (the writer gets its
 *  category) and the code stop rules. Mentions older than a day (by when they were posted: a long halt never ends in
 *  replies to old posts) are left alone, except an idea (any age since launch: its author always gets one reply, which
 *  never goes stale in the queue); mentions skipped while muted are not answered after /unmute. */
export const repliesHandler: Handler = {
  lane: "x",
  run: async () => {
    // a day's mentions, the ones live idea mode's backfill took again, and every idea since launch (each idea author
    // gets their one reply, whatever its age; today's mentions first). simplification: the backfill mark and the intake
    // index are read unsigned: a forged row can only put an old signed mention on the page, where every hard line runs
    // again (and replyBlock re-checks the signed mention at send)
    const todo = await sql<MentionRow[]>`select m.id, m.author_id, m.text, m.raw, m.sig from x_mention m
      where ((m.fetched_at > now() - interval '1 day' and coalesce(m.created_at, m.fetched_at) > now() - interval '1 day')
          or exists (select 1 from log l where l.kind = 'intake' and l.ref = m.id and l.doc->>'backfill' = 'true')
          or (exists (select 1 from intake i where i.mention_id = m.id and (i.status in ${sql(IDEA_STATUSES)} or i.reason like 'near-duplicate%'))
            and coalesce(m.created_at, m.fetched_at) >= ${new Date(LLM.launchAt ?? 0)}))
        and not exists (select 1 from x_outbox o where o.event_key = 'reply:' || m.id)
        -- what would only come back "later" stays off the page (a busy author never starves everyone else): a turn
        -- whose previous reply in its thread is pending, and an author at the anti-loop brake
        and not exists (select 1 from x_outbox o join x_mention x on x.id = o.reply_to where o.type = 'reply' and o.status in ('queued', 'held', 'attempt')
          and x.author_id = m.author_id and x.raw->>'conversation_id' = m.raw->>'conversation_id')
        and (select count(*) from x_outbox o where o.type = 'reply' and o.status <> 'skipped' and o.event->>'author' = m.author_id and o.created_at > now() - interval '1 hour') < ${X.repliesPerAuthorHour}
      order by coalesce(m.created_at, m.fetched_at) > now() - interval '1 day' desc, length(m.id), m.id limit 20`;
    const out: Record<string, string> = {};
    const skip = async (m: MentionRow, why: string) => {
      await skipReply(m.id, why);
      out[m.id] = why;
    };
    for (const m of todo) {
      if (!(await signedMention(m))) { await skip(m, "unsigned mention row"); continue; }
      if (m.author_id && m.author_id === X.userId) { await skip(m, "own post"); continue; }
      if (parseBinding(m.text)) continue; // a wallet binding: the intake replies once, or marks it skipped
      // shaped like us or an ally, or an address outside the binding format (a scam's "send me ETH 0x…"): never a reply
      const fake = impersonator(m.raw.user ? { id: m.author_id ?? undefined, ...m.raw.user } : null);
      if (fake) { await skip(m, fake); continue; }
      // an address in a contract question ("is 0x… the real contract?") gets the official line (once a day); any other
      // loose address gets nothing
      const loose = LOOSE_ADDRESS.test(m.text);
      if (loose && !CONTRACT_ASK.test(m.text)) { await skip(m, "an address outside the binding format"); continue; }
      if (phishing(m.text, m.raw.entities ? (m.raw.entities.urls ?? []).map((u) => u.expanded_url) : undefined)) { await skip(m, "scam or phishing"); continue; }
      if (m.author_id && (await sql`select 1 from x_optout where author_id = ${m.author_id}`).length) { await skip(m, "opted out"); continue; }
      if (optOutRequest(m.text)) {
        if (m.author_id) await sql`insert into x_optout (author_id) values (${m.author_id}) on conflict do nothing`;
        await skip(m, "opt-out request"); continue;
      }
      const tier = tierOf(m.raw.user ? { id: m.author_id ?? undefined, ...m.raw.user } : null);
      const d = await decide(m, tier);
      // a reader retry ("later") alerts nothing yet: the final verdict does
      // a reply's alert goes out with its text, once it is written (sendOne)
      if (tier !== "normal" && ("skip" in d || "wait" in d)) await alertMention(m, tier, "skip" in d ? `no reply (${d.skip})` : `waiting on ${d.wait}`);
      if ("wait" in d) break;
      if ("later" in d) { out[m.id] = d.later; continue; }
      if ("skip" in d) { await skip(m, d.skip); continue; }
      // which contract is the real one: the fixed answer (code text), rate-limited like any reply (decide's caps)
      if (d.kind === "official_contract" || loose) {
        // the fixed line once per author a UTC day ("ca? ca? ca?" gets it once)
        if ((await sql`select 1 from x_outbox o join x_mention x on x.id = o.reply_to where o.type = 'reply' and o.status <> 'skipped' and o.event->>'event' = 'official_reply'
          and x.author_id = ${m.author_id} and o.created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`).length) { await skip(m, "the official line went to this author today"); continue; }
        await enqueueX(`reply:${m.id}`, "reply", { event: "official_reply", tier, ...(m.author_id ? { author: m.author_id } : {}) }, { replyTo: m.id });
        out[m.id] = "official_contract";
        continue;
      }
      // an ally (important, held for the tap) is marked so the writer stays warm; a competitor so it never names an ally
      const relationship = isAlly(m.author_id) ? "ally" : tier === "competitor" ? "competitor" : undefined;
      // a competitor that came at us first may be answered by name (code's name for it, never its handle)
      const rival = relationship === "competitor" && m.author_id ? COMPETITOR_NAMES[m.author_id] : undefined;
      // the intake took it as an idea (the screen's or the judge's result): the idea reply, whatever the reader called it
      const kind = (await sql`select 1 from intake where mention_id = ${m.id} and (status in ${sql(IDEA_STATUSES)} or reason like 'near-duplicate%')`).length ? "idea" : d.kind;
      await enqueueX(`reply:${m.id}`, "reply", { event: "reply", category: kind, topic: d.topic, ...(d.question ? { question: d.question } : {}), ...(rival ? { rival } : {}), tier, ...(relationship ? { relationship } : {}), ...(d.lang ? { lang: d.lang } : {}), ...(m.author_id ? { author: m.author_id } : {}) }, { replyTo: m.id });
      out[m.id] = kind;
    }
    return out;
  },
};

// ---------------------------------------------------------------- the daily digest

/** The digest posts only on a day something happened: a rolled-over post, an experiment closed, a jackpot winner, ETH
 *  paid or DNA burned (silence when nothing happened). */
export const digestDue = (f: { total: number; survived: number; extinct: number; winners: number; ethPaid: number; dnaBurned: number }) =>
  f.total + f.survived + f.extinct + f.winners > 0 || f.ethPaid > 0 || f.dnaBurned > 0;

/** The day's numbers for the digest, from the signed announcements and the indexed chain: the
 *  generation (newest epoch), experiments survived / extinct, jackpot winners and the ETH paid, DNA burned. */
export async function dayFacts(day = new Date().toISOString().slice(0, 10)) {
  const from = new Date(`${day}T00:00:00Z`), to = new Date(from.getTime() + 86_400_000);
  const ann = (await sql<{ ref: string }[]>`select distinct ref from log where kind = 'announce' and at >= ${from} and at < ${to} and doc->>'type' in ('outcome', 'jackpot_drawn')`);
  let survived = 0, extinct = 0, winners = 0, eth = 0;
  for (const { ref } of ann) {
    const [a] = await trustedDocs<{ type: string; facts: Record<string, unknown> }>("announce", ref);
    if (!a) continue;
    if (a.type === "outcome") { if (a.facts.outcome === "kept (promoted)") survived++; else extinct++; }
    if (a.type === "jackpot_drawn") { winners += Number(a.facts.winners ?? 0); eth += Number(a.facts.prizeEth ?? 0); }
  }
  return { generation: (await latest<{ n: number }>("epoch"))?.n ?? 0, survived, extinct, winners, ethPaid: Number(eth.toFixed(3)), dnaBurned: await burnedDna(from, to) };
}

/** Whole DNA burned (every indexed DNA Transfer to 0x0: the token's own logs only) from `from` until `to` (or now). */
export async function burnedDna(from: Date, to?: Date) {
  const [{ burned }] = await sql<{ burned: string | null }[]>`select sum((args->>'value')::numeric)::text as burned from chain_log
    where event = 'Transfer' and address = ${d.token.toLowerCase()} and args->>'to' = '0x0000000000000000000000000000000000000000' and at >= ${from} ${to ? sql`and at < ${to}` : sql``}`;
  return Math.round(Number(BigInt(String(burned ?? "0").split(".")[0]) / 10n ** 18n));
}

/** Daily (23:00 UTC), one post that counts as 1 of the 25: the day's numbers (`dayFacts`) and the posts that did not
 *  fit today (rolled over, or still queued behind the cap) by kind, with the link to the full list; each of those is
 *  on the site already (announced again here if it never resolved before). */
export const digestHandler: Handler = {
  lane: "x",
  run: async (job) => {
    // at its hour only: a run caught up at boot hours later never posts a stale digest (what it would have counted
    // stays in 'digest' and goes into the next one)
    const due = typeof job.payload.due === "string" ? Date.parse(job.payload.due) : NaN;
    if (Date.now() - due > 3600_000) return `missed the digest hour (${job.payload.due}): rolled into the next one`;
    const items = await sql<Outbox[]>`select id::text, type, event_key, event, reply_to, link, created_at, errors, sig from x_outbox
      where type = 'post' and status in ('queued', 'digest') and event->>'event' not in ('digest', 'ct') order by id`;
    // counts first, then the digest (keyed by its batch: a retry after a crash enqueues the same row, never a second),
    // then the batch is marked in one statement. It posts on every day something happened, with the day's numbers
    const counts: Record<string, number> = { money: 0, games: 0, experiments: 0, other: 0 };
    const ids: string[] = [];
    for (const i of items) {
      if (!(await trusted("x_outbox", i.event_key, outboxValue(i.type, i.event, i.reply_to, i.link), i.sig))) { await setStatus(i.id, "skipped", { error: "unsigned outbox row" }); continue; }
      await announceEvent(i.event_key, i.event, i.link);
      counts[bucketOf(typeOf(i.event))]++;
      ids.push(i.id);
    }
    const total = ids.length;
    const day = new Date().toISOString().slice(0, 10);
    const facts = { event: "digest", total, ...counts, ...(await dayFacts(day)) };
    if (!digestDue(facts)) return "nothing happened today: no digest (silence when nothing happened)";
    const key = `digest:${day}:${ids[0] ?? "day"}`;
    const id = await enqueueX(key, "post", facts, { link: ANNOUNCEMENTS_URL });
    if (id) await requestArtFor(key, factSheet(facts));
    if (ids.length) await sql`update x_outbox set status = 'digested', error = null, updated_at = now() where id = any(${ids}::bigint[])`;
    return { digest: day, total };
  },
};

// ---------------------------------------------------------------- tone scout (daily)

export const scoutHandler: Handler = {
  lane: "x",
  run: async () => {
    if (!SCOUT.handles.length) return "no read-list: no tone scout";
    const fromDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const r = await scoutTone(fromDate);
    const phrases = toneBrief(r.data.phrases);
    await record("tone", "brief", { phrases, dropped: r.data.phrases.length - phrases.length, fromDate, model: r.model, at: nowIso() });
    return { phrases: phrases.length };
  },
};
