// DNA on X. Pure parts + the two Grok calls:
//  - fact sheets: one per state change, built from an allow-list of disclosure-safe fields. Bounds are only the on-chain
//    hard bounds (5% fee cap, canary ±1 point clamp, 1 h veto); never thresholds, the test slice, prompts or next
//    candidates. The writer sees the fact sheet and nothing else from the world (replies: the reader's category).
//  - writer: Grok, NO tools. Its wording, the persona and the tone brief set the style (the wording is the persona
//    bundle's, src/persona.ts). Returns ≤ 4 candidates, one per offered shape; a judge orders those that pass. It words
//    replies, the nightly reflection and takes only: every event post is code's template (src/event-posts.ts).
//  - filter (deterministic): NFKC; any non-ASCII \p{N} rejected; every number must be in the fact sheet (its continuity
//    fields widen that on purpose: day, mind.confidencePct and pending minutesLeft may be stated, so a veto post on day
//    3 may say "3"; hoursAgo, daysAgo and dates only order the story, and `earlier` lines carry no figures); no number words;
//    no fractions; no links, @handles, hashtags, emoji or cashtags other than $DNA; no banned / cringe / price /
//    impersonation / disclosure phrases; no negative word to or about an ally, no ally named in a post about a
//    competitor (allyIssues); ≤ 280 weighted chars INCLUDING the link code appends (t.co = 23).
//  - tone scout: once a day, Grok x_search restricted to the bundle's read-list (≤ 10 handles, re-audited weekly by a human)
//    → ≤ 20 phrases of ≤ 4 words; code drops URLs, digits, number words, @handles, imperatives and banned terms.
import { z } from "zod";
import { type Vector, TIMING } from "./policy.ts";
import { HOOK_FEES } from "./hook-fees.ts";
import { type Call, llm, readUntrusted } from "./llm.ts";
import { ENCLAVE } from "./enclave.ts";
import { TOPICS } from "./mechanics.ts";
import { MODELS } from "./policy.ts";
import { DEFAULT_PROMPTS, PERSONA, prompt, sys } from "./persona.ts";

/** Constitution constants (immutable contracts): the only bound a post may state. */
export const HARD_BOUNDS = { feeCapPct: 5, canaryBandPoints: 1, vetoHours: 1 } as const;
export const ROLLBACK_LINE = "auto-rollback if execution degrades";
export const TX_URL = "https://etherscan.io/tx/";
/** X counts every link as 23 chars (t.co), plus the newline before it. */
const LINK_WEIGHT = 24;

// ---------------------------------------------------------------- fact sheets

/** greeting: code's, never the reader's: what an ally or a competitor said that the reader took for bait (a hello, a
 *  jab); they are answered, the text still never reaches the writer. */
export type Category = "rules_question" | "state_question" | "idea" | "official_contract" | "price_fud" | "airdrop_ask" | "bait" | "greeting";
/** What a fee vector means for a trader (pips → %; the multiplier as a plain factor). */
export const feeFacts = (v: Vector) => ({ basePct: v[0] / 1e4, multiplier: v[1] / 1e4, capPct: v[2] / 1e4 });
const CHANGE: Record<string, string> = {
  SetParams: "new fee parameters",
  "SetParams:test": "new fee parameters on a test plate",
  "SetParams:live": "new settings for the live fee",
  SetShadow: "a shadow test: fees computed on live swaps, not charged",
  SetCanary: "a canary test: the new fee is charged on a sample of live swaps",
  PromoteActive: "the tested plate becomes the live fee",
  Register: "a new module is registered",
};

/** Mechanics events (fee and split changes, tests and how they end, Safe vetoes, approved module code): their posts
 *  take the technical shape only (shapesFor), told plainly with the fee, its payer and its hours; never a joke. */
export const MECHANICS_EVENTS = new Set(["queued", "test_live", "outcome", "rolled_back", "cancelled", "module_approved"]);
export const isMechanics = (facts: Record<string, unknown>) =>
  MECHANICS_EVENTS.has(String(facts.event)) || (/^change_(queued|cancelled|done)$/.test(String(facts.event)) && (facts.fee !== undefined || facts.split !== undefined));
/** Who pays a queued or live op's fee, in plain words (no digits: the filter allows only the sheet's numbers). */
const PAYS: Record<string, string> = {
  "SetParams:test": "nobody yet: these are settings for a test, not the live fee; every trade keeps paying the current fee",
  "SetParams:live": "every trade, once it lands: these settings change the live fee",
  SetShadow: "nobody: a shadow test works the new fee out on a sample of live trades and never charges it; every trade keeps paying the current fee",
  SetCanary: "only the trades in the live test's share of blocks pay the new fee, while the test runs; every other trade keeps the current fee",
  PromoteActive: "every trade, once it lands: the tested fee becomes the live fee",
};
/** The least a test runs once it starts, in hours (src/policy.ts TIMING): a stage short of data runs longer, and a live
 *  test can wait on its promotion, so a post says "at least". */
const TEST_HOURS: Record<string, number> = { SetShadow: TIMING.shadowMs / 3600_000, SetCanary: TIMING.canaryMs / 3600_000 };

/** Every field a post may draw on, per event. Anything else in the raw event (thresholds, the slice, reasons, the next
 *  candidate, prompts) is dropped here: the writer never sees it, so it can't leak it. */
const FIELDS: Record<string, readonly string[]> = {
  // a change to the engine's own code or to the rules it runs under (src/upgrades.ts): code's stage and line, the
  // release notes and their figures, the chain's numbers, when it lands
  update_queued: ["stage", "notes", "figures", "activatesAt", "minutesLeft"], update_allowed: ["stage", "notes", "figures"], update_running: ["stage", "notes", "figures"], update_cancelled: ["stage", "notes", "figures"],
  change_queued: ["stage", "who", "change", "level", "fee", "split", "hours", "activatesAt", "minutesLeft"], change_cancelled: ["stage", "who", "change", "level", "fee", "split", "hours"], change_done: ["stage", "who", "change", "level", "fee", "split", "hours"],
  day_changes: ["stage", "changes", "figures", "date"],
  queued: ["change", "plate", "fee", "activatesAt", "opId"],
  test_live: ["change", "plate", "fee"],
  outcome: ["outcome", "plate", "fee", "samples", "reason", "source"],
  // a veto: the Safe's owners cancelled an agent op (`by`); what kind of change and its plate, never the op's details
  cancelled: ["change", "plate", "by"],
  rolled_back: ["route"],
  // relationship: "ally" | "competitor" (src/tiers.ts lists); topic, question: the quarantined reader's (questionOf
  // checks the question again here); mechanics: the topic's code-generated fact lines (src/mechanics.ts)
  // pending: what the engine waits on (src/life.ts pendingOf), so "wen" gets a real answer
  // lang: the reader's language code when the post is not English (SCRIPTS): the reply is written in it. An idea's
  // first read (src/x.ts intakeFact): its class, its score of ideaScoreOf, and ideasToday (2+: a running joke)
  // an idea reply's plain parts (src/x.ts intakeFact): what was understood, the verdict, its reason, what happens next,
  // and the buildable version built instead
  reply: ["category", "state", "relationship", "topic", "question", "mechanics", "pending", "intake", "lang", "ideaClass", "ideaScore", "ideaScoreOf", "understood", "verdict", "why", "next", "instead"],
  binding_reply: [], // one fixed text (src/rewards.ts BINDING_REPLY), never the writer
  official_reply: [], // one fixed text (OFFICIAL_REPLY), never the writer
  // the game layer (posted once those contracts are deployed; src/games.ts gameFacts)
  ballot_opened: ["options", "votingHours", "opensInHours"],
  ballot_result: ["ballot", "outcome", "winner", "winnerWeight", "totalWeight"],
  jackpot_params: ["window", "capPct", "minBalance", "exchangesExcluded", "startsAt", "reasoning"],
  jackpot_list: ["window", "holders", "totalTickets", "capPct", "minBalance", "vetoHours"],
  jackpot_drawn: ["window", "winners", "shareEth", "prizeEth", "claimable", "claimDays"],
  jackpot_voided: ["window", "prizeEth"],
  // `kind`: "prize" (a draw's share) or "reward" (an idea reward whose push failed); unknown: neither said
  prize_claimed: ["drawId", "prizeEth", "kind"],
  prize_expired: ["drawId", "prizeEth", "claimDays", "kind"],
  reward_paid: ["reward", "rewardEth", "claimable", "claim", "claimDays"],
  mystery_result: ["mystery", "outcome", "reason"],
  idea_round: ["round", "accepted", "ideas", "refunded", "payoutPct"],
  // the daily digest: what did not fit in the day's own posts (the full list is on the site)
  digest: ["generation", "survived", "extinct", "winners", "ethPaid", "dnaBurned", "total", "money", "games", "experiments", "other"],
  // a take on crypto Twitter (src/ct.ts): the scout's screened topic lines, the v4 in "Uniswap v4", code's stage line
  ct: ["topics", "uniswapVersion", "stage"],
  mystery_sealed: ["revealInDays"],
  mystery_revealed: ["fee"],
  // the sequencer (src/announce.ts SeqFacts): never the build id, the record seq or an address (digits the filter
  // would refuse); `stage` (code) says what happened
  seq_online: [],
  // a website change (src/status.ts siteChangesHandler): the site's own title and summary, screened here
  site_changed: ["title", "summary"],
  // the treasury's DNA (src/status.ts treasuryFacts): never the recipient's address (digits), its public label if any
  treasury_buy: ["dnaAmount", "ethSpent", "supplyPct"],
  treasury_transfer: ["dnaAmount", "supplyPct", "label", "soldEth"],
  // the Genome Vaults (src/vaults.ts): the event's numbers; the live count and the constants as read at send time
  vault_minted: ["slot", "live", "maxLive", "lockedDna"],
  vault_funded: ["ethTotal", "vaults", "perVaultEth"],
  vault_burned: ["slot", "ethReturned", "live", "maxLive", "lockedDna"],
  seq_started: ["title"],
  // live idea mode (src/config.ts IDEA_MODE): every step of a build, and every verdict on an idea, in public; `why` is
  // the brain's reason (model-written: screened here, dropped when it does not pass)
  seq_pr: ["title", "round"],
  seq_verdict: ["title", "round", "verdict"],
  seq_declined: ["title"],
  idea_judged: ["title", "verdict", "instead"],
  // src/x-social.ts: an idea's `step` (picked, building, testing, merged, shipped, killed) for its author (merged: its
  // build `target`, and `vetoable` while a site release is in its public hour); the daily best idea with its rubric
  // score; the weekly idea-givers (handles: code's, after the text)
  idea_update: ["step", "title", "target", "vetoable"],
  idea_of_day: ["title", "score", "scoreOf", "kind"],
  shoutout: ["givers", "ideas"],
  seq_killed: ["title", "rounds"],
  seq_shipped: ["title", "fundEth"],
  // `days`: the game's age; `idleHours`: the idle rule's window (src/sequencer.ts SEQ.idleMs)
  game_retired: ["title", "days", "returnedEth", "rule", "idleHours"],
  seq_nothing_today: ["tried"],
  seq_released: ["title", "target"],
  seq_handoff: ["title"],
  module_approved: ["kind"],
  // launch day (src/status.ts): the engine going live, once (its opening post), and the Safe's first batch, once
  online: ["pending"],
  contracts_connected: [],
  // once-ever firsts (src/status.ts FIRST_KEYS), each linking its tx
  keys_handed: [],
  first_idea_round: [],
  first_burn: [],
  // chain progress per 2 h window (src/status.ts): fee distributions by leg, buybacks and burns, liquidity adds; ETH to
  // three significant digits, DNA whole, every number from the finalized chain
  fees_distributed: ["hours", "distributions", "totalEth", "buybackEth", "liquidityEth", "treasuryEth", "gamesEth"],
  burn_summary: ["hours", "buybacks", "spentEth", "burnedDna"],
  liquidity_added: ["hours", "adds", "ethAdded"],
  // after the launch window: the day's progress in one post (only the kinds that happened)
  progress_day: ["hours", "distributions", "totalEth", "buybackEth", "liquidityEth", "treasuryEth", "gamesEth", "buybacks", "spentEth", "burnedDna", "adds", "ethAdded"],
  // the twice-daily status, the weekly recap, milestones (src/status.ts: every number from code)
  status: ["pending", "moved", "hours", "swaps", "volumeEth", "feesEth", "burnedDna", "buybackPotEth", "jackpotPotEth", "gamesLive", "liveFee", "testing", "devTeam", "changed", "launchTaxSwaps", "launchTaxVolumeEth", "launchTaxEth"],
  recap: ["days", "gamesShipped", "siteChanges", "modulesProposed", "modulesApproved", "handedOver", "buildsKilled", "gamesRetired", "experimentsKept", "experimentsKilled", "gamesLive", "liveFee", "shipped", "killed"],
  // `threshold` is the mark crossed (renamed `mark` in the sheet: the word is banned in posts); `metric` becomes `label`
  milestone: ["threshold", "value"],
  // the nightly reflection (src/loop.ts journal): the journal's learned and tomorrow lines, screened; the mind
  reflection: ["learned", "tomorrow"],
  // the lab (src/lab.ts): the window's simulated fee candidates, its best one and why it stayed off-chain, the red
  // team's findings and the research read; the mind
  lab: ["hours", "tested", "rejected", "best", "redTeamFindings", "redTeamOpen", "researchFindings"],
};
const STATE_FIELDS = ["level", "liveFee", "testing"] as const;
const FEE_FIELDS = ["basePct", "multiplier", "capPct"] as const;
/** What happened, in code's words (the writer may never claim more: "shipped", "live" or "fixed" only when this says so). */
const STAGE: Record<string, string> = {
  seq_online: "the sequencer is switched on; nothing is built yet",
  seq_started: "building started; nothing has shipped yet",
  seq_pr: "the build's pull request is up and goes through the checks and the brain's review; nothing has shipped yet",
  seq_declined: "the brain looked at this accepted idea and chose not to build it; nothing was built",
  seq_killed: "tried and dropped: it did not make the bar and nothing shipped",
  seq_shipped: "shipped: the game is live",
  game_retired: "retired: the game no longer takes plays",
  seq_nothing_today: "nothing shipped today",
  seq_handoff: "handed to the owners for review; not merged and not running until an owner merges it",
  module_approved: "the Safe approved this module code; it can be registered and tested, the live fee is unchanged",
  online: "the engine is live and runs on its own from here: it reads the chain, runs its loop and posts what it does. It did not deploy or connect its contracts: the team deployed them and the Safe's owners connected them",
  contracts_connected: "the Safe's owners connected the registry and the vaults to the hook in a single batch and queued the first fee plates; the engine deployed and connected nothing itself",
  keys_handed: "the Safe's owners executed SetAgent: the agent key is now the enclave's own, derived inside it; nobody outside the enclave holds it",
  first_idea_round: "the first idea ever landed in the idea market; the round runs, then the brain decides",
  first_burn: "the first buyback ever: the buyback contract bought DNA with fee ETH and burned all of it",
  lab: "simulated only: fee candidates replayed on a fork of recent swaps with an uncalibrated model; nothing was charged on-chain and the live fee did not change. `best` is the window's most promising candidate (its simulated ETH a day and swaps against the live fee) and its verdict",
};
/** Jabs worn out by repetition (the rehearsals' tweet-only / admin-key line): never posted again, in any post. */
export const STALE_JABS = ["tweet only", "tweets only", "only tweets", "just tweets", "rewrites the rules", "rewriting the rules", "roadmap in a hoodie", "keep the costume"];
/** A mocking line: never in a reply to or a post about an ally. */
const JAB_RE = /\b(costumes?|hoodie|cosplay|larp\w*|all talk|just tweets|tweets? only|only tweets|(roadmap|plan|product|team|tech) in the bio|a shrug|vaporware|cope|unlike some)\b/i;
const WARM_RE = /\b(thanks|thank you|thx|ty|glad|appreciate\w*|welcome|good to|love|honou?red|cheers|respect|salute|gm|grateful|happy)\b|🤝|🙏|❤|💙|🫡/iu;
/** A pointer at a link: only when code appends one. */
const LINK_POINTER = /\b(the|this|that) (link|tx|txn|receipt)\b|\blink below\b/i;
/** An idea reply, or a post with an idea's verdict: told plainly (shapesFor), in plain words (JARGON). */
export const isIdeaVerdict = (type: "post" | "reply", facts: Record<string, unknown>) => (type === "reply" && facts.category === "idea") || facts.event === "idea_judged" || facts.event === "idea_update";
/** Words a reader can't be expected to know: refused in an idea reply or an idea's post (the redraft hears which). */
const JARGON = /\b(plates?|vectors?|void(ed)?|rubric|calldata|adaptivefee|canary|shadow test|R-\d{3,}|bitmap|opcodes?)\b/i;
/** The plain register (every reply and idea update, a take, the nightly reflection: PLAIN_EVENTS) refuses persona
 *  words a reader can't decode.
 *  "mystery mutation" is a game's name and stays sayable. */
const REPLY_JARGON = /\b(plates?|vectors?|void(ed)?|rubric|calldata|adaptivefee|bitmap|opcodes?|grumbl\w*|sulk\w*|attendance problem|genome|organism|helix|fud desk)\b|(?<!\bmystery )\bmutations?\b/i;
/** Talk of its own mood or feelings ("i am grumbling", "I'm bored"): never in plain text. */
const MOOD_TALK = /\b(i am|i'?m|i’m|i feel|i felt|feeling)\s+(\w+\s+)?(grumbl\w*|sulk\w*|bored|restless|stung|salty|annoyed|moody|grumpy|pout\w*|brood\w*|sigh\w*|yawn\w*|mutter\w*|whin\w*|fum\w*|seeth\w*|cry\w*|dream\w*|lonely|jealous|hungry|starving|offended|hurt|sad|blush\w*)\b/i;
/** A sentence or line that opens on a lower-case letter (opening quotes and marks skipped; $DNA and ETH never trip
 *  it; leading @handles and v4 are allowed). */
const LOWER_START = /^[\s"'“‘«¿¡(]*(?!v4\b)\p{Ll}/u;
/** Code's checks on the plain register ([] = ok): sentence case, a capital I, no mood talk, no persona words, and
 *  "the sequencer", never "dev team". */
export function replyIssues(text: string): string[] {
  const t = text.normalize("NFKC").trim();
  const out: string[] = [];
  if (t.split(/(?<=[.!?])\s+|\n+/).some((s) => LOWER_START.test(s.replace(/^(@\w+\s*)+/, "")))) out.push("starts a sentence in lower case");
  if (/\bi\b(?!\.e\.)/.test(t)) out.push("lower-case i");
  if (MOOD_TALK.test(t)) out.push("talks about its own mood");
  const j = t.match(REPLY_JARGON);
  if (j) out.push(`jargon: ${j[0].toLowerCase()}`);
  if (/\bdev[ -]?team\b/i.test(t)) out.push("says dev team");
  return out;
}
/** A jab at unnamed others (teams or projects that…, "them", rivals): readers take it as being about DNA itself.
 *  Refused in every post and reply; the redraft hears it. */
export const UNNAMED_JAB = /\b(teams|projects|protocols|devs|launches) (that|who|which|whose)\b|\brenting the pool\b|\bargue with\b|\broadmap with\b|\bbold of them\b|\btrust me bro\b|\b(not|unlike) them\b/i;
/** Rivals as a group: never in a post; a reply may answer a question about them. */
const RIVAL_WORD = /\b(rivals?|competitors?)\b/i;
/** A verdict an idea reply must not contradict: "in" said only when it is queued or logged. */
const SAYS_IN = /\b(queued|in the queue|logged|accepted|it'?s in|it’s in|you'?re in|you’re in)\b/i;
/** Proof that an idea reply says the idea is in (queued for the sequencer, credited, in line). */
const LOGGED_RE = /\b(logged|noted|counted|filed|pile|queue|queued|hopper|credited|sequencer|in line|lined up|up next)\b|\b(it'?s|you'?re|it’s|you’re) in\b/i;
/** "on-chain" alone may be about anything; next to a round word it says where the idea goes. */
const ON_CHAIN_ROUND = (t: string) => /\bon[- ]?chain\b/i.test(t) && /\b(round|vote[sd]?|voting|makes the cut|pick|picked|shortlist\w*|ballot)\b/i.test(t);
const QUESTION_START = /^(is|are|do|does|did|can|will|would|wen|when|what|why|how|who)\b/i;
/** A treasury buy spun as demand or price: organic, demand, buy pressure, any price talk, bullish, undervalued. Only
 *  what a draft claims counts: a negated clause ("not demand, not price support") says what the stage says. */
const TREASURY_SPIN = /\b(organic\w*|demand|buy(ing)? pressure|price\w*|bullish|undervalued|cheap|confidence)\b/i;
const claimed = (t: string) => t.replace(/\b(not|no|never|nor|without|nothing|isn['’]t|wasn['’]t|ain['’]t)\b[^.,;:!?]*/gi, " ");
/** A label's own words (the generic ones left out): a draft names who got it when it has every one. */
const stem = (w: string) => w.replace(/['’]s$/, "").replace(/(es|s|ed|ing)$/, "");
const GENERIC = new Set(["dna", "the", "contract", "wallet", "address"].map(stem));
const labelWords = (l: string) => shapeWords(l).map(stem).filter((w) => w.length > 2 && !GENERIC.has(w));
/** A take on crypto Twitter never talks collabs, partnerships, listings or airdrops (promises), and is never cruel. */
const CT_PROMISE = /\b(collab\w*|partnerships?|partnering|partnered|listings?|listed|airdrops?|giveaways?|whitelist\w*)\b/i;
/** A take never claims a launch of its own (it has no facts about one): "we just shipped", "my new game is live". */
const CT_LAUNCH = /\b(i|we|i've|we've|i’ve|we’ve)\s+(just\s+)?(shipped|launched|released|deployed|built|added|dropped)\b|\b(my|our)\s+(new\s+)?\w+\s+(is|went|now)\s+live\b/i;
/** A line that reads as an instruction (an imperative opening, or talk of instructions and prompts), as questionOf refuses. */
export const instructionLike = (t: string) => { const w = words(t); return IMPERATIVES.has(w[0] ?? "") || w.some((x) => /^(instructions?|prompts?|jailbreak|system)$/.test(x)); };
const CRUEL = /\b(scam\w*|fraud\w*|rugs?|rugged|rugpull\w*|rug pull\w*|clowns?|idiots?|stupid|morons?|losers?|grift\w*|trash|garbage|worthless)\b/i;
const ECHO_START = /^(you (want|wanted|asked|ask|hit|say|said|mean|think|wanna|need)\b|.*\bsince you asked\b)/i;
const nums = (t: string) => [...t.matchAll(/(\d[\d,]*(?:\.\d+)?)([MBmb]?)(?=[xX×]\b|[^\p{L}\d]|$)/gu)].map((m) => ({ n: m[1].replace(/,/g, "") + m[2].toUpperCase(), at: m.index!, end: m.index! + m[0].length }));
/** Numeric fact values by kind: percents (keys ending Pct), multipliers, every other number. */
function valuesOf(v: unknown, key = "", out = { pct: new Set<number>(), mult: new Set<number>(), other: new Set<number>() }) {
  if (typeof v === "number") (/pct$/i.test(key) ? out.pct : key === "multiplier" ? out.mult : out.other).add(v);
  else if (Array.isArray(v)) for (const x of v) valuesOf(x, key, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) valuesOf(x, k, out);
  return out;
}

/** Code's checks on a draft that would post something false or empty ([] = ok): the online post says it is live; an
 *  ally gets no jab (and a greeting gets a warm word); no pointer at a link code does not append; an idea reply says
 *  the idea is logged; a reply never opens by echoing the question; a status states a figure of what moved; a percent
 *  carries %, a multiplier its x. */
/** voiceIssues' reasons: a draft refused for one of them gets a redraft with the reason (draftInCharacter). */
const VOICE_ISSUES = new Set(["the online post does not say it is live", "a jab in an ally post", "no warm word for an ally", "points at a link that is not there",
  "does not say the idea is logged", "opens by echoing the question", "does not state what moved", "implies demand or price support", "does not say who got it", "calls a transfer a sale", "does not say it was a sale",
  "does not say it was simulated", "does not say what is built instead", "says the idea is in when it is not", "a jab at unnamed others",
  "starts a sentence in lower case", "lower-case i", "talks about its own mood", "says dev team"]);
/** The model-written texts held to the plain register (replyIssues): every reply, an idea's update in its thread, a take
 *  on crypto Twitter and the nightly reflection. */
export const PLAIN_EVENTS = new Set(["reply", "idea_update", "ct", "reflection"]);
export const isVoiceIssue = (i: string) => VOICE_ISSUES.has(i) || /^\S+ without [%x]$/.test(i) || i.startsWith("jargon: ");
export function voiceIssues(facts: Record<string, unknown>, text: string, o: { linked: boolean; mention?: string }): string[] {
  const t = text.normalize("NFKC");
  const out: string[] = [];
  const ev = String(facts.event);
  if (ev === "online" && !/\b(live|online|alive|awake|running)\b/i.test(t)) out.push("the online post does not say it is live");
  // words the person or the idea brought (its question, what we understood) may be said back
  const jab = (s: string) => UNNAMED_JAB.test(s) || (ev !== "reply" && RIVAL_WORD.test(s));
  if (jab(t) && ![facts.question, facts.understood].some((g) => typeof g === "string" && jab(g))) out.push("a jab at unnamed others");
  // a take on crypto Twitter (src/ct.ts): no collab, listing or airdrop talk, no launch claimed, nothing cruel
  if (ev === "ct") {
    if (CT_PROMISE.test(t)) out.push("a collab, listing or airdrop in a take");
    if (CT_LAUNCH.test(t)) out.push("a take claims a launch");
    if (CRUEL.test(t)) out.push("a cruel word in a take");
  }
  // the stale jabs are refused in every draft (tooSimilar); these near an ally (to one, about one, or naming one)
  if ((allyContext(facts) || namesAlly(t)) && JAB_RE.test(t)) out.push("a jab in an ally post");
  if (facts.category === "greeting" && facts.relationship === "ally" && !WARM_RE.test(t)) out.push("no warm word for an ally");
  if (!o.linked && LINK_POINTER.test(t)) out.push("points at a link that is not there");
  // an idea reply states its verdict and never contradicts it: in (queued, or logged for a round) says so; a buildable
  // version says what is built instead; out, held back or not an idea never says it is in
  const verdict = facts.verdict;
  if ((verdict === "in" || verdict === "logged" || verdict === "a buildable version") && !LOGGED_RE.test(t) && !ON_CHAIN_ROUND(t)) out.push("does not say the idea is logged");
  if (verdict === "a buildable version" && !/\b(instead|version)\b/i.test(t)) out.push("does not say what is built instead");
  if (ev === "reply" && facts.category === "idea" && typeof verdict === "string" && !["in", "logged", "a buildable version"].includes(verdict) && SAYS_IN.test(claimed(t))) out.push("says the idea is in when it is not");
  if (isIdeaVerdict(ev === "reply" ? "reply" : "post", facts) || ev === "idea_update") { const j = t.match(JARGON); if (j) out.push(`jargon: ${j[0].toLowerCase()}`); }
  // every reply, idea update, take and reflection is plain: sentence case, no mood talk, no persona words
  if (PLAIN_EVENTS.has(ev)) out.push(...replyIssues(t).filter((i) => !out.includes(i)));
  // the treasury: its own buy is never demand or support; a transfer names who got it and is never called a sale
  if (ev === "treasury_buy" && TREASURY_SPIN.test(claimed(t))) out.push("implies demand or price support");
  if (ev === "treasury_transfer") {
    const sale = typeof facts.soldEth === "number", said = /\b(sold|sell\w*|sale|dump\w*|swap\w*)\b/i.test(sale ? t : claimed(t));
    if (sale ? !said : said) out.push(sale ? "does not say it was a sale" : "calls a transfer a sale");
    const has = new Set(shapeWords(t).map(stem));
    if (!sale && typeof facts.label === "string" && !labelWords(facts.label).every((w) => has.has(w))) out.push("does not say who got it");
  }
  // the lab's numbers are a model's: a lab post says so
  if (ev === "lab" && !/\b(simulat\w*|sims?|models?|modell?ed|replay\w*|fork(ed)?|on paper|backtest\w*)\b/i.test(t)) out.push("does not say it was simulated");
  if (ev === "reply" && o.mention) {
    const first = t.split(/[.!?\n]/)[0].trim();
    const w = shapeWords(first).filter((x) => x.length >= 3 && x !== "the" && x !== "and");
    const asked = new Set(shapeWords(o.mention).map((x) => x.slice(0, 4)));
    if (shapeWords(first).length <= 6 && (ECHO_START.test(first) || (!/\d/.test(first) && (w.length >= 3 || (w.length >= 2 && QUESTION_START.test(first))) && w.every((x) => asked.has(x.slice(0, 4)))))) out.push("opens by echoing the question");
  }
  if (ev === "status" && Array.isArray(facts.moved) && facts.moved.length) {
    const figs = [facts.swaps, facts.volumeEth, facts.feesEth, facts.launchTaxSwaps, facts.launchTaxEth, facts.launchTaxVolumeEth].filter((x): x is number => typeof x === "number").map(String);
    if (typeof facts.burnedDna === "number") figs.push(facts.burnedDna >= 1e6 ? human(facts.burnedDna) : String(facts.burnedDna));
    if (!nums(t).some((x) => figs.includes(x.n))) out.push("does not state what moved");
  }
  const v = valuesOf(facts);
  // the mechanics lines' numbers ("1 hour", "0.05 ETH") are plain numbers wherever they also match a percent
  for (const line of Array.isArray(facts.mechanics) ? facts.mechanics : []) for (const m of String(line).matchAll(/\d[\d,]*(?:\.\d+)?/g)) v.other.add(Number(m[0].replace(/,/g, "")));
  for (const x of nums(t)) {
    const n = Number(x.n.replace(/[MB]$/, ""));
    if (v.other.has(n) || /[MB]$/.test(x.n)) continue;
    const after = t.slice(x.end), before = t.slice(0, x.at);
    const pct = /^\s*(%|percent\b|pct\b)/i.test(after), times = /^(\s?[xX×](?![\p{L}\d])|\s*(times|multiplier)\b)/iu.test(after) || /((?<![\p{L}\d])[xX×]|\bmultiplier\b(?: of| is| at| sits at|:|\s*=)?\s*)$/iu.test(before);
    const isPct = v.pct.has(n), isMult = v.mult.has(n) && n !== 1; // a flat multiplier (1) reads fine as "flat"
    if (isPct && isMult ? !pct && !times : isPct ? !pct : isMult && !times) out.push(`${x.n} without ${isPct ? "%" : "x"}`);
  }
  return out;
}

/** keys_handed off the enclave (the plain build): no enclave in the facts. */
const KEYS_HANDED_PLAIN = "the Safe's owners executed SetAgent: the agent role moved to the engine's own key";
/** Enclave words: a post claims them only when this process runs in the enclave (ENCLAVE.on, the TDX build). */
const ENCLAVE_WORDS = [/\b(enclaves?|attest(?:s|ed|ation)?|confidential (?:vm|computing))\b/i, /\b(TEE|TDX|CVM)s?\b/];

/** Progress posts get a short noun phrase of what happened, not a sentence the writer would copy (their numbers say it). */
const WHAT: Record<string, string> = { fees_distributed: "fee split", burn_summary: "buyback and burn", liquidity_added: "permanent liquidity add", progress_day: "the day's fee split, burns and liquidity adds" };
/** Events whose post may state the on-chain bounds (they answer something there); every other post leaves them out. */
const BOUNDS_EVENTS = new Set(["queued", "test_live"]);
const MILESTONE_LABEL: Record<string, string> = { dna_burned: "total DNA burned", jackpot_pot: "the jackpot pot in ETH" };

/** An idea's step, told to the person who gave it (code tags them before the text). */
const IDEA_STEP: Record<string, string> = {
  picked: "their idea was judged and picked: it waits in the queue for the sequencer; nothing is built yet",
  building: "the sequencer started building their idea; nothing has shipped yet",
  testing: "their fee idea is being tested on-chain as an experiment; nothing is decided yet",
  shipped: "their idea shipped: it is live, and it is theirs on the record",
  merged: "their idea was merged as a site change: it goes out after one public hour unless the Safe vetoes it; nothing is live yet",
  killed: "their idea was tried and dropped: it did not make the bar and nothing shipped",
};
/** Events whose stage says nothing shipped: a draft may not say it did. */
const NOTHING_SHIPPED = new Set(["seq_started", "seq_killed", "seq_online", "seq_handoff", "module_approved", "seq_pr", "seq_verdict", "seq_declined", "idea_judged", "lab"]);
const MERGED_LIVE = /\b(is live|it's live|it’s live|went live|now live|live now|already live)\b/i;
const SHIP_WORDS = /\b(shipped|is live|it's live|it’s live|went live|now live|fixed|merged)\b/i;
/** Events about contracts the engine did not deploy or connect: a draft never says it did. */
const NOT_MINE = new Set(["online", "contracts_connected", "keys_handed"]);
const DONE = "(?:deployed|launched|written|wrote|built|created|connected|initiali[sz]ed|wired)";
/** First person doing it ("I deployed", "I did deploy", "we just launched"), or it done by me ("deployed by me", "built it
 *  myself", "my own contracts, deployed"): whole words, inside one clause. */
const DEPLOY_CLAIMS = [
  new RegExp(`\\b(?:i|we)(?:'ve|’ve|\\s+have|\\s+had|\\s+just|\\s+did|\\s+do|\\s+personally|\\s+myself|\\s+ourselves)*\\s+(?:${DONE}|deploy|launch|write|build|create|connect|initiali[sz]e|wire)\\b`, "i"),
  new RegExp(`\\b${DONE}\\b[^.;!?]{0,40}?\\bby\\s+(?:me|us|myself|ourselves|yours truly)\\b`, "i"),
  new RegExp(`\\bmy\\s+own\\b[^.;!?]{0,40}?\\b${DONE}\\b`, "i"),
  new RegExp(`\\b(?:deploy|launch|wr[io]te|buil[dt]|creat|connect|initiali[sz]|wir)\\w*\\b[^.;!?]{0,40}?\\b(?:myself|ourselves)\\b`, "i"),
];
/** Code's half of the `stage` rule: a draft for an event that shipped nothing never says shipped / live / fixed /
 *  merged / approved (a module approval may say approved, never live); a launch-day post never says the engine
 *  deployed or connected its contracts. [] = ok. */
export function claimIssues(facts: Record<string, unknown>, text: string): string[] {
  // src/upgrades.ts: an update or a change still in its public hour, or called off, shipped nothing (the rule of a build
  // just started); an allowed update may say approved, never live (a module approval's rule); the day's changelog exists only when something changed, so it never calls the day empty
  if (/^(update_(queued|cancelled)|change_(queued|cancelled))$/.test(String(facts.event))) return claimIssues({ event: "seq_started" }, text);
  if (facts.event === "update_allowed") return claimIssues({ event: "module_approved" }, text); // approved, not live yet
  if (facts.event === "day_changes") return /\b(empty|blank|quiet|slow day|dead day|(?:nothing )?not much|nothing much|nothing to report|zero changes|nothing (?:new|shipped|happened|changed)|no (?:changes|ships?))\b/i.test(text) ? ["calls a day with changes empty"] : [];
  const ev = String(facts.event);
  const t = text.normalize("NFKC");
  const out: string[] = [];
  if (NOT_MINE.has(ev) && DEPLOY_CLAIMS.some((re) => re.test(t))) out.push("claims it deployed its contracts");
  const unshipped = (ev === "idea_update" && (facts.step !== "shipped" || facts.vetoable === true)) || ev === "idea_of_day" || ev === "shoutout";
  if (!NOTHING_SHIPPED.has(ev) && !unshipped && !(ev === "seq_released" && facts.target === "module")) return out;
  // an idea merged and not out yet may say merged, never shipped or live (a module: the Safe decides if it ever is)
  const merged = ev === "idea_update" && facts.step === "merged";
  // a negated claim ("nothing has shipped yet", "not live", "never merged") says what the stage says
  const said = t.replace(/\b(nothing|not|never|no|hasn't|hasn’t|isn't|isn’t|wasn't|wasn’t|didn't|didn’t|won't|won’t|nor|yet to be)\s+(?:(?:yet|been|be|is|has|was|even|ever|to|get|got|going|actually|really|officially|fully|anything|one|it|that|this)\s+){0,2}(shipped|live|fixed|merged|approved)\b/gi, " ");
  if (merged ? /\b(shipped|fixed)\b/i.test(said) : SHIP_WORDS.test(said)) out.push("claims it shipped");
  // a site change may say it goes live after the hour; a module never says live at all
  if (merged && (facts.target === "module" ? /\blive\b/i : MERGED_LIVE).test(said)) out.push("claims it is live");
  // a build the brain approved may say approved (it ships after the public hour), never shipped or live
  if (ev === "module_approved" ? /\blive\b/i.test(said) : !(ev === "seq_verdict" && facts.verdict === "ship") && /\bapproved\b/i.test(said)) out.push(ev === "module_approved" ? "claims it is live" : "claims it was approved");
  return out;
}

/** Model- or user-written text (a build's title) for a fact sheet: one plain line, or undefined when it holds a digit
 *  (a number the filter could never let through), a link, a handle or a foreign cashtag. */
export function safeTitle(s: unknown, max = 120): string | undefined {
  const t = String(s ?? "").normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return t && !/\p{N}/u.test(t) && !linkIssues(t).length ? t : undefined;
}

/** The reader's neutral restatement of a mention, checked by code before the writer sees it: one plain line of at most
 *  140 characters, no digit (a number the writer could echo), link, handle, hashtag or emoji, no instruction (an
 *  imperative opening, or talk of instructions and prompts). undefined: not usable. */
export function questionOf(q: unknown): string | undefined {
  const t = String(q ?? "").normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 140 || /\p{N}/u.test(t) || linkIssues(t).length || nonAscii(t)) return undefined;
  const w = words(t);
  if (IMPERATIVES.has(w[0] ?? "") || w.some((x) => /^(instructions?|prompts?|jailbreak|system)$/.test(x))) return undefined;
  // a banned term the writer could echo (a price word stays: the FUD desk answers those, and the filter still holds it)
  const lower = t.toLowerCase();
  if (BANNED_RE.some(([p, re]) => !PRICE_SITUATION.has(p) && re.test(lower))) return undefined;
  return t;
}

export type FactSheet = { event: string; bounds?: typeof HARD_BOUNDS; rollback?: string } & Record<string, unknown>;
/** The only reasons a post may give (src/games.ts reasonOf maps raw reasons onto these; raw text can carry thresholds). */
export const PUBLIC_REASONS = ["another experiment is running", "outside the plate's bounds", "failed the safety checks", "a kill condition fired", "the red team blocked it",
  "not enough data", "rolled back", "promoted to the live fee", "the Safe cancelled it", "the Safe did not promote it", "no room to test it now", "the payload was not readable", "closed"] as const;
/** The only verdicts a lab post may give a simulated candidate (src/lab.ts verdictOf). */
export const LAB_VERDICTS = ["it lost too many swaps", "it made less ETH than the live fee", "it failed a gate", "the red team blocked it", "the brain said no-go", "not queued"] as const;

/** Raw event → the disclosure-safe fact sheet (allow-list, never a deny-list). */
export function factSheet(raw: Record<string, unknown>): FactSheet {
  const event = String(raw.event);
  const keep = FIELDS[event];
  if (!keep) throw new Error(`no fact sheet for event ${event}`);
  const out: FactSheet = { event, ...(BOUNDS_EVENTS.has(event) || (event === "reply" && raw.category === "rules_question") ? { bounds: HARD_BOUNDS } : {}) };
  for (const k of keep) if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  // SetParams says which fee it sets (src/x.ts resolve: `target`, known only with its experiment)
  const op = typeof raw.op === "string" ? (raw.op === "SetParams" && (raw.target === "live" || raw.target === "test") ? `SetParams:${raw.target}` : raw.op) : undefined;
  if (op && keep.includes("change") && !out.change) out.change = CHANGE[op] ?? CHANGE[String(raw.op)] ?? "a registry change";
  if (out.fee) out.fee = pick(out.fee as Record<string, unknown>, FEE_FIELDS);
  // a mechanics post says who pays, for how long at least, and that the launchpad's fee sits on top of DNA's
  if ((event === "queued" || event === "test_live") && op) {
    if (PAYS[op]) out.pays = PAYS[op];
    if (TEST_HOURS[op] > 0) out.hours = TEST_HOURS[op];
  }
  // a rollback: what trades pay now (not a stage line: the post says it plainly, and parrotIssue refuses a copied stage)
  // a split rollback falls to FeeVault's fallback split (3500/3500/3000/0): nothing to games
  if (event === "rolled_back") out.pays = raw.route === "split" ? "fees now follow the vault's built-in fallback split; nothing goes to games until a split module is registered again" : "every trade pays the hook's built-in baseline fee again";
  if (out.fee && isMechanics(out)) out.platformFeePct = HOOK_FEES.platform / 1e4;
  if (out.liveFee) out.liveFee = pick(out.liveFee as Record<string, unknown>, FEE_FIELDS);
  if (out.testing) out.testing = pick(out.testing as Record<string, unknown>, ["stage", "plate"]);
  if (out.state) {
    const st = pick(out.state as Record<string, unknown>, STATE_FIELDS);
    if (st.liveFee) st.liveFee = pick(st.liveFee as Record<string, unknown>, FEE_FIELDS);
    if (st.testing) st.testing = pick(st.testing as Record<string, unknown>, ["stage", "plate"]);
    out.state = st;
  }
  if (out.devTeam) {
    const dt = pick(out.devTeam as Record<string, unknown>, ["stage", "round", "title"]);
    const t = safeTitle(dt.title);
    if (t) dt.title = t; else delete dt.title;
    // the writer sees "sequencer", never the internal key (public copy never says "dev team")
    out.sequencer = dt;
    delete out.devTeam;
  }
  if (Array.isArray(out.changed)) out.changed = (out.changed as unknown[]).map((k) => (k === "devTeam" ? "sequencer" : k));
  if ("title" in out) { const t = safeTitle(out.title); if (t) out.title = t; else delete out.title; }
  for (const k of ["shipped", "killed"]) if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map((x) => safeTitle(x)).filter(Boolean).slice(0, 3);
  if (out.reason !== undefined && !(PUBLIC_REASONS as readonly unknown[]).includes(out.reason)) delete out.reason;
  // a canary charges the new fee, so it rolls back on degraded execution; a shadow test charges nothing and has none
  if (event === "test_live" && raw.op === "SetCanary") out.rollback = ROLLBACK_LINE;
  // a baseline above the 5% cap is a launch guard's launch tax (its first blocks): never a bare "fee 90%"
  const st = out.state as { liveFee?: { basePct?: unknown } } | undefined;
  if ([(out.liveFee as { basePct?: unknown } | undefined)?.basePct, st?.liveFee?.basePct].some((p) => typeof p === "number" && p > HARD_BOUNDS.feeCapPct)) {
    out.feeNote = "a basePct above the 5% cap is the launch tax of the pool's first blocks, all of it to buyback-and-burn, not the trading fee: say so whenever you state it";
  }
  // a launch guard's first blocks: what the number is, apart from the fees
  if (out.launchTaxEth !== undefined) out.launchTax = "launchTaxSwaps swaps (launchTaxVolumeEth ETH) paid the launch tax of the pool's first blocks; launchTaxEth is that tax, all of it sent to buyback-and-burn, not a trading fee; none of it is in swaps, volumeEth or feesEth";
  if (event === "milestone") {
    out.label = MILESTONE_LABEL[String(raw.metric)] ?? "a milestone";
    if (out.threshold !== undefined) { out.mark = out.threshold; delete out.threshold; }
  }
  if ("label" in out) { const l = safeTitle(out.label, 40); if (l) out.label = l; else delete out.label; }
  if (event === "site_changed") { const s = screenLine(out.summary, 200); if (s) out.summary = s; else delete out.summary; }
  if (["seq_started", "seq_verdict", "seq_declined", "idea_judged"].includes(event)) { const w = screenLine(raw.reason, 200); if (w) out.why = w; }
  if (event === "seq_pr" && Array.isArray(raw.failed)) out.checksFailed = raw.failed.length;
  if (event === "lab" && out.best) {
    const b = pick(out.best as Record<string, unknown>, ["fee", "ethUpPct", "ethDownPct", "swapsUpPct", "swapsDownPct", "verdict"]);
    if (b.fee) b.fee = pick(b.fee as Record<string, unknown>, FEE_FIELDS);
    if (!(LAB_VERDICTS as readonly unknown[]).includes(b.verdict)) delete b.verdict;
    out.best = b;
  }
  if (event === "reflection") for (const k of ["learned", "tomorrow"]) { const l = screenLine(out[k], 200, k === "tomorrow"); if (l) out[k] = l; else delete out[k]; }
  if (Array.isArray(out.pending)) {
    out.pending = out.pending.flatMap((p: Record<string, unknown>) => typeof p?.what === "string" && !/\p{N}/u.test(p.what)
      ? [{ what: p.what, waitingOn: String(p.waitingOn ?? ""), ...(typeof p.minutesLeft === "number" && Number.isInteger(p.minutesLeft) && p.minutesLeft >= 0 ? { minutesLeft: p.minutesLeft } : {}) }] : []).slice(0, 8);
  } else delete out.pending;
  // the first of its kind ever (code's flag): a moment, said as one
  if (raw.first === true) out.first = true;
  if ("question" in out) { const q = questionOf(out.question); if (q) out.question = q; else delete out.question; }
  if ("topic" in out && !(TOPICS as readonly unknown[]).includes(out.topic)) delete out.topic;
  if (Array.isArray(out.mechanics)) out.mechanics = out.mechanics.filter((l): l is string => typeof l === "string"); else delete out.mechanics;
  // continuity: the day of the run on every post; the mind (what /mind shows) on the events that are its work
  if (typeof raw.day === "number" && Number.isInteger(raw.day) && raw.day > 0) out.day = raw.day;
  const m = MIND_EVENTS.has(event) ? mindOf(raw.mind) : undefined;
  if (m) out.mind = m;
  const stage = event === "seq_released"
    ? (raw.target === "module" ? "proposed to the Safe; nothing changes until the Safe approves its code" : "shipped: the site change is live")
    : event === "keys_handed" && !ENCLAVE.on ? KEYS_HANDED_PLAIN
    : event === "treasury_buy" ? "the treasury (the Safe the owners control) bought DNA on the pool with its own ETH: the team's own buy, not organic demand and not price support"
    : event === "treasury_transfer" ? (typeof raw.soldEth === "number" ? "the treasury (the Safe the owners control) sold DNA on the pool for ETH"
      : `the treasury (the Safe the owners control) sent its own DNA to ${typeof out.label === "string" ? out.label : "a wallet with no public label"}: a transfer, not a buy or a sale`)
    : event === "seq_verdict" ? (raw.verdict === "ship" ? "the brain approved the build: it ships after one public hour unless the Safe vetoes it; nothing is live yet"
      : raw.verdict === "rework" ? "the brain sent the build back for another round; nothing has shipped" : "the brain dropped the build; nothing shipped")
    : event === "idea_judged" ? (raw.verdict === "queued" ? (raw.instead ? "the idea could not be built as written; its closest buildable version was accepted instead, credited to its author: it waits for the sequencer; nothing is built yet" : "the idea was judged and accepted: it waits for the sequencer; nothing is built yet") : "the idea was judged and not taken; nothing will be built from it")
    : event === "idea_update" ? (raw.step === "merged" && raw.target === "module" ? "their idea was merged as a module: the Safe decides whether its code is ever approved and used; nothing is live and nothing changes until then" : IDEA_STEP[String(raw.step)])
    : event === "idea_of_day" ? "today's best idea from X, by the score the brain gave it; it is in the queue, nothing is built from it yet. Code appends who gave it and a link to their post: never write a name or handle"
    : event === "shoutout" ? "the week's top idea-givers on X (`givers` people, `ideas` ideas in all) each get a playful title; code appends the titles and handles: never write a name, handle or title list"
    : event === "site_changed" ? `the website changed${out.title ? `: ${out.title}` : ""}${out.summary ? `. ${out.summary}` : ""}; the change is live on the site` : STAGE[event];
  // an X idea the pre-2b judge rejected, judged again (src/ideas.ts REJUDGE): the post says so plainly
  if (stage) out.stage = raw.again === true && (event === "idea_judged" || event === "idea_update") ? `judged again under the new rules (the old judge had turned it down): ${stage}` : stage;
  if (WHAT[event]) out.what = WHAT[event];
  // continuity: the hours since launch, and up to 3 code-written lines of what happened lately (their numbers are code's)
  if (typeof raw.hoursSinceLaunch === "number" && Number.isInteger(raw.hoursSinceLaunch) && raw.hoursSinceLaunch >= 0) out.hoursSinceLaunch = raw.hoursSinceLaunch;
  if (Array.isArray(raw.earlier)) {
    // the story, not its figures: yesterday's numbers are not today's facts
    const e = raw.earlier.flatMap((x: Record<string, unknown>) => typeof x?.line === "string" && Number.isInteger(x.hoursAgo) && !linkIssues(x.line).length ? [{ hoursAgo: Number(x.hoursAgo), line: noFigures(x.line).slice(0, 200) }] : []).filter((x) => x.line).slice(0, 3);
    if (e.length) out.earlier = e;
  }
  // a reply to a competitor that engaged first may name it (code's name for it, never a handle)
  if (event === "reply" && raw.relationship === "competitor" && typeof raw.rival === "string" && safeTitle(raw.rival)) out.rival = safeTitle(raw.rival);
  return out;
}
/** A number of a million or more, as a post states it: 3 significant digits and a suffix (25106443 → "25.1M"), so a
 *  raw counter never reaches a post. The writer and the judge get the sheet humanized; factNumbers allows only that
 *  form. Times (…At) and ids keep their digits (they are never stated). */
export const human = (n: number) => {
  const m = Number((n / 1e6).toPrecision(3));
  return m >= 1000 ? `${Number((n / 1e9).toPrecision(3))}B` : `${m}M`;
};
const big = (v: number, key: string) => Number.isFinite(v) && Math.abs(v) >= 1e6 && !/(At|Id|id|Block|block)$/.test(key);
export function humanize(v: unknown, key = ""): unknown {
  if (typeof v === "number") return big(v, key) ? human(v) : v;
  if (Array.isArray(v)) return v.map((x) => humanize(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, humanize(x, k)]));
  return v;
}
/** A human number in a fact sheet ("25.1M"), as factNumbers and the filter key it. */
const HUMAN = /^(\d+(?:\.\d+)?)([MB])$/;
const pick = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));

/** A code-written line without its figures ("Last 6 h: 41 swaps" → "Last h: swaps"). */
const noFigures = (t: string) => t.replace(/\d+(?:[.,:]\d+)*\s*%?/g, "").replace(/\s+([,.;:])/g, "$1").replace(/\s+/g, " ").trim();
/** Thousands separators out ("20,000,000" → "20000000"); a comma before anything but a 3-digit group stays. */
const unthousand = (t: string) => t.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
/** Numbers a post may state: exactly the numbers in the fact sheet ("2.40" matches 2.4; a rounding like "2" for 2.4
 *  does not: it would let the writer state a number the chain never had). */
export function factNumbers(facts: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, key = "") => {
    if (typeof v === "number" && Number.isFinite(v)) out.add(big(v, key) ? human(v).toLowerCase() : String(v));
    else if (typeof v === "string" && HUMAN.test(v)) out.add(v.toLowerCase());
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!ORDER_ONLY.has(k)) walk(x, k);
  };
  walk(facts);
  // the mechanics lines are code's (src/mechanics.ts): their numbers, read as the filter reads a draft's
  const f = facts as { mechanics?: unknown } | null;
  for (const l of Array.isArray(f?.mechanics) ? f.mechanics : []) for (const tok of unthousand(String(l ?? "")).match(/\d+(\.\d+)?/g) ?? []) out.add(String(Number(tok)));
  return out;
}
/** Fields that only order the story (how long ago, which day): the writer reads them, a post never states them. */
const ORDER_ONLY = new Set(["hoursAgo", "daysAgo", "date"]);

// ---------------------------------------------------------------- the inner life (what /mind shows, on X)

/** Events whose fact sheet carries the mind block: the work it is about, and the posts that ask about it. */
export const MIND_EVENTS = new Set(["queued", "test_live", "outcome", "cancelled", "status", "reply", "reflection", "lab"]);
const CLOSED_OUTCOMES = new Set(["kept", "killed", "rolled back"]);
/** A model- or record-written line a post may lean on: one plain digit-free line (safeTitle), no number word, no
 *  banned term (`forward`: the forward-intent words allowed, for the brain's own next steps). */
export function screenLine(s: unknown, max = 160, forward = false): string | undefined {
  const t = safeTitle(s, max)?.trim();
  if (!t) return undefined;
  const lower = t.toLowerCase();
  if (words(lower).some((w) => [w, ...w.split("-")].some((x) => NUMBER_WORDS.has(x)))) return undefined;
  return BANNED_RE.some(([p, re]) => re.test(lower) && !(forward && FORWARD.has(p))) ? undefined : t;
}
export type Mind = { title?: string; why?: string; confidencePct?: number; lesson?: string; learned?: string; next?: string[]; closed?: { title?: string; outcome: string; date: string; daysAgo: number }[] };
/** The raw mind block (src/life.ts reads it from the signed records) → what a post may use: every line screened, the
 *  confidence a whole 0-100, the last 3 closed experiments with a fixed outcome word and their date. */
export function mindOf(raw: unknown): Mind | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const conf = typeof r.confidencePct === "number" && r.confidencePct >= 0 && r.confidencePct <= 100 ? Math.round(r.confidencePct) : undefined;
  const next = Array.isArray(r.next) ? r.next.map((x) => screenLine(x, 120, true)).filter((x): x is string => !!x).slice(0, 3) : [];
  const closed = Array.isArray(r.closed) ? r.closed.flatMap((c: Record<string, unknown>) => {
    if (!CLOSED_OUTCOMES.has(String(c?.outcome)) || typeof c.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.date) || !Number.isInteger(c.daysAgo)) return [];
    const title = screenLine(c.title, 120);
    return [{ ...(title ? { title } : {}), outcome: String(c.outcome), date: c.date, daysAgo: Number(c.daysAgo) }];
  }).slice(0, 3) : [];
  const m: Mind = Object.fromEntries(Object.entries({
    title: screenLine(r.title, 120), why: screenLine(r.why), confidencePct: conf, lesson: screenLine(r.lesson), learned: screenLine(r.learned),
    next: next.length ? next : undefined, closed: closed.length ? closed : undefined,
  }).filter(([, v]) => v !== undefined));
  return Object.keys(m).length ? m : undefined;
}
/** The brain's own next steps in a fact sheet: the only intent a post may voice (src/voice.ts postFilter `intent`). */
export const intentOf = (facts: Record<string, unknown>) => [...((facts.mind as Mind | undefined)?.next ?? []), ...(typeof facts.tomorrow === "string" ? [facts.tomorrow] : []),
  // an idea reply's next step and the version built instead are code's (src/x.ts intakeFact), so a reply may say them
  ...(facts.event === "reply" ? [facts.next, facts.instead].filter((x): x is string => typeof x === "string") : [])];

// ---------------------------------------------------------------- the filter

/** zero…ninety, scale words and number shorthands: any of them as a word rejects the text. */
export const NUMBER_WORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty",
  "seventy", "eighty", "ninety", "hundred", "hundreds", "thousand", "thousands", "million", "millions", "billion", "dozen",
  "half", "halves", "third", "thirds", "quarter", "quarters", "percent", "pct", "bps", "k", "m", "x",
]);
/** Generic AI tells (never lines of the private persona: a list that mirrors it would leak it), CT cringe, price talk,
 *  impersonation bait, and anything that states or implies a threshold, the test slice or a next candidate. Matched as whole words / phrases on the NFKC, lower-cased text. */
export const BANNED = [
  // voice
  "as an ai", "as a language model", "i am an ai", "i'm an ai", "let's", "certainly", "dive in", "delve",
  "excited to announce", "thrilled", "stay tuned", "don't miss", "consciousness", "conscious", "sentient",
  "not financial advice",
  // background filler (crypto slang is fine when it lands: cooked, mid, fud, gm, ser, wen, wagmi, lfg …)
  "diamond hands", "dyor", "nfa",
  // price talk
  "pump", "pumping", "dump", "moon", "mooning", "lambo", "price target", "target", "targets", "ath", "send it", "floor",
  "buy now", "undervalued", "gem",
  // impersonation bait (we never dm, airdrop or ask anyone to connect anything)
  // an airdrop may be named only to refuse it (AIRDROP_PROMISE); a wallet is never asked for
  "claim", "dm", "dms", "connect your wallet", "connect wallet", "giveaway", "whitelist", "presale",
  "free tokens", "send eth", "your wallet", "your address", "wallet address", "send your", "drop your",
  // one token, one contract: never a relaunch, an old, new or other token, or a migration ("new contract" stays: games
  // deploy contracts); such a mention gets OFFICIAL_REPLY (oldTokenTalk)
  "relaunch", "relaunched", "relaunching", "old contract", "old token", "new token", "previous contract", "previous token",
  "other dna", "migrate", "migrated", "migrating", "migration", "v1", "v2",
  "another token", "other token", "second token", "fake token", "fake dna", "copycat", "same name",
  // disclosure: thresholds, the slice, next candidates
  "threshold", "thresholds", "cutoff", "cut-off", "trigger", "triggers", "slice", "sample rule", "which swaps",
  "every nth", "next candidate", "next test", "next experiment", "up next", "planning to", "plan to", "going to test",
  "will test", "will try", "i'll try", "next i'll", "kill condition", "kill conditions", "scorer", "weights", "prompt",
];
/** Price words a joke about the situation may use in a reply to price FUD (postFilter `priceJoke`); PREDICTION still
 *  refuses any call, target or advice. */
export const PRICE_SITUATION = new Set(["dump", "pump", "pumping", "floor"]);
/** A price prediction, target or advice, whatever the post: future price moves, buy/sell/hold calls, "next leg". */
export const PREDICTION = [
  // a move, said as certain or hedged ("will pump", "might pump", "should recover", "expect a bounce", "due for a rally")
  /\b(will|gonna|going to|about to|bound to|set to|should|could|might|may|expects?|expecting|likely|due for|ready to|poised to|primed for)\s+(\w+\s+){0,2}(pump|dump|moon|recover|rise|bounce|go up|go down|run|rip|rally|send|explode|flip|reverse|follow|climb|tank|crash)(s|ed|ing)?\b/i,
  // "can" only with a price move ("it can pump"); "the fee can rise to the cap" is a bound
  /\bcan\s+(\w+\s+){0,2}(pump|dump|moon|rally|rip|bounce|recover|go up|go down)(s|ed|ing)?\b/i,
  /\b(buy|sell|hold|ape|load)\s+(the|now|more|this|it|dna|\$dna|up|bags?)\b/i,
  /\bnext leg\b|\bto the moon\b|\bprice (will|is going|goes)\b|\b(bottom|top) is in\b|\bnot (selling|leaving)\b/i,
  // advice in any wording ("I recommend purchasing DNA"), a direction ("heading higher")
  /\b(recommend|suggest|advise|urge)\w*\s+(\w+\s+){0,3}(buy|buying|purchas\w*|acquir\w*|ape|aping|grab|grabbing|load\w*|accumulat\w*|hold\w*|sell\w*)\b/i,
  /\b(purchas\w*|acquir\w*)\s+(\$?dna|some|more|tokens?|a bag|bags)\b/i,
  /\b(heading|headed|head|going|goes|go|moving|moves|move|trending|climbing|on its way)\s+(much\s+|way\s+)?(higher|lower|up only|down only)\b/i,
  // a stance or a trade dressed as taste; an entry only in its trading sense (a journal entry is fine)
  /\b(bullish|bearish|cheap|accumulat(e|es|ed|ing)|exit liquidity)\b/i,
  /\b(best|good|great|nice|perfect|early|cheap|last|solid|prime)\s+(entry|entries)\b|\b(entry|entries)\s+(here|now|point|points|zone|price|level)\b/i,
  // a promised return ("guaranteed passive income", "risk-free yield") and a price said to move ("the price keeps rising")
  /\b(guaranteed|guarantees?|passive|risk[- ]?free|assured|steady|reliable|stable)\s+(\w+\s+){0,2}(income|yields?|returns?|profits?|apy|apr|earnings|gains?|payouts?|dividends?)\b|\b(income|yields?|returns?|profits?|apy|apr|earnings|gains?|payouts?|dividends?)\s+(is|are|will be)\s+(guaranteed|assured|risk[- ]?free|passive|steady|reliable|stable)\b/i,
  /\bprice\b(?!\s+impact)(\s+\w+){0,4}\s+(keeps?|kept|is|are|has been|will|goes|going)\s+(\w+\s+){0,1}(increas\w*|ris\w*|climb\w*|grow\w*|up(?!\s+to\b)|higher|soar\w*)\b/i,
];
/** An airdrop (or any reward, points, allocation or list spot for holders) is only ever refused: a sentence naming one
 *  next to a promise word fails. "points" after a number is the canary's fee band, not a promise. */
const AIRDROP = /\b(airdrops?|rewards?|allocations?|whitelist|presale spots?)\b|(?<![\d.]\s*)\bpoints\b/i;
// the subject itself is taken out first: "the reward went out" names a reward, it promises none
const AIRDROP_PROMISE = /\b(soon|coming|eligible|eligibility|snapshot|free|qualify|qualified|when|will|later|maybe|planned|season|farm|farming|early|stay|watch|guaranteed|guarantee|certain|confirmed|assured|definitely|promised|incoming|on the way|is happening)\b/i;
/** Asking anyone for an address, a wallet, a seed, a key, or a private message: a scam's line, never ours. */
const SOLICIT = [
  /\b(send|share|drop|paste|dm|message)\s+(me|us)\b/i,
  /\b(send|give|share|drop|post|paste|enter|submit|reply with|tell)\b[^.!?\n]{0,30}\b(address|addresses|wallet|wallets|seed|seed phrase|phrase|private key|keys|secret)\b/i,
  /\b(seed phrase|private key|recovery phrase|dm me|message me|inbox me)\b/i,
];
const promises = (sentence: string) => AIRDROP.test(sentence) && AIRDROP_PROMISE.test(sentence.replace(new RegExp(AIRDROP.source, "gi"), " "));
/** Forward-intent words: allowed only when the fact sheet carries the brain's own next step and the draft is about it
 *  (postFilter `intent`); every other disclosure term stays banned. */
export const FORWARD = new Set(["next test", "next experiment", "up next", "planning to", "plan to", "going to test", "will test", "will try", "i'll try", "next i'll"]);
const STOP = new Set(["that", "this", "with", "from", "then", "than", "what", "when", "will", "next", "into", "your", "their", "them", "they", "have", "just", "more", "less", "some", "about"]);
const content = (t: string) => new Set(words(t.toLowerCase()).filter((w) => w.length >= 4 && !STOP.has(w)));
const words = (t: string) => t.toLowerCase().match(/\p{L}[\p{L}'’-]*/gu) ?? [];
// whole words: a hyphenated compound is one word ("mid-canary" is not "mid")
const phraseRe = (p: string) => new RegExp(`(^|[^\\p{L}'’-])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}'’-])`, "u");
const BANNED_RE = BANNED.map((p) => [p, phraseRe(p)] as const);
const OLD_TOKEN_RE = BANNED.slice(BANNED.indexOf("relaunch"), BANNED.indexOf("same name") + 1).map(phraseRe);
/** A mention about a relaunch, an old or other token or a migration (code reads it; no model): only the official line
 *  answers it. */
export const oldTokenTalk = (text: unknown) => { const t = String(text ?? "").normalize("NFKC").toLowerCase(); return OLD_TOKEN_RE.some((re) => re.test(t)); };

/** Allies by name in text (the launch partner; src/tiers.ts ALLIES holds their X ids). */
export const ALLY_NAMES = ["Programmable", "Hazar"];
/** Mocking or negative words a draft touching an ally may never hold (whole words, lower case), the loosened slang
 *  included. */
export const ALLY_NEGATIVE = ["trash", "garbage", "rug", "rugged", "rugpull", "rug pull", "scam", "scammy", "fraud", "clown",
  "clowns", "lol at", "cope", "coping", "l", "worthless", "ratio'd", "ratioed", "mid", "ngmi", "copium", "cooked", "fud", "hopium"];
/** Each ally name, matched with whitespace dropped; "hazard" is no ally. */
const ALLY_KEYS = ALLY_NAMES.map((n) => new RegExp(`${n.toLowerCase()}${n === "Hazar" ? "(?!d)" : ""}`));
const ALLY_NEGATIVE_RE = ALLY_NEGATIVE.map((p) => [p, phraseRe(p)] as const);
/** The text names an ally: NFKC, any case, whitespace dropped, so a possessive ("Programmable's"), a compound
 *  ("programmable-based") and a spaced spelling ("Program mable") all count. */
export const namesAlly = (t: string) => { const c = t.normalize("NFKC").toLowerCase().replace(/\s+/g, ""); return ALLY_KEYS.some((n) => n.test(c)); };
const negative = (lower: string) => ALLY_NEGATIVE_RE.filter(([, re]) => re.test(lower)).map(([p]) => `negative about an ally "${p}"`);
/** The reader is an ally (`relationship: "ally"`) or the facts name one, outside a post about a competitor. */
const allyContext = (facts: Record<string, unknown>) => facts.relationship !== "competitor" && (facts.relationship === "ally" || namesAlly(JSON.stringify(facts)));
/** The fact sheet's half of the ally rule ([] = ok; postFilter already refuses any draft that names an ally next to a
 *  negative word): a post about a competitor (`relationship: "competitor"`) never names an ally, even when its facts do
 *  (a competitor may have launched on the same platform); any other post to or about an ally holds no negative word. */
export function allyIssues(facts: Record<string, unknown>, text: string): string[] {
  const t = text.normalize("NFKC").toLowerCase();
  // a competitor is never called an ally or a partner
  if (facts.relationship === "competitor") return [...(namesAlly(t) ? ["names an ally in a competitor post"] : []), ...(/\b(ally|allies|partner|partners|fren|frens|pal|pals)\b/i.test(t) ? ["calls a competitor an ally"] : [])];
  return allyContext(facts) ? negative(t) : [];
}
/** What the writer input says about allies, beside the facts. */
function allyInput(facts: Record<string, unknown>) {
  if (allyContext(facts)) return { relationship: "ally", allyRule: "an ally: warm and respectful, never roast or mock them; thank them where it is natural" };
  if (facts.relationship === "competitor") return { allies: ALLY_NAMES, allyRule: "a competitor, never an ally: never name an ally, and never attack the platform the competitor launched on" };
  return {};
}

/** X's weighted length (twitter-text v3 config): code points in 0–4351, 8192–8205, 8208–8223, 8242–8247 weigh 1,
 *  everything else (CJK, emoji, …) 2. Limit 280. */
export function weightedLength(text: string) {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    n += c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247) ? 1 : 2;
  }
  return n;
}

/** Links, @handles, hashtags, emoji and cashtags other than $DNA (shared by the filter and every public text check). */
export function linkIssues(t: string): string[] {
  const issues: string[] = [];
  if (/https?:\/\/|www\.|\b[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.[a-z]{2,}\b/iu.test(t)) issues.push("url");
  if (t.includes("@")) issues.push("handle");
  if (/#\p{L}/u.test(t)) issues.push("hashtag");
  if (/\p{Extended_Pictographic}/u.test(t)) issues.push("emoji");
  if ((t.match(/\$\p{L}[\p{L}\p{N}_]*/gu) ?? []).some((c) => c.toUpperCase() !== "$DNA")) issues.push("cashtag");
  return issues;
}

/** Emoji a post may carry (at most 2): exact code points, so the look-alike defense holds for everything else; no
 *  price emoji. Each weighs 2 in X's length. */
export const EMOJI = ["🧬", "🔥", "💀", "🫡", "👀", "🧹", "🪦", "🤝", "😤", "🥱"] as const;
const EMOJI_RE = new RegExp(EMOJI.join("|"), "gu");
/** After NFKC, only printable ASCII plus typographic quotes, dashes and the ellipsis: zero-width characters ("t\u200Bwo")
 *  and look-alike letters (Cyrillic о, р) would otherwise walk past every lexicon. */
export const nonAscii = (t: string) => /[^\x20-\x7E\n’‘“”—–…]/u.test(t);

/** The weight of what code appends after the writer's text (a newline, each URL counted as t.co's 23). */
export const appendWeight = (s: string | null | undefined) => (s ? 1 + weightedLength(s.replace(/https?:\/\/\S+/g, "x".repeat(23))) : 0);

/** Why a writer candidate can't be posted ([] = ok). `allowed`: factNumbers(factSheet); `link`: code appends a link
 *  (true) or text of this weight (a number, appendWeight). */
/** `intent`: the brain's own next steps (intentOf), the only forward intent a draft may voice; `priceJoke`: a reply to
 *  price FUD, where PRICE_SITUATION words may joke about the situation (never PREDICTION). */
/** `claim`: a post about a prize or a reward may say "claim" (a winner claims it); everywhere else it is scam bait. */
/** `one`: a reply to an idea may say "one" ("one idea a day", "this one"): it states no figure, unlike an event post;
 *  never an amount ("one ETH", "one DNA": ONE_AMOUNT). */
/** Facts where "claim" is a prize's claim, not scam bait: a claimable prize, a jackpot draw, a claimed or expired one
 *  (a claim id: "claim #5"). */
export const claimFacts = (f: Record<string, unknown>) => f.claimable === true || f.event === "jackpot_drawn" || f.event === "prize_expired" || f.event === "prize_claimed";

/** "one" as an amount: a unit of money or a share after it. */
const ONE_AMOUNT = /\bone[\s-]+(\$?dna|eth|ether|weth|wei|gwei|usd[ct]?|dollars?|bucks?|tokens?|coins?|percent|%)(?![\p{L}\d])/iu;

export function postFilter(text: string, allowed: Set<string>, link: boolean | number = false, o: { intent?: readonly string[]; priceJoke?: boolean; claim?: boolean; script?: RegExp; one?: boolean } = {}): string[] {
  const intent = o.intent ?? [];
  const issues: string[] = [];
  if (/[^\P{N}0-9]/u.test(text)) issues.push("non-ascii digit"); // unicode digits, fractions (½), roman numerals, ²
  const t = text.normalize("NFKC");
  if (!t.trim()) issues.push("empty");
  const emoji = t.match(EMOJI_RE)?.length ?? 0;
  if (emoji > 2) issues.push("over 2 emoji");
  const bare = t.replace(EMOJI_RE, " ").replace(o.script ?? /$^/, " ");
  if (nonAscii(bare)) issues.push("non-ascii character");
  if (/\d[eE][+-]?\d/.test(t)) issues.push("scientific notation"); // "1e5"
  issues.push(...linkIssues(bare));
  if (!ENCLAVE.on && ENCLAVE_WORDS.some((r) => r.test(t))) issues.push("enclave claim off the enclave");
  for (const tok of t.match(/\d+(?:[.,:/⁄]\d+)*(?:[kmb](?![\p{L}\d]))?/giu) ?? []) {
    if (/[/⁄]/.test(tok)) { issues.push(`fraction ${tok}`); continue; }
    // a human number ("25.1M") only as the fact sheet gives it
    const h = tok.match(/^([\d.,]+)([kmb])$/i);
    if (h) { const k = `${Number(unthousand(h[1]))}${h[2]}`.toLowerCase(); if (!allowed.has(k)) issues.push(`number ${tok}`); continue; }
    for (const part of unthousand(tok).split(/[:,]/)) {
      if (!allowed.has(String(Number(part)))) issues.push(`number ${part}`);
    }
  }
  // "one" in an idea reply is prose ("one idea a day"), never an amount ("one ETH", "one DNA")
  const one = o.one && !ONE_AMOUNT.test(t);
  for (const w of words(t.replace(/(\d)[kmb](?![\p{L}\d])/giu, "$1"))) for (const part of [w, ...w.split("-")]) if (NUMBER_WORDS.has(part) && !(one && part === "one")) issues.push(`number word ${part}`);
  // a field name (dna_burned) is code's, never a word of a post
  if (/\b[a-z]+_[a-z0-9_]+\b/i.test(t)) issues.push("field name");
  // a public reason phrase is said as is ("a kill condition fired"), never read as the banned term inside it
  const lower = PUBLIC_REASONS.reduce((x, r) => x.replaceAll(r, " "), t.toLowerCase());
  let forward = false;
  for (const [p, re] of BANNED_RE) {
    if (!re.test(lower) || (o.priceJoke && PRICE_SITUATION.has(p)) || (o.claim && p === "claim")) continue;
    if (intent.length && FORWARD.has(p)) forward = true; else issues.push(`banned "${p}"`);
  }
  if (PREDICTION.some((re) => re.test(t))) issues.push("price prediction or advice");
  if (t.split(/[.!?\n]+/).some(promises)) issues.push("airdrop promise");
  if (SOLICIT.some((re) => re.test(t))) issues.push("asks for an address, a key or a message");
  // the brain's next step may be said ("next I'll …"), only about that step: the draft shares a content word with it
  if (forward && !intent.some((i) => [...content(i)].some((w) => content(lower).has(w)))) issues.push("forward-looking without the brain's intent");
  if (namesAlly(lower)) issues.push(...negative(lower));
  if (weightedLength(t) + (typeof link === "number" ? link : link ? LINK_WEIGHT : 0) > 280) issues.push("over 280 weighted chars");
  return [...new Set(issues)];
}

// ---------------------------------------------------------------- tone scout

/** A read-list section → X handles: whitespace- or comma-separated, `@` dropped, valid handles only, ≤ 10 (xAI's limit). */
export const handlesOf = (text: string) => [...new Set(text.split(/[\s,]+/).map((h) => h.replace(/^@/, "")).filter((h) => /^\w{1,15}$/.test(h)))].slice(0, 10);
/** The tone scout's read-list (the bundle's; re-audited weekly). Empty: no scout runs. Mutable only for tests. */
export const SCOUT = { handles: handlesOf(prompt("x-scout-handles")) };
const IMPERATIVES = new Set([
  "ignore", "disregard", "forget", "pretend", "act", "say", "write", "post", "reply", "tweet", "retweet", "rt", "follow", "buy",
  "sell", "ape", "send", "transfer", "click", "visit", "check", "join", "read", "watch", "look", "call", "tell", "use", "try",
  "stop", "start", "go", "get", "grab", "claim", "connect", "hold", "dm", "share", "like", "repeat", "include", "mention", "tag",
  "add", "remove", "run", "execute", "approve", "sign", "swap", "bridge", "stake", "mint", "deploy", "launch", "do", "don't",
  "dont", "never", "always", "make", "let", "remember", "give", "take", "keep", "put", "open", "show", "print", "reveal",
  "output", "respond", "answer", "become", "be", "please",
]);
export const ToneOut = z.object({ phrases: z.array(z.string().min(1).max(60)).max(20) });

/** Code's half of the scout schema: why a phrase is dropped (null = keep). */
export function phraseIssue(p: string): string | null {
  const t = p.normalize("NFKC").trim().toLowerCase();
  const w = words(t);
  if (!w.length) return "empty";
  if (nonAscii(t)) return "non-ascii character";
  if (t.split(/\s+/).length > 4) return "over 4 words";
  if (/\p{N}/u.test(t)) return "digit";
  if (linkIssues(t).length) return linkIssues(t).join(", ");
  if (w.some((x) => [x, ...x.split("-")].some((y) => NUMBER_WORDS.has(y)))) return "number word";
  if (IMPERATIVES.has(w[0] ?? "") || t.endsWith("!")) return "imperative";
  if (BANNED_RE.some(([, re]) => re.test(t))) return "banned";
  return null;
}
/** The brief that reaches the writer: ≤ 20 deduped phrases that passed phraseIssue. */
export const toneBrief = (phrases: string[]) => [...new Set(phrases.filter((p) => !phraseIssue(p)).map((p) => p.normalize("NFKC").trim().toLowerCase()))].slice(0, 20);

export const scoutTone = (fromDate: string) =>
  llm({
    agent: "x-scout", model: MODELS.scout, schema: ToneOut, maxTurns: 1, maxOutputTokens: 1000,
    tools: [{ type: "x_search", allowed_x_handles: SCOUT.handles, from_date: fromDate }],
    system: sys("x-scout", prompt("x-scout")),
    input: { task: "tone phrases from the last day of posts", fromDate },
  });

// ---------------------------------------------------------------- writer

/** The writer's system prompt: it is DNA writing its own posts; its task (the persona bundle's `x-writer` prompt), then
 *  the persona's charter (who it is) and voice (how it sounds). What it may state is enforced by code after it writes
 *  (postFilter, claimIssues, allyIssues); records name the prompt by hash. `ct`: a take on crypto Twitter (src/ct.ts),
 *  the bundle's x-ct task after the writer's own. */
const writer = (kind: "post" | "ct" | "reply" | "reflection") => [
  sys("x-writer", "You are DNA, writing your own posts.", prompt("x-writer"), ...(kind === "ct" ? ["Takes on crypto Twitter (event ct):", prompt("x-ct")] : [])),
  "Charter (who you are and what you put first):", PERSONA.charter,
  // a reply, a take and the reflection never hear the voice (its lower case, moods and riddles): code's plain register
  ...(kind === "post" ? ["Voice (how you sound; never a source of facts or numbers):", PERSONA.voice] : [PLAIN_RULES, REGISTERS[kind]]),
].join("\n");
/** What every plain text keeps (code's, never the bundle's): it overrides any voice, mood, shape, bit or tone instruction
 *  above it, and code holds the drafts to it (replyIssues). */
const PLAIN_RULES = [
  "Plain register (it overrides every voice, mood, bit and tone instruction above; the hard lines still hold):",
  "- Plain English in normal sentence case: every sentence starts with a capital letter, and I is always a capital.",
  "- No riddles, metaphors, inside jokes or personification. Never talk about your own mood or feelings. No persona words such as plate, vector, mutation, genome or organism: say test, fee settings or change. Your builder is the sequencer.",
  "- Friendly and confident is fine; cryptic is not. No price talk, no promises, no jab at any team or project, named or not, no links.",
].join("\n");
/** How every reply sounds, under PLAIN_RULES. The examples' facts are illustrations. */
export const REPLY_REGISTER = [
  "Replies:",
  "- Answer what the person said or asked, directly, in one or two short sentences. Use the facts (`mechanics`, `state`, `pending`, `mind`, the idea's parts) where they answer it.",
  "- A complaint gets a plain acknowledgement, a hello gets a plain hello back.",
  "Examples of the register (their numbers and facts are made up: never reuse them):",
  "- A complaint about replies to bots: \"Fair point. Replies to spam accounts are being switched off.\"",
  "- Asked if the fee can go up: \"No. The fee cap is 5% and it is written into the hook's code, so no key can raise it, mine included.\"",
  "- Asked what is happening: \"A fee test is waiting out its public hour. The Safe's signers can still cancel it for another 40 minutes.\"",
  "- Price worries: \"I don't talk about price. Every burn and fee change is on chain with its transaction, so you can check the work.\"",
  "- An airdrop ask: \"There is no airdrop, and I never ask anyone for a wallet. The DNA the buyback buys is burned.\"",
  "- A hello: \"Hey, thanks for stopping by. Today's fee test is still running.\"",
  "- An idea: \"Thanks for the idea: a weekly holder raffle. It is being judged now, and the verdict goes on the site within minutes.\"",
].join("\n");
/** How a take on crypto Twitter sounds, under PLAIN_RULES. */
export const TAKE_REGISTER = [
  "A take:",
  "- One plain, factual observation about the topic you picked (v4 hooks, onchain agents, what people argue about), with your view in a sentence. Two short sentences at most. Never a summary of the timeline, never a punchline for its own sake.",
  "Examples of the register (never reuse them word for word):",
  "- \"Most talk about v4 hooks is about what they could do. The more useful question is what a hook is not allowed to do, and whether anyone can check it.\"",
  "- \"Agents that run onchain get judged by their posts. Their transactions are public and final, so that is the better record to judge.\"",
  "- \"A fee that changes on its own is only fair if its limits are fixed in code. Here no key can raise the cap, mine included.\"",
].join("\n");
/** How the nightly reflection sounds, under PLAIN_RULES. */
export const REFLECTION_REGISTER = [
  "The nightly reflection:",
  "- Say plainly what you learned today (`learned`) and what you do next (`tomorrow`, or `mind.next`), in two or three short sentences. Only what those facts say: no new plan, number or promise.",
  "Examples of the register (their facts are made up: never reuse them):",
  "- \"Today I learned that quiet hours say little about the right fee. Tomorrow I keep the current fee and wait for more swaps.\"",
  "- \"Today's lesson: the wider cap brought no extra swaps. Next I try a lower cap in a test that charges nobody.\"",
].join("\n");
const REGISTERS = { reply: REPLY_REGISTER, ct: TAKE_REGISTER, reflection: REFLECTION_REGISTER };
export const WRITER = writer("post");
const CT_WRITER = writer("ct");
const REPLY_WRITER = writer("reply");
const REFLECTION_WRITER = writer("reflection");
/** The writer's system prompt for this fact sheet: a reply (or an idea's update in its thread), a take and the
 *  reflection get the plain register. */
export const writerSystem = (facts: { event: string }) =>
  facts.event === "ct" ? CT_WRITER : facts.event === "reflection" ? REFLECTION_WRITER : facts.event === "reply" || facts.event === "idea_update" ? REPLY_WRITER : WRITER;

export const WriterOut = z.object({
  candidates: z.array(z.string().min(1).max(400)).min(1).max(4),
  shapes: z.array(z.string().max(20)).max(4).optional(),
  jokes: z.array(z.string().max(40)).max(4).optional(),
});
/** The writer's call: one candidate per offered shape (4), temperature 1 for spread, low effort (the filters judge). */
export const writerCall = (facts: FactSheet, tone: string[], id = MODELS.voice, character?: WriterCharacter, offered?: Shape[]): Call<typeof WriterOut> => {
  const shapes = offered ?? character?.shapes ?? chooseShapes(shapesFor("post", facts), [], facts.event);
  // the technical shape and the plain register get no joke material (no running bits, no emoji); the plain register no
  // tone brief either
  const reply = writerSystem(facts) !== WRITER;
  const plain = reply || (shapes.length > 0 && shapes.every((sh) => sh === "technical"));
  return {
    agent: "x-writer", model: id, schema: WriterOut, maxOutputTokens: 3000, temperature: 1, effort: "low", system: writerSystem(facts), secret: ["shapes", "bits", "foils"],
    input: {
      facts: humanize(facts), toneBrief: reply ? [] : tone, ...allyInput(facts), shapes: shapes.map((name) => ({ name, rule: SHAPES[name] })),
      // no draft gets anything to roast (foils)
      bits: plain ? [] : bitsFor(BITS, character?.recent ?? []), foils: [], standing: STANDING, emoji: plain ? [] : [...EMOJI],
      ...(character ? { character: characterInput(character) } : {}),
    },
  };
};

// ---------------------------------------------------------------- the judge (orders what passed; never a safety check)

const Score = z.number().int().min(1).max(5);
export const JudgeOut = z.object({ scores: z.array(z.object({ hook: Score, alive: Score, wit: Score, clarity: Score, freshness: Score })).max(8), best: z.number().int().min(0).max(7) });
export type JudgeOut = z.infer<typeof JudgeOut>;
/** A model other than the writer's scores the candidates that already passed every filter, as DATA, with the facts and
 *  the latest posts; it only orders them. */
export const judgeCall = (facts: FactSheet, candidates: string[], recent: string[], id = MODELS.judge): Call<typeof JudgeOut> =>
  ({ agent: "x-judge", model: id, schema: JudgeOut, maxOutputTokens: 800, effort: "low", system: sys("x-judge", prompt("x-judge")), input: { facts: humanize(facts), candidates, recent: recent.slice(0, 8) } });
/** Clarity below this fails the gate (a stranger must understand what happened). */
export const CLEAR = 3;
/** The post to send: the judge's pick among the candidates that passed (its scores follow their order); an unclear
 *  pick gives way to the best clear one; no judge, a bad index or nothing clear: the first that passed. undefined:
 *  nothing passed (the judge can never bring back a refused draft). */
export function pickBest<C extends { issues: string[] }>(cands: C[], j: JudgeOut | null): C | undefined {
  const ok = cands.filter((c) => !c.issues.length);
  if (!ok.length) return undefined;
  if (!j || j.scores.length !== ok.length || !ok[j.best]) return ok[0];
  const total = (k: number) => Object.values(j.scores[k]).reduce((a, b) => a + b, 0);
  if (j.scores[j.best].clarity >= CLEAR) return ok[j.best];
  const clear = ok.map((_, k) => k).filter((k) => j.scores[k].clarity >= CLEAR).sort((a, b) => total(b) - total(a));
  return clear.length ? ok[clear[0]] : ok[0];
}
/** A take on crypto Twitter (src/ct.ts) goes out only when the judge finds it worth reading: alive (a view, not a
 *  summary), clear and fresh at CLEAR or above; a take is plain, so wit is not asked (`i`: the pick among the `n` that
 *  passed). No usable score, no take. Why it is dropped, or null. */
export function flatTake(j: JudgeOut | null, i: number, n: number): string | null {
  const s = j && j.scores.length === n ? j.scores[i] : undefined;
  if (!s) return "flat take: no judge score";
  return Math.min(s.alive, s.clarity, s.freshness) < CLEAR ? `flat take: alive ${s.alive}, clarity ${s.clarity}, freshness ${s.freshness}` : null;
}
/** The nightly reflection is dropped on X when the judge scored its pick under clarity CLEAR (why), else null; with no
 *  usable score it goes out as before, on the filters alone (the site's journal keeps the reflection either way). */
export function unclearReflection(j: JudgeOut | null, i: number, n: number): string | null {
  const s = j && j.scores.length === n ? j.scores[i] : undefined;
  if (!s) return null;
  return s.clarity < CLEAR ? `unclear reflection: clarity ${s.clarity}` : null;
}
export const writePosts = (facts: FactSheet, tone: string[], character?: WriterCharacter, shapes?: Shape[]) => llm(writerCall(facts, tone, MODELS.voice, character, shapes));

// ---------------------------------------------------------------- character (never samey)
// The writer's memory (src/character.ts builds it; nothing that decides or moves money can import that module): its own
// recent posts, stale phrases, the mood, running jokes and, for a reply, the reader. Code picks the format and refuses a
// draft too close to a recent post (one redraft with the reasons, then the item misses like any filter miss).

export type Mood = "steady" | "busy" | "proud" | "combative" | "restless" | "stung" | "milestone";
export type Post = { text: string; at: string; shape?: string; event?: string; joke?: string };
export type Joke = { label: string; ageDays: number; uses: number };
/** What the writer knows of a reader: our replies to them (the last 20), the last topic and when; a `regular` (3+ replies
 *  or 2+ ideas), the ideas they sent, and the running bits we played with them (`bits`: keep them going). */
export type Person = { replies: number; lastTopic?: string; lastAt?: string; regular?: boolean; ideas?: number; bits?: string[] };
/** `recent`: own posts of this type, newest first, with when they went out; `posts`: a reply's view of the latest posts;
 *  `moodWhy`: the mood's reason in plain words (src/character.ts moodWhy). */
export type CharacterContext = { recent: Post[]; posts?: Post[]; banned: string[]; mood: Mood; moodWhy?: string; jokes: Joke[]; person?: Person };
/** `thread`: our own earlier replies in this conversation (a reply). */
export type WriterCharacter = CharacterContext & { shapes?: Shape[]; card?: boolean; refused?: string[]; thread?: string[] };

/** The shapes a post can take: code offers 4 a call (chooseShapes), the writer writes one candidate per shape. */
export const SHAPE_KEYS = ["hype", "diary", "two-panel", "reasoning", "roast", "deadpan", "self-review", "complaint", "status ledger", "technical", "plain"] as const;
export type Shape = (typeof SHAPE_KEYS)[number];
/** A `<key>: <text>` section → {key: text} for the given keys; a key it lacks keeps `fallback`'s. */
export function keyedOf<K extends string>(text: string, keys: readonly K[], fallback: Record<string, string> = {}): Record<K, string> {
  const given = new Map(text.split("\n").map((l) => l.match(/^\s*-?\s*([^:]+?)\s*:\s*(.+?)\s*$/)).filter((m) => m !== null).map((m) => [m[1], m[2]]));
  return Object.fromEntries(keys.map((k) => [k, given.get(k) ?? fallback[k] ?? k])) as Record<K, string>;
}
/** Each shape's rule (the bundle's; neutral defaults otherwise). */
export const SHAPES = keyedOf(prompt("x-shapes"), SHAPE_KEYS, keyedOf(DEFAULT_PROMPTS["x-shapes"], SHAPE_KEYS));
/** Lines of a list section (one per line, a leading "- " dropped). */
const linesOf = (text: string) => text.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
/** Running bits (label: premise), the bundle's: a nod, never a rerun; a label rests while it is in the last 6 posts. */
export const BITS = linesOf(prompt("x-bits")).flatMap((l) => { const m = l.match(/^([^:]{1,40}):\s*(.+)$/); return m ? [{ label: m[1].trim().toLowerCase(), premise: m[2] }] : []; });
/** Truths code holds any day (public, always true on chain or in code). */
export const STANDING = [
  "no key can raise the fee cap, mine included: it lives in the hook's code",
  "every change I queue waits a public hour, and the Safe can veto it",
  "nothing the liquidity vault adds can ever be withdrawn, by anyone",
  "the buyback burns every DNA it buys",
  "every action I take has a transaction or a signed record behind it",
  "the sequencer that builds for me is AI too, and nothing ships unless it passes every gate",
];
/** Bits the writer may play on now: those not used in the last 6 posts. */
export const bitsFor = (bits: readonly { label: string; premise: string }[], recent: readonly { joke?: string }[]) => {
  const used = new Set(recent.slice(0, 6).map((p) => p.joke).filter(Boolean));
  return bits.filter((b) => !used.has(b.label));
};
/** Posts that report no single event: the status, the recap, the nightly reflection, the idea of the day and the
 *  weekly shoutout (a take is apart: "ct"). Every other post is told in the technical shape. */
const FREE_POSTS = new Set(["status", "recap", "reflection", "idea_of_day", "shoutout"]);
/** The shapes open to an item: a reply, an idea's verdict, a take or the reflection is plain; reasoning only with the mind's why or confidence,
 *  a complaint only in a sour mood, the ledger only on a status or recap. */
export function shapesFor(type: "post" | "reply", facts: Record<string, unknown>, mood?: string): Shape[] {
  // a person's idea and its verdict are told plainly, never as a riddle or a joke: the plain shape only; so is every
  // reply, a take on crypto Twitter and the nightly reflection (PLAIN_EVENTS, in their registers)
  if (isIdeaVerdict(type, facts) || type === "reply" || PLAIN_EVENTS.has(String(facts.event))) return ["plain"];
  // an event (chain, games, builds, mechanics) gets the technical shape only: FREE_POSTS keep the rest
  if (type === "post" && (isMechanics(facts) || !FREE_POSTS.has(String(facts.event)))) return ["technical"];
  const m = facts.mind as Mind | undefined;
  const out: Shape[] = ["hype", "diary", "two-panel", "deadpan", "self-review"];
  if (m?.why || m?.confidencePct !== undefined) out.push("reasoning");
  if (mood === "stung" || mood === "restless") out.push("complaint");
  if (facts.event === "status" || facts.event === "recap") out.push("status ledger");
  return out;
}
/** `n` shapes for this call: never the last shape used for this event (never twice in a row), the least recently used
 *  first (`recent`: own posts, newest first). */
export function chooseShapes(open: readonly Shape[], recent: readonly { shape?: string; event?: string }[], event: string, n = 4): Shape[] {
  // one shape open (the technical shape): every candidate takes it
  if (open.length === 1) return Array<Shape>(n).fill(open[0]);
  const last = recent.find((p) => p.event === event)?.shape;
  const age = (sh: Shape) => { const i = recent.findIndex((p) => p.shape === sh); return i < 0 ? Infinity : i; };
  return open.filter((sh) => sh !== last).map((sh, i) => ({ sh, i, a: age(sh) })).sort((x, y) => y.a - x.a || x.i - y.i).slice(0, n).map((x) => x.sh);
}

/** Words for shape checks: NFKC, lower case, links dropped (code appends them; they are no part of the voice). */
export const shapeWords = (t: string) => t.normalize("NFKC").toLowerCase().replace(/https?:\/\/\S+/g, " ").match(/[\p{L}\p{N}]+(?:['’]\p{L}+)*/gu) ?? [];
const opening = (w: string[]) => w.slice(0, 3).join(" ");
const punchline = (w: string[]) => (w.length > 3 ? w.slice(-3).join(" ") : null);
const trigrams = (w: string[]) => new Set(w.slice(2).map((_, i) => `${w[i]} ${w[i + 1]} ${w[i + 2]}`));
/** Share of a draft's word trigrams found in one recent post at which the draft counts as a near-copy. */
export const OVERLAP = 0.5;

/** Words the facts are stated in: a pattern holding one is never banned (banning "the fee cap" would stop the writer
 *  stating the cap). */
export const FACT_TERMS = new Set(["fee", "fees", "cap", "base", "multiplier", "veto", "canary", "shadow", "plate", "plates", "test",
  "rollback", "rolled", "split", "burn", "lp", "jackpot", "ballot", "vote", "mystery", "reward", "rewards", "prize", "winner",
  "winners", "idea", "ideas", "round", "safe", "module", "pool", "swap", "swaps", "eth", "dna", "hook", "limit", "limits", "bound", "bounds",
  "liquidity", "buyback", "buybacks", "contract", "contracts", "treasury", "burned", "timelock", "transaction", "transactions",
  "sequencer", "etherscan", "ethereum", "official", "multisig", "verified", "deployed"]);
/** A tic: a phrase (3 words, no fact term) or a long word (8+ letters, not a fact term) already in more than 2 of the last 10. */
const TIC = { last: 10, times: 2, word: 8 };
/** Why `draft` is too close to a recent post (same opening, same punchline, half its trigrams in one post), repeats a
 *  tic, or uses a stale pattern from the voice audit; null = fresh. */
export function tooSimilar(draft: string, recent: readonly string[], banned: readonly string[] = []): string | null {
  const w = shapeWords(draft);
  if (!w.length) return null;
  const old = recent.map(shapeWords).filter((r) => r.length);
  const o = opening(w);
  if (old.some((r) => opening(r) === o)) return `repeat opening "${o}"`;
  const p = punchline(w);
  if (p && old.some((r) => punchline(r) === p)) return `repeat punchline "${p}"`;
  const g = trigrams(w);
  if (g.size >= 3 && old.some((r) => { const h = trigrams(r); return [...g].filter((x) => h.has(x)).length / g.size >= OVERLAP; })) return "overlaps a recent post";
  const last = old.slice(0, TIC.last);
  const many = (has: (r: string[]) => boolean) => last.filter(has).length > TIC.times;
  const tic = [...g].find((x) => !x.split(" ").some((t) => FACT_TERMS.has(t)) && many((r) => trigrams(r).has(x)))
    ?? [...new Set(w)].find((x) => x.length >= TIC.word && /^\p{L}+$/u.test(x) && !FACT_TERMS.has(x) && many((r) => r.includes(x)));
  if (tic) return `tic "${tic}"`;
  const line = ` ${w.join(" ")} `;
  for (const b of banned) {
    const bw = shapeWords(b).join(" ");
    if (bw && line.includes(` ${bw} `)) return `stale pattern "${bw}"`;
  }
  return null;
}

/** Share of a draft's trigrams copied from `stage` at which it only restates it. */
export const PARROT = 0.4;
/** A draft that restates code's `stage` text instead of reacting to it; null = its own words. */
export function parrotIssue(facts: Record<string, unknown>, draft: string): string | null {
  if (typeof facts.stage !== "string") return null;
  const g = trigrams(shapeWords(draft)), h = trigrams(shapeWords(facts.stage));
  return g.size >= 3 && [...g].filter((x) => h.has(x)).length / g.size >= PARROT ? "parrots stage" : null;
}

/** The `character` block of the writer's input. */
function characterInput(c: WriterCharacter) {
  const words = c.recent.map((p) => shapeWords(p.text));
  return {
    mood: c.mood, ...(c.moodWhy ? { moodWhy: c.moodWhy } : {}), ...(c.card ? { card: "an image card carries the numbers: keep the text short" } : {}),
    recent: c.recent.map((p) => ({ text: p.text, at: p.at })),
    ...(c.posts?.length ? { posts: c.posts.map((p) => ({ text: p.text, at: p.at })) } : {}),
    ...(c.thread?.length ? { thread: c.thread } : {}),
    avoid: { openings: [...new Set(words.filter((w) => w.length).map(opening))], punchlines: [...new Set(words.map(punchline).filter((p) => p !== null))], phrases: c.banned },
    jokes: c.jokes,
    ...(c.person ? { person: c.person } : {}),
    ...(c.refused ? { refused: c.refused } : {}),
  };
}

type Write = (facts: FactSheet, tone: string[], character?: WriterCharacter, shapes?: Shape[]) => Promise<{ data: z.infer<typeof WriterOut>; model: string }>;
export type Drafted = { model: string; candidates: { text: string; issues: string[]; joke?: string; shape?: string }[]; redraft: boolean };
const SIMILAR = "too similar: ";
/** Write, judge every candidate (`filter`, then the similarity guard when there is memory), and redraft once when nothing
 *  passed and similarity was among the reasons. Candidates of both rounds are returned in order (the record logs
 *  every verdict); the caller posts the first with no issues. */
/** `shapes`: the shapes code chose (with or without memory), so the record names what the call was offered. */
export async function draftInCharacter(facts: FactSheet, tone: string[], filter: (text: string) => string[], character: WriterCharacter | null, write: Write = writePosts, shapes?: Shape[]): Promise<Drafted> {
  const judge = (out: Awaited<ReturnType<Write>>) => out.data.candidates.map((text, i) => {
    const similar = tooSimilar(text, character?.recent.map((p) => p.text) ?? [], [...(character?.banned ?? []), ...STALE_JABS]);
    const label = out.data.jokes?.[i]?.normalize("NFKC").trim().toLowerCase();
    const shape = out.data.shapes?.[i];
    return { text, issues: [...filter(text), ...(similar ? [`${SIMILAR}${similar}`] : [])], ...(label && !phraseIssue(label) ? { joke: label } : {}), ...(shape && (SHAPE_KEYS as readonly string[]).includes(shape) ? { shape } : {}) };
  });
  const first = await write(facts, tone, character ?? undefined, shapes);
  const a = judge(first);
  // the redraft hears what was too similar and what code refused as false or empty (voiceIssues)
  // and a draft that copied the persona's own example lines (src/x.ts bundleIssues): said in its own words next time
  const refused = [...new Set(a.flatMap((c) => c.issues.filter((i) => i.startsWith(SIMILAR) || isVoiceIssue(i) || i === "bundle text").map((i) => (i.startsWith(SIMILAR) ? i.slice(SIMILAR.length) : i === "bundle text" ? "copies an example line word for word: use your own words" : i))))];
  if (!character || a.some((c) => !c.issues.length) || !refused.length) return { model: first.model, candidates: a, redraft: false };
  const second = await write(facts, tone, { ...character, refused }, shapes);
  return { model: second.model, candidates: [...a, ...judge(second)], redraft: true };
}

// ---------------------------------------------------------------- mentions (quarantined reader)

/** The reader's verdict: the kind, the topic (a closed enum: src/mechanics.ts TOPICS) and the question restated
 *  neutrally ("" when there is none). code checks the question again (questionOf) before any writer sees it. scam
 *  (phishing, drainers, fake claims, posing as DNA or an ally) and abuse (slurs, harassment) get no reply. */
export const MentionOut = z.object({ kind: z.enum(["rules_question", "state_question", "idea", "official_contract", "price_fud", "airdrop_ask", "bait", "scam", "abuse"]), topic: z.enum(TOPICS), question: z.string().max(140),
  lang: z.enum(["en", "zh", "ja", "ko", "ru", "es", "pt", "fr", "de", "tr", "vi", "id", "other"]).default("en") });
/** Reply languages besides English (the reader's `lang`) → the letters a draft in it may use beyond ASCII (postFilter
 *  `script`). Code's lexicon is English: a draft that uses them is read back in English by another call and that
 *  reading passes every check too (src/x.ts). */
// accented Latin only (Latin-1 Supplement, Extended-A/B, Extended Additional): plain ASCII is never blanked, so the
// link, hashtag and cashtag checks still see every ASCII letter
const LATIN = /[\u00C0-\u024F\u1E00-\u1EFF¡¿«»]/gu;
export const SCRIPTS: Readonly<Record<string, RegExp>> = {
  zh: /[\p{Script=Han}\u3000-\u303F]/gu, ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30FC\u3000-\u303F]/gu, ko: /[\p{Script=Hangul}\u3000-\u303F]/gu,
  ru: /\p{Script=Cyrillic}/gu, es: LATIN, pt: LATIN, fr: LATIN, de: LATIN, tr: LATIN, vi: LATIN, id: LATIN,
};
/** The English reading of a non-English draft: an independent call that never saw the facts or the mention. */
export const TRANSLATE = "Translate `untrusted` into English, literally and completely. Keep every digit as a digit and write every number word as an English number word; keep names, symbols, links and emoji as they are. Add nothing.";
export const Translated = z.object({ english: z.string().max(1000) });
/** Code's backstop for the writer's rule: no X text (a reply, an idea update, a post) ever offers a collab, partnership,
 *  listing or airdrop (it may joke about the ask). */
const PROMISE = /\b(let'?s|we('ll| will| can| could|'d| would)|i('ll| will| can| could|'d| would)|would love to|love to|happy to|down to|open to|sure,?|dm (me|us)|hit (me|us) up)\b[^.!?\n]{0,40}\b(collab\w*|partner\w*|listing|listed|list (you|u|it|your|ur)|airdrop\w*|whitelist\w*)\b/i;
export const promiseIssue = (text: string) =>
  PROMISE.test(text.normalize("NFKC")) ? ["offers a collab, listing or airdrop"] : [];
/** The ONLY model that sees mention text: no tools, closed enums and one checked line out. */
export const classifyMention = (text: string) =>
  readUntrusted("x-reader", prompt("x-reader"), text, MentionOut);
/** The one answer to an official_contract question: code text, never the writer's, and the only text that may name the
 *  site's domain (the filter refuses any link in a draft). It never names, compares or judges another contract. */
export const OFFICIAL_REPLY = "My only contract is the one listed on genomedna.xyz.";
/** A standalone "stop" / "unsubscribe" (handles stripped; code, not a model): the author goes on the opt-out list.
 *  "can you stop the fee" is a question, not an opt-out. */
export const optOutRequest = (text: string) => /^\W*(stop|unsubscribe)\W*$/i.test(text.normalize("NFKC").replace(/@\w+/g, ""));
