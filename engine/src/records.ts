// Engine records → the site. Zod schemas mirror web/app/_data/types.ts (the source of truth; test/records.typecheck.ts
// asserts the inferred types equal the web types at compile time, so `npm run check` fails on drift). Every record is
// validated here and appended through log_append (src/log.ts): the web reads the newest record per ref.
import type postgres from "postgres";
import { z } from "zod";
import { edb } from "./db.ts";
import { append, type EnclaveRow, type LogKind, newestOf, RolledBack, rolledBack, trustedRecord } from "./log.ts";

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z)?$/);
const text = (max: number) => z.string().min(1).max(max);

export const AgentName = z.enum(["Research", "Market", "Risk", "Red-team", "Treasury", "Simulation", "Main"]);
export const ThreadStep = z.object({
  id: z.string(),
  kind: z.enum(["hypothesis", "evidence+", "evidence-", "counter", "confidence", "decision", "next"]),
  agent: AgentName,
  model: z.string(),
  text: text(1200),
  ref: z.string().optional(),
  value: z.number().min(0).max(100).optional(),
  at: iso,
});
export const ThreadHead = z.object({ id: z.string(), title: text(200), status: z.enum(["open", "decided"]) });
export const Thread = ThreadHead.extend({ steps: z.array(ThreadStep) });

export const Experiment = z.object({
  id: z.string(),
  bench: z.enum(["1", "2", "3"]),
  module: z.string(),
  status: z.enum(["shadow", "canary_queued", "canary", "rejected", "passed"]),
  sim: z.string(),
  metrics: z.array(z.object({ name: z.string(), delta: z.number(), unit: z.enum(["%", "bps"]) })),
  note: z.string(),
});
export const PIPELINE = ["research", "simulate", "red-team", "canary", "measure", "rollback", "memory"] as const;
export const Pipeline = z.array(z.object({ stage: z.enum(PIPELINE), current: z.boolean() }));

export const MemoryEntry = z.object({
  id: z.number().int(),
  title: text(200),
  hypothesis: text(600),
  method: text(600),
  result: text(800),
  decision: z.enum(["accepted", "rejected", "rolled_back"]),
  futureRule: z.string().max(400).optional(),
  refs: z.array(z.object({ label: z.string(), ref: z.string() })),
  date: iso,
  series: z.object({ candidate: z.array(z.number()), baseline: z.array(z.number()) }).optional(),
});

export const Epoch = z.object({
  n: z.number().int(),
  name: z.string(),
  block: z.number().int(),
  before: z.string(),
  after: z.string(),
  changed: z.string(),
  rollbacks: z.number().int(),
  autonomy: z.tuple([z.number().int(), z.number().int()]),
  branches: z.array(z.object({ id: z.string(), label: z.string(), outcome: z.enum(["active", "rejected", "rolled_back"]) })),
});

export const JournalEntry = z.object({
  day: z.number().int(),
  date: iso,
  summary: text(400),
  stats: z.array(z.object({ label: z.string(), value: z.string() })),
  learned: text(400),
  tomorrow: text(400),
  autonomy: z.string(),
});

export const SecurityItem = z.object({
  id: z.string(),
  kind: z.enum(["red-team", "rollback", "guardian", "disclosure"]),
  title: text(200),
  severity: z.enum(["info", "low", "medium", "high"]),
  status: z.enum(["open", "mitigated", "accepted", "resolved"]),
  detail: text(1200),
  date: iso,
  ref: z.string().optional(),
});

/** Idea status as the engine knows it (written only after the idea's round closed; SPEC §10.1). */
export const IdeaStatus = z.object({
  id: z.number().int(),
  round: z.number().int(),
  status: z.enum(["researching", "simulating", "red-team", "accepted", "rejected", "void"]),
  resolution: z.string().max(400).optional(),
  // live idea mode (src/config.ts IDEA_MODE): one idea judged as it came in. `id` is its IdeaMarket id, or for an X
  // idea the number it was queued under (0: not queued); `from` where it came from; `brain` the signed outcome's seq
  live: z.literal(true).optional(),
  from: z.enum(["site", "x"]).optional(),
  kind: z.string().max(20).optional(),
  title: z.string().max(120).optional(),
  brain: z.string().regex(/^\d{1,18}$/).optional(),
  redTeam: z.enum(["pass", "block"]).optional(),
});

/** Engine fields of the homepage core (web _live/feed.ts Core). */
export const CoreRecord = z.object({
  goal: text(200),
  task: text(200),
  hypothesis: text(400),
  confidence: z.number().min(0).max(100),
  next: z.array(text(120)).max(3),
  simulations: z.number().int(),
  stage: z.enum(PIPELINE).optional(),
});

/** Attested counts behind the /autonomy ladder criteria. */
export const Autonomy = z.object({
  simulations: z.number().int(),
  redteamRuns: z.number().int(),
  redteamPasses: z.number().int(),
  redteamBlocks: z.number().int(),
  openHighFindings: z.number().int(),
  canaries: z.number().int(),
  canariesPassed: z.number().int(),
  canariesKilled: z.number().int(),
  at: iso,
});

export const Sim = z.object({
  id: z.string(),
  thread: z.string(),
  label: z.literal("uncalibrated"),
  harness: z.string(),
  plate: z.string(),
  params: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  forkBlock: z.number().int().nullable(),
  replayed: z.number().int(),
  safety: z.object({
    candidateReverts: z.number().int(),
    moduleFailed: z.number().int(),
    breakerFailCount: z.number().int(),
    maxGasDelta: z.number().int(),
    clamped: z.number().int(),
  }).nullable(),
  baseline: z.object({ projectEthPerDay: z.number(), swapsPerDay: z.number(), meanPips: z.number(), atCapShare: z.number() }),
  candidate: z.object({ meanPips: z.number(), atCapShare: z.number() }),
  elasticity: z.array(z.object({ eps: z.number(), projectEthPerDay: z.number(), swapRetention: z.number() })),
});

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const wei = z.string().regex(/^\d{1,78}$/);
/** A DNA pool without DNA's hook (src/clones.ts). */
export const Clone = z.object({
  id: z.string().regex(/^0x([0-9a-f]{40}|[0-9a-f]{64})$/),
  venue: text(40),
  version: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  other: addr,
  fee: z.number().int().min(0).nullable(),
  hooks: addr.nullable(),
  block: z.number().int(),
  tx: z.string().regex(/^0x[0-9a-f]{64}$/),
});
export const Leakage = z.object({
  fromBlock: z.number().int(),
  toBlock: z.number().int(),
  canonicalDna: wei,
  cloneDna: wei,
  pct: z.number().min(0).max(100),
  byClone: z.array(z.object({ id: z.string(), dna: wei })),
});

const SCHEMAS: Partial<Record<LogKind, z.ZodType>> = {
  clone: Clone,
  leakage: Leakage,
  step: ThreadStep.extend({ thread: z.string() }),
  thread: ThreadHead.extend({ genesis: z.boolean().optional(), pipeline: Pipeline.optional() }),
  experiment: Experiment.extend({ thread: z.string() }),
  memory: MemoryEntry.extend({ genesis: z.boolean().optional() }),
  epoch: Epoch,
  journal: JournalEntry.extend({ genesis: z.boolean().optional(), pulse: z.boolean().optional() }), // pulse: the hourly "today so far" (ref 'pulse')
  security: SecurityItem,
  idea: IdeaStatus,
  core: CoreRecord,
  autonomy: Autonomy,
  sim: Sim,
};

type Db = postgres.Sql | postgres.TransactionSql;
/** Validate (for the site-facing kinds) and append. Throws on a schema violation: nothing invalid reaches the log. */
export async function record(kind: LogKind, ref: string | null, body: unknown, tx: Db = edb) {
  const schema = SCHEMAS[kind];
  return append(kind, ref, schema ? schema.parse(body) : body, tx);
}

/** Newest record bodies of `kind` (optionally for `ref`) that the enclave signed; the plain build trusts every row.
 *  Enclave: throws (`rolledBack`) when the newest one is older than a record the enclave knows it wrote (hidden rows). */
export async function trustedDocs<T>(kind: LogKind, ref?: string, limit = 1): Promise<(T & { _seq: string; _at: Date })[]> {
  const out: (T & { _seq: string; _at: Date })[] = [];
  const want = newestOf(kind, ref); // before the read: an append landing meanwhile is not a rollback
  const rows = await edb<({ doc: T; seq: string; at: Date } & EnclaveRow)[]>`select doc, seq::text, at, kind, ref, body, eprev, ehash, esig from log where kind = ${kind}
    ${ref === undefined ? edb`` : edb`and ref = ${ref}`} order by log.seq desc limit ${limit + 20}`; // + room for skipped rows; log.seq, not the ::text alias
  for (const r of rows) {
    if (out.length >= limit) break;
    if (await trustedRecord(r, `${kind} record`)) out.push({ ...r.doc, _seq: r.seq, _at: r.at });
  }
  if (await rolledBack(kind, ref, out[0]?._seq, want)) throw RolledBack(`${kind}${ref === undefined ? "" : ` ${ref}`}`);
  return out;
}
/** Newest (trusted) record body of `kind` (optionally for `ref`). */
export const latest = async <T>(kind: LogKind, ref?: string) => (await trustedDocs<T>(kind, ref))[0];

export const count = async (kind: LogKind, where = edb``) =>
  (await edb<{ n: number }[]>`select count(*)::int as n from log where kind = ${kind} ${where}`)[0].n;

/** Next sequential id for a record family ('R' red-team findings, 'sim', 'mem', 'T' threads): count + 1. */
export async function nextId(kind: LogKind, distinctRefs = true) {
  const [r] = await edb<{ n: number }[]>`select count(${distinctRefs ? edb`distinct ref` : edb`*`})::int as n from log where kind = ${kind}`;
  return r.n + 1;
}

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
export { nowIso };

/** Append one reasoning step to a thread (the /mind page). */
export async function step(thread: string, s: Omit<z.input<typeof ThreadStep>, "id" | "at"> & { at?: string }, tx: Db = edb) {
  const [{ n }] = await (tx as postgres.Sql)<{ n: number }[]>`select count(*)::int as n from log where kind = 'step' and ref = ${thread}`;
  return record("step", thread, { ...s, id: `${thread}-s${n + 1}`, at: s.at ?? nowIso(), thread }, tx);
}
