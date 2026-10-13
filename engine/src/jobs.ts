// Postgres job queue: enqueue with an optional dedupe_key, claim with `for update skip locked`, exponential backoff,
// per-lane concurrency (lanes are in-process: one engine replica; a second replica would need DB-side lane counts).
import { edb as sql } from "./db.ts";

export type Job = { id: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number; created_at: Date; dedupe_key: string | null };
export type Handler = { lane: string; run: (job: Job) => Promise<unknown> };

/** Reschedule without spending an attempt (gas too high, halted, LLM cap, ...). */
export class Defer extends Error {
  ms: number;
  constructor(ms: number, message: string) { super(message); this.ms = ms; }
}

// agent: daily cycle, plate ticks, journal, genesis (serial: one experiment at a time); ideas: intake + round research
export const LANES: Record<string, number> = { "tx:agent": 1, "tx:anchor": 1, "tx:keeper": 1, agent: 1, ideas: 1, llm: 2, tg: 1, x: 1, seq: 1, pages: 1, default: 4 };
// A crashed worker's job is reclaimed after this. Most handlers end well within it (tx 10 min, LLM 10 min); the page
// check runs longer (up to 90 min in the public hour). Its job is never claimed twice by a live process: a lane runs
// one job at a time, and a claim needs a lane with room. After a restart mid-check the job is reclaimed when its lock
// expires and asks again; the page check service answers 409 while the old check finishes, and the engine waits.
export const LOCK_MS = 30 * 60_000;
export const backoff = (attempts: number) => Math.min(2 ** attempts * 10_000, 3600_000);

export async function enqueue(kind: string, payload: Record<string, unknown> = {}, o: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
  const [r] = await sql<{ id: string }[]>`insert into job (kind, payload, run_at, dedupe_key, max_attempts)
    values (${kind}, ${sql.json(payload as never)}, ${o.runAt ?? new Date()}, ${o.dedupeKey ?? null}, ${o.maxAttempts ?? 5})
    on conflict (dedupe_key) do nothing returning id::text`;
  return r?.id; // undefined: deduped
}

/** Claim the oldest due job among `kinds` (queued, or running with an expired lock). */
export async function claim(kinds: string[]): Promise<Job | undefined> {
  if (!kinds.length) return;
  const [j] = await sql<Job[]>`update job set status = 'running', attempts = attempts + 1, updated_at = now(),
      locked_until = now() + ${LOCK_MS / 1000} * interval '1 second'
    where id = (select id from job where run_at <= now() and kind = any(${kinds})
      and (status = 'queued' or (status = 'running' and locked_until < now()))
      order by run_at, id limit 1 for update skip locked)
    returning id::text, kind, payload, attempts, max_attempts, created_at, dedupe_key`;
  return j;
}

/** Record the outcome. Returns the new status. */
export async function finish(job: Job, err?: unknown): Promise<"done" | "queued" | "failed"> {
  if (err === undefined) {
    await sql`update job set status = 'done', locked_until = null, updated_at = now() where id = ${job.id}`;
    return "done";
  }
  const msg = String((err as Error)?.message ?? err).slice(0, 2000);
  if (err instanceof Defer) {
    await sql`update job set status = 'queued', attempts = attempts - 1, last_error = ${msg}, updated_at = now(),
      run_at = now() + ${err.ms / 1000} * interval '1 second' where id = ${job.id}`;
    return "queued";
  }
  const failed = job.attempts >= job.max_attempts || (err as { final?: boolean })?.final === true; // final: retrying can't help
  await sql`update job set status = ${failed ? "failed" : "queued"}, last_error = ${msg}, updated_at = now(),
    run_at = now() + ${backoff(job.attempts) / 1000} * interval '1 second' where id = ${job.id}`;
  return failed ? "failed" : "queued";
}

/** The worker's liveness, read by the stall guard (src/engine.ts): when the poll loop last came round, and since when
 *  each job is in flight in this process. */
export const workerPulse = { polledAt: Date.now(), running: new Map<string, { kind: string; since: number }>() };
/** A poll loop that has not come round in `pollMs` is stuck on a call that never returns (a DB socket gone dead); a
 *  job in flight past its limit holds its lane shut for good. The limits are backstops for a call that never returns,
 *  not timings: the long kinds get a day (the idea intake screens and judges dozens of mentions in series, each model
 *  call up to 10 min with a retry; a sequencer step and the daily check run page checks in series). */
export const STALL = { pollMs: 10 * 60_000, jobMs: 8 * 3600_000, jobMsByKind: { "pages:daily": 24 * 3600_000, "seq:step": 24 * 3600_000, "ideas:intake": 24 * 3600_000 } as Record<string, number> };
/** Call `exit` (in the same tick as the check: nothing can start signing in between) once no state record is being
 *  signed and the last one finished QUIET.ms ago, so its row write (one statement right after) has landed; at most
 *  QUIET.maxMs in all (a dead DB never finishes one). */
export const QUIET = { ms: 30_000, maxMs: 10 * 60_000 };
export async function quietSpell(w: { at: number; pending: number }, exit: () => void, q = QUIET, now = () => Date.now(), sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  for (const end = now() + q.maxMs; ; await sleep(1_000)) if ((w.pending === 0 && now() - w.at >= q.ms) || now() >= end) return exit();
}
/** Why the worker is stuck, or null. */
export function stalled(p: typeof workerPulse, now = Date.now()): string | null {
  if (now - p.polledAt > STALL.pollMs) return `the job poll has not come round in ${Math.round((now - p.polledAt) / 60_000)} min`;
  for (const [id, r] of p.running) if (now - r.since > (STALL.jobMsByKind[r.kind] ?? STALL.jobMs)) return `job ${id} ${r.kind} has run ${Math.round((now - r.since) / 60_000)} min`;
  return null;
}

/** Worker loop: fill every lane with capacity, run handlers concurrently, poll every `pollMs`. */
export function startWorker(handlers: Record<string, Handler>, onFailed: (job: Job, err: unknown) => void, pollMs = 2000) {
  const busy: Record<string, number> = {};
  let stopped = false;
  let wake: () => void = () => {};
  const open = () => Object.entries(handlers).filter(([, h]) => (busy[h.lane] ?? 0) < (LANES[h.lane] ?? 1)).map(([k]) => k);
  (async () => {
    while (!stopped) {
      workerPulse.polledAt = Date.now();
      try {
        for (let job = await claim(open()); job && !stopped; job = stopped ? undefined : await claim(open())) {
          const j = job;
          const h = handlers[j.kind];
          busy[h.lane] = (busy[h.lane] ?? 0) + 1;
          workerPulse.running.set(j.id, { kind: j.kind, since: Date.now() });
          h.run(j).then(() => finish(j), async (e) => {
            if (!(e instanceof Defer)) console.error(`job ${j.id} ${j.kind} attempt ${j.attempts} failed:`, (e as Error)?.message ?? e);
            if ((await finish(j, e)) === "failed") onFailed(j, e);
          }).catch((e) => console.error("finish failed", e)).finally(() => { busy[h.lane]--; workerPulse.running.delete(j.id); wake(); });
        }
      } catch (e) {
        console.error("worker poll failed", e);
      }
      await new Promise<void>((r) => { wake = r; setTimeout(r, pollMs); });
    }
  })();
  return () => { stopped = true; wake(); };
}

// ---------------------------------------------------------------- scheduler

export type Schedule = { kind: string; everyMs: number; offsetMs?: number; payload?: (start: Date) => Record<string, unknown> };

/** Start of the period containing `now` (periods are `offset + k·every` since the epoch, UTC). */
export const periodStart = (now: number, everyMs: number, offsetMs = 0) => new Date(Math.floor((now - offsetMs) / everyMs) * everyMs + offsetMs);

/** Insert this period's job for every schedule (dedupe `<kind>:<period start>`: a period runs at most once). Periods
 *  without a payload coalesce: no new one while an earlier job of the kind is still queued or running (a busy lane or
 *  a deferred job must not stack a backlog of identical runs). Payload periods (anchor <day>) are distinct work. */
export async function schedule(list: Schedule[], now = Date.now()) {
  for (const s of list) {
    const start = periodStart(now, s.everyMs, s.offsetMs);
    if (!s.payload && (await sql`select 1 from job where kind = ${s.kind} and status in ('queued', 'running') limit 1`).length) continue;
    await enqueue(s.kind, s.payload?.(start) ?? {}, { runAt: start, dedupeKey: `${s.kind}:${start.toISOString()}` });
  }
}
