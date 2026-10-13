// The engine's hash-chained log (migration 003). Every record goes through the log_append() SQL function.
// Enclave build (migration 006): each record also extends the enclave's OWN chain — ehash = sha256(eprev ‖ sha256(body)),
// eprev = the previous record the enclave signed — and carries esig, the enclave LOG key's signature over logDigest
// (below). The DB chain is transport only: foreign rows (no or a bad esig, or not linking) are
// skipped on load and alerted, never links; anchored roots are enclave-chain heads.
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { type Hex, recoverMessageAddress } from "viem";
import { edb } from "./db.ts";
import { ENCLAVE } from "./enclave.ts";
import { enqueue } from "./jobs.ts";

/** Every kind the database accepts: the rows of log_kinds (migration 014 seeds them; a later migration inserts its
 *  own). A kind added here needs its insert, and a test checks the database has every one. */
export const LOG_KINDS = ["tx", "anchor", "mode", "draft", "alert", "llm", "x_post",
  "observe", "thread", "step", "experiment", "sim", "security", "memory", "epoch", "core", "journal",
  "idea", "report", "autonomy", "research", "intake", "plate", // migration 004
  "tone", // migration 005
  "cycle", "state", // migration 006
  "game", // migration 007
  "announce", // migration 009
  "brain", "approve", "veto", "model-change", // migration 010
  "binding", "reward", // migration 011
  "build", "gates", "ship", "ship-cancel", "retire", "release", "page-kill", "fund", // migration 013
  "self", // migration 014
  "character", // migration 016
  "clone", "leakage", // migration 017
] as const;
export type LogKind = (typeof LOG_KINDS)[number];

import { canonical } from "./canonical.ts";
export { canonical };

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
export const GENESIS = Buffer.alloc(32);
/** hash = sha256(prev || sha256(utf8 body)), exactly what log_append computes (the enclave chain uses the same rule). */
export const chainHash = (prev: Buffer, body: string) => sha256(Buffer.concat([prev, sha256(Buffer.from(body, "utf8"))]));

type Db = postgres.Sql | postgres.TransactionSql;
export type Appended = { seq: string; hash: string; ehash?: string | null };

/** Append one record; `tx` lets a caller append inside its own transaction (state change + record commit together).
 *  Enclave build: always its own transaction, serialized in-process, chained on the enclave's OWN head (never on
 *  whatever the DB says is last): a caller's rollback can't leave the head pointing at nothing, and a row the DB made
 *  up can't become a link. The record hash is recomputed here before the log key signs it (no signing oracle). */
export async function append(kind: LogKind, ref: string | null, body: unknown, tx: Db = edb): Promise<Appended> {
  const text = canonical(body);
  if (!ENCLAVE.on) {
    const [r] = await (tx as postgres.Sql)<Appended[]>`select seq::text, encode(hash, 'hex') as hash from log_append(${kind}, ${ref}, ${text})`;
    return r;
  }
  const run = async (): Promise<Appended> => {
    const eprev = (head ??= await ourHead())?.ehash ?? GENESIS.toString("hex");
    const mine = chainHash(Buffer.from(eprev, "hex"), text).toString("hex");
    const { signDigest, signerAddress } = await import("./signed.ts");
    let r: Appended;
    try {
      r = (await LOG_TX.begin(async (t) => {
        const [r] = await t<Appended[]>`select seq::text, encode(hash, 'hex') as hash, encode(ehash, 'hex') as ehash from log_append(${kind}, ${ref}, ${text}, true, decode(${eprev}, 'hex'))`;
        if (r.ehash !== mine) throw new Error(`enclave log: the DB returned ehash ${r.ehash}, not the ${mine} computed here; refusing to sign`);
        await t`update log set esig = ${await signDigest(logDigest(mine, kind, ref))} where seq = ${r.seq}`;
        return r;
      })) as Appended;
    } catch (e) {
      // the commit may have landed with only its acknowledgement lost: our record (by its ehash, verified) is the head
      const [x] = await edb<(EnclaveRow & Appended)[]>`select seq::text, encode(hash, 'hex') as hash, kind, ref, body, eprev, ehash, esig from log where ehash = decode(${mine}, 'hex')`;
      if (!x || !(await recordOk(x, signerAddress()))) throw e;
      r = { seq: x.seq, hash: x.hash };
    }
    head = { ehash: mine, seq: r.seq };
    noteNewest(kind, ref, r.seq);
    // the disk head follows every record (a tampered newest one can't vanish across a restart). The record is committed:
    // a failed write (disk full) must not fail the append (a caller retry would duplicate it); the heartbeat retries it
    const err = (await import("./head.ts")).persistHead();
    if (err) await enqueue("alert", { text: `Enclave: the disk head could not be written (${err.slice(0, 200)}); agent txs wait, the heartbeat retries.` }, { dedupeKey: `alert:headsync:${new Date().toISOString().slice(0, 13)}` });
    return { seq: r.seq, hash: r.hash, ehash: mine };
  };
  const p = queue.then(run, run);
  queue = p.then(() => undefined, () => undefined);
  return p;
}

let queue: Promise<unknown> = Promise.resolve();
/** The enclave append's transaction (a seam: tests make a commit's acknowledgement go missing). */
export const LOG_TX = { begin: <T>(fn: (t: postgres.TransactionSql) => Promise<T>) => edb.begin(fn) as Promise<T> };

/** Newest seq of the enclave's own records, per kind and per kind:ref: advanced by each append and seeded by the boot
 *  check's walk of the whole chain. The DB can hide or delete rows; a load whose newest verified record is older than
 *  this is a rollback, never "the newest record". */
export const newest = new Map<string, bigint>();
export function noteNewest(kind: string, ref: string | null, seq: string) {
  for (const k of ref === null ? [kind] : [kind, `${kind}:${ref}`]) if ((newest.get(k) ?? -1n) < BigInt(seq)) newest.set(k, BigInt(seq));
}
/** The newest seq the enclave wrote for kind[:ref]: snapshot it BEFORE reading the DB. */
export const newestOf = (kind: string, ref?: string) => newest.get(ref === undefined ? kind : `${kind}:${ref}`);
/** Enclave: is `seq` (the DB's newest verified record of kind[:ref], or none) older than `want` (newestOf, taken before
 *  the read)? Alerted. */
export async function rolledBack(kind: string, ref: string | undefined, seq: string | undefined, want: bigint | undefined) {
  if (!ENCLAVE.on) return false;
  if (want === undefined || (seq !== undefined && BigInt(seq) >= want)) return false;
  await enqueue("alert", { text: `Enclave: the DB hides the newest ${kind}${ref ? ` ${ref}` : ""} record (seq ${want}, it shows ${seq ?? "none"}): treated as no record.` }, { dedupeKey: `alert:rollback:${kind}:${ref ?? ""}:${new Date().toISOString().slice(0, 13)}` });
  return true;
}
export const RolledBack = (what: string) => Object.assign(new Error(`${what}: the DB hides the enclave's newest record`), { rolledBack: true, final: true });
export const isRolledBack = (e: unknown) => !!(e as { rolledBack?: boolean })?.rolledBack;
/** The enclave's own head: set by the boot check, then advanced by each append. */
let head: { ehash: string; seq: string } | undefined;
export const setHead = (h: { ehash: string; seq: string } | undefined) => { head = h; };
export const enclaveHead = () => head;
/** Without a boot check (tests): the newest record that verifies. */
async function ourHead() {
  const { signerAddress } = await import("./signed.ts");
  for (const r of await edb<(EnclaveRow & { seq: string })[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where ehash is not null and esig is not null order by log.seq desc limit 50`) {
    if (await recordOk(r, signerAddress())) return { ehash: r.ehash!.toString("hex"), seq: r.seq };
  }
  return undefined;
}

const LOG_DOMAIN = Buffer.from("dna/log/v1");
const STATE_DOMAIN = Buffer.from("dna/state/v1");
/** What the log key signs for a record: sha256("dna/log/v1" ‖ ehash ‖ sha256(canonical [kind, ref])). kind and ref
 *  are not in the hash chain, so they are bound here: a row relabelled by the DB (an alert as a mode override, one
 *  draft's approval as another's) no longer verifies. */
export const logDigest = (ehash: string | Buffer, kind: string, ref: string | null) =>
  sha256(Buffer.concat([LOG_DOMAIN, typeof ehash === "string" ? Buffer.from(ehash, "hex") : ehash, sha256(canonical([kind, ref]))])).toString("hex");

export type EnclaveRow = { kind: string; ref: string | null; body: string; eprev: Buffer | null; ehash: Buffer | null; esig: string | null };
/** A record of `signer`'s enclave chain: ehash recomputes from (eprev, body) and esig recovers to signer. */
export async function recordOk(r: EnclaveRow, signer: string) {
  if (!r.eprev || !r.ehash || !r.esig) return false;
  if (!chainHash(r.eprev, r.body).equals(r.ehash)) return false;
  try {
    return (await recoverMessageAddress({ message: { raw: `0x${logDigest(r.ehash, r.kind, r.ref)}` }, signature: r.esig as Hex })).toLowerCase() === signer.toLowerCase();
  } catch {
    return false;
  }
}

const untrusted = (what: string) =>
  enqueue("alert", { text: `Enclave: ignored an unsigned, foreign or stale ${what} (DB rows are not trusted).` }, { dedupeKey: `alert:foreign:${what}:${new Date().toISOString().slice(0, 13)}` });

/** Load-side check for a log row (always true in the plain build). */
export async function trustedRecord(r: EnclaveRow, what: string) {
  if (!ENCLAVE.on) return true;
  const { signerAddress } = await import("./signed.ts");
  if (await recordOk(r, signerAddress())) return true;
  await untrusted(what);
  return false;
}

/** Mutable state rows the enclave re-reads (thread runs, state.loop, outbox and mention rows) carry `seq:sig`: each
 *  write first appends a `state` record {digest} for `table:key`, and the log key signs sha256("dna/state/v1" ‖
 *  canonical {table, key, value, seq}). On load the row must be signed AND its seq must be the newest verified `state`
 *  record for that key: an older signed row replayed by the DB is refused. Restrict-only rows (tx, anchor, job,
 *  engine_exec) stay unsigned: forging them can only make the engine wait or refuse. Flags, mute and drafts are read
 *  from the log itself in the enclave (src/mode.ts, src/x.ts, src/telegram.ts). */
export const stateDigest = (table: string, key: string, value: unknown, seq: string) =>
  sha256(Buffer.concat([STATE_DOMAIN, Buffer.from(canonical({ table, key, value, seq }))])).toString("hex");
const valueDigest = (value: unknown) => sha256(canonical(value)).toString("hex");
/** State records being signed now, and when the last one finished: its row is written right after (one statement), so a
 *  process that exits on its own (src/engine.ts stall guard) waits for none in flight and a quiet spell first. */
export const STATE_WRITES = { at: 0, pending: 0 };
export async function stateSig(table: string, key: string, value: unknown) {
  if (!ENCLAVE.on) return null;
  STATE_WRITES.pending++;
  try {
    const rec = await append("state", `${table}:${key}`, { digest: valueDigest(value) });
    return `${rec.seq}:${await (await import("./signed.ts")).signDigest(stateDigest(table, key, value, rec.seq))}`;
  } finally {
    STATE_WRITES.pending--;
    STATE_WRITES.at = Date.now();
  }
}
/** Load-side check for a state row (always true in the plain build); a failure is alerted (hourly per table). */
export async function trusted(table: string, key: string, value: unknown, sig: string | null | undefined) {
  if (!ENCLAVE.on) return true;
  const [seq, s] = (sig ?? "").split(":");
  const ok = !!seq && (await (await import("./signed.ts")).isOurs(stateDigest(table, key, value, seq), s)) && (await newestState(`${table}:${key}`)) === seq;
  if (!ok) await untrusted(`${table} row`);
  return ok;
}
async function newestState(ref: string) {
  const want = newestOf("state", ref); // before the read: an append landing meanwhile is not a rollback
  const { signerAddress } = await import("./signed.ts");
  let seq: string | undefined;
  for (const r of await edb<(EnclaveRow & { seq: string })[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where kind = 'state' and ref = ${ref} order by log.seq desc limit 20`) {
    if (await recordOk(r, signerAddress())) { seq = r.seq; break; }
  }
  return (await rolledBack("state", ref, seq, want)) ? undefined : seq; // an older row the DB resurrected by hiding the newest
}

/** Recompute the chain in seq order. Returns the first broken seq, or the head. The enclave chain (records with an
 *  ehash) is checked too: a record is OURS when its ehash recomputes and its signature recovers to `signer` (default:
 *  the first such record's signer); ours must link linearly (each eprev = the previous of ours: a fork or a rollback
 *  shows here); anything else is foreign: counted and skipped, never a link. */
export async function verify(sql: postgres.Sql, signer?: string) {
  let prev: Buffer = GENESIS;
  let eprev: Buffer = GENESIS;
  let n = 0;
  let foreign = 0;
  let who = signer?.toLowerCase();
  const hashes = new Set<string>();
  const ehashes = new Set<string>();
  for await (const rows of sql<({ seq: string; prev_hash: Buffer; hash: Buffer } & EnclaveRow)[]>`select seq::text, kind, ref, body, prev_hash, hash, eprev, ehash, esig from log order by log.seq`.cursor(1000)) {
    for (const r of rows) {
      n++;
      if (Number(r.seq) !== n) return { ok: false as const, seq: r.seq, error: "gap in seq" };
      if (!r.prev_hash.equals(prev)) return { ok: false as const, seq: r.seq, error: "prev_hash does not link" };
      const h = chainHash(prev, r.body);
      if (!h.equals(r.hash)) return { ok: false as const, seq: r.seq, error: "hash mismatch" };
      hashes.add(`0x${h.toString("hex")}`);
      prev = h;
      if (!r.ehash) continue;
      if (!who && r.eprev && r.esig && chainHash(r.eprev, r.body).equals(r.ehash)) {
        who = (await recoverMessageAddress({ message: { raw: `0x${logDigest(r.ehash, r.kind, r.ref)}` }, signature: r.esig as Hex }).catch(() => "")).toLowerCase() || undefined;
      }
      if (!who || !(await recordOk(r, who))) { foreign++; continue; }
      if (!r.eprev!.equals(eprev)) return { ok: false as const, seq: r.seq, error: "the enclave chain forks or was rolled back (eprev is not the previous enclave record)" };
      ehashes.add(`0x${r.ehash.toString("hex")}`);
      eprev = r.ehash;
    }
  }
  return { ok: true as const, n, head: `0x${prev.toString("hex")}`, hashes, ehashes, enclaveHead: ehashes.size ? `0x${eprev.toString("hex")}` : null, signer: who ?? null, foreign };
}
