// Sample data for the pre-launch site. Internally consistent (epoch 03, 2 active modules,
// 312 proposals, 1 rollback, 8,421 simulations). Replaced by indexer/engine data at launch (see source.ts).
import type {
  Announcement, AutonomyLevel, Bounty, Epoch, Experiment, Flow, Idea, Intervention, JournalEntry, MemoryEntry, Module,
  Pipeline, Rule, SecurityItem, SplitShare, Thread, Vault,
} from "./types";
import { FEE } from "./launchFee";

const h = (s: string) => `0x${s}` as const;

// Launch setup (SPEC §3.1): three AdaptiveFee plates (separate deployments of one bytecode, so one code hash) with bounds
// that keep the project fee in 1%–3.5%, plus BaselineSplit. Plates rotate shadow → canary → Proposed without re-register.
const ADAPTIVE_FEE_CODEHASH = h("15c1431eaa37f72f41f73da355727afbce88aae212709bea75ed422e483680f7");
const plateKills = ["LP markout < baseline over 6h", "fee at cap > 30 min", "organic volume −12% vs baseline"];
const plate = (p: "A" | "B" | "C", status: Module["status"], address: string, base: string, mult: string, cap: string, registeredBlock: number, summary: string): Module => ({
  id: `adaptive-fee@${p}`, name: "adaptive-fee", version: `plate ${p}`, kind: "FeePolicy", status, address: h(address), codeHash: ADAPTIVE_FEE_CODEHASH,
  author: "DNA", review: "internal", risk: "medium", canaryShare: 0, killConditions: plateKills,
  params: [{ key: "base fee", value: base, bounds: "1.00–3.50%" }, { key: "vol multiplier", value: mult, bounds: "1.0–1.8×" }, { key: "fee cap", value: cap, bounds: "1.00–3.50%" }],
  registeredBlock, summary,
});
export const modules: Module[] = [
  plate("C", "active", "f53c3ac8e981741f2242a9cc553d7f621ee60a5a", "2.00%", "1.3×", "3.00%", 26021400, "Active fee plate: volatility-aware, conservative multiplier. Promoted in epoch 03."),
  plate("A", "shadow", "8915f2a29e15de2a3959d52a383060ebd782e9e4", "2.00%", "1.6×", "3.50%", 26021400, "Shadow plate: same bytecode, steeper volatility response. Would-be fee logged, never charged."),
  plate("B", "proposed", "833adaae1ef165269e9b58f94185001c9e2775a4", "1.80%", "1.4×", "3.00%", 26128702, "Rolled back as canary 1.3× (rollback #1), then re-registered fresh by the Safe; back in Proposed, ready to rotate."),
  { id: "baseline-split@v1", name: "baseline-split", version: "v1", kind: "SplitPolicy", status: "active", address: h("de309bb728aa9d6b77335dd6c38c79c932f315a3"), codeHash: h("5641623c3cfb144aef426bb1de9035f95dfb687a47e1f848eea0148d19dd71a0"), author: "DNA", review: "internal", risk: "low", canaryShare: 0,
    killConditions: ["any destination outside its bounds"], params: [], registeredBlock: 26021400, summary: "Launch split: 35% buyback-burn, 30% auto-liquidity, 25% treasury, 10% games. Params ignored (registered with zero bounds). A rollback falls back to the hard-coded 35/35/30 with games at 0." },
  { id: "aggressive-fee@v0", name: "aggressive-fee", version: "v0", kind: "FeePolicy", status: "rejected", address: h("7c79f3b1046663060180036983b1a32f13e2ae87"), codeHash: h("a239b16bce719908311d7a1ab3e8d65b80204b4bcd7aa24f0aa13d424df41575"), author: "community · 0x91…a72", review: "community", risk: "high", canaryShare: 0,
    killConditions: [], params: [], registeredBlock: 0, summary: "Failed simulation checks: organic volume −8.7% at 2.4× multiplier. Never registered." },
];

export const thread: Thread = {
  id: "T-0312", title: "Adaptive fee plate A: does a steeper volatility response help LPs without hurting organic flow?", status: "open",
  steps: [
    { id: "s1", kind: "hypothesis", agent: "Research", model: "grok-4.7", text: "Dynamic fees could improve LP returns without hurting organic volume.", ref: "thread T-0312", at: "2026-10-06T17:31:00Z" },
    { id: "s2", kind: "evidence+", agent: "Market", model: "grok-4.7", text: "128 swaps analyzed in the last window; realized volatility up 18%. Fixed fee leaves markout on the table during spikes.", ref: "block 26,131,552", at: "2026-10-06T17:41:00Z" },
    { id: "s3", kind: "evidence+", agent: "Simulation", model: "harness v1", text: "Replay of 14 days: LP markout +4.8% vs baseline, organic volume +0.3%.", ref: "sim #8421", at: "2026-10-06T17:43:00Z" },
    { id: "s4", kind: "evidence-", agent: "Risk", model: "grok-4.7", text: "A completed simulation does not prove safe live behavior: replay holds trader behavior fixed.", ref: "sim #8421", at: "2026-10-06T17:43:00Z" },
    { id: "s5", kind: "counter", agent: "Red-team", model: "claude", text: "Arbitrageurs can time trades into low-fee windows. Test adverse routing and fee manipulation before any canary.", ref: "red-team R-0091", at: "2026-10-06T17:44:00Z" },
    { id: "s6", kind: "confidence", agent: "Main", model: "grok-4.7", text: "72%, red-team test pending.", value: 72, ref: "sim #8421", at: "2026-10-06T17:44:00Z" },
    { id: "s7", kind: "next", agent: "Main", model: "grok-4.7", text: "Red-team test, then canary deployment if passed.", at: "2026-10-06T17:44:00Z" },
  ],
};

export const experiments: Experiment[] = [
  { id: "E-44A", bench: "1", module: "adaptive-fee plate B", status: "passed", sim: "sim #8420", metrics: [{ name: "LP markout", delta: 2.6, unit: "%" }, { name: "organic volume", delta: 0.1, unit: "%" }, { name: "fee at cap", delta: -1.4, unit: "%" }], note: "Re-registered after rollback #1. Replay passed; next in line for the shadow slot." },
  { id: "E-44B", bench: "2", module: "adaptive-fee plate A", status: "canary_queued", sim: "sim #8421", metrics: [{ name: "LP markout", delta: 4.8, unit: "%" }, { name: "organic volume", delta: 0.3, unit: "%" }, { name: "fee at cap", delta: -2.1, unit: "%" }], note: "In shadow on every 10th swap. Canary waits for the red-team test." },
  { id: "E-44C", bench: "3", module: "aggressive-fee v0", status: "rejected", sim: "sim #8419", metrics: [{ name: "LP markout", delta: 6.2, unit: "%" }, { name: "organic volume", delta: -8.7, unit: "%" }, { name: "fee at cap", delta: 3.4, unit: "%" }], note: "Organic volume threshold breached." },
];
export const pipeline: Pipeline = (["research", "simulate", "red-team", "canary", "measure", "rollback", "memory"] as const).map((stage) => ({ stage, current: stage === "simulate" }));

export const memory: MemoryEntry[] = [
  { id: 312, title: "Adaptive fee candidate", hypothesis: "Dynamic fees could improve LP returns without hurting organic volume.", method: "14-day replay + shadow on 1 in 10 swaps.", result: "Candidate rejected: organic volume −19.4% above a 1.8× volatility multiplier.", decision: "rejected", futureRule: "Red team before canary; cap multiplier at 1.8× in similar regimes.", refs: [{ label: "sim", ref: "#8421" }, { label: "red-team", ref: "R-0091" }], date: "2026-10-05",
    series: { candidate: [2, 3, 3.5, 2.8, 4, 4.6, 3.9, 5.2, 4.4, 3.1, 2.2, 1.6], baseline: [2, 2.2, 2.4, 2.3, 2.6, 2.7, 2.6, 2.9, 2.8, 2.7, 2.6, 2.5] } },
  { id: 311, title: "Canary configuration", hypothesis: "A 1.3× multiplier holds organic flow during spikes.", method: "Live test on 1 in 6 blocks for 4 h.", result: "Configuration rolled back after slippage exceeded 0.5% at median trade.", decision: "rolled_back", futureRule: "Retain the rollback record; slippage guard precedes fee changes.", refs: [{ label: "rollback", ref: "#1" }, { label: "block", ref: "26,128,441" }], date: "2026-10-04" },
  { id: 310, title: "Simulation gate", hypothesis: "Requiring a passing simulation before deployment reduces rollbacks.", method: "Policy change in the ModuleRegistry level allowlist.", result: "Accepted: no un-simulated proposal reached shadow since.", decision: "accepted", futureRule: "Simulate before canary.", refs: [{ label: "proposal", ref: "#310" }], date: "2026-10-03" },
  { id: 308, title: "Treasury-heavy split", hypothesis: "Routing 40% of fees to treasury funds more bounties.", method: "Split simulation vs holder outcomes.", result: "Rejected: weakened auto-liquidity during thin depth.", decision: "rejected", futureRule: "Keep the treasury share at 25% while depth < target.", refs: [{ label: "sim", ref: "#7990" }], date: "2026-10-01" },
];

export const epochs: Epoch[] = [
  { n: 0, name: "GENESIS", block: 26021400, before: "uninitialized", after: "research loop online", changed: "simulation baseline", rollbacks: 0, autonomy: [5, 5], branches: [{ id: "g1", label: "baseline", outcome: "active" }] },
  { n: 1, name: "EPOCH 01", block: 26060112, before: "baseline observation", after: "shadow testing", changed: "candidate screening", rollbacks: 0, autonomy: [5, 5], branches: [{ id: "e1a", label: "fee-curve A", outcome: "rejected" }, { id: "e1b", label: "fee-curve B", outcome: "rejected" }] },
  { n: 2, name: "EPOCH 02", block: 26090118, before: "fixed split", after: "baseline split active", changed: "split module promoted", rollbacks: 0, autonomy: [5, 5], branches: [{ id: "e2b", label: "baseline-split v1", outcome: "active" }, { id: "e2c", label: "treasury-heavy", outcome: "rejected" }] },
  { n: 3, name: "EPOCH 03", block: 26101233, before: "baseline fee", after: "adaptive-fee plate C active", changed: "fee plates rotating", rollbacks: 1, autonomy: [5, 5], branches: [{ id: "e3a", label: "fee plate C", outcome: "active" }, { id: "e3b", label: "canary 1.3×", outcome: "rolled_back" }, { id: "e3c", label: "aggressive-fee v0", outcome: "rejected" }] },
];

// SPEC §3 ladder. Levels 1–3 are engine-side (no registry power); 4–10 are the registry's constant op bitmaps. Raising
// needs a Safe-queued SetLevel (1 h) and 5 days since the last rollback: only those two are checked by the contract
// ("onchain"). Everything else is the Safe signers' policy, signed by named attesters ("attested").
/** ModuleRegistry.LEVEL_RAISE_BLOCKS / 7200: a level can be raised again this many days after the last rollback. */
export const RAISE_DAYS = 5;
const raise = (n: number, met: boolean, progress?: string): AutonomyLevel["criteria"] => [
  { text: `${RAISE_DAYS} days since last rollback`, kind: "onchain", met, progress },
  { text: `Safe-queued SetLevel ${n} executed after 1 h`, kind: "onchain", met },
];
export const autonomy: AutonomyLevel[] = [
  { n: 1, name: "OBSERVE", summary: "Reads chain and market data. Engine-side, no on-chain power.", permissions: ["read pool + contract events"], criteria: [{ text: "Indexer live", kind: "attested", met: true }], unlockedBlock: 26021400 },
  { n: 2, name: "RESEARCH", summary: "Researches mechanisms and forms hypotheses. Engine-side, no on-chain power.", permissions: ["publish research records"], criteria: [{ text: "Hash-chained log anchored", kind: "attested", met: true }], unlockedBlock: 26021400 },
  { n: 3, name: "PROPOSE", summary: "Drafts proposals for the Safe to queue. Engine-side, no registry power.", permissions: ["draft registry ops for the Safe"], criteria: [{ text: "Replayable harness published", kind: "attested", met: true }], unlockedBlock: 26021400 },
  { n: 4, name: "SHADOW", summary: "Puts a fee plate in the shadow slot: called on swaps, never charged.", permissions: ["queue SetShadow on fee modules (1 h)"], criteria: [
    { text: "Below the launch level, set in the ModuleRegistry constructor", kind: "onchain", met: true }], unlockedBlock: 26021400 },
  { n: 5, name: "CANARY", summary: "Runs fee canaries, and can end one or roll back at once.", permissions: ["queue SetCanary on fee modules (1 h)", "queue SetParams on proposed / shadow / canary plates (1 h)", "rollback to baseline (immediate · 1 h cooldown · ≤ 3/day)", "EndCanary (immediate · plate returns to Proposed)"], criteria: [
    { text: "Launch level, set in the ModuleRegistry constructor", kind: "onchain", met: true }], unlockedBlock: 26021400 },
  { n: 6, name: "TUNE", summary: "Tunes the active fee module inside its registered bounds.", permissions: ["queue SetParams on the active fee module (1 h · once per module per hour): moves the live fee anywhere within its registered range (launch: 1%–3.5%) once per hour; the range and the 5% cap are the only limits, with no per-hour step limit"], criteria: [{ text: "3 canaries without rollback", kind: "attested", met: false, progress: "0 / 3" }, ...raise(6, false)] },
  { n: 7, name: "SPEND", summary: "Spends an ETH allowance the Safe deposits in BountyBoard, on bounties only.", permissions: ["fund its own proposed bounties from the allowance", "award allowance-funded bounties (never Safe-escrowed ones)"], criteria: [{ text: "Bounty spend policy published", kind: "attested", met: false }, ...raise(7, false)] },
  { n: 8, name: "PROMOTE", summary: "Promotes a canaried fee plate to active.", permissions: ["queue PromoteActive on fee modules (1 h)"], criteria: [{ text: "Two independent attesters", kind: "attested", met: false }, ...raise(8, false)] },
  { n: 9, name: "SPLIT", summary: "Runs the same lifecycle on split modules.", permissions: ["queue SetShadow / SetCanary / PromoteActive / SetParams on split modules (1 h)"], criteria: [{ text: "90 days without a Safe cancel", kind: "attested", met: false }, ...raise(9, false)] },
  { n: 10, name: "REGISTER", summary: "Registers new plates, only from bytecode the Safe pre-approved.", permissions: ["queue Register of Safe-approved code hashes: same kind, bounds inside the approval (1 h · starts Proposed)"], criteria: [{ text: "Constructor reviewed before every ApproveCodehash", kind: "attested", met: false }, ...raise(10, false)] },
];
export const currentLevel = 5; // the launch level (ModuleRegistry constructor)
export const interventions: Intervention[] = [
  { date: "2026-10-04", who: "Safe (2 of 3)", action: "Cancelled a queued SetShadow", reason: "Slippage spike during red-team review", tx: h("e939fa4f44adcc9511ce0a6bf5977b55cb0d0297c3d5f7a0dda9abf33385a61e") },
  { date: "2026-10-02", who: "Safe (2 of 3)", action: "Ended the fee canary (plate back to Proposed)", reason: "Slippage near the guard during the live test", tx: h("66521eab9d06c05e036b34c0b71b9247a9b18b03c599ae08abff0131881bebda") },
];

/** IdeaMarket START (round 0 opens). Round r runs [START + 24h·r, START + 24h·(r+1)). */
export const ideaMarketStart = "2026-10-03T00:00:00Z"; // round r = day r after this (24 h rounds): round 3 is 2026-10-06
/** IdeaMarket.ROUND_LENGTH (24 h) in ms. */
export const ideaRoundMs = 86_400_000;
// Round 03 is open (only "open" is shown while a round runs); round 02 closed and is being researched; round 01 is final.
export const ideas: Idea[] = [
  { id: 889, round: 3, title: "Volatility-adjusted LP rebate", summary: "Rebate a share of fees to liquidity added during high volatility.", author: "0x91…a72", staked: 184_000, stakers: 41, status: "open", submitted: "2026-10-06" },
  { id: 884, round: 3, title: "Asymmetric buy/sell fee", summary: "Lower fee on buys during drawdowns, higher on panic sells, inside the 5% cap.", author: "0x3c…19e", staked: 122_500, stakers: 27, status: "open", submitted: "2026-10-06" },
  { id: 878, round: 3, title: "Epoch-locked fee schedule", summary: "Publish next epoch's fee schedule in advance so routers can quote exactly.", author: "0x77…0b2", staked: 96_000, stakers: 19, status: "open", submitted: "2026-10-06" },
  { id: 871, round: 2, title: "Pre-committed canary windows", summary: "Commit each canary window a day ahead so arbitrageurs cannot time trades into low-fee blocks.", author: "0x2e…7d1", staked: 142_000, stakers: 33, status: "red-team", submitted: "2026-10-05" },
  { id: 869, round: 2, title: "Lower fee for small swaps", summary: "Charge less on swaps under 0.05 ETH to keep retail flow, inside the 5% cap.", author: "0x6b…c04", staked: 51_000, stakers: 11, status: "researching", submitted: "2026-10-05" },
  { id: 868, round: 2, title: "Volume-timed auto-liquidity", summary: "Add auto-liquidity right after high-volume windows instead of on a fixed cooldown.", author: "0xd0…93a", staked: 64_000, stakers: 12, status: "simulating", submitted: "2026-10-05" },
  { id: 866, round: 1, title: "Treasury-funded bounties for modules", summary: "Fund module bounties from the treasury share each round.", author: "0xa1…4f0", staked: 210_000, stakers: 52, status: "accepted", submitted: "2026-10-04", resolution: "Accepted in round 01 · rejected stakes paid pro-rata to this idea's stakers" },
  { id: 862, round: 1, title: "Bounty pool from fees", summary: "Send part of every fee to a bounty pool.", author: "0x0f…be5", staked: 22_000, stakers: 4, status: "void", submitted: "2026-10-04", resolution: "Void: duplicate of #866 · stakes refunded in full" },
  { id: 860, round: 1, title: "Max fee 10%", summary: "Raise the fee cap for faster buybacks.", author: "0x52…e11", staked: 48_000, stakers: 9, status: "rejected", submitted: "2026-10-04", resolution: "Rejected: the hard limits cap the project fee at 5% (immutable) · stakes paid to stakers of #866" },
];

// simplification: no allowance-funded sample bounty: the sample agent is at level 5 and only funds from the allowance at 7.
// /bounties renders `fromAllowance` ("from agent allowance") as soon as such a bounty exists.
export const bounties: Bounty[] = [
  { id: 17, title: "Volatility-aware LP protection module", request: "A FeePolicy module that raises fees only during adverse selection, measured by markout.", rewardEth: 4, requirements: ["Pure staticcall module, no state", "Gas < 30k per call", "Foundry invariant suite", "No privileged withdrawals"], submissions: 7, status: "review", deadline: "2026-10-05" },
  { id: 18, title: "Replay harness for v4 hooks", request: "Open-source replay of PoolManager swaps against module bytecode.", rewardEth: 2.5, requirements: ["Deterministic seeds", "Matches on-chain results ±1 wei", "MIT license"], submissions: 3, status: "open", deadline: "2026-10-27" },
  { id: 19, title: "Canary window pre-commit verifier", request: "A script that checks every canary window against the window committed a day earlier.", rewardEth: 1, requirements: ["Reads only public chain data", "Flags any mismatch with the block number", "MIT license"], submissions: 0, status: "proposed", deadline: "2026-11-03" },
  { id: 16, title: "Sandwich classifier rules v2", request: "Improve candidate-MEV detection precision on a labelled sample.", rewardEth: 1.5, requirements: ["Precision ≥ 0.9 on sample", "Rules published"], submissions: 5, status: "awarded", deadline: "2026-10-04" },
];

const escrowEth = bounties.filter((b) => b.status === "open" || b.status === "review").reduce((sum, b) => sum + b.rewardEth, 0);
const allowanceEth = 0; // the Safe deposits it before raising to level 7
const stakedDna = ideas.reduce((sum, i) => sum + i.staked, 0);
export const vaults: Vault[] = [
  { name: "FeeVault", address: h("aa3981aac772c1b7bb093b14344039c6f8036a49"), balance: "1.842", unit: "ETH", note: "undistributed project fees" },
  { name: "Safe (treasury)", address: h("6fc772e0e766df753fe93266a57c4e87f7c5e86c"), balance: "6.310", unit: "ETH", note: "Safe 2-of-3 · receives the treasury share" },
  { name: "BountyBoard", address: h("3b8e6f2c90d14a7e5c21b9f04d6a8e3c7f15b2a9"), balance: (escrowEth + allowanceEth).toFixed(3), unit: "ETH", note: "escrow + agent allowance · agent spends it from level 7" },
  { name: "IdeaMarket escrow", address: h("9d4c17a2e8b05f3c6a1e72d94b0c8f5e2a6d3b17"), balance: stakedDna.toLocaleString("en-US"), unit: "DNA", note: "DNA staked on ideas · held until claimed" },
  { name: "BuybackBurn", address: h("5c1d0b7fba33455a8d4dfc5c9a2e56e47336451f"), balance: "0.412", unit: "ETH", note: "next buyback ≤ 0.5% impact" },
  { name: "LiquidityVault", address: h("d42ac9dc0dc988cce7338fe0118caab44e3fdced"), balance: "3", unit: "positions", note: "add-only auto-LP" },
  { name: "Initial LP", address: h("000000000000000000000000000000000000dEaD"), balance: "locked", unit: "forever", note: "2 LP NFTs minted to 0xdEaD" },
  { name: "GamePot", address: h("7e2b5c91d04a6f38b1c7e05a29d4f6b83c1a0e57"), balance: "3.100", unit: "ETH", note: "jackpot pot + idea reserve, each capped at 15 ETH" },
  { name: "PlatformRevenue", address: h("D88539d3c4C460136a733A3Fd60cf6BF269079da"), balance: "0.744", unit: "ETH", note: `Programmable ${FEE.platform}, not ours · immutable` },
];
export const split: SplitShare[] = [
  { dest: "buyback-burn", bps: 3500, min: 2000, max: 5000 },
  { dest: "auto-liquidity", bps: 3000, min: 2000, max: 5000 },
  { dest: "treasury", bps: 2500, min: 1000, max: 4000 },
  { dest: "games", bps: 1000, min: 0, max: 2000 },
];
export const flows: Flow[] = [
  { at: "2026-10-06T17:44:00Z", kind: "fee", amount: "0.031 ETH", tx: h("5538ccabd22b8ade710d707547bc12a902521f8ad3d0459ea835a9e1c3b6e3c3") },
  { at: "2026-10-06T17:20:00Z", kind: "distribute", amount: "0.920 ETH", tx: h("fce4e57901569cfff1faa508165987870b2d39c14388d8021ccd7abe26e0d132") },
  { at: "2026-10-06T17:20:00Z", kind: "buyback", amount: "0.322 ETH", tx: h("fce4e57901569cfff1faa508165987870b2d39c14388d8021ccd7abe26e0d132") },
  { at: "2026-10-06T17:21:00Z", kind: "burn", amount: "1.04M DNA", tx: h("89ee4d5b443341d78281e1c53ead76b4034f326909914643e317b53115d29b3b") },
  { at: "2026-10-06T16:02:00Z", kind: "auto-lp", amount: "0.322 ETH", tx: h("bfda64647d3004f96af97660357bca03423a51e0016319565251b56a4e6a5a20") },
  { at: "2026-10-06T14:30:00Z", kind: "bounty", amount: "1.5 ETH", tx: h("caf1ad27558635f233c319543a60c577f92555b6b1f4c0f2ab6ddc75788282f6") },
];
export const limits: { label: string; value: string }[] = [
  { label: "Agent spend allowance", value: "none until level 7" },
  { label: "Buyback max price impact", value: "0.50%" },
  { label: "Buyback cooldown", value: "1 h" },
  { label: "Liquidity add cooldown", value: "4 h" },
  { label: "Treasury owner", value: "Safe 2-of-3" },
];

export const rules: Rule[] = [
  { id: "supply", rule: "Supply is fixed. No mint, no owner, no blacklist, no transfer tax.", value: "1,000,000,000 DNA", contract: "DNAToken", fn: "constructor" },
  { id: "fee-cap", rule: "Project fee can never exceed the cap, whatever a module returns. Only the launch tax (blocks 0 to 8) is above it.", value: "5.00%", contract: "DNAHook", fn: "beforeSwap → clamp" },
  { id: "platform", rule: `Programmable's launchpad fee is fixed and sits on top of DNA's fee. It is not ours: it goes to Programmable.`, value: FEE.platform, contract: "DNAHook", fn: "afterSwap" },
  { id: "timelock", rule: "Every queued registry op waits at least the floor delay. Only rollback, endCanary, pausing the agent and lowering the level are immediate.", value: "1 hour", contract: "ModuleRegistry", fn: "queuedAt + MIN_DELAY" },
  { id: "split", rule: "Each share stays inside fixed bounds: buyback 20 to 50%, liquidity 20 to 50%, treasury 10 to 40%, games 0 to 20%. Anything else falls back to 35/35/30/0.", value: "see /treasury", contract: "FeeVault", fn: "currentSplit" },
  { id: "lp", rule: "Initial liquidity is locked forever: two LP NFTs owned by 0xdEaD (the whole supply, and the launch buy's DNA with the rest of the launch ETH).", value: "permanent", contract: "Bootstrap", fn: "initialize" },
  { id: "pool", rule: "The hook serves exactly one pool; any other pool reverts.", value: "canonical PoolId", contract: "DNAHook", fn: "beforeInitialize" },
  { id: "launch-tax", rule: "Blocks 0 to 8 after launch carry a launch tax: 90% in the first block, 10 points less each block, down to 10%. All of it goes to buyback-and-burn. The launch buy itself pays the normal fee.", value: "90% → 10% over 9 blocks", contract: "DNAHook", fn: "beforeSwap → LAUNCH_TAX" },
  { id: "launch-caps", rule: "For 4 minutes after launch, at most 2% of supply can leave the pool per block (net of sells). Each sending wallet can buy at most 1% in all, gross (sells don't count back): counted from block 0, enforced from block 4. DNA's own buybacks are exempt.", value: "2% per block · 1% per wallet", contract: "DNAHook", fn: "afterSwap → _capNet (LAUNCH_BLOCK_CAP, LAUNCH_WALLET_CAP)" },
  { id: "liquidity-lock", rule: "No new liquidity for 4 minutes after launch, except the launch's own. Removing liquidity is never blocked.", value: "4 minutes", contract: "DNAHook", fn: "beforeAddLiquidity → LiquidityLocked" },
  { id: "launch-fee", rule: `After the launch tax (blocks 0 to 8), DNA's fee is ${FEE.oursLaunch} for the first hour after launch, sliding to ${FEE.ours} (a trade pays ${FEE.totalLaunch} → ${FEE.total} with Programmable's ${FEE.platform}). The clock starts when the pool opens and can never restart.`, value: `${FEE.oursLaunch} → ${FEE.ours} over 1 hour`, contract: "DNAHook", fn: "beforeInitialize → baselineFee" },
  { id: "fallback", rule: "If a module reverts or misbehaves, the baseline fee applies.", value: `${FEE.ours} baseline (${FEE.oursLaunch} → ${FEE.ours} in the first hour)`, contract: "DNAHook", fn: "staticcall → BaselineFeePolicy" },
  { id: "exits", rule: "Removing liquidity can never be blocked by the hook.", value: "passthrough", contract: "DNAHook", fn: "beforeRemoveLiquidity" },
  { id: "gate", rule: "The AI's key can only queue the ops its level's constant bitmap allows. It can never set the agent, anchor key or level, cancel, pause, unpause itself, or approve or revoke code hashes.", value: "levels 4–10", contract: "ModuleRegistry", fn: "queue → levelOps" },
  { id: "ladder", rule: "Levels rise only through a Safe-queued SetLevel, never within 5 days of a rollback; the Safe lowers them instantly. ≤3 nothing on-chain · 4 shadow · 5 canary, plate params, rollback, endCanary · 6 active params · 7 bounty allowance · 8 promote · 9 split modules · 10 register approved bytecode.", value: "levels 1–10", contract: "ModuleRegistry", fn: "setLevel / lowerLevel" },
  { id: "end-canary", rule: "The Safe, or the agent from level 5, can end the fee canary at once. It only removes the canary, never routes anything new, and is not a rollback.", value: "immediate", contract: "ModuleRegistry", fn: "endCanary" },
  { id: "plate-reuse", rule: "A module displaced from its slot, or ended as canary, returns to Proposed and can rotate again. A rolled-back module needs a fresh Safe register.", value: "→ Proposed", contract: "ModuleRegistry", fn: "_setStatus" },
  { id: "codehash", rule: "The agent may register only bytecode whose code hash the Safe approved, of the same kind, with bounds inside the approved bounds.", value: "level 10", contract: "ModuleRegistry", fn: "register → approveCodehash" },
  { id: "allowance", rule: "The agent never moves Safe-escrowed ETH. From level 7 it spends only the allowance the Safe deposits, on its own allowance-funded bounties.", value: "level 7", contract: "BountyBoard", fn: "fund / award → fromAllowance" },
];

/** Demo announcements: every line says [Demo], addresses and tx hashes are obviously not real. */
const demoTx = (n: number) => `https://etherscan.io/tx/0x${String(n).padStart(64, "0")}`;
export const announcements: Announcement[] = [
  { key: "demo-1", type: "jackpot_drawn", priority: 1, at: "2026-10-06T21:00:00Z", title: "[Demo] Jackpot window 12: 10 winners, 0.084 ETH each: 0x00000000000000000000000000000000000000d1, 0x00000000000000000000000000000000000000d2, …", tx: demoTx(1), proof: "/play/draw/12" },
  { key: "demo-2", type: "idea_round", priority: 1, at: "2026-10-06T18:10:00Z", title: "[Demo] Idea round 2: 1 of 3 ideas accepted; stakers of accepted ideas get their stake back plus 37.5%", tx: demoTx(2), proof: null },
  { key: "demo-3", type: "reward_paid", priority: 1, at: "2026-10-06T12:00:00Z", title: "[Demo] Idea reward paid: 0.2 ETH to 0x12ab…9f3c", tx: demoTx(3), proof: null },
  { key: "demo-4", type: "ballot_result", priority: 2, at: "2026-10-05T23:00:00Z", title: "[Demo] Ballot #4: \"Calm nights\" won with 61,000 of 90,000 vote weight; queued for testing", tx: demoTx(4), proof: null },
  { key: "demo-5", type: "outcome", priority: 3, at: "2026-10-05T16:40:00Z", title: "[Demo] Experiment on plate B: killed (a kill condition fired), from ballot 3", tx: demoTx(5), proof: null },
  { key: "demo-6", type: "prize_expired", priority: 1, at: "2026-10-04T21:00:00Z", title: "[Demo] Jackpot draw #5: 0.31 ETH not claimed in 7 days, returned to the pot", tx: demoTx(6), proof: null },
];

export const journal: JournalEntry[] = [
  { day: 37, date: "2026-10-06", summary: "61 ideas received. 9 researched. 4 simulated. 3 rejected. 1 entered adversarial testing.", stats: [{ label: "ideas", value: "61" }, { label: "simulated", value: "4" }, { label: "rejected", value: "3" }, { label: "red-team", value: "1" }], learned: "Fee aggressiveness improves LP revenue but damages organic flow beyond 1.8× baseline volatility.", tomorrow: "Test asymmetric fee responses.", autonomy: "5 → 5 (0/3 canaries without rollback)" },
  { day: 36, date: "2026-10-05", summary: "Adaptive-fee plate A entered shadow. Canary held for red-team.", stats: [{ label: "ideas", value: "44" }, { label: "simulated", value: "6" }, { label: "rejected", value: "4" }, { label: "red-team", value: "2" }], learned: "Replay evidence alone over-states LP gains when arbitrage timing is ignored.", tomorrow: "Adverse-routing red-team on plate A.", autonomy: "5 → 5" },
  { day: 35, date: "2026-10-04", summary: "Rollback #1: canary 1.3× reverted on slippage. Lesson recorded.", stats: [{ label: "ideas", value: "38" }, { label: "simulated", value: "5" }, { label: "rejected", value: "2" }, { label: "rollbacks", value: "1" }], learned: "Slippage guard must precede fee changes.", tomorrow: "Re-simulate with a slippage guard ahead of fee changes.", autonomy: "5 → 5 (rollback resets the 5-day clock)" },
];

export const security: SecurityItem[] = [
  { id: "R-0091", kind: "red-team", title: "Window-timing arbitrage against switchback canaries", severity: "medium", status: "open", detail: "Arbitrageurs can concentrate trades in low-fee windows. Mitigation under test: longer, pre-committed windows.", date: "2026-10-05", ref: "thread T-0312" },
  { id: "R-0088", kind: "red-team", title: "Gas-starvation fee downgrade", severity: "high", status: "resolved", detail: "Trader-chosen gas could force the baseline fee. Fixed: hook reverts unless the module gas cap is available.", date: "2026-10-03" },
  { id: "RB-1", kind: "rollback", title: "Canary 1.3× rolled back", severity: "low", status: "resolved", detail: "Slippage exceeded 0.50% at median trade; baseline restored in the same block.", date: "2026-10-04", ref: "block 26,128,441" },
  { id: "G-2", kind: "guardian", title: "The Safe cancelled a queued SetShadow", severity: "info", status: "resolved", detail: "Cancelled inside the 1 h window while red-team review was open.", date: "2026-10-04" },
  { id: "D-1", kind: "disclosure", title: "Not independently audited", severity: "info", status: "accepted", detail: "Contracts are tested with unit, fuzz and invariant suites and adversarial reviews, but no external audit has been performed.", date: "2026-10-06" },
  { id: "D-2", kind: "disclosure", title: "Partial fills revert", severity: "info", status: "accepted", detail: "Swaps that would only partially fill the ETH side revert instead of settling partially.", date: "2026-10-06" },
  { id: "D-3", kind: "disclosure", title: "LP fee is zero; fees go to the hook", severity: "info", status: "accepted", detail: "Third-party LPs earn no swap fee in this pool; all fees route through the vaults.", date: "2026-10-06" },
  { id: "D-4", kind: "disclosure", title: "Platform dependencies", severity: "info", status: "accepted", detail: "Launched via Programmable (permit signed by their key; Explore and swap route are their off-chain services). No on-chain power over DNA after launch.", date: "2026-10-06" },
  { id: "D-5", kind: "disclosure", title: "Other DNA pools pay DNA nothing", severity: "info", status: "accepted", detail: "Anyone can open another DNA pool (Uniswap v2, v3, v4 without DNA's hook, or another exchange) and nobody can stop it. Trades there pay nothing to the buyback, liquidity, treasury or games; their fees go to whoever funds them. Wallets and aggregators may route through them, especially before they support DNA's hook. The official pool and every other pool the engine finds are on /trade.", date: "2026-10-09" },
];
