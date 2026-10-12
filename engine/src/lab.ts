// The lab on X: what the brain tried since the last lab post. Every cycle simulates a fee candidate (src/loop.ts: a
// fork replay with an uncalibrated model), the gates, the red team and the brain judge it, and most never go on-chain;
// those verdicts are on the site (/lab) and, every 2 h on a launch day (6 h after), here: how many were simulated and
// rejected, the most promising one with its simulated ETH a day and swaps against the live fee and why it stayed
// off-chain, the red team's findings and the research read. Counts and figures from the signed records only (code,
// never a model); the writer words them (src/voice.ts lab fact sheet, which says it was simulated). Nothing tested:
// no post. Only candidates that never went on-chain count (a run that did writes a shadow record first, and gets its
// own posts: queued, test live, outcome).
import { announce, launchDay } from "./announce.ts";
import { requestArtFor } from "./card.ts";
import { LOG_BASE_URL } from "./config.ts";
import type { Handler } from "./jobs.ts";
import type { LogKind } from "./log.ts";
import { trustedDocs } from "./records.ts";
import { factSheet, feeFacts, type LAB_VERDICTS } from "./voice.ts";
import { enqueueX } from "./x.ts";

const HOUR = 3600_000;
/** A window every `hours` (`afterHours` once the launch window is over); the job runs `lagMs` after it ends. */
export const LAB = { hours: 2, afterHours: 6, lagMs: 5 * 60_000 };
export const labSchedule = () => ({ kind: "x:lab", everyMs: LAB.hours * HOUR, offsetMs: LAB.lagMs, payload: (start: Date) => ({ due: start.toISOString() }) });

type Vector = [number, number, number];
export type Exp = { id: string; status: string; note: string; sim: string; metrics: { name: string; delta: number }[] };
type Finding = { kind: string; severity: string; status: string };
type Verdict = (typeof LAB_VERDICTS)[number];

/** Why a candidate stayed off-chain, from its rejected record's note (`<fee> · <why>`, src/loop.ts), in fixed words. */
export function verdictOf(note: string): Verdict {
  const why = note.split(" · ").slice(1).join(" · ");
  if (/^gates failed/.test(why)) return /swap retention/.test(why) ? "it lost too many swaps" : /ETH\/day/.test(why) ? "it made less ETH than the live fee" : "it failed a gate";
  if (/^the red team blocked/.test(why)) return "the red team blocked it";
  if (/^Main said no-go/.test(why)) return "the brain said no-go";
  return "not queued";
}
const delta = (e: Exp, re: RegExp) => e.metrics.find((m) => re.test(m.name))?.delta;
/** A signed delta as a post states it: up or down, never a minus sign (a draft's "8.21" must match a fact). */
const move = (d: number | undefined, up: string, down: string) => (typeof d !== "number" || !Number.isFinite(d) ? {} : d >= 0 ? { [up]: d } : { [down]: -d });

/** The window's lab facts (pure; `exps` the candidates rejected before going on-chain, `params` the sims' fee
 *  vectors), or null when nothing was simulated. The best candidate: the highest simulated ETH a day. */
export function labFacts(hours: number, exps: Exp[], params: ReadonlyMap<string, Vector>, findings: Finding[], research: number) {
  if (!exps.length) return null;
  const best = exps.reduce((a, b) => ((delta(b, /^project ETH/) ?? -Infinity) > (delta(a, /^project ETH/) ?? -Infinity) ? b : a));
  const v = params.get(best.sim);
  const red = findings.filter((f) => f.kind === "red-team");
  const open = red.filter((f) => f.status === "open").length;
  return {
    event: "lab", hours, tested: exps.length, rejected: exps.length,
    best: { ...(v ? { fee: feeFacts(v) } : {}), ...move(delta(best, /^project ETH/), "ethUpPct", "ethDownPct"), ...move(delta(best, /^swap retention/), "swapsUpPct", "swapsDownPct"), verdict: verdictOf(best.note) },
    ...(red.length ? { redTeamFindings: red.length, ...(open ? { redTeamOpen: open } : {}) } : {}),
    ...(research ? { researchFindings: research } : {}),
  };
}

/** Signed records of `kind` written in [from, to) (newest first, at most `n` read). */
const inWindow = async <T>(kind: LogKind, from: number, to: number, n: number) =>
  (await trustedDocs<T>(kind, undefined, n)).filter((r) => r._at.getTime() >= from && r._at.getTime() < to);

/** x:lab (every 2 h, 5 min after the window): the window's lab post, once (its key); quiet windows post nothing. */
export const labHandler: Handler = {
  lane: "x",
  run: async (job) => {
    const at = typeof job.payload.due === "string" ? Date.parse(job.payload.due) : Date.now();
    if (Date.now() - at > HOUR) return `missed the lab hour (${job.payload.due})`; // a stale window never posts
    const to = at - LAB.lagMs;
    const hours = launchDay(to - LAB.hours * HOUR) ? LAB.hours : LAB.afterHours;
    if (new Date(to).getUTCHours() % hours) return `not a lab hour: one every ${hours} h`;
    const from = to - hours * HOUR;
    const [expRows, sims, findings, research] = await Promise.all([
      inWindow<Exp>("experiment", from, to, 80), inWindow<{ id: string; params: Vector }>("sim", from, to, 80),
      inWindow<Finding>("security", from, to, 150), inWindow<{ findings?: unknown[] }>("research", from, to, 20),
    ]);
    // an experiment counts once, as its newest record in the window says (rows come newest first), and only when every
    // record it has is a rejection: a run that went on-chain wrote a shadow record at its queue (src/loop.ts)
    const newest = [...new Map(expRows.reverse().map((e) => [e.id, e])).values()];
    const offChain = await Promise.all(newest.map(async (e) => (await trustedDocs<Exp>("experiment", e.id, 10)).every((r) => r.status === "rejected")));
    const exps = newest.filter((_, i) => offChain[i]);
    const facts = labFacts(hours, exps, new Map(sims.map((s) => [s.id, s.params])), findings, research.reduce((n, r) => n + (Array.isArray(r.findings) ? r.findings.length : 0), 0));
    if (!facts) return "nothing simulated in the window: no lab post";
    const key = `lab:${new Date(from).toISOString().slice(0, 13)}`, link = `${LOG_BASE_URL}/lab/experiments`;
    // the outbox row first (once per key), then the site's record; the studio starts on its art now
    const id = await enqueueX(key, "post", facts, { link });
    await announce(key, facts, { proof: link });
    if (id) await requestArtFor(key, factSheet(facts));
    return { [key]: !!id };
  },
};
