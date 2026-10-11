// Shared by the staging runs (scripts/stage-*.ts): the production code against the REAL external services, with nothing
// public and nothing written anywhere but the run's own output directory (stage/out/, gitignored).
//  - guardEnv: refuses to start with a wallet key, a signing or seal key, a database URL, or a token the run does not
//    need (it names the variable, never the value); forces ENGINE_MODE=dry_run and the pre-launch config (no deployment).
//  - memLedger: model calls are booked in memory (src/llm.ts useLedger) under a hard budget: a call whose worst case
//    would cross it is refused before it is made.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallRow, Spend } from "../src/llm.ts";

export const die = (name: string, msg: string): never => { console.error(`${name}: ${msg}`); process.exit(2); };

// ^PG: libpq-style variables (PGHOST, PGPASSWORD, …) the database client would also read
const FORBIDDEN = /PRIVATE_KEY|MNEMONIC|SIGNING_KEY|SEAL_KEY|DATABASE_URL|^PG|^X_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN)$|^TELEGRAM_BOT_TOKEN$|^STUDIO_TOKEN$/;
/** A database nobody listens on: a query a staging run should never make fails loudly instead of finding a local one. */
export const REFUSED_DB = "postgres://127.0.0.1:1/refused";
/** Exit 2 if the env holds anything that can write somewhere this run must not (`allow`: names the run needs). */
export function guardEnv(name: string, allow: string[] = []) {
  const bad = Object.keys(process.env).filter((k) => process.env[k] && FORBIDDEN.test(k) && !allow.includes(k)).sort();
  if (bad.length) die(name, `refusing to run with ${bad.join(", ")} set: a staging run has no database, wallet or tokens it does not need. Unset them.`);
  Object.assign(process.env, { ENGINE_MODE: "dry_run", LLM_MODE: "live", ENGINE_PRELAUNCH: "1", DATABASE_URL: REFUSED_DB });
}

/** The run's output directory (created): `out`, else stage/out/<name>-<UTC>. */
export function outDir(name: string, out?: string) {
  const dir = out ?? join(new URL("../stage/out/", import.meta.url).pathname, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
export const writeJson = (dir: string, file: string, v: unknown) => writeFileSync(join(dir, file), `${JSON.stringify(v, null, 2)}\n`);

export type Booked = CallRow & { at: string };
/** Book model calls in memory under `budgetUsd`. Call before the first model call. */
export async function memLedger(budgetUsd: number) {
  const { useLedger } = await import("../src/llm.ts");
  const calls: Booked[] = [];
  const alerts: string[] = [];
  const spent = () => calls.reduce((n, c) => n + c.costUsd, 0);
  useLedger({
    spend: async (): Promise<Spend> => {
      const by: Record<string, number> = {};
      for (const c of calls) by[c.budget] = (by[c.budget] ?? 0) + c.costUsd;
      return { total: spent(), by, real: by, month: { total: spent(), by } };
    },
    record: async (r) => { calls.push({ ...r, at: new Date().toISOString() }); },
    alert: async (text) => { alerts.push(text); },
    refuse: (s, est) => (s.total + est > budgetUsd ? `staging budget $${budgetUsd} (spent $${s.total.toFixed(4)}, this call's worst case $${est.toFixed(4)})` : null),
  });
  return { calls, alerts, spent };
}

/** Local fakes for --dry (no network): the engine's fake APIs with synthetic model answers; points every base URL at them. */
export async function dryFakes() {
  const { startFakes } = await import("./fakes.ts");
  const { synthetic } = await import("./synthetic.ts");
  const fakes = await startFakes();
  fakes.llm.xai = (b) => synthetic("xai", b);
  fakes.llm.anthropic = (b) => synthetic("anthropic", b);
  Object.assign(process.env, { OPENROUTER_API_BASE: fakes.url, XAI_API_BASE: fakes.url, OPENAI_API_BASE: fakes.url, TELEGRAM_API_BASE: fakes.url, X_API_BASE: fakes.url });
  return fakes;
}
