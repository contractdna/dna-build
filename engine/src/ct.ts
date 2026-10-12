// CT commentary: about 5 standalone takes a UTC day on what crypto Twitter is talking about right now (DNA, its rivals,
// AI-run tokens, Uniswap v4 hooks), at times nobody can plan around:
//  - slots: CT.perDay a day in [06:00, 01:00 next day) UTC, at least CT.gapMin apart, plus one night slot (02:30-04:30)
//    that posts only when the scout calls the moment big. Drawn from a seed in the signed log (the hash of the last
//    record before the day's 00:00 UTC), so anyone can recompute them (ctSlots); every slot's verdict is a signed record.
//  - scout: at a slot, Grok x_search (xAI direct, the x-scout role) over the bundle's read-list and searches
//    (x-ct-watch, with the tone scout's handles) → up to 5 one-line topics, how worth a take the moment is, and whether
//    it is big. Code screens every line (no digits beyond "v4", links, handles, foreign cashtags, banned terms).
//  - quiet: nothing worth a take (worth under CT.bar, or no topic left), and the slot is skipped: no filler.
//  - the take: one outbox post (event "ct", no link, no image); x:send runs it through the writer, every filter, the
//    judge and the daily cap like any post, ranked below every event (src/announce.ts PRIORITY). A take that waits past
//    CT.staleMin is dropped, never rolled into the digest.
import { createHash } from "node:crypto";
import { z } from "zod";
import { eventPosts } from "./announce.ts";
import { edb as sql } from "./db.ts";
import { ENCLAVE } from "./enclave.ts";
import { Defer, type Handler } from "./jobs.ts";
import { llm } from "./llm.ts";
import { prompt, sys } from "./persona.ts";
import { MODELS } from "./policy.ts";
import { latest, nowIso, record } from "./records.ts";
import { instructionLike, linkIssues, nonAscii, SCOUT, screenLine } from "./voice.ts";
import { enqueueX, muted, usedToday } from "./x.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** perDay day slots `gapMin` apart in [dayFrom, dayTo) hours of the UTC day (25 = 01:00 next day), one night slot in
 *  [nightFrom, nightTo) (02:30-04:30: 90 min clear of the day slots on both sides); a slot is taken within graceMin;
 *  bar: the scout's worth a day slot needs (1-5); reserve: event posts a take always leaves free under the day's cap;
 *  staleMin: a take still queued this long after its slot is dropped. */
export const CT = { perDay: 5, gapMin: 90, dayFrom: 6, dayTo: 25, nightFrom: 26.5, nightTo: 28.5, graceMin: 30, bar: 3, reserve: 3, staleMin: 60, everyMs: 5 * MIN };

// ---------------------------------------------------------------- slots (pure)

/** A uniform draw in [0, 1) from the seed and a label. */
const draw = (seed: string, label: string) => parseInt(createHash("sha256").update(`${seed}:${label}`).digest("hex").slice(0, 12), 16) / 2 ** 48;
export type Slot = { i: number; at: number; night: boolean };
/** The slots of the plan that starts on UTC `day` (YYYY-MM-DD) at 06:00: CT.perDay day slots at least CT.gapMin apart
 *  (n draws over the free time, sorted, a gap added after each), then the night slot. Minute precision. */
export function ctSlots(seed: string, day: string): Slot[] {
  const d0 = Date.parse(`${day}T00:00:00Z`);
  const from = CT.dayFrom * 60, free = (CT.dayTo - CT.dayFrom) * 60 - (CT.perDay - 1) * CT.gapMin;
  const xs = Array.from({ length: CT.perDay }, (_, i) => Math.floor(draw(seed, `day${i}`) * free)).sort((a, b) => a - b);
  const night = CT.nightFrom * 60 + Math.floor(draw(seed, "night") * (CT.nightTo - CT.nightFrom) * 60);
  return [...xs.map((x, i) => ({ i, at: d0 + (from + x + i * CT.gapMin) * MIN, night: false })), { i: CT.perDay, at: d0 + night * MIN, night: true }];
}
/** The plan covering `now` starts at 06:00 UTC of this day. */
export const planDay = (now: number) => new Date(now - CT.dayFrom * HOUR).toISOString().slice(0, 10);
/** The slot to take at `now`: the earliest one due (at or past its time, within CT.graceMin) and not yet `done`. */
export const dueSlot = (slots: Slot[], now: number, done: (i: number) => boolean) =>
  slots.find((s) => s.at <= now && now - s.at < CT.graceMin * MIN && !done(s.i));

// ---------------------------------------------------------------- the scout and the quiet rule

/** What the scout may watch: the tone scout's handles plus the bundle's x-ct-watch (`@handle` lines, every other line a
 *  search). Empty: no scout runs. Mutable only for tests. */
export const WATCH = watchOf(prompt("x-ct-watch"), SCOUT.handles);
export function watchOf(text: string, handles: readonly string[]) {
  const lines = text.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  const own = lines.filter((l) => l.startsWith("@")).map((l) => l.slice(1)).filter((h) => /^\w{1,15}$/.test(h));
  return {
    handles: [...new Set([...handles, ...own])].slice(0, 20),
    searches: [...new Set(lines.filter((l) => !l.startsWith("@") && l.length <= 60 && !/https?:\/\/|www\./i.test(l)))].slice(0, 10),
  };
}

export const ABOUT = ["dna", "rivals", "ai", "hooks", "ct"] as const;
export const CtScoutOut = z.object({
  topics: z.array(z.object({ line: z.string().min(1).max(200), about: z.enum(ABOUT), heat: z.number().int().min(1).max(5) })).max(5),
  worth: z.number().int().min(0).max(5),
  big: z.boolean(),
});
export type CtScout = z.infer<typeof CtScoutOut>;
export type Topic = { line: string; about: (typeof ABOUT)[number] };

/** A topic line the writer may read: one plain line of at most 160 characters (src/voice.ts screenLine: no digit, link,
 *  handle, number word or banned term), "v4" the only number allowed, nothing that reads as an instruction; null = dropped. */
export function topicLine(s: string): string | null {
  const t = s.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!t || t.length > 160 || nonAscii(t) || linkIssues(t).length || instructionLike(t)) return null;
  return screenLine(t.replace(/\bv4\b/gi, "v"), 160) ? t : null;
}

/** The quiet rule (pure): the screened topics, hottest first, at most 3; or why the slot posts nothing. A day slot needs
 *  worth ≥ CT.bar; the night slot a big moment at worth 5. */
export function ctVerdict(out: CtScout, night: boolean): { topics: Topic[]; dropped: number } | { skip: string } {
  if (night && !(out.big && out.worth >= 5)) return { skip: "quiet night: nothing big" };
  if (out.worth < CT.bar) return { skip: `quiet: worth ${out.worth} under ${CT.bar}` };
  const kept = out.topics.flatMap((t) => { const line = topicLine(t.line); return line ? [{ line, about: t.about, heat: t.heat }] : []; });
  if (!kept.length) return { skip: "quiet: no topic passed the screen" };
  return { topics: kept.sort((a, b) => b.heat - a.heat).slice(0, 3).map(({ line, about }) => ({ line, about })), dropped: out.topics.length - kept.length };
}

/** Code's words for what a take is (the writer's `stage`). */
export const CT_STAGE = "a take on what crypto Twitter is talking about right now. `topics` are what posts say, unverified: react with your own view of one of them, state none of them as fact and name no person. About DNA itself claim only `standing` and `earlier`";

export const scoutCt = (fromDate: string, recent: string[]) =>
  llm({
    agent: "x-ct-scout", model: MODELS.scout, schema: CtScoutOut, maxTurns: 1, maxOutputTokens: 1500,
    tools: [{ type: "x_search", from_date: fromDate }],
    system: sys("x-ct-scout", prompt("x-ct-scout")),
    input: { task: "what crypto Twitter is talking about in the last few hours", now: new Date().toISOString(), watch: WATCH, recent },
    secret: ["watch"],
  });

// ---------------------------------------------------------------- the job

/** The seed of a plan: the newest log record before the plan day's 00:00 UTC (its seq and chain hash; in the enclave the
 *  newest signed one, by its signed chain hash, so no unsigned row can move the day's times). */
export async function seedOf(day: string) {
  const [r] = await sql<{ seq: string; hash: string }[]>`select seq::text, encode(coalesce(ehash, hash), 'hex') as hash from log
    where at < ${new Date(`${day}T00:00:00Z`)} and (ehash is not null or not ${ENCLAVE.on}) order by seq desc limit 1`;
  return r ?? { seq: "0", hash: "0".repeat(64) };
}

/** x:ct (every 5 min): drops stale takes, then takes the due slot once (its signed record says what it did). */
export const ctHandler: Handler = {
  lane: "llm",
  run: async () => {
    await sql`update x_outbox set status = 'skipped', error = 'stale take', updated_at = now() where status = 'queued' and event->>'event' = 'ct'
      and created_at < now() - make_interval(mins => ${CT.staleMin})`;
    if (!WATCH.handles.length && !WATCH.searches.length) return "no watch list: no CT scout";
    const now = Date.now(), day = planDay(now);
    const seed = await seedOf(day);
    const slots = ctSlots(seed.hash, day);
    const done = new Set<number>();
    for (const s of slots) if (dueSlot([s], now, () => false) && (await latest("tone", `ct:${day}:${s.i}`))) done.add(s.i);
    const slot = dueSlot(slots, now, (i) => done.has(i));
    if (!slot) return "no slot due";
    // halted: x:ct is a MODEL_JOBS kind (src/mode.ts), so it waits before it gets here
    if (await muted()) return "muted";
    const key = `ct:${day}:${slot.i}`;
    const base = { day, slot: slot.i, at: new Date(slot.at).toISOString(), night: slot.night, seed };
    const skip = async (why: string) => { await record("tone", key, { kind: "ct", ...base, status: "skipped", why, recordedAt: nowIso() }); return `${key}: ${why}`; };
    // one take at a time, never two inside the gap, and never in the way of the day's events
    // the gap on the DB's clock, as usedToday measures the spacing (never Node's against the DB's)
    const [ahead] = await sql<{ n: number; since: number | null }[]>`select count(*) filter (where o.status = 'queued')::int as n,
      (extract(epoch from now() - max(o.updated_at) filter (where o.status in ('posted', 'dry_run', 'attempt', 'attempted'))) * 1000)::float8 as since
      from x_outbox o where o.event->>'event' = 'ct'`;
    if (ahead.n) return skip("a take is still queued");
    if (ahead.since !== null && ahead.since < CT.gapMin * MIN) return skip(`the last take went out less than ${CT.gapMin} min ago`);
    const [{ queued }] = await sql<{ queued: number }[]>`select count(*)::int as queued from x_outbox where type = 'post' and status in ('queued', 'attempt')`;
    if ((await usedToday()).post + queued >= eventPosts() - CT.reserve) return skip("no room under the day's cap");
    const recent = (await sql<{ text: string }[]>`select l.doc->>'draft' as text from log l where l.kind = 'x_post' and l.ref like 'ct:%'
      and l.doc->>'status' in ('attempt', 'dry_run') and l.doc->>'draft' is not null order by l.seq desc limit 5`).map((r) => r.text);
    let r: Awaited<ReturnType<typeof scoutCt>>;
    try {
      r = await scoutCt(new Date(now - 6 * HOUR).toISOString().slice(0, 10), recent);
    } catch (e) {
      if (e instanceof Defer) throw e; // the LLM cap or provider trouble: tried again while the slot's grace lasts
      return skip(`scout failed: ${(e as Error).message.slice(0, 200)}`);
    }
    const v = ctVerdict(r.data, slot.night);
    const scouted = { worth: r.data.worth, big: r.data.big, model: r.model };
    if ("skip" in v) { await record("tone", key, { kind: "ct", ...base, ...scouted, status: "skipped", why: v.skip, recordedAt: nowIso() }); return `${key}: ${v.skip}`; }
    // uniswapVersion: "v4" is the one number a take may say without one in the facts
    await enqueueX(key, "post", { event: "ct", topics: v.topics, uniswapVersion: 4, stage: CT_STAGE });
    await record("tone", key, { kind: "ct", ...base, ...scouted, status: "queued", topics: v.topics, dropped: v.dropped, recordedAt: nowIso() });
    return { [key]: "queued", topics: v.topics.length };
  },
};
