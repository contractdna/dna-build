// Pure mapping from indexer rows to display values (no runtime imports, so `node --test` runs it: web/test).
import type { Core, FeedEvent } from "../_live/feed";
import type { SeqEvent, SeqStage } from "./types";

type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const ZERO = /^0x0{40}$/i;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const units = (wei: string | number) => Number(BigInt(wei)) / 1e18;
/** ETH with 3 decimals; dust keeps 2 significant digits instead of reading "0.000". */
export const eth = (wei: string | number) => {
  const n = units(wei);
  return n !== 0 && n < 0.001 ? n.toPrecision(2) : n.toFixed(3);
};
/** 18-decimal token amount, compact (1.50M). */
export const compact = (wei: string) => {
  const n = units(wei);
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(2);
};
/** A bytes32 module param as its manifest unit says: pips → percent, x1e4 → multiplier. */
export const fmtParam = (hex: string | undefined, unit?: string) => {
  if (hex === undefined) return "—";
  const v = Number(BigInt(hex));
  return unit === "pips" ? `${(v / 1e4).toFixed(2)}%` : unit === "x1e4" ? `${(v / 1e4).toFixed(1)}×` : String(v);
};

/** Registry ops, in ModuleRegistry.Op order (same names as engine/src/lib.ts OPS). */
export const OPS = ["Register", "SetShadow", "SetCanary", "PromoteActive", "SetParams", "SetAgent", "SetAnchorKey", "SetLevel", "UnpauseAgent", "ApproveCodehash", "RevokeCodehash"];
// ModuleRegistry.Status. Retired (5) is unreachable since plate reuse (displaced modules return to Proposed); the enum
// value only stays for ABI stability, so it reads as proposed here.
export const STATUS = ["proposed", "proposed", "shadow", "canary", "active", "proposed", "rolled_back"] as const;

/** The baseline counts as one module when nothing is Active → max(1, active fee + active split). */
export const activeModules = (route?: { active: string }, split?: { module: string }) =>
  Math.max(1, Number(!!route && !ZERO.test(route.active)) + Number(!!split && !ZERO.test(split.module)));

/** Chain events that reach the feed (same set as engine/src/lib.ts FEED_EVENTS). */
export const FEED_EVENTS = ["StatusChanged", "RolledBack", "CanaryEnded", "Cancelled", "Queued", "LevelSet", "AgentPaused", "Distributed", "Buyback", "LiquidityAdded"];

/** One chain row → one feed event (null = not shown). id `${block}:${logIndex}` doubles as the SSE id. */
export function toFeed(r: { block: number; logIndex: number; at: string; event: string; args: Args }): FeedEvent | null {
  const env = { id: `${r.block}:${r.logIndex}`, at: r.at, block: r.block };
  const a = r.args;
  const chain = (text: string, tone: Core["log"][number]["tone"] = "plain"): FeedEvent => ({ ...env, kind: "chain", text, tone });
  switch (r.event) {
    case "StatusChanged": {
      const to = Number(a.to);
      return to === 2 ? { ...env, kind: "testing" } : to === 3 ? { ...env, kind: "canary" } : to === 4 ? { ...env, kind: "activated" } : null;
    }
    case "RolledBack": return { ...env, kind: "rollback" };
    case "CanaryEnded": return chain(`canary ended · ${short(a.module)} back to proposed`, "alert"); // not a rollback
    case "Cancelled": return chain(`queued op #${a.id} cancelled by the Safe`, "reject");
    case "Queued": return chain(`proposal #${a.id} queued · ${OPS[Number(a.op)] ?? "op"}`);
    case "LevelSet": return chain(`autonomy level ${a.from} → ${a.to}`, Number(a.to) > Number(a.from) ? "good" : "alert");
    case "AgentPaused": return chain(a.paused ? "agent paused by the Safe" : "agent unpaused", "alert");
    case "Distributed": return chain(`fees distributed · ${eth(a.amount)} ETH`);
    case "Buyback": return chain(`buyback ${eth(a.spent)} ETH · burned ${compact(a.burned)} DNA`, "good");
    case "LiquidityAdded": return chain(`auto-liquidity added · ${eth(a.eth)} ETH`);
  }
  return null;
}

/** One engine log record (NOTIFY t:'elog' + its body) → one feed line, or null. Ids `e:<seq>` live only in the JSON
 *  (like head-tier events), so an SSE Last-Event-ID always points into chain_log. `core` records refresh the
 *  snapshot instead (stream route). */
export function elogToFeed(r: { seq: string | number; at: string; kind: string; ref: string | null; doc: Args }): FeedEvent | null {
  const env = { id: `e:${r.seq}`, at: r.at };
  const d = r.doc;
  const line = (text: string, tone: Core["log"][number]["tone"] = "plain"): FeedEvent => ({ ...env, kind: "chain", text, tone });
  switch (r.kind) {
    case "step": return d.kind === "hypothesis" ? { ...env, kind: "testing" } : line(`${String(d.agent).toLowerCase()} · ${d.kind === "evidence+" ? "evidence for" : d.kind === "evidence-" ? "evidence against" : d.kind}`, d.kind === "counter" ? "alert" : "plain");
    case "sim": return line(`simulation completed · ${d.id} (uncalibrated)`);
    case "memory": return d.decision === "accepted" ? line(`memory #${d.id} · accepted`, "good") : { ...env, kind: "rejected" };
    case "security": return line(`red-team finding ${d.id} · ${d.severity}`, "alert");
    case "journal": return d.pulse ? line(`pulse · ${String(d.summary).slice(0, 140)}`) : line(`journal day ${d.day} published`);
    case "observe": return line(`observed block ${Number(d.block).toLocaleString("en-US")} · ${d.feeSwaps} swaps in 24 h · volatility ${d.realizedVolPct}%`);
    case "research": return line("research completed (untrusted sources)");
    case "report": return line(`idea round ${d.round} report published`);
    case "anchor": return d.mode === "live" ? line(`log anchored on-chain · ${d.day}`, "good") : null;
    case "plate": return d.event === "stage" && d.to ? line(`experiment ${d.run} · ${String(d.to).replace("_", " ")}`) : null;
  }
  return null;
}

/** The Sequencer's announcement types, in story order (engine/src/announce.ts SeqFacts). */
export const SEQ_STAGES: readonly SeqStage[] = ["seq_online", "seq_started", "seq_building", "seq_pr", "seq_verdict", "seq_shipped", "seq_killed", "game_retired", "seq_nothing_today"];
/** An engine `announce` record → one Sequencer feed step (null for any other announcement). */
export function toSeqEvent(doc: { type: string; title: string; at: string; facts?: Args }): SeqEvent | null {
  if (!SEQ_STAGES.includes(doc.type as SeqStage)) return null;
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  // record: the signed log record's seq (GET /api/log/<seq>); anything else is not a public link
  const rec = s(doc.facts?.record);
  return { at: doc.at, stage: doc.type as SeqStage, build: s(doc.facts?.build), text: doc.title, record: rec && /^\d{1,18}$/.test(rec) ? rec : null };
}
