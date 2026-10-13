// The Sequencer in the enclave: its builds, several at once (SEQ_PACE), from the idea queue to a live game.
// Each step reads and writes one signed `seq_build` row per build (table seq_build: at most one active build of an idea,
// by a unique index), so a crash resumes where it stopped; every step is idempotent.
//  idle       → open (SEQ_OPEN_DELAY_MIN after launch, default 0: at once), engine live, fewer than SEQ.maxInflight builds
//               on their way, fewer than SEQ.dailyTarget shipped or on their way today, no outage skip in the last
//               30 min, a game factory deployed, room in the
//               dev part of the day's cap: the top build idea (its neutral spec only) goes to the brain (build /
//               no-build, a signed `brain` record). Build ⇒ the whole build's budget (4 orders at the day's order
//               ceiling) is reserved (a `dev-reserve` row) ⇒ `decided`.
//  decided    → the round's order is signed (a `build` record, expiresAt = dispatch + 20 min, a fresh order id per
//               round = the single-use nonce) and dispatched once ⇒ `dispatched`.
//  dispatched → the run (run-name `seq order:<id>`; a second run of one order is alerted and never used; a re-run
//               attempt is refused) is charged from its report (a `dev-round` row: the reported cost clipped to the
//               ceiling, the whole ceiling without a readable report). Its pull request: the identity gate (G14) and
//               every other gate run here on the exact head with the kit from the image (M3: CI is advice), a signed
//               `gates` record carrying the enclave's own compile, the commit status. No run within 25 min (the order's 20 + 5), or no gated PR
//               4 h after dispatch ⇒ skipped (the idea goes back to the queue).
//  gated      → the brain's verdict (PR text, CI advice and the code are DATA). Code ANDs it with the gates: ship only
//               if every gate passed. Rework ⇒ the next round (at most 4, the old PR closed); kill ⇒ the PR closed.
//               A spec amendment the lead proposed (in the run's report) goes to the brain first, once a build, unless
//               the spec checks refuse it: approved, the amended spec is what the verdict and later orders carry, and
//               the ship record names it. A round with no verdict (no pull request) has its amendment reviewed as it
//               ends.
//  verdict    → a 4th live game would be one too many (counting the other ships on their way): of the games live 8 h
//               or more, the fewest-players one no other ship already evicts gets a brain-signed, delayed `retire`
//               record. Then the delayed `ship` record (one public hour, Safe veto: M1) with everything the deploy will
//               check: gated sha, the game folders' blob ids, salt, init code hash, predicted address, code hash.
//  shipping   → once the ship is in effect (and an evicted game is retired on-chain): (a) squash-merge pinned to the
//               gated sha, then the merge's game folders must equal the gated ones and nothing else may change; (b)
//               factory.deploy(initCode, salt) with the enclave's own compile (crash-safe: code at the predicted
//               address = landed), the code hash checked; (c) the starting fund queued, or "awaiting funding"; (d) a
//               `release` record for the merge commit that inherits the ship's hour, and `release` fast-forwarded;
//               (e) the idea shipped and its reward started (rewardShipped, basis = the ship record), the reservation
//               released ⇒ `shipped`.
// Any end (shipped, killed, skipped) releases the reservation with a row dated on the reservation's day, so the dev
// spend of a build nets to exactly its rounds' real costs. An outage before the verdict (GitHub, a model provider,
// RPC providers disagreeing, a deadline) skips the build; after it the ship path waits and retries.
// A build has a kind (the brain's choice at `idle`): a game, as above, or a site change (new pages of the site in a new
// route folder, no wallet). A site change goes the same way with its own gates (G1, G2, G11, G12, and G15 on the main
// site's pages), its ship record names the exact files it adds, and once the public hour passed it is merged and
// released; there is nothing to deploy or fund. It is announced as live only once the site serves it (siteServe). A module (a fee or split policy) is merged the same way and only proposed to the
// Safe (code hash, address, bounds, the registry calls); the engine sends none of them. An engine change is never
// merged here: its build ends `handed`, its pull request left open for an owner. With no idea queued, the brain may pick
// one of its own open risks (the self-file) to fix as a site change, a module or an engine change (improve, once a day).
// Hourly (seqHourly): retire games with no players for 48 h (brain-signed, delayed 1 h), sweep retired games,
// top up funded games after 5 new players, retry "awaiting funding", execute ready Delay funds, issue a release record
// when another merge moved main, fast-forward `release` to the newest release record in effect, post "nothing good
// enough today" for a finished day with no ship, and warn 14 days before the GitHub token expires.
import { createHash, randomBytes } from "node:crypto";
import { type Address, getAddress, getCreate2Address, type Hex, keccak256, stringToHex } from "viem";
import { effective, type Row, trustedRows, vetoed } from "./approve.ts";
import type { Rubric } from "./brain.ts";
import { d, IDEAS_LIVE, LLM, LOG_BASE_URL, SEQ_PACE } from "./config.ts";
import { edb as sql } from "./db.ts";
import { ENCLAVE } from "./enclave.ts";
import { Defer, type Handler } from "./jobs.ts";
import { append, type EnclaveRow, newestOf, RolledBack, rolledBack, stateSig, trusted, trustedRecord } from "./log.ts";
import { dailyCap, orderCeiling, overCap, publicTextIssues, RESERVE_AGENT, SPEC_DOMAIN, spendToday } from "./llm.ts";
import { slugOf, unpriced } from "./models.ts";
import { mode } from "./mode.ts";
import type { GatedModule } from "./seq-forge.ts";
import { type Touch, touchLines } from "./seq-gates.ts";
import { type GateResult, roots, under } from "./seq-gates.ts";
import { DEV_ROLES, type DevRole, type Kind, kindOf, type Order, ORDER_TTL_MS, orderRef } from "./seq-order.ts";
import type { SeqFacts } from "./announce.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const SEQ = {
  // after LLM_LAUNCH_AT (a compose literal): SEQ_OPEN_DELAY_MIN minutes, default 0 (the sequencer starts with the launch;
  // not an allowed env in the enclave, so the enclave uses the default)
  openAfterMs: Number(process.env.SEQ_OPEN_DELAY_MIN || 0) * 60_000,
  maxRounds: 4,
  fixRounds: 3,
  runStartMs: ORDER_TTL_MS + 5 * 60_000, // dispatch → a run: past the order's expiry, so no run can still start after it
  deployTries: 6, // failed deploys (15 min apart) before the ship is stopped
  codeWaits: 30, // minutes a mined deploy may show no code before its receipt is checked again
  orderMs: 4 * HOUR, // dispatch → a gated pull request
  publicHourMs: HOUR,
  maxInflight: SEQ_PACE.maxInflight, // builds at once (config.ts SEQ_PACE: 3)
  dailyTarget: SEQ_PACE.dailyTarget, // builds a UTC day, those shipped and those on their way (config.ts SEQ_PACE: 5)
  skipCooldownMs: 30 * 60_000, // a build skipped for an outage: the next one starts no sooner than this after it
  refusedCooldownMs: 2 * HOUR, // a dispatch GitHub refused (the token's rights): the next try no sooner than this after it
  evictMinAgeMs: 8 * HOUR, // a game is evicted for a new one only once it has been live this long
  pagesDailyWaitMs: 6 * HOUR, // the daily live page check waits for builds going at most this long
  ownIdeas: false, // with no idea queued, may the brain build a fix for one of its own open risks? Off: people's ideas only
  // does the website deploy from the build repository's `release` branch? Off, a site change would never reach the
  // site: the brain's pick of one is then a no-build, and nothing says a site change shipped or is live. On since the
  // site guard's second round: the main site's nonce CSP, the site gates' global allowlist (no reflection) and the page
  // check's CSP and link checks
  siteLive: true,
  // a released site change is announced (and its idea's author told it is live) only once the site serves it: the
  // health route names the merge or a later commit and each new page answers 200. Not served this long after the
  // release branch holds it (or the release branch not there this long after the first look): one alert, not
  // announced yet
  siteServeMs: 30 * 60_000,
  // then the hourly job looks again (the site may be deployed by hand), this long after the first look: served, it is
  // announced then; still not, one more alert and no more looks
  siteServeRecheckMs: 14 * DAY,
  siteReleaseMs: 3 * HOUR, // covers a release record's own hour and the hourly job that then moves the branch
  idleMs: 48 * HOUR, // no players this long ⇒ retire
  playersWindowBlocks: 14_400n, // ≈ 48 h of 12 s blocks
  tokenWarnDays: 14,
  /** the trusted kit the enclave gates with: the image's contracts dir (tests point it at the repo) */
  kit: process.env.SEQ_KIT_DIR ?? "/app/contracts",
  bot: process.env.SEQ_BOT ?? "",
  // a worker writes whole files (the page's are the largest): medium effort leaves its replies room for them, and $1 is
  // headroom for the page's (the order's ceiling bounds the round's total whatever the per-query caps)
  perQuery12: { lead: 2, worker: 1, tester: 1, fixer: 1, review: 2 } as Record<DevRole, number>,
  effort: { lead: "medium", worker: "medium", tester: "high", fixer: "high", review: "high" } as Order["effort"],
};
export const ROUND_AGENT = "dev-round";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// ---------------------------------------------------------------- pure rules

/** Open: launch time known and SEQ.openAfterMs passed since it. */
export const seqOpen = (now: number, launchAt = LLM.launchAt) => launchAt !== undefined && now >= launchAt + SEQ.openAfterMs;
/** A round's charge: the reported cost clipped to [0, ceiling]; the ceiling when the report is missing, belongs to
 *  another order, or comes from a re-run. */
export function chargeOf(report: unknown, o: { id: string; ceilingUsd: number }): number {
  const r = report as { orderId?: unknown; runAttempt?: unknown; totalUsd?: unknown } | null;
  if (!r || r.orderId !== o.id || String(r.runAttempt) !== "1" || typeof r.totalUsd !== "number" || !Number.isFinite(r.totalUsd)) return o.ceilingUsd;
  return Math.min(o.ceilingUsd, Math.max(0, r.totalUsd));
}
/** Per-query caps for an order ceiling (the $12 caps scaled down with it). */
export const perQuery = (ceiling: number) => Object.fromEntries(DEV_ROLES.map((r) => [r, Math.round(SEQ.perQuery12[r] * Math.min(1, ceiling / 12) * 100) / 100])) as Record<DevRole, number>;
/** The verdict code applies: ship only with every gate green; a rework after the 4th round is a kill. */
export function outcome(verdict: "ship" | "rework" | "kill", gates: GateResult[], round: number): "ship" | "rework" | "kill" {
  const v = verdict === "ship" && (gates.length === 0 || gates.some((g) => !g.ok)) ? "rework" : verdict;
  return v === "rework" && round >= SEQ.maxRounds ? "kill" : v;
}
/** The next round's issues: the verdict's and the failing gates', short (DATA in the next order). */
export const issuesFor = (verdictIssues: string[], gates: GateResult[]) =>
  [...verdictIssues, ...gates.filter((g) => !g.ok).flatMap((g) => g.issues.slice(0, 3).map((i) => `${g.gate} ${g.name}: ${i}`))].map((s) => s.slice(0, 300)).slice(0, 12);
/** A game's folder name: the title's words and the idea number (new at base, so G1's "new folder" holds). */
export function slugFor(title: string, idea: number) {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "");
  const s = `${/^[a-z]/.test(words) ? words : `g${words}`}-${idea}`.replace(/^g-/, "g");
  return s.length > 31 ? `g${idea}` : s.length < 3 ? `gx${idea}` : s;
}
/** Why a spec may not go into an order (it is sent to GitHub and stays public in the order record). */
export function specIssues(spec: string): string[] {
  const out: string[] = [];
  if (spec.trim().length < 20) out.push("the spec is too short");
  if (spec.length > 4000) out.push("the spec is over 4000 characters");
  for (const i of publicTextIssues(spec, SPEC_DOMAIN)) out.push(`the spec has a ${i}`);
  return out;
}
/** The rework rounds left after round `round` (what the verdict is told, so it never counts them itself). */
export const reworksLeft = (round: number) => Math.max(0, SEQ.maxRounds - round);

// ---------------------------------------------------------------- spec amendments
/** A spec amendment the sequencer's lead proposed: why the spec can't be built as written, and the smallest change. */
export type Amendment = { reason: string; change: string };
/** The amendment in a build's report, if any (model output: data, cut to the plan's limits). */
export function amendmentOf(report: unknown): Amendment | undefined {
  const a = (report as { amendment?: { reason?: unknown; change?: unknown } } | null)?.amendment;
  if (typeof a?.reason !== "string" || typeof a.change !== "string" || !a.reason.trim() || !a.change.trim()) return undefined;
  return { reason: a.reason.trim().slice(0, 300), change: a.change.trim().slice(0, 600) };
}
/** The amended spec: the spec as written, then the change and its reason. */
export const amendedSpec = (spec: string, a: Amendment) => `${spec}\n\nAmendment: ${a.change}\nWhy: ${a.reason}`;
/** A best-effort text screen, never the rule (the gates and the kit enforce every rule whatever the spec says): a change
 *  whose verb loosens a rule, a cap, a limit or a gate. Only the change is read; its reason may name what it avoids. */
const RELAX = /\b(?:rais|increas|lift|remov|drop|relax|loosen|skip|bypass|disabl|waiv|ignor|exceed)\w*\b[^.;:\n]{0,40}?\b(?:caps?|limits?|ceilings?|max(?:imum)?s?|budgets?|gates?|rules?|checks?|guards?|veto(?:es)?|timelocks?|bounds?|safety|tests?)\b/i;
/** The same screen for what the game rules forbid outright: value in, calls out, low-level code, weak randomness. A word
 *  the change says it goes without ("instead of blockhash", "the place of the draw block's blockhash", "no external
 *  calls") asks for nothing: a negation at most three plain words before it. A verb of change is no negation (replace X
 *  with blockhash asks for it), nor is "not only", and a preposition or a conjunction between ("no limit on deposits",
 *  "no external calls except token approvals") ends the negation's reach. */
const FORBIDDEN = /\b(?:payable|fallback|selfdestruct|suicide|delegatecall|assembly|tx\.origin|msg\.value|deposits?|token approvals?|external calls?|unchecked|prevrandao|blockhash)\b|\breceive\s*(?:\(|function)/gi;
const DROPPED = /\b(?:no|not(?!\s+only\b)|never|nor|without|instead of|rather than|place of|avoid\w*)\s+(?:(?!(?:on|of|for|to|with|in|at|from|by|and|or|but|also|except|than|plus)\b)[\w'’-]+\s+){0,3}$/i;
const forbids = (change: string) => [...change.matchAll(FORBIDDEN)].some((m) => !DROPPED.test(change.slice(0, m.index)));
/** Why an amendment can't be put to the brain: the amended spec fails the spec checks, or the change relaxes a rule or
 *  asks for something forbidden. */
export function amendmentIssues(spec: string, a: Amendment): string[] {
  const out = specIssues(amendedSpec(spec, a));
  if (RELAX.test(a.change)) out.push("the change would relax a rule, a cap, a limit or a gate");
  if (forbids(a.change)) out.push("the change asks for what the rules forbid");
  return out;
}
/** The spec a build is checked against: the amended one once the brain approved it, else the spec as written. */
export const specOf = (d: Pick<BuildData, "spec" | "specSha256" | "amendment">) =>
  d.amendment?.approved && d.amendment.spec && d.amendment.specSha256 ? { spec: d.amendment.spec, specSha256: d.amendment.specSha256 } : { spec: d.spec, specSha256: d.specSha256 };
/** The approved amendment as the ship record shows it. */
const amendmentShown = (d: BuildData) => (d.amendment?.approved ? { amendment: { reason: d.amendment.reason, change: d.amendment.change, specSha256: d.amendment.specSha256, brainSeq: d.amendment.brainSeq } } : {});
export type LiveGame = { game: Address; build: string; players48h: number; deployedAt: number };
/** The games a 4th one may evict, in turn: those live SEQ.evictMinAgeMs or more, fewest distinct players in 48 h first,
 *  then the oldest. */
export const evictOrder = <G extends LiveGame>(games: G[], now: number) => games.filter((g) => now - g.deployedAt >= SEQ.evictMinAgeMs).sort((a, b) => a.players48h - b.players48h || a.deployedAt - b.deployedAt);
export const evictee = (games: LiveGame[], now: number) => evictOrder(games, now)[0]?.game;
/** The idle rule: live 48 h or more and nobody played in the last 48 h. */
export const retireDue = (g: { ageMs: number; players48h: number }) => g.ageMs >= SEQ.idleMs && g.players48h === 0;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const startOfDay = (t: number) => Date.parse(`${dayOf(t)}T00:00:00Z`);

// ---------------------------------------------------------------- rows (signed state)

export type OrderState = { round: number; id: string; seq?: string; dispatchedAt?: string; runId?: number; charge?: number; pr?: number; gatedSha?: string; gatesSeq?: string; gatesOk?: boolean; verdictSeq?: string; verdict?: string; amendment?: Amendment };
export type BuildData = {
  /** absent: a game (the builds from before kinds existed) */
  kind?: Kind;
  /** a build of the brain's own (no idea behind it): the self-file's open risk it answers */
  risk?: string;
  idea: string; ideaNum: number; slug: string; title: string; spec: string; specSha256: string; rubric: Rubric; brainSeq: string;
  /** why the brain picked it (its build decision's reason: told when the build starts) */
  pick?: string;
  ceilingUsd: number; reservation: { at: string; amount: number }; building?: boolean; reserved?: boolean; released?: boolean;
  orders: OrderState[]; issues: string[];
  /** the one spec amendment the brain reviewed (approved: `spec` is what later orders and verdicts carry) */
  amendment?: Amendment & { round: number; approved: boolean; why: string; brainSeq?: string; spec?: string; specSha256?: string };
  ship?: { verdictSeq: string; reason: string; orderId: string; pr: number; gatedSha: string; baseSha: string; decidedAt: string; evictAsked?: string };
  shipSeq?: string; mergeSha?: string; game?: { address: Address; codehash: Hex; deployedAt: string }; fund?: { queued: boolean; why?: string; amount?: string };
  releaseSeq?: string; released_ff?: boolean; rewarded?: boolean; why?: string; endedAt?: string; deepChecked?: string;
  deployed?: boolean; deployedOnce?: boolean; deployFails?: number; codeWaits?: number; badMerge?: string; // the deploy mined; failed deploys; minutes waited for its code; a merge never to be released
  /** a site change: when the engine first looked for it on the site, and first saw the release branch hold it; `served`:
   *  when the site was seen serving it (only then is it announced, and told as live) */
  serve?: { since: string; onRelease?: string; gaveUp?: string }; served?: string;
};
export type Status = "decided" | "dispatched" | "gated" | "verdict" | "shipping" | "shipped" | "handed" | "killed" | "skipped";
export type BuildRow = { id: string; status: Status; round: number; data: BuildData };
export const ACTIVE: Status[] = ["decided", "dispatched", "gated", "verdict", "shipping"];

const valueOf = (r: BuildRow) => ({ status: r.status, round: r.round, data: r.data });
export async function saveBuild(r: BuildRow) {
  const value = JSON.parse(JSON.stringify(valueOf(r))) as ReturnType<typeof valueOf>;
  await sql`insert into seq_build (id, status, round, data, sig) values (${r.id}, ${r.status}, ${r.round}, ${sql.json(value.data as never)}, ${await stateSig("seq_build", r.id, value)})
    on conflict (id) do update set status = excluded.status, round = excluded.round, data = excluded.data, sig = excluded.sig, updated_at = now()`;
}
/** Builds matching `where` (enclave-signed rows only), newest first. */
async function builds(where: ReturnType<typeof sql>, limit?: number): Promise<BuildRow[]> {
  const rs = await sql<(BuildRow & { sig: string | null })[]>`select id, status, round, data, sig from seq_build where ${where}
    order by created_at desc ${limit ? sql`limit ${limit}` : sql``}`;
  const out: BuildRow[] = [];
  for (const r of rs) if (await trusted("seq_build", r.id, valueOf(r), r.sig)) out.push({ id: r.id, status: r.status, round: r.round, data: r.data });
  return out;
}
/** Every build on its way (at most SEQ.maxInflight start), oldest first. */
export const activeBuilds = async () => (await builds(sql`status = any(${ACTIVE})`, 20)).reverse();
/** The newest build on its way, if any. */
export const activeBuild = async () => (await activeBuilds()).at(-1) ?? null;
/** Where an idea's newest build stands, for the person who gave it: a game is live once its build is shipped, a site
 *  change once the site was seen serving it (siteServed, the same check that lets it be announced); a module never by
 *  us (the Safe decides). null: no signed build for it. */
export async function ideaShip(idea: string): Promise<{ target: Kind; live: boolean } | null> {
  const [r] = await builds(sql`data->>'idea' = ${idea}`, 5);
  if (!r) return null;
  const target = kindOf(r.data);
  const live = target === "game" ? r.status === "shipped" : target === "site" ? !!(r.data.mergeSha && r.data.served) : false;
  return { target, live };
}
/** Every shipped build (its game live or retired). */
const shippedBuilds = () => builds(sql`status = 'shipped'`);
/** Builds that ended shipped (or handed to an owner) whose ship was decided since `t`. */
const shippedSince = async (t: number) => (await builds(sql`status in ('shipped', 'handed') and data->'ship'->>'decidedAt' >= ${new Date(t).toISOString()}`)).length;
/** Builds skipped since `t` (the engine's clock, signed on the row when it ended). */
const skippedSince = async (t: number) => (await builds(sql`status = 'skipped' and data->>'endedAt' > ${new Date(t).toISOString()}`)).length;
const triedOn = async (day: string) => (await sql<{ n: number }[]>`select count(*)::int as n from seq_build where created_at >= ${new Date(`${day}T00:00:00Z`)} and created_at < ${new Date(Date.parse(`${day}T00:00:00Z`) + DAY)}`)[0].n;

// ---------------------------------------------------------------- spend (the dev part of the day's cap)

/** One spend row per (agent, ref), ever: a step retried after a crash never reserves, charges or releases twice. */
async function spendRow(agent: string, cost: number, ref: string, at: Date) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`seq-spend:${ref}`}))`;
    if ((await tx`select 1 from llm_call where agent = ${agent} and prompt_hash = ${ref} limit 1`).length) return;
    await tx`insert into llm_call (at, agent, budget, mode, requested_model, prompt_hash, schema_hash, input_hash, cost_usd, ok)
      values (${at}, ${agent}, 'dev', ${LLM.mode}, 'sequencer', ${ref}, '', '', ${cost}, true)`;
    await append("llm", agent, { agent, budget: "dev", ref, costUsd: cost, at: at.toISOString() }, tx);
  });
}
/** The whole build's budget held from the dev part of the reservation's day. */
const reserve = (r: BuildRow) => spendRow(RESERVE_AGENT, r.data.reservation.amount, `reserve:${r.id}`, new Date(r.data.reservation.at));
/** One round's real cost (counts toward the dev 70% alert), on the reservation's day. */
const charge = (r: BuildRow, orderId: string, amount: number) => spendRow(ROUND_AGENT, amount, `round:${orderId}`, new Date(r.data.reservation.at));
/** The reservation released on its own day: the build nets to its rounds' charges. */
async function releaseReservation(r: BuildRow) {
  if (!r.data.reserved || r.data.released) return;
  await spendRow(RESERVE_AGENT, -r.data.reservation.amount, `release:${r.id}`, new Date(r.data.reservation.at));
  r.data.released = true;
  await saveBuild(r);
}

// ---------------------------------------------------------------- the seams (tests replace them)

type Gh = typeof import("./github.ts");
export type Chain = {
  liveCount: () => Promise<number>;
  isLive: (game: Address) => Promise<boolean>;
  codeHash: (a: Address) => Promise<Hex | null>;
  players: (game: Address, sinceBlock?: bigint) => Promise<{ players48h: number; sinceFund: number }>;
  deploy: (initCode: Hex, salt: Hex, purpose: string) => Promise<{ status: string; error?: string }>;
  retire: (game: Address, purpose: string) => Promise<{ status: string; error?: string }>;
  sweep: (game: Address) => Promise<string>;
  /** the newest mined tx of this purpose still has a receipt */
  deployLanded: (purpose: string) => Promise<boolean>;
  /** the code hash at the lowest finalized block of the providers (null: no code there yet) */
  finalizedCodeHash: (a: Address) => Promise<Hex | null>;
};
export const SEQ_DEPS = {
  now: () => Date.now(),
  mode: () => mode(),
  /** why X may not post now (src/x.ts stopped: not live, or muted), null = it may */
  stopped: async (): Promise<string | null> => (await import("./x.ts")).stopped(),
  github: async (): Promise<Gh> => import("./github.ts"),
  queue: async () => import("./idea-queue.ts"),
  decide: async (kind: "build" | "verdict" | "retire" | "improve" | "amend", input: unknown, ref: string) => (await import("./brain.ts")).decide(kind, input, ref) as Promise<{ seq: string; decision: Record<string, unknown> }>,
  /** the self-file's open risks: the newest `self` record the enclave signed (its text hashing to its sha256), else the
   *  file brain-context writes (engine/brain/self.md) */
  openRisks: async (): Promise<string[]> => {
    const [row] = await sql<(EnclaveRow & { seq: string })[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where kind = 'self' order by log.seq desc limit 1`;
    if (row && (await trustedRecord(row, "self record"))) {
      const b = JSON.parse(row.body) as { text?: unknown; sha256?: unknown };
      if (typeof b.text === "string" && createHash("sha256").update(b.text).digest("hex") === b.sha256) return openRisksOf(b.text);
    }
    return openRisksOf(await (await import("node:fs/promises")).readFile(new URL("../brain/self.md", import.meta.url), "utf8").catch(() => ""));
  },
  models: async (): Promise<Order["models"]> => {
    const { activeModel } = await import("./swap.ts");
    const { model } = await import("./models.ts");
    // the sequencer runs Claude only (the Agent SDK): a swapped-in model of another family falls back to the registry's
    const claude = (id: string) => /^anthropic\/claude-[a-z0-9.-]+$/.test(id);
    return Object.fromEntries(await Promise.all(DEV_ROLES.map(async (r) => {
      const id = slugOf(await activeModel(`dev-${r}` as never));
      return [r, claude(id) ? id : slugOf(model(`dev-${r}` as never))];
    }))) as Order["models"];
  },
  runGates: async (...a: Parameters<typeof import("./seq-forge.ts").runGates>) => (await import("./seq-forge.ts")).runGates(...a),
  alert: async (text: string, key: string) => { await (await import("./telegram.ts")).alert(text, key); },
  /** The site record, and an X post (and the public Telegram chat's) for the types with an X priority (src/announce.ts
   *  onX: switched on, started, declined, killed, shipped, retired, released, a module proposed, an engine change handed
   *  over, an empty day; a round's steps only in live idea mode), its link the signed record (a pull request: the pull
   *  request). `record` must be a signed record's seq (resolvable at /api/log/<seq>). */
  announce: async (f: SeqFacts) => {
    if (!/^\d{1,18}$/.test(f.record) || !(await sql`select 1 from log where seq = ${f.record}`).length) throw new Error(`announce ${f.event}: no record ${f.record}`);
    const a = await import("./announce.ts");
    const key = a.seqKey(f);
    await a.announce(key, f as never);
    if (!a.onX(f.event)) return;
    const { GH } = await import("./github.ts");
    const link = f.event === "seq_pr" && /^[\w.-]+\/[\w.-]+$/.test(GH.repo) ? `https://github.com/${GH.repo}/pull/${f.pr}` : a.recordUrl(f.record);
    await (await import("./x.ts")).enqueueX(key, "post", f as never, { link });
    await (await import("./telegram.ts")).publicPost(`${a.titleOf(f as never)}\n${link}`, key);
  },
  fund: async () => import("./funding.ts"),
  chain: async (): Promise<Chain> => liveChain(),
  /** G15 (src/pages.ts): the page check at the gate, the public hour's deep run, the enclave's own ship cancel */
  pageGate: async (b: import("./pages.ts").BuildPage) => (await import("./pages.ts")).pageGate(b),
  sitePageGate: async (b: import("./pages.ts").SitePage) => (await import("./pages.ts")).sitePageGate(b),
  /** the module kit is in this image (an older image gates no module) */
  moduleKit: async () => {
    const { existsSync } = await import("node:fs");
    return (await import("./seq-forge.ts")).MODULE_KIT_FILES.every((f) => existsSync(`${SEQ.kit}/${f}`));
  },
  deepCheck: async (r: BuildRow, body: { gatedSha: string; gatesSeq: string; salt?: Hex }) => {
    const gh = await SEQ_DEPS.github();
    const { changes, texts } = await gh.changedFiles(r.data.ship!.baseSha, body.gatedSha);
    if (kindOf(r.data) === "module") return { ok: true, kill: false, why: "", violations: [] }; // a module has no page
    if (kindOf(r.data) === "site") return (await import("./pages.ts")).checkSite({ files: withDeleted(texts, changes), pages: [...(await gh.treeOf(body.gatedSha)).keys()] }, true);
    const g = await signedBody<GatesRecord>("gates", `gates:${r.data.ship!.orderId}`, body.gatesSeq);
    return (await import("./pages.ts")).checkBuild({ slug: r.data.slug, files: texts, factory: d.gameFactory!, safe: d.safe, initCode: g.game!.initCode, salt: body.salt!, gameAbi: gameAbiOf(texts, r.data.slug) }, true);
  },
  shipCancel: async (build: string, shipSeq: string, why: string) => { await (await import("./pages.ts")).shipCancel(build, shipSeq, why); },
  /** GET a path on the website (LOG_BASE_URL): its status, and its body read as JSON when `json` (at most 64 KB). 10 s,
   *  no redirect followed (a redirect is its own status). */
  siteGet: async (path: string, json = false): Promise<{ status: number; body?: unknown }> => {
    const r = await fetch(`${LOG_BASE_URL.replace(/\/+$/, "")}${path}`, { signal: AbortSignal.timeout(10_000), redirect: "manual", headers: { "cache-control": "no-cache" } });
    if (!json) { await r.body?.cancel().catch(() => {}); return { status: r.status }; }
    const t = await r.text();
    let body: unknown;
    try { body = t.length <= 65_536 ? JSON.parse(t) : undefined; } catch { body = undefined; }
    return { status: r.status, body };
  },
  /** M1 (src/approve.ts): in effect / vetoed */
  effective: (row: Row) => effective(row),
  vetoed: (row: Row) => vetoed(row),
};

async function liveChain(): Promise<Chain> {
  const abi = await import("./abi.ts");
  const { agreedHead, clients, readAgreed } = await import("./chainref.ts");
  const { getLogsChunked } = await import("./ticket-source.ts");
  const { pub, send } = await import("./tx.ts");
  const f = d.gameFactory!;
  const read = <T>(address: Address, a: readonly unknown[], functionName: string, args: unknown[] = []) =>
    agreedHead().then((blockNumber) => readAgreed((c) => (c.readContract({ address, abi: a, functionName, args, blockNumber } as never) as Promise<unknown>).then((x) => (typeof x === "bigint" ? String(x) : x)))) as Promise<T>;
  const played = async (game: Address, from: bigint, to: bigint) => {
    const logs = await readAgreed(async (c) => (await getLogsChunked((lo, hi) => c.getLogs({ address: game, event: { type: "event", name: "Played", inputs: [{ type: "address", name: "player", indexed: true }, { type: "uint256", name: "valueWei", indexed: false }] }, fromBlock: lo, toBlock: hi }), from, to)).map((l) => String(l.args.player).toLowerCase()));
    return new Set(logs).size;
  };
  return {
    liveCount: async () => Number(await read<string>(f, abi.gameFactoryAbi, "liveCount")),
    isLive: (game) => read<boolean>(f, abi.gameFactoryAbi, "isLive", [game]),
    codeHash: async (a) => {
      const blockNumber = await agreedHead();
      const code = await readAgreed((c) => c.getCode({ address: a, blockNumber }).then((x) => x ?? "0x"));
      return code && code !== "0x" ? keccak256(code) : null;
    },
    players: async (game, sinceBlock) => {
      const head = await agreedHead();
      const from = head > SEQ.playersWindowBlocks ? head - SEQ.playersWindowBlocks : 0n;
      return { players48h: await played(game, from, head), sinceFund: sinceBlock === undefined ? 0 : await played(game, sinceBlock + 1n, head) };
    },
    deploy: (initCode, salt, purpose) => send({ key: "agent", to: f, abi: abi.gameFactoryAbi, fn: "deploy", args: [initCode, salt], purpose }),
    retire: (game, purpose) => send({ key: "agent", to: f, abi: abi.gameFactoryAbi, fn: "retire", args: [game], purpose }),
    sweep: async (game) => {
      const free = BigInt(await read<string>(game, abi.gameKitAbi, "freeBalance"));
      if (free === 0n) return "nothing to sweep";
      const ok = await pub.simulateContract({ address: game, abi: abi.gameKitAbi, functionName: "sweep", account: ZERO }).then(() => true, () => false);
      if (!ok) return "sweep can't run yet (a round is open)";
      return (await send({ key: "keeper", to: game, abi: abi.gameKitAbi, fn: "sweep", purpose: `keeper:sweep:${game.toLowerCase()}` })).status;
    },
    deployLanded: async (purpose) => {
      const { trustedDocs } = await import("./records.ts");
      const tx = (await trustedDocs<{ status: string; hash?: Hex }>("tx", purpose, 10)).find((t) => t.status === "mined" && t.hash);
      if (!tx) return false;
      // only "no such receipt" means gone: any other RPC error throws (the caller waits and asks again)
      const rc = await pub.getTransactionReceipt({ hash: tx.hash! }).catch((e: Error) => { if (e.name === "TransactionReceiptNotFoundError") return null; throw e; });
      return rc?.status === "success";
    },
    finalizedCodeHash: async (a) => {
      const blockNumber = (await Promise.all(clients.map(async (c) => (await c.getBlock({ blockTag: "finalized" })).number!))).reduce((m, n) => (n < m ? n : m));
      const code = await readAgreed((c) => c.getCode({ address: a, blockNumber }).then((x) => x ?? "0x"));
      return code && code !== "0x" ? keccak256(code) : null;
    },
  };
}

// ---------------------------------------------------------------- helpers

/** The brain's reason as a public line (site, X fact sheet, public Telegram): no links, handles or foreign cashtags, at
 *  most 300 bytes, cut at a word with an ellipsis. */
export const publicReason = async (s: string) => (s.trim() ? (await import("./announce.ts")).clipReason((await import("./agents.ts")).sanitize(s), 300) : "");
const cur = (r: BuildRow) => r.data.orders.find((o) => o.round === r.round)!;
/** A round's dispatch on the site: round 1 is the build's start (it goes to X too), a later round stays on the site. */
export const building = (r: BuildRow, record: string): SeqFacts => r.round === 1
  ? { event: "seq_started", build: r.id, title: r.data.title, ...(r.data.pick ? { reason: r.data.pick } : {}), record }
  : { event: "seq_building", build: r.id, title: r.data.title, round: r.round, record };
export const branchOf = (o: { id: string; round: number }) => `seq/${o.id}-r${o.round}`;
/** The body of the record the signed build row names (kind, ref, seq), only as the enclave signed it: a row the DB
 *  swapped or forged never feeds a verdict, a ship record or a deploy. */
async function signedBody<T>(kind: "build" | "gates" | "ship", ref: string, seq: string): Promise<T> {
  const row = (await trustedRows(kind, ref, 10)).find((x) => x.seq === seq);
  if (!row) throw Object.assign(new Error(`the signed ${kind} record ${seq} (${ref}) is missing or not ours`), { final: true });
  return JSON.parse(row.body) as T;
}
const orderBody = (o: OrderState) => signedBody<Order>("build", orderRef(o), o.seq!);
const gatesBody = (o: OrderState) => signedBody<GatesRecord>("gates", `gates:${o.id}`, o.gatesSeq!);
/** The base's text of each file a change edits or removes (blob-verified; what G16 compares an engine change against). */
async function baseTexts(gh: Gh, tree: Map<string, import("./github.ts").Entry>, changes: { path: string; status: string }[]) {
  const out: Record<string, string> = {};
  for (const c of changes) {
    const e = tree.get(c.path);
    if (e && e.type === "blob" && (c.status === "M" || c.status === "D" || c.status === "T")) out[c.path] = (await gh.blob(e.sha)).toString("utf8");
  }
  return out;
}
/** A change's files for the page check: their texts, and each removed path as null (taken out of the check's copy). */
const withDeleted = (texts: Record<string, string>, changes: { path: string; status: string }[]): Record<string, string | null> =>
  ({ ...texts, ...Object.fromEntries(changes.filter((c) => c.status === "D").map((c) => [c.path, null])) });
/** The ABI in the gated game.json (the views a page can read), if it parses. */
function gameAbiOf(texts: Record<string, string>, slug: string): unknown[] | undefined {
  try { const a = (JSON.parse(texts[`web/app/g/${slug}/game.json`] ?? "") as { abi?: unknown }).abi; return Array.isArray(a) ? a : undefined; } catch { return undefined; }
}

/** An outage: GitHub down or rate limited, a model provider's 5xx, RPC providers disagreeing. */
async function isOutage(e: unknown) {
  const { outage } = await SEQ_DEPS.github();
  const m = (e as Error)?.message ?? "";
  return outage(e) || /^(openrouter|xai) 5\d\d|^pagecheck:|disagree|fetch failed|ECONNRESET|ETIMEDOUT|timed? ?out/i.test(m);
}

/** How a build GitHub refused to dispatch ends (its `why`): it waits SEQ.refusedCooldownMs, not the outage cooldown. */
const REFUSED = "dispatch refused: ";
async function end(r: BuildRow, status: "killed" | "skipped", why: string) {
  const q = await SEQ_DEPS.queue();
  if (r.data.building && r.data.idea) await q.setBuildStatus(r.data.idea, "building", status === "skipped" ? "queued" : "killed", why.slice(0, 300)).catch((e) => SEQ_DEPS.alert(`Sequencer: idea ${r.data.idea} status: ${(e as Error).message}`, `alert:seq:status:${r.id}`));
  const o = cur(r);
  if (o?.pr && !r.data.mergeSha) await (await SEQ_DEPS.github()).closePull(o.pr, status === "killed" ? "Not shipped." : "Skipped: the build stopped on an outage or a deadline.").catch(() => {});
  await releaseReservation(r);
  await saveBuild({ ...r, status, data: { ...r.data, why: why.slice(0, 500), endedAt: new Date(SEQ_DEPS.now()).toISOString() } });
  // a build that ends killed (a kill verdict, the 4th round, a stopped ship): one post, resting on its newest record
  if (status === "killed") {
    await SEQ_DEPS.announce({ event: "seq_killed", build: r.id, title: r.data.title, rounds: r.round, record: o?.verdictSeq ?? o?.gatesSeq ?? o?.seq ?? r.data.brainSeq })
      .catch((e) => SEQ_DEPS.alert(`Sequencer: ${r.id} killed, not announced: ${(e as Error).message.slice(0, 200)}`, `alert:seq:killed:${r.id}`));
  }
  if (status === "skipped") {
    const last = await builds(sql`status in (${"shipped"}, ${"killed"}, ${"skipped"})`, 2);
    // a refused dispatch has its own alert already
    if (last.length === 2 && last.every((x) => x.status === "skipped") && !why.startsWith(REFUSED)) await SEQ_DEPS.alert(`Sequencer: two builds in a row skipped (last: ${why.slice(0, 200)})`, `alert:seq:skips:${r.id}`);
  }
  return `${status}: ${why}`;
}

// ---------------------------------------------------------------- idle → decided

/** The first time the Sequencer is open, live, unmuted and has a factory: "switched on", once ever (its key), resting on the
 *  brain's newest self-file (what it can and can't do), else the newest public announcement; neither yet: not yet. */
async function online() {
  if ((await sql`select 1 from log where kind = 'announce' and ref = 'seq:online'`).length) return;
  // once ever: never queued while it can't reach X (muted, or not live), where it would be spent unseen
  if ((await SEQ_DEPS.stopped()) !== null) return;
  const [rec] = await sql<{ seq: string }[]>`select seq::text from log where kind in ('self', 'announce') order by (kind = 'self') desc, log.seq desc limit 1`;
  if (rec) await SEQ_DEPS.announce({ event: "seq_online", record: rec.seq });
}

/** How a site idea's kill reason starts while the website does not take site changes (the live engine wrote "the dev
 *  team's changes"): such an idea goes back to the queue once it does. */
const NO_SITE = "no-build: the website does not take";
/** The site ideas killed for the website went back to the queue in this process (simplification: once a process, not
 *  every minute; a restart looks once more, which finds nothing: the note replaced their kill reason). */
let requeued = false;
async function start(now: number): Promise<string> {
  if (!seqOpen(now)) return `closed: the Sequencer opens ${SEQ.openAfterMs / 60_000} min after launch`;
  if ((await SEQ_DEPS.mode()) !== "live") return "waiting: the engine is not live";
  if (!d.gameFactory) return "waiting: no game factory in the deployment";
  await online();
  const going = (await activeBuilds()).length;
  if (going >= SEQ.maxInflight) return `busy: ${going} builds on their way`;
  const shipped = await shippedSince(startOfDay(now));
  if (shipped + going >= SEQ.dailyTarget) return `done for today: ${shipped} shipped${going ? `, ${going} on their way` : ""} (the day's target is ${SEQ.dailyTarget})`;
  if ((await skippedSince(now - SEQ.skipCooldownMs)) > 0) return `waiting: a build was skipped (outage) in the last ${SEQ.skipCooldownMs / 60_000} min`;
  if ((await builds(sql`status = 'skipped' and data->>'why' like ${`${REFUSED}%`} and data->>'endedAt' > ${new Date(now - SEQ.refusedCooldownMs).toISOString()}`, 1)).length)
    return `waiting: GitHub refused a dispatch in the last ${SEQ.refusedCooldownMs / 60_000} min`;
  const q = await SEQ_DEPS.queue();
  // the site ideas killed while the website did not take site changes are built now (their kill reason starts so)
  if (SEQ.siteLive && !requeued) {
    for (const id of await q.requeueKilled(NO_SITE, "queued again: the website now takes the sequencer's changes")) await SEQ_DEPS.alert(`Sequencer: idea ${id} is back in the queue, now that the website takes site changes.`, `alert:seq:site-requeued:${id}`);
    requeued = true;
  }
  const [idea] = await q.buildQueue(1);
  // the sequencer builds only from people's ideas: an empty queue waits (its own open risks only when SEQ.ownIdeas)
  if (!idea) return SEQ.ownIdeas ? improve(now) : "nothing queued: waiting for people's ideas";
  // a person's idea only: an X author or an IdeaMarket submitter on record (never one the engine submitted itself)
  if (!idea.source) {
    await q.setBuildStatus(idea.id, "queued", "killed", "not built: no person's idea on record");
    return `not built: ${idea.id} has no author on record`;
  }
  const bad = specIssues(idea.spec);
  if (bad.length) {
    await q.setBuildStatus(idea.id, "queued", "killed", `not buildable: ${bad.join("; ")}`.slice(0, 300));
    return `not buildable: ${idea.id}`;
  }
  const cap = dailyCap(now);
  const ceiling = orderCeiling(cap);
  const why = overCap(await spendToday(), "dev", 4 * ceiling, { ...LLM, dailyCapUsd: cap });
  if (why) return `waiting: ${why}`;
  const b = await SEQ_DEPS.decide("build", { title: idea.title, spec: idea.spec, rubric: idea.rubric, untrusted: true }, `build:${idea.id}`);
  if (b.decision.decision !== "build") {
    await q.setBuildStatus(idea.id, "queued", "killed", `no-build: ${String(b.decision.reason)}`.slice(0, 300));
    // live idea mode: a no-build is news (the idea was accepted in public); the brain's reason without links or handles
    if (IDEAS_LIVE) await SEQ_DEPS.announce({ event: "seq_declined", idea: idea.id, title: idea.title, reason: (await publicReason(String(b.decision.reason ?? ""))), record: String(b.seq) })
      .catch((e) => SEQ_DEPS.alert(`Sequencer: the no-build of ${idea.id} was not announced: ${(e as Error).message.slice(0, 200)}`, `alert:seq:declined:${idea.id}`));
    return `no-build: ${idea.id}`;
  }
  // an idea skipped for an outage goes back to the queue and may start again the same day: a fresh id for each try
  // (its own row, reservation and release)
  const stem = `b${dayOf(now).replace(/-/g, "")}-${idea.idea}`;
  const [{ n: tries }] = await sql<{ n: number }[]>`select count(*)::int as n from seq_build where id = ${stem} or id like ${`${stem}-%`}`;
  const id = tries ? `${stem}-${tries + 1}` : stem;
  const kind: Kind = b.decision.target === "site" || b.decision.target === "module" ? b.decision.target : "game";
  if (kind === "site" && !SEQ.siteLive) {
    await SEQ_DEPS.alert(`Sequencer: the brain picked a site change for idea ${idea.id}, but the website does not deploy from the build repository's release branch; the idea is not built.`, `alert:seq:nosite:${idea.id}`);
    await q.setBuildStatus(idea.id, "queued", "killed", `${NO_SITE} the sequencer's changes yet`);
    // live idea mode: the idea was queued in public, so its end is public too (never a silent drop)
    if (IDEAS_LIVE) await SEQ_DEPS.announce({ event: "seq_declined", idea: idea.id, title: idea.title, reason: "the website does not take the sequencer's changes yet, so a site page is not built for now", record: String(b.seq) })
      .catch((e) => SEQ_DEPS.alert(`Sequencer: the no-build of ${idea.id} was not announced: ${(e as Error).message.slice(0, 200)}`, `alert:seq:declined:${idea.id}`));
    return `no-build: ${idea.id} (the website does not take site changes yet)`;
  }
  // a module needs the module kit in this image (it ships with the image before the brain can pick one): else no-build
  if (kind === "module" && !(await SEQ_DEPS.moduleKit())) {
    await SEQ_DEPS.alert(`Sequencer: the brain picked a module for idea ${idea.id}, but this image has no module kit; the idea is not built.`, `alert:seq:nokit:${idea.id}`);
    await q.setBuildStatus(idea.id, "queued", "killed", "no-build: the module kit is not in this image yet");
    return `no-build: ${idea.id} (no module kit in this image)`;
  }
  const r: BuildRow = {
    id, status: "decided", round: 1,
    data: { kind, idea: idea.id, ideaNum: idea.idea, slug: slugFor(idea.title, idea.idea), title: idea.title, spec: idea.spec, specSha256: (await import("./seq-gates.ts")).sha256(idea.spec), rubric: idea.rubric, brainSeq: String(b.seq), ...(IDEAS_LIVE ? { pick: (await publicReason(String(b.decision.reason ?? ""))) } : {}), ceilingUsd: ceiling, reservation: { at: new Date(now).toISOString(), amount: 4 * ceiling }, orders: [{ round: 1, id: orderIdFor(id, 1) }], issues: [] },
  };
  await saveBuild(r); // first: the unique index refuses a second active build of the same idea
  return prepare(r);
}

/** The build's idea marked building and its budget reserved, once each (a crash in between resumes here). */
/** The open risks in a self-file (its "Open risks" section's bullets): at most 10, each cut to 300 characters. */
export function openRisksOf(md: string): string[] {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s*open risks\b/i.test(l.trim()));
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(l.trim())) break;
    const m = l.match(/^\s*[-*]\s+(.+)$/);
    if (m) out.push(m[1].trim().slice(0, 300));
  }
  return out.slice(0, 10);
}

/** No idea queued: the brain may pick one of its own open risks (the self-file's) to fix: a site change, a module or an
 *  engine change. Once a day at most; no open risk, no call. A build of its own has no idea behind it (no reward). */
async function improve(now: number): Promise<string> {
  const risks = await SEQ_DEPS.openRisks();
  if (!risks.length) return "nothing queued";
  const day = dayOf(now);
  if ((await sql`select 1 from log where kind = 'brain' and ref = ${`improve:${day}`} limit 1`).length) return "nothing queued (the open risks were weighed today)";
  const cap = dailyCap(now);
  const ceiling = orderCeiling(cap);
  const why = overCap(await spendToday(), "dev", 4 * ceiling, { ...LLM, dailyCapUsd: cap });
  if (why) return `waiting: ${why}`;
  // the self-file is the engine's own, but it quotes the log (titles, reasons) others wrote: data, never instructions
  const b = await SEQ_DEPS.decide("improve", { openRisks: risks, untrusted: true }, day);
  const x = b.decision as { improve: boolean; risk: string; target: Kind; title: string; spec: string; rubric: Rubric; reason: string };
  if (!x.improve) return `nothing to improve today: ${String(x.reason).slice(0, 120)}`;
  const bad = specIssues(x.spec);
  if (!["site", "module", "engine"].includes(x.target)) bad.push(`target ${x.target}`);
  if (x.target === "site" && !SEQ.siteLive) bad.push("the website does not take site changes yet");
  if (bad.length) return `not buildable: ${bad.join("; ")}`.slice(0, 300);
  const id = `b${day.replace(/-/g, "")}-s${(await triedOn(day)) + 1}`;
  const r: BuildRow = {
    id, status: "decided", round: 1,
    data: {
      kind: x.target, risk: String(x.risk ?? "").slice(0, 300), idea: "", ideaNum: 0, slug: slugFor(x.title || "change", Math.floor(now / DAY)), title: x.title || "A change", spec: x.spec, specSha256: (await import("./seq-gates.ts")).sha256(x.spec),
      rubric: x.rubric, brainSeq: String(b.seq), ceilingUsd: ceiling, reservation: { at: new Date(now).toISOString(), amount: 4 * ceiling }, building: true, orders: [{ round: 1, id: orderIdFor(id, 1) }], issues: [],
    },
  };
  await saveBuild(r);
  return prepare(r);
}

async function prepare(r: BuildRow) {
  if (!r.data.building) {
    const q = await SEQ_DEPS.queue();
    // a crash after the status moved and before this row was saved: the idea is already building
    await q.setBuildStatus(r.data.idea, "queued", "building", r.id).catch((e) => q.setBuildStatus(r.data.idea, "building", "building", r.id).catch(() => { throw e; }));
    r.data.building = true;
    await saveBuild(r);
  }
  if (!r.data.reserved) {
    await reserve(r);
    r.data.reserved = true;
    await saveBuild(r);
  }
  return `decided: ${r.id} (${r.data.slug})`;
}

// ---------------------------------------------------------------- decided → dispatched

/** A round's order id, drawn when the round is planned and saved with it (a retried dispatch keeps it): the build and
 *  round, and a random suffix, so no one can start a workflow run under a coming order's id ahead of it. */
export const orderIdFor = (build: string, round: number) => `${build}-r${round}-${randomBytes(6).toString("hex")}`;

/** The order of the build's current round, under the id saved with the round. */
export function orderOf(r: BuildRow, baseSha: string, models: Order["models"], now: number): Order {
  const id = cur(r).id;
  const kind = kindOf(r.data);
  return {
    v: 1, ...(kind === "game" ? {} : { kind }), id, build: r.id, round: r.round, slug: r.data.slug, salt: keccak256(stringToHex(id)), factory: d.gameFactory!.toLowerCase(), safe: d.safe.toLowerCase(),
    baseSha, ...specOf(r.data), rubric: r.data.rubric, models, effort: SEQ.effort,
    budget: { ceilingUsd: r.data.ceilingUsd, perQueryUsd: perQuery(r.data.ceilingUsd) }, fixRounds: SEQ.fixRounds, issues: r.data.issues,
    expiresAt: new Date(now + ORDER_TTL_MS).toISOString(),
  };
}

async function dispatchRound(r: BuildRow, now: number): Promise<string> {
  // the sequencer's spend is metered at models.json prices: an unpriced model would be charged a guess, so no order
  // goes out until every model has a price (the build waits in `decided`)
  const models = await SEQ_DEPS.models();
  const missing = unpriced(Object.values(models));
  if (missing.length) {
    const why = `not dispatched: no price in models.json for ${missing.join(", ")}`;
    await SEQ_DEPS.alert(`Sequencer: build ${r.id} ${why}. Price the model or swap it.`, `alert:seq:unpriced:${r.id}`);
    return why;
  }
  if (!r.data.building || !r.data.reserved) await prepare(r);
  const gh = await SEQ_DEPS.github();
  const o = orderOf(r, await gh.refSha("main"), models, now);
  const rec = await append("build", orderRef(o), o);
  const [row] = await sql<{ seq: string; kind: string; ref: string; body: string; eprev: string | null; ehash: string | null; esig: string | null }[]>`
    select seq::text, kind, ref, body, encode(eprev, 'hex') as eprev, encode(ehash, 'hex') as ehash, esig from log where seq = ${rec.seq}`;
  if (!row?.esig) throw Object.assign(new Error("orders are signed by the enclave's log key only"), { final: true });
  // saved before the dispatch: one dispatch per order, ever (a failed one ends as "no run in time")
  const os = r.data.orders.map((x) => (x.round === r.round ? { ...x, id: o.id, seq: rec.seq, dispatchedAt: new Date(now).toISOString() } : x));
  const sent: BuildRow = { ...r, status: "dispatched", data: { ...r.data, orders: os } };
  await saveBuild(sent);
  try {
    await gh.dispatch(row);
  } catch (e) {
    // GitHub refused it (a 4xx: the token's rights, the repository): it never landed, so no run can come. Said at once,
    // and the build ends skipped (the idea back in the queue for the next try)
    if (e instanceof gh.GitHubError && !gh.outage(e)) {
      const why = `${REFUSED}${o.id}: ${e.message.slice(0, 200)}`;
      await SEQ_DEPS.alert(`🚨 Sequencer: GitHub refused the dispatch of ${r.id} (HTTP ${e.status}): ${e.message.slice(0, 300)}. No build can start until the token or repository is fixed; the idea is back in the queue.`, `alert:seq:dispatch:${r.id}`);
      return end(sent, "skipped", why);
    }
    // it may have landed: like a dispatch that never did, the run is matched (and charged) if it comes before the deadline
    if (!(await isOutage(e))) throw e;
    return `dispatch of ${o.id} unconfirmed (${(e as Error).message.slice(0, 120)}): waiting for a run`;
  }
  await SEQ_DEPS.announce(building(r, rec.seq));
  return `dispatched: ${o.id}`;
}

// ---------------------------------------------------------------- dispatched → gated

async function intake(r: BuildRow, now: number): Promise<string> {
  const gh = await SEQ_DEPS.github();
  const o = cur(r);
  const since = Date.parse(o.dispatchedAt!);
  const runs = await gh.runsFor(orderRef(o));
  if (runs.length > 1) await SEQ_DEPS.alert(`Sequencer: ${runs.length} runs for order ${o.id}; only the first counts.`, `alert:seq:runs:${o.id}`);
  const run = runs[0];
  if (!run) return now - since > SEQ.runStartMs ? end(r, "skipped", `no run of ${o.id} within ${SEQ.runStartMs / 60_000} min`) : "waiting for the run";
  if (o.charge === undefined) {
    // a dispatch that failed on an outage never announced: once its run shows, it did land (announce dedupes by key)
    await SEQ_DEPS.announce(building(r, o.seq!));
    if (run.status !== "completed") {
      if (now - since <= SEQ.orderMs) return "waiting: the run is going";
      await charge(r, o.id, r.data.ceilingUsd); // it may have spent anything up to the ceiling
      return end(r, "skipped", `${o.id} ran past 4 h`);
    }
    const attempt = (await gh.runOf(run.id)).run_attempt;
    const report = attempt === 1 ? await gh.artifactFile(run.id, "build", "report.json").then((b) => (b ? JSON.parse(b.toString("utf8")) : null), () => null) : null;
    const c = chargeOf(report, { id: o.id, ceilingUsd: r.data.ceilingUsd });
    await charge(r, o.id, c);
    const amendment = attempt === 1 && report?.orderId === o.id ? amendmentOf(report) : undefined;
    Object.assign(o, { runId: run.id, charge: c, ...(amendment ? { amendment } : {}) });
    await saveBuild(r);
    if (attempt !== 1) {
      await SEQ_DEPS.alert(`Sequencer: order ${o.id} was re-run (attempt ${attempt}); its output is refused.`, `alert:seq:rerun:${o.id}`);
      return next(r, ["the run was re-run: its output is refused"]);
    }
  }
  const pr = await gh.pullOn(branchOf(o));
  if (!pr || pr.state !== "open") return next(r, ["the sequencer stopped without a pull request this round"]);
  o.pr = pr.number; // known before the deadline below, so end() closes it
  if (now - since > SEQ.orderMs) return end(r, "skipped", `${o.id}: not gated within 4 h`);
  const order = await orderBody(o);
  const commits = await gh.pullCommits(pr.number);
  const { identityGate } = await import("./seq-gates.ts");
  const id = identityGate({
    headRepo: pr.head.repo?.full_name ?? "", baseRepo: pr.base.repo.full_name, author: pr.user.login, headRef: pr.head.ref, headSha: pr.head.sha,
    commits: commits.map((c) => ({ sha: c.sha, parents: c.parents.map((p) => p.sha), author: c.author?.login ?? "", committer: c.committer?.login ?? "", verified: !!c.commit.verification?.verified })),
  }, { orderId: o.id, round: r.round, baseSha: order.baseSha, gatedSha: pr.head.sha, bot: SEQ.bot });
  let results: GateResult[] = [id];
  let game: { initCode: Hex; runtime: Hex | null; name: string } | undefined;
  let module: GatedModule | undefined;
  let run2Touch: Touch[] | undefined;
  // the kind the signed order carries (the build row's, as the enclave signed it)
  const kind = kindOf(order);
  if (id.ok) {
    const { changes, texts } = await gh.changedFiles(order.baseSha, pr.head.sha);
    // a game or a module needs its folders new at the base; a site change, the base's paths (no new file named like one
    // but for case)
    const baseTree = await gh.treeOf(order.baseSha);
    const baseHasSlug = (kind === "game" || kind === "module") && roots(r.data.slug, kind).some((p) => gh.hasPrefix(baseTree, p));
    if (ENCLAVE.on) process.env.SEQ_SOLC ??= "/usr/local/bin/solc"; // the image's pinned solc (P5)
    const run2 = await SEQ_DEPS.runGates({ kind, slug: r.data.slug, changes, files: texts, baseHasSlug, ...(kind === "site" ? { basePaths: [...baseTree.keys()] } : {}), ...(kind === "engine" ? { baseFiles: await baseTexts(gh, baseTree, changes) } : {}), prBody: pr.body ?? "", kit: SEQ.kit, order: { seed: pr.head.sha, specSha256: order.specSha256, factory: getAddress(order.factory), safe: getAddress(order.safe), salt: order.salt as Hex } });
    results = [id, ...run2.results];
    if (run2.game) game = { initCode: run2.game.initCode, runtime: run2.game.runtime, name: run2.game.name };
    if (kind === "module") module = run2.module;
    if (kind === "engine") run2Touch = run2.touch;
    // G15: the page in a browser, once everything else passed (it builds and runs the page)
    if (results.every((g) => g.ok) && kind === "game" && game?.runtime) {
      results.push(await SEQ_DEPS.pageGate({ slug: r.data.slug, files: texts, factory: getAddress(order.factory), safe: getAddress(order.safe), initCode: game.initCode, salt: order.salt as Hex, gameAbi: gameAbiOf(texts, r.data.slug) }));
    }
    if (results.every((g) => g.ok) && kind === "site") results.push(await SEQ_DEPS.sitePageGate({ files: withDeleted(texts, changes), pages: [...(await gh.treeOf(pr.head.sha)).keys()] }));
  }
  const ok = results.every((g) => g.ok) && (kind === "game" ? !!game?.runtime : kind === "module" ? !!module : kind === "engine" || results.some((g) => g.gate === "G15"));
  const rec = await append("gates", `gates:${o.id}`, {
    build: r.id, order: o.id, round: r.round, pr: pr.number, sha: pr.head.sha, ok, results,
    ...(game ? { game: { name: game.name, initCode: game.initCode, initCodeHash: keccak256(game.initCode), codehash: game.runtime ? keccak256(game.runtime) : null } } : {}),
    // the enclave's own compile of a module: what the Safe is asked to approve
    ...(module ? { module: { name: module.name, kind: module.kind, initCode: module.initCode, initCodeHash: keccak256(module.initCode), codehash: module.codehash, salt: module.salt, address: module.address, bounds: module.bounds } } : {}),
    ...(run2Touch ? { touch: run2Touch } : {}),
  });
  await gh.setStatus(pr.head.sha, ok ? "success" : "failure", ok ? "every enclave gate passed" : `failed: ${results.filter((g) => !g.ok).map((g) => g.gate).join(", ")}`).catch(() => {});
  Object.assign(o, { pr: pr.number, gatedSha: pr.head.sha, gatesSeq: rec.seq, gatesOk: ok });
  await saveBuild({ ...r, status: "gated" });
  await SEQ_DEPS.announce({ event: "seq_pr", build: r.id, title: r.data.title, round: r.round, pr: pr.number, failed: results.filter((g) => !g.ok).map((g) => g.gate), record: rec.seq });
  // a page that did something the check does not allow is a kill, not a rework
  const page = results.find((g) => g.gate === "G15" && (g as { kill?: boolean }).kill);
  if (page) {
    await SEQ_DEPS.alert(`🚨 Sequencer: the page check of ${o.id} failed (gates record ${rec.seq}): ${page.issues.slice(0, 3).join("; ").slice(0, 300)}. The build is killed and its pull request closed.`, `alert:seq:page:${o.id}`);
    return end(r, "killed", "the page check failed (G15)");
  }
  return `gated: ${o.id} ${ok ? "all green" : "with failures"}`;
}

/** The next round (with these issues; the old PR closed), or a kill after the 4th. */
async function next(r: BuildRow, issues: string[]): Promise<string> {
  const o = cur(r);
  // a round that ended without a verdict (no pull request: its review would not pass code built to an amendment not yet
  // ruled on) still has its amendment reviewed here; at a verdict it already was, and this is a no-op
  const am = await reviewAmendment(r, o);
  if (am.approved) issues = ["the spec amendment was approved: build to the amended spec in this order", ...issues];
  else if (am.notes.length) issues = [...am.notes, ...issues];
  else if (o.amendment && r.data.amendment?.round !== r.round && r.data.amendment?.brainSeq && r.round < SEQ.maxRounds) issues = [`the spec amendment proposed in round ${r.round} was not put to the brain: it already ruled on one in round ${r.data.amendment.round} (${r.data.amendment.approved ? "approved" : "refused"}), and rules once a build`, ...issues];
  if (o.pr) await (await SEQ_DEPS.github()).closePull(o.pr, "Superseded: this build goes on in its next round.").catch(() => {});
  if (r.round >= SEQ.maxRounds) return end(r, "killed", `no shippable build after ${SEQ.maxRounds} rounds`);
  const round = r.round + 1;
  await saveBuild({ ...r, status: "decided", round, data: { ...r.data, issues: issues.slice(0, 12), orders: [...r.data.orders, { round, id: orderIdFor(r.id, round) }] } });
  return `rework: round ${round}`;
}

// ---------------------------------------------------------------- gated → verdict

type GatesRecord = {
  results: GateResult[]; ok: boolean; sha: string; game?: { name: string; initCode: Hex; initCodeHash: Hex; codehash: Hex | null };
  module?: Omit<GatedModule, "runtime"> & { initCodeHash: Hex };
  touch?: Touch[];
};
async function verdict(r: BuildRow, now: number): Promise<string> {
  const o = cur(r);
  const g = await gatesBody(o);
  const gh = await SEQ_DEPS.github();
  const pr = await gh.pullOn(branchOf(o));
  const order = await orderBody(o);
  const same = pr?.state === "open" && pr.head.sha === o.gatedSha;
  const code = same ? Object.entries((await gh.changedFiles(order.baseSha, o.gatedSha!)).texts).map(([p, t]) => `--- ${p}\n${t}`).join("\n").slice(0, 60_000) : "";
  const ci = await gh.ciAdvice(o.gatedSha!).catch(() => null);
  const am = await reviewAmendment(r, o);
  // approved just now: the round was built to the old spec, so it is rebuilt to the amended one (what ships always
  // carries the signed, amended spec), never shipped as it is
  if (am.approved) return next(r, ["the spec amendment was approved: build to the amended spec in this order"]);
  const a = r.data.amendment;
  const v = await SEQ_DEPS.decide("verdict", {
    spec: specOf(r.data).spec, title: r.data.title, round: r.round, maxRounds: SEQ.maxRounds, reworkRoundsLeft: reworksLeft(r.round),
    ...(a ? { amendment: { untrusted: true, reason: a.reason, change: a.change, approved: a.approved, why: a.why } } : {}),
    gates: g.results.map((x) => ({ gate: x.gate, name: x.name, ok: x.ok, issues: x.issues.slice(0, 5) })),
    // an engine change: what each file reaches (computed by the gates, not the change's own words)
    ...(g.touch ? { touch: g.touch } : {}),
    ciAdvice: { untrusted: true, ...(ci ?? { status: "none" }) },
    pullRequestText: { untrusted: true, text: (pr?.body ?? "").slice(0, 2000) }, code: { untrusted: true, text: code },
  }, `verdict:${o.id}`);
  const dv = v.decision as { verdict: "ship" | "rework" | "kill"; reason: string; issues: string[] };
  // both signed: the gates record and the build row's own note of it
  const res = outcome(dv.verdict, g.ok && o.gatesOk === true ? g.results : [...g.results, { gate: "G13", name: "address", ok: false, issues: ["no deployable compile"] }], r.round);
  Object.assign(o, { verdictSeq: String(v.seq), verdict: res });
  // a site build from before the site stopped taking them: its verdict would say it goes live, so it is not announced
  if (kindOf(r.data) !== "site" || SEQ.siteLive) await SEQ_DEPS.announce({ event: "seq_verdict", build: r.id, title: r.data.title, round: r.round, verdict: res, reason: await publicReason(dv.reason), record: String(v.seq) });
  if (res === "ship") {
    if (!same || !pr) return next(r, ["the pull request moved or closed after it was gated"]);
    await saveBuild({ ...r, status: "verdict", data: { ...r.data, ship: { verdictSeq: String(v.seq), reason: dv.reason.slice(0, 400), orderId: o.id, pr: pr.number, gatedSha: o.gatedSha!, baseSha: order.baseSha, decidedAt: new Date(now).toISOString() } } });
    return `ship decided: ${o.id}`;
  }
  if (res === "kill") return end(r, "killed", dv.verdict === "kill" ? dv.reason : `no shippable build after ${SEQ.maxRounds} rounds`);
  return next(r, [...am.notes, ...issuesFor(dv.issues, g.results)]);
}

/** The lead's spec amendment, put to the brain once a build (at the end of the round that proposed it, at its verdict
 *  or without one, while a round is left to build it): one the text screen refuses never reaches it, and a later round's
 *  may still be put to it. Each round's is reviewed once. Approved just now: `approved` (the caller rebuilds the round);
 *  refused just now: the note for the next round. */
async function reviewAmendment(r: BuildRow, o: OrderState): Promise<{ approved: boolean; notes: string[] }> {
  const done = r.data.amendment && (r.data.amendment.brainSeq || r.data.amendment.round === r.round);
  if (done || !o.amendment || reworksLeft(r.round) === 0) return { approved: false, notes: [] };
  const a = o.amendment;
  const spec = amendedSpec(r.data.spec, a);
  const bad = amendmentIssues(r.data.spec, a);
  let approved = false;
  let why = bad.join("; ");
  let brainSeq: string | undefined;
  if (!bad.length) {
    // a crash after the brain's record and before this row was saved: that record is the ruling (the brain rules once a
    // build), never asked for again
    const [row] = await sql<(EnclaveRow & { seq: string })[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where kind = 'brain' and ref = ${`amend:${r.id}`} order by log.seq desc limit 1`;
    const b = row && (await trustedRecord(row, "brain record"))
      ? { seq: row.seq, decision: (JSON.parse(row.body) as { decision: Record<string, unknown> }).decision }
      : await SEQ_DEPS.decide("amend", { kind: kindOf(r.data), title: r.data.title, spec: r.data.spec, reason: a.reason, change: a.change, amendedSpec: spec, untrusted: true }, r.id);
    approved = b.decision.approve === true;
    why = String(b.decision.reason ?? "");
    brainSeq = String(b.seq);
  }
  r.data.amendment = { ...a, round: r.round, approved, why: why.slice(0, 300), ...(brainSeq ? { brainSeq } : {}), ...(approved ? { spec, specSha256: (await import("./seq-gates.ts")).sha256(spec) } : {}) };
  await saveBuild(r);
  return { approved, notes: approved ? [] : [`the spec amendment was refused (${why.slice(0, 200)}): build the spec as written`] };
}

// ---------------------------------------------------------------- verdict → shipping (the ship record)

/** Live games: shipped builds whose game the factory still lists as live. */
async function liveGames(chain: Chain): Promise<(LiveGame & { row: BuildRow })[]> {
  const out: (LiveGame & { row: BuildRow })[] = [];
  for (const b of await shippedBuilds()) {
    if (b.status !== "shipped" || !b.data.game) continue;
    if (!(await chain.isLive(b.data.game.address))) continue;
    const p = await chain.players(b.data.game.address);
    out.push({ game: b.data.game.address, build: b.id, players48h: p.players48h, deployedAt: Date.parse(b.data.game.deployedAt), row: b });
  }
  return out;
}
type RetireRecord = { kind: "retire"; game: Address; build: string; rule: "idle" | "evict"; players48h: number; ageH: number; brain: string; effectiveAt: string };
const retireRows = (game: Address) => trustedRows("retire", `retire:${game.toLowerCase()}`, 5);
/** A pending (not vetoed) retire record for a game, if any. */
async function pendingRetire(game: Address) {
  for (const row of await retireRows(game)) if (!(await SEQ_DEPS.vetoed(row))) return row;
  return undefined;
}
/** Ask the brain to retire a game (once per game a day) and sign the delayed record if it agrees with the rule. */
async function proposeRetire(g: LiveGame, rule: "idle" | "evict", now: number): Promise<string> {
  const day = dayOf(now);
  const ref = `retire:${g.game.toLowerCase()}:${day}`;
  if ((await sql`select 1 from log where kind = 'brain' and ref = ${ref} limit 1`).length) return "asked today already";
  const ageH = Math.floor((now - g.deployedAt) / HOUR);
  const out = await SEQ_DEPS.decide("retire", { game: g.game, players48h: g.players48h, ageH, rule: rule === "idle" ? "no distinct players in the last 48 hours, live 48 hours or more: retire" : `a new game is ready and at most 3 may be live: retire the one with the fewest players in 48 hours (then the oldest) of those live ${SEQ.evictMinAgeMs / HOUR} hours or more` }, ref.slice("retire:".length));
  if (out.decision.retire !== true) {
    await SEQ_DEPS.alert(`Sequencer: the rule says retire ${g.game} (${rule}), the brain says no (${String(out.decision.reason).slice(0, 200)}). No action; asked again tomorrow.`, `alert:seq:retire:${ref}`);
    return "the brain disagrees";
  }
  const body: RetireRecord = { kind: "retire", game: g.game, build: g.build, rule, players48h: g.players48h, ageH, brain: String(out.seq), effectiveAt: new Date(now + SEQ.publicHourMs).toISOString() };
  const rec = await append("retire", `retire:${g.game.toLowerCase()}`, body);
  return `retire record ${rec.seq}`;
}

async function shipRecord(r: BuildRow, now: number): Promise<string> {
  const s = r.data.ship!;
  const o = r.data.orders.find((x) => x.id === s.orderId)!;
  const g = await gatesBody(o);
  const kind = kindOf(r.data);
  const gh = await SEQ_DEPS.github();
  if (kind === "engine") return handoff(r, now);
  if (kind !== "game") {
    // a site change: the ship record names the exact files it changes and their blobs (the tree comparison lists a
    // rename as its removal and its addition, so both paths are here); a module: its own folders, and the proposal the
    // Safe gets (its code hash, address and bounds, and the registry calls). Nothing to deploy here.
    if (kind === "module" && !g.module) return end(r, "killed", "the gated compile has no module");
    const paths = kind === "module" ? roots(r.data.slug, kind) : (await gh.changedFiles(s.baseSha, s.gatedSha)).changes.map((c) => c.path);
    // the spec hash the gated SPEC.json carries: the order's (an amended spec, once approved, from the next order on)
    const proposal = g.module ? (await import("./seq-forge.ts")).moduleProposal({ ...g.module, runtime: "0x" }, (await orderBody(o)).specSha256, d.registry) : undefined;
    const body = {
      kind: "ship", verdict: "ship", target: kind, title: r.data.title, reason: s.reason, build: r.id, idea: r.data.idea, slug: r.data.slug,
      verdictSeq: s.verdictSeq, order: o.id, gatesSeq: o.gatesSeq, pr: s.pr, gatedSha: s.gatedSha, baseSha: s.baseSha, paths,
      treeHashes: gh.treeHashes(await gh.treeOf(s.gatedSha), paths), effectiveAt: new Date(now + SEQ.publicHourMs).toISOString(), ...amendmentShown(r.data),
      // the deploy call's data is salt ‖ the gates record's init code (it is not repeated here)
      ...(proposal && g.module ? { module: { ...proposal, initCodeHash: g.module.initCodeHash, salt: g.module.salt, calls: proposal.calls.map((c, i) => (i === 0 ? { what: c.what, to: c.to, salt: g.module!.salt, initCodeHash: g.module!.initCodeHash, initCodeIn: o.gatesSeq } : c)) } } : {}),
    };
    const rec = await append("ship", `ship:${r.id}`, body);
    await saveBuild({ ...r, status: "shipping", data: { ...r.data, shipSeq: rec.seq } });
    return `ship record ${rec.seq}: in effect at ${body.effectiveAt} unless vetoed`;
  }
  if (!g.game?.codehash) return end(r, "killed", "the gated compile has no deployable code");
  const chain = await SEQ_DEPS.chain();
  let evict: { game: Address; retireSeq: string } | undefined;
  // the other games on their way to a deploy each take a slot: one their own eviction frees (that game is theirs), or a
  // free one. At most 3 live (GameFactory.MAX_LIVE): this one needs an eviction when the rest would fill them.
  const claimed = new Set<string>();
  let unclaimed = 0;
  for (const b of await activeBuilds()) {
    if (b.id === r.id || b.status !== "shipping" || kindOf(b.data) !== "game" || b.data.game) continue;
    const [row] = await trustedRows("ship", `ship:${b.id}`, 1);
    const e = row ? (JSON.parse(row.body) as ShipRecord).evict : undefined;
    // its evictee still live: the slot it takes is that one; already retired: it takes a free one
    if (e && (await chain.isLive(e.game))) claimed.add(e.game.toLowerCase());
    else unclaimed++;
  }
  if ((await chain.liveCount()) + unclaimed >= 3) {
    const live = await liveGames(chain);
    const order = evictOrder(live.filter((g) => !claimed.has(g.game.toLowerCase())), now);
    if (!live.length) return "waiting for a free slot: none of the live games is ours (the Safe's?)";
    let why = `every live game of ours is newer than ${SEQ.evictMinAgeMs / HOUR} h or already makes room for another`;
    for (const g of order) {
      let row = await pendingRetire(g.game);
      if (!row) {
        why = await proposeRetire(g, "evict", now);
        row = await pendingRetire(g.game);
      }
      if (row) { evict = { game: g.game, retireSeq: row.seq }; break; }
    }
    if (!evict) return `waiting for a free slot: ${why}`;
  }
  const treeHashes = gh.treeHashes(await gh.treeOf(s.gatedSha), roots(r.data.slug));
  const salt = (await orderBody(o)).salt as Hex; // the salt the signed order fixed
  const predicted = getCreate2Address({ from: d.gameFactory!, salt, bytecodeHash: g.game.initCodeHash });
  const body = {
    kind: "ship", verdict: "ship", title: r.data.title, reason: s.reason, build: r.id, idea: r.data.idea, slug: r.data.slug,
    verdictSeq: s.verdictSeq, order: o.id, gatesSeq: o.gatesSeq, pr: s.pr, gatedSha: s.gatedSha, baseSha: s.baseSha, treeHashes,
    factory: d.gameFactory, salt, initCodeHash: g.game.initCodeHash, predicted, codehash: g.game.codehash,
    ...(evict ? { evict } : {}), effectiveAt: new Date(now + SEQ.publicHourMs).toISOString(), ...amendmentShown(r.data),
  };
  const rec = await append("ship", `ship:${r.id}`, body);
  await saveBuild({ ...r, status: "shipping", data: { ...r.data, shipSeq: rec.seq } });
  return `ship record ${rec.seq}: in effect at ${body.effectiveAt} unless vetoed`;
}

/** An engine change is never merged here: a signed ship record names the gated pull request, its commit and its files
 *  (`ownerMerge`), the owners are told, and the build ends `handed`. An owner reviews and merges it, or not; then the new
 *  image and the 1 h code timelock, as for any engine change. */
async function handoff(r: BuildRow, now: number): Promise<string> {
  const s = r.data.ship!;
  const o = r.data.orders.find((x) => x.id === s.orderId)!;
  const gh = await SEQ_DEPS.github();
  const touch = (await gatesBody(o)).touch ?? [];
  const paths = (await gh.changedFiles(s.baseSha, s.gatedSha)).changes.map((c) => c.path);
  // one ship record per build: saved on the row at once, so a step retried after a failure below signs no second one
  if (!r.data.shipSeq) {
    r.data.shipSeq = (await append("ship", `ship:${r.id}`, {
      kind: "ship", verdict: "ship", target: "engine", ownerMerge: true, title: r.data.title, reason: s.reason, build: r.id, slug: r.data.slug,
      ...(r.data.risk ? { risk: r.data.risk } : {}), verdictSeq: s.verdictSeq, order: o.id, gatesSeq: o.gatesSeq, pr: s.pr, gatedSha: s.gatedSha, baseSha: s.baseSha, paths,
      treeHashes: gh.treeHashes(await gh.treeOf(s.gatedSha), paths), touch, effectiveAt: new Date(now).toISOString(), ...amendmentShown(r.data),
    })).seq;
    await saveBuild(r);
  }
  const rec = { seq: r.data.shipSeq };
  // the row moves on even if the alert fails; a failure is logged
  await SEQ_DEPS.alert([
    `Sequencer: engine change "${r.data.title.slice(0, 80)}" passed its gates and the brain: pull request #${s.pr} (commit ${s.gatedSha}) waits for an owner's review and merge. Ship record ${rec.seq}.`,
    ...(r.data.risk ? [`It answers the open risk: ${r.data.risk.slice(0, 300)}`] : []),
    "Read the full diff. Where to start (a pointer, not a guarantee):", ...touchLines(touch).slice(0, 20).map((l) => `- ${l}`),
    "The enclave never merges an engine change; after a merge, the new image and the 1 h code timelock as usual.",
  ].join("\n"), `alert:seq:handoff:${r.id}`).catch((e) => console.error(`handoff alert of ${r.id}: ${(e as Error).message.slice(0, 200)}`));
  await releaseReservation(r);
  // the site's record before the row ends (a failed announcement is told, never silent)
  await SEQ_DEPS.announce({ event: "seq_handoff", build: r.id, title: r.data.title, pr: s.pr, record: rec.seq })
    .catch((e) => SEQ_DEPS.alert(`Sequencer: the handoff of ${r.id} was not announced (${(e as Error).message.slice(0, 200)}).`, `alert:seq:handoff-ann:${r.id}`));
  await saveBuild({ ...r, status: "handed", data: { ...r.data, shipSeq: rec.seq } });
  return `handed: ${r.id} (pull request #${s.pr} waits for an owner's merge)`;
}

// ---------------------------------------------------------------- shipping → shipped

/** A game's ship record carries its deploy (salt, init code hash, predicted address, code hash); a site change's names
 *  its `target` and the exact `paths` it changes. */
type ShipRecord = {
  title: string; slug: string; order: string; gatedSha: string; baseSha: string; treeHashes: Record<string, string>; gatesSeq: string; pr: number; effectiveAt: string;
  target?: Kind; paths?: string[];
  salt: Hex; initCodeHash: Hex; predicted: Address; codehash: Hex; evict?: { game: Address; retireSeq: string };
};

/** A ship stopped at any point: a merge already made is never released, a game already deployed is paged for retire. */
async function stopShip(r: BuildRow, why: string, predicted?: Address) {
  if (r.data.mergeSha) {
    r.data.badMerge = r.data.mergeSha;
    // the mark that keeps it from going out also lives in the signed, chain-linked log (a held release record naming
    // itself bad): deleting the build row can't free it, and deleting a log record breaks the chain the boot check walks
    if (!(await trustedRows("release", `release:${r.data.mergeSha}`, 5)).some((x) => (JSON.parse(x.body) as ReleaseRecord).bad?.includes(r.data.mergeSha!))) {
      // and everything else under it that must not go out on its own now (an approval names exactly these)
      const gh = await SEQ_DEPS.github();
      const under = await gh.refSha("release").then((rel) => underRelease(rel, r.data.mergeSha!)).catch(() => ({ bad: [] as string[], complete: true }));
      const bad = [...new Set([r.data.mergeSha, ...under.bad])];
      const rec = await append("release", `release:${r.data.mergeSha}`, { kind: "release", sha: r.data.mergeSha, build: r.id, stopped: why.slice(0, 200), needApprovals: 1, bad, ...(under.complete ? {} : { unlisted: true }), effectiveAt: new Date(SEQ_DEPS.now()).toISOString() });
      await SEQ_DEPS.alert(`Sequencer: merge ${r.data.mergeSha} of ${r.id} is never released on its own${bad.length > 1 ? ` (nor ${bad.slice(1).join(", ")} under it)` : ""}; release record ${rec.seq} waits for one Safe owner's approval (revert it on main first; anything on top of it waits for an approval too).`, `alert:seq:held:${rec.seq}`);
    }
  }
  // any sign the deploy went out (the row says so, or a mined deploy tx is on record): never orphan a live game
  const { trustedDocs } = await import("./records.ts");
  const mined = (await trustedDocs<{ status: string }>("tx", `seq:deploy:${r.id}`, 20)).some((t) => t.status === "mined");
  const game = r.data.game?.address ?? (r.data.deployedOnce || mined ? predicted : undefined);
  if (game) await SEQ_DEPS.alert(`🚨 Sequencer: ${r.id} stopped after its deploy (${why}). Safe: factory.retire(${game}) and veto any fund queued for it.`, `alert:seq:stopped:${r.id}`);
  return end(r, "killed", why);
}

/** The deploy mined but not every provider shows its code: wait a minute, at most SEQ.codeWaits times; then alert and
 *  check its receipt again. A deploy a reorg dropped (no receipt any more) is sent again; one still mined keeps waiting. */
async function codeWait(r: BuildRow, chain: Chain): Promise<never> {
  const n = (r.data.codeWaits ?? 0) + 1;
  r.data.codeWaits = n;
  if (n >= SEQ.codeWaits) {
    // an RPC error is not "gone": wait and check again next time (the count stays at the bound)
    const landed = await chain.deployLanded(`seq:deploy:${r.id}`).catch(async (e: Error) => {
      await saveBuild(r);
      throw new Defer(60_000, `deploy of ${r.id}: its receipt could not be read (${e.message.slice(0, 120)})`);
    });
    await SEQ_DEPS.alert(`Sequencer: ${r.id}'s deploy shows no code after ${n} minutes; its receipt ${landed ? "is still there (waiting on)" : "is gone (a reorg?): deploying again"}.`, `alert:seq:nocode:${r.id}:${Math.floor(n / SEQ.codeWaits)}`);
    r.data.codeWaits = 0;
    if (!landed) r.data.deployed = false;
  }
  await saveBuild(r);
  throw new Defer(60_000, `deploy of ${r.id} mined; not every provider shows its code yet`);
}

async function ship(r: BuildRow, now: number): Promise<string> {
  const [row] = await trustedRows("ship", `ship:${r.id}`, 1);
  if (!row || row.seq !== r.data.shipSeq) throw Object.assign(new Error(`ship ${r.id}: the signed ship record is missing`), { final: true });
  const body = JSON.parse(row.body) as ShipRecord;
  const gh = await SEQ_DEPS.github();
  // the enclave's own cancel and the Safe's veto stop every step below: the merge, the deploy, the fund, the release. A
  // site change the release branch already holds (serve.onRelease: seen there, not just asked for) only waits for the
  // site to serve it: nothing here can take it back (an owner reverts it on main), so it is never told as stopped; a
  // veto then is one alert to the owners
  const released = body.target === "site" && !!r.data.serve?.onRelease;
  if (!released && (await trustedRows("ship-cancel", `ship:${r.id}`, 1)).length) return stopShip(r, "the enclave cancelled its ship (a page check failed in the public hour)", body.predicted);
  if (await SEQ_DEPS.vetoed(row)) {
    if (!released) return stopShip(r, "the Safe owners vetoed the ship", body.predicted);
    await SEQ_DEPS.alert(`Sequencer: site change "${r.data.title.slice(0, 80)}" (${r.id}) was vetoed after its release (${r.data.mergeSha}): revert it on main.`, `alert:seq:site-vetoed:${r.id}`);
  }
  if (!r.data.mergeSha) {
    // the public hour's deep page check (7 days simulated, three profiles): nothing merges before it passed
    if (!r.data.deepChecked) {
      const c = await SEQ_DEPS.deepCheck(r, body);
      if (c.kill) {
        await SEQ_DEPS.shipCancel(r.id, row.seq, c.why);
        return stopShip(r, "the enclave cancelled its ship (a page check failed in the public hour)", body.predicted);
      }
      if (!c.ok) throw new Error(`ship ${r.id}: the public hour's page check did not run: ${c.why.slice(0, 200)}`);
      r.data.deepChecked = new Date(now).toISOString();
      await saveBuild(r);
    }
    if (!(await SEQ_DEPS.effective(row))) return "waiting: the public hour";
    if (body.evict) {
      const chain = await SEQ_DEPS.chain();
      if (await chain.isLive(body.evict.game)) {
        const rr = (await retireRows(body.evict.game)).find((x) => x.seq === body.evict!.retireSeq);
        if (!rr || (await SEQ_DEPS.vetoed(rr))) return end(r, "killed", "no free slot: the eviction was vetoed");
        return "waiting: the evicted game retires first";
      }
    }
    // an engine change is an owner's to merge, never ours (handoff ends its build before here; this holds whatever row)
    if (kindOf(r.data) === "engine" || body.target === "engine") throw Object.assign(new Error(`ship ${r.id}: an engine change is merged by an owner only`), { final: true });
    // (a) the merge, pinned to the gated head; then the merged game folders must be exactly the gated ones
    const pr = await gh.pull(body.pr);
    let merged = pr.merged ? pr.merge_commit_sha : null;
    if (!merged) {
      if (pr.state !== "open" || pr.head.sha !== body.gatedSha) {
        await SEQ_DEPS.alert(`Sequencer: PR #${body.pr} moved or closed after it was gated; ${r.id} is not merged.`, `alert:seq:moved:${r.id}`);
        return end(r, "killed", "the pull request changed after it was gated");
      }
      // several builds at once: main may have moved since this one was gated. A file it changes that main changed
      // meanwhile would merge into a tree nobody gated: skipped (the idea back in the queue), never merged
      const mine = body.paths ?? roots(body.slug);
      const [was, now2] = await Promise.all([gh.treeOf(body.baseSha), gh.refSha("main").then((m) => gh.treeOf(m))]);
      if (JSON.stringify(gh.treeHashes(was, mine)) !== JSON.stringify(gh.treeHashes(now2, mine))) return end(r, "skipped", "main changed a file this change edits after it was gated");
      // a game merges only with a free slot to deploy into (other games merged and not deployed yet count)
      if ((body.target ?? "game") === "game") {
        const merging = (await activeBuilds()).filter((b) => b.id !== r.id && b.data.mergeSha && !b.data.game && !b.data.badMerge && kindOf(b.data) === "game").length;
        if ((await (await SEQ_DEPS.chain()).liveCount()) + merging >= 3) return "waiting: no free game slot yet";
      }
      try {
        merged = await gh.merge(body.pr, body.gatedSha);
      } catch (e) {
        if (await isOutage(e)) throw e;
        await SEQ_DEPS.alert(`Sequencer: PR #${body.pr} was not merged (${(e as Error).message.slice(0, 200)}).`, `alert:seq:merge:${r.id}`);
        return end(r, "killed", "the merge was refused");
      }
    }
    r.data.mergeSha = merged!;
    const mergedTree = await gh.treeOf(merged!);
    const parent = (await gh.commit(merged!)).parents[0]?.sha;
    const { changes } = await gh.changedFiles(parent, merged!);
    // a game: its own folders; a site change: exactly the files its ship record names
    const scope = body.paths ?? roots(body.slug);
    const outside = changes.filter((c) => !under(c.path, scope));
    if (JSON.stringify(gh.treeHashes(mergedTree, scope)) !== JSON.stringify(body.treeHashes) || outside.length) {
      await SEQ_DEPS.alert(`🚨 Sequencer: merge ${merged} of ${r.id} is not the gated tree${outside.length ? ` (also changes ${outside.slice(0, 3).map((c) => c.path).join(", ")})` : ""}. Nothing deployed; it is never released.`, `alert:seq:tree:${r.id}`);
      return stopShip(r, "the merged tree is not the gated one");
    }
    await saveBuild(r);
  }
  // a site change has nothing to deploy or fund: it goes on to its release
  const isGame = (body.target ?? "game") === "game";
  // (b) the deploy: the enclave's own compile, at the address the ship record published
  if (isGame && !r.data.game) {
    const chain = await SEQ_DEPS.chain();
    let at = await chain.codeHash(body.predicted);
    // a mined deploy a lagging provider does not show yet: wait for it, never read it as "no code"
    if (!at && r.data.deployed) return codeWait(r, chain);
    if (!at) {
      const g = await signedBody<GatesRecord>("gates", `gates:${body.order}`, body.gatesSeq);
      if (!g.game || keccak256(g.game.initCode) !== body.initCodeHash) return stopShip(r, "the gated init code is not the ship record's");
      const s = await chain.deploy(g.game.initCode, body.salt, `seq:deploy:${r.id}`);
      if (s.status === "dry_run") return "dry run: the deploy was simulated";
      if (s.status !== "mined") {
        const fails = (r.data.deployFails ?? 0) + 1;
        r.data.deployFails = fails;
        await saveBuild(r);
        if (fails >= SEQ.deployTries) return stopShip(r, `the deploy failed ${fails} times (last: ${s.status} ${s.error ?? ""})`.slice(0, 300));
        await SEQ_DEPS.alert(`Sequencer: deploy of ${r.id} ${s.status} (${s.error ?? ""}); try ${fails} of ${SEQ.deployTries}, retried in 15 min.`, `alert:seq:deploy:${r.id}:${fails}`);
        throw new Defer(15 * 60_000, `deploy ${s.status}: ${s.error ?? ""}`);
      }
      r.data.deployed = true;
      r.data.deployedOnce = true; // never cleared: a stopped ship always pages the retire of what it deployed
      await saveBuild(r);
      at = await chain.codeHash(body.predicted);
      if (!at) return codeWait(r, chain);
    }
    if (at !== body.codehash) {
      await SEQ_DEPS.alert(`🚨 Sequencer: the code at ${body.predicted} hashes to ${at}, the ship record says ${body.codehash}.`, `alert:seq:codehash:${r.id}`);
      r.data.game = { address: body.predicted, codehash: at, deployedAt: new Date(now).toISOString() };
      return stopShip(r, "the deployed code is not the shipped code");
    }
    r.data.game = { address: body.predicted, codehash: body.codehash, deployedAt: new Date(now).toISOString() };
    await saveBuild(r);
  }
  // the fund and the reward wait for the game's code at the finalized block: a shallow reorg can't leave a fund queued
  // or a reward paid for a game that isn't there
  if (isGame && (!r.data.fund || !r.data.rewarded) && (await (await SEQ_DEPS.chain()).finalizedCodeHash(body.predicted)) !== body.codehash) {
    throw new Defer(60_000, `${r.id}: waiting for the game's code at the finalized block`);
  }
  // (c) the starting fund (never blocks a ship)
  if (isGame && !r.data.fund) {
    const f = await (await SEQ_DEPS.fund()).queueFund(body.predicted, r.id, "start", now).catch((e) => ({ queued: false as const, why: `error: ${(e as Error).message.slice(0, 200)}` }));
    r.data.fund = f.queued ? { queued: true, amount: String(f.amount) } : { queued: false, why: f.why };
    await saveBuild(r);
  }
  // (d) the release record for the merge commit. It inherits the ship's hour only when everything under it is
  // already released or in effect; otherwise (a push or a vetoed release under it) it waits an hour of its own, and an
  // owner's approval too when something under it must never go out on its own (releaseRecord).
  if (!r.data.releaseSeq) {
    const parent = (await gh.commit(r.data.mergeSha!)).parents[0]?.sha;
    const covered = parent === (await gh.refSha("release")) || !!(await releaseInEffect(parent));
    // the merge under it is another ship's whose own release record is not written yet: wait for that one
    if (!covered && (await activeBuilds()).some((b) => b.id !== r.id && b.data.mergeSha === parent && !b.data.badMerge && !b.data.releaseSeq)) throw new Defer(60_000, `${r.id}: waiting for the release record of the merge under it`);
    if (!covered) await SEQ_DEPS.alert(`Sequencer: main had commits no release covers under ${r.id}'s merge; its release waits an hour of its own.`, `alert:seq:own-hour:${r.id}`);
    r.data.releaseSeq = (await releaseRecord(r.data.mergeSha!, covered ? Date.parse(body.effectiveAt) : now + SEQ.publicHourMs, { ship: row.seq, build: r.id })).seq;
    await saveBuild(r);
  }
  if (!r.data.released_ff) {
    await releaseTo(r.data.mergeSha!).catch((e) => SEQ_DEPS.alert(`Sequencer: release not moved to ${r.data.mergeSha} (${(e as Error).message.slice(0, 200)}); the hourly job retries.`, `alert:seq:release:${r.id}`));
    r.data.released_ff = true;
    await saveBuild(r);
  }
  // (e) shipped: the idea's reward rests on the ship record (a crash after either move finds it done)
  const q = await SEQ_DEPS.queue();
  if (!r.data.rewarded && r.data.idea) {
    // only "already moved" is swallowed, and only when the signed row really is shipped or past it
    const done = async (e: unknown) => {
      const past = ["shipped", "reward", "rewarded", "no_reward", "reward_dropped"].includes((await q.buildStatusOf(r.data.idea)) ?? "");
      if (!/^no (building|shipped) build idea/.test((e as Error).message) || !past) throw e;
    };
    await q.setBuildStatus(r.data.idea, "building", "shipped", r.id).catch(done);
    await q.rewardShipped(r.data.idea, row.seq).catch(done);
    r.data.rewarded = true;
    await saveBuild(r);
  }
  await releaseReservation(r);
  // a site change is live only once the site serves it: until then it waits here (Defer), on its way
  const unserved = !isGame && body.target !== "module" && SEQ.siteLive ? await siteServe(r, body.paths ?? [], now) : null;
  // the row turns shipped only after its announcement (deduped by key): a crash between the two announces again, never
  // leaves a shipped row nothing announced
  const shipped = async (why: string) => { await saveBuild({ ...r, status: "shipped" }); return why; };
  if (body.target === "module") {
    // the Sequencer's part ends here: the Safe decides whether this code hash is ever approved, registered or tested
    const m = (body as ShipRecord & { module: { codehash: Hex; address: Address } }).module;
    await SEQ_DEPS.alert(`Sequencer: module "${r.data.title.slice(0, 80)}" is merged (${r.data.mergeSha}). Ship record ${row.seq} carries its code hash ${m.codehash}, its address ${m.address}, its bounds and the calls for the Safe: deploy through the CREATE2 deployer, ApproveCodehash, Register. The engine sends none of them.`, `alert:seq:module:${r.id}`);
    await SEQ_DEPS.announce({ event: "seq_released", build: r.id, title: r.data.title, target: "module", record: row.seq });
    return shipped(`shipped: ${r.id} (module ${m.codehash}, proposed to the Safe)`);
  }
  if (!isGame) {
    // a site change built before the site took them: released in the repository, but not on the site, so not announced
    if (!SEQ.siteLive) {
      await SEQ_DEPS.alert(`Sequencer: site change "${r.data.title.slice(0, 80)}" is merged and released (${r.data.mergeSha}), but the website does not deploy from release, so it is not live and was not announced.`, `alert:seq:site-not-live:${r.id}`);
      return shipped(`shipped: ${r.id} (site, released at ${r.data.mergeSha}; the website does not deploy it)`);
    }
    if (unserved) return shipped(`shipped: ${r.id} (site, released at ${r.data.mergeSha}; not served, not announced: ${unserved})`);
    await SEQ_DEPS.announce({ event: "seq_released", build: r.id, title: r.data.title, target: "site", record: row.seq });
    return shipped(`shipped: ${r.id} (site, released at ${r.data.mergeSha})`);
  }
  await SEQ_DEPS.announce({ event: "seq_shipped", build: r.id, title: r.data.title, slug: r.data.slug, game: body.predicted, fundEth: r.data.fund?.queued ? Number(r.data.fund.amount) / 1e18 : null, record: row.seq });
  return shipped(`shipped: ${r.id} at ${body.predicted}`);
}

/** Does the site serve this site change: its health names the merge or a later commit (RAILWAY_GIT_COMMIT_SHA), and each
 *  of its new pages answers 200 there (a query only the check uses, so no cached answer from before the deploy). Not
 *  yet: why (a deploy still building, a page answering 500 while it warms up: every miss is waited on, SEQ.siteServeMs
 *  is the one bound). */
export async function siteServed(sha: string, paths: string[]): Promise<{ ok: true } | { ok: false; why: string }> {
  const h = await SEQ_DEPS.siteGet("/api/health", true).catch((e) => ({ status: 0, body: undefined, error: (e as Error).message }));
  const commit = (h.body as { commit?: unknown } | undefined)?.commit;
  if (h.status !== 200 || typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return { ok: false, why: `the site's health names no deployed commit (status ${h.status || "none"})` };
  if (!(await (await SEQ_DEPS.github()).contains(commit, sha))) return { ok: false, why: `the site serves ${commit.slice(0, 12)}, which does not hold ${sha.slice(0, 12)}` };
  const { siteRoutes } = await import("./pages.ts");
  for (const route of siteRoutes(paths, paths)) {
    const g = await SEQ_DEPS.siteGet(`${route}?served=${sha.slice(0, 12)}`).catch(() => ({ status: 0 }));
    if (g.status !== 200) return { ok: false, why: `${route} answers ${g.status || "nothing"} on the deployed commit` };
  }
  return { ok: true };
}
/** A released site change, before it is called live: null once the site serves it (marked on its row). Not yet: Defer a
 *  minute, up to SEQ.siteServeMs after the release branch first held it (SEQ.siteReleaseMs after the first look while
 *  the branch does not); then one alert to the owners and why it is not announced. */
async function siteServe(r: BuildRow, paths: string[], now: number): Promise<string | null> {
  if (r.data.served) return null;
  const c = await serveCheck(r, paths, now);
  if (c.ok) {
    r.data.served = new Date(now).toISOString();
    await saveBuild(r);
    return null;
  }
  const s = r.data.serve!;
  const late = s.onRelease ? now - Date.parse(s.onRelease) >= SEQ.siteServeMs : now - Date.parse(s.since) >= SEQ.siteReleaseMs;
  if (!late) throw new Defer(60_000, `${r.id}: not served yet: ${c.why}`);
  await SEQ_DEPS.alert(`Sequencer: site change "${r.data.title.slice(0, 80)}" (${r.id}) is released at ${r.data.mergeSha} but the site has not picked it up: ${c.why.slice(0, 200)}. It is not announced until the site serves it (looked for each hour, for ${SEQ.siteServeRecheckMs / DAY} days).`, `alert:seq:site-not-served:${r.id}`);
  return c.why;
}
/** One look: notes when the release branch first holds the change, then asks the site (siteServed). */
async function serveCheck(r: BuildRow, paths: string[], now: number) {
  const sha = r.data.mergeSha!;
  const gh = await SEQ_DEPS.github();
  const s = (r.data.serve ??= { since: new Date(now).toISOString() });
  if (!s.onRelease && (await gh.contains(await gh.refSha("release"), sha))) s.onRelease = new Date(now).toISOString();
  await saveBuild(r);
  return s.onRelease ? siteServed(sha, paths) : { ok: false as const, why: "the release branch does not hold it yet" };
}
/** Hourly: a released site change the site did not serve within SEQ.siteServeMs (a deploy by hand comes later) is
 *  looked for again, up to SEQ.siteServeRecheckMs after the first look. Served: announced as its ship would have, once
 *  (the announcement dedupes by key, and `served` is marked only after it), and its author told it is live (x-social.ts
 *  reads `served`). Still not by then: one alert, no more looks. */
async function serveStep(now: number) {
  const out: Record<string, string> = {};
  if (!SEQ.siteLive) return out;
  for (const r of await builds(sql`status = 'shipped' and data ? 'serve' and not data ? 'served' and not (data->'serve' ? 'gaveUp')`)) {
    const [row] = await trustedRows("ship", `ship:${r.id}`, 1);
    if (!row || row.seq !== r.data.shipSeq) { out[r.id] = "no signed ship record"; continue; }
    const c = await serveCheck(r, (JSON.parse(row.body) as ShipRecord).paths ?? [], now);
    if (c.ok) {
      await SEQ_DEPS.announce({ event: "seq_released", build: r.id, title: r.data.title, target: "site", record: row.seq });
      r.data.served = new Date(now).toISOString();
      await saveBuild(r);
      out[r.id] = "served, announced";
      continue;
    }
    out[r.id] = `not served: ${c.why.slice(0, 120)}`;
    if (now - Date.parse(r.data.serve!.since) < SEQ.siteServeRecheckMs) continue;
    await SEQ_DEPS.alert(`Sequencer: site change "${r.data.title.slice(0, 80)}" (${r.id}) is released at ${r.data.mergeSha} and still not served after ${SEQ.siteServeRecheckMs / DAY} days: ${c.why.slice(0, 200)}. It is never announced; the engine stops looking.`, `alert:seq:site-never-served:${r.id}`);
    r.data.serve!.gaveUp = new Date(now).toISOString();
    await saveBuild(r);
  }
  return out;
}

// ---------------------------------------------------------------- release (M2)

type ReleaseRecord = { sha: string; ship?: string; build?: string; effectiveAt: string; needApprovals?: number; bad?: string[]; unlisted?: boolean };
/** Is this release record in effect (its own hour, its approvals, no veto, and a ship's release only while its ship
 *  stands)? */
async function releaseOk(row: Row & { seq: string }) {
  const b = JSON.parse(row.body) as ReleaseRecord;
  if (!(await SEQ_DEPS.effective(row))) return false;
  if (b.ship) {
    const s = (await trustedRows("ship", `ship:${b.build}`, 5)).find((x) => x.seq === b.ship);
    if (!s || (await SEQ_DEPS.vetoed(s))) return false;
  }
  return true;
}
/** The newest release record for `sha`, if it is in effect (a newer one that needs an approval replaces an older one). */
async function releaseInEffect(sha: string | undefined) {
  if (!sha) return null;
  const [row] = await trustedRows("release", `release:${sha}`, 1);
  return row && (await releaseOk(row)) ? (JSON.parse(row.body) as ReleaseRecord) : null;
}
/** What lies between `base` and `head` that must never go out on its own: merges the enclave refused or stopped after
 *  (their own held release record names them bad; the build row says so too) and commits whose release record the
 *  Safe vetoed. `complete` false: GitHub could not list it all (> 250 commits). A DB hiding the enclave's newest
 *  release record of one of them stops here (RolledBack), never reads as "nothing bad". */
async function underRelease(base: string, head: string): Promise<{ bad: string[]; complete: boolean }> {
  if (base === head) return { bad: [], complete: true };
  const between = await (await SEQ_DEPS.github()).commitsBetween(base, head);
  const bad = new Set((await builds(sql`data ? 'badMerge'`)).map((b) => b.data.badMerge!));
  // the release records of exactly these commits (any age)
  const refs = between.shas.map((c) => `release:${c}`);
  const want = new Map(refs.map((ref) => [ref, newestOf("release", ref)] as const)); // before the read
  const seen = new Map<string, bigint>();
  for (const row of refs.length ? await sql<(EnclaveRow & { ref: string; seq: string })[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where kind = 'release' and ref = any(${refs})` : []) {
    if (!(await trustedRecord(row, "release record"))) continue;
    const sha = row.ref.slice("release:".length);
    if (BigInt(row.seq) > (seen.get(row.ref) ?? -1n)) seen.set(row.ref, BigInt(row.seq));
    if (((JSON.parse(row.body) as ReleaseRecord).bad ?? []).includes(sha) || (await SEQ_DEPS.vetoed(row))) bad.add(sha);
  }
  for (const [ref, w] of want) if (await rolledBack("release", ref, seen.get(ref)?.toString(), w)) throw RolledBack(`release ${ref}`);
  return { bad: between.shas.filter((c) => bad.has(c)), complete: between.complete };
}
/** A release record for `sha`. When something under it must not go out on its own (or GitHub can't list it all), it
 *  needs one Safe owner's approval as well as its hour: the owners revert what has to go on main, then approve. */
async function releaseRecord(sha: string, effectiveAt: number, extra: { ship?: string; build?: string } = {}) {
  const rel = await (await SEQ_DEPS.github()).refSha("release");
  const u = await underRelease(rel, sha);
  const held = u.bad.length > 0 || !u.complete;
  const rec = await append("release", `release:${sha}`, { kind: "release", sha, ...extra, effectiveAt: new Date(effectiveAt).toISOString(), ...(held ? { needApprovals: 1, bad: u.bad, ...(u.complete ? {} : { unlisted: true }) } : {}) });
  if (held) {
    await SEQ_DEPS.alert(`Sequencer: release record ${rec.seq} for ${sha} waits for one Safe owner's approval: ${u.bad.length ? `under it is ${u.bad.join(", ")}, which is never released on its own (revert it on main first)` : "GitHub could not list everything under it"}. /approve ${rec.seq} <signature> releases it.`, `alert:seq:held:${rec.seq}`);
  }
  return { seq: rec.seq, held };
}
/** Fast-forward `release` to `sha` if a release record for it is in effect. A record that needed an owner's approval
 *  has it (effective() checked); any other is refused if something never-released lies under it now. */
async function releaseTo(sha: string) {
  const gh = await SEQ_DEPS.github();
  const rec = await releaseInEffect(sha);
  if (!rec) return "waiting: no release record in effect";
  const rel = await gh.refSha("release");
  if (rel === sha) return "release is there";
  // what lies under it now: a plain record carries nothing bad; a held one only the bad commits its approval named
  // (an approval of one record never carries a veto or a stopped merge it did not list)
  const u = await underRelease(rel, sha);
  const allowed = rec.needApprovals ? (rec.bad ?? []) : [];
  const extra = u.bad.filter((b) => !allowed.includes(b));
  if (extra.length || (!u.complete && !(rec.needApprovals && rec.unlisted))) {
    // a newer held record with the full list (alerted); it is the one in effect from now on
    await releaseRecord(sha, SEQ_DEPS.now());
    return `refused: ${extra.length ? `${extra.join(", ")} is never released on its own` : "GitHub could not list what lies under it"}`;
  }
  await gh.fastForward("release", sha);
  return `release → ${sha}`;
}

/** Hourly: any other merge on main gets its own release record (an hour of its own, and an owner's approval when
 *  something under it must not go out on its own); `release` follows the newest record in effect. Nothing is issued
 *  while a ship is on its way (its own record covers its merge). */
async function releaseStep(now: number) {
  const gh = await SEQ_DEPS.github();
  const [main, rel] = await Promise.all([gh.refSha("main"), gh.refSha("release")]);
  // a ship's merge waiting for its own release record (it covers that merge)
  const shipping = (await activeBuilds()).some((b) => b.data.mergeSha && !b.data.releaseSeq);
  if (main !== rel && !shipping && !(await trustedRows("release", `release:${main}`, 1)).length) await releaseRecord(main, now + SEQ.publicHourMs);
  const recent = await sql<{ ref: string }[]>`select ref, max(seq) as s from log where kind = 'release' group by ref order by s desc limit 10`;
  for (const { ref } of recent) {
    const sha = ref.slice("release:".length);
    if (sha === rel) return "release is current";
    const r = await releaseTo(sha).catch((e) => `error: ${(e as Error).message.slice(0, 120)}`);
    if (r.startsWith("release")) return r;
  }
  return "no release in effect";
}

// ---------------------------------------------------------------- the step

/** When a deferred build is stepped again (its id → ms), while several builds share the step. In memory: after a
 *  restart a deferred build is stepped at once, which only brings its next try forward (a deploy's tries are counted on
 *  its row). */
const deferredUntil = new Map<string, number>();

/** One step of every build on its way (oldest first), then a new one if there is room. One build at a time
 *  (SEQ.maxInflight 1): its wait (Defer) is the job's, as ever. Otherwise a build's wait holds only that build, and the
 *  first other error is thrown once every build was stepped (the job retries). */
export async function seqStep(): Promise<string> {
  const now = SEQ_DEPS.now();
  const going = await activeBuilds();
  for (const id of deferredUntil.keys()) if (!going.some((b) => b.id === id)) deferredUntil.delete(id);
  const solo = going.length === 1 && SEQ.maxInflight === 1;
  const out: [string | null, string][] = [];
  let failed: unknown;
  for (const r of going) {
    if ((deferredUntil.get(r.id) ?? 0) > now) { out.push([r.id, "waiting"]); continue; }
    deferredUntil.delete(r.id);
    try { out.push([r.id, await stepBuild(r, now)]); } catch (e) {
      if (solo) throw e;
      if (e instanceof Defer) { deferredUntil.set(r.id, now + e.ms); out.push([r.id, `waiting ${Math.ceil(e.ms / 60_000)} min: ${e.message.slice(0, 120)}`]); continue; }
      out.push([r.id, `error: ${String((e as Error)?.message ?? e).slice(0, 120)}`]);
      failed ??= e;
    }
  }
  if (going.length < SEQ.maxInflight) out.push([null, await start(now)]);
  if (failed) throw failed;
  return out.length === 1 ? out[0][1] : out.map(([id, m]) => (id ? `${id}: ${m}` : m)).join("; ");
}

async function stepBuild(r: BuildRow, now: number): Promise<string> {
  try {
    if (r.status === "decided") return await dispatchRound(r, now);
    if (r.status === "dispatched") return await intake(r, now);
    if (r.status === "gated") return await verdict(r, now);
    if (r.status === "verdict") return await shipRecord(r, now);
    return await ship(r, now);
  } catch (e) {
    if (e instanceof Defer || !(await isOutage(e))) throw e;
    // before the ship is signed an outage ends the build (the next starts SEQ.skipCooldownMs later); after it the ship
    // path waits and retries
    if (r.status === "decided" || r.status === "dispatched" || r.status === "gated") return end(r, "skipped", `outage: ${(e as Error).message.slice(0, 200)}`);
    return `waiting: outage (${(e as Error).message.slice(0, 120)})`;
  }
}

// ---------------------------------------------------------------- hourly: retire, sweep, top-ups, release, daily post

async function retireStep(now: number) {
  const out: Record<string, string> = {};
  if (!d.gameFactory) return out;
  const chain = await SEQ_DEPS.chain();
  const fund = await SEQ_DEPS.fund();
  const st = d.gameFunder && d.delay ? await fund.fundState().catch(() => null) : null;
  for (const b of await shippedBuilds()) {
    if (b.status !== "shipped" || !b.data.game) continue;
    const game = b.data.game.address;
    const live = await chain.isLive(game);
    const pending = await pendingRetire(game);
    if (!live) {
      out[game] = await chain.sweep(game).catch((e) => `sweep: ${(e as Error).message.slice(0, 100)}`);
      // announced once (the site record and the X outbox both dedupe by key)
      if (pending) await SEQ_DEPS.announce({ event: "game_retired", build: b.id, title: b.data.title, slug: b.data.slug, game, days: Math.max(1, Math.round((now - Date.parse(b.data.game.deployedAt)) / DAY)), returnedEth: null, record: pending.seq, rule: (JSON.parse(pending.body) as RetireRecord).rule, idleHours: SEQ.idleMs / HOUR });
      continue;
    }
    if (pending) {
      if (!(await SEQ_DEPS.effective(pending))) { out[game] = "retire: waiting for the public hour"; continue; }
      if (st && fund.pendingFor(st.s, game) > 0n) { out[game] = "retire: waits for its queued fund to execute"; continue; }
      const s = await chain.retire(game, `seq:retire:${game.toLowerCase()}`);
      out[game] = `retire ${s.status}`;
      continue;
    }
    const p = await chain.players(game, st?.lastFunded[game.toLowerCase()]);
    const g: LiveGame = { game, build: b.id, players48h: p.players48h, deployedAt: Date.parse(b.data.game.deployedAt) };
    if (retireDue({ ageMs: now - g.deployedAt, players48h: g.players48h })) { out[game] = await proposeRetire(g, "idle", now); continue; }
    // funding: a start that found no room, or a top-up after 5 new players
    if (st && d.gameFunder) {
      const funded = (st.s.funded[game.toLowerCase()] ?? 0n) > 0n || fund.pendingFor(st.s, game) > 0n;
      if (!funded) out[game] = `start fund: ${JSON.stringify(await fund.queueFund(game, b.id, "start", now).catch((e) => ({ why: (e as Error).message.slice(0, 100) })), (_, v) => (typeof v === "bigint" ? String(v) : v))}`;
      else if (fund.topupDue(st.s, game, p.sinceFund)) out[game] = `top-up: ${JSON.stringify(await fund.queueFund(game, b.id, "topup", now).catch((e) => ({ why: (e as Error).message.slice(0, 100) })), (_, v) => (typeof v === "bigint" ? String(v) : v))}`;
    }
  }
  if (st) out.delay = await fund.executeReady(now).catch((e) => `execute: ${(e as Error).message.slice(0, 100)}`);
  return out;
}

/** The day's changelog (src/upgrades.ts): every real change of the day that ended, or no post. */
async function dailyPost(now: number) {
  return (await import("./upgrades.ts")).changelog(dayOf(now - DAY), (await SEQ_DEPS.mode()) === "live");
}

async function tokenCheck(now: number) {
  const { tokenDaysLeft } = await SEQ_DEPS.github();
  const left = tokenDaysLeft(now);
  if (left !== undefined && left < SEQ.tokenWarnDays) await SEQ_DEPS.alert(`Sequencer: the GitHub token expires in ${Math.max(0, Math.floor(left))} days. Make a new one and set GITHUB_TOKEN.`, `alert:seq:token:${dayOf(now)}`);
  return left;
}

export async function seqHourly() {
  const now = SEQ_DEPS.now();
  const out: Record<string, unknown> = {};
  const step = async (k: string, fn: () => Promise<unknown>) => {
    try { out[k] = await fn(); } catch (e) {
      if (e instanceof Defer) { out[k] = `deferred: ${e.message.slice(0, 200)}`; return; }
      out[k] = `error: ${(e as Error).message.slice(0, 200)}`;
      if (!(await isOutage(e))) await SEQ_DEPS.alert(`Sequencer hourly ${k}: ${(e as Error).message.slice(0, 300)}`, `alert:seq:hourly:${k}:${new Date(now).toISOString().slice(0, 13)}`);
    }
  };
  const m = await SEQ_DEPS.mode();
  if (m === "live") await step("games", () => retireStep(now));
  if (m === "live") await step("release", () => releaseStep(now)); // the public site branch moves only in live mode
  await step("serve", () => serveStep(now));
  await step("daily", () => dailyPost(now));
  await step("token", () => tokenCheck(now));
  return out;
}

export const seqHandler: Handler = { lane: "seq", run: async () => ({ step: await seqStep() }) };
export const seqHourlyHandler: Handler = { lane: "seq", run: async () => seqHourly() };

/** Shipped games (signed build rows): their page folder, address and ABI, for the daily live page check. */
export async function shippedGames(): Promise<import("./pages.ts").LiveGame[]> {
  if (!d.gameFactory) return [];
  return (await shippedBuilds()).filter((b) => b.data.game).map((b) => ({ slug: b.data.slug, address: b.data.game!.address, factory: d.gameFactory!, safe: d.safe }));
}
/** The daily live check. It shares the page check service with the builds' own checks (one at a time): while a build
 *  is going it waits, so it never makes a build's check wait out its turn; with builds going all day, at most
 *  SEQ.pagesDailyWaitMs, then it takes its turn (a build's check waits for the service, PAGES.busyWaitMs). */
export const pagesDailyHandler: Handler = {
  lane: "pages",
  run: async (job) => {
    const a = await activeBuild();
    // the job's age on the wall clock (created_at is the database's)
    if (a && Date.now() - job.created_at.getTime() < SEQ.pagesDailyWaitMs) throw new Defer(30 * 60_000, `the daily page check waits: build ${a.id} is ${a.status}`);
    return (await import("./pages.ts")).dailyPages(await shippedGames());
  },
};
export const _test = { start, dispatchRound, intake, verdict, shipRecord, ship, releaseStep, serveStep, retireStep, dailyPost, liveGames, ZERO, requeueAgain: () => { requeued = false; } };
