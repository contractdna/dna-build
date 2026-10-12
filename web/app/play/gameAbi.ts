// A Sequencer game's ABI as the main site's generic game panel (GamePanel.tsx) uses it: which functions it shows, how a
// typed-in argument becomes a call argument, and how a read value reads. Pure: no network, no React (web/test/games).
import { formatEther, isAddress } from "viem";

export type AbiParam = { name?: string; type: string };
export type AbiFn = { type: string; name: string; inputs: AbiParam[]; outputs: AbiParam[]; stateMutability: string };

/** The kit's functions only the Safe, the factory or anyone funding a game calls: never a player's button. */
const KIT_ADMIN = new Set(["fund", "pause", "retire", "sweep"]);
/** The kit's amounts in wei (shown as ETH). */
const WEI = new Set(["freeBalance", "owedTotal", "owed", "reserved"]);
/** One argument the panel can take as typed text: a plain value, no arrays or tuples. */
const PLAIN = /^(u?int\d*|bool|address|bytes\d*|string)$/;

// an overloaded name keeps its first form only (the panel keys and calls functions by name)
const fns = (abi: unknown[]) => (abi as AbiFn[]).filter((f, i, all) => f?.type === "function" && typeof f.name === "string" && all.findIndex((g) => g?.type === "function" && g.name === f.name) === i)
  .map((f) => ({ ...f, inputs: f.inputs ?? [], outputs: f.outputs ?? [] }));
const takes = (f: AbiFn) => f.inputs.every((i) => PLAIN.test(i.type));
const view = (f: AbiFn) => f.stateMutability === "view" || f.stateMutability === "pure";

/** What the panel shows of a game: its state (zero-argument views with one plain output), the reads that need
 *  arguments, and what a player can send (no value, never the kit's admin calls; a retired game only its claim). */
export function panelOf(abi: unknown[], retired: boolean) {
  const all = fns(abi);
  return {
    state: all.filter((f) => view(f) && f.inputs.length === 0 && f.outputs.length === 1 && PLAIN.test(f.outputs[0].type)).slice(0, 24),
    reads: all.filter((f) => view(f) && f.inputs.length > 0 && takes(f) && f.outputs.length > 0 && f.outputs.every((o) => PLAIN.test(o.type))).slice(0, 12),
    actions: all.filter((f) => f.stateMutability === "nonpayable" && !KIT_ADMIN.has(f.name) && takes(f) && (!retired || f.name === "claim")).slice(0, 12),
  };
}

/** Typed text → a call argument of `type`; a string is the reason it can't be. */
export function parseArg(type: string, text: string): { ok: true; value: unknown } | { ok: false; why: string } {
  const t = text.trim();
  if (/^u?int\d*$/.test(type)) {
    if (!/^-?\d{1,78}$/.test(t) || (type.startsWith("u") && t.startsWith("-"))) return { ok: false, why: `${type}: a whole number` };
    return { ok: true, value: BigInt(t) };
  }
  if (type === "bool") return t === "true" || t === "false" ? { ok: true, value: t === "true" } : { ok: false, why: "bool: true or false" };
  if (type === "address") return isAddress(t, { strict: false }) ? { ok: true, value: t } : { ok: false, why: "address: 0x and 40 hex digits" };
  const n = type.match(/^bytes(\d+)$/)?.[1];
  if (n) return new RegExp(`^0x[0-9a-fA-F]{${Number(n) * 2}}$`).test(t) ? { ok: true, value: t } : { ok: false, why: `${type}: 0x and ${Number(n) * 2} hex digits` };
  if (type === "bytes") return /^0x([0-9a-fA-F]{2})*$/.test(t) ? { ok: true, value: t } : { ok: false, why: "bytes: 0x and pairs of hex digits" };
  if (type === "string") return { ok: true, value: text };
  return { ok: false, why: `${type} is not supported here` };
}

/** A read value as text: the kit's amounts in ETH, a timestamp-named value with its UTC date too. */
export function showValue(name: string, v: unknown): string {
  if (typeof v === "bigint") {
    if (WEI.has(name)) return `${formatEther(v)} ETH`;
    if (/(At|Ends|End|Deadline)$/.test(name) && v > BigInt(1_000_000_000) && v < BigInt(10_000_000_000)) {
      return `${v} (${new Date(Number(v) * 1000).toUTCString()})`;
    }
    return v.toString();
  }
  if (Array.isArray(v)) return v.map((x) => showValue("", x)).join(", ");
  return String(v);
}
