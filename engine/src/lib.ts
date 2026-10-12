// Pure helpers for the indexer (unit-tested in test/lib.test.ts).
import { decodeAbiParameters, encodeAbiParameters, parseEventLogs, type Address, type Hex, type Log } from "viem";
import { gameFactoryAbi, gameKitAbi } from "./abi.ts";

/** One finalized log as stored in chain_log. bigint args become decimal strings (jsonb has no bigint). */
export type Row = {
  block: number;
  log_index: number;
  tx: string;
  block_hash: string;
  at: Date;
  address: string;
  event: string;
  args: Record<string, unknown>;
};

/** JSON-safe copy: bigint → decimal string, recursively. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

/** A decoded log → its chain_log row. viem decodes an event with no arguments (GameKit's Retired()) to args undefined:
 *  it stores {} (args is jsonb not null; an undefined would fail the window's insert on every tick). */
export function logRow(l: Log & { eventName: string; args?: unknown }, at: Date): Row {
  const args = jsonSafe(l.args ?? {}) as Record<string, unknown>;
  if (l.eventName === "Queued") Object.assign(args, decodeQueued(Number(args.op), args.data as Hex));
  return { block: Number(l.blockNumber), log_index: l.logIndex!, tx: l.transactionHash!, block_hash: l.blockHash!, at, address: l.address.toLowerCase(), event: l.eventName, args };
}

/** Next getLogs range: [from, min(from + window - 1, last)]. */
export function nextRange(from: bigint, last: bigint, window: bigint): { from: bigint; to: bigint } {
  const to = from + window - 1n;
  return { from, to: to < last ? to : last };
}

/** Provider errors that mean "ask for a smaller range" (Alchemy, dRPC, geth, erigon wordings, and viem's own cap on a
 *  response body). Anything else (rate limits included: "exceeded its compute units", "capacity limit exceeded") is
 *  retried from the same cursor next tick. */
export function isRangeError(e: unknown): boolean {
  const msg = `${(e as { details?: string })?.details ?? ""} ${(e as Error)?.message ?? ""}`;
  return /block range|range (is )?too (large|wide)|ranges? over|max results|too many (results|logs)|more than \d+ (results|logs)|response size|response body exceeded|limited to a|query timeout/i.test(msg);
}

/** ModuleRegistry.Op in enum order → abi types of its `data` (ModuleRegistry._apply). A new op is one line here. */
export const OP_TABLE = [
  ["Register", ["address", "uint8", "bytes32", "bytes32[4]", "bytes32[4]", "bytes32[4]"]],
  ["SetShadow", ["address"]],
  ["SetCanary", ["address", "uint64", "uint32", "uint32"]],
  ["PromoteActive", ["address"]],
  ["SetParams", ["address", "bytes32[4]"]],
  ["SetAgent", ["address"]],
  ["SetAnchorKey", ["address"]],
  ["SetLevel", ["uint8"]],
  ["UnpauseAgent", []],
  ["ApproveCodehash", ["bytes32", "uint8", "bytes32[4]", "bytes32[4]"]],
  ["RevokeCodehash", ["bytes32"]],
] as const;
// endCanary() and rollback(kind) are immediate registry calls, not queued ops: they are not in this table.
export type OpName = (typeof OP_TABLE)[number][0];
export const OPS = OP_TABLE.map(([n]) => n);
/** Ops only the Safe may queue (in no agent level bitmap): the engine never sends them with the agent key. */
export const SAFE_ONLY_OPS: readonly OpName[] = ["SetAgent", "SetAnchorKey", "SetLevel", "UnpauseAgent", "ApproveCodehash", "RevokeCodehash"];

/** `registry.queue(op, data)` arguments for a named op. */
export function encodeOp(name: OpName, args: readonly unknown[]): { op: number; data: Hex } {
  const op = OPS.indexOf(name);
  const types = OP_TABLE[op][1];
  if (args.length !== types.length) throw new Error(`${name} takes ${types.length} args`);
  return { op, data: encodeAbiParameters(types.map((type) => ({ type })), args as never) };
}

/** Decoded op for alerts; unknown op index or malformed data → raw. */
export function decodeOp(op: number, data: Hex): { name: string; args: unknown[] } {
  const row = OP_TABLE[op];
  if (!row) return { name: `op ${op}`, args: [data] };
  try {
    return { name: row[0], args: [...decodeAbiParameters(row[1].map((type) => ({ type })), data)] };
  } catch {
    return { name: row[0], args: [data] };
  }
}

/** What a Queued op targets, decoded from its `data` (see ModuleRegistry._apply encodings). */
export function decodeQueued(op: number, data: Hex): { target?: string; level?: number } {
  try {
    if (op <= 6) return { target: decodeAbiParameters([{ type: "address" }], data)[0] }; // every module/role op leads with an address
    if (op === 7) return { level: Number(decodeAbiParameters([{ type: "uint8" }], data)[0]) };
    if (op === 9 || op === 10) return { target: decodeAbiParameters([{ type: "bytes32" }], data)[0] }; // codehash ops lead with it
  } catch { /* malformed data still queued on-chain; show the raw bytes */ }
  return {};
}

/** Chain events that reach the live feed. Swaps and blocks come only from the head tier (no double emission). */
export const FEED_EVENTS = new Set(["StatusChanged", "RolledBack", "CanaryEnded", "Cancelled", "Queued", "LevelSet", "AgentPaused", "Distributed", "Buyback", "LiquidityAdded"]);
export const NOTIFY_WINDOW_MS = 5 * 60_000;

/** Notify only fresh rows: a backfill of old blocks must not replay history into every open stream. `tip` is the
 *  finalized block's time in ms, NOT the wall clock: mainnet finalized lags ~13 min, so wall-clock freshness would
 *  never pass. */
export const notifiable = (r: Row, tip: number) => FEED_EVENTS.has(r.event) && r.at.getTime() > tip - NOTIFY_WINDOW_MS;

/** NOTIFY payload for a chain row (Postgres caps payloads at 8000 bytes; args are dropped if they don't fit). */
export function feedPayload(r: Row): string {
  const p = { t: "log", block: r.block, logIndex: r.log_index, at: r.at.toISOString(), event: r.event, args: r.args };
  const s = JSON.stringify(p);
  return s.length < 7900 ? s : JSON.stringify({ ...p, args: {} });
}

// The Sequencer's games: the factory's events, then every game's kit events (Played, Funded, Claimed, Retired, Swept,
// ...). The games are the ones the factory deployed: those already indexed (`known`) plus any deployed in this same
// range (read first), so a game's first plays are never missed. A game's own events beyond the kit's are not decoded.
const gameAbi = [...gameFactoryAbi, ...gameKitAbi].filter((x) => x.type === "event");
export async function gameLogs(factory: Address, fromBlock: bigint, toBlock: bigint,
  getLogs: (a: { address: Address | Address[]; fromBlock: bigint; toBlock: bigint }) => Promise<Log[]>, known: () => Promise<Address[]>) {
  const fac = parseEventLogs({ abi: gameAbi, logs: await getLogs({ address: factory, fromBlock, toBlock }) });
  const fresh = fac.filter((l) => l.eventName === "GameDeployed").map((l) => (l.args as { game: Address }).game.toLowerCase() as Address);
  const games = [...new Set([...(await known()).map((g) => g.toLowerCase() as Address), ...fresh])];
  const kit = games.length ? parseEventLogs({ abi: gameAbi, logs: await getLogs({ address: games, fromBlock, toBlock }) }) : [];
  return [...fac, ...kit];
}
