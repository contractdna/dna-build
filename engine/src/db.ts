import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

export const pool = (max: number) => postgres(process.env.DATABASE_URL ?? "postgres://localhost/dna", { max, onnotice: () => {} });
// The indexer is the single writer: one connection, so per-window transactions and NOTIFYs are strictly ordered.
export const sql = pool(1);
// The engine runs jobs concurrently (postgres.js connects lazily: the indexer never opens this pool).
export const edb = pool(Number(process.env.PG_MAX ?? 10));

const LOCK = 0x4d4f5250; // 'MORP': serializes writers (a second indexer replica waits instead of interleaving)
export const lock = (tx: postgres.TransactionSql) => tx`select pg_advisory_xact_lock(${LOCK})`;

/** Applies migrations/*.sql in name order, each once, each in its own transaction. */
export async function migrate() {
  const dir = new URL("../migrations/", import.meta.url);
  await sql`create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())`;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await sql.begin(async (tx) => {
      await lock(tx);
      if ((await tx`select 1 from _migrations where name = ${name}`).length) return;
      await tx.unsafe(readFileSync(new URL(name, dir), "utf8"));
      await tx`insert into _migrations (name) values (${name})`;
      console.log("migrated", name);
    });
  }
}
