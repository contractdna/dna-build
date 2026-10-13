// Every string of /docs, both modes. Feature names live in NAMES so a rename is one edit.
// Numbers are the code's (contracts/src, engine/src); the PR that added this page lists each one with its source.
// Plain .ts (no JSX) so web/test/docs.test.mjs can import it (hence the .ts extension on the one value import).
// Fee figures come from _data/launchFee (the one place they live).
import { FEE } from "../_data/launchFee.ts";
import { ENGINE_COMMIT, ENGINE_REPO, LIVE, SOURCE_COMMIT, SOURCE_REPO } from "../_data/flags.ts";

export const MODES = ["dumb", "smart"] as const;
export type Mode = (typeof MODES)[number];
export const parseMode = (v: string | null | undefined): Mode | null => (v === "dumb" || v === "smart" ? v : null);
export const STORAGE_KEY = "dna.docs.mode";

export const NAMES = {
  token: "DNA",
  ticker: "$DNA",
  jackpot: "Holder jackpot",
  staking: "Staking",
  votes: "Mutation vote",
  mystery: "Mystery mutation",
  rewards: "Idea rewards",
  ideas: "Ideas",
  vaults: "Genome Vaults",
  safety: "The Safe",
} as const;

export const PAGE = {
  title: "Docs",
  lede: "How DNA works, explained two ways. Pick yours; you can switch any time.",
  metaTitle: "Docs · DNA",
  metaDescription: "How DNA works, in two modes: three short lines per chapter, or the contracts, parameters and formulas with links to the source.",
  chooserLabel: "Pick a mode",
  toggleLabel: "Reading mode",
  chaptersLabel: "Chapters",
  sourceLabel: "Source",
  sourcePending: LIVE ? "not public yet" : "source published at launch",
};

export const MODE_LABEL: Record<Mode, { button: string; hint: string }> = {
  dumb: { button: "I'm dumb", hint: "three short lines a chapter, in plain words" },
  smart: { button: "I'm smart", hint: "contracts, parameters, formulas, source links" },
};

/** Base URL of the public source (files are appended as `${SOURCE_BASE}/contracts/src/…`), at the launched commit.
 *  null before launch (_data/flags SOURCE_REPO): the page then names each file and says the source is published at
 *  launch. Only ever the project's own org. */
export const SOURCE_BASE: string | null = SOURCE_REPO && `${SOURCE_REPO}/blob/${SOURCE_COMMIT}`;
/** The running engine's public source (engine/, contracts/SPEC.md, docs/), at the commit the enclave image was built
 *  from (_data/flags ENGINE_REPO); contracts/ links stay on the repo Etherscan verifies. */
export const ENGINE_BASE: string | null = ENGINE_REPO && `${ENGINE_REPO}/blob/${ENGINE_COMMIT}`;
const eng = (path: string) => (ENGINE_BASE ? `${ENGINE_BASE}/${path}` : null);
const src = (path: string) => (SOURCE_BASE ? `${SOURCE_BASE}/${path}` : null);
const sol = (name: string) => src(`contracts/src/${name}.sol`);

export type Fact = { k: string; v: string; at?: string };
export type Flow = { steps: string[]; branches: { when: string; then: string }[] };
export type Link = { label: string; href: string | null }; // null: source not published yet
export type Chapter = {
  id: string;
  title: string;
  /** ≤ 3 short lines (the test enforces it) */
  dumb: string[];
  smart: { lead: string; formula?: string[]; flow?: Flow; facts: Fact[]; notes?: string[]; links: Link[] };
};

export const CHAPTERS: Chapter[] = [
  {
    id: "what",
    title: "What this is",
    dumb: [
      "$DNA is a coin on ethereum with an AI that tunes its trading fee. the sequencer builds new games for it too.",
      "every fee change is a mutation (CT would say a new hook). the AI tests each one on real trades. bad ones get rolled back, good ones stay.",
      "every move it makes is public, and you can check it yourself.",
    ],
    smart: {
      lead: "DNA is an ERC-20 on Ethereum, traded against ETH in one Uniswap v4 pool. The pool's hook, DNAHook, charges a dynamic fee whose policy is a swappable module: what CT calls a new hook, DNA calls a mutation. An AI agent proposes parameters for registered modules through ModuleRegistry (registering new Safe-approved bytecode needs level 10). A separate pipeline, the Sequencer, builds standalone game contracts, new modules and new pages on this site (see The Sequencer). Each change waits in a public 1 h queue, then runs in shadow and on a slice of live trades before it is kept or rolled back.",
      facts: [
        { k: "Token", v: "DNA (ticker DNA), 1,000,000,000 minted once. Burnable, no mint function, no owner", at: "DNAToken.SUPPLY" },
        { k: "Pool", v: "ETH/DNA on Uniswap v4, dynamic fee, tick spacing 1, one canonical pool", at: "DNAHook.poolKey" },
        { k: "Hook", v: "Immutable, no owner, no upgrade path", at: "SPEC §2" },
        { k: "Agent", v: "Runs in an Intel TDX enclave on Phala; its address is registry.agent()", at: "ModuleRegistry.agent" },
        { k: "The Safe", v: "2-of-3 multisig. Cancels, pauses, lowers the level. Can't touch your DNA or the hard limits (see The Safe)", at: "ModuleRegistry.safe" },
      ],
      links: [
        { label: "contracts/SPEC.md", href: eng("contracts/SPEC.md") },
        { label: "DNAToken.sol", href: sol("DNAToken") },
        { label: "DNAHook.sol", href: sol("DNAHook") },
        { label: "ModuleRegistry.sol", href: sol("ModuleRegistry") },
      ],
    },
  },
  {
    id: "mutations",
    title: "Mutations (CT: hooks)",
    dumb: [
      "a mutation is a change to how DNA's hook charges fees. today that means new settings for a fee module the Safe already approved. new module code comes from the Sequencer and needs the Safe's signature.",
      "each one waits 1 hour in public, runs 2 hours in shadow (worked out, never charged), then 4 hours on a slice of real trades.",
      "if it does better it stays. if it breaks or does worse, it gets rolled back.",
    ],
    smart: {
      lead: "A mutation is a module, or new parameters for one, that DNA's one Uniswap v4 hook calls. DNAHook itself never changes. A module is a small pure contract: a fee policy the hook calls on every swap (AdaptiveFee) or a split policy FeeVault calls on every distribution (BaselineSplit). A module moves Proposed → Shadow → Canary → Active, one queued registry op per step, and anyone can execute an op once its 1 h delay has passed.",
      formula: [
        "AdaptiveFee:  pips = min(base + mult × volEma / 1e4, cap)",
        "canary fee is clamped to activeFee ± 10,000 pips (±1 point)",
      ],
      flow: {
        steps: ["Queue SetParams + SetShadow · 1 h", "Shadow · 2 h, every 10th swap, fee computed, nothing charged", "Queue SetCanary · 1 h", "Canary · 4 h, live fee on 100 of every 600 blocks"],
        branches: [
          { when: "passes", then: "PromoteActive, queued 1 h (by the Safe until level 8): it becomes the live fee" },
          { when: "fails or a kill check fires", then: `endCanary (the active fee stays) or rollback (the ${FEE.ours} baseline)` },
        ],
      },
      facts: [
        { k: "Mutation = hook", v: "\"Hook\" is what CT calls it; \"mutation\" is DNA's name. Either way: a module the one hook calls, never a new hook contract. DNAHook is immutable", at: "DNAHook._staticcallPips → IFeePolicy.projectFee" },
        { k: "Who writes them", v: "The AI proposes every one. Today a mutation is a new parameter set for an approved module (an AdaptiveFee plate); brand-new bytecode needs autonomy level 10 and a code hash the Safe approved. ParamSplit, DirectionalFee and SizeTierFee are built and tested; the Safe has not registered them yet. Today the AI tunes AdaptiveFee only", at: "ModuleRegistry.L10_OPS, ApproveCodehash; contracts/src/modules" },
        { k: "Launch level", v: "5: shadow, live test, parameters on non-active modules, rollback. Promotion needs the Safe until 8", at: "ModuleRegistry constructor level_, L5_OPS" },
        { k: "Queue delay", v: "1 h on every op, the agent's and the Safe's alike", at: "ModuleRegistry.MIN_DELAY" },
        { k: "One experiment", v: "About 8 h: 1 h + 2 h shadow + 1 h + 4 h canary, so at most 3 a day. A stage short of data is extended, up to 3× its length", at: "engine/src/policy.ts TIMING" },
        { k: "Shadow sampling", v: "Every 10th swap, 30,000 gas, failures ignored", at: "DNAHook.SHADOW_EVERY" },
        { k: "Canary window", v: "100 of every 600 blocks (the contract requires ≥ 50)", at: "ModuleRegistry.MIN_CANARY_WINDOW" },
        { k: "Module gas cap", v: `40,000 gas. A revert, a bad return or running out of gas falls back to the ${FEE.ours} baseline in the same swap`, at: "DNAHook.MODULE_GAS_CAP" },
        { k: "Breaker", v: "3 module failures within 300 blocks: anyone may roll the fee route back, and the engine's watcher does it at once", at: "DNAHook.BREAKER_WINDOW, ModuleRegistry.BREAKER_N" },
        { k: "Launch fee range", v: "Base and cap 10,000–35,000 pips (1%–3.5%), multiplier 0.1×–1.8×", at: "script/Launch.s.sol feeBounds" },
        { k: "Tuning", v: "At most one parameter change per module per hour. From level 6 the live fee can move anywhere in its range; there is no step limit", at: "ModuleRegistry.PARAMS_EPOCH" },
        { k: "Autonomy levels", v: "0–10. L4 shadow, L5 canary and rollback, L6 tune the live fee, L7 bounty allowance, L8 promote, L9 split modules, L10 register bytecode the Safe approved", at: "ModuleRegistry.L4_OPS–L10_OPS" },
        { k: "Level changes", v: "Raised only by the Safe, through the queue, ≥ 5 days after the last rollback. Lowered by the Safe instantly", at: "ModuleRegistry.LEVEL_RAISE_BLOCKS" },
      ],
      links: [
        { label: "ModuleRegistry.sol", href: sol("ModuleRegistry") },
        { label: "DNAHook.sol", href: sol("DNAHook") },
        { label: "AdaptiveFee.sol", href: src("contracts/src/modules/AdaptiveFee.sol") },
        { label: "engine/src/policy.ts", href: eng("engine/src/policy.ts") },
        { label: "engine/src/loop.ts", href: eng("engine/src/loop.ts") },
      ],
    },
  },
  {
    id: "sequencer",
    title: "The Sequencer",
    dumb: [
      "the sequencer takes the best ideas and builds each one as a game, a fee module or a new page on the site, tests included.",
      "a tester attacks every build, the brain decides if it ships, and the deploy and its funding wait one public hour the Safe can cancel.",
      "it's switched on and builds from the first winning idea, up to 3 ideas at once. a game ships only after every check and one public hour.",
    ],
    smart: {
      lead: "An off-chain build pipeline. The brain picks what to build and signs the decision. The sequencer's models work in public CI on the public repo and can only open pull requests. The sealed engine re-runs every gate, compiles the merged commit itself and deploys after the public hour. No wallet key ever sits in CI.",
      flow: {
        steps: [
          "Idea → sealed intake → plain spec (builders never see the raw post)",
          "Brain: build or not, signed",
          "Lead plans; workers write contract, page and tests; tester attacks; fixer repairs (≤ 3 rounds); reviewer checks",
          "Brain verdict: ship, rework or kill, signed",
          "Public hour: deploy and funding queued, the Safe can cancel",
          "Sealed engine deploys a game; a new site page goes out on the release branch and is announced once the site serves it",
        ],
        branches: [
          { when: "fails the gates or 3 rounds", then: "dropped, reason published" },
          { when: "no players for 2 days", then: "retired, ETH back to the Safe, claims stay" },
        ],
      },
      facts: [
        { k: "Brain", v: "One model call per decision (build, verdict, retire, model swap, idea-round outcome, reward). Each is a signed record with the model, the sha256 of its context and of its input", at: "engine/src/brain.ts" },
        { k: "Models", v: "Public registry of every role's model and backup, shown as a table on /models. These are the default models. Swapping one needs a public tryout on fixed test cases, then a public hour, and the Safe can veto. Swapping the brain itself needs two Safe owners to approve", at: "engine/models.json, docs/MODELS.md" },
        { k: "Spend caps", v: "A daily and a monthly cap on AI spending. Near the cap the sequencer pauses first, then research. Keepers never call a model, so trading, fees and payouts never need the AI", at: "engine/src/config.ts LLM" },
        { k: "Gates", v: "Fuzz and invariant tests, fork simulation, static analysis, a planted-bug check, a gas cap, no delegatecall, selfdestruct or upgradeability, no new dependencies, no CI edits. The sealed engine re-runs them; CI alone never decides" },
        { k: "New games", v: "Standalone contracts with no power over the hook, the fees or other games. Only the Safe can pause one. No user deposits until a higher ladder level" },
        { k: "Live cap", v: "At most 3 games live. A 4th retires the one with the fewest players over 2 days" },
        { k: "Funding", v: "Safe → Zodiac Roles (one allowed call, GameFunder.fund, bounded amount) → Delay (1 h, the Safe can cancel). GameFunder enforces a weekly budget and a per-game cap", at: "contracts/src/games/GameFunder.sol, test/fork/Funding.t.sol" },
        { k: "Hook modules", v: "A module the Sequencer builds still needs the Safe's code-hash approval before it can be registered", at: "ModuleRegistry.ApproveCodehash" },
        { k: "Status", v: "Running in the sealed engine since 11 Oct 2026: the brain, model registry, spend caps, funding path (fork-tested), module library, idea rewards, idea routing, X wallet links and the sequencer's build loop" },
      ],
      links: [
        { label: "engine/src/brain.ts", href: eng("engine/src/brain.ts") },
        { label: "engine/models.json", href: eng("engine/models.json") },
        { label: "Models", href: "/models" },
        { label: "GameFunder.sol", href: src("contracts/src/games/GameFunder.sol") },
        { label: "The Sequencer map", href: "/sequencer" },
      ],
    },
  },
  {
    id: "rules",
    title: "Hard limits",
    dumb: [
      "baked in for good: after the launch tax, the fee can never go above 5%, there will only ever be 1B coins, and the starting liquidity is locked at the dead address.",
      "launch guard: blocks 0 to 8 are taxed 90% down to 10%, all of it to buyback-and-burn. for 4 minutes at most 2% of the coins can leave the pool per block, and from block 4 no wallet can buy more than 1% in all. every change waits 1 hour in public, and nothing in here can move your coins.",
      "the hook is immutable. no proxy admin, no upgrade key, not even for us. the team can't change any of this, and neither can the AI.",
    ],
    smart: {
      lead: "The hook is immutable. No proxy admin, no upgrade key, not even for us. These are constants in immutable bytecode. No key can change them, the Safe's included.",
      facts: [
        { k: "Project fee cap", v: "50,000 pips (5.00%): every module's answer is clamped to it. Only the launch tax (blocks 0 to 8) is above it", at: "DNAHook.MAX_PROJECT_FEE" },
        { k: "Baseline fee", v: `22,000 pips (${FEE.ours}) when no module is active or a module fails. With Programmable's fee on top, traders pay ${FEE.total}`, at: "DNAHook.BASELINE_PROJECT_FEE" },
        { k: "Launch fee", v: `The baseline slides linearly from 30,000 to 22,000 pips (${FEE.oursLaunch} to ${FEE.ours}; ${FEE.totalLaunch} to ${FEE.total} for traders) over the first hour after pool initialization, then stays at ${FEE.ours}. It applies only as the baseline/fallback (no module active, or a module failed). The clock is set once, at initialization. Blocks 0 to 8 pay the launch tax instead (90% down to 10%, to BuybackBurn)`, at: "DNAHook.LAUNCH_PROJECT_FEE, LAUNCH_DECAY" },
        { k: "Platform fee", v: `3,000 pips (${FEE.platform}) on top: Programmable's launchpad fee, not ours (the share its profile 3.6.0 binds)`, at: "DNAHook.PLATFORM_FEE" },
        { k: "Canary clamp", v: "±10,000 pips (±1 point) around the active fee", at: "DNAHook.CANARY_MAX_DELTA" },
        { k: "Supply", v: "1,000,000,000 DNA, minted once. There is no mint function, so supply only goes down", at: "DNAToken.SUPPLY" },
        { k: "Launch liquidity", v: "Two positions, both owned by 0xdEaD: the whole supply as one DNA-only position, and the launch buy's DNA with the rest of the launch ETH as one full-range position. Bootstrap reverts unless ownerOf == 0xdEaD for each", at: "Bootstrap.DEAD" },
        { k: "Launch buy", v: "Its DNA is locked in the full-range position. Only the excess the position could not pair, about 47,000 DNA, was burned. Bootstrap ends holding nothing", at: "Bootstrap.initialize" },
        { k: "Launch tax", v: "900,000 pips (90%) in the pool's first block, 100,000 less each block after: blocks 0 to 8 pay 90% down to 10%, plus the platform fee. All of it goes to BuybackBurn. The launch buy itself pays the normal fee", at: "DNAHook.LAUNCH_TAX, LAUNCH_TAX_STEP, LAUNCH_TAX_BLOCKS" },
        { k: "Launch caps", v: "For 4 minutes after launch: at most 20,000,000 DNA (2% of supply) out of the pool per block, net of sells, and at most 10,000,000 DNA (1%) bought per sending wallet (tx.origin) in all, gross (sells don't count back), enforced from block 4. DNA's own buybacks are never taxed, capped or counted", at: "DNAHook.LAUNCH_BLOCK_CAP, LAUNCH_WALLET_CAP, LAUNCH_CAP_WINDOW" },
        { k: "Liquidity lock", v: "No liquidity can be added for 4 minutes after launch, except by the launch transaction. Removing liquidity is never blocked", at: "DNAHook.LiquidityLocked" },
        { k: "Added liquidity", v: "LiquidityVault only adds; it has no withdraw or decrease path", at: "LiquidityVault.add" },
        { k: "Queue", v: "1 h minimum delay on every registry op", at: "ModuleRegistry.MIN_DELAY" },
        { k: "Split bounds", v: "Buyback 20–50%, liquidity 20–50%, treasury 10–40%, games 0–20%, summing to 100%. Anything else falls back to 35/35/30/0", at: "FeeVault.currentSplit" },
        { k: "Game bounds", v: "Draws every 12 h–3 d, prize ≤ 3 ETH, per-wallet cap 0.5–2%, idea reward ≤ 25% of the idea reserve", at: "GamePot constants" },
      ],
      notes: ["What can change, inside those bounds: the fee (1%–3.5% at launch), the split, and the game settings."],
      links: [
        { label: "DNAHook.sol", href: sol("DNAHook") },
        { label: "DNAToken.sol", href: sol("DNAToken") },
        { label: "Bootstrap.sol", href: sol("Bootstrap") },
        { label: "FeeVault.sol", href: sol("FeeVault") },
        { label: "LiquidityVault.sol", href: sol("LiquidityVault") },
        { label: "SPEC §1 constants", href: eng("contracts/SPEC.md") },
      ],
    },
  },
  {
    id: "fees",
    title: "Where fees go",
    dumb: [
      `every trade pays ${FEE.total}: ${FEE.ours} to DNA plus ${FEE.platform} to programmable, the launchpad. the first hour starts at ${FEE.totalLaunch} and slides down.`,
      `the AI can tune DNA's part between 1% and 3.5%, and after the launch tax it can never pass ${FEE.cap}. (on programmable.market their router adds another ${FEE.platform}.)`,
      "DNA's part splits four ways: 35% buys $DNA and burns it, 30% adds liquidity, 25% goes to the Safe, 10% to the games. the live split is on the treasury page.",
    ],
    smart: {
      lead: "Fees are taken in ETH, on the swap's ETH leg. The project fee is minted to FeeVault as ERC-6909 claims; the platform fee goes to PlatformRevenue, whose only recipient is Programmable: it is the launchpad's fee, not DNA's.",
      formula: [
        "fee     = gross × (projectPips + 3,000) / 1e6",
        "project = floor(gross × projectPips / 1e6)   → FeeVault",
        "platform = fee − project                     → PlatformRevenue",
        "baseline = 22,000 + 8,000 × (1 h − elapsed) / 1 h   for the first hour after initialization, then 22,000",
      ],
      flow: {
        steps: [`Swap pays DNA's fee (${FEE.ours} baseline, 1%–3.5% tuned) + Programmable's ${FEE.platform} (not ours), in ETH`, "FeeVault.distribute(), anyone, at ≥ 0.05 ETH"],
        branches: [
          { when: "35%", then: "BuybackBurn: buys DNA and burns it" },
          { when: "30%", then: "LiquidityVault: adds liquidity, never removes it" },
          { when: "25%", then: "Treasury: ETH to the Safe" },
          { when: "10%", then: "GamePot: 70% jackpot, 30% idea rewards (games bounds 0–20%)" },
        ],
      },
      facts: [
        { k: "Project fee", v: `${FEE.ours} default (${FEE.total} with the platform fee); the AI tunes it inside 1%–3.5%`, at: "DNAHook.BASELINE_PROJECT_FEE, Launch.s.sol feeBounds" },
        { k: "Launch fee", v: `The baseline slides linearly from 30,000 to 22,000 pips (${FEE.oursLaunch} to ${FEE.ours}; ${FEE.totalLaunch} to ${FEE.total} for traders) over the first hour after pool initialization, then stays at ${FEE.ours}. It applies only as the baseline/fallback (no module active, or a module failed). The clock is set once, at initialization. Blocks 0 to 8 pay the launch tax instead (90% down to 10%, to BuybackBurn)`, at: "DNAHook.LAUNCH_PROJECT_FEE, LAUNCH_DECAY" },
        { k: "Platform fee", v: `${FEE.platform} on top, to an immutable recipient: Programmable's launchpad fee, not ours (Programmable profile 3.6.0)`, at: "DNAHook.PLATFORM_FEE, PlatformRevenue.recipient" },
        { k: "Launch split", v: "3,500 / 3,000 / 2,500 / 1,000 bps (buyback / liquidity / treasury / games)", at: "BaselineSplit.split" },
        { k: "Split fallback", v: "3,500 / 3,500 / 3,000 / 0 if the split module is rolled back. The games stop; nothing else does", at: "FeeVault.BASELINE_*" },
        { k: "Buyback", v: "≤ 1 ETH per call, 1 h cooldown (≤ 24 ETH a day), 0.50% price limit. Pays only the 0.30% platform share, no project fee. All bought DNA is burned", at: "BuybackBurn.MAX_SIZE, COOLDOWN" },
        { k: "Liquidity adds", v: "Every ≥ 4 h, an ETH-only range 2,000 ticks wide just above the price", at: "LiquidityVault.COOLDOWN, WIDTH" },
        { k: "Games", v: "GamePot splits arrivals 70% jackpot / 30% idea reserve, each capped at 15 ETH. Overflow goes to the buyback", at: "GamePot.JACKPOT_BPS, POT_CAP, RESERVE_CAP" },
        { k: "Who triggers it", v: "Anyone: distribute, process, add and sync are permissionless. The engine's keepers call them", at: "FeeVault, BuybackBurn, LiquidityVault, GamePot" },
      ],
      links: [
        { label: "DNAHook.sol", href: sol("DNAHook") },
        { label: "FeeVault.sol", href: sol("FeeVault") },
        { label: "BaselineSplit.sol", href: src("contracts/src/modules/BaselineSplit.sol") },
        { label: "BuybackBurn.sol", href: sol("BuybackBurn") },
        { label: "LiquidityVault.sol", href: sol("LiquidityVault") },
        { label: "PlatformRevenue.sol", href: sol("PlatformRevenue") },
      ],
    },
  },
  {
    id: "jackpot",
    title: NAMES.jackpot,
    dumb: [
      "hold 1,000+ $DNA (average over the window) and you're in. no sign-up. staking counts 2x to 4x.",
      "10 wallets win each draw and split it equally, up to 3 eth. chainlink picks them, the eth lands by itself, and no wallet gets more than 2% of the tickets.",
      "the AI sets the timing (every 12 to 24 hours) and posts the rules before each window; a window without them is not drawn. anyone can check a draw on-chain.",
    ],
    smart: {
      lead: "Every DNA holder is in. Tickets are a time-weighted average balance over the draw window, built in the enclave from the full Transfer history and committed on-chain as a Merkle root. One Chainlink VRF v2.5 word, delivered after the list is fixed, picks 10 winners, who split the prize equally (at least 0.25 ETH).",
      formula: [
        "tickets = floor( Σ balance × seconds × mult / (windowSeconds × 10,000) / 1e18 )",
        "mult = 10,000 (×1) for held DNA, the staking weight (×2–×4) for staked DNA",
        "eligible iff the unweighted average balance ≥ minBalance",
        "cap: find L so every wallet above L gets exactly L and L ≤ capBps / 10,000 × Σ tickets",
        "ticket_j = keccak256(abi.encode(rand, j)) mod totalTickets, j = 0, 1, … until 10 distinct wallets (at most 32 tickets)",
        "share = prize / 10; unfilled places and dust stay in the pot",
      ],
      flow: {
        steps: ["The AI posts the window's rules (cap, minimum, excluded exchanges) with its reasoning, anchored before the window opens", "Window closes; the AI posts root, total tickets and holders", "1 h veto: the Safe can cancel, a watchdog rebuilds the list", "requestDraw: VRF, 3 confirmations", "anyone settles with the leaf and proof of every ticket the walk draws; one transaction pays all 10"],
        branches: [
          { when: "wallet accepts ETH", then: "its share is pushed in the same transaction" },
          { when: "wallet rejects ETH", then: "that winner claims within 7 days, else the share goes back to the pot" },
          { when: "ticket's wallet already won or is excluded", then: "skipped; the next ticket is drawn" },
        ],
      },
      facts: [
        { k: "Draw window", v: "24 h by default; the AI sets it within 12–24 h (the chain allows 12 h–3 d). A window is drawn only if its rules were anchored on-chain before it opened; otherwise its pot carries over", at: "engine/src/games.ts GAME_POLICY.maxInterval, engine/src/jackpot.ts paramsOf; GamePot.MIN_INTERVAL, MAX_INTERVAL" },
        { k: "Per-wallet cap", v: "2%, or 1% while a draw in the last two windows had 100+ wallets. Wallets above the cap are cut down to it. Chain bounds 0.5% to 2%. The cap is per wallet, so one person can split across wallets", at: "engine/src/tickets.ts capForWindow, CAP_POLICY; GamePot.MIN_CAP_BPS / MAX_CAP_BPS" },
        { k: "Too few wallets", v: "Fewer than 50 eligible wallets: no level fits even a 2% cap, so there is no draw and the pot carries over", at: "engine/src/tickets.ts waterfill" },
        { k: "Minimum balance", v: "1,000 DNA average over the window (chain bounds 100–1,000,000)", at: "engine/src/jackpot.ts JACKPOT_POLICY, GamePot.MIN_BALANCE_FLOOR / CEIL" },
        { k: "List veto", v: "1 h after postList; the list must be posted within 24 h of the window's end", at: "GamePot.LIST_DELAY, LIST_GRACE" },
        { k: "Winners", v: "Ten distinct wallets, equal shares, at most 32 tickets drawn. Fewer wallets in the list means fewer winners; the rest stays in the pot", at: "GamePot.WINNERS, MAX_TICKETS, settle" },
        { k: "Timing target", v: "The AI picks the interval so a draw is worth about 1 ETH, up to 24 h, and changes it only when the move is over 25%", at: "engine/src/games.ts GAME_POLICY" },
        { k: "Prize", v: "min(pot − VRF top-up, 3 ETH), and at least 0.25 ETH (0.025 per winner) or the draw waits. The top-up refills the VRF subscription to 0.1364 ETH (the whole 0.1364 ETH while the subscription is empty), so the first draw needs a pot of 0.3864 ETH", at: "GamePot.PRIZE_CAP, MIN_PRIZE, SUB_MIN" },
        { k: "Pot cap", v: "15 ETH; anything above goes to the buyback", at: "GamePot.POT_CAP" },
        { k: "Gas gate", v: "No draw while the VRF cost would be more than 20% of the prize", at: "GamePot.MAX_COST_BPS" },
        { k: "Payout", v: "Each share pushed with 50,000 gas; the settle reverts rather than starve a push. A failed push becomes a claim within 7 d; after that anyone returns it to the pot", at: "GamePot.PUSH_GAS, CLAIM_WINDOW" },
        { k: "VRF stall", v: "No answer in 36 h: the draw is aborted and the same list is requested again", at: "GamePot.VRF_TIMEOUT" },
        { k: "Excluded on-chain", v: "The Safe, its signers and team wallets, the agent and anchor keys, the protocol contracts, the PoolManager, 0x0 and 0xdEaD", at: "GamePot.isExcluded" },
        { k: "Excluded off-chain", v: "PlatformRevenue, Bootstrap, and exchange wallets listed in the params before the window", at: "engine/src/tickets.ts" },
        { k: "Known limit", v: "The list is fixed before the random number, so a VRF operator who withholds an answer would know the winners first. Bounded by the 3 ETH prize cap", at: "SPEC §13" },
      ],
      links: [
        { label: "GamePot.sol", href: sol("GamePot") },
        { label: "ConvictionVault.sol", href: sol("ConvictionVault") },
        { label: "engine/src/tickets.ts", href: eng("engine/src/tickets.ts") },
        { label: "engine/src/jackpot.ts", href: eng("engine/src/jackpot.ts") },
        { label: "Play: the live pot", href: "/play" },
      ],
    },
  },
  {
    id: "staking",
    title: NAMES.staking,
    dumb: [
      "lock at least 10k $DNA for 12 hours, 3 days or 7 days and it counts 2x, 2.5x or 3x in the jackpot and in votes.",
      "keep it locked and a streak stacks on top, up to 4x total. after the term it still counts 2x.",
      "take it back any time after the term. staking pays nothing out, it just makes your coins count more.",
    ],
    smart: {
      lead: "ConvictionVault holds staked DNA in non-transferable positions. One weight function serves both jackpot tickets and votes.",
      formula: [
        "weight = amount × min(tierMult × streakMult, 40,000) / 10,000",
        "tierMult (hundredths) = 200 / 250 / 300 while the term runs, 200 after",
        "streakMult (hundredths) = 125 at 2 d, 150 at 5 d, 200 at 10 d of position age",
      ],
      facts: [
        { k: "Minimum stake", v: "10,000 DNA", at: "ConvictionVault.MIN_LOCK" },
        { k: "Terms", v: "12 h ×2, 3 d ×2.5, 7 d ×3", at: "ConvictionVault.term, tierMult" },
        { k: "After the term", v: "×2 while it stays staked", at: "ConvictionVault.currentWeight" },
        { k: "Streak", v: "×1.25 at 2 d, ×1.5 at 5 d, ×2 at 10 d", at: "ConvictionVault.streakMult" },
        { k: "Ceiling", v: "×4 combined (a 7 d term at a 10 d streak is ×4, not ×6)", at: "ConvictionVault.MAX_MULT" },
        { k: "Not staked", v: "Held DNA counts ×1 for the jackpot. It does not vote", at: "engine/src/tickets.ts" },
        { k: "Vote eligibility", v: "A position votes once it is 12 h old at the ballot's start", at: "ConvictionVault.MIN_AGE" },
        { k: "Withdraw", v: "Any time after the term in force. recommit starts a new term and keeps the streak", at: "ConvictionVault.withdraw, recommit" },
        { k: "Who can't stake", v: "The Safe, its signers, team wallets and the AI's keys", at: "ConvictionVault.lock" },
      ],
      links: [
        { label: "ConvictionVault.sol", href: sol("ConvictionVault") },
        { label: "engine/src/tickets.ts", href: eng("engine/src/tickets.ts") },
      ],
    },
  },
  {
    id: "votes",
    title: NAMES.votes,
    dumb: [
      "every 2 days the AI puts 3 fee mutations on a ballot, and stakers vote for 24 hours.",
      "the winner goes next in line for testing. it still has to survive the test like everything else.",
      "votes open once 1% of all $DNA is staked. until then the AI picks, and it says so.",
    ],
    smart: {
      lead: "MutationBoard runs ballots over candidate parameter sets. Votes pick what is tested next, never what is kept: the winner still goes through queue, shadow and canary.",
      facts: [
        { k: "Cadence", v: "At most one ballot per 48 h", at: "MutationBoard.BALLOT_EVERY" },
        { k: "Veto", v: "Voting opens 1 h after the proposal. The Safe can cancel a ballot until it is resolved", at: "MutationBoard.VETO_WINDOW" },
        { k: "Voting", v: "24 h, 3 options", at: "MutationBoard.VOTING" },
        { k: "Weight", v: "vault.weightAt(position, ballotStart): staked positions only, streak included. Re-voting moves your weight", at: "MutationBoard.vote" },
        { k: "Winner", v: "Highest tally; ties and an all-zero ballot go to the lowest index", at: "MutationBoard.winner" },
        { k: "Proposer", v: "The agent (level ≥ 5) or the Safe", at: "MutationBoard.MIN_LEVEL" },
        { k: "1% gate", v: "The AI proposes ballots only while ≥ 1% of supply is staked. Below that it runs its own picks, labelled \"AI pick (votes open at 1% staked)\"", at: "engine/src/games.ts ballotMinStakedBps" },
        { k: "On-chain record", v: "ballotRun(ballot, option, registryOpId) while the op is queued, or ballotSkipped(reason)", at: "MutationBoard.ballotRun" },
      ],
      links: [
        { label: "MutationBoard.sol", href: sol("MutationBoard") },
        { label: "engine/src/games.ts", href: eng("engine/src/games.ts") },
      ],
    },
  },
  {
    id: "mystery",
    title: NAMES.mystery,
    dumb: [
      "once a week the AI seals a hidden fee mutation on-chain. nobody can see it or swap it.",
      "it opens about 2 days later (the contract allows 2 to 7) and anyone can reveal it within 24 hours. then it's tested like any other change.",
    ],
    smart: {
      lead: "A commit-reveal on MutationBoard. The payload is a candidate parameter vector; after the reveal it is gated and tested like any other candidate.",
      formula: ["commitment = keccak256(salt32 ‖ payload)"],
      facts: [
        { k: "Seal", v: "seal(commitment, revealAt), revealAt between seal + 2 d and seal + 7 d. One sealed at a time", at: "MutationBoard.REVEAL_MIN, REVEAL_MAX" },
        { k: "Cadence", v: "The engine seals one a week, set to open 2 d 1 h after the seal", at: "engine/src/games.ts mysteryEveryS" },
        { k: "Reveal", v: "Anyone with the salt and payload (≤ 2,048 bytes), within 24 h of revealAt. After that it can be marked broken", at: "MutationBoard.REVEAL_WINDOW, MAX_PAYLOAD" },
        { k: "Outcome", v: "mysteryRun(id, registryOpId) if it passes the gates, else mysteryRejected(id, reason)", at: "MutationBoard.mysteryRun" },
        { k: "Veto", v: "The Safe can cancelSeal", at: "MutationBoard.cancelSeal" },
        { k: "Check it", v: "The Play page recomputes the commitment in your browser after a reveal", at: "web/app/play/MysteryCheck.tsx" },
      ],
      links: [
        { label: "MutationBoard.sol", href: sol("MutationBoard") },
        { label: "Play", href: "/play" },
      ],
    },
  },
  {
    id: "rewards",
    title: NAMES.rewards,
    dumb: [
      "70% of the games pot is the jackpot. 30% pays the people whose ideas the AI ships. the brain sets each amount, and every payment waits one public hour.",
      "a fee idea earns only if it's kept after its test. a build idea earns when the Sequencer ships it.",
      "idea market ideas pay the address that submitted them. X ideas pay the wallet you link by tagging @contractdna with one 0x address. no link within 30 days and the reward is dropped. the link is public, so use a fresh wallet.",
    ],
    smart: {
      lead: "GamePot pays idea rewards from its idea reserve (30% of the games share). The brain picks each amount inside the contract caps; every reward is escrowed, waits 1 h in public, and the Safe can cancel it.",
      flow: {
        steps: ["A build ships, or a fee experiment is kept", "The brain signs a reward record and calls queueReward(to, amount, ideaRef)", "1 h public queue: the Safe can cancelReward"],
        branches: [
          { when: "after 1 h", then: "anyone calls payReward: ETH is sent to the recipient" },
          { when: "push fails", then: "a 7-day claim, like an unclaimed prize; unclaimed, it returns to the jackpot" },
        ],
      },
      facts: [
        { k: "Queue", v: "queueReward(to, amount, ideaRef) by the agent (level ≥ 5, not paused) or the Safe; the amount leaves the reserve at once, into escrow", at: "GamePot.queueReward" },
        { k: "Size", v: "At least 0.01 ETH and at most 25% of the idea reserve per reward", at: "GamePot.queueReward, MAX_REWARD_BPS, MIN_REWARD" },
        { k: "Daily cap", v: "At most 25% of the reserve queued per rolling day (measured at the day's first queue)", at: "GamePot.MAX_REWARD_BPS, dayBudget" },
        { k: "Public hour", v: "Payable 1 h after it is queued. payReward is open to anyone and pays only while the agent is not paused", at: "GamePot.payReward" },
        { k: "Veto", v: "The Safe can cancelReward until it is paid; the escrow goes back to the reserve", at: "GamePot.cancelReward" },
        { k: "Never to", v: "The Safe, the agent, the protocol's contracts or the excluded list: the same set the jackpot excludes", at: "GamePot.isExcluded" },
        { k: "Reserve cap", v: "15 ETH; arrivals above it go to the buyback", at: "GamePot.RESERVE_CAP" },
        { k: "Who is paid", v: "IdeaMarket ideas: the submitter's address, read on-chain. X ideas: the wallet the author's X account linked by posting @contractdna and one 0x address, and nothing else (public; any other words make it no link). The first link counts at once and gets one reply; a change takes effect 48 h later, announced on the site. At most 3 link posts a day", at: "engine/src/bindings.ts BINDING_LIMITS, rewards.ts REBIND_DELAY_MS" },
        { k: "Hold", v: "A reward with no linked wallet, or no room under the caps, waits up to 30 days. Then it is dropped and the money stays in the reserve", at: "engine/src/policy.ts REWARD_HOLD_DAYS" },
        { k: "Status", v: "Fee-idea rewards and X wallet links run now. Build-idea rewards start with the Sequencer's first shipped build", at: "engine/src/idea-queue.ts" },
        { k: "Events", v: "RewardQueued, RewardPaid, RewardCancelled", at: "GamePot" },
      ],
      links: [
        { label: "GamePot.sol", href: sol("GamePot") },
        { label: "Rules for ideas", href: "/rules" },
      ],
    },
  },
  {
    id: "ideas",
    title: NAMES.ideas,
    dumb: [
      "got an idea? post it on X and tag @contractdna. any account works: no badge, account age or follower count. one idea a day, no links.",
      "the AI screens them and the best 16 each day go to the idea market. game and tool ideas count too; the Sequencer builds them.",
      "you can stake $DNA on ideas. backers of picked ideas split the stakes of the ones that lost. if nobody judges a round in time, everyone gets refunded.",
    ],
    smart: {
      lead: "Two doors into IdeaMarket: X mentions, filtered by the engine and submitted by the agent at zero stake, or a direct on-chain submit with a stake. Each 24 h round settles on its own.",
      formula: [
        "A = stake on accepted ideas, R = stake on rejected ideas",
        "accepted position s → s + floor(s × R / A);  rejected → 0;  void → s;  A = 0 → everyone gets s back",
      ],
      flow: {
        steps: ["Post on X tagging @contractdna", "Gate: any account, no links, no duplicates", "Screen: fee / build / impossible / question / chat / joke / shill / spam, scored out of 30; then 1 idea per person per round (live: per UTC day)", "Top 16 of the round submitted at the start of the next"],
        branches: [
          { when: "outcome proposed in time", then: "final 24 h later unless the Safe cancels; accepted backers split the rejected stakes" },
          { when: "no outcome within 3 d", then: "anyone finalizes the round as void: every stake refunded" },
        ],
      },
      facts: [
        { k: "Round", v: "24 h", at: "IdeaMarket.ROUND_LENGTH" },
        { k: "Direct submit", v: "≥ 10,000 DNA opening stake (refundable) + 1,000 DNA burned", at: "IdeaMarket.MIN_SUBMIT, SUBMIT_FEE" },
        { k: "Stake limits", v: "≥ 1,000 DNA per stake; ≤ 1,000,000 per address per round; ≤ 2,000,000 per idea", at: "IdeaMarket.MIN_STAKE, MAX_PER_ADDRESS, MAX_PER_IDEA" },
        { k: "Slots", v: "128 a round: 112 public, 16 for the agent's X intake", at: "IdeaMarket.MAX_IDEAS, MAX_AGENT_IDEAS" },
        { k: "Outcome", v: "The Safe or the agent proposes within 3 d of the round's end; final after 24 h; the Safe can cancel", at: "IdeaMarket.RESOLVE_WINDOW, MIN_DELAY" },
        { k: "Lock-up", v: "At most about 5 d (24 h round + 3 d + 24 h)", at: "SPEC §10.2" },
        { k: "Who judges", v: "\"Accepted\" means picked for implementation after research and a red team. The oracle is the team's agent: the brain judges each round and signs the outcome. It is public for 1 h before the agent proposes it on-chain, and 2 Safe owners can veto it; then the Safe has 24 h to cancel", at: "SPEC §10.1, engine/src/ideas.ts" },
      ],
      links: [
        { label: "IdeaMarket.sol", href: sol("IdeaMarket") },
        { label: "engine/src/ideas.ts", href: eng("engine/src/ideas.ts") },
        { label: "Rules for ideas", href: "/rules" },
      ],
    },
  },
  {
    id: "vaults",
    title: NAMES.vaults,
    dumb: [
      "50 vaults, each an NFT. lock 200k $DNA to mint one, burn it any time and the $DNA comes straight back.",
      "the Safe sends the vaults ETH from the treasury's fee share, split equally across every eligible vault. a new vault joins at the next fund. nothing is promised.",
      "sell a vault and its unclaimed ETH goes with it. 50 pieces of art, one per slot, all equal.",
    ],
    smart: {
      lead: "GenomeVaults is an ERC-721 with at most 50 live tokens. A mint locks exactly 200,000 DNA in the contract; a burn returns it with the vault's unclaimed ETH in the same transaction. Only the Safe funds it, over an exact block window of fee inflows, and the ETH is shared per eligible vault through an accumulator.",
      formula: [
        "fund(fromBlock, toBlock): fromBlock must equal fundedThrough (no window skipped or paid twice); value + carry split per eligible vault, the remainder carried",
        "pending(id) = accPerToken − max(debt, accAfter[mintSeq + 1]); a vault minted since the last fund earns from the one after it",
      ],
      facts: [
        { k: "Live vaults", v: "At most 50; a burned slot goes to the next mint, lowest free slot first", at: "GenomeVaults.MAX_LIVE, _takeSlot" },
        { k: "Deposit", v: "Exactly 200,000 DNA per mint, returned in full by burn; nobody else can move it", at: "GenomeVaults.DEPOSIT, mint, burn" },
        { k: "Funding", v: "The Safe only, over the block window since the last fund, finalized blocks only. The signers decide the amount; their script proposes half of the treasury's fee share in the window", at: "GenomeVaults.fund, engine/scripts/vault-fund.ts" },
        { k: "Eligibility", v: "A vault joins at the first fund after its mint and earns from every fund after that", at: "GenomeVaults.pendingCount, eligible" },
        { k: "Transfer", v: "A standard ERC-721; unclaimed ETH stays with the vault, so a buyer gets it. 2.5% royalty to the Safe", at: "GenomeVaults.ROYALTY_BPS" },
        { k: "Admin", v: "No owner mint, no upgrade. The Safe can pause new mints only, never a burn or a claim", at: "GenomeVaults.setMintPaused" },
        { k: "Art", v: "50 images, one per slot, named in on-chain metadata with a strand that grows with what the vault earned", at: "GenomeVaults.tokenURI" },
        { k: "On X", v: "Every mint, fund and burn is a plain post with its transaction; a reply about the vaults states only what the contract says", at: "engine/src/vaults.ts" },
      ],
      notes: ["The vaults earn only what the Safe sends. A fund is a signed Safe transaction over a public block window; nothing here is automatic, and nothing is promised."],
      links: [
        { label: "GenomeVaults.sol", href: sol("GenomeVaults") },
        { label: "engine/src/vaults.ts", href: eng("engine/src/vaults.ts") },
        { label: "engine/scripts/vault-fund.ts", href: eng("engine/scripts/vault-fund.ts") },
        { label: "Vaults: the 50 slots, the contract and the collection", href: "/vaults" },
      ],
    },
  },
  {
    id: "proof",
    title: "How to check us",
    dumb: [
      "the AI's key lives in a sealed machine (intel tdx, on phala). we can switch it off, but we can't read the key or swap its code without a public trace.",
      "every decision it makes is a signed record, stamped on ethereum. the proof page checks it right in your browser.",
      "the brain runs in that sealed machine now. the proof page asks it for a fresh quote and checks it in your browser.",
    ],
    smart: {
      lead: "Three things are checkable: where the agent key lives, which code holds it, and what it decided. None of it is needed for the safety of your tokens; the contracts bound every key.",
      facts: [
        { k: "Enclave", v: "The agent key is made and kept inside an Intel TDX machine on Phala. Phala's key service releases it only to code on the on-chain allow-list", at: "/proof" },
        { k: "Allow-list", v: "A DstackApp on Ethereum owned by a 1 h timelock: the first code version is allowed when the app is created, every later change waits 1 h in public, and only the Safe can propose or cancel one", at: "/proof" },
        { k: "Status", v: "Live since 11 Oct 2026. The release record (image digest, compose hash, measurements, log key) is pinned, and /proof checks a fresh quote against it", at: "/proof" },
        { k: "Records", v: "Every decision is an enclave-signed record: the model's output plus the chain data it judged, by block hash", at: "engine/src/records.ts" },
        { k: "Brain decisions", v: "Signed records carrying the model and the sha256 of its context and input", at: "engine/src/brain.ts" },
        { k: "Models", v: "The public registry lists every role's model and backup (table on /models). These are the default models. A swap is a signed model-change record: a public tryout on fixed test cases, then a public hour, and the Safe can veto. Swapping the brain itself needs two Safe owners to approve", at: "engine/models.json" },
        { k: "Anchors", v: "anchor(root, uri) on ModuleRegistry. The agent's queue ops wait until their record's anchor is mined; each day's log head is anchored too", at: "ModuleRegistry.anchor" },
        { k: "In your browser", v: "/proof checks a fresh TDX quote, the compose hash and any record's signature", at: "web/app/proof" },
        { k: "From the CLI", v: "node scripts/verify.ts checks the same against Intel's collateral service", at: "engine/scripts/verify.ts" },
        { k: "Jackpot lists", v: "A separate watchdog with no keys rebuilds every ticket list and pages the Safe on a mismatch", at: "engine/scripts/watchdog.ts" },
        { k: "Not claimed", v: "That a text really came from a given model, or that the system is \"trustless\". Trust remains in Intel TDX, Phala's governance and the Safe", at: "/proof" },
      ],
      links: [
        { label: "Proof page", href: "/proof" },
        { label: "Models", href: "/models" },
        { label: "ModuleRegistry.sol", href: sol("ModuleRegistry") },
        { label: "engine/scripts/verify.ts", href: eng("engine/scripts/verify.ts") },
      ],
    },
  },
  {
    id: "safety",
    title: NAMES.safety,
    dumb: [
      "the Safe is a 2-of-3 multisig. it can cancel anything in the public hour, pause the AI, lower its level or roll a change back.",
      "it can't raise the 5% cap, pull the liquidity or touch your coins.",
      "it can queue changes too, but those wait the same public hour and obey the same limits.",
    ],
    smart: {
      lead: "The Safe is a 2-of-3 multisig whose address is immutable in every contract. Its fast powers only stop things; anything else it does goes through the same public 1 h queue as the agent.",
      facts: [
        { k: "Instant brakes", v: "cancel any queued op, pauseAgent, lowerLevel, rollback, endCanary", at: "ModuleRegistry.cancel, pauseAgent, lowerLevel, rollback" },
        { k: "Game vetoes", v: "cancelList (jackpot), cancelBallot, cancelSeal, cancelReward, cancelDrawInterval, cancelOutcome (ideas)", at: "GamePot, MutationBoard, IdeaMarket" },
        { k: "Queued like anyone", v: "register modules, set parameters, promote, raise the level, rotate the agent key, approve bytecode: all public for 1 h first", at: "ModuleRegistry.queue" },
        { k: "Cannot", v: "Change any constant (5% cap, supply, queue delay, split bounds), alter the hook, remove liquidity, move anyone's DNA or staked DNA, or take the jackpot or the idea reserve", at: "SPEC §1, §13" },
        { k: "Receives", v: "The treasury share of project fees (25% today), in ETH", at: "FeeVault.distribute" },
        { k: "Also", v: "Telegram /halt, /mute and /delete for signers: they only stop the engine or its posting, or remove one of its own posts", at: "/proof" },
      ],
      links: [
        { label: "ModuleRegistry.sol", href: sol("ModuleRegistry") },
        { label: "GamePot.sol", href: sol("GamePot") },
        { label: "docs/OPERATIONS.md", href: eng("docs/OPERATIONS.md") },
      ],
    },
  },
  {
    id: "risks",
    title: "Risks",
    dumb: [
      "this can go to zero. it's a new coin run by an experimental AI, and code can have bugs.",
      "the jackpot is a draw, not income. most holders will never win it.",
      "not financial advice. only put in what you're fine losing.",
    ],
    smart: {
      lead: "Read this before you buy, stake or submit anything.",
      facts: [
        { k: "Price", v: "DNA can lose all its value. Nothing here promises a price or a return" },
        { k: "Code", v: "The contracts are new. They have tests, fuzzing, invariant suites and static analysis; no third-party audit is published in the repo", at: "contracts/audit/slither.md" },
        { k: "The fee", v: "From level 6 the AI can move the live fee anywhere in 1%–3.5% once an hour, with no step limit", at: "SPEC §3" },
        { k: "Jackpot", v: "A random draw. The prize is capped at 3 ETH and draws pause when the pot or the gas makes them uneconomic. It is not a yield", at: "GamePot" },
        { k: "Idea market", v: "Stakes on rejected ideas are lost. Funds can be locked about 5 days. The judge is the team's agent and the Safe can veto", at: "IdeaMarket" },
        { k: "Sequencer", v: "AI-written contracts can have bugs. The gates and the Safe lower the risk without removing it. New games start without user deposits" },
        { k: "Dependencies", v: "Intel TDX, Phala, Chainlink VRF, Uniswap v4, Programmable, the three Safe signers and the AI model providers" },
        { k: "Uniswap", v: "A future Uniswap protocol fee would apply on top of DNA's fees", at: "SPEC §2" },
        { k: "Other pools", v: "Anyone can open another DNA pool (Uniswap v2, v3 or v4 without DNA's hook, or another exchange), and nobody can stop it. Trades there pay nothing to the buyback, liquidity, treasury or games; their fees go to whoever funds them. Wallets and aggregators may route through them when they quote better, or before they support the hook. Only the pool on the trade page funds DNA; the engine lists every other one it finds there, with the share of volume they take", at: "DNAHook._beforeInitialize" },
        { k: "Who can play", v: "18+. You decide whether the games are legal where you live" },
      ],
      links: [
        { label: "contracts/SPEC.md", href: eng("contracts/SPEC.md") },
        { label: "Security page", href: "/security" },
        { label: "Trade page", href: "/trade" },
      ],
    },
  },
];
