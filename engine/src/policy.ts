// Agent-loop policy: the published, deterministic knobs (env-overridable). Everything an LLM proposes is clamped or
// gated by these; none of them can be changed by a model. Shown on /lab as the gate list.
// The thresholds (POLICY_*, GATE_*, KILL_*, MIN_*_SAMPLES) can also come as one POLICY_THRESHOLDS JSON blob: in the
// enclave that blob's sha256 is a compose literal (commit-reveal), revealed when rotated.
import { thresholds } from "./enclave.ts";
import { model } from "./models.ts";

export const THRESHOLD_KEYS = ["POLICY_BASE_MIN", "POLICY_BASE_MAX", "POLICY_MULT_MIN", "POLICY_MULT_MAX", "POLICY_CAP_MIN", "POLICY_CAP_MAX",
  "GATE_EPS", "GATE_MIN_REVENUE_LIFT", "GATE_MIN_RETENTION", "GATE_MAX_CAP_SHARE", "GATE_MIN_SWAPS", "GATE_MAX_GAS_DELTA",
  "KILL_MAX_CAP_SHARE", "KILL_MIN_RETENTION", "KILL_WINDOW_HOURS", "KILL_MIN_SWAPS", "MIN_SHADOW_SAMPLES", "MIN_CANARY_SAMPLES"] as const;
const env: Record<string, string | undefined> = { ...process.env, ...thresholds(process.env.POLICY_THRESHOLDS, THRESHOLD_KEYS) };
const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));
const H = 3600_000;

/** Engine policy bounds for AdaptiveFee [base pips, multiplier ×1e4, cap pips], intersected with each plate's
 *  registered bounds (contracts/SPEC.md §3.1: fee 1%–3.5%; plates A/B/C at 0.3×/1.0×/1.8× with multiplier bounds
 *  1,000–18,000). The multiplier floor defers to the plate's registered minimum. */
export const POLICY = {
  base: [num(env.POLICY_BASE_MIN, 10_000), num(env.POLICY_BASE_MAX, 30_000)],
  mult: [num(env.POLICY_MULT_MIN, 0), num(env.POLICY_MULT_MAX, 18_000)],
  cap: [num(env.POLICY_CAP_MIN, 10_000), num(env.POLICY_CAP_MAX, 35_000)],
} as const;

/** Candidate gates (before any registry op): the objective is project-fee ETH/day to the vaults, with guardrails. */
export const GATES = {
  eps: [0.5, 1, 2] as const, // published elasticity assumptions: volume ∝ (f_new / f_old)^−ε on the total fee
  gateEps: num(env.GATE_EPS, 1), // the ε the revenue + retention gates are judged at
  minRevenueLift: num(env.GATE_MIN_REVENUE_LIFT, 0), // candidate project ETH/day ≥ baseline × (1 + lift)
  minRetention: num(env.GATE_MIN_RETENTION, 0.9), // swap-count retention vs the trailing window
  maxCapShare: num(env.GATE_MAX_CAP_SHARE, 0.3), // share of swaps charged at the cap (time at cap ≤ Y%)
  minSwaps: num(env.GATE_MIN_SWAPS, 20), // fewer recorded swaps than this: no candidate (nothing to judge)
  // replay: max extra gas per swap with the candidate canary. Not a module-gas measure (the hook caps the module call at
  // 40k and a breach shows as ModuleFailed): it also carries cold reads and price-path differences, so it bounds cost only
  maxGasDelta: num(env.GATE_MAX_GAS_DELTA, 100_000),
};

/** Canary kill conditions (deterministic, indexable; mirrored in modules/adaptive-fee-v1.json). */
export const KILL = {
  maxCapShare: num(env.KILL_MAX_CAP_SHARE, 0.3),
  minRetention: num(env.KILL_MIN_RETENTION, 0.7),
  windowHours: num(env.KILL_WINDOW_HOURS, 1), // judged every tick (10 min), every cycle and on every watcher event
  minSwaps: num(env.KILL_MIN_SWAPS, 10),
};

/** State-machine timings and the canary schedule. A stage ends on time AND on data: short of its minimum samples it
 *  is extended in 1 h steps up to 3× its length, then closed as "insufficient data" (never passed on missing data).
 *  One experiment ≈ 1 h queue + 2 h shadow + 1 h queue + 4 h canary ≈ 8 h. */
export const TIMING = {
  shadowMs: num(env.SHADOW_HOURS, 2) * H,
  canaryMs: num(env.CANARY_HOURS, 4) * H,
  promoteWaitMs: num(env.PROMOTE_WAIT_HOURS, 13) * H, // L5: signers have 12 h to queue PromoteActive + its 1 h delay
  extendStepMs: H, // a stage short of samples is re-checked in 1 h steps …
  maxStretch: 3, // … up to 3× its length
  minShadowSamples: num(env.MIN_SHADOW_SAMPLES, 5), // ShadowFee events from the plate (the hook samples 1 swap in 10)
  minCanarySamples: num(env.MIN_CANARY_SAMPLES, 10), // fee-paying swaps inside the canary window
  canaryPeriod: num(env.CANARY_PERIOD_BLOCKS, 600), // canary 100 of every 600 blocks
  canaryLen: num(env.CANARY_LEN_BLOCKS, 100), // ≥ 50 (MIN_CANARY_WINDOW), < period
  // research (Grok + web_search/x_search) runs only on a trigger, at most once per researchMinMs: a volatility-regime
  // change, new X mentions, a closed idea round, or a stale (researchEveryMs) result
  researchMinMs: num(env.RESEARCH_MIN_HOURS, 1) * H,
  researchEveryMs: num(env.RESEARCH_EVERY_HOURS, 24) * H,
};

/** Daily maxima (UTC day) and the agent's own pending-op ceiling (the registry allows 8). The engine never sends an
 *  agent rollback (breaker rollbacks are the keeper's permissionless call; the registry caps agent rollbacks at 3/day). */
// the registry would revert a SetCanary outside these (MIN_CANARY_WINDOW 50, len < period): refuse to start instead
if (!(Number.isInteger(TIMING.canaryLen) && Number.isInteger(TIMING.canaryPeriod) && TIMING.canaryLen >= 50 && TIMING.canaryPeriod > TIMING.canaryLen)) {
  throw new Error(`CANARY_LEN_BLOCKS (${TIMING.canaryLen}) must be an integer ≥ 50 and < CANARY_PERIOD_BLOCKS (${TIMING.canaryPeriod})`);
}
/** Startup validation of the hours-based timings (a typo must not silently become NaN or a zero-length canary).
 *  `minDelayMs`: the registry's MIN_DELAY (1 h; loop.ts re-checks with the value read from the contract). */
export function checkTimings(t = TIMING, k = KILL, minDelayMs = H) {
  const bad: string[] = [];
  const nonNeg = (name: string, x: number) => { if (!Number.isFinite(x) || x < 0) bad.push(`${name} must be a number ≥ 0 (got ${x})`); };
  nonNeg("SHADOW_HOURS", t.shadowMs / H); nonNeg("CANARY_HOURS", t.canaryMs / H);
  if (!(t.promoteWaitMs > minDelayMs)) bad.push(`PROMOTE_WAIT_HOURS must be > the registry MIN_DELAY (${minDelayMs / H} h): the Safe needs time to queue PromoteActive (got ${t.promoteWaitMs / H})`);
  if (!(k.windowHours > 0)) bad.push(`KILL_WINDOW_HOURS must be > 0 (got ${k.windowHours})`);
  for (const [n, x] of [["MIN_SHADOW_SAMPLES", t.minShadowSamples], ["MIN_CANARY_SAMPLES", t.minCanarySamples], ["KILL_MIN_SWAPS", k.minSwaps]] as const) {
    if (!Number.isInteger(x) || x < 0) bad.push(`${n} must be an integer ≥ 0 (got ${x})`);
  }
  if (t.shadowMs === 0 && t.minShadowSamples > 0) bad.push("SHADOW_HOURS 0 needs MIN_SHADOW_SAMPLES 0 (no time to collect samples)");
  if (t.canaryMs === 0 && t.minCanarySamples > 0) bad.push("CANARY_HOURS 0 needs MIN_CANARY_SAMPLES 0");
  return bad;
}
const timingErrors = checkTimings();
if (timingErrors.length) throw new Error(timingErrors.join("; "));

// One experiment at a time: it queues 4 ops (SetParams + SetShadow, SetCanary, PromoteActive/SetParams) and takes
// ≥ 8 h, so at most 3 a day = 12 queue ops; anything above that is churn (e.g. the Safe cancelling and the loop
// re-queueing) and waits for tomorrow. redteamPerDay bounds a loop that alternates candidates.
export const LIMITS = {
  agentQueueOps: num(env.MAX_AGENT_QUEUE_PER_DAY, 12),
  redteamPerDay: num(env.MAX_REDTEAM_PER_DAY, 12),
  intakePerRound: 16, // IdeaMarket MAX_AGENT_IDEAS
  agentPending: num(env.MAX_AGENT_PENDING, 2),
};

/** The public rubric the brain scores build ideas by (0-5 each, total 0-20): the Sequencer's build queue order. */
export const RUBRIC = {
  value: "how much players or holders would want it",
  fit: "fits every rule and limit here and can be tested by the listed gates",
  clarity: "the spec says exactly what to build",
  originality: "new for DNA, not a copy of something it already has",
} as const;
/** Idea rewards: an unbound X author (or a reward with no room under the caps) waits this long, then the reward is
 *  dropped and the money stays in the reserve. */
export const REWARD_HOLD_DAYS = 30;

/** Model ids per job, from the public registry (models.json; src/models.ts). */
export const MODELS = {
  grok: model("main"), // Main: hypothesis + go/no-go
  research: model("research"), // web + X search (xAI direct)
  voice: model("x-voice"), // X writer
  scout: model("x-scout"), // X tone scout: X search (xAI direct)
  audit: model("x-audit"), // weekly voice audit of our own posts (a model other than the writer's)
  // simplification: the post judge runs on the audit role's model (a model other than the writer's); its own registry
  // role once it has a tryout set
  judge: model("x-audit"),
  narrate: model("narrate"), // routine narration: monitor notes, lessons, journal text
  redteam: model("redteam"),
  redteamGate: model("gate"), // before SetCanary and before a PromoteActive request
};

export type Vector = [number, number, number];
type Bounds = { min: readonly bigint[] | readonly number[]; max: readonly bigint[] | readonly number[] };

/** A vector the clamp would change is not the one people voted or sealed: refuse rather than run another. */
export const boundsIssue = (v: Vector, clamped: Vector) => (v.some((x, i) => x !== clamped[i]) ? "outside the plate's bounds" : null);

/** Clamp a proposed vector into policy ∩ registered plate bounds; cap ≥ base (else the cap binds and base is moot). */
export function clampVector(v: Vector, plate?: Bounds): Vector {
  const lim = (i: 0 | 1 | 2, x: number) => {
    const p = [POLICY.base, POLICY.mult, POLICY.cap][i];
    const lo = Math.max(p[0], plate ? Number(plate.min[i]) : -Infinity);
    const hi = Math.min(p[1], plate ? Number(plate.max[i]) : Infinity);
    if (lo > hi) throw new Error(`policy and plate bounds don't overlap for param ${i}`);
    return Math.min(hi, Math.max(lo, Math.round(Number.isFinite(x) ? x : lo)));
  };
  const base = lim(0, v[0]);
  const mult = lim(1, v[1]);
  const cap = lim(2, Math.max(v[2], base));
  return [Math.min(base, cap), mult, cap];
}
