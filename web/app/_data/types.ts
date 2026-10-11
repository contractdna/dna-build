// Domain types shared by every page. Each mirrors a planned on-chain contract or engine record (contracts/SPEC.md).
// Conventions: hex values are full length (format with `short()` from _ui/ui), times are ISO 8601 UTC
// (format with `fmtDate`/`fmtTime`), ids are unique keys. Amounts are display strings: pages render them and never parse them.

export type Hex = `0x${string}`;

/** ModuleRegistry lifecycle (SPEC §3). */
export type ModuleStatus = "proposed" | "shadow" | "canary" | "active" | "rolled_back" | "rejected"; // no "retired": displaced plates return to proposed
export type Risk = "low" | "medium" | "high";

export type Module = {
  id: string;               // unique registry key "<name>@<version>" (use as React key)
  // name = module family, version = release
  name: string;
  version: string;          // "v3"
  kind: "FeePolicy" | "SplitPolicy";
  status: ModuleStatus;
  address: Hex;
  codeHash: Hex;
  author: string;           // "DNA" | contributor handle
  review: "internal" | "community" | "none";
  risk: Risk;
  canaryShare: number;      // % of blocks in canary windows (0 when not canary)
  killConditions: string[];
  params: { key: string; value: string; bounds: string }[];
  registeredBlock: number;
  summary: string;
};

/** Engine reasoning thread (/mind). Every step is a hash-chained log record. */
export type Agent = "Research" | "Market" | "Risk" | "Red-team" | "Treasury" | "Simulation" | "Main";
export type ThreadStep = {
  id: string;
  kind: "hypothesis" | "evidence+" | "evidence-" | "counter" | "confidence" | "decision" | "next";
  agent: Agent;
  model: string;            // pinned model id
  text: string;
  ref?: string;             // "sim #8421", "block 26,131,552"
  value?: number;           // 0–100, set on "confidence" steps; pages fall back to the last "NN%" in text
  at: string;               // ISO 8601 UTC
};
export type Thread = { id: string; title: string; status: "open" | "decided"; steps: ThreadStep[] };

/** Experiments on the bench (/lab). */
export type Experiment = {
  id: string;
  bench: "1" | "2" | "3";   // lab bench slot (not a registry plate)
  module: string;           // module name + version
  status: "shadow" | "canary_queued" | "canary" | "rejected" | "passed";
  sim: string;
  metrics: { name: string; delta: number; unit: "%" | "bps" }[];
  note: string;
};
export type Pipeline = { stage: "research" | "simulate" | "red-team" | "canary" | "measure" | "rollback" | "memory"; current: boolean }[];

/** Memory entries (/memory): append-only, rejected entries are first-class. */
export type MemoryEntry = {
  id: number;
  title: string;
  hypothesis: string;
  method: string;
  result: string;
  decision: "accepted" | "rejected" | "rolled_back";
  futureRule?: string;
  refs: { label: string; ref: string }[];
  date: string;
  series?: { candidate: number[]; baseline: number[] };
};

/** Epoch history (/evolution). */
export type Epoch = {
  n: number;
  name: string;             // "GENESIS", "EPOCH 01"
  block: number;
  before: string;
  after: string;
  changed: string;
  rollbacks: number;
  autonomy: [number, number];
  branches: { id: string; label: string; outcome: "active" | "rejected" | "rolled_back" }[];
};

/** ModuleRegistry autonomy ladder (/autonomy). */
export type AutonomyLevel = {
  n: number;
  name: string;
  summary: string;
  permissions: string[];
  criteria: { text: string; kind: "onchain" | "attested"; met: boolean; progress?: string }[];
  unlockedBlock?: number;
};
export type Intervention = { date: string; who: string; action: string; reason: string; tx?: Hex };

/** IdeaMarket (/proposals): 24-hour rounds; rejected stakes are paid pro-rata to accepted-idea stakers (SPEC §10).
 * During an open round every idea is "open" (the engine researches a round only after it closes); researching →
 * simulating → red-team are engine states of a closed round; accepted / rejected / void are final. */
export type Idea = {
  id: number;
  round: number;            // IdeaMarket round = (submit time − START) / ROUND_LENGTH (24 hours)
  title: string;
  summary: string;
  author: string;
  staked: number;           // DNA
  stakers: number;
  status: "open" | "researching" | "simulating" | "red-team" | "accepted" | "rejected" | "void";
  submitted: string;
  resolution?: string;
};

/** BountyBoard (/bounties, SPEC §11): proposed = agent-proposed, no ETH escrowed yet; open = funded, by Safe escrow
 * or (level 7+) from the agent allowance (`fromAllowance`); review = open and past its deadline (awardable until
 * deadline + 7 d); closed = cancelled or expired. */
export type Bounty = {
  id: number;
  title: string;
  request: string;
  rewardEth: number;
  requirements: string[];
  submissions: number;
  status: "proposed" | "open" | "review" | "awarded" | "closed";
  deadline: string;
  fromAllowance?: boolean;  // funded by the L7 agent from the Safe-deposited allowance (refunds return there)
};

/** Vaults + flows (/treasury). */
export type Vault = { name: string; address: Hex; balance: string; unit: string; note: string };
export type SplitShare = { dest: string; bps: number; min: number; max: number };
export type Flow = { at: string /* ISO 8601 UTC */; kind: "fee" | "distribute" | "buyback" | "burn" | "auto-lp" | "bounty"; amount: string; tx: Hex };

/** Constitution (/constitution): only what immutable bytecode enforces. */
export type Rule = { id: string; rule: string; value?: string; contract: string; fn: string };

/** Daily reports (/journal). */
/** One public announcement (the engine's `announce` records, engine/src/announce.ts): a plain line built by code from
 *  on-chain facts, its tx and, when there is one, a proof (an idea round's report). priority 1 money, 2 ballot / mystery,
 *  3 experiments, 4 the rest. */
export type Announcement = { key: string; type: string; title: string; at: string; tx: string | null; proof: string | null; priority: number };

/** One step of the Sequencer's public story (the engine's Sequencer announcements, engine/src/announce.ts SeqFacts):
 *  the stage, the build it belongs to (null for a day with nothing shipped), the plain line, and the signed record it
 *  rests on (its log seq: /api/log/<seq>). Newest first. */
export type SeqStage = "seq_online" | "seq_started" | "seq_building" | "seq_pr" | "seq_verdict" | "seq_shipped" | "seq_killed" | "game_retired" | "seq_nothing_today";
export type SeqEvent = { at: string; stage: SeqStage; build: string | null; text: string; record: string | null };

/** A DNA pool that does not use DNA's hook (engine `clone` record, ref = id). Trades there pay nothing to DNA. id: the
 *  v4 pool id, or the v2/v3 pool address. other: the other token (zero address = ETH). fee: LP fee in pips (null =
 *  dynamic). hooks: v4 only (zero address = none). */
export type Clone = { id: string; venue: string; version: 2 | 3 | 4; other: string; fee: number | null; hooks: string | null; block: number; tx: string };
/** Leakage over one block window (engine `leakage` record): DNA moved through the hook pool and through clones (wei,
 *  decimal strings), and the clones' share in percent. */
export type Leakage = { fromBlock: number; toBlock: number; canonicalDna: string; cloneDna: string; pct: number; byClone: { id: string; dna: string }[] };

export type JournalEntry = {
  day: number;
  date: string;
  summary: string;
  stats: { label: string; value: string }[];
  learned: string;
  tomorrow: string;
  autonomy: string;
};

/** Security log (/security). */
export type SecurityItem = {
  id: string;
  kind: "red-team" | "rollback" | "guardian" | "disclosure";
  title: string;
  severity: "info" | "low" | "medium" | "high";
  status: "open" | "mitigated" | "accepted" | "resolved";
  detail: string;
  date: string;
  ref?: string;
};

/** ModuleRegistry queue (/proposals, LIVE only): every Queued op, its decoded target and fate. */
export type QueuedOp = {
  id: number;
  op: string;               // "Register", "SetCanary", ...
  target?: string;          // module/role address, or "level N"
  proposer: Hex;
  eta: string;              // ISO 8601 UTC: executable from
  status: "pending" | "executed" | "cancelled";
  tx: Hex;
};

/** Homepage core readouts (/ and the shell ticker; web _live/feed.ts reduces the feed into it). */
export type LogTone = "plain" | "reject" | "good" | "alert";

export type Core = {
  status: "ONLINE";
  autonomy: number;
  epoch: number;
  activeModules: number;
  simulations: number;
  proposals: number;
  rollbacks: number;
  block: number;
  goal: string;
  task: string;
  hypothesis: string;
  confidence: number;
  next: string[];
  state: "observing" | "testing" | "canary" | "rollback";
  log: { id: number | string; time: string; text: string; tone: LogTone }[];
  engine?: boolean;         // LIVE: goal/task/hypothesis/confidence/next/simulations come from engine records
};
