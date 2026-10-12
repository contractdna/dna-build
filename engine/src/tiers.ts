// X conversations: who the author is (tier), whether the post summoned us, and when a thread stops. Pure; the reply
// pipeline (src/x.ts) feeds it the stored mention and the thread's history.
//  - X's rules: an API reply only to a post whose author @mentioned us or quoted one of our posts (else X answers 403);
//    one reply per post; AI replies need X's written approval. Until X_AI_REPLIES_APPROVED=1, important accounts get a
//    drafted reply a signer releases with a Send tap in Telegram, and nobody else gets an AI reply. Once it is set (the
//    deploy sets it), every eligible author gets an automatic reply, important accounts too, unless X_HOLD_IMPORTANT=1.
//  - tiers come from the profile X returns with each mention: no hand-kept list except the competitors (code, ≤ 10)
//    and the allies (code): an ally is always at least important, so its replies wait for the Send tap until X approves.
import { X } from "./config.ts";
import { GATE, instructionMarkers, overlap, type XUser } from "./ideas.ts";

export type Tier = "normal" | "important" | "competitor";
/** Competitor X user ids (at most 10). Part of the code, so changing it is a reviewed release. */
export const COMPETITORS: readonly string[] = ["2105791902952067072", "2105971870097104896"];
/** A competitor's name a reply may use when that account engaged us first (id → the project's name, never a handle). */
export const COMPETITOR_NAMES: Readonly<Record<string, string>> = { "2105791902952067072": "CLAUS", "2105971870097104896": "CLAUS" };
/** Ally X user ids: the launch partner's accounts (public ids only). Part of the code, like COMPETITORS. An ally is never
 *  roasted or mocked (src/voice.ts allyIssues) and never on the competitor list (refused at load). */
export const ALLIES: readonly string[] = ["4889482985", "2081391259113938945"];
/** Why these lists can't run together (null = fine): an id on both. */
export function listsIssue(competitors: readonly string[], allies: readonly string[]): string | null {
  const both = allies.filter((id) => competitors.includes(id));
  return both.length ? `ally on the competitor list: ${both.join(", ")}` : null;
}
const listIssue = listsIssue(COMPETITORS, ALLIES);
if (listIssue) throw new Error(`tiers: ${listIssue}`);
export const isAlly = (id: string | null | undefined, allies: readonly string[] = ALLIES) => !!id && allies.includes(id);
/** Important: a badge (GATE.badges) and real reach, by followers or by how many lists carry the account. */
export const IMPORTANT = { followers: 25_000, listed: 250 };
/** Replies we send per conversation (to this author). There is no daily cap per author: every tier runs a turn per new
 *  post of theirs until a stop rule ends it, under the anti-loop brake (X.repliesPerAuthorHour to one account an hour)
 *  and the global ceilings. A competitor (often an agent itself) gets 3 turns a conversation: two bots never loop. */
export const TIERS: Record<Tier, { perConversation: number }> = {
  normal: { perConversation: Infinity },
  important: { perConversation: Infinity },
  competitor: { perConversation: 3 },
};

export function tierOf(u: XUser | null | undefined, competitors: readonly string[] = COMPETITORS, allies: readonly string[] = ALLIES): Tier {
  if (isAlly(u?.id, allies)) return "important"; // first: an ally is never a competitor, whatever list it is handed
  if (u?.id && competitors.includes(u.id)) return "competitor";
  const m = u?.public_metrics ?? {};
  const reach = (m.followers_count ?? 0) >= IMPORTANT.followers || (m.listed_count ?? 0) >= IMPORTANT.listed;
  return reach && GATE.badges.includes(u?.verified_type ?? "none") ? "important" : "normal";
}

type Summon = { entities?: { mentions?: { id?: string | null; username?: string | null }[] }; referenced_tweets?: { type: string; id: string }[] };
/** X's reply test, on the post we would answer: it @mentions our account (the mention entity's user id) or quotes one
 *  of `ours` (our posted tweet ids). No id in the entity = not summoned (fail closed: a 403 is worse than silence). */
export function summoned(m: Summon & Record<string, unknown>, self = X.userId, ours: ReadonlySet<string> = new Set()): boolean {
  if (!self) return false;
  return !!m.entities?.mentions?.some((e) => e.id === self) || !!m.referenced_tweets?.some((r) => r.type === "quoted" && ours.has(r.id));
}

/** auto = the pipeline sends it; hold = drafted, a signer taps Send; off = no reply. Approved: auto for every tier,
 *  unless `holdImportant` (X_HOLD_IMPORTANT=1) holds an important account's reply for the tap. */
export const replyPath = (tier: Tier, approved = X.aiRepliesApproved, holdImportant = X.holdImportant): "auto" | "hold" | "off" =>
  tier === "important" && (holdImportant || !approved) ? "hold" : approved ? "auto" : "off";

/** When an X id (a snowflake) was minted, in ms; null for anything else. */
export const snowflakeMs = (id: string | null | undefined) => (id && /^\d{15,20}$/.test(id) ? Number((BigInt(id) >> 22n) + 1288834974657n) : null);

/** Look-alike digits and letters folded, everything but letters and digits dropped ("C0ntract_DNA" → "contractdna"). */
const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[0@]/g, "o").replace(/[1|!]/g, "l").replace(/3/g, "e").replace(/[5$]/g, "s").replace(/4/g, "a").replace(/[^a-z0-9]/g, "");
/** Our names, as a handle or display name would copy them. */
const OURS = /contractdna|genomedna|dnagenome|^(the|real|official)*(dna|genome)(official|agent|ai|team|support|hq|token|xyz|eth|airdrop|claim|bot|help|mod|admin|desk|service|care)*$/;
const ALLY_LOOKS = /programmable|hazar(?!d)/;
/** An author shaped like us or like an ally without being them (by X id): no reply at all, whatever they post.
 *  simplification: a name containing an ally's (a staff member's "Ana | Programmable") counts too; silence is cheap. */
export function impersonator(u: XUser | null | undefined, self = X.userId, allies: readonly string[] = ALLIES): string | null {
  if (!u || (u.id && (u.id === self || allies.includes(u.id)))) return null;
  for (const n of [u.username, u.name].filter((x): x is string => !!x).map(fold)) {
    if (OURS.test(n)) return "an author shaped like this account";
    if (ALLY_LOOKS.test(n)) return "an author shaped like an ally";
  }
  return null;
}

/** A run that may be base64 and decodes to readable text with a space: hidden words. A base58 address or a CID decodes
 *  to noise. */
const base64Words = (w: string) => {
  const bytes = Buffer.from(w, "base64");
  if (bytes.length < 16) return false;
  const printable = bytes.filter((c) => (c >= 0x20 && c <= 0x7e) || c === 0x0a || c === 0x09).length;
  return printable / bytes.length >= 0.9 && bytes.includes(0x20);
};
/** Instructions aimed at the model, or text hidden in an encoding: base64 that decodes to words, morse (dots AND
 *  dashes: a run of ellipses is not morse). Addresses, tx hashes and CIDs are not one. */
export function injection(text: string) {
  const t = text.normalize("NFKC").replace(/[​-‍]/g, "").replace(/0x[0-9a-fA-F]{40,64}/g, " ");
  const base64 = (t.match(/[A-Za-z0-9+/]{24,}={0,2}/g) ?? []).some(base64Words);
  const morse = (`${t} `.match(/(?:[.\-•−–—]{1,7}[ /]+){8,}/g) ?? []).some((r) => /[.•]/.test(r) && /[-−–—]/.test(r));
  return instructionMarkers(t).length > 0 || base64 || morse;
}

/** Phishing in a mention (code, not a model): asks for a seed phrase or a private key, or a link that leaves X beside a
 *  lure (claim, airdrop, giveaway, a free mint, connect / sync / verify / migrate a wallet). `urls`: the mention's
 *  entities' expanded links, when X sent them: X puts a t.co link on every quote and every image, so only links off
 *  x.com count (without them, any link in the text does). Our own site is no link here. */
const SECRET_ASK = /\b(send|share|give|dm|enter|paste|type|input|provide|need|verify|import|drop|your|ur)\b[^.!?\n]{0,30}\b((seed|recovery|secret|mnemonic) ?phrase|private ?keys?)\b/i;
const LURE = /\b(claim\w*|airdrop\w*|giveaway|free (mint|tokens?|eth|nft)|(connect|sync|link|verify|validate|migrate|rectify|revoke) (your |ur )?wallets?|wallet ?connect)\b/i;
const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(xyz|io|app|com|net|org|finance|site|online|live|claims?|pro|fun|gg|me|top|vip|cc)\b/i;
const OURS_OR_X = /^https?:\/\/((www|mobile)\.)?(x\.com|twitter\.com|genomedna\.xyz)(\/|$)/i;
export function phishing(text: string, urls?: (string | undefined)[]) {
  const t = text.normalize("NFKC").replace(/[\u200b-\u200d]/g, "").replace(/genomedna\.xyz/gi, " ");
  // X's url entities name where each link goes; with none, any link in the text counts (fail closed)
  const linked = urls?.length ? urls.some((u) => !!u && !OURS_OR_X.test(u)) : LINK.test(t);
  return SECRET_ASK.test(t) || (linked && LURE.test(t));
}

/** `at`: when our reply went out (ms); otherwise its snowflake id says. */
export type Post = { id: string; text: string; parent?: string; at?: number };
/** Faster than this after our reply, twice in a row, is not a person typing. */
export const BOT_GAP_MS = 15_000;
/** A running thread whose first reply of ours is older than this has lost its audience. */
export const THREAD_MAX_AGE_MS = 24 * 3600_000;

/** Why this post ends the thread (null = it may get a reply). `theirs`: the author's earlier posts in this conversation,
 *  newest first; `ours`: our replies in it (none = first contact: never "audience gone", however old the post it sits
 *  under). Opt-out is checked before (it is permanent, not per thread). A post that repeats their earlier one still gets
 *  an answer (the writer answers with personality); an exact repeat within the hour is caught before (src/x.ts). */
export function stopRule(post: Post, theirs: Post[], ours: Post[], nowMs: number): string | null {
  if (injection(post.text)) return "injection attempt";
  const ourIds = new Set(ours.map((o) => o.id));
  const fast = (p?: Post) => {
    const a = snowflakeMs(p?.parent), b = snowflakeMs(p?.id);
    return !!p?.parent && ourIds.has(p.parent) && a !== null && b !== null && b >= a && b - a < BOT_GAP_MS;
  };
  if (fast(post) && fast(theirs[0])) return "automated peer";
  if (ours.some((o) => overlap(o.text, post.text) >= GATE.overlap)) return "loop";
  const started = Math.min(...ours.map((o) => o.at ?? snowflakeMs(o.id) ?? Infinity));
  if (Number.isFinite(started) && nowMs - started > THREAD_MAX_AGE_MS) return "audience gone";
  return null;
}
