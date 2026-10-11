// The media studio: a worker OUTSIDE the enclave, the only holder of the OpenAI key. The enclave POSTs /request
// {eventKey, slots, shape} with its bearer token (slots: the event enum, the style + numbers, validated strictly here;
// a meme also carries its two upper-case labels); the studio generates up to ROUNDS × CANDIDATES images with OpenAI
// Images (`edits` with the style references for the lab style, `generations` for every other style), drops any that
// fail the size check, OpenAI's moderation, the near-duplicate check (perceptual hash vs every image it ever generated;
// fallback plates are not in that set) or the vision rubric (on brand, clean, room for the caption, original against
// the studio's last 3 arts; no text, except a meme's labels, which the enclave reads back word by word), and publishes
// the best one at /studio/<eventKey>.art (JPEG q90) with its scores and provenance (/studio/<eventKey>.json). It holds
// no other key and decides nothing: the enclave re-checks every byte. No OCR (it hallucinates glyphs in film grain).
// Files older than TTL_DAYS are cleaned up (the near-duplicate hashes stay).
// Run: node src/studio.ts (Railway: engine/studio.railway.json). Env: OPENAI_API_KEY, OPENAI_API_BASE (tests: the
// fakes), OPENAI_IMAGE_MODEL (pinned: gpt-image-2.5-sunburst), OPENAI_RUBRIC_MODEL, STUDIO_TOKEN (the enclave's
// bearer; the studio refuses to run without it), STUDIO_DIR (a volume), STUDIO_DAILY_ROUNDS (cost cap), PORT;
// optional STUDIO_VIA=openrouter + OPENROUTER_API_KEY_STUDIO (+ OPENROUTER_API_BASE in tests): images and the rubric
// through OpenRouter, pinned to OpenAI (the pinned image model is listed there); moderation stays on OpenAI;
// optional STUDIO_PROMPTS: base64 of `# Prompt studio.<id>` sections, the prompt text (studio.base, studio.hero,
// studio.style.<style>, studio.scene.<event> with "_" spelled "-", studio.plate.1-4, studio.rubric, studio.banned one
// term a line); an id it leaves out keeps its neutral default below, and a malformed value stops the studio starting.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { z } from "zod";
import { promptSections } from "./enclave.ts";
import { post } from "./http.ts";
import { artIssue, IMAGE_EVENTS, SHAPES, type Shape, Slots, STYLES, type Style } from "./media-slots.ts";

/** A positive number from the env, else the default: a typo (NaN) must never switch a cap off. */
export const posNum = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : d; };

const env = process.env;
/** The studio's models when no env var overrides them (the site's model table lists these). */
export const STUDIO_DEFAULTS = { model: "gpt-image-2.5-sunburst", rubricModel: "gpt-5.5" } as const;
export const STUDIO = {
  api: env.OPENAI_API_BASE ?? "https://api.openai.com",
  key: env.OPENAI_API_KEY,
  model: env.OPENAI_IMAGE_MODEL ?? STUDIO_DEFAULTS.model, // pinned
  rubricModel: env.OPENAI_RUBRIC_MODEL ?? STUDIO_DEFAULTS.rubricModel,
  // STUDIO_VIA=openrouter: images and the rubric through OpenRouter (pinned to OpenAI, no fallback) on its own key;
  // moderation stays on OpenAI (free; OpenRouter has none), so OPENAI_API_KEY is still needed. Default: OpenAI direct.
  via: env.STUDIO_VIA === "openrouter" ? "openrouter" : "openai",
  openrouterApi: env.OPENROUTER_API_BASE ?? "https://openrouter.ai/api",
  openrouterKey: env.OPENROUTER_API_KEY_STUDIO,
  dir: env.STUDIO_DIR ?? "./studio-data",
  commit: env.RAILWAY_GIT_COMMIT_SHA ?? env.STUDIO_COMMIT ?? "dev",
  candidates: 3, rounds: 2, minScore: 7, dupDistance: 10,
  dailyRounds: posNum(env.STUDIO_DAILY_ROUNDS, 20), // 7 events × 2 rounds + slack: a hard cost ceiling
  token: env.STUDIO_TOKEN,
  ttlDays: 14,
  recent: 3, // the studio's last arts the rubric compares a candidate with (originality)
  refs: new URL("../media/references/", import.meta.url),
};
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- the prompts (STUDIO_PROMPTS)

/** Section ids allow no underscore: an event's scene id spells it with a dash (studio.scene.jackpot-drawn). */
type Dash<S extends string> = S extends `${infer A}_${infer B}` ? `${A}-${Dash<B>}` : S;
/** Neutral defaults: plain and functional. The live prompt text comes from STUDIO_PROMPTS (base64 of `# Prompt
 *  studio.<id>` sections, src/enclave.ts promptSections); each id it leaves out keeps its default here. */
const DEFAULT_PROMPTS: Record<"studio.base" | "studio.hero" | "studio.rubric" | "studio.banned" | `studio.style.${Style}` | `studio.scene.${Dash<Slots["event"]>}` | `studio.plate.${1 | 2 | 3 | 4}`, string> = {
  "studio.base": "An image for DNA, a crypto project run by an AI, whose emblem is the DNA double helix. Accent colours: cyan, green and amber, used sparingly. Keep the lower-left third quiet and empty so a caption fits there. Do not show real people, real brands, coins, rockets or robots.",
  "studio.hero": "The double helix is the main subject.",
  "studio.style.lab": "Night-time photograph in a dim laboratory: a double helix inside glassware, glowing from tiny points of light in cyan, green and amber. Shallow focus, soft bokeh, light film grain, realistic glass and optics. Mood: quiet, precise, alive.",
  "studio.style.meme": "A meme in two panels next to each other, divided by a narrow vertical rule, flat illustration on a dark background. Left: the competitor's approach, muddled and dull. Right: the double helix as a bright cyan and amber character, relaxed and ahead. Above each panel, a dark band holding one short label in bold white capital letters.",
  "studio.style.riso": "Risograph print using two or three spot colours (cyan, green, amber) on cream paper: large flat forms, grainy ink, layers slightly out of register, lots of blank paper.",
  "studio.style.blueprint": "Technical blueprint: thin white and cyan lines on dark blue paper, the double helix drafted like an engineered part with guide lines, section views and tick marks without labels, small touches of amber.",
  "studio.style.clay": "Macro photo of a small handmade clay scene: the double helix modelled in matte cyan, green and amber clay on a miniature set, visible fingerprints, soft warm lighting, shallow focus.",
  "studio.style.etching": "Antique engraved plate from a natural-history book: dense cross-hatched ink lines on cream paper, the double helix shown as a specimen, with light hand-painted tints of cyan, green and amber.",
  "studio.style.film": "Still frame from a 35mm movie: the double helix as a luminous sculpture in a real location at twilight, anamorphic look, organic grain, teal and amber colour grade, shallow focus.",
  "studio.scene.outcome": "A single double helix after an experiment, the clear centre of the frame.",
  "studio.scene.jackpot-drawn": "A double helix drawing ten bright sparks up out of a faint cloud of particles.",
  "studio.scene.ballot-result": "Three double helices in a row; the winner is taller and glows more than the others.",
  "studio.scene.mystery-result": "A double helix enclosed in a sealed glass capsule, wisps of mist around it.",
  "studio.scene.digest": "A double helix at dusk, with little clusters of light around it as the glow dims.",
  "studio.scene.roast": "The double helix, calm and self-assured, beside a dreary rival that promises too much (fictional, no logo).",
  "studio.plate.1": "The double helix on its own, standing upright on the right side, viewed head-on at eye level, evenly and softly lit.",
  "studio.plate.2": "The double helix viewed from below, climbing from the bottom centre toward the top right, backlit so its strands carry a bright rim.",
  "studio.plate.3": "A tiny double helix in the distance on the right third of a broad, open, mostly empty scene, side light throwing a long soft shadow.",
  "studio.plate.4": "Very close up on the double helix: two crossing strands fill the right half, cut off by the frame edges, the surroundings dark except for the helix's glow.",
  "studio.rubric": "Rate one generated image for a brand whose emblem is a double helix, with cyan, green and amber accents. Give integers from 0 to 10 for: onBrand (the helix is the main subject, the accents appear, and it fits the style named in the message), clean (free of defects such as warped shapes, smears, bad hands or impossible glass and physics), room (the lower-left third is quiet enough to carry a caption), original (not stock-looking or generic, and clearly different in composition and framing from the recent images sent after the candidate). Set text to true when the image shows lettering, numerals, logos or UI elements.",
  "studio.banned": "text\nletters\ndigits\nlogos\nwatermarks\nfaces\nhands\ncoins\nrobots",
};
/** STUDIO_PROMPTS over the defaults. Set but malformed (not base64, not `# Prompt <id>` sections, an id the studio
 *  does not know, so also a fifth plate) throws: the studio refuses to start rather than run on half its prompts. */
export function studioPrompts(env: Record<string, string | undefined>): Record<string, string> {
  if (!env.STUDIO_PROMPTS) return { ...DEFAULT_PROMPTS };
  const s = /^[A-Za-z0-9+/=\s]+$/.test(env.STUDIO_PROMPTS) ? promptSections(Buffer.from(env.STUDIO_PROMPTS, "base64").toString("utf8")) : null;
  if (!s) throw new Error("STUDIO_PROMPTS: not base64 of `# Prompt studio.<id>` sections");
  const unknown = Object.keys(s).filter((id) => !(id in DEFAULT_PROMPTS));
  if (unknown.length) throw new Error(`STUDIO_PROMPTS: unknown ids ${unknown.join(", ")}`);
  return { ...DEFAULT_PROMPTS, ...s };
}
const PROMPTS = studioPrompts(env);
/** Every prompt starts here, whatever the style. */
export const BASE = PROMPTS["studio.base"];
const HERO = PROMPTS["studio.hero"];
export const STYLE_PROMPTS = Object.fromEntries(STYLES.map((s) => [s, PROMPTS[`studio.style.${s}`]])) as Record<Style, string>;
export const BANNED = PROMPTS["studio.banned"].split("\n").map((b) => b.trim()).filter(Boolean);
/** The meme carries its two labels (and its helix may be a character): everything else stays banned. */
export const bannedFor = (style: Style) => (style === "meme" ? BANNED.filter((b) => !["text", "letters", "faces", "hands"].includes(b)) : BANNED);
const SCENE = Object.fromEntries(IMAGE_EVENTS.map((e) => [e, PROMPTS[`studio.scene.${e.replaceAll("_", "-")}`]])) as Record<Slots["event"], string>;
/** Fallback plates (scripts/plates.ts) fit any event: the helix alone, no event's props. Plate N of every style gets
 *  scene N, each a different framing, scale and light, so a style's 4 plates differ from each other. */
export const PLATE_SCENES = [1, 2, 3, 4].map((n) => PROMPTS[`studio.plate.${n}`]);
/** A plates run: one candidate a round, three rounds, and the rubric judges originality on the image alone (no recent
 *  arts), so a style's 4 plates are never failed as repeats of each other. Live posting keeps STUDIO.recent. */
export const PLATE_RUN = { candidates: 1, rounds: 3, recent: 0 };
const grade = (x: number, words: [string, string, string]) => words[x < 0.34 ? 0 : x < 0.67 ? 1 : 2];
/** Slots → prompt. The brand base, the style, the event's fixed scene (a plate brings its own), words chosen by the
 *  numbers and, for a meme, its two validated labels: nothing else reaches the model. */
export function promptOf(s: Slots, round = 0, scene = SCENE[s.event]) {
  return [
    BASE, HERO, STYLE_PROMPTS[s.style], scene,
    ...(s.caption ? [`The two labels, spelled exactly, letter for letter: left panel "${s.caption[0]}", right panel "${s.caption[1]}". No other text anywhere in the image.`] : []),
    `Growth: ${grade(s.growth, ["dormant", "budding", "blooming, spreading new branches"])}.`,
    `Decay: ${grade(s.decay, ["none, healthy", "some parts fading", "wilting, dissolving into dark sediment"])}.`,
    `Light: ${grade(s.light, ["faint glow", "steady glow", "brilliant, light pouring out"])}.`,
    `Composition variation ${s.seed % 997}-${round}.`,
    `Never: ${bannedFor(s.style).join(", ")}.`,
  ].join("\n");
}

// ---------------------------------------------------------------- OpenAI (plain HTTP, no SDK)

export type Rubric = { onBrand: number; clean: number; room: number; original: number; text: boolean };
const Score = z.number().int().min(0).max(10);
const RubricSchema = z.object({ onBrand: Score, clean: Score, room: Score, original: Score, text: z.boolean() });
const RUBRIC = PROMPTS["studio.rubric"];
const auth = () => ({ authorization: `Bearer ${STUDIO.key ?? ""}` });
const dataUrl = (img: Buffer) => `data:${img[0] === 0x89 ? "image/png" : "image/jpeg"};base64,${img.toString("base64")}`;
const RUBRIC_FORMAT = { type: "json_schema", json_schema: { name: "rubric", strict: true, schema: { type: "object", additionalProperties: false, required: ["onBrand", "clean", "room", "original", "text"],
  properties: { onBrand: { type: "integer" }, clean: { type: "integer" }, room: { type: "integer" }, original: { type: "integer" }, text: { type: "boolean" } } } } };
/** The vision rubric on a chat-completions endpoint (OpenAI's or OpenRouter's): the candidate first, then the recent arts. */
async function rubricAt(url: string, headers: Record<string, string>, model: string, png: Buffer, recent: Buffer[], style: Style, extra: Record<string, unknown> = {}): Promise<Rubric> {
  const res = await fetch(url, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, signal: AbortSignal.timeout(5 * 60_000),
    body: JSON.stringify({
      model, ...extra, response_format: RUBRIC_FORMAT,
      messages: [{ role: "system", content: RUBRIC }, { role: "user", content: [{ type: "text", text: `The style asked for: ${style} (${STYLE_PROMPTS[style]}) The candidate, then ${recent.length} recent images.` }, ...[png, ...recent].map((b) => ({ type: "image_url", image_url: { url: dataUrl(b) } }))] }],
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[] };
  if (!res.ok) throw new Error(`rubric ${res.status}`);
  return RubricSchema.parse(JSON.parse(body.choices?.[0]?.message?.content ?? "null"));
}
const imagesOf = (body: { data?: { b64_json?: string }[] }) => (body.data ?? []).flatMap((d) => (d.b64_json ? [Buffer.from(d.b64_json, "base64")] : []));
// JPEG q90 keeps a card (art + facts) well under X's 5 MB; the enclave accepts PNG or JPEG
const OUT = { quality: "high", output_format: "jpeg", output_compression: 90 };

export type StudioClient = {
  /** n candidates at `size`; `refs` (the lab style's references) go with the call when there are any. */
  images(prompt: string, refs: Buffer[], n: number, size: string): Promise<{ requestId: string | null; images: Buffer[]; usage: unknown }>;
  flagged(png: Buffer): Promise<boolean>;
  rubric(png: Buffer, recent: Buffer[], style: Style): Promise<Rubric>;
};
export const openai: StudioClient = {
  /** Images `edits` with every reference attached, or `generations` when there are none. Not fetch: n high-quality
   *  images can pass its 300 s header limit before the reply starts (http.ts). */
  async images(prompt: string, refs: Buffer[], n: number, size: string) {
    let res: Response;
    if (refs.length) {
      const form = new FormData();
      for (const [k, v] of Object.entries({ model: STUDIO.model, prompt, n, size, ...OUT })) form.set(k, String(v));
      refs.forEach((r, i) => form.append("image[]", new Blob([new Uint8Array(r)], { type: r[0] === 0x89 ? "image/png" : "image/jpeg" }), `ref-${i}.${r[0] === 0x89 ? "png" : "jpg"}`));
      res = await post(`${STUDIO.api}/v1/images/edits`, form, 10 * 60_000, auth());
    } else {
      res = await post(`${STUDIO.api}/v1/images/generations`, JSON.stringify({ model: STUDIO.model, prompt, n, size, ...OUT }), 10 * 60_000, { ...auth(), "content-type": "application/json" });
    }
    const body = (await res.json().catch(() => ({}))) as { data?: { b64_json?: string }[]; usage?: unknown };
    if (!res.ok) throw new Error(`OpenAI images ${res.status}`);
    return { requestId: res.headers.get("x-request-id"), images: imagesOf(body), usage: body.usage ?? null };
  },
  /** OpenAI's (free) moderation endpoint on one image. */
  async flagged(png: Buffer) {
    const res = await fetch(`${STUDIO.api}/v1/moderations`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ model: "omni-moderation-latest", input: [{ type: "image_url", image_url: { url: dataUrl(png) } }] }), signal: AbortSignal.timeout(60_000) });
    const body = (await res.json().catch(() => ({}))) as { results?: { flagged: boolean }[] };
    if (!res.ok || !body.results?.length) throw new Error(`OpenAI moderation ${res.status}`);
    return body.results.some((r) => r.flagged);
  },
  rubric: (png: Buffer, recent: Buffer[], style: Style) => rubricAt(`${STUDIO.api}/v1/chat/completions`, auth(), STUDIO.rubricModel, png, recent, style),
};

/** The same models through OpenRouter, served by OpenAI only (no fallback provider). */
const orAuth = () => ({ authorization: `Bearer ${STUDIO.openrouterKey ?? ""}` });
const OPENAI_ONLY = { provider: { order: ["openai"], allow_fallbacks: false } };
export const openrouter: StudioClient = {
  /** OpenRouter's image API: the references (if any) as input_references, n candidates at `size`. */
  async images(prompt: string, refs: Buffer[], n: number, size: string) {
    const res = await post(`${STUDIO.openrouterApi}/v1/images`, JSON.stringify({ model: `openai/${STUDIO.model}`, prompt, n, size, ...OUT,
      ...(refs.length ? { input_references: refs.map((r) => ({ type: "image_url", image_url: { url: dataUrl(r) } })) } : {}), ...OPENAI_ONLY }), 10 * 60_000, { ...orAuth(), "content-type": "application/json" });
    const body = (await res.json().catch(() => ({}))) as { id?: string; data?: { b64_json?: string }[]; usage?: unknown };
    if (!res.ok) throw new Error(`OpenRouter images ${res.status}`);
    return { requestId: body.id ?? null, images: imagesOf(body), usage: body.usage ?? null };
  },
  flagged: openai.flagged, // OpenRouter has no moderation endpoint: OpenAI's (free) one stays
  rubric: (png: Buffer, recent: Buffer[], style: Style) => rubricAt(`${STUDIO.openrouterApi}/v1/chat/completions`, orAuth(), `openai/${STUDIO.rubricModel}`, png, recent, style, OPENAI_ONLY),
};
/** The client the studio runs (STUDIO_VIA). */
export const activeClient = (): StudioClient => (STUDIO.via === "openrouter" ? openrouter : openai);

// ---------------------------------------------------------------- perceptual hash (near-duplicates)

/** 64-bit DCT perceptual hash: the image scaled to 32×32 grey (resvg), the top-left 8×8 DCT block against its median. */
export function phash(img: Buffer): bigint {
  const N = 32;
  const mime = img[0] === 0x89 ? "image/png" : "image/jpeg";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}"><image href="data:${mime};base64,${img.toString("base64")}" width="${N}" height="${N}" preserveAspectRatio="none"/></svg>`;
  const px = new Resvg(svg, { fitTo: { mode: "original" } }).render().pixels;
  const g = Array.from({ length: N * N }, (_, i) => 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2]);
  const dct: number[] = [];
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    let s = 0;
    for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) s += g[x * N + y] * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N)) * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * N));
    dct.push(s);
  }
  const ac = dct.slice(1);
  const median = [...ac].sort((a, b) => a - b)[Math.floor(ac.length / 2)];
  return dct.reduce((h, c, i) => (c > median ? h | (1n << BigInt(i)) : h), 0n);
}
export const hamming = (a: bigint, b: bigint) => { let x = a ^ b, n = 0; for (; x; x &= x - 1n) n++; return n; };

// ---------------------------------------------------------------- the gate

// ---------------------------------------------------------------- the gate

export type Meta = { status: "ready" | "failed"; eventKey: string; style?: Style; sha256?: string; openaiId: string | null; studioCommit: string; refsetHash: string; model: string; scores?: Rubric; phash?: string; reasons?: string[]; usage?: unknown[]; at: string };
const idOf = (eventKey: string) => sha256(eventKey).slice(0, 32);
const fileOf = (eventKey: string, ext: string) => join(STUDIO.dir, `${idOf(eventKey)}.${ext}`);

export function references() {
  mkdirSync(STUDIO.dir, { recursive: true });
  const files = readdirSync(STUDIO.refs).filter((f) => /\.(png|jpe?g)$/.test(f)).sort();
  const refs = files.map((f) => readFileSync(new URL(f, STUDIO.refs)));
  return { refs, refsetHash: refsetHashOf(refs) };
}
const refsetHashOf = (refs: Buffer[]) => sha256(refs.map((r) => sha256(r)).join("\n"));
/** The studio's last arts (newest first, whether or not they were posted): what a candidate must not repeat. */
function recentArts(n = STUDIO.recent) {
  if (!existsSync(STUDIO.dir)) return [];
  return readdirSync(STUDIO.dir).filter((f) => /^[0-9a-f]{32}\.art$/.test(f)).map((f) => ({ f, t: statSync(join(STUDIO.dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t).slice(0, n).map(({ f }) => readFileSync(join(STUDIO.dir, f)));
}
const hashesFile = () => join(STUDIO.dir, "phashes.json");
const known = (): bigint[] => (existsSync(hashesFile()) ? (JSON.parse(readFileSync(hashesFile(), "utf8")) as string[]).map((h) => BigInt(h)) : []);
const remember = (h: bigint) => writeFileSync(hashesFile(), JSON.stringify([...known().map(String), String(h)]));
const roundsFile = () => join(STUDIO.dir, `rounds-${new Date().toISOString().slice(0, 10)}.json`);
const roundsToday = () => (existsSync(roundsFile()) ? Number(readFileSync(roundsFile(), "utf8")) || 0 : 0);
/** Take one round of today's budget, or false at the cap. Synchronous (read, check, write with no await between), so
 *  concurrent generates in this process can never overshoot the cap. */
export function claimRound(): boolean {
  const n = roundsToday();
  if (n >= STUDIO.dailyRounds) return false;
  writeFileSync(roundsFile(), String(n + 1));
  return true;
}
/** Constant-time bearer check (fail closed without a configured token). */
export function authorized(header: string | undefined) {
  if (!STUDIO.token) return false;
  const a = Buffer.from(header ?? ""), b = Buffer.from(`Bearer ${STUDIO.token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Generate, gate, publish. The best passing candidate (sum of the rubric) wins; none → a 'failed' record with why.
 *  The daily cap is not a verdict: nothing is written and a later request tries again. `prompt` defaults to the
 *  slots' prompt (scripts/plates.ts passes a plate's). */
export async function generate(eventKey: string, slots: Slots, shape: Shape, client = activeClient(), prompt = (round: number) => promptOf(slots, round)): Promise<Meta> {
  const refs = slots.style === "lab" ? references().refs : []; // the references pin the lab look; any other style would drift toward it
  mkdirSync(STUDIO.dir, { recursive: true });
  const { w, h } = SHAPES[shape];
  const reasons: string[] = [];
  const usage: unknown[] = [];
  const base = { eventKey, style: slots.style, studioCommit: STUDIO.commit, refsetHash: refsetHashOf(refs), model: STUDIO.model };
  const recent = recentArts();
  let lastId: string | null = null;
  let capped = false;
  for (let round = 0; round < STUDIO.rounds; round++) {
    if (!claimRound()) {
      reasons.push(`daily cap of ${STUDIO.dailyRounds} rounds reached`);
      capped = true;
      break;
    }
    const r = await client.images(prompt(round), refs, STUDIO.candidates, `${w}x${h}`);
    lastId = r.requestId;
    usage.push(r.usage);
    const seen = known();
    const ok: { png: Buffer; scores: Rubric; ph: bigint }[] = [];
    for (const [i, png] of r.images.entries()) {
      const tag = `round ${round} candidate ${i}`;
      const bad = artIssue(png, shape);
      if (bad) { reasons.push(`${tag}: ${bad}`); continue; }
      if (await client.flagged(png)) { reasons.push(`${tag}: moderation`); continue; }
      const ph = phash(png);
      const near = [...seen, ...ok.map((o) => o.ph)].find((k) => hamming(k, ph) <= STUDIO.dupDistance);
      if (near !== undefined) { reasons.push(`${tag}: near-duplicate (distance ${hamming(near, ph)})`); continue; }
      const scores = await client.rubric(png, recent, slots.style);
      // a meme's labels are text by design: the enclave reads them back word by word (src/card.ts captionIssue)
      if (scores.text && slots.style !== "meme") { reasons.push(`${tag}: rubric saw text`); continue; }
      const low = (["onBrand", "clean", "room", "original"] as const).filter((k) => scores[k] < STUDIO.minScore);
      if (low.length) { reasons.push(`${tag}: low ${low.map((k) => `${k} ${scores[k]}`).join(", ")}`); continue; }
      ok.push({ png, scores, ph });
    }
    const best = ok.sort((a, b) => sum(b.scores) - sum(a.scores))[0];
    if (best) {
      writeFileSync(fileOf(eventKey, "art"), best.png);
      remember(best.ph);
      const meta: Meta = { ...base, status: "ready", sha256: sha256(best.png), openaiId: r.requestId, scores: best.scores, phash: best.ph.toString(16), reasons, usage, at: new Date().toISOString() };
      writeFileSync(fileOf(eventKey, "json"), JSON.stringify(meta));
      return meta;
    }
  }
  const meta: Meta = { ...base, status: "failed", openaiId: lastId, reasons, usage, at: new Date().toISOString() };
  if (!capped) writeFileSync(fileOf(eventKey, "json"), JSON.stringify(meta)); // a cap is not a verdict: retried later
  return meta;
}
const sum = (s: Rubric) => s.onBrand + s.clean + s.room + s.original;

// ---------------------------------------------------------------- the HTTP face

const Request = z.object({ eventKey: z.string().min(1).max(200), slots: Slots, shape: z.enum(["wide", "square"]) }).strict();
const inflight = new Map<string, Promise<Meta>>();
async function body(req: IncomingMessage) { let s = ""; for await (const c of req) { s += c; if (s.length > 10_000) throw new Error("too large"); } return s; }
export async function handle(req: IncomingMessage, res: ServerResponse, client = activeClient()) {
  const send = (code: number, b: Buffer | string, type = "application/json") => res.writeHead(code, { "content-type": type }).end(b);
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (req.method === "POST" && path === "/request") {
    // only the enclave asks (fail closed without a configured token)
    if (!authorized(req.headers.authorization)) return send(401, JSON.stringify({ error: "unauthorized" }));
    prune();
    let parsed: z.infer<typeof Request>;
    try { parsed = Request.parse(JSON.parse(await body(req))); } catch (e) { return send(400, JSON.stringify({ error: (e as Error).message.slice(0, 300) })); }
    const { eventKey, slots, shape } = parsed;
    if (!existsSync(fileOf(eventKey, "json")) && !inflight.has(eventKey)) {
      // an exception (OpenAI down) is not a verdict either: nothing written, the next request tries again
      inflight.set(eventKey, generate(eventKey, slots, shape, client).catch((e) => ({ status: "failed", eventKey, openaiId: null, studioCommit: STUDIO.commit, refsetHash: "", model: STUDIO.model, reasons: [(e as Error).message.slice(0, 300)], at: new Date().toISOString() } as Meta)).finally(() => inflight.delete(eventKey)));
    }
    return send(202, JSON.stringify({ accepted: eventKey }));
  }
  const m = path.match(/^\/studio\/(.+)\.(art|json)$/);
  if (req.method === "GET" && m) {
    const f = fileOf(m[1], m[2]);
    if (!existsSync(f)) return send(404, JSON.stringify({ status: inflight.has(m[1]) ? "generating" : "unknown" }));
    const b = readFileSync(f);
    return send(200, b, m[2] === "json" ? "application/json" : b[0] === 0x89 ? "image/png" : "image/jpeg");
  }
  if (path === "/health") return send(200, JSON.stringify({ ok: true, inflight: inflight.size, roundsToday: roundsToday(), model: STUDIO.model }));
  send(404, JSON.stringify({ error: "not found" }));
}
/** Files older than TTL_DAYS (art, metadata, old round counters) go; the near-duplicate hashes stay. */
export function prune(now = Date.now()) {
  if (!existsSync(STUDIO.dir)) return 0;
  let n = 0;
  for (const f of readdirSync(STUDIO.dir)) {
    if (!/^([0-9a-f]{32}\.(art|json)|rounds-\d{4}-\d{2}-\d{2}\.json)$/.test(f)) continue;
    const p = join(STUDIO.dir, f);
    if (now - statSync(p).mtimeMs > STUDIO.ttlDays * 86_400_000) { unlinkSync(p); n++; }
  }
  return n;
}
/** Tests: wait for the generations in flight. */
export const idle = () => Promise.all(inflight.values());

if (import.meta.filename === process.argv[1]) {
  if (!STUDIO.key) throw new Error("OPENAI_API_KEY unset (images, or moderation only with STUDIO_VIA=openrouter)");
  if (STUDIO.via === "openrouter" && !STUDIO.openrouterKey) throw new Error("STUDIO_VIA=openrouter needs OPENROUTER_API_KEY_STUDIO");
  if (!STUDIO.token) throw new Error("STUDIO_TOKEN unset (the enclave's bearer token)");
  references();
  createServer((req, res) => { handle(req, res).catch((e) => res.writeHead(500).end(String((e as Error).message))); }).listen(Number(env.PORT ?? 8080));
}
