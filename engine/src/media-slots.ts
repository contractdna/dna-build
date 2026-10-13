// What the enclave and the studio agree on about an image: the shapes, the events that carry art, the style library
// and how a style is picked, the prompt slots (the event enum, the style + numbers only) and the PNG check.
// Dependency-light: the studio imports it.
import { createHash } from "node:crypto";
import { z } from "zod";

export const SHAPES = { wide: { w: 1536, h: 864 }, square: { w: 1088, h: 1088 } } as const;
export type Shape = keyof typeof SHAPES;
export const MAX_BYTES = 5 * 1024 * 1024;
/** Ritual posts that carry generated art: survived / extinct, the jackpot winner, a ballot's result (natural
 *  selection), a mystery's verdict, the daily digest (square). */
export const ART_EVENTS = ["outcome", "jackpot_drawn", "ballot_result", "mystery_result", "digest"] as const;
/** Posts that may carry the two-panel meme (the one style with words in the art): roasts and comparisons. */
export const MEME_EVENTS = ["roast"] as const;
export const IMAGE_EVENTS = [...ART_EVENTS, ...MEME_EVENTS] as const;
/** Posts that carry the studio's art under an image event's scene (the studio's enum stays as it is): the lab's
 *  simulated candidates and a site change under the experiment's, the status, the nightly reflection, the weekly recap
 *  and a buyback and burn (the glow dims) under the digest's, a fee split under the jackpot's (sparks drawn out), the
 *  6 h chain progress (fees, burns, liquidity in one post) under the digest's. */
export const SCENE_OF: Record<string, (typeof IMAGE_EVENTS)[number]> = {
  lab: "outcome", status: "digest", reflection: "digest", recap: "digest", burn_summary: "digest", fees_distributed: "jackpot_drawn", site_changed: "outcome", progress_day: "digest",
};
/** A post the studio makes art for (its own scene or a borrowed one). */
export const hasArt = (event: string) => (IMAGE_EVENTS as readonly string[]).includes(event) || event in SCENE_OF;
export const shapeOf = (event: string): Shape => (event === "digest" ? "square" : "wide");

/** The style library (prompts: the studio's STUDIO_PROMPTS, neutral defaults in src/studio.ts). */
export const STYLES = ["lab", "meme", "riso", "blueprint", "clay", "etching", "film"] as const;
export type Style = (typeof STYLES)[number];
export const MOODS = ["calm", "proud", "grim", "festive", "sharp"] as const;
export type Mood = (typeof MOODS)[number];
/** The styles each mood prefers, best first (every style but the meme is in every list, so a pick always exists). */
const FIT: Record<Mood, readonly Style[]> = {
  calm: ["lab", "etching", "blueprint", "film", "clay", "riso"],
  proud: ["film", "riso", "clay", "lab", "blueprint", "etching"],
  grim: ["etching", "film", "lab", "blueprint", "clay", "riso"],
  festive: ["riso", "clay", "film", "lab", "blueprint", "etching"],
  sharp: ["meme", "blueprint", "riso", "etching", "film", "clay", "lab"],
};
/** The mood an event sets (a valid `facts.mood` wins). */
export function moodOf(facts: Record<string, unknown>): Mood {
  if ((MOODS as readonly unknown[]).includes(facts.mood)) return facts.mood as Mood;
  if (facts.event === "jackpot_drawn") return "festive";
  if (facts.event === "digest") return "calm";
  if (facts.event === "roast") return "sharp";
  return facts.outcome === "killed" || facts.outcome === "rolled back" || facts.outcome === "rejected" ? "grim" : "proud";
}
/** Each event's own style, tried before its mood's list. */
const LEAN: Record<string, Style> = { outcome: "lab", jackpot_drawn: "clay", ballot_result: "blueprint", mystery_result: "etching", digest: "blueprint", roast: "meme" };
/** Pure: the style for an event, its own style or else the best fit for its mood, never one of `recent` (the styles
 *  of the last 3 image posts, newest first); the meme only for roasts and comparisons. Excluding the last 3 rotates a
 *  run of like events through several styles. */
export function pickStyle(event: string, mood: Mood, recent: readonly string[]): Style {
  const last = recent.slice(0, 3);
  return [...(LEAN[event] ? [LEAN[event]] : []), ...FIT[mood]].find((s) => !last.includes(s) && (s !== "meme" || (MEME_EVENTS as readonly string[]).includes(event)))!;
}

/** One meme panel label: upper-case words (an apostrophe inside a word is fine), single spaces, ≤ 24 characters. */
const Label = z.string().regex(/^(?=.{1,24}$)[A-Z]+('[A-Z]+)?( [A-Z]+('[A-Z]+)?)*$/);
export const Caption = z.tuple([Label, Label]);
export const Slots = z.object({
  event: z.enum(IMAGE_EVENTS), style: z.enum(STYLES), growth: z.number().min(0).max(1), decay: z.number().min(0).max(1), light: z.number().min(0).max(1),
  seed: z.number().int().min(0).max(2 ** 32 - 1), caption: Caption.optional(),
}).strict()
  .refine((s) => (s.style === "meme") === (s.caption !== undefined), "a caption goes with the meme, and only with it")
  .refine((s) => s.style !== "meme" || (MEME_EVENTS as readonly string[]).includes(s.event), "the meme is only for roasts and comparisons");
export type Slots = z.infer<typeof Slots>;
const clamp = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export const seedOf = (eventKey: string) => parseInt(createHash("sha256").update(eventKey).digest("hex").slice(0, 8), 16);
/** Fact sheet → prompt slots: the event enum, the style, numbers mapped to visual parameters (survival = growth,
 *  extinction = decay, prize or fee size = light), a seed from the event key. Never a free string from the facts (names,
 *  reasons, options, titles). The one exception is a meme's two labels, upper-case words only, which the enclave reads
 *  back off the art and compares word by word before anything posts. */
export function slotsOf(facts: Record<string, unknown>, eventKey: string, style: Style): Slots {
  const event = z.enum(IMAGE_EVENTS).parse(SCENE_OF[String(facts.event)] ?? facts.event);
  const kept = facts.outcome === "kept (promoted)" || facts.outcome === "queued for testing";
  const lost = facts.outcome === "killed" || facts.outcome === "rolled back" || facts.outcome === "rejected";
  const eth = num(facts.prizeEth) + num(facts.ethPaid) + num(facts.totalEth) + num(facts.spentEth); // a fee split's, a buyback's
  const n = num(facts.survived) + num(facts.extinct);
  const share = num(facts.totalWeight) > 0 ? num(facts.winnerWeight) / num(facts.totalWeight) : 0;
  return Slots.parse({
    event, style, growth: kept ? 1 : clamp(share || (n ? num(facts.survived) / n : 0)), decay: lost ? 1 : clamp(n ? num(facts.extinct) / n : 0),
    light: clamp(Math.log10(1 + eth * 10) / 2), seed: seedOf(eventKey), ...(style === "meme" ? { caption: facts.caption } : {}),
  });
}


/** The size an image says it has: PNG (magic + IHDR) or JPEG (SOI, then the first SOF0/SOF2 frame header). */
export function imageSize(b: Buffer): { type: "png" | "jpeg"; w: number; h: number } | string {
  if (b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (b.toString("latin1", 12, 16) !== "IHDR") return "no IHDR";
    return { type: "png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return "corrupt JPEG";
      const marker = b[i + 1];
      if (marker === 0xc0 || marker === 0xc2) return { type: "jpeg", h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      if (marker === 0xd9 || marker === 0xda) return "JPEG without a frame header";
      i += 2 + b.readUInt16BE(i + 2);
    }
    return "JPEG without a frame header";
  }
  return "not a PNG or JPEG";
}
/** Art the enclave accepts: PNG or JPEG with exactly the shape's size, ≤ 5 MB. null = ok. */
export function artIssue(b: Buffer, shape: Shape): string | null {
  if (b.length > MAX_BYTES) return `over ${MAX_BYTES} bytes`;
  const s = imageSize(b);
  if (typeof s === "string") return s;
  const { w, h } = SHAPES[shape];
  return s.w === w && s.h === h ? null : `size ${s.w}×${s.h}, want ${w}×${h}`;
}
