// Engine mode: live | dry_run | halted. Effective mode = the more restrictive of env ENGINE_MODE and the DB override.
// Telegram sets the override to dry_run or halted, never live: it can only restrict below the env mode. Only an
// ENGINE_MODE change clears it (and alerts the signers); a restart with the same env keeps it, so a crash never
// un-halts the engine.
// Enclave: the override is read from the enclave's own signed log ('mode' records 'env' / 'override'), never from the
// mutable engine_flags row (an old signed row could be replayed). No record = halted (fail closed); the first enclave
// boot writes an 'env' record that halts until a signer /dryrun or an ENGINE_MODE change.
import { ENV_MODE, type Mode, MODES } from "./config.ts";
import { edb as sql } from "./db.ts";
import { ENCLAVE } from "./enclave.ts";
import { Defer, type Handler } from "./jobs.ts";
import { append, isRolledBack } from "./log.ts";
import { trustedDocs } from "./records.ts";
import { alert } from "./telegram.ts";

export const effective = (env: Mode, override: Mode | null): Mode =>
  override && MODES.indexOf(override) < MODES.indexOf(env) ? override : env;

type ModeRec = { env?: Mode; override?: Mode | null; unsignedFlags?: boolean };
/** Pure: the override the newest verified 'env' / 'override' record implies. No record = halted; an 'env' record clears
 *  the override unless it marks a fresh enclave (unsignedFlags). */
export function overrideOf(env: (ModeRec & { _seq: string }) | undefined, ov: (ModeRec & { _seq: string }) | undefined): Mode | null {
  const last = !env ? ov : !ov ? env : BigInt(ov._seq) > BigInt(env._seq) ? ov : env;
  if (!last) return "halted";
  if (last === ov) return last.override ?? null;
  return last.unsignedFlags ? "halted" : null;
}

export async function initMode() {
  if (ENCLAVE.on) {
    const [e] = await trustedDocs<ModeRec>("mode", "env");
    if (e?.env === ENV_MODE) return;
    // a new ENGINE_MODE clears the override; no verified record at all = a fresh enclave: halted until a signer acts
    await append("mode", "env", { env: ENV_MODE, previousEnv: e?.env ?? null, ...(e ? {} : { unsignedFlags: true }) });
    await sql`insert into engine_flags (id, env_mode, override, updated_by) values (1, ${ENV_MODE}, ${e ? null : "halted"}, 'env')
      on conflict (id) do update set env_mode = excluded.env_mode, override = excluded.override, updated_by = 'env', updated_at = now()`;
    if (e) await alert(`ENGINE_MODE changed to ${ENV_MODE}: any Telegram override was cleared. Effective mode: ${ENV_MODE}.`);
    return;
  }
  const cleared = await sql.begin(async (tx) => {
    const [f] = await tx<{ env_mode: Mode; override: Mode | null }[]>`select env_mode, override from engine_flags for update`;
    if (f?.env_mode === ENV_MODE) return null;
    await tx`insert into engine_flags (id, env_mode, override, updated_by) values (1, ${ENV_MODE}, null, 'env')
      on conflict (id) do update set env_mode = excluded.env_mode, override = null, updated_by = 'env', updated_at = now()`;
    await append("mode", "env", { env: ENV_MODE, previousEnv: f?.env_mode ?? null, clearedOverride: f?.override ?? null }, tx);
    return f?.override ?? null;
  });
  if (cleared) await alert(`ENGINE_MODE changed to ${ENV_MODE}: the Telegram override (${cleared}) was cleared. Effective mode: ${ENV_MODE}.`);
}

export async function getFlags() {
  let override: Mode | null;
  if (ENCLAVE.on) {
    try {
      const [[e], [o]] = await Promise.all([trustedDocs<ModeRec>("mode", "env"), trustedDocs<ModeRec>("mode", "override")]);
      override = overrideOf(e, o);
    } catch (err) {
      if (!isRolledBack(err)) throw err;
      override = "halted"; // the DB hid the newest mode record: never un-halt on its word
    }
  } else {
    const [f] = await sql<{ env_mode: Mode; override: Mode | null }[]>`select env_mode, override from engine_flags`;
    override = f?.override ?? null;
  }
  return { env: ENV_MODE, override, mode: effective(ENV_MODE, override) };
}
export const mode = async () => (await getFlags()).mode;

/** Telegram path: the override is dry_run or halted (never live, never above ENV_MODE in effect). */
export async function setOverride(to: "dry_run" | "halted", by: string) {
  await sql.begin(async (tx) => {
    await tx`update engine_flags set override = ${to}, updated_by = ${by}, updated_at = now()`;
    await append("mode", "override", { override: to, by }, tx); // the enclave reads this record, not the row
  });
  return getFlags();
}

/** Jobs that call a model and don't already wait for live mode themselves (x:send, ideas:intake, ideas:loop,
 *  games:agent, seq:*, plates:tick do), and the mention reader (x:mentions: X bills per mention, and only the reply and
 *  idea jobs read them). Halted: they wait, so a halted engine spends nothing on models or mentions; code-only work
 *  (keepers, observe, the indexer) goes on. dry_run runs them (its cycles are the first real-model test). llm()
 *  refuses while halted too, for any path not listed here. */
export const MODEL_JOBS = ["cycle", "journal", "genesis", "x:scout", "x:mentions", "x:replies", "voice:audit", "ideas:rounds", "x:ct"];
export const HALTED_WAIT_MS = 60_000; // a /dryrun resumes them within a minute; a waiting kind never stacks (jobs.ts schedule)

/** The handlers, with every MODEL_JOBS kind waiting (Defer: no attempt spent, nothing run) while the engine is halted. */
export function waitWhenHalted(handlers: Record<string, Handler>, halted = async () => (await mode()) === "halted"): Record<string, Handler> {
  return Object.fromEntries(Object.entries(handlers).map(([kind, h]) => [kind, !MODEL_JOBS.includes(kind) ? h : {
    lane: h.lane,
    run: async (job) => {
      if (await halted()) throw new Defer(HALTED_WAIT_MS, `engine halted: ${kind} waits (no model calls)`);
      return h.run(job);
    },
  }]));
}
