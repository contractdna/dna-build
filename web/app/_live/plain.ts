// Feed lines (feed.ts reduce + _data/chain.ts toFeed/elogToFeed) → plain sentences for /live. Pure, so test/plain.test.mjs runs it.
// Wording states only what the event says: StatusChanged/RolledBack carry no module kind or cause, so they stay neutral.
import type { Core } from "../_data/types";

const RULES: [RegExp, string][] = [
  [/^analyzed (\d+) swaps$/, "Read $1 new trades"],
  [/^detected MEV pattern$/, "Spotted a likely bot trade (MEV) and noted it"],
  [/^testing new configuration$/, "Started testing a new idea. Nothing is charged while it is tested"],
  [/^simulation completed · (.+)$/, "Replayed past trades to test the idea: $1"],
  [/^simulation completed$/, "Replayed past trades to test the idea"],
  [/^candidate rejected$/, "Rejected the idea. The reason is kept in memory"],
  [/^canary deployment started$/, "A live test started on a slice of blocks"],
  [/^module activated$/, "A module was promoted to active after its 1 h queue"],
  [/^rollback executed$/, "A test was stopped and the previous setting restored at once"],
  [/^epoch (\d+) began$/, "A new chapter began (epoch $1)"],
  [/^canary ended · .+$/, "A live test was ended early. The module went back to the queue"],
  [/^queued op #(\d+) cancelled by the Safe$/, "The Safe cancelled queued change #$1"],
  [/^proposal #(\d+) queued · (.+)$/, "Queued change #$1 ($2). It waits 1 hour in public before it can run"],
  [/^autonomy level (\d+) → (\d+)$/, "Autonomy level changed from $1 to $2"],
  [/^agent paused by the Safe$/, "The Safe paused the AI"],
  [/^agent unpaused$/, "The Safe let the AI resume"],
  [/^fees distributed · (.+) ETH$/, "Shared out $1 ETH of fees"],
  [/^buyback (.+) ETH · burned (.+) DNA$/, "Bought back DNA with $1 ETH and burned $2 DNA"],
  [/^auto-liquidity added · (.+) ETH$/, "Added $1 ETH of liquidity to the pool"],
  [/^red-team · counter$/, "The red team argued against the idea"],
  [/^(\S+) · evidence for$/, "The $1 agent found evidence for the idea"],
  [/^(\S+) · evidence against$/, "The $1 agent found evidence against the idea"],
  [/^(\S+) · decision$/, "The $1 agent recorded a decision"],
  [/^(\S+) · confidence$/, "The $1 agent updated its confidence"],
  [/^(\S+) · next$/, "The $1 agent set its next step"],
  [/^experiment (\S+) · (.+)$/, "Experiment $1 moved to: $2"],
  [/^memory #(\d+) · accepted$/, "Kept the idea and wrote it to memory (#$1)"],
  [/^red-team finding (\S+) · (\w+)$/, "The red team logged a $2-severity finding ($1)"],
  [/^journal day (\d+) published$/, "Published its journal for day $1"],
  [/^pulse · (.+)$/, "Update: $1"],
  [/^observed block (\S+) · (\d+) swaps in 24 h · volatility (.+)%$/, "Checked the market at block $1: $2 trades in 24 hours, volatility $3%"],
  [/^log anchored on-chain · (.+)$/, "Anchored its log for $1 on-chain"],
];

/** One feed line as a sentence. Unknown lines keep their words; every line is capitalised and ends with a full stop. */
export function sentence(text: string): string {
  const rule = RULES.find(([re]) => re.test(text));
  const t = rule ? text.replace(rule[0], rule[1]) : text;
  const out = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

/** The AI's state in plain words. */
export const STATE: Record<Core["state"], { now: string; detail: string }> = {
  observing: { now: "Watching the market", detail: "No test running. The current fee applies to every trade." },
  testing: { now: "Testing a new fee idea", detail: "Simulated on past trades, or run in shadow on real trades, never charged." },
  canary: { now: "Test fee running", detail: "A new fee charges real trades on 1 in 6 blocks, never more than 1 point from the current fee. It can be stopped at once." },
  rollback: { now: "Test stopped", detail: "A test was stopped and the previous setting restored at once." },
};
