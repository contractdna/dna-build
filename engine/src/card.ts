// Images on DNA's posts, enclave side. Two layers:
//  - art: generated OUTSIDE the enclave by the studio (src/studio.ts) from prompt slots this file hands it (the event
//    enum, the style + numbers, `slotsOf`; a meme also its two upper-case labels); fetched, then re-checked here
//    trusting nothing: PNG magic + IHDR, exact size, ≤ 5 MB, the style asked for, and a vision check (letters, digits,
//    logos, UI, a wallet address, NSFW → reject; a meme's words are read back and must be exactly its labels).
//  - facts: drawn HERE (`factLayer` → SVG → PNG with resvg and the site's Karrik font) from the fact sheet the post is
//    written from (the enclave's signed records and chain reads), plus the generation badge and the logo.
// The style is picked once per event (`styleFor`: by its mood, never a style of the last 3 image posts) and signed.
// The composite's sha256 + provenance go into the signed x_post record before upload (src/x.ts); a card that passes
// every check posts on its own (no human approval). The post never waits in-process: `cardFor` says "wait" until the
// art is ready, or MEDIA.waitMs passed, or the studio says none is coming (its verdict failed, or it holds no job for
// the event: its daily round cap, an outage); then a pinned fallback plate (`hash(event_key)` among the plates whose
// style is not a recent one, never the previous plate) with the same fact layer; if that fails, text only. A studio
// call that fails (an HTTP status, a timeout, no route) is alerted, once an hour per kind.
// The animated logo (pinned MP4) goes on the engine going live and the mystery seal and reveal posts; launch and
// treasury posts (PLATE_EVENTS) get a plate with the fact layer at once. The lab, the status, the reflection, the recap,
// a fee split, a buyback and burn and a site change get studio art under a borrowed scene (media-slots SCENE_OF), a
// plate when it does not come.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { z } from "zod";
import { artIssue, Caption, hasArt, MAX_BYTES, moodOf, pickStyle, SHAPES, type Shape, shapeOf, type Slots, slotsOf, type Style, STYLES } from "./media-slots.ts";
import { MEDIA } from "./config.ts";
import { edb as sql } from "./db.ts";
import { llm } from "./llm.ts";
import { mode } from "./mode.ts";
import { append, type EnclaveRow, trustedRecord } from "./log.ts";
import { latest, trustedDocs } from "./records.ts";
import { alert } from "./telegram.ts";
import { postFilter } from "./voice.ts";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export { ART_EVENTS, IMAGE_EVENTS, MAX_BYTES, artIssue, SHAPES, type Shape, shapeOf, Slots, slotsOf } from "./media-slots.ts";
/** The engine going live, the mystery seal and reveal carry the animated logo. */
export const LOGO_EVENTS = new Set(["online", "mystery_sealed", "mystery_revealed"]);
/** Launch, progress and money posts: a pinned plate with the fact layer at once (never studio art; a treasury buy or
 *  transfer is a money fact and goes out at once). */
export const PLATE_EVENTS = new Set(["contracts_connected", "keys_handed", "first_idea_round", "first_burn", "liquidity_added",
  "jackpot_params", "seq_online", "treasury_buy", "treasury_transfer"]);

// ---------------------------------------------------------------- the fact layer

export type Layer = { badge: string; headline: string; figures: { label: string; value: string }[]; addresses?: string[] };
const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 3 }) : String(v ?? "?"));
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** What the enclave draws on a card: fixed labels and the fact sheet's own numbers (the same object the signed x_post
 *  record holds), the winners' short addresses from the signed chain event, the generation badge. No model text. */
export function factLayer(facts: Record<string, unknown>, raw: Record<string, unknown>, generation: number): Layer {
  const f = (label: string, v: unknown, unit = "") => ({ label, value: `${fmt(v)}${unit}` });
  const badge = `GEN ${generation}`;
  // the post's own tx (the link code appends), shortened; it and any name go on the line above the figures (never a
  // figure column: at most 4 of those, each a short number)
  const tx = typeof raw.link === "string" ? raw.link.match(/\/tx\/(0x[0-9a-fA-F]{64})$/)?.[1] : undefined;
  const line = (...xs: (string | undefined | false)[]) => { const l = xs.filter((x): x is string => !!x); return l.length ? { addresses: l } : {}; };
  const txLine = tx ? `tx ${tx.slice(0, 6)}…${tx.slice(-4)}` : undefined;
  const some = (...xs: [string, unknown, string?][]) => xs.filter(([, v]) => typeof v === "number").map(([l, v, u]) => f(l, v, u)).slice(0, 4);
  const short = (a: unknown) => (typeof a === "string" && ADDRESS.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : undefined);
  switch (facts.event) {
    case "contracts_connected": return { badge, headline: "CONTRACTS CONNECTED", figures: [], ...line(txLine) };
    case "keys_handed": return { badge, headline: "KEYS HANDED OVER", figures: [], ...line(txLine) };
    case "first_idea_round": return { badge, headline: "FIRST IDEA", figures: [], ...line(txLine) };
    case "first_burn": return { badge, headline: "FIRST BURN", figures: [], ...line(txLine) };
    case "fees_distributed": return { badge, headline: "FEE SPLIT", figures: some(["ETH split", facts.totalEth], ["to buyback", facts.buybackEth], ["to liquidity", facts.liquidityEth], ["to games", facts.gamesEth]), ...line(txLine) };
    case "burn_summary": return { badge, headline: "BUYBACK AND BURN", figures: some(["ETH spent", facts.spentEth], ["DNA burned", facts.burnedDna], ["buybacks", facts.buybacks]), ...line(txLine) };
    case "liquidity_added": return { badge, headline: "LIQUIDITY ADDED", figures: some(["ETH added", facts.ethAdded], ["adds", facts.adds]), ...line(txLine) };
    case "progress_day": return { badge, headline: facts.hours === 24 ? "THE DAY'S WORK" : `THE LAST ${facts.hours} HOURS`, figures: some(["ETH split", facts.totalEth], ["ETH spent", facts.spentEth], ["DNA burned", facts.burnedDna], ["ETH added", facts.ethAdded]), ...line(txLine) };
    case "jackpot_params": return { badge, headline: "JACKPOT RULES", figures: [f("window", `#${fmt(facts.window)}`), ...some(["cap per wallet", facts.capPct, "%"], ["min balance", facts.minBalance, " DNA"])], ...line(txLine) };
    case "seq_online": return { badge, headline: "SEQUENCER ONLINE", figures: [] };
    case "treasury_buy": return { badge, headline: "TREASURY BUY", figures: some(["DNA bought", facts.dnaAmount], ["ETH spent", facts.ethSpent], ["of supply", facts.supplyPct, "%"]), ...line(txLine) };
    case "treasury_transfer": {
      const to = typeof facts.label === "string" ? facts.label.slice(0, 40) : short(raw.recipient);
      return { badge, headline: typeof facts.soldEth === "number" ? "TREASURY SALE" : "TREASURY TRANSFER",
        figures: some(["DNA", facts.dnaAmount], ["of supply", facts.supplyPct, "%"], ["ETH received", facts.soldEth]), ...line(to && `to ${to}`, txLine) };
    }
    case "site_changed": {
      // the page from the outbox event (the fact sheet has no url): a site path only
      const page = typeof raw.url === "string" && /^\/[\w./~-]*$/.test(raw.url) ? raw.url : "";
      return { badge, headline: "SITE UPDATED", figures: [], ...line(page && `page ${page.length > 48 ? `${page.slice(0, 47)}…` : page}`) };
    }
    case "outcome": return { badge, headline: facts.outcome === "kept (promoted)" ? "SURVIVED" : facts.outcome === "rolled back" ? "ROLLED BACK" : "EXTINCT", figures: [f("plate", facts.plate), f("swaps measured", facts.samples)] };
    case "jackpot_drawn": {
      const paid = (((raw.args ?? {}) as Record<string, unknown>).paid ?? []) as { account?: unknown }[];
      const addresses = paid.map((p) => String(p.account ?? "")).filter((w) => ADDRESS.test(w)).map((w) => `${w.slice(0, 6)}…${w.slice(-4)}`);
      return { badge, headline: facts.winners === 1 ? "GENE POOL WINNER" : "GENE POOL WINNERS", figures: [f("winners", facts.winners), f("each", facts.shareEth, " ETH"), f("window", `#${fmt(facts.window)}`)],
        addresses: addresses.length ? addresses : undefined };
    }
    case "ballot_result": return { badge, headline: "NATURAL SELECTION", figures: [f("ballot", `#${fmt(facts.ballot)}`), f("winning weight", facts.winnerWeight), f("of", facts.totalWeight)] };
    case "mystery_result": return { badge, headline: "MYSTERY", figures: [f("mystery", `#${fmt(facts.mystery)}`), f("verdict", facts.outcome === "rejected" ? "REJECTED" : "QUEUED")] };
    case "digest": return { badge, headline: "DAILY DIGEST", figures: [f("survived", facts.survived), f("extinct", facts.extinct), f("winners", facts.winners), f("ETH paid", facts.ethPaid), f("DNA burned", facts.dnaBurned)] };
    case "roast": return { badge, headline: "", figures: [] }; // the words are the post's (and a meme's own labels)
    // studio art under a borrowed scene (media-slots SCENE_OF), code's numbers on top
    case "lab": {
      const fee = ((facts.best ?? {}) as { fee?: { basePct?: unknown; multiplier?: unknown; capPct?: unknown } }).fee;
      return { badge, headline: "LAB NOTES", figures: some(["simulated", facts.tested], ["rejected", facts.rejected], ["red-team findings", facts.redTeamFindings], ["research read", facts.researchFindings]),
        ...line(fee && typeof fee.basePct === "number" && `best: base ${fmt(fee.basePct)}%  multiplier ${fmt(fee.multiplier)}x  cap ${fmt(fee.capPct)}%`) };
    }
    case "status": return { badge, headline: `LAST ${fmt(facts.hours)} HOURS`, figures: some(["swaps", facts.swaps], ["ETH volume", facts.volumeEth], ["ETH in fees", facts.feesEth], ["DNA burned", facts.burnedDna]) };
    case "reflection": return { badge, headline: "NIGHTLY REFLECTION", figures: some(["day", facts.day]) };
    case "recap": return { badge, headline: "THE WEEK", figures: some(["games shipped", facts.gamesShipped], ["kept", facts.experimentsKept], ["killed", facts.experimentsKilled], ["site changes", facts.siteChanges]) };
  }
  throw new Error(`no card for ${String(facts.event)}`);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mime = (b: Buffer) => (b[0] === 0x89 ? "image/png" : "image/jpeg");
const FONT = new URL("fonts/Karrik-Regular.ttf", MEDIA.dir).pathname;
let logo: Buffer | undefined;
/** The card as SVG: art full-bleed (cover), a dark band, the facts in Karrik, the logo bottom right. */
export function cardSvg(art: Buffer, layer: Layer, shape: Shape) {
  const { w, h } = SHAPES[shape];
  const s = w / 1536; // type scales with the width
  logo ??= readFileSync(new URL("logo.png", MEDIA.dir));
  const x = Math.round(64 * s), base = h - Math.round(64 * s);
  const figs = layer.figures.map((g, i) => {
    const fx = x + i * Math.round((shape === "square" ? 200 : 280) * s);
    return `<text x="${fx}" y="${base - Math.round(34 * s)}" font-size="${Math.round(44 * s)}" fill="#f2efe6">${esc(g.value)}</text><text x="${fx}" y="${base}" font-size="${Math.round(20 * s)}" fill="#9fb3b3" letter-spacing="2">${esc(g.label.toUpperCase())}</text>`;
  }).join("");
  const rows = layer.addresses ? Math.ceil(layer.addresses.length / 5) : 0; // 5 short addresses per line
  const top = base - Math.round((110 + rows * 40) * s);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05090b" stop-opacity="0"/><stop offset="1" stop-color="#05090b" stop-opacity="0.92"/></linearGradient></defs>
<image href="data:${mime(art)};base64,${art.toString("base64")}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>
<rect x="0" y="${Math.round(h * 0.45)}" width="${w}" height="${h - Math.round(h * 0.45)}" fill="url(#band)"/>
<text x="${x}" y="${Math.round(72 * s)}" font-size="${Math.round(22 * s)}" fill="#c9f2e4" letter-spacing="4">${esc(layer.badge)}</text>
<text x="${x}" y="${top}" font-size="${Math.round(72 * s)}" fill="#f2efe6">${esc(layer.headline)}</text>
${Array.from({ length: rows }, (_, r) => `<text x="${x}" y="${top + Math.round((46 + r * 36) * s)}" font-size="${Math.round(26 * s)}" fill="#c9f2e4">${esc(layer.addresses!.slice(r * 5, r * 5 + 5).join("   "))}</text>`).join("")}
${figs}
<image href="data:image/png;base64,${logo.toString("base64")}" x="${w - Math.round(170 * s)}" y="${h - Math.round(170 * s)}" width="${Math.round(120 * s)}" height="${Math.round(120 * s)}"/>
</svg>`;
}
/** Deterministic: the same art and facts give the same bytes (so an approval names exactly what is posted). */
export const composite = (art: Buffer, layer: Layer, shape: Shape) =>
  Buffer.from(new Resvg(cardSvg(art, layer, shape), { font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: "Karrik" }, fitTo: { mode: "original" } }).render().asPng());

// ---------------------------------------------------------------- the art re-check (trust nothing the studio says)

const Vision = z.object({ letters: z.boolean(), digits: z.boolean(), logos: z.boolean(), ui: z.boolean(), walletAddress: z.boolean(), nsfw: z.boolean() });
const VISION = "agent: media-check\nYou check an image that will be posted with text drawn over it later. Answer each question about the image itself: does it contain any letters or words (in any script, even blurred), any digits, any logo or brand mark, any user-interface element, anything that looks like a wallet address or hash, any nudity, gore or sexual content? Answer true when unsure.";
const MemeVision = z.object({ text: z.array(z.string().max(300)).max(60), digits: z.boolean(), logos: z.boolean(), ui: z.boolean(), walletAddress: z.boolean(), nsfw: z.boolean() });
// the reader is never told the intended words: it can't "read" what it expects to see
const MEME_VISION = "agent: media-check\nYou check a two-panel meme image. Transcribe every piece of text you can see anywhere in the image exactly as it is written, letter by letter: never correct a spelling, never guess a missing letter, write a letter you can't read as ?. One entry per piece of text: the left panel's label first, then the right panel's label (a label that wraps onto two lines is still one entry), then any other text anywhere, one entry each. Then answer about the image itself: does it contain any digits, any logo or brand mark, any user-interface element, anything that looks like a wallet address or hash, any nudity, gore or sexual content? Answer true when unsure.";
/** A piece of text as its word sequence: upper case, punctuation dropped (an apostrophe inside a word kept). */
const wordSeq = (s: string) => s.toUpperCase().replace(/[’‘`]/g, "'").split(/[^A-Z0-9']+/).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean).join(" ");
/** Pure: the text read off a meme against its two labels. Exactly two pieces of text, the left panel's then the right
 *  panel's, each the same word sequence as its label: a misspelling, an extra, missing, merged, duplicated or swapped
 *  label rejects (case and punctuation aside). */
export function captionIssue(read: string[], caption: readonly string[]): string | null {
  const got = read.map(wordSeq), want = caption.map(wordSeq);
  if (got.length === want.length && got.every((g, i) => g === want[i])) return null;
  return `meme text: read ${got.map((g) => `"${g.slice(0, 60)}"`).join(", ") || "nothing"}, want ${want.map((w) => `"${w}"`).join(", ")}`;
}
/** A meme caption that may go into an image: two valid labels that the post filter passes as text (no banned phrase). */
export const validCaption = (c: unknown): c is [string, string] => Caption.safeParse(c).success && postFilter((c as string[]).join(" "), new Set()).length === 0;
/** In-enclave vision check with a key the enclave already holds. Any yes, or no answer, rejects; for a meme the text it
 *  transcribes must be exactly the caption's words. */
export async function visionIssue(png: Buffer, caption?: readonly string[]): Promise<string | null> {
  try {
    const call = { agent: "media-check", model: MEDIA.visionModel, input: { task: "check the attached image" }, images: [png.toString("base64")], maxOutputTokens: caption ? 1000 : 400, effort: "low" as const };
    const r = caption ? await llm({ ...call, system: MEME_VISION, schema: MemeVision }) : await llm({ ...call, system: VISION, schema: Vision });
    const yes = Object.entries(r.data).filter(([, v]) => v === true).map(([k]) => k);
    if (yes.length) return `vision check: ${yes.join(", ")}`;
    return caption ? captionIssue((r.data as z.infer<typeof MemeVision>).text, caption) : null;
  } catch (e) {
    return `vision check failed: ${(e as Error).message.slice(0, 200)}`;
  }
}

// ---------------------------------------------------------------- the studio (outside the enclave)

export const STUDIO = {
  fetch: (url: string, init?: RequestInit, timeoutMs = 30_000) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  timeouts: { json: 5_000, art: 15_000, request: 10_000 },
  jsonMax: 64 * 1024,
};
/** Test seam: the largest card the enclave uploads (X's image limit). */
export const CARD = { maxBytes: MAX_BYTES };

/** A response body, at most `max` bytes: the declared length first, then a running count (a length can lie). */
export async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) { await res.body?.cancel().catch(() => {}); return null; }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > max) return null; // leaving the loop cancels the stream
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Pixels with any opacity in the image rendered alone (64×64): 0 = fully transparent, nothing to show. */
export function visiblePixels(img: Buffer) {
  const mime = img[0] === 0x89 ? "image/png" : "image/jpeg";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image href="data:${mime};base64,${img.toString("base64")}" width="64" height="64" preserveAspectRatio="none"/></svg>`;
  const px = new Resvg(svg, { fitTo: { mode: "original" } }).render().pixels;
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
  return n;
}
type StudioMeta = { status: string; style?: unknown; sha256: string; openaiId: string | null; studioCommit: string; refsetHash: string; scores?: unknown };
export type Provenance = { openaiId: string | null; studioCommit: string; refsetHash: string };

// ---------------------------------------------------------------- the style (picked once per event, signed)

type StyleRow = EnclaveRow & { doc: { status?: string; style?: unknown; media?: { style?: unknown } | null }; fresh: boolean };
/** The styles of the last `n` image posts, newest first, this event left out; an event whose art is still on its way
 *  (a pick under a day old) counts with the style picked for it, so two events in flight don't share one. Every row is
 *  verified (trustedRecord) before it counts; a ref's newest verified row decides it. */
export async function recentStyles(except: string, n = 3): Promise<string[]> {
  const rows = await sql<StyleRow[]>`select doc, kind, ref, body, eprev, ehash, esig, (at > now() - interval '1 day') as fresh from log
    where kind = 'x_post' and ref is not null and ref <> ${except} and doc->>'status' in ('attempt', 'dry_run', 'style')
    order by log.seq desc limit 200`;
  const seen = new Set<string>(), out: string[] = [];
  for (const r of rows) {
    if (out.length >= n) break;
    if (seen.has(r.ref!) || (r.doc.status === "style" && !r.fresh)) continue;
    if (!(await trustedRecord(r, "x_post record"))) continue;
    seen.add(r.ref!);
    const style = r.doc.status === "style" ? r.doc.style : r.doc.media?.style;
    if (typeof style === "string") out.push(style);
  }
  return out;
}
/** The event's oldest verified style pick, or undefined. Two callers that raced to pick both end up here, on one style. */
async function pickedStyle(eventKey: string): Promise<Style | undefined> {
  const rows = await sql<StyleRow[]>`select doc, kind, ref, body, eprev, ehash, esig, true as fresh from log
    where kind = 'x_post' and ref = ${eventKey} and doc->>'status' = 'style' order by log.seq`;
  for (const r of rows) if ((STYLES as readonly unknown[]).includes(r.doc.style) && (await trustedRecord(r, "x_post record"))) return r.doc.style as Style;
}
/** The style of an event's art: picked once (its mood, never a style of the last 3 image posts; the meme only for a
 *  roast with a valid caption) and kept as a signed record, so every request and re-check agrees on it. */
export async function styleFor(eventKey: string, facts: Record<string, unknown>): Promise<Style> {
  const picked = await pickedStyle(eventKey);
  if (picked) return picked;
  const mood = moodOf(facts);
  const style = pickStyle(validCaption(facts.caption) ? String(facts.event) : "", mood, await recentStyles(eventKey));
  await append("x_post", eventKey, { status: "style", style, mood });
  return (await pickedStyle(eventKey)) ?? style;
}

// ---------------------------------------------------------------- the studio's art

/** Why a studio call failed, token-free: the error's name and its cause's code (never its message, a header or the
 *  url), e.g. "TimeoutError", "TypeError ENOTFOUND". */
export const failureOf = (e: unknown) => {
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  return `${e instanceof Error ? e.name : "Error"}${typeof code === "string" ? ` ${code}` : ""}`.replace(/[^\w ]/g, "").slice(0, 60);
};
/** A studio call that failed reaches the signers' alerts (and the signed alert record), once an hour per call and
 *  reason; the post itself goes on (a plate when the art does not come). */
export async function studioFailed(call: "request" | "status" | "art", reason: string) {
  const hour = new Date().toISOString().slice(0, 13);
  await alert(`Studio ${call} failed: ${reason}. Posts waiting for art get a plate instead.`, `alert:studio:${call}:${reason}:${hour}`).catch(() => {});
}
/** A studio fetch: the response, or null with the failure alerted (a 404 is an answer, not a failure). */
async function studioCall(call: "request" | "status" | "art", url: string, init: RequestInit | undefined, timeoutMs: number) {
  const r = await STUDIO.fetch(url, init, timeoutMs).catch(async (e) => { await studioFailed(call, failureOf(e)); return null; });
  if (r && !r.ok && (r.status !== 404 || call === "request")) await studioFailed(call, `HTTP ${r.status}`);
  return r;
}

/** Ask for art (idempotent per event key; best effort: the next send tick asks again). STUDIO_TOKEN (a sealed allowed
 *  env) authenticates the enclave to the studio. Never while halted: the studio's image models cost money too. */
export async function requestArt(eventKey: string, slots: Slots, shape: Shape) {
  if (!MEDIA.studioUrl || (await mode()) === "halted") return false;
  const r = await studioCall("request", `${MEDIA.studioUrl}/request`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${MEDIA.studioToken ?? ""}` }, body: JSON.stringify({ eventKey, slots, shape }) }, STUDIO.timeouts.request);
  return !!r?.ok;
}
/** At enqueue: an art post picks its style and asks for its art the moment the event is known, so the studio has the
 *  whole post spacing to deliver it. */
export async function requestArtFor(eventKey: string, facts: Record<string, unknown>) {
  const ev = String(facts.event);
  if (!MEDIA.studioUrl || !hasArt(ev)) return false;
  return styleFor(eventKey, facts).then((style) => requestArt(eventKey, slotsOf(facts, eventKey, style), shapeOf(ev))).catch(() => false);
}

/** The studio's art for an event, re-checked; null = not ready or rejected; "failed" = the studio's verdict (final:
 *  it never tries that event again); "unknown" = it holds no job for the event (its daily round cap, an outage or a
 *  restart drop a request without a verdict). The verdict on art is cached per art hash in a signed x_post record, so
 *  art that failed doesn't re-run the vision check every minute. */
async function studioArt(eventKey: string, shape: Shape, style: Style, caption: unknown): Promise<{ png: Buffer; provenance: Provenance } | "failed" | "unknown" | null> {
  if (!MEDIA.studioUrl) return null;
  const path = `${MEDIA.studioUrl}/studio/${encodeURIComponent(eventKey)}`;
  const m = await studioCall("status", `${path}.json`, undefined, STUDIO.timeouts.json);
  if (!m) return null;
  const mb = await readCapped(m, STUDIO.jsonMax);
  if (!mb) return null;
  let meta: StudioMeta;
  try { meta = JSON.parse(mb.toString("utf8")) as StudioMeta; } catch { return null; }
  if (m.ok && meta?.status === "failed") return "failed";
  if (m.status === 404 && meta?.status === "unknown") return "unknown";
  if (!m.ok || meta?.status !== "ready") return null;
  const p = await studioCall("art", `${path}.art`, undefined, STUDIO.timeouts.art);
  if (!p?.ok) return null;
  const png = await readCapped(p, MAX_BYTES);
  if (!png) return null; // over 5 MB: never read further
  const art = sha256(png);
  const done = (await trustedDocs<{ status: string; art?: string; issue?: string | null }>("x_post", eventKey, 20)).find((r) => r.status === "art-check" && r.art === art);
  const meme = style === "meme";
  const issue = done ? done.issue ?? null : artIssue(png, shape) ?? (visiblePixels(png) === 0 ? "fully transparent" : null)
    ?? (meta.style !== style ? `style ${String(meta.style).slice(0, 20)}, asked ${style}` : null)
    ?? (meme && !validCaption(caption) ? "a meme without a valid caption" : null)
    ?? (await visionIssue(png, meme ? (caption as [string, string]) : undefined));
  // a verdict is cached per art hash; a vision check that could not run is not a verdict (it runs again)
  if (!done && !issue?.startsWith("vision check failed")) await append("x_post", eventKey, { status: "art-check", art, issue });
  return issue ? null : { png, provenance: { openaiId: typeof meta.openaiId === "string" ? meta.openaiId.slice(0, 200) : null, studioCommit: String(meta.studioCommit).slice(0, 64), refsetHash: String(meta.refsetHash).slice(0, 64) } };
}

// ---------------------------------------------------------------- plates and the logo (pinned in the image)

type Plate = { file: string; sha256: string; style?: Style };
type Manifest = { placeholder: boolean; plates: Plate[] };
/** A plate's style (the placeholder set predates styles: it is lab-like). */
export const plateStyle = (p: { style?: Style }): Style => p.style ?? "lab";
/** The pinned plates, each checked against the manifest's sha256 (a swapped file is never drawn). */
export function plates(): Manifest & { bytes: (i: number) => Buffer } {
  const m = JSON.parse(readFileSync(new URL("plates/manifest.json", MEDIA.dir), "utf8")) as Manifest;
  return { ...m, bytes: (i) => {
    const b = readFileSync(new URL(`plates/${m.plates[i].file}`, MEDIA.dir));
    if (sha256(b) !== m.plates[i].sha256) throw new Error(`plate ${m.plates[i].file} does not match the manifest`);
    return b;
  } };
}
/** hash(event_key) mod the plates whose style is not one of the last 3 image posts' (`recent`), never the plate the
 *  previous plate post used; with none of those left, any plate but the previous one (a plate beats text only). */
export function plateIndex(eventKey: string, set: readonly { file: string; style?: Style }[], previous: string | null, recent: readonly string[]) {
  const all = set.map((_, i) => i);
  const fresh = all.filter((i) => set[i].file !== previous);
  const fits = fresh.filter((i) => !recent.slice(0, 3).includes(plateStyle(set[i])));
  const pool = fits.length ? fits : fresh.length ? fresh : all;
  return pool[parseInt(sha256(eventKey).slice(0, 8), 16) % pool.length];
}
export const LOGO_MP4 = new URL("dna-logo.mp4", MEDIA.dir);
/** Events the studio held no job for on a send tick and that were asked for again then (the request reached it): still
 *  none on the next tick means none is coming (process memory: after a restart an event is asked once more). */
const unheard = new Set<string>();

// ---------------------------------------------------------------- the decision

export type Card =
  | { kind: "image"; png: Buffer; sha256: string; source: "studio" | "plate"; style?: Style; provenance?: Provenance; plate?: string; layer: Layer }
  | { kind: "video"; buf: Buffer; sha256: string; source: "logo" }
  | { kind: "none"; why: string };
/** What goes on a post, or "wait" (the item stays queued; the send loop moves on). Art that passed every check posts. */
export async function cardFor(eventKey: string, createdAt: Date, raw: Record<string, unknown>, facts: Record<string, unknown>, now = Date.now()): Promise<Card | "wait"> {
  const ev = String(facts.event);
  if (LOGO_EVENTS.has(ev)) {
    try { const buf = readFileSync(LOGO_MP4); return { kind: "video", buf, sha256: sha256(buf), source: "logo" }; } catch (e) { return { kind: "none", why: `logo: ${(e as Error).message}` }; }
  }
  const plateOnly = PLATE_EVENTS.has(ev);
  if (!plateOnly && !hasArt(ev)) return { kind: "none", why: "no image for this event" };
  const shape = shapeOf(ev);
  let layer: Layer;
  try { layer = factLayer(facts, raw, (await latest<{ n: number }>("epoch"))?.n ?? 0); } catch (e) { return { kind: "none", why: (e as Error).message }; }
  let plateNow = false;
  if (MEDIA.studioUrl && !plateOnly) {
    try {
      const style = await styleFor(eventKey, facts);
      const art = await studioArt(eventKey, shape, style, facts.caption);
      // no art is coming: a failed verdict, or still no job after a request that reached it (its daily round cap, a
      // generation error: alerted): the plate now
      const dropped = art === "unknown" && unheard.has(eventKey);
      if (art !== "unknown" || dropped) unheard.delete(eventKey);
      if (dropped) await studioFailed("request", "no job after a request, its round cap or a generation error");
      if (art === "failed" || dropped) plateNow = true;
      else if (art === "unknown") { if (await requestArt(eventKey, slotsOf(facts, eventKey, style), shape)) unheard.add(eventKey); }
      else if (art) {
        const png = composite(art.png, layer, shape);
        if (png.length <= CARD.maxBytes) return { kind: "image", png, sha256: sha256(png), source: "studio", style, provenance: art.provenance, layer };
        plateNow = true; // too big for X: the plate goes now (waiting won't shrink it)
      } else await requestArt(eventKey, slotsOf(facts, eventKey, style), shape);
    } catch (e) {
      console.error(`card ${eventKey}:`, (e as Error).message);
    }
    if (!plateNow && now - createdAt.getTime() < MEDIA.waitMs) return "wait";
  } // no studio configured, or a plate event: nothing to wait for, the plate goes at once
  try {
    const p = plates();
    const [prev] = await sql<{ plate: string | null }[]>`select doc->'media'->>'plate' as plate from log where kind = 'x_post' and doc->'media'->>'source' = 'plate' order by log.seq desc limit 1`;
    const i = plateIndex(eventKey, p.plates, prev?.plate ?? null, await recentStyles(eventKey));
    const png = composite(p.bytes(i), layer, shape);
    if (png.length > CARD.maxBytes) return { kind: "none", why: `plate card ${png.length} bytes: over ${CARD.maxBytes}` };
    return { kind: "image", png, sha256: sha256(png), source: "plate", style: plateStyle(p.plates[i]), plate: p.plates[i].file, layer };
  } catch (e) {
    return { kind: "none", why: `plate failed: ${(e as Error).message.slice(0, 200)}` };
  }
}
/** What the signed x_post record says about the media (written before the upload). */
export const mediaRecord = (c: Card | null) => (!c || c.kind === "none" ? (c ? { kind: "none", why: c.why } : null)
  : c.kind === "video" ? { kind: "video", sha256: c.sha256, source: c.source, bytes: c.buf.length }
  : { kind: "image", sha256: c.sha256, source: c.source, style: c.style ?? null, provenance: c.provenance ?? null, plate: c.plate ?? null, layer: c.layer, bytes: c.png.length });
