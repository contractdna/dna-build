// Event posts are code's templates (src/event-posts.ts): every kind rendered from realistic facts through the same fact
// sheet x:send builds, then held to the rules: sentence case, no closing flourish, ≤ 280 with the appended link, the
// post filters' banned terms, and every number the facts' own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PRIORITY } from "../src/announce.ts";
import { C, VOTES_CLOSED } from "../src/games.ts";
import { dna, eth, eventIssues, eventPost, eventVariants, MODEL_POSTS } from "../src/event-posts.ts";
import { appendWeight, factSheet, voiceIssues, weightedLength } from "../src/voice.ts";

const TX = `https://etherscan.io/tx/0x${"ab".repeat(32)}`;
const RECORD = "https://genomedna.xyz/api/log/123456";
const fee = { basePct: 0.3, multiplier: 1.5, capPct: 5 };
/** The real claim window (GamePot CLAIM_WINDOW), in days: 7. */
const CLAIM_DAYS = C.CLAIM_WINDOW / 86_400;
const LONG = "A dice game where every roll burns a little DNA and the house edge goes to the jackpot pot for holders";

/** One realistic raw event per kind (what resolve() hands the fact sheet), with what code appends after the text. */
const SAMPLES: [Record<string, unknown>, string][] = [
  [{ event: "fees_distributed", hours: 2, distributions: 1, totalEth: 0.56, buybackEth: 0.196, liquidityEth: 0.168, treasuryEth: 0.14, gamesEth: 0.056 }, TX],
  [{ event: "fees_distributed", hours: 2, distributions: 3, totalEth: 12.3, buybackEth: 4.31, liquidityEth: 3.69, treasuryEth: 3.08, gamesEth: 1.23 }, TX],
  [{ event: "burn_summary", hours: 2, buybacks: 1, spentEth: 0.189, burnedDna: 486886 }, TX],
  [{ event: "burn_summary", hours: 2, buybacks: 4, spentEth: 1.27, burnedDna: 25106443 }, TX],
  [{ event: "liquidity_added", hours: 2, adds: 1, ethAdded: 0.12 }, TX],
  [{ event: "liquidity_added", hours: 2, adds: 2, ethAdded: 0.348 }, TX],
  [{ event: "progress_day", hours: 24, distributions: 12, totalEth: 6.72, buybackEth: 2.35, liquidityEth: 2.02, treasuryEth: 1.68, gamesEth: 0.672, buybacks: 9, spentEth: 2.35, burnedDna: 5843210, adds: 3, ethAdded: 2.02 }, TX],
  [{ event: "progress_day", hours: 24, buybacks: 1, spentEth: 0.189, burnedDna: 486886 }, TX],
  [{ event: "status", hours: 12, swaps: 1234, volumeEth: 41.2, feesEth: 0.906, burnedDna: 2486886, buybackPotEth: 0.0512, jackpotPotEth: 1.37, gamesLive: 2, liveFee: fee,
    testing: { stage: "canary", plate: "B" }, devTeam: { stage: "building", round: 2, title: LONG }, changed: ["gamesLive"], moved: ["DNA burned", "swaps"] }, RECORD],
  [{ event: "status", hours: 12, swaps: 41, volumeEth: 3.4, feesEth: 0.0748, burnedDna: 0, buybackPotEth: 0.0123, gamesLive: 0, liveFee: { basePct: 90 }, devTeam: { stage: "idle" },
    launchTaxSwaps: 12, launchTaxVolumeEth: 2.91, launchTaxEth: 2.62, moved: ["the launch tax: all of it to buyback-and-burn", "swaps"] }, RECORD],
  [{ event: "recap", days: 7, gamesShipped: 2, siteChanges: 1, modulesProposed: 1, modulesApproved: 0, handedOver: 1, buildsKilled: 3, gamesRetired: 1, experimentsKept: 1, experimentsKilled: 2, gamesLive: 3, liveFee: fee,
    shipped: ["Coin flip", "Daily dice"], killed: ["Lottery wheel"] }, RECORD],
  [{ event: "milestone", metric: "dna_burned", threshold: 25000000, value: 25106443 }, RECORD],
  [{ event: "milestone", metric: "jackpot_pot", threshold: 2.5, value: 2.613 }, RECORD],
  [{ event: "digest", generation: 4, survived: 1, extinct: 2, winners: 3, ethPaid: 0.15, dnaBurned: 486886, total: 4, money: 1, games: 2, experiments: 0, other: 1 }, "https://genomedna.xyz/announcements"],
  [{ event: "jackpot_params", window: 12, capPct: 2, minBalance: 10000, exchangesExcluded: 4, startsAt: "2026-10-12T18:00:00.000Z", reasoning: "a model's words" }, RECORD],
  [{ event: "jackpot_list", window: 12, holders: 1234, totalTickets: 56789, capPct: 2, minBalance: 10000, vetoHours: 1 }, `list ipfs://bafy${"a".repeat(55)}\n${TX}`],
  [{ event: "jackpot_drawn", window: 12, winners: 3, shareEth: 0.05, prizeEth: 0.15, claimable: 1, claimDays: CLAIM_DAYS }, `proof https://genomedna.xyz/play/draw/12\n${TX}`],
  [{ event: "jackpot_voided", window: 12, prizeEth: 0.15 }, TX],
  [{ event: "prize_claimed", drawId: 4, prizeEth: 0.05, kind: "prize" }, TX],
  [{ event: "prize_claimed", drawId: 5, prizeEth: 0.1, kind: "reward" }, TX],
  [{ event: "prize_claimed", drawId: 6, prizeEth: 0.1 }, TX],
  [{ event: "prize_expired", drawId: 4, prizeEth: 0.05, claimDays: CLAIM_DAYS, kind: "prize" }, TX],
  [{ event: "prize_expired", drawId: 5, prizeEth: 0.1, claimDays: CLAIM_DAYS, kind: "reward" }, TX],
  [{ event: "prize_expired", drawId: 6, prizeEth: 0.1, claimDays: CLAIM_DAYS }, TX],
  [{ event: "reward_paid", reward: 7, rewardEth: 0.1, claimable: false, claim: 0, claimDays: CLAIM_DAYS }, `proof https://genomedna.xyz/api/log/99\n${TX}`],
  [{ event: "reward_paid", reward: 7, rewardEth: 0.1, claimable: true, claim: 3, claimDays: CLAIM_DAYS }, `proof https://genomedna.xyz/api/log/99\n${TX}`],
  [{ event: "ballot_opened", options: ["Lower base fee", "Higher cap", "Keep the fee"], votingHours: 24, opensInHours: 1 }, TX],
  [{ event: "ballot_result", ballot: 3, outcome: "queued for testing", winner: "Lower base fee", winnerWeight: 1234567, totalWeight: 2000000 }, TX],
  [{ event: "ballot_result", ballot: 4, winner: "Lower base fee", winnerWeight: 1234567, totalWeight: 2000000 }, TX],
  [{ event: "mystery_sealed", revealInDays: 2 }, `commitment 0x${"cd".repeat(32)}\n${TX}`],
  [{ event: "mystery_revealed", fee }, TX],
  [{ event: "mystery_result", mystery: 2, outcome: "rejected", reason: "failed the safety checks" }, TX],
  [{ event: "idea_round", round: 5, accepted: 2, ideas: 9, refunded: false, payoutPct: 37.5 }, `report https://genomedna.xyz/api/log/77\n${TX}`],
  [{ event: "idea_round", round: 6, accepted: 0, ideas: 4, refunded: true, payoutPct: 0 }, TX],
  [{ event: "queued", op: "SetCanary", opId: 12, plate: "B", fee, activatesAt: { utcHour: 14, utcMinute: 5 } }, TX],
  [{ event: "queued", op: "SetParams", target: "live", opId: 13, fee, activatesAt: { utcHour: 9, utcMinute: 0 } }, TX],
  [{ event: "test_live", op: "SetShadow", plate: "B", fee }, TX],
  [{ event: "test_live", op: "SetCanary", plate: "B", fee }, TX],
  [{ event: "outcome", outcome: "killed", plate: "B", fee, samples: 1234, reason: "a kill condition fired", source: VOTES_CLOSED }, TX],
  [{ event: "outcome", outcome: "kept (promoted)", plate: "C", fee, samples: 5021, reason: "promoted to the live fee" }, TX],
  [{ event: "outcome", outcome: "rolled back", plate: "B", fee, samples: 321, reason: "rolled back" }, TX],
  [{ event: "cancelled", opId: 12, plate: "B", op: "SetCanary", by: "the Safe owners" }, TX],
  [{ event: "rolled_back", route: "fee" }, TX],
  [{ event: "rolled_back", route: "split" }, TX],
  [{ event: "module_approved", kind: "fee", codehash: `0x${"ef".repeat(32)}` }, TX],
  [{ event: "update_queued", notes: ["Replies open to everyone", "Draws every 24h at most", "Event posts are plain templates"], figures: [24], activatesAt: { utcHour: 14, utcMinute: 5 }, minutesLeft: 55 }, TX],
  [{ event: "update_allowed", notes: ["Replies open to everyone"] }, TX],
  [{ event: "update_running", notes: ["Replies open to everyone", "Event posts are plain templates"] }, TX],
  [{ event: "update_cancelled" }, TX],
  [{ event: "change_queued", who: "the Safe", change: "a fee split change", split: { buybackPct: 35, liquidityPct: 30, treasuryPct: 25, gamesPct: 10 }, activatesAt: { utcHour: 14, utcMinute: 5 } }, TX],
  [{ event: "change_queued", who: "me", change: "a new draw interval", hours: 24 }, TX],
  [{ event: "change_cancelled", who: "the Safe", change: "a new autonomy level for the engine", level: 3 }, TX],
  [{ event: "change_done", change: "a new anchor key, the key that pins the engine's log on-chain" }, TX],
  [{ event: "day_changes", day: "2026-10-11", date: "2026-10-11", changes: ["the fee split changed: buyback 35%, liquidity 30%, treasury 25%, games 10%", "a new game shipped: Coin flip", "draws now run every 24 hours"], figures: [35, 30, 25, 10, 24] }, "https://genomedna.xyz/announcements"],
  [{ event: "seq_online", record: "1" }, RECORD],
  [{ event: "seq_started", build: "b1", title: LONG, reason: "the most staked idea this week and cheap to build", record: "2" }, RECORD],
  [{ event: "seq_pr", build: "b1", title: "Coin flip", round: 2, pr: 41, failed: ["G3"], record: "3" }, RECORD],
  [{ event: "seq_verdict", build: "b1", title: "Coin flip", round: 2, verdict: "ship", reason: "every check passed", record: "4" }, RECORD],
  [{ event: "seq_verdict", build: "b1", title: "Coin flip", round: 2, verdict: "rework", reason: "the payout math is off by a rounding step", record: "4" }, RECORD],
  [{ event: "seq_verdict", build: "b1", title: "Coin flip", round: 3, verdict: "kill", reason: "it kept failing the same check", record: "4" }, RECORD],
  [{ event: "seq_declined", idea: "i1", title: "Coin flip", reason: "too close to a live game", record: "5" }, RECORD],
  [{ event: "idea_judged", idea: 3, title: "Coin flip", verdict: "queued", reason: "simple and fun" }, RECORD],
  [{ event: "idea_judged", idea: 3, title: "Coin flip lite", verdict: "queued", reason: "the closest version that can be built", instead: "Coin flip lite" }, RECORD],
  [{ event: "idea_judged", idea: 4, title: "Coin flip", verdict: "rejected", reason: "a live game already does this" }, RECORD],
  [{ event: "seq_killed", build: "b1", title: "Coin flip", rounds: 3, record: "6" }, RECORD],
  [{ event: "seq_shipped", build: "b1", title: "Coin flip", slug: "coin-flip", game: `0x${"12".repeat(20)}`, fundEth: 0.25, record: "7" }, RECORD],
  [{ event: "seq_shipped", build: "b1", title: LONG, slug: "dice", game: `0x${"12".repeat(20)}`, fundEth: null, record: "7" }, RECORD],
  [{ event: "game_retired", build: "b1", title: "Coin flip", slug: "coin-flip", game: `0x${"12".repeat(20)}`, days: 14, returnedEth: 0.0312, record: "8", rule: "idle", idleHours: 48 }, RECORD],
  [{ event: "game_retired", build: "b1", title: "Coin flip", slug: "coin-flip", game: `0x${"12".repeat(20)}`, days: 3, returnedEth: null, record: "8", rule: "evict" }, RECORD],
  [{ event: "seq_released", build: "b2", title: "Wallet link in the header", target: "site", record: "9" }, RECORD],
  [{ event: "seq_released", build: "b3", title: "Volume based fee curve", target: "module", record: "9" }, RECORD],
  [{ event: "seq_handoff", build: "b4", title: "Faster reply queue", pr: 42, record: "10" }, RECORD],
  [{ event: "site_changed", id: "c1", title: "Wallet link in the header", summary: "The header now links the official contract on Etherscan", url: "/" }, "https://genomedna.xyz/"],
  [{ event: "treasury_buy", dnaAmount: 1234567, ethSpent: 0.5, supplyPct: 0.123 }, TX],
  // the Genome Vaults (src/vaults.ts): the chain event's numbers, the live count and constants as read at send time
  [{ event: "vault_minted", slot: 7, live: 12, maxLive: 50, lockedDna: 200000 }, TX],
  [{ event: "vault_minted", slot: 1 }, TX],
  [{ event: "vault_funded", ethTotal: 0.4123, vaults: 12, perVaultEth: 0.0343 }, TX],
  [{ event: "vault_funded", ethTotal: 0.05, vaults: 0 }, TX],
  [{ event: "vault_burned", slot: 7, ethReturned: 0.0343, live: 11, maxLive: 50, lockedDna: 200000 }, TX],
  [{ event: "vault_burned", ethReturned: 0 }, TX],
  [{ event: "treasury_transfer", dnaAmount: 500000, supplyPct: 0.05, recipient: `0x${"34".repeat(20)}`, label: "fomo team wallet" }, TX],
  [{ event: "treasury_transfer", dnaAmount: 500000, supplyPct: 0.05, recipient: `0x${"34".repeat(20)}` }, TX],
  [{ event: "treasury_transfer", dnaAmount: 500000, supplyPct: 0.05, recipient: `0x${"34".repeat(20)}`, soldEth: 0.21 }, TX],
  [{ event: "online" }, TX],
  [{ event: "contracts_connected" }, TX],
  [{ event: "keys_handed" }, TX],
  [{ event: "first_idea_round" }, TX],
  [{ event: "first_burn" }, TX],
  [{ event: "lab", hours: 2, tested: 12, rejected: 12, best: { fee, ethUpPct: 12, swapsDownPct: 3, verdict: "it lost too many swaps" }, redTeamFindings: 2, redTeamOpen: 1, researchFindings: 5 }, "https://genomedna.xyz/lab/experiments"],
  [{ event: "idea_of_day", idea: 9, kind: "build", title: "Coin flip", score: 24, scoreOf: 30, append: "idea by @someone" }, `idea by @someone\nhttps://x.com/i/status/1`],
  [{ event: "shoutout", givers: 5, ideas: 12 }, "Idea machine: @a\nNight owl: @b"],
];

/** The numbers a post may state: each fact number as the templates format it, and the digit groups of fact strings
 *  (a date, a clock). */
function allowed(facts: unknown, out = new Set<number>()) {
  if (typeof facts === "number") for (const s of [eth(facts), dna(facts), String(facts)]) out.add(Number(s.replace(/,/g, "")));
  else if (typeof facts === "string") for (const m of facts.match(/\d+(?:\.\d+)?/g) ?? []) out.add(Number(m));
  else if (Array.isArray(facts)) facts.forEach((x) => allowed(x, out));
  else if (facts && typeof facts === "object") Object.values(facts).forEach((x) => allowed(x, out));
  return out;
}
const FLOURISH = /\b(does not|doesn't|won't|never) come back\b|\bfor good\b|\bforever\b|\bnot coming back\b|\bthat supply\b|\bno take-?backs\b|\bgone\b|\bjust like that\b/i;

test("event posts: every kind renders from its fact sheet in sentence case, no flourish, ≤ 280 with the link, no banned terms, numbers from the facts", () => {
  for (const [raw, suffix] of SAMPLES) {
    const facts = factSheet({ ...raw, day: 3, hoursSinceLaunch: 50 });
    const room = 280 - appendWeight(suffix);
    const text = eventPost(facts, room);
    const what = `${raw.event}: ${JSON.stringify(text)}`;
    assert.ok(typeof text === "string", `${raw.event} has a template that fits`);
    assert.ok(/^[A-Z]/.test(text), `starts with a capital: ${what}`);
    for (const s of text.split(/(?<=[.!?])\s+/)) assert.ok(!/^[a-z]/.test(s), `no sentence starts in lower case: "${s}" in ${what}`);
    assert.ok(!FLOURISH.test(text), `no flourish: ${what}`);
    assert.ok(weightedLength(text) + appendWeight(suffix) <= 280, `fits with the link (${weightedLength(text) + appendWeight(suffix)}): ${what}`);
    assert.deepEqual(eventIssues(facts, text, room), [], `post filters: ${what}`);
    assert.deepEqual(voiceIssues(facts, text, { linked: true }).filter((i) => i !== "does not state what moved" || facts.event !== "status"), [], `voice checks: ${what}`);
    assert.ok(!/\b(price|cheap|pump|moon|bullish)\b/i.test(text), `no price talk: ${what}`);
    const ok = allowed(facts);
    for (const tok of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) assert.ok(ok.has(Number(tok.replace(/,/g, ""))), `${tok} is a fact's number: ${what}`);
  }
});

test("event posts: the owner's examples, word for word; ETH to 3 significant digits, DNA whole with separators", () => {
  const post = (raw: Record<string, unknown>) => eventPost(factSheet(raw), 280 - appendWeight(TX));
  assert.equal(post({ event: "burn_summary", hours: 2, buybacks: 1, spentEth: 0.189, burnedDna: 486886 }), "Buyback and burn: 0.189 ETH bought 486,886 DNA, and it was burned.");
  assert.equal(post({ event: "fees_distributed", hours: 2, distributions: 1, totalEth: 0.56, buybackEth: 0.196, liquidityEth: 0.168, treasuryEth: 0.14, gamesEth: 0.056 }),
    "Fees distributed (last 2 h): 0.56 ETH total. 0.196 ETH to buyback, 0.168 ETH to liquidity, 0.14 ETH to treasury, 0.056 ETH to games.");
  // contracts/src/LiquidityVault.sol: ETH-only and permanent (no withdraw path), never "paired"
  assert.equal(post({ event: "liquidity_added", hours: 2, adds: 1, ethAdded: 0.12 }), "Liquidity added: 0.12 ETH went into the pool as permanent liquidity. It can never be withdrawn.");
  assert.deepEqual([eth(0.19649), eth(1234.5), eth(0), eth(0.0000123456), dna(25106443.9), dna(999)], ["0.196", "1,230", "0", "0.0000123", "25,106,443", "999"]);
});

test("event posts: a title or reason that fails a filter is left out, never posted; too long drops the optional parts", () => {
  const f = factSheet({ event: "seq_shipped", title: "Buy now and moon", fundEth: 0.25 });
  assert.equal(eventPost(f), "New game: a new game is live. Its first 0.25 ETH of funding waits a public hour.");
  const s = factSheet({ event: "seq_started", title: "Coin flip", reason: "the next experiment we plan to run" });
  assert.equal(eventPost(s), 'The sequencer started building "Coin flip".');
  // little room (a long appended text): the shortest variant
  const st = factSheet(SAMPLES.find(([r]) => r.event === "status" && r.devTeam && (r.devTeam as { title?: string }).title)![0]);
  const short = eventPost(st, 120) as string;
  assert.ok(short.startsWith("Status, last 12 h: 1,234 swaps"), short);
  assert.ok(weightedLength(short) <= 120 && !short.includes("Coin") && !short.includes("dice game"), short);
});

test("event posts: every type that goes to X has a template, except the writer's (a take, the reflection)", () => {
  // an empty day is never posted (src/x.ts resolve returns null for it)
  for (const type of [...Object.keys(PRIORITY), "digest"].filter((t) => t !== "seq_nothing_today")) {
    if (MODEL_POSTS.has(type)) assert.equal(eventPost({ event: type }), null, type);
    else assert.ok(Array.isArray(eventVariants({ event: type })), `${type} has a template`);
  }
  assert.deepEqual([...MODEL_POSTS].sort(), ["ct", "reflection"]);
});

test("event posts: a kind with no template, or no variant that fits and passes, is skipped: never the model, never an unchecked text", () => {
  // no template: skipped, never handed to the writer (only a take and the reflection are)
  assert.deepEqual(eventPost(factSheet({ event: "idea_update", step: "picked", title: "Coin flip" })), { skip: "no template" });
  // nothing fits the room left by the appended text: skipped, not the last variant unchecked
  const drawn = factSheet({ event: "jackpot_drawn", window: 12, winners: 3, shareEth: 0.05, prizeEth: 0.15, claimable: 1, claimDays: CLAIM_DAYS });
  assert.deepEqual(eventPost(drawn, 40), { skip: "no template variant fits" });
  // a mystery with no outcome says nothing: skipped (never "undefined")
  assert.deepEqual(eventPost(factSheet({ event: "mystery_result", mystery: 2 })), { skip: "no template variant fits" });
});

test("event posts: word for word (claims, rounds, rollbacks, retirements, queued changes, the treasury)", () => {
  const post = (raw: Record<string, unknown>) => eventPost(factSheet(raw), 280 - appendWeight(TX));
  assert.equal(CLAIM_DAYS, 7);
  assert.equal(post({ event: "jackpot_drawn", window: 12, winners: 3, shareEth: 0.05, prizeEth: 0.15, claimable: 1, claimDays: CLAIM_DAYS }),
    "Jackpot window 12 drawn: 3 winners, 0.05 ETH each (0.15 ETH in all). 1 prize can be claimed within 7 days.");
  assert.equal(post({ event: "prize_claimed", drawId: 4, prizeEth: 0.05, kind: "prize" }), "Jackpot prize #4 was claimed: 0.05 ETH.");
  assert.equal(post({ event: "prize_claimed", drawId: 5, prizeEth: 0.1, kind: "reward" }), "Idea reward (claim #5) was claimed: 0.1 ETH.");
  assert.equal(post({ event: "prize_expired", drawId: 4, prizeEth: 0.05, claimDays: CLAIM_DAYS, kind: "prize" }), "Jackpot prize #4 was not claimed within 7 days: 0.05 ETH went to the jackpot pot.");
  assert.equal(post({ event: "prize_expired", drawId: 5, prizeEth: 0.1, claimDays: CLAIM_DAYS, kind: "reward" }), "Idea reward (claim #5) was not claimed within 7 days: 0.1 ETH went to the jackpot pot.");
  assert.equal(post({ event: "prize_expired", drawId: 6, prizeEth: 0.1, claimDays: CLAIM_DAYS }), "Claim #6 (a jackpot share or an idea reward) was not claimed within 7 days: 0.1 ETH went to the jackpot pot.");
  assert.equal(post({ event: "reward_paid", reward: 7, rewardEth: 0.1, claimable: true, claim: 3, claimDays: CLAIM_DAYS }),
    "Idea reward #7: 0.1 ETH. The wallet could not take it, so it can be claimed (claim #3) within 7 days.");
  assert.equal(post({ event: "idea_round", round: 5, accepted: 2, ideas: 9, refunded: false, payoutPct: 37.5 }),
    "Idea round 5 closed: 2 of 9 ideas accepted. Stakers of accepted ideas get their stake back plus 37.5%.");
  assert.equal(post({ event: "idea_round", round: 6, accepted: 0, ideas: 4, refunded: true, payoutPct: 0 }), "Idea round 6 closed: no idea accepted, every stake refunded.");
  assert.equal(post({ event: "rolled_back", route: "fee" }), "Rolled back: the fee module. Every trade pays the hook's built-in baseline fee again.");
  // contracts/src/FeeVault.sol: the fallback split is 3500/3500/3000/0, nothing to games
  assert.equal(post({ event: "rolled_back", route: "split" }), "Rolled back: the split module. Fees now follow the vault's built-in fallback split; nothing goes to games until a split module is registered again.");
  // src/sequencer.ts retireDue: live 48 h or more and nobody played in the last 48 h; `days` is its age
  assert.equal(post({ event: "game_retired", title: "Coin flip", days: 14, returnedEth: 0.0312, rule: "idle", idleHours: 48 }),
    'Game retired: "Coin flip" had no players in its last 48 hours, after 14 days live. 0.0312 ETH went back to the treasury (the Safe). Anything won stays claimable.');
  assert.equal(post({ event: "game_retired", title: "Coin flip", days: 3, returnedEth: null, rule: "evict", idleHours: 48 }),
    'Game retired: "Coin flip" made room for a new game, as it had the fewest players of the live games. Anything won stays claimable.');
  assert.equal(post({ event: "update_queued", notes: ["Replies open to everyone", "Draws every 24h at most"], activatesAt: { utcHour: 14, utcMinute: 5 } }),
    "Engine update queued. What it changes: Replies open to everyone; Draws every 24h at most. It can land from 14:05 UTC unless the Safe cancels it first.");
  assert.equal(post({ event: "change_queued", who: "the Safe", change: "a fee split change", split: { buybackPct: 35, liquidityPct: 30, treasuryPct: 25, gamesPct: 10 }, activatesAt: { utcHour: 14, utcMinute: 5 } }),
    "The Safe queued a fee split change (buyback 35%, liquidity 30%, treasury 25%, games 10%). It can take effect from 14:05 UTC unless the Safe cancels it first.");
  assert.equal(post({ event: "treasury_buy", dnaAmount: 1234567, ethSpent: 0.5, supplyPct: 0.123 }),
    "The treasury (the Safe) bought 1,234,567 DNA on the pool for 0.5 ETH with its own ETH (0.123% of supply): the team's own buy, not organic demand.");
  assert.equal(post({ event: "treasury_transfer", dnaAmount: 500000, supplyPct: 0.05, soldEth: 0.21 }), "The treasury (the Safe) sold 500,000 DNA (0.05% of supply) on the pool for 0.21 ETH.");
  // a live settings change takes effect; a test runs (and only a canary rolls back on its own)
  assert.equal(post({ event: "queued", op: "SetParams", target: "live", fee, activatesAt: { utcHour: 9, utcMinute: 0 } }),
    "Queued. New settings for the live fee. Fee: base 0.3%, multiplier 1.5, cap 5%. It can take effect from 09:00 UTC unless the Safe cancels it first. Who pays: every trade, once it lands: these settings change the live fee.");
  assert.equal(post({ event: "test_live", op: "SetShadow", plate: "B", fee }),
    "Test live on plate B. A shadow test: fees computed on live swaps, not charged. Fee: base 0.3%, multiplier 1.5, cap 5%. It runs at least 2 hours.");
  assert.match(String(post({ event: "test_live", op: "SetCanary", plate: "B", fee })), /It runs at least \d+ hours, with auto-rollback if execution degrades\./);
  assert.equal(post({ event: "outcome", outcome: "rolled back", plate: "B", reason: "rolled back" }), "Experiment on plate B: rolled back.");
  assert.equal(post({ event: "ballot_result", ballot: 4, winner: "Lower base fee", winnerWeight: 1234567, totalWeight: 2000000 }), 'Ballot #4: "Lower base fee" won with 1,234,567 of 2,000,000 vote weight.');
});
