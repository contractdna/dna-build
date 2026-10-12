// Engine configuration: every knob is an env var with a default here. Secrets (keys, API tokens) only come from env
// (Railway sealed variables) and are never logged or written to the database. The enclave build (ENCLAVE=1, src/enclave.ts)
// refuses to start unless the env is exactly allowed_envs + compose literals, takes RPC hosts from code literals and
// derives the agent and anchor keys in the TEE.
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { ENCLAVE, enclaveKeys, isoWithZone, lockdown, rpcUrls } from "./enclave.ts";
import { model } from "./models.ts";

if (ENCLAVE.on) lockdown();

const env = process.env;
const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export type Deployment = Record<"safe" | "poolManager" | "token" | "hook" | "registry" | "feeVault" | "buybackBurn" | "liquidityVault" | "platformRevenue", Address> & {
  chainId: number; startBlock: number; poolId: Hex; ideaMarket?: Address; bountyBoard?: Address; gamePot?: Address; convictionVault?: Address; mutationBoard?: Address; vrfCoordinator?: Address;
  /** the Sequencer's games (when deployed): the factory that lists them, and the ladder's current GameFunder */
  gameFactory?: Address; gameFunder?: Address;
  /** the funding path's Zodiac modules (contracts/script/FundingSetup.s.sol): the funder key queues through Roles into Delay */
  roles?: Address; delay?: Address;
  /** the engine's code update path: the DstackApp and its owner, the TimelockController the Safe schedules through */
  dstackApp?: Address; codeTimelock?: Address;
  /** the Genome Vaults NFT (contracts/src/GenomeVaults.sol); absent: the vaults are not live, and nothing says they are */
  genomeVaults?: Address;
  /** public labels for addresses the treasury sends DNA to (address → a few plain words, no digits or links, e.g.
   *  "growth team"); the treasury posts look back to `treasuryFromBlock` */
  labels?: Record<string, string>; treasuryFromBlock?: number;
};

export const CHAIN_ID = num(env.CHAIN_ID, 31337);
export const RPC_URLS = ENCLAVE.on ? rpcUrls(env) : (env.RPC_URL ?? "http://127.0.0.1:8545").split(",").map((u) => u.trim());
// DEPLOYMENT_FILE: only for scripts/rehearsal.sh (a mainnet fork must not overwrite the committed deployments/1.json)
export const d: Deployment = JSON.parse(readFileSync(env.DEPLOYMENT_FILE ?? new URL(`../deployments/${CHAIN_ID}.json`, import.meta.url), "utf8"));
/** Pre-launch (ENGINE_PRELAUNCH=1): no deployment yet; only genesis research, journal, drafts and alerts run. */
export const PRELAUNCH = env.ENGINE_PRELAUNCH === "1";
if (!PRELAUNCH && (d.chainId !== CHAIN_ID || /^0x0+$/.test(d.registry))) throw new Error(`deployments/${CHAIN_ID}.json is a placeholder: fill it after launch`);

export type Mode = "live" | "dry_run" | "halted";
export const MODES: Mode[] = ["halted", "dry_run", "live"]; // most → least restrictive
export const ENV_MODE = (env.ENGINE_MODE ?? "dry_run") as Mode;
if (!MODES.includes(ENV_MODE)) throw new Error(`ENGINE_MODE must be one of ${MODES.join("|")}`);

export type KeyName = "agent" | "anchor" | "keeper" | "funder";
export const KEY_NAMES: KeyName[] = ["agent", "anchor", "keeper", "funder"];
const derived = ENCLAVE.on ? await enclaveKeys() : undefined;
/** The enclave log key: signs log records and state rows, never a tx (derived in the TEE; LOG_SIGNING_KEY only in tests). */
export const LOG_KEY = (derived?.log ?? env.LOG_SIGNING_KEY) as Hex | undefined;
// funder: the Sequencer's Roles member (dna/funder): it may only queue GameFunder.fund through Roles → Delay
export const KEYS: Partial<Record<KeyName, Hex>> = derived ? { agent: derived.agent, anchor: derived.anchor, keeper: env.KEEPER_PRIVATE_KEY as Hex | undefined, funder: derived.funder } : {
  agent: env.AGENT_PRIVATE_KEY as Hex | undefined,
  anchor: env.ANCHOR_PRIVATE_KEY as Hex | undefined,
  keeper: env.KEEPER_PRIVATE_KEY as Hex | undefined,
  funder: env.FUNDER_PRIVATE_KEY as Hex | undefined,
};

export const GAS = {
  maxGwei: num(env.MAX_GWEI, 20), // normal ceiling for maxFeePerGas
  emergencyMaxGwei: num(env.EMERGENCY_MAX_GWEI, 200), // breaker rollback, and anything past MAX_DELAY
  valuePct: num(env.GAS_VALUE_PCT, 2), // keeper cost ≤ this % of the value the call moves
  maxDelayMs: num(env.GAS_MAX_DELAY_MS, 24 * 3600_000), // after this long deferred, the guard yields (≤ emergency cap)
  bumpBlocks: num(env.TX_BUMP_BLOCKS, 3),
  pollMs: num(env.TX_POLL_MS, 2000),
  timeoutMs: num(env.TX_TIMEOUT_MS, 10 * 60_000), // give up polling (the job retries; the pending record is resolved first)
  // fee quote (tx.ts quoteFees), from eth_feeHistory over FEE_BLOCKS blocks, never eth_maxPriorityFeePerGas (0 or ~12k
  // wei on public RPCs: a 0 tip is refused by geth pools). Tip = median of the per-block reward at the percentile
  // (blocks < 10% full ignored), never below the floor; maxFee = BASE_FEE_MULT × max(latest, next base fee) + tip
  tipPercentile: num(env.TIP_PERCENTILE, 50),
  emergencyTipPercentile: num(env.EMERGENCY_TIP_PERCENTILE, 90), // `emergency` calls: rollback, reveal, abortDraw, settle…
  tipFloorGwei: num(env.TIP_FLOOR_GWEI, 0.1),
  emergencyTipFloorGwei: num(env.EMERGENCY_TIP_FLOOR_GWEI, 1),
  feeBlocks: num(env.FEE_BLOCKS, 10),
  baseFeeMult: num(env.BASE_FEE_MULT, 2), // 2× survives six full blocks in a row without a bump; only the base fee is paid
  dailyCapEth: {
    agent: num(env.GAS_CAP_ETH_AGENT, 0.1),
    anchor: num(env.GAS_CAP_ETH_ANCHOR, 0.05), // per agent op (≤ 12/day) + the daily head
    keeper: num(env.GAS_CAP_ETH_KEEPER, 0.3), // a 10-winner settle is sent with a 1.8M gas floor
    funder: num(env.GAS_CAP_ETH_FUNDER, 0.02), // a few queued funds a day (Roles → Delay, ~200k gas each) and a skipExpired
  } as Record<KeyName, number>,
};

/** Balance alert thresholds (ETH): alert below `alert`; `min` is what /health flags as not ok. The agent's `min` is one
 *  breaker rollback (214,355 gas) at EMERGENCY_MAX_GWEI (200) = 0.043 ETH; the keeper's adds one settle at its gas
 *  floor (1.8M, games.ts SETTLE_GAS_MIN) at MAX_GWEI (20) = 0.036, so an alert always comes while both are affordable. */
export const BALANCES: Record<KeyName, { min: number; alert: number }> = {
  agent: { min: num(env.MIN_ETH_AGENT, 0.045), alert: num(env.ALERT_ETH_AGENT, 0.05) },
  anchor: { min: num(env.MIN_ETH_ANCHOR, 0.0025), alert: num(env.ALERT_ETH_ANCHOR, 0.005) },
  keeper: { min: num(env.MIN_ETH_KEEPER, 0.08), alert: num(env.ALERT_ETH_KEEPER, 0.15) },
  funder: { min: num(env.MIN_ETH_FUNDER, 0.004), alert: num(env.ALERT_ETH_FUNDER, 0.008) }, // one queued fund at MAX_GWEI = 0.004
};

export const KEEPER = {
  intervalMs: num(env.KEEPER_INTERVAL_MS, 3600_000),
  executeMs: num(env.EXECUTE_INTERVAL_MS, 600_000), // registry ops + IdeaMarket finalize: soon after eta
  distributeMinWei: BigInt(env.DISTRIBUTE_MIN_WEI ?? 5n * 10n ** 16n), // 0.05 ETH (= FeeVault.MIN_DISTRIBUTE)
  claimMinWei: BigInt(env.CLAIM_MIN_WEI ?? 5n * 10n ** 17n), // 0.5 ETH, or weekly
  claimEveryMs: 7 * 24 * 3600_000,
};

export const WATCH = {
  pollMs: num(env.WATCH_POLL_MS, 4000),
  largeSwapWei: BigInt(env.LARGE_SWAP_WEI ?? 5n * 10n ** 18n),
  indexerStaleMs: 5 * 60_000,
};

/** AGENT_LOOP=0: observe, journal, keepers and ideas only (launch days 1–3: observe-only + genesis content). */
export const AGENT_LOOP = env.AGENT_LOOP !== "0";
export const LOG_BASE_URL = env.LOG_BASE_URL ?? "https://genomedna.xyz";
export const PORT = num(env.PORT, 8080);
export const SCHEDULER_MS = num(env.SCHEDULER_MS, 60_000);
/** How ideas reach the sequencer (a compose literal in the enclave):
 *  - rounds: IdeaMarket's on-chain rounds; a round is researched once it closes, its outcome proposed after the public
 *    hour and finalized after the Safe's 24 h, and only then do its accepted ideas queue;
 *  - live: every idea (an X mention past the screen, a site submit) is judged as it comes in and an accepted fee or build
 *    idea queues at once; the Sequencer picks the best one whenever it is free. Holder staking has no say: every
 *    closed round gets an all-void report, so every stake is refunded. */
export const IDEA_MODE = (env.IDEA_MODE || "rounds") as "rounds" | "live";
if (IDEA_MODE !== "rounds" && IDEA_MODE !== "live") throw new Error("IDEA_MODE must be rounds or live");
export const IDEAS_LIVE = IDEA_MODE === "live";
/** The sequencer's pace: at most SEQ_MAX_INFLIGHT builds at once (1-5), and new builds start until SEQ_DAILY_TARGET
 *  builds shipped or are on their way that UTC day (1-10). Code defaults: neither is an allowed env in the enclave, so
 *  the enclave runs 3 and 5 (a change is a new image); the env only sets them outside it (rehearsals, tests). */
const pace = (k: string, v: string | undefined, d: number, max: number) => {
  const n = num(v, d);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${k} must be a whole number from 1 to ${max}`);
  return n;
};
export const SEQ_PACE = { maxInflight: pace("SEQ_MAX_INFLIGHT", env.SEQ_MAX_INFLIGHT, 3, 5), dailyTarget: pace("SEQ_DAILY_TARGET", env.SEQ_DAILY_TARGET, 5, 10) };
/** The public hour of an IdeaMarket outcome report before it is proposed (M1). Not in allowed_envs: 1 h in the enclave. */
export const IDEA_OUTCOME_DELAY_MS = num(env.IDEA_OUTCOME_DELAY_MS, 3600_000);
/** The visible loop. Full cycle every CYCLE_MS; observe (code only, a feed
 *  line per finalized advance) every OBSERVE_MS; an hourly pulse record; a search thread closes into one memory entry
 *  after SEARCH_THREAD_CYCLES cycles without a queued experiment (4 per day at the defaults). */
export const LOOP = {
  cycleMs: num(env.CYCLE_MS, 15 * 60_000),
  observeMs: num(env.OBSERVE_MS, 5 * 60_000),
  pulseMs: num(env.PULSE_MS, 3600_000),
  searchCycles: num(env.SEARCH_THREAD_CYCLES, 24),
};

export const TG = {
  api: env.TELEGRAM_API_BASE ?? "https://api.telegram.org",
  token: env.TELEGRAM_BOT_TOKEN,
  group: env.TELEGRAM_GROUP_ID ? Number(env.TELEGRAM_GROUP_ID) : undefined,
  allow: new Set(list(env.TELEGRAM_ALLOWED_USER_IDS).map(Number)),
  pollTimeoutS: num(env.TELEGRAM_POLL_TIMEOUT_S, 25),
  /** a public chat (a channel's @name or a numeric chat id; a compose literal) the bot also posts the public build and
   *  idea news to (the bot must be an admin there); unset = none */
  publicChat: env.TELEGRAM_PUBLIC_CHAT || undefined,
};

export const X = {
  api: env.X_API_BASE ?? "https://api.x.com",
  clientId: env.X_CLIENT_ID,
  clientSecret: env.X_CLIENT_SECRET, // confidential client → Basic auth on token refresh
  refreshToken: env.X_REFRESH_TOKEN, // seed (and re-auth); rotated tokens live SEALED in the `secret` table
  userId: env.X_USER_ID,
  // ≤ 25 own posts a UTC day, ≥ 20 min apart (≤ 40, ≥ 10 min apart in the launch window). Replies (src/tiers.ts) only to posts that @mention or quote us, from
  // any account (no age, follower or badge gate); an anti-loop brake of ≤ 10 replies an hour to one account, under a
  // safety ceiling of 1,000 a day and 120 an hour. An item queued longer than staleMs is
  // dropped. Mentions are read every minute (X bills per mention returned, not per call)
  dailyPosts: num(env.X_DAILY_POSTS, 25),
  // the launch window: every UTC day the X_LAUNCH_WINDOW_H after LLM_LAUNCH_AT touch, up to X_LAUNCH_DAILY_POSTS a
  // day, ≥ X_LAUNCH_POST_SPACING_MIN apart (src/announce.ts postCaps); the reply caps stay the same
  launchDailyPosts: num(env.X_LAUNCH_DAILY_POSTS, 40),
  launchSpacingMs: num(env.X_LAUNCH_POST_SPACING_MIN, 10) * 60_000,
  launchWindowMs: num(env.X_LAUNCH_WINDOW_H, 48) * 3600_000,
  dailyReplies: num(env.X_DAILY_REPLIES, 1000),
  hourlyReplies: num(env.X_HOURLY_REPLIES, 120),
  repliesPerAuthorHour: num(env.X_REPLIES_PER_AUTHOR_HOUR, 10),
  spacingMs: num(env.X_POST_SPACING_MIN, 20) * 60_000,
  staleMs: num(env.X_STALE_HOURS, 6) * 3600_000,
  mentionsMs: num(env.X_MENTIONS_INTERVAL_MS, 60_000),
  // X's written approval for AI replies (a compose literal in the enclave). Until then: important accounts get a drafted
  // reply a signer releases with Send in Telegram; nobody else gets an AI reply
  aiRepliesApproved: env.X_AI_REPLIES_APPROVED === "1",
  // approved: every eligible author gets an automatic reply, important accounts too. X_HOLD_IMPORTANT=1 (default off)
  // puts an important account's reply back behind a signer's Send tap
  holdImportant: env.X_HOLD_IMPORTANT === "1",
  sendMs: num(env.X_SEND_INTERVAL_MS, 20_000), // x:send drains one outbox item per run (≤ 180 an hour: room for the reply ceiling)
};
/** Post media. The studio (outside the enclave) generates art; the enclave re-checks it, draws the facts and decides:
 *  a card that passes every check posts on its own. */
export const MEDIA = {
  studioUrl: env.STUDIO_URL?.replace(/\/$/, "") || undefined, // "" = no studio: plates at once
  studioToken: env.STUDIO_TOKEN, // sealed: the enclave's bearer token at the studio
  waitMs: num(env.MEDIA_WAIT_MIN, 20) * 60_000, // then a fallback plate (posts are ≥ 20 min apart anyway)
  visionModel: model("vision"), // models.json (MEDIA_VISION_MODEL overrides outside the enclave)
  dir: new URL("../media/", import.meta.url),
};

// the rotated X refresh token is sealed before it is stored (src/sealed.ts): no seal key = fail at boot, not after a
// refresh has already spent the single-use token
if (X.clientId && !ENCLAVE.on && !/^(0x)?[0-9a-f]{64}$/i.test(env.SECRET_SEAL_KEY ?? "")) throw new Error("SECRET_SEAL_KEY (32 bytes hex) is required when X_CLIENT_ID is set");

export const LLM = {
  mode: (env.LLM_MODE ?? "live") as "live" | "record" | "replay",
  fixtures: new URL(env.LLM_FIXTURES ?? "../test/fixtures/llm/", import.meta.url),
  // Hard caps (src/llm.ts dailyCap/overCap). Daily: week1DailyCapUsd for the 7 days after launchAt, then dailyCapUsd
  // (LLM_DAILY_CAP_USD is accepted as an alias); with a treasury income reading, never above treasuryCap(income).
  // The day's cap is split: the Sequencer (budget dev) gets devPct of it, everything else shares the rest (research
  // pauses at pauseAt.research of that shared part, the others at all of it). Monthly: the calendar month's total
  // bounds every budget; dev pauses at devMonthlyPct of it, research at pauseAt.research. Keepers never call a model.
  dailyCapUsd: num(env.LLM_DAILY_USD_CAP ?? env.LLM_DAILY_CAP_USD, 300),
  week1DailyCapUsd: num(env.LLM_WEEK1_DAILY_USD_CAP, 300),
  launchAt: env.LLM_LAUNCH_AT ? Date.parse(env.LLM_LAUNCH_AT) : undefined, // ISO with Z or an offset; a compose literal in the enclave
  monthlyCapUsd: num(env.LLM_MONTHLY_USD_CAP, 3000),
  subCapsUsd: {
    research: num(env.LLM_CAP_RESEARCH_USD, 20),
    redteam: num(env.LLM_CAP_REDTEAM_USD, 40),
    rest: num(env.LLM_CAP_REST_USD, 40), // Main (hypothesis, decide), the brain, narration, lessons, journal, readers
  } as Record<string, number>,
  devPct: 0.65, // the Sequencer's share of each day's cap: $195 of $300; four $48 reservations (4 orders × $12) fit, so 3 builds run with room for charges
  devMonthlyPct: 0.6,
  orderCeilingUsd: 12, // one Sequencer order at most; lower when the day's dev share is below 4 × this
  pauseAt: { research: 0.8 } as Record<string, number>,
  treasury: { share: num(env.LLM_TREASURY_SHARE, 0.5), floorUsd: num(env.LLM_TREASURY_FLOOR_USD, 20) },
  alertPct: 0.7,
  // every model call goes through OpenRouter (the engine's own key) except server-side search (web/X), which keeps a direct xAI key
  openrouterKey: env.OPENROUTER_API_KEY_ENGINE,
  openrouterApi: env.OPENROUTER_API_BASE ?? "https://openrouter.ai/api",
  xaiKey: env.XAI_API_KEY,
  xaiApi: env.XAI_API_BASE ?? "https://api.x.ai",
  // per server-side tool call when xAI's usage doesn't report cost: web_search $5/1k calls; x_search bills $5/1k posts
  // fetched (no max-results knob), so assume ~10 posts → $0.05/call (conservative; docs.x.ai/developers/pricing)
  searchUsdPerCall: num(env.XAI_SEARCH_USD_PER_CALL, 0.05),
  // input tokens one search turn adds to the context (src/llm.ts estimateUsd). A live research call with 2 turns read
  // 294,675 input tokens over its 3 passes (~98K per turn); 120K leaves headroom
  searchTokensPerTurn: num(env.XAI_SEARCH_TOKENS_PER_TURN, 120_000),
};
if (env.LLM_LAUNCH_AT && !isoWithZone(env.LLM_LAUNCH_AT)) throw new Error("LLM_LAUNCH_AT must be an ISO date-time with Z or an explicit offset");
