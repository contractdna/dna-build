// /sequencer "Right now" strip: real feed lines (core.log, the same lines /live shows) → a short label and the box on
// the map they belong to. Only chain events count (id `${block}:${logIndex}`): swap counts and engine notes stay on /live.
// Pure, so web/test/sequencer.test.mjs runs it.
import { sentence } from "../_live/plain.ts";
import type { Core } from "../_data/types";
import type { NodeId } from "./graph.ts";

export type Line = Core["log"][number];

const RULES: [RegExp, string, NodeId][] = [
  [/^proposal #(\d+) queued · (\w+)$/, "Change #$1 queued ($2), waits the public hour", "gate"],
  [/^queued op #(\d+) cancelled by the Safe$/, "The Safe cancelled change #$1", "safe"],
  [/^testing new configuration$/, "Shadow test started", "shadow"],
  [/^canary deployment started$/, "Live test started", "livetest"],
  [/^canary ended · .+$/, "Live test ended early", "livetest"],
  [/^module activated$/, "Module promoted to active", "livehook"],
  [/^rollback executed$/, "Rolled back to the previous setting", "livehook"],
  [/^autonomy level (\d+) → (\d+)$/, "Autonomy level $1 → $2", "safe"],
  [/^agent paused by the Safe$/, "The Safe paused the AI", "safe"],
  [/^agent unpaused$/, "The AI resumed", "safe"],
  [/^fees distributed · (.+) ETH$/, "Fees split · $1 ETH", "fee"],
  [/^buyback (.+) ETH · burned (.+) DNA$/, "Bought back with $1 ETH · burned $2 DNA", "burn"],
  [/^auto-liquidity added · (.+) ETH$/, "Liquidity added · $1 ETH", "lp"],
];

/** One feed line → its short label and map box (unknown: the /live sentence, no box). */
export function label(text: string): { text: string; node: NodeId | null } {
  const r = RULES.find(([re]) => re.test(text));
  return r ? { text: text.replace(r[0], r[1]), node: r[2] } : { text: sentence(text), node: null };
}

const CHAIN = /^(\d+):(\d+)$/;
const pos = (l: Line) => (String(l.id).match(CHAIN) ?? []).slice(1).map(Number);

/** The newest `n` chain events across what was kept and the latest log, oldest first (the log keeps only 6 lines and
 *  swap counts push chain events out of it, so the strip keeps its own). */
export function latest(kept: Line[], log: Line[], n = 3): Line[] {
  const byId = new Map<string, Line>();
  for (const l of [...kept, ...log]) if (CHAIN.test(String(l.id))) byId.set(String(l.id), l);
  return [...byId.values()].sort((a, b) => {
    const [ab, ai] = pos(a), [bb, bi] = pos(b);
    return ab - bb || ai - bi;
  }).slice(-n);
}
