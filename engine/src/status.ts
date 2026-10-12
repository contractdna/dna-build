// What X hears between events: a status at 14:00 and 22:00 UTC, a recap Sundays at 18:00 UTC, and milestones as they
// are crossed. Every number comes from code: the indexer's finalized chain rows and snapshot, the signed announcement
// records, the signed build rows. The writer only words them (src/voice.ts fact sheets and filter). Each goes through
// announce() (the site's signed record, once per key) and the X outbox (one row per key), ranked below money and games
// and above the rest (src/announce.ts PRIORITY); its proof link is that signed record.
// A quiet status window (no swaps, nothing burned, nothing changed since the last status) posts nothing: silence when
// nothing happened, like the digest.
// Launch day: the engine going live is the opening post (once ever, the first time it is live and unmuted), the Safe's
// first batch (the registry's Initialized) once; then every 2 h one post per kind of chain progress that happened (fee
// distributions by leg, buybacks and burns, liquidity adds), each linking its latest tx (code appends the link).
import { isDeepStrictEqual } from "node:util";
import { formatEther } from "viem";
import { announce, launchDay, recordUrl } from "./announce.ts";
import { z } from "zod";
import { d, type Deployment, LOG_BASE_URL } from "./config.ts";
import { edb as sql } from "./db.ts";
import type { Handler, Job, Schedule } from "./jobs.ts";
import { chainRows, launchTax, observeNow } from "./observe.ts";
import { trustedDocs } from "./records.ts";
import { stateSig, trusted } from "./log.ts";
import { alert } from "./telegram.ts";
import { factSheet, TX_URL } from "./voice.ts";
import { addressOf, pub } from "./tx.ts";
import { requestArtFor } from "./card.ts";
import { burnedDna, enqueueX, stateFacts, stopped } from "./x.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Chain progress is summed per `hours` window; its job runs `lagMs` after the window ends, so the finalized indexer
 *  (≈ 13 min behind the head) has its last rows. */
export const PROGRESS = { hours: 2, lagMs: 30 * 60_000 };
/** UTC hours of the two daily status posts. */
export const STATUS_HOURS = [14, 22];
/** The weekly recap: Sunday (0), 18:00 UTC. */
export const RECAP_AT = { weekday: 0, hour: 18 };
const due = (start: Date) => ({ due: start.toISOString() });
/** The jobs (src/engine.ts schedules them with X posting). Periods count from the epoch, a Thursday: Sunday is 3 days on. */
export const xSchedules = (): Schedule[] => [
  ...STATUS_HOURS.map((h) => ({ kind: "x:status", everyMs: DAY, offsetMs: h * HOUR, payload: due })),
  { kind: "x:recap", everyMs: WEEK, offsetMs: ((RECAP_AT.weekday + 3) % 7) * DAY + RECAP_AT.hour * HOUR, payload: due },
  { kind: "x:milestones", everyMs: HOUR, offsetMs: 30 * 60_000 },
  { kind: "x:launch", everyMs: 60_000 },
  { kind: "x:progress", everyMs: PROGRESS.hours * HOUR, offsetMs: PROGRESS.lagMs, payload: due },
];

// ---------------------------------------------------------------- pure

/** Three significant digits (0 stays 0): the numbers a post states. */
const sig3 = (x: number) => (x ? Number(x.toPrecision(3)) : 0);
const defined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

export type DevTeam = { stage: "building" | "shipping" | "idle"; round?: number; title?: string };
/** One status window as the engine reads it. */
export type StatusInput = {
  hours: number; swaps: number; volumeEth: number; feesEth: number; burnedDna: number; buybackPotEth: number | null; jackpotPotEth: number | null;
  gamesLive: number; liveFee: Record<string, unknown>; testing?: { stage: string; plate: string }; devTeam: DevTeam;
  /** the swaps that paid a launch guard's launch tax in the window (src/observe.ts launchTax): never in `swaps`,
   *  `volumeEth` or `feesEth` */
  launchTax?: { eth: number; swaps: number; volumeEth: number };
};
/** What a status compares with the last one. */
const MOVES = ["buybackPotEth", "jackpotPotEth", "gamesLive", "liveFee", "testing", "devTeam"] as const;

/** The status facts (code numbers, rounded by code) and what moved since `prev` (the last status's facts). Quiet: no
 *  swaps, nothing burned, nothing moved. */
export function statusFacts(i: StatusInput, prev: Record<string, unknown> | undefined) {
  const facts: Record<string, unknown> = defined({
    event: "status", hours: i.hours, swaps: i.swaps, volumeEth: sig3(i.volumeEth), feesEth: sig3(i.feesEth), burnedDna: Math.floor(i.burnedDna),
    buybackPotEth: i.buybackPotEth === null ? undefined : sig3(i.buybackPotEth), jackpotPotEth: i.jackpotPotEth === null ? undefined : sig3(i.jackpotPotEth),
    gamesLive: i.gamesLive, liveFee: i.liveFee, testing: i.testing, devTeam: defined(i.devTeam),
    ...(i.launchTax?.swaps ? { launchTaxSwaps: i.launchTax.swaps, launchTaxVolumeEth: sig3(i.launchTax.volumeEth), launchTaxEth: sig3(i.launchTax.eth) } : {}),
  });
  const changed = prev ? MOVES.filter((k) => !isDeepStrictEqual(facts[k] ?? null, prev[k] ?? null)) : [];
  // the first status has nothing to compare with: no `changed` (an empty one reads as "nothing moved")
  if (prev) facts.changed = changed;
  // what moved in the window, in code's words, so a status leads with it
  const moved = [...(i.launchTax?.swaps ? ["the launch tax: all of it to buyback-and-burn"] : []), ...(facts.burnedDna ? ["DNA burned"] : []), ...(i.swaps ? ["swaps"] : [])];
  if (moved.length) facts.moved = moved;
  return { facts, quiet: i.swaps === 0 && !i.launchTax?.swaps && facts.burnedDna === 0 && changed.length === 0 };
}

/** Round thresholds a milestone post marks (whole DNA burned in total; the jackpot pot in ETH). */
export const MILESTONES = {
  dna_burned: [1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7, 1e8, 2.5e8, 5e8],
  jackpot_pot: [0.5, 1, 2.5, 5, 10, 15],
};
export type Metric = keyof typeof MILESTONES;
/** The highest threshold `value` has reached, or null. */
export const crossed = (value: number, ladder: readonly number[]) => ladder.filter((t) => value >= t).at(-1) ?? null;
/** A milestone's key: DNA burned once per threshold, ever; the jackpot pot once per threshold per climb (`draws`: the
 *  pot's draw count, so a draw that empties it lets the next climb post again). */
export const milestoneKey = (metric: Metric, threshold: number, draws: string) =>
  metric === "jackpot_pot" ? `milestone:jackpot_pot:${draws}:${threshold}` : `milestone:${metric}:${threshold}`;
/** A milestone's facts, or null below the first threshold. */
export function milestoneFacts(metric: Metric, value: number) {
  const threshold = crossed(value, MILESTONES[metric]);
  return threshold === null ? null : { event: "milestone", metric, threshold, value: metric === "dna_burned" ? Math.floor(value) : Number(value.toFixed(3)) };
}

type Doc = { type: string; facts: Record<string, unknown> };
/** The week in numbers, from its signed announcements: what shipped, what was killed, what changed in fees and games.
 *  null: nothing happened. */
export function recapFacts(docs: Doc[], live: { gamesLive: number; liveFee: Record<string, unknown> }) {
  const of = (type: string, f: (x: Record<string, unknown>) => boolean = () => true) => docs.filter((x) => x.type === type && f(x.facts));
  const titles = (xs: Doc[]) => xs.map((x) => String(x.facts.title ?? "")).filter(Boolean).slice(0, 3);
  const shipped = of("seq_shipped"), killed = of("seq_killed");
  const kept = (x: Record<string, unknown>) => x.outcome === "kept (promoted)";
  const counts = {
    gamesShipped: shipped.length, siteChanges: of("seq_released", (x) => x.target !== "module").length, modulesProposed: of("seq_released", (x) => x.target === "module").length,
    modulesApproved: of("module_approved").length, handedOver: of("seq_handoff").length, buildsKilled: killed.length, gamesRetired: of("game_retired").length,
    experimentsKept: of("outcome", kept).length, experimentsKilled: of("outcome", (x) => !kept(x)).length,
  };
  if (!Object.values(counts).some(Boolean)) return null;
  return { event: "recap", days: 7, ...counts, gamesLive: live.gamesLive, liveFee: live.liveFee, shipped: titles(shipped), killed: titles(killed) };
}

type ProgressRow = { tx: string; event: string; args: Record<string, string> };
const sum = (rows: ProgressRow[], k: string) => rows.reduce((n, r) => n + BigInt(r.args[k] ?? 0), 0n);
const ethOf = (wei: bigint) => sig3(Number(formatEther(wei)));
/** One window's chain progress (rows: the window's FeeVault Distributed, BuybackBurn Buyback and LiquidityVault
 *  LiquidityAdded logs, in chain order): one post per kind with anything in it, each with its kind's latest tx. */
export function progressFacts(rows: ProgressRow[], hours = PROGRESS.hours) {
  const of = (e: string) => rows.filter((r) => r.event === e);
  const dist = of("Distributed"), buy = of("Buyback"), add = of("LiquidityAdded");
  const out: { facts: Record<string, unknown>; tx: string }[] = [];
  if (dist.length) out.push({ tx: dist.at(-1)!.tx, facts: { event: "fees_distributed", hours, distributions: dist.length, totalEth: ethOf(sum(dist, "amount")),
    buybackEth: ethOf(sum(dist, "buyback")), liquidityEth: ethOf(sum(dist, "lp")), treasuryEth: ethOf(sum(dist, "treasury")), gamesEth: ethOf(sum(dist, "game")) } });
  if (buy.length) out.push({ tx: buy.at(-1)!.tx, facts: { event: "burn_summary", hours, buybacks: buy.length, spentEth: ethOf(sum(buy, "spent")), burnedDna: Number(sum(buy, "burned") / 10n ** 18n) } });
  if (add.length) out.push({ tx: add.at(-1)!.tx, facts: { event: "liquidity_added", hours, adds: add.length, ethAdded: ethOf(sum(add, "eth")) } });
  return out;
}

/** After the launch window: the day's chain progress in one post (every kind that happened), or null (nothing did). */
export function progressDayFacts(rows: ProgressRow[]) {
  const parts = progressFacts(rows, 24);
  if (!parts.length) return null;
  const facts: Record<string, unknown> = { event: "progress_day", hours: 24 };
  for (const p of parts) { const { event: _e, hours: _h, ...rest } = p.facts; Object.assign(facts, rest); }
  return { facts, tx: rows.at(-1)!.tx };
}

/** The launch-day one-offs. */
export const LAUNCH_KEYS = ["online", "contracts_connected"] as const;
/** The launch-day one-offs still to queue (`done`: their keys in the outbox, not skipped): the engine going live and the
 *  Safe's first batch, both linking the Safe's T0 initialize tx (`initTx`: the registry's indexed Initialized). */
export function launchQueue(done: ReadonlySet<string>, initTx: string) {
  const link = `${TX_URL}${initTx}`;
  return LAUNCH_KEYS.filter((key) => !done.has(key)).map((key) => ({ key, facts: { event: key }, link }));
}

/** Once-ever firsts after the launch posts: the keys handed to the enclave (the Safe's SetAgent to the enclave's own
 *  key), the first idea in the idea market, the first buyback-and-burn. Each posts once, linking its tx. */
export const FIRST_KEYS = ["keys_handed", "first_idea_round", "first_burn"] as const;
export type FirstKey = (typeof FIRST_KEYS)[number];
/** The firsts still to queue (`done`: their keys in the outbox, not skipped) whose tx is indexed. */
export function firstsQueue(done: ReadonlySet<string>, txs: Partial<Record<FirstKey, string>>) {
  return FIRST_KEYS.filter((key) => !done.has(key) && txs[key]).map((key) => ({ key, facts: { event: key }, link: `${TX_URL}${txs[key]}` }));
}

// ---------------------------------------------------------------- reads (code only)

const eth = (wei: unknown) => (wei === undefined || wei === null ? null : Number(formatEther(BigInt(String(wei)))));
type Chain = { claims?: { buybackBurn?: string }; game?: { pot?: { jackpotPot?: string; drawCount?: string } } };
const chainState = async () => (await sql<{ value: Chain }[]>`select value from state where key = 'chain'`)[0]?.value ?? {};

/** Games the factory lists as live: deployed and not retired (the indexed factory events). */
async function liveGames() {
  if (!d.gameFactory) return 0;
  const f = d.gameFactory.toLowerCase();
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from (select lower(args->>'game') from chain_log where event = 'GameDeployed' and address = ${f}
    except select lower(args->>'game') from chain_log where event = 'GameRetired' and address = ${f}) g`;
  return r.n;
}

/** The last `hours` as the engine knows them: swaps, volume and fees (the finalized swap rows), DNA burned, the pots
 *  (the snapshot), live games, the live fee and its test, and the dev team's build (its signed row). */
export async function readStatus(hours = 12): Promise<StatusInput> {
  const o = await observeNow(hours);
  const { activeBuild } = await import("./sequencer.ts");
  const [chain, burned, gamesLive, st, build, fees] = await Promise.all([chainState(), burnedDna(new Date(o.fromMs), new Date(o.toMs)), liveGames(), stateFacts(), activeBuild(), chainRows(["FeeTaken"], o.fromMs)]);
  const devTeam: DevTeam = !build ? { stage: "idle" } : { stage: build.status === "verdict" || build.status === "shipping" ? "shipping" : "building", round: build.round, title: build.data.title };
  return {
    hours, swaps: o.feeSwaps, volumeEth: o.volumeEth, feesEth: o.projectEth, burnedDna: burned, buybackPotEth: eth(chain.claims?.buybackBurn), jackpotPotEth: eth(chain.game?.pot?.jackpotPot),
    gamesLive, liveFee: st.liveFee, ...(st.testing ? { testing: st.testing } : {}), devTeam, launchTax: launchTax(fees.filter((r) => r.at.getTime() < o.toMs)),
  };
}

/** Signed announcements of these types since `fromMs`. */
async function announcedSince(types: string[], fromMs: number): Promise<Doc[]> {
  const refs = await sql<{ ref: string }[]>`select distinct ref from log where kind = 'announce' and at >= ${new Date(fromMs)} and doc->>'type' = any(${types})`;
  const out: Doc[] = [];
  for (const { ref } of refs) {
    const [a] = await trustedDocs<Doc>("announce", ref);
    if (a) out.push({ type: a.type, facts: a.facts });
  }
  return out;
}

// ---------------------------------------------------------------- jobs

/** The site's record (once per key), then the X outbox row (once per key) with that record as its proof link. */
export async function post(key: string, facts: Record<string, unknown>) {
  await announce(key, facts);
  const [r] = await sql<{ seq: string }[]>`select seq::text from log where kind = 'announce' and ref = ${key} order by seq limit 1`;
  const id = await enqueueX(key, "post", facts, { link: recordUrl(r.seq) });
  if (id) await requestArtFor(key, factSheet(facts)); // a post with studio art (the status, the recap): asked for now
  return id;
}
/** A scheduled run's hour; null when it runs over an hour late (caught up at boot: a stale status never posts). */
function dueAt(job: Job) {
  const t = typeof job.payload.due === "string" ? Date.parse(job.payload.due) : Date.now();
  return Date.now() - t > HOUR ? null : t;
}

/** x:status (14:00 and 22:00 UTC): the last 12 h, or nothing on a quiet window. */
export const statusHandler: Handler = {
  lane: "x",
  run: async (job) => {
    const at = dueAt(job);
    if (at === null) return `missed the status hour (${job.payload.due})`;
    const key = `status:${new Date(at).toISOString().slice(0, 13)}`;
    const [last] = await sql<{ ref: string }[]>`select ref from log where kind = 'announce' and doc->>'type' = 'status' order by seq desc limit 1`;
    const prev = last ? (await trustedDocs<Doc>("announce", last.ref))[0]?.facts : undefined;
    // a retry after a crash: this window's status is the last one; queue it (once) as it was
    if (last?.ref === key && prev) return { status: key, queued: !!(await post(key, prev)) };
    const { facts, quiet } = statusFacts(await readStatus(), prev);
    if (quiet) return "a quiet window: no status (no swaps, nothing burned, nothing changed)";
    await post(key, facts);
    return { status: key };
  },
};

const RECAP_TYPES = ["seq_shipped", "seq_released", "seq_killed", "seq_handoff", "game_retired", "outcome", "module_approved"];
/** x:recap (Sundays 18:00 UTC): the week's signed announcements, the games live and the live fee now. */
export const recapHandler: Handler = {
  lane: "x",
  run: async (job) => {
    const at = dueAt(job);
    if (at === null) return `missed the recap hour (${job.payload.due})`;
    const key = `recap:${new Date(at).toISOString().slice(0, 10)}`;
    const facts = recapFacts(await announcedSince(RECAP_TYPES, at - WEEK), { gamesLive: await liveGames(), liveFee: (await stateFacts()).liveFee });
    if (!facts) return "a quiet week: no recap";
    await post(key, facts);
    return { recap: key };
  },
};

/** x:milestones (hourly): total DNA burned (the indexed burns) and the jackpot pot (the snapshot) against the round
 *  thresholds; once per key (milestoneKey). */
export const milestonesHandler: Handler = {
  lane: "x",
  run: async () => {
    const pot = (await chainState()).game?.pot;
    const values: [Metric, number | null][] = [["dna_burned", await burnedDna(new Date(0))], ["jackpot_pot", eth(pot?.jackpotPot)]];
    const out: Record<string, string> = {};
    for (const [metric, v] of values) {
      const f = v === null ? null : milestoneFacts(metric, v);
      if (!f) continue;
      const key = milestoneKey(metric, f.threshold, String(pot?.drawCount ?? 0));
      out[metric] = (await post(key, f)) ? `queued ${key}` : `${key} already out`;
    }
    return out;
  },
};

/** x:launch (every minute): the launch-day one-offs (launchQueue) and the once-ever firsts (firstsQueue), queued only while the engine is live and posting is
 *  unmuted (queued in dry_run or while muted, they would be spent without reaching X), and only once the Safe's T0
 *  initialize tx is indexed (the posts say the Safe connected the contracts: never without that tx). One skipped (a
 *  /mute dropped it) is alerted and queued again once posting resumes: they post once, not "once queued". */
export const launchHandler: Handler = {
  lane: "x",
  run: async () => {
    const rows = await sql<{ id: string; k: string; status: string; error: string | null }[]>`select id::text, event_key as k, status, error from x_outbox where event_key = any(${[...LAUNCH_KEYS, ...FIRST_KEYS]})`;
    const skipped = rows.filter((r) => r.status === "skipped");
    for (const r of skipped) await alert(`The launch post "${r.k}" was skipped (${r.error ?? "no reason"}). It is queued again once X posting is live and unmuted.`, `alert:launchskip:${r.id}`);
    const stop = await stopped();
    if (stop) return `waiting: ${stop}`;
    const done = new Set(rows.filter((r) => r.status !== "skipped").map((r) => r.k));
    if (done.size === LAUNCH_KEYS.length + FIRST_KEYS.length) return "launch posts queued";
    const [init] = await sql<{ tx: string }[]>`select tx from chain_log where event = 'Initialized' and address = ${d.registry.toLowerCase()} order by block, log_index limit 1`;
    if (!init) return "waiting: the registry's Initialized is not indexed yet";
    if (skipped.length) await sql`delete from x_outbox where id = any(${skipped.map((r) => r.id)}::bigint[]) and status = 'skipped'`;
    const out: string[] = [];
    const agent = addressOf("agent")?.toLowerCase();
    const first = async (event: string, address: string | undefined, extra = sql``) => address
      ? (await sql<{ tx: string }[]>`select tx from chain_log where event = ${event} and address = ${address.toLowerCase()} ${extra} order by block, log_index limit 1`)[0]?.tx : undefined;
    const txs = {
      keys_handed: agent ? await first("AgentSet", d.registry, sql`and lower(args->>'agent') = ${agent}`) : undefined,
      first_idea_round: await first("IdeaSubmitted", d.ideaMarket),
      first_burn: await first("Buyback", d.buybackBurn),
    };
    for (const p of [...launchQueue(done, init.tx), ...firstsQueue(done, txs)]) {
      await announce(p.key, p.facts, { tx: p.link });
      if (await enqueueX(p.key, "post", p.facts, { link: p.link })) out.push(p.key);
    }
    return out.length ? { queued: out } : LAUNCH_KEYS.every((k) => done.has(k)) ? "launch posts queued" : "nothing new";
  },
};

/** The window's FeeVault Distributed, BuybackBurn Buyback and LiquidityVault LiquidityAdded logs (finalized), in chain
 *  order: DNA's own contracts only. */
const progressRows = (from: number, to: number) => sql<ProgressRow[]>`select tx, event, args from chain_log
  where address = any(${[d.feeVault, d.buybackBurn, d.liquidityVault].map((a) => a.toLowerCase())}) and event = any(${["Distributed", "Buyback", "LiquidityAdded"]})
  and at >= ${new Date(from)} and at < ${new Date(to)} order by block, log_index`;

/** x:progress (every 2 h, 30 min after the window): heavy updates early, never bot spam later.
 *  - On a launch day (src/announce.ts launchDay): the 2 h window's fee distributions, buybacks and liquidity adds, one
 *    post per kind that happened.
 *  - After: one combined post for the UTC day that ended (the 00:30 run only), at the lowest priority, so on a full day
 *    the digest absorbs it.
 *  Nothing happened: no post. Once per window (its key). */
export const progressHandler: Handler = {
  lane: "x",
  run: async (job) => {
    const at = dueAt(job);
    if (at === null) return `missed the progress hour (${job.payload.due})`;
    const to = at - PROGRESS.lagMs, from = to - PROGRESS.hours * HOUR;
    let posts: { facts: Record<string, unknown>; tx: string; key: string }[];
    if (launchDay(from)) {
      const window = new Date(from).toISOString().slice(0, 13);
      posts = progressFacts(await progressRows(from, to)).map((p) => ({ ...p, key: `${p.facts.event}:${window}` }));
    } else {
      if (new Date(to).getUTCHours() !== 0) return "after the launch window: one combined progress post a day (00:30 UTC)";
      const p = progressDayFacts(await progressRows(to - DAY, to));
      posts = p ? [{ ...p, key: `progress_day:${new Date(to - DAY).toISOString().slice(0, 10)}` }] : [];
    }
    if (!posts.length) return "nothing distributed, bought back or added in the window: no progress post";
    const out: Record<string, boolean> = {};
    for (const p of posts) {
      const link = `${TX_URL}${p.tx}`;
      await announce(p.key, p.facts, { tx: link });
      out[p.key] = !!(await enqueueX(p.key, "post", p.facts, { link })); // false: queued by an earlier run
      if (out[p.key]) await requestArtFor(p.key, factSheet(p.facts)); // a fee split, a buyback: studio art, asked for now
    }
    return out;
  },
};

/** One entry of the site's change list (GET <LOG_BASE_URL>/api/changes, newest first). The site is still a fetch
 *  away: every field is checked and capped, a path must stay on the site. */
const SiteChange = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  at: z.iso.datetime({ offset: true }),
  title: z.string().trim().min(1).max(60),
  summary: z.string().trim().max(200),
  url: z.string().max(200).regex(/^\/(?![/\\])[A-Za-z0-9._~!$&*+,;=:@%/?#-]*$/), // no quote or bracket: X's linker cuts there
});
export type SiteChange = z.infer<typeof SiteChange>;
const SITE_WINDOW_MS = 48 * HOUR;
const SITE_BASE = LOG_BASE_URL.replace(/\/+$/, "");
/** The change to post now: the oldest valid entry of the last 48 h not yet announced (`done`: announced ids). A bad
 *  entry is skipped, a body that is not a list posts nothing. */
export function siteChangeDue(body: unknown, done: ReadonlySet<string>, now = Date.now()): SiteChange | undefined {
  if (!Array.isArray(body)) return undefined;
  return body.slice(0, 100).flatMap((e) => { const r = SiteChange.safeParse(e); return r.success ? [r.data] : []; })
    .filter((c) => !done.has(c.id) && now - Date.parse(c.at) <= SITE_WINDOW_MS && Date.parse(c.at) <= now + 5 * 60_000)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
}
/** The fetch (a test swaps it). At most 256 KB, 10 s, no redirect off the site. */
export const SITE = {
  changes: async (): Promise<unknown> => {
    const r = await fetch(`${SITE_BASE}/api/changes`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (Number(r.headers.get("content-length")) > 256_000) { await r.body?.cancel().catch(() => {}); return undefined; }
    const t = r.ok ? await r.text() : "";
    return t && t.length <= 256_000 ? JSON.parse(t) : undefined;
  },
};
/** site:changes (every 10 min): each website change, once (key site:<id>), one a run, oldest first; the post links the
 *  changed page. A failed fetch waits for the next run, without an alert. */
export const siteChangesHandler: Handler = {
  lane: "x",
  run: async () => {
    const body = await SITE.changes().catch(() => undefined);
    if (body === undefined) return "the site's change list was not readable";
    const ids = Array.isArray(body) ? body.slice(0, 100).map((e) => `site:${(e as { id?: unknown })?.id}`) : [];
    const done = new Set((await sql<{ ref: string }[]>`select ref from log where kind = 'announce' and ref = any(${ids})`).map((r) => r.ref.slice(5)));
    const c = siteChangeDue(body, done);
    if (!c) return "no new site change";
    const key = `site:${c.id}`, link = `${SITE_BASE}${c.url}`;
    const facts = { event: "site_changed", id: c.id, title: c.title, summary: c.summary, url: c.url };
    // the outbox row first: a crash before the site record leaves the id open, and the next run's insert is a no-op
    const queued = !!(await enqueueX(key, "post", facts, { link }));
    await announce(key, facts, { proof: link });
    if (queued) await requestArtFor(key, factSheet(facts));
    return { [key]: queued };
  },
};

// ---------------------------------------------------------------- the treasury's DNA (chain facts only)

type TreasuryRow = { tx: string; event: string; args: Record<string, string> };
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Deployment entries that are not one of DNA's own contracts (Uniswap's and Chainlink's, the token, the Safe itself). */
const NOT_OURS = new Set(["labels", "positionManager", "vrfCoordinator", "token", "safe", "agent", "anchorKey"]);
/** Who an address is, publicly: the deployment's `labels`, else one of DNA's own contracts, else nobody (a short address
 *  on the card, "a wallet" in words). */
export function labelOf(address: string, dep: Pick<Deployment, "labels"> & Record<string, unknown> = d): string | undefined {
  const a = address.toLowerCase();
  const own = Object.entries(dep.labels ?? {}).find(([k]) => k.toLowerCase() === a)?.[1];
  // a label is a few plain words: one with a digit or a link would be dropped from the post, so it is not used at all
  const clean = typeof own === "string" ? own.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40) : "";
  if (clean && !/\p{N}|[/@#$:]|\.[a-z]/iu.test(clean)) return clean;
  if (/^0x0{40}$/.test(a) || a === "0x000000000000000000000000000000000000dead") return "the burn address";
  const key = Object.entries(dep).find(([k, v]) => !NOT_OURS.has(k) && typeof v === "string" && ADDR.test(v) && v.toLowerCase() === a)?.[0];
  return key === "poolManager" ? "the Uniswap pool" : key ? `DNA's ${key.replace(/([A-Z])/g, " $1").toLowerCase()} contract` : undefined;
}
const pctOf = (wei: bigint, supply: bigint | undefined) => (supply ? Number((Number((wei * 10n ** 8n) / supply) / 1e6).toPrecision(3)) : undefined);
/** One tx's treasury facts from its DNA Transfer, pool Swap and hook FeeTaken logs (chain order). `bySafe`: the txs the
 *  Safe itself executed (its ExecutionSuccess or ExecutionFromModuleSuccess in the receipt): only those can be the
 *  treasury's buy (anyone can swap with the Safe as recipient). DNA into the Safe in such a tx that bought on the pool
 *  is the buy (at least 1 DNA; the ETH spent includes the hook's fee); DNA out of the Safe is a transfer per recipient
 *  (only the Safe can send it), a sale when the tx sold on the pool (the ETH received net of the fee). Anything else is
 *  nothing. */
export function treasuryFacts(rows: TreasuryRow[], safe: string, supply?: bigint, dep: Pick<Deployment, "labels"> & Record<string, unknown> = d, bySafe: ReadonlySet<string> = new Set()) {
  const s = safe.toLowerCase();
  const out: { key: string; tx: string; facts: Record<string, unknown> }[] = [];
  for (const tx of [...new Set(rows.map((r) => r.tx))]) {
    const of = rows.filter((r) => r.tx === tx);
    const swaps = of.filter((r) => r.event === "Swap").map((r) => BigInt(r.args.amount0));
    const fees = of.filter((r) => r.event === "FeeTaken").map((r) => ({ buy: String(r.args.buy) === "true", eth: BigInt(r.args.project ?? 0) + BigInt(r.args.platform ?? 0) }));
    const fee = (buy: boolean) => fees.filter((f) => f.buy === buy).reduce((n, f) => n + f.eth, 0n);
    const bought = swaps.filter((a) => a < 0n).reduce((n, a) => n - a, 0n), sold = swaps.filter((a) => a > 0n).reduce((n, a) => n + a, 0n);
    const transfers = of.filter((r) => r.event === "Transfer").map((r) => ({ from: String(r.args.from).toLowerCase(), to: String(r.args.to).toLowerCase(), value: BigInt(r.args.value) }));
    const into = transfers.filter((t) => t.to === s && t.from !== s).reduce((n, t) => n + t.value, 0n);
    if (into >= 10n ** 18n && bought > 0n && bySafe.has(tx)) out.push({ key: `treasury:${tx}:buy`, tx, facts: defined({ event: "treasury_buy", dnaAmount: Number(into / 10n ** 18n), ethSpent: ethOf(bought + fee(true)), supplyPct: pctOf(into, supply) }) });
    const outs = new Map<string, bigint>();
    for (const t of transfers) if (t.from === s && t.to !== s) outs.set(t.to, (outs.get(t.to) ?? 0n) + t.value);
    for (const [to, value] of outs) {
      const label = labelOf(to, dep);
      out.push({ key: `treasury:${tx}:out:${to}`, tx, facts: defined({ event: "treasury_transfer", dnaAmount: Number(value / 10n ** 18n), supplyPct: pctOf(value, supply),
        recipient: to, label, soldEth: sold > 0n ? ethOf(sold > fee(false) ? sold - fee(false) : 0n) : undefined }) });
    }
  }
  return out;
}
/** The Safe's own execution events (Safe v1.3+/1.4): ExecutionSuccess, ExecutionFromModuleSuccess. */
const SAFE_EXECUTED = ["0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e", "0x6895c13664aa4f67288b25d7a21d7aaa34916e355fb9b6fae0a139a9085becb8"];
/** Test seam: whether the Safe executed a tx (its receipt holds one of the Safe's execution events). */
export const TREASURY = {
  bySafe: async (tx: string): Promise<boolean> => {
    const r = await pub.getTransactionReceipt({ hash: tx as `0x${string}` });
    return r.logs.some((l) => l.address.toLowerCase() === d.safe.toLowerCase() && SAFE_EXECUTED.includes(String(l.topics[0]).toLowerCase()));
  },
};
/** How far the treasury job has read (a signed state row): every Safe move at or below it was handled. An unsigned or
 *  missing row reads from the start again (moves already queued are skipped; only the scan costs more). */
const treasuryCursor = async () => {
  const [r] = await sql<{ value: { block: number }; sig: string | null }[]>`select value, sig from state where key = 'treasury'`;
  return r && (await trusted("state", "treasury", r.value, r.sig)) ? r.value.block : -1;
};
/** treasury (every 10 min): the Safe's DNA moves in finalized logs from the deployment's `treasuryFromBlock` on (else
 *  the last 48 h), past the cursor, each posted once (its key), linking its tx; a buy only when the Safe executed the
 *  tx. The cursor moves past a run's blocks only when every receipt it needed was read: a failed read is tried again. */
export const treasuryHandler: Handler = {
  lane: "x",
  run: async () => {
    const safe = d.safe.toLowerCase(), cursor = await treasuryCursor();
    const from = typeof d.treasuryFromBlock === "number" ? sql`block >= ${d.treasuryFromBlock}` : sql`at >= ${new Date(Date.now() - 48 * HOUR)}`;
    const found = await sql<{ tx: string; block: number }[]>`select tx, max(block)::int as block from chain_log where event = 'Transfer' and address = ${d.token.toLowerCase()} and ${from}
      and block > ${cursor} and (lower(args->>'from') = ${safe} or lower(args->>'to') = ${safe}) group by tx`;
    const queued = new Set((await sql<{ k: string }[]>`select event_key as k from x_outbox where event_key like 'treasury:%'`).map((r) => r.k));
    const open = found.map((r) => r.tx).filter((tx) => ![...queued].some((k) => k.startsWith(`treasury:${tx}:`)));
    const advance = async (failed: number) => {
      const top = Math.max(-1, ...found.map((r) => r.block));
      if (failed || top <= cursor) return;
      await sql`insert into state (key, block, value, sig) values ('treasury', ${top}, ${sql.json({ block: top })}, ${await stateSig("state", "treasury", { block: top })})
        on conflict (key) do update set block = excluded.block, value = excluded.value, sig = excluded.sig, updated_at = now()`;
    };
    if (!open.length) { await advance(0); return "no new treasury DNA moves"; }
    const rows = await sql<TreasuryRow[]>`select tx, event, args from chain_log where tx = any(${open})
      and ((event = 'Transfer' and address = ${d.token.toLowerCase()}) or (event = 'Swap' and address = ${d.poolManager.toLowerCase()}) or (event = 'FeeTaken' and address = ${d.hook.toLowerCase()}))
      order by block, log_index`;
    const [c] = await sql<{ supply: string | null }[]>`select value->>'totalSupply' as supply from state where key = 'chain'`;
    const bySafe = new Set<string>(), unread = new Set<string>();
    // only a tx that swapped on the pool can be a buy: the receipt is read for those alone; a failed read leaves the
    // whole tx for the next run (never "not the Safe", which would lose a buy beside a transfer)
    for (const tx of new Set(rows.filter((r) => r.event === "Swap").map((r) => r.tx))) {
      try { if (await TREASURY.bySafe(tx)) bySafe.add(tx); } catch { unread.add(tx); }
    }
    const out: Record<string, boolean> = {};
    for (const p of treasuryFacts(rows.filter((r) => !unread.has(r.tx)), safe, c?.supply ? BigInt(c.supply) : undefined, d, bySafe)) {
      const link = `${TX_URL}${p.tx}`;
      out[p.key] = !!(await enqueueX(p.key, "post", p.facts, { link }));
      await announce(p.key, p.facts, { tx: link });
    }
    await advance(unread.size);
    return out;
  },
};
