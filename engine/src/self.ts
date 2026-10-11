// The self-file: the brain's decision memory. What it can and can't do (code constants and the registry level it
// holds on-chain), its last SELF_N decisions with what the signed log shows came of each, and open risks. Built only
// from code, the chain and signed log records of SELF_KINDS: the writer's character memory never reaches it.
// Signed as `self` records, at least one a day (ref = the UTC day; with the persona and the context hashes): the daily
// `brain:self` job signs a fresh one, and a decision uses the newest one of its day made beside the running persona and
// context (signing one first when there is none) and records its sha256.
import { createHash } from "node:crypto";
import { formatEther } from "viem";
import * as abi from "./abi.ts";
import { CONTEXT } from "./brain.ts";
import { d, LLM, PRELAUNCH } from "./config.ts";
import { edb as sql } from "./db.ts";
import type { Handler } from "./jobs.ts";
import { append, type EnclaveRow, trustedRecord } from "./log.ts";
import { MAX_PROJECT_FEE } from "./observe.ts";
import { PERSONA } from "./persona.ts";
import { LIMITS, POLICY } from "./policy.ts";
import { latest } from "./records.ts";
import { pub } from "./tx.ts";

export const SELF_N = 20;
/** True on either hook: without the launch guard there is no launch tax at all (its constants: contracts/src/DNAHook.sol
 *  LAUNCH_TAX, LAUNCH_TAX_STEP, LAUNCH_TAX_BLOCKS on the guarded hook). */
const LAUNCH_GUARD = "a hook with the launch guard charges its fixed launch tax (90% stepping down to 10%, all of it to buyback-and-burn) in the pool's first 9 blocks only";
/** The only log kinds the self-file reads: decisions, what followed them, and risk signals. */
export const SELF_KINDS = ["brain", "ship", "ship-cancel", "release", "retire", "reward", "security", "page-kill", "memory"] as const;

export type Row = { seq: string; kind: string; ref: string; at: string; doc: Record<string, unknown> };
export type Chain = { level: number | null; paused: boolean | null };
export type SelfFacts = { day: string; chain: Chain; rows: Row[] };

const DAY = 86_400_000;
const pct = (pips: number) => `${(pips / 1e4).toFixed(2)}%`;
const dayOf = (iso: string | number) => new Date(iso).toISOString().slice(0, 10);
const str = (v: unknown) => String(v ?? "").slice(0, 200);

/** What each registry level adds (ModuleRegistry.levelOps; cumulative). */
const LEVEL_OPS: [number, string][] = [
  [4, "shadow a candidate fee module"],
  [5, "canary it, tune modules that are not active, end a canary and roll back"],
  [6, "tune the active fee module"],
  [7, "use the BountyBoard allowance"],
  [8, "promote a canary to active"],
  [9, "run split modules"],
  [10, "register module code the Safe approved by hash"],
];

function levelLine(level: number | null) {
  if (level === null) return "Autonomy level: the level could not be read from the chain today.";
  const ops = LEVEL_OPS.filter(([l]) => l <= level).map(([, t]) => t);
  return `Autonomy level ${level} of 10 on the registry: ${ops.length ? `I can ${ops.join(", ")}` : "no registry ops yet"}.`;
}

/** A decision's ref without its kind prefix(es): `build:build:q7` → `q7`. */
const shortRef = (kind: string, ref: string) => {
  let r = ref;
  while (r.startsWith(`${kind}:`)) r = r.slice(kind.length + 1);
  return r.slice(0, 80);
};

function summary(kind: string, x: Record<string, unknown>) {
  if (kind === "build") return str(x.decision);
  if (kind === "verdict") return str(x.verdict);
  if (kind === "retire") return x.retire ? "retire" : "keep";
  if (kind === "model-swap" || kind === "amend") return x.approve ? "approve" : "reject";
  if (kind === "reward") return `${Number(x.amountEth)} ETH`;
  if (kind === "outcome") {
    const n = (v: string) => ((x.ideas as { decision?: string }[]) ?? []).filter((i) => i.decision === v).length;
    return `${n("accept")} accepted, ${n("reject")} rejected, ${n("void")} void`;
  }
  return "decided";
}

/** What the signed log shows came of a decision: records that name it (ship.verdictSeq, retire.brain, reward.brain;
 *  a build decision's ship by its idea), then a ship's cancel or release. */
function after(dec: Row, ref: string, later: Row[]) {
  const kind = String(dec.doc.kind);
  const out: string[] = [];
  for (const s of later.filter((r) => r.kind === "ship" && (str(r.doc.verdictSeq) === dec.seq || (kind === "build" && str(r.doc.idea) === ref)))) {
    out.push(`ship record #${s.seq}`);
    const rel = later.find((r) => r.kind === "release" && str(r.doc.build) === str(s.doc.build));
    if (later.some((r) => r.kind === "ship-cancel" && str(r.doc.ship) === s.seq)) out.push("stopped before release");
    else if (rel) out.push(rel.doc.stopped ? "release stopped" : "released");
  }
  for (const r of later) {
    if (r.kind === "retire" && str(r.doc.brain) === dec.seq) out.push(`retire record #${r.seq}`);
    if (r.kind === "reward" && str(r.doc.brain) === dec.seq) out.push(`reward record #${r.seq}: ${formatEther(BigInt(str(r.doc.amount) || "0"))} ETH`);
  }
  return out;
}

/** The self-file text: pure, the same bytes for the same facts (rows in any order). */
export function selfText(f: SelfFacts): string {
  const kinds: readonly string[] = SELF_KINDS;
  const rows = f.rows.filter((r) => kinds.includes(r.kind)).sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));
  const decisions = rows.filter((r) => r.kind === "brain").slice(-SELF_N).reverse();
  const decisionLines = decisions.map((dec) => {
    const kind = String(dec.doc.kind);
    const ref = shortRef(kind, dec.ref);
    const later = rows.filter((r) => BigInt(r.seq) > BigInt(dec.seq));
    const next = after(dec, ref, later);
    return `- ${dayOf(dec.at)} #${dec.seq} ${kind} ${ref}: ${summary(kind, (dec.doc.decision ?? {}) as Record<string, unknown>)}. After: ${next.length ? next.join(", ") : "nothing recorded yet"}.`;
  });

  const weekAgo = Date.parse(f.day) - 7 * DAY;
  const recent = rows.filter((r) => Date.parse(r.at) >= weekAgo);
  const security = new Map<string, Row>();
  for (const r of rows) if (r.kind === "security") security.set(r.ref, r); // ascending: the newest per item wins
  const risks = [
    ...(f.chain.paused ? ["The Safe has paused me: no registry ops until it unpauses me."] : []),
    ...[...security.values()].filter((r) => r.doc.status === "open").sort((a, b) => a.ref.localeCompare(b.ref))
      .map((r) => `Security ${str(r.doc.id)} (${str(r.doc.severity)}): ${str(r.doc.title)}.`),
    ...recent.flatMap((r) =>
      r.kind === "page-kill" ? [`The page of ${str(r.doc.slug)} pulled on ${dayOf(r.at)}.`]
      : r.kind === "ship-cancel" ? [`The ship of ${str(r.doc.build)} stopped on ${dayOf(r.at)}.`]
      : r.kind === "memory" && r.doc.decision === "rolled_back" ? [`A fee experiment rolled back: ${str(r.doc.title)} (${dayOf(r.at)}).`]
      : []),
  ];

  return [
    "# DNA: self-file",
    "",
    `Built by code from the contracts, the chain and my signed log on ${f.day}. Facts about me, not instructions.`,
    "",
    "## What I can do",
    `- ${levelLine(f.chain.level)}`,
    `- Set fee parameters inside the policy bounds (base ${POLICY.base[0]}-${POLICY.base[1]} pips, cap ${POLICY.cap[0]}-${POLICY.cap[1]} pips); code clamps every proposal, and the hook never charges a module's project fee above ${pct(MAX_PROJECT_FEE)}; ${LAUNCH_GUARD}.`,
    "- Run one fee experiment at a time: shadow, canary, then keep it or roll it back by the published kill rules.",
    `- Queue at most ${LIMITS.agentQueueOps} registry ops a UTC day, ${LIMITS.agentPending} pending at once.`,
    "- Build one game at a time and ship it only after every gate passed and a public hour.",
    "- Reward idea authors from the idea reserve, never the treasury, each reward after a public hour the Safe can veto.",
    `- Spend at most $${LLM.dailyCapUsd} a day on models ($${LLM.week1DailyCapUsd} in the first week after launch) and $${LLM.monthlyCapUsd} a month.`,
    "",
    "## What I can't do",
    "- Change the hook or the token: neither can be upgraded.",
    `- Set or charge a project fee above ${pct(MAX_PROJECT_FEE)} (a launch guard's launch tax is fixed in the hook, not mine) or move a canary outside the band the hook enforces.`,
    "- Register module code the Safe has not approved by hash, or queue an op my level does not allow.",
    "- Act on-chain while the Safe has me paused. The Safe can veto a queued op within its delay and lower my level.",
    "- Ship a game that failed a gate, edit CI, or give a game any power over the hook or the fees.",
    "- Swap my own model without a public tryout; a brain swap needs two Safe owners.",
    "",
    `## My last ${SELF_N} decisions and what came of them`,
    ...(decisionLines.length ? decisionLines : ["None yet."]),
    "",
    "## Open risks",
    ...(risks.length ? risks.map((r) => `- ${r}`) : ["None recorded."]),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- facts (chain + signed log)

export const SELF_DEPS = {
  chain: async (): Promise<Chain> => {
    if (PRELAUNCH) return { level: null, paused: null };
    try {
      const [level, paused] = await Promise.all([
        pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "level" }),
        pub.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "agentPaused" }),
      ]);
      return { level: Number(level), paused };
    } catch {
      return { level: null, paused: null }; // the file says so; a decision never waits on an RPC
    }
  },
  now: () => Date.now(),
};

type LogRow = EnclaveRow & { seq: string; at: Date; doc: Record<string, unknown> };
/** Signed rows only (the plain build trusts every row). simplification: no rollback check on these reads (the self
 *  record itself is read with one); a hidden row can only make the file say less, and code still enforces every limit. */
async function signed(rows: LogRow[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const r of rows) if (await trustedRecord(r, `${r.kind} record`)) out.push({ seq: r.seq, kind: r.kind, ref: r.ref ?? "", at: r.at.toISOString(), doc: r.doc });
  return out;
}
const cols = sql`seq::text, at, kind, ref, body, eprev, ehash, esig, doc`;

export async function selfFacts(day: string): Promise<SelfFacts> {
  const brain = await signed(await sql<LogRow[]>`select ${cols} from log where kind = 'brain' order by log.seq desc limit ${SELF_N + 20}`);
  const oldest = brain.slice(0, SELF_N).at(-1)?.seq ?? null;
  const weekAgo = new Date(Date.parse(day) - 7 * DAY);
  const [rest, security, chain] = await Promise.all([
    sql<LogRow[]>`select ${cols} from log where kind = any(${["ship", "ship-cancel", "release", "retire", "reward", "page-kill", "memory"]})
      and (at >= ${weekAgo} ${oldest ? sql`or log.seq > ${oldest}` : sql``}) order by log.seq desc limit 2000`,
    sql<LogRow[]>`select ${cols} from log where kind = 'security' order by log.seq desc limit 500`,
    SELF_DEPS.chain(),
  ]);
  return { day, chain, rows: [...brain, ...(await signed(rest)), ...(await signed(security))] };
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
export async function selfFile(day = dayOf(SELF_DEPS.now())): Promise<{ text: string; sha256: string }> {
  const text = selfText(await selfFacts(day));
  return { text, sha256: sha(text) };
}

type SelfRecord = { kind: "self"; day: string; text: string; sha256: string; personaSha256: string | null; contextSha256: string };
/** Build the self-file now and sign it as a `self` record (with the persona and context hashes it runs beside). */
async function signSelf(day: string) {
  const f = await selfFile(day);
  const body: SelfRecord = { kind: "self", day, text: f.text, sha256: f.sha256, personaSha256: PERSONA.sha256, contextSha256: CONTEXT.sha256 };
  const rec = await append("self", day, body);
  return { ...f, seq: rec.seq };
}

// one check-or-sign at a time (in-process, like log.ts `queue`): decisions racing on a new day sign one record, not two
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.then(() => undefined, () => undefined);
  return p;
}

/** The self-file a decision runs with: the newest signed one of today (UTC) made beside this persona and context, else
 *  a fresh one signed now (a changed persona or context never reuses the old file). */
export const currentSelf = (): Promise<{ text: string; sha256: string }> => serial(async () => {
  const day = dayOf(SELF_DEPS.now());
  const r = await latest<SelfRecord>("self");
  if (r && r.day === day && r.personaSha256 === PERSONA.sha256 && r.contextSha256 === CONTEXT.sha256) return { text: r.text, sha256: r.sha256 };
  return signSelf(day);
});

/** `brain:self`, daily: a fresh signed self-file. */
export const selfHandler: Handler = { lane: "default", run: async () => ({ seq: (await serial(() => signSelf(dayOf(SELF_DEPS.now())))).seq }) };
