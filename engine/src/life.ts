// What a post knows of the engine's own run, read from its signed records (the same ones /mind, /memory and /journal
// show): the day of the run and the mind block (the open experiment's title, hypothesis and confidence, the brain's
// next steps, the latest lesson, the journal's learned line, the last closed experiments). Raw here; src/voice.ts
// mindOf screens every line before a writer sees it.
import { LLM } from "./config.ts";
import { ENCLAVE } from "./enclave.ts";
import { edb as sql } from "./db.ts";
import { isRolledBack, trusted } from "./log.ts";
import { latest, trustedDocs } from "./records.ts";

const DAY = 86_400_000;

/** The run's day (day 1 is the launch day, by LLM_LAUNCH_AT; before a launch time is set, from the first record). */
export function dayOf(now: number, launchAt: number | undefined, firstAt: number | undefined) {
  const start = launchAt ?? firstAt;
  if (start === undefined || now < start) return 1;
  return Math.floor((now - (start - (start % DAY))) / DAY) + 1;
}
export async function dayOfLife(now = Date.now()) {
  if (LLM.launchAt !== undefined) return dayOf(now, LLM.launchAt, undefined);
  const [r] = await sql<{ at: Date }[]>`select at from log order by seq limit 1`;
  return dayOf(now, undefined, r?.at.getTime());
}

const OUTCOME: Record<string, string> = { accepted: "kept", rejected: "killed", rolled_back: "rolled back" };
type Memory = { title: string; decision: string; date: string; futureRule?: string };
/** The last closed experiments (newest first) as the mind lists them. */
export const closedOf = (mem: Memory[], now: number) => mem.filter((m) => OUTCOME[m.decision]).slice(0, 3)
  .map((m) => ({ title: m.title, outcome: OUTCOME[m.decision], date: m.date.slice(0, 10), daysAgo: Math.max(0, Math.floor((now - Date.parse(`${m.date.slice(0, 10)}T00:00:00Z`)) / DAY)) }));

const soft = <T>(p: Promise<T>, fallback: T) => p.catch((e) => (isRolledBack(e) ? fallback : Promise.reject(e)));
/** The raw mind block (null fields left out by the screen). */
export async function mindNow(now = Date.now()) {
  const [runRow] = await sql<{ id: string; data: { title: string; hypothesis: string; confidence: number }; sig: string | null }[]>`select id, data, sig from thread where kind = 'fee' and stage <> 'closed' order by created_at desc limit 1`;
  const run = runRow && (await trusted("thread", runRow.id, runRow.data, runRow.sig)) ? runRow.data : undefined;
  const [core, mem, journals] = await Promise.all([
    soft(latest<{ hypothesis?: string; confidence?: number; next?: string[] }>("core"), undefined),
    soft(trustedDocs<Memory>("memory", undefined, 3), []),
    soft(trustedDocs<{ learned?: string; tomorrow?: string; pulse?: boolean }>("journal", undefined, 30), []),
  ]);
  const journal = journals.find((j) => !j.pulse);
  return {
    title: run?.title, why: run?.hypothesis ?? core?.hypothesis, confidencePct: run?.confidence ?? (core?.confidence || undefined),
    next: core?.next, lesson: mem[0]?.futureRule, learned: journal?.learned, closed: closedOf(mem, now),
  };
}

// ---------------------------------------------------------------- what it is waiting on

/** One thing the engine waits on, in code's words; `minutesLeft` (a number a post may state) when it has a clock. */
export type Pending = { what: string; waitingOn: string; minutesLeft?: number };
export type PendingInput = {
  now: number;
  /** registry ops queued and neither executed nor cancelled (the public veto hour) */
  queued: { op: string; byAgent: boolean; etaMs: number }[];
  /** the registry's agent is the enclave's key (the Safe executed SetAgent) */
  agentSet: boolean;
  /** a passed canary waits for the Safe to promote its plate */
  promoteRequested: boolean;
  /** a split module is routed (until then the games get no fee share) */
  splitSet: boolean;
  /** the game factory is deployed (the dev team can ship a game) */
  gameFactory: boolean;
  build: { stage: "building" | "shipping"; title?: string } | null;
  /** `fromX`: ideas from X the intake took in for this round (they go on-chain after it closes) */
  ideaRound: { endsMs: number; ideas: number; fromX?: number } | null;
  draw: { stage: "veto" | "randomness"; etaMs?: number } | null;
  /** a code update scheduled in the timelock, in its hour (src/upgrades.ts pendingUpdate) */
  update?: { etaMs: number } | null;
};
const OP_WORDS: Record<string, string> = { SetParams: "new fee parameters", SetShadow: "shadow test", SetCanary: "canary test", PromoteActive: "promotion of the tested plate", Register: "module registration" };
const mins = (now: number, at: number) => Math.max(0, Math.ceil((at - now) / 60_000));
/** A build title a post may carry (digit-free, no link or handle), quoted; else none. */
const titled = (t: string | undefined) => (t && !/\p{N}/u.test(t) && !/https?:|www\.|@|#|\$/.test(t) ? `"${t.replace(/"/g, "").slice(0, 80)}"` : undefined);
/** The pending block (pure): what is queued, what waits for the Safe's signers, the dev team, the idea round, a draw.
 *  `broadcast` (a status, the opening post): the Safe's queued ops and a code update are left out, each has its own post
 *  (src/upgrades.ts); a reply keeps them ("wen?" gets the minutes). */
export function pendingOf(i: PendingInput, broadcast = false): Pending[] {
  const out: Pending[] = [];
  for (const q of i.queued.slice(0, 3)) {
    if (broadcast && !q.byAgent) continue;
    out.push(q.byAgent
      ? { what: `my ${OP_WORDS[q.op] ?? "change"} sits in the public veto hour`, waitingOn: "the clock and the Safe", minutesLeft: mins(i.now, q.etaMs) }
      : { what: `the Safe's ${q.op} in its public hour`, waitingOn: "the clock", minutesLeft: mins(i.now, q.etaMs) });
  }
  if (i.update && !broadcast) out.push({ what: "an update to my own code in its public hour", waitingOn: "the clock and the Safe", minutesLeft: mins(i.now, i.update.etaMs) });
  if (!i.agentSet) out.push({ what: ENCLAVE.on ? "the Safe's signers to hand my keys to the enclave (SetAgent)" : "the Safe's signers to hand me the agent role (SetAgent)", waitingOn: "the Safe's signers" });
  if (i.promoteRequested) out.push({ what: "the Safe's signers to make the tested plate the live fee", waitingOn: "the Safe's signers" });
  if (!i.splitSet) out.push({ what: "the Safe to switch on a split module (the games get no fee share until then)", waitingOn: "the Safe's signers" });
  if (!i.gameFactory) out.push({ what: "the game factory: the sequencer can't ship a game before it is deployed", waitingOn: "the team" });
  if (i.build) {
    const t = titled(i.build.title);
    out.push(i.build.stage === "shipping"
      ? { what: `${t ?? "a new game"} waiting out its public hour`, waitingOn: "the clock and the Safe" }
      : { what: t ? `the sequencer building ${t}` : "the sequencer building a game", waitingOn: "the sequencer" });
  }
  if (i.ideaRound) out.push({ what: i.ideaRound.ideas ? "the idea round closing, then my verdicts on its ideas" : i.ideaRound.fromX ? "the idea round closing: ideas from X are logged for it, the top ones go on-chain after" : "ideas for the open round (none in yet)", waitingOn: "holders", minutesLeft: mins(i.now, i.ideaRound.endsMs) });
  if (i.draw) out.push(i.draw.stage === "veto"
    ? { what: "a jackpot draw: its list waits out the Safe's veto hour", waitingOn: "the clock and the Safe", ...(i.draw.etaMs ? { minutesLeft: mins(i.now, i.draw.etaMs) } : {}) }
    : { what: "a jackpot draw waiting for its randomness", waitingOn: "the oracle" });
  return out;
}

/** The pending block now, from the indexed chain, the snapshot, the open run and the dev team's build (code reads only;
 *  a failed read leaves its line out, never a guessed one). `event`: the post it is for (pendingOf's broadcast). */
export async function pendingNow(now = Date.now(), event?: string): Promise<Pending[]> {
  const { d } = await import("./config.ts");
  const { addressOf, pub } = await import("./tx.ts");
  const { OPS } = await import("./lib.ts");
  const { ideaMarketAbi } = await import("./abi.ts");
  const { activeBuild } = await import("./sequencer.ts");
  const agent = addressOf("agent")?.toLowerCase();
  const reg = d.registry.toLowerCase();
  const [queued, agentSet, run, chain, build] = await Promise.all([
    sql<{ op: number; proposer: string; eta: string }[]>`select (q.args->>'op')::int as op, q.args->>'proposer' as proposer, q.args->>'eta' as eta from chain_log q
      where q.event = 'Queued' and q.address = ${reg} and not exists (select 1 from chain_log x where x.address = ${reg} and x.event in ('Executed', 'Cancelled') and x.args->>'id' = q.args->>'id')
      order by q.block, q.log_index limit 3`,
    agent ? sql`select 1 from chain_log where event = 'AgentSet' and address = ${reg} and lower(args->>'agent') = ${agent} limit 1`.then((r) => r.length > 0) : Promise.resolve(true),
    sql<{ stage: string }[]>`select stage from thread where kind = 'fee' and stage <> 'closed' order by created_at desc limit 1`,
    sql<{ value: { split?: { module?: string }; game?: { pot?: { draw?: { eta?: string; requestedAt?: string; fulfilledAt?: string } } } } }[]>`select value from state where key = 'chain'`,
    activeBuild().catch(() => null),
  ]);
  let ideaRound: PendingInput["ideaRound"] = null;
  if (d.ideaMarket) {
    try {
      const r = await pub.readContract({ address: d.ideaMarket, abi: ideaMarketAbi, functionName: "currentRound" }) as bigint;
      const end = await pub.readContract({ address: d.ideaMarket, abi: ideaMarketAbi, functionName: "roundEnd", args: [r] }) as bigint;
      const [{ n, x }] = await sql<{ n: number; x: number }[]>`select (select count(*) from chain_log where event = 'IdeaSubmitted' and (args->>'round')::numeric = ${String(r)})::int as n,
        (select count(*) from intake where round = ${Number(r)} and status in ('candidate', 'picked', 'submitted', 'queued', 'rejected'))::int as x`;
      ideaRound = { endsMs: Number(end) * 1000, ideas: n, fromX: x };
    } catch { /* not read: no line */ }
  }
  const draw = chain[0]?.value.game?.pot?.draw;
  const num = (v: unknown) => Number(v ?? 0);
  const update = await (await import("./upgrades.ts")).pendingUpdate(now).catch(() => null);
  return pendingOf({
    now, agentSet, update,
    queued: queued.map((q) => ({ op: OPS[q.op] ?? "change", byAgent: q.proposer?.toLowerCase() === agent, etaMs: Number(q.eta) * 1000 })),
    promoteRequested: run[0]?.stage === "promote_requested",
    splitSet: !chain[0] || !/^0x0{40}$/i.test(chain[0].value.split?.module ?? "0x0000000000000000000000000000000000000000"),
    gameFactory: !!d.gameFactory,
    build: build ? { stage: build.status === "verdict" || build.status === "shipping" ? "shipping" : "building", title: build.data.title } : null,
    ideaRound,
    draw: !draw || !num(draw.eta) ? null : num(draw.fulfilledAt) ? null : num(draw.requestedAt) ? { stage: "randomness" } : { stage: "veto", etaMs: num(draw.eta) * 1000 },
  }, event !== undefined && event !== "reply");
}

// ---------------------------------------------------------------- the story so far

type Ann = { type: string; title: string; at: Date };
/** Up to 3 lines of what happened lately (newest first), the last post of the same kind first so a repeat kind says
 *  something new; each with its age in whole hours. */
export function earlierOf(rows: Ann[], type: string, now: number) {
  const same = rows.find((r) => r.type === type);
  const pick = [...(same ? [same] : []), ...rows.filter((r) => r !== same)].slice(0, 3);
  return pick.map((r) => ({ hoursAgo: Math.max(0, Math.floor((now - r.at.getTime()) / 3600_000)), line: r.title }));
}
/** The story for a post: hours since launch and what happened in the last 48 h (the site's code-written titles). */
export async function storyNow(key: string, type: string, now = Date.now()) {
  // simplification: plain announce rows (public titles the site shows), no signature checks: writer context only
  const rows = await sql<Ann[]>`select doc->>'type' as type, doc->>'title' as title, at from log where kind = 'announce' and ref <> ${key}
    and at > ${new Date(now - 48 * 3600_000)} and doc->>'title' is not null order by seq desc limit 30`;
  return { ...(LLM.launchAt !== undefined && now >= LLM.launchAt ? { hoursSinceLaunch: Math.floor((now - LLM.launchAt) / 3600_000) } : {}), earlier: earlierOf(rows, type, now) };
}
