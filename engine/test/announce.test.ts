// Public announcements (src/announce.ts): the site's plain-text lines (code, from the fact sheet), the X priority order
// and the digest buckets; the reasons a post may give.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketOf, eventPosts, onX, plain, priorityOf, proofOf, recordUrl, seqKey, titleOf, typeOf } from "../src/announce.ts";
import { reasonOf } from "../src/games.ts";
import { rankOf } from "../src/x.ts";
import { PUBLIC_REASONS } from "../src/voice.ts";

const winner = "0x1234567890abcdef1234567890abcdef12345678";

test("site lines: every winner's full address, target vs final, where the reward went, the payout ratio, the vote weights", () => {
  const other = "0xabcdef1234567890abcdef1234567890abcdef12";
  const drawn = { event: "jackpot_drawn", window: 4, winners: 2, shareEth: 0.1, prizeEth: 0.2, claimable: 1, claimDays: 30 };
  assert.equal(titleOf(drawn, { args: { paid: [{ rank: "0", account: winner, prizeId: "0" }, { rank: "1", account: other, prizeId: "3" }] } }),
    `Jackpot window 4: 2 winners, 0.1 ETH each: ${winner}, ${other}; 1 claimable for 30 days`);
  assert.equal(titleOf({ ...drawn, winners: 1, claimable: 0 }, { args: { paid: [{ account: winner }] } }), `Jackpot window 4: 1 winner, 0.1 ETH each: ${winner}`);
  assert.equal(titleOf({ event: "jackpot_list", window: 7, holders: 1_234, totalTickets: 5_000_000, capPct: 1, vetoHours: 1 }), "Jackpot window 7: 1,234 holders, 5,000,000 tickets (cap 1%); the draw opens in 1 hour");
  assert.equal(titleOf({ event: "jackpot_params", window: 8, startsAt: "2026-10-09T00:00:00.000Z", capPct: 1, minBalance: 1_000, exchangesExcluded: 2 }),
    "Jackpot window 8 (starts 2026-10-09T00:00:00.000Z): cap 1% per wallet, minimum average balance 1,000 DNA, 2 exchange wallets excluded");
  assert.equal(titleOf({ event: "jackpot_voided", window: 7, prizeEth: 0.5 }), "Jackpot window 7: the draw was not settled in 7 days; 0.5 ETH returned to the pot");
  assert.equal(titleOf({ event: "prize_expired", drawId: 4, prizeEth: 0.1, claimDays: 7 }), "Jackpot prize #4: 0.1 ETH not claimed in 7 days, returned to the pot");
  assert.equal(titleOf({ event: "prize_claimed", drawId: 4, prizeEth: 0.1 }), "Jackpot prize #4: the 0.1 ETH share was claimed");
  const to = "0x12ab000000000000000000000000000000009f3c";
  assert.equal(titleOf({ event: "reward_paid", reward: 3, rewardEth: 0.2, claimable: false, claimDays: 7 }, { args: { id: "3", to, amount: String(2n * 10n ** 17n), claimId: "0" } }),
    "Idea reward paid: 0.2 ETH to 0x12ab…9f3c", "the short address only, from the chain event");
  assert.equal(titleOf({ event: "reward_paid", reward: 3, rewardEth: 0.2, claimable: true, claim: 5, claimDays: 7 }, { args: { to } }),
    "Idea reward paid: 0.2 ETH to 0x12ab…9f3c; the wallet could not take it: claim #5 within 7 days");
  assert.equal(titleOf({ event: "reward_paid", reward: 3, rewardEth: 0.2, claimable: false, claimDays: 7 }, { args: { to: "not an address" } }), "Idea reward paid: 0.2 ETH");
  assert.equal(titleOf({ event: "idea_round", round: 9, accepted: 2, ideas: 5, payoutPct: 37.5, refunded: false }),
    "Idea round 9: 2 of 5 ideas accepted; stakers of accepted ideas get their stake back plus 37.5%");
  assert.equal(titleOf({ event: "idea_round", round: 9, accepted: 0, ideas: 5, payoutPct: 0, refunded: true }), "Idea round 9: no idea accepted, every stake refunded");
  assert.equal(titleOf({ event: "ballot_result", ballot: 3, winner: "Calm nights", winnerWeight: 61_000, totalWeight: 90_000, outcome: "queued for testing" }),
    "Ballot #3: \"Calm nights\" won with 61,000 of 90,000 vote weight; queued for testing");
  assert.equal(titleOf({ event: "mystery_result", mystery: 2, outcome: "rejected", reason: "failed the safety checks" }), "Mystery #2: rejected (failed the safety checks)");
  assert.equal(titleOf({ event: "outcome", plate: "B", outcome: "killed", reason: "a kill condition fired", source: "ballot 3" }), "Experiment on plate B: killed (a kill condition fired), from ballot 3");
  assert.equal(proofOf("proof https://genomedna.xyz/play/draw/4"), "https://genomedna.xyz/play/draw/4");
  assert.equal(proofOf("report https://genomedna.xyz/api/log/77"), "https://genomedna.xyz/api/log/77");
});

test("X priority: money > ballot / mystery results > experiments > the rest; the digest takes the last slot of 7", () => {
  const p = (ev: Record<string, unknown>) => priorityOf(ev);
  assert.deepEqual(
    [p({ event: "game", name: "Drawn" }), p({ event: "game", name: "RewardPaid" }), p({ event: "game", name: "RoundFinalized" }), p({ event: "game", name: "PrizeExpired" }), p({ event: "game", name: "PrizeClaimed" }),
      p({ event: "game", name: "DrawVoided" })], [1, 1, 1, 1, 1, 1], "money (the win, claimed / expired)");
  assert.deepEqual([p({ event: "game", name: "BallotRun" }), p({ event: "game", name: "Revealed" }), p({ event: "game", name: "Rejected" }), p({ event: "game", name: "ListPosted" }), p({ event: "jackpot_params" })], [2, 2, 2, 2, 2]);
  assert.deepEqual([p({ event: "outcome" }), p({ event: "queued" }), p({ event: "rolled_back" })], [3, 3, 3]);
  assert.deepEqual([p({ event: "game", name: "BallotProposed" })], [2], "a new ballot ranks with the results");
  assert.deepEqual([p({ event: "game", name: "Sealed" })], [4]);
  // the outbox order: the digest's slot, then posts by priority; replies rank with the rest (4), then by id
  const q = [{ id: "1", type: "reply", event: { event: "reply" } }, { id: "2", type: "post", event: { event: "queued" } }, { id: "3", type: "post", event: { event: "game", name: "Sealed" } },
    { id: "4", type: "post", event: { event: "game", name: "Drawn" } }, { id: "5", type: "post", event: { event: "digest" } }];
  assert.deepEqual([...q].sort((a, b) => rankOf(a) - rankOf(b) || Number(a.id) - Number(b.id)).map((i) => i.id), ["5", "4", "2", "1", "3"]);
  assert.equal(p({ event: "digest" }), 0);
  assert.equal(eventPosts(), 24, "25 a day, the last one is the digest's");
  assert.deepEqual([bucketOf(typeOf({ event: "game", name: "Drawn" })), bucketOf("ballot_result"), bucketOf("outcome"), bucketOf("mystery_sealed")], ["money", "games", "experiments", "other"]);
});

test("reasons: raw reasons (they can carry thresholds) map onto fixed public phrases only", () => {
  for (const raw of ["gates failed: retention 45% < 70%", "kill condition: in-window swap rate 0% of the out-window rate", "an experiment is already running",
    "outside the plate's bounds", "red team blocked acceptance", "insufficient data", "rolled back by the breaker", "promoted", "the Safe cancelled op 7",
    "the agent already has 3 pending ops (limit 2)", "revealed payload not readable", "anything else"]) {
    assert.ok((PUBLIC_REASONS as readonly string[]).includes(reasonOf(raw)), raw);
  }
  assert.equal(reasonOf("gates failed: retention 45% < 70%"), "failed the safety checks");
  // the loop's rejection reasons (src/loop.ts) never read as a promotion
  for (const [raw, phrase] of [
    ["the queued SetParams on the active plate was cancelled or did not apply", "the Safe cancelled it"],
    ["the queued PromoteActive was cancelled or did not apply", "the Safe cancelled it"],
    ["the Safe did not promote within 48 h", "the Safe did not promote it"],
    ["active plate tuned to base 2.25%", "closed"],
  ]) {
    assert.equal(reasonOf(raw), phrase, raw);
    assert.ok((PUBLIC_REASONS as readonly string[]).includes(phrase));
  }
});

test("site-only lines: an accepted idea going into testing, an X account linking or changing its payout wallet", () => {
  assert.equal(titleOf({ event: "idea_testing", idea: 12, plate: "B", fee: { basePct: 2, multiplier: 1.5, capPct: 3 } }), "Idea #12 was accepted and goes into testing on plate B: base 2%, multiplier 1.5×, cap 3%");
  assert.equal(titleOf({ event: "binding_linked", change: "first", wallet: "0x12ab…9f3c", xUserId: "777", effectiveAt: "2026-10-08T00:00:00.000Z" }), "X account 777 linked its payout wallet 0x12ab…9f3c");
  assert.equal(titleOf({ event: "binding_linked", change: "rebind", wallet: "0x12ab…9f3c", xUserId: "777", effectiveAt: "2026-10-10T00:00:00.000Z" }),
    "X account 777 changed its payout wallet to 0x12ab…9f3c; it takes effect at 2026-10-10T00:00:00.000Z, 48 hours from now, unless the account binds back");
  assert.equal(titleOf({ event: "binding_linked", change: "cancel", wallet: "0x12ab…9f3c", xUserId: "777" }), "X account 777 cancelled its pending wallet change; 0x12ab…9f3c stays");
  for (const t of ["idea_testing", "binding_linked"]) assert.equal(priorityOf({ event: t }), 4, "never ahead of money or results on X (site only anyway)");
});

test("the Sequencer's lines: fixed templates, plain words; new and retired games go to X, the rest stay on the site", () => {
  const b = { build: "b7", title: "Last Click", record: "12" };
  assert.equal(titleOf({ event: "seq_building", ...b, round: 1 }), 'The AI dev team started building "Last Click"');
  assert.equal(titleOf({ event: "seq_building", ...b, round: 2 }), 'The AI dev team started building "Last Click" (round 2)');
  assert.equal(titleOf({ event: "seq_pr", ...b, round: 1, pr: 41, failed: [] }), '"Last Click", round 1: pull request #41 is up; every check passed');
  assert.equal(titleOf({ event: "seq_pr", ...b, round: 2, pr: 42, failed: ["G4", "G9"] }), '"Last Click", round 2: pull request #42 is up; 2 checks failed (G4, G9)');
  assert.equal(titleOf({ event: "seq_verdict", ...b, round: 1, verdict: "ship", reason: "" }), 'The brain approved "Last Click". It goes live after one public hour unless the Safe vetoes it');
  assert.equal(titleOf({ event: "seq_verdict", ...b, round: 1, verdict: "rework", reason: "the timer can be gamed" }), 'The brain sent "Last Click" back for another round: the timer can be gamed');
  assert.equal(titleOf({ event: "seq_verdict", ...b, round: 3, verdict: "kill", reason: "three rounds without a pass" }), 'The brain dropped "Last Click": three rounds without a pass');
  const game = "0x12ab000000000000000000000000000000009f3c";
  assert.equal(titleOf({ event: "seq_shipped", ...b, slug: "lastclick", game, fundEth: 0.05 }), 'New game: "Last Click" is live at 0x12ab…9f3c. Its first 0.05 ETH waits one public hour');
  assert.equal(titleOf({ event: "seq_shipped", ...b, slug: "lastclick", game: "nope", fundEth: null }), 'New game: "Last Click" is live. It is waiting for funding');
  assert.equal(titleOf({ event: "game_retired", ...b, slug: "lastclick", game, days: 7, returnedEth: 0.012 }), '"Last Click" was retired after 7 days without players; 0.012 ETH went back to the treasury. Anything won stays claimable');
  assert.equal(titleOf({ event: "seq_nothing_today", day: "2026-10-09", tried: 2, record: "3" }), "Nothing good enough today: no new game shipped");
  assert.equal(titleOf({ event: "seq_nothing_today", day: "2026-10-09", tried: 0, record: "3" }), "No new game today: nothing was ready to build");
  for (const e of ["seq_shipped", "game_retired", "seq_nothing_today", "seq_online", "seq_started", "seq_killed", "seq_released", "seq_handoff"]) assert.ok(priorityOf({ event: e }) < 4 && onX(e), e);
  for (const e of ["seq_building", "seq_pr", "seq_verdict"]) { assert.equal(priorityOf({ event: e }), 4); assert.equal(onX(e), false, `${e} is site only`); }
  assert.equal(titleOf({ event: "seq_released", ...b, target: "site" }), 'A site change the AI dev team made is live: "Last Click"');
  assert.equal(seqKey({ event: "seq_released", ...b, target: "site" }), "seq:b7:seq_released");
  assert.equal(titleOf({ event: "seq_handoff", ...b, pr: 41 }), 'An engine change the AI dev team made waits for an owner\'s review: "Last Click" (pull request #41). It runs only after an owner merges it and the code timelock passes');
  assert.equal(priorityOf({ event: "seq_handoff" }), 3, "on X too: handed over, never 'fixed'");
  assert.equal(titleOf({ event: "seq_released", ...b, target: "module" }), 'A fee or split module the AI dev team made waits for the Safe: "Last Click". Nothing changes until the Safe approves it');
  assert.equal(seqKey({ event: "seq_pr", ...b, round: 2, pr: 42, failed: [] }), "seq:b7:r2:seq_pr");
  assert.equal(seqKey({ event: "seq_shipped", ...b, slug: "lastclick", game, fundEth: null }), "seq:b7:seq_shipped");
  assert.equal(seqKey({ event: "seq_nothing_today", day: "2026-10-09", tried: 0, record: "3" }), "seq:nothing:2026-10-09");
});

test("the dev team on X: switched on once, a build started (round 1), a build that missed the bar; keys dedupe", () => {
  const b = { build: "b7", title: "Last Click", record: "12" };
  assert.equal(seqKey({ event: "seq_online", record: "3" }), "seq:online", "once, ever");
  assert.equal(seqKey({ event: "seq_started", ...b }), "seq:b7:seq_started", "once per build");
  assert.equal(seqKey({ event: "seq_killed", ...b, rounds: 4 }), "seq:b7:seq_killed", "once per build");
  assert.match(titleOf({ event: "seq_online", record: "3" }), /^The AI dev team is switched on/);
  assert.equal(titleOf({ event: "seq_started", ...b }), 'The AI dev team started building "Last Click"');
  assert.equal(titleOf({ event: "seq_started", ...b, title: "see evil.example" }), "The AI dev team started a new build", "a link never reaches an X line");
  assert.equal(titleOf({ event: "seq_killed", ...b, rounds: 4 }), 'The AI dev team tried "Last Click" for 4 rounds; it did not make the bar and nothing shipped');
  assert.equal(titleOf({ event: "seq_killed", ...b, rounds: 1 }), 'The AI dev team tried "Last Click" for 1 round; it did not make the bar and nothing shipped');
  assert.equal(recordUrl("12"), "https://genomedna.xyz/api/log/12", "the proof link: the signed record");
  // module code: the Safe's approval is a chain event; the line says what it allows, never that anything is live
  assert.equal(titleOf({ event: "module_approved", codehash: `0x${"ab".repeat(32)}`, kind: "fee" }),
    "The Safe approved fee module code 0xabab…abab. It can now be registered and tested on a plate; the live fee is unchanged");
  assert.ok(onX("module_approved"));
});

test("live idea mode lines: why a build was picked, an idea the brain will not build, an idea's verdict; keys dedupe", () => {
  const b = { build: "b7", title: "Last Click", record: "12" };
  assert.equal(titleOf({ event: "seq_started", ...b, reason: "small, testable, and holders asked for it" }), 'The AI dev team started building "Last Click". Why this one: small, testable, and holders asked for it');
  assert.equal(titleOf({ event: "seq_started", ...b }), 'The AI dev team started building "Last Click"');
  assert.equal(titleOf({ event: "seq_declined", idea: "im:4", title: "Last Click", reason: "it needs custody", record: "12" }), 'The AI dev team will not build "Last Click": it needs custody');
  assert.equal(seqKey({ event: "seq_declined", idea: "im:4", title: "t", reason: "r", record: "12" }), "seq:declined:im:4");
  assert.equal(titleOf({ event: "idea_judged", idea: 4, title: "Last Click", verdict: "queued", reason: "a clear game" }), 'Idea "Last Click" was accepted and is queued for the AI dev team: a clear game');
  assert.equal(titleOf({ event: "idea_judged", idea: 4, title: "", verdict: "rejected", reason: "" }), "Idea #4 was not taken");
  for (const e of ["seq_declined", "idea_judged"]) assert.equal(onX(e), false, `${e}: live idea mode only`);
});

test("status, recap and milestones: lines from code numbers; ranked below money and games, above the rest", () => {
  const status = { event: "status", hours: 12, swaps: 41, volumeEth: 3.21, feesEth: 0.0642, burnedDna: 120_000, buybackPotEth: 0.12, jackpotPotEth: 1.5, gamesLive: 2,
    liveFee: { basePct: 2, multiplier: 1.5, capPct: 5 }, testing: { stage: "canary", plate: "B" }, devTeam: { stage: "building", round: 2, title: "Last Click" }, changed: ["gamesLive"] };
  assert.equal(titleOf(status), 'Last 12 h: 41 swaps, 3.21 ETH volume, 0.0642 ETH in fees, 120,000 DNA burned; buyback pot 0.12 ETH, jackpot pot 1.5 ETH; 2 games live; live fee 2% (canary on plate B); the dev team is building "Last Click" (round 2)');
  assert.equal(titleOf({ ...status, jackpotPotEth: undefined, testing: undefined, devTeam: { stage: "idle" } }),
    "Last 12 h: 41 swaps, 3.21 ETH volume, 0.0642 ETH in fees, 120,000 DNA burned; buyback pot 0.12 ETH; 2 games live; live fee 2%; the dev team is idle");
  assert.equal(titleOf({ event: "recap", days: 7, gamesShipped: 1, siteChanges: 0, buildsKilled: 2, gamesRetired: 1, experimentsKept: 1, experimentsKilled: 3, gamesLive: 2, liveFee: { basePct: 2 } }),
    "Week: 1 game shipped, 0 site changes, 2 builds killed, 1 game retired; experiments 1 kept, 3 killed; 2 games live, live fee 2%");
  assert.equal(titleOf({ event: "milestone", metric: "dna_burned", threshold: 1_000_000, value: 1_204_332 }), "Milestone: 1,000,000 DNA burned in total (now 1,204,332)");
  assert.equal(titleOf({ event: "milestone", metric: "jackpot_pot", threshold: 1, value: 1.08 }), "Milestone: the jackpot pot passed 1 ETH (now 1.08 ETH)");
  // the digest's slot, money, games, the dev team and experiments, status / recap / milestones, the rest
  assert.deepEqual(["digest", "reward_paid", "seq_shipped", "seq_started", "outcome", "status", "recap", "milestone", "mystery_sealed"].map((e) => priorityOf({ event: e })), [0, 1, 2, 3, 3, 3.5, 3.5, 3.5, 4]);
  // 20 posts queued at once on a day with 14 event slots (an X_DAILY_POSTS=15 day), lowest rank first: they go to money, games, the dev team and
  // experiments, then status / recap / milestones; "the rest" waits for the digest
  const order = [["mystery_sealed", 5], ["milestone", 2], ["recap", 1], ["status", 3], ["seq_started", 2], ["outcome", 3], ["game:BallotRun", 2], ["game:Drawn", 2]] as const;
  const q = order.flatMap(([k, n]) => Array.from({ length: n }, () => (k.startsWith("game:") ? { event: "game", name: k.slice(5) } : { event: k })))
    .map((event, i) => ({ id: String(i + 1), type: "post", event }));
  const sent = [...q].sort((a, b) => rankOf(a) - rankOf(b) || Number(a.id) - Number(b.id)).slice(0, 14).map((i) => typeOf(i.event));
  assert.deepEqual(sent.slice(0, 9), ["jackpot_drawn", "jackpot_drawn", "ballot_result", "ballot_result", "seq_started", "seq_started", "outcome", "outcome", "outcome"]);
  assert.deepEqual(sent.slice(9).sort(), ["milestone", "milestone", "recap", "status", "status"]);
  assert.ok(!sent.includes("mystery_sealed"), "the rest waits for the digest");
  assert.equal(bucketOf("status"), "other", "a status that did not fit is counted with the rest in the digest");
});

test("planted: model-written text on a Sequencer line is cut, flattened, and kept off X when it carries a link", () => {
  const b = { build: "b7", title: "Last Click", round: 1, record: "12" };
  const long = titleOf({ event: "seq_verdict", ...b, verdict: "rework", reason: `the timer\n\ncan be ${"gamed ".repeat(400)}` });
  assert.ok(!/[\n\r]/.test(long), "one line");
  assert.ok(Buffer.byteLength(long.split(": ").slice(1).join(": ")) <= 160, "the reason is at most 160 bytes");
  assert.match(long, /^The brain sent "Last Click" back for another round: the timer can be gamed gamed/);
  const evil = titleOf({ event: "seq_building", ...b, title: "Last\u202e Click\nhttps://evil.example" });
  assert.equal(evil, 'The AI dev team started building "Last Click https://evil.example"', "site only: flattened to one line, no control or format characters");
  assert.equal(plain("ｆｕｌｌ\twidth", 120), "full width", "NFKC");
  assert.equal(titleOf({ event: "seq_pr", ...b, pr: 4, failed: ["G4", "G4; rm -rf", "x", 7, "G123"] }), '"Last Click", round 1: pull request #4 is up; 1 check failed (G4)');
  const game = "0x12ab000000000000000000000000000000009f3c";
  assert.equal(titleOf({ event: "seq_shipped", ...b, title: "Click evil.example now", slug: "lastclick", game, fundEth: null }), "A new game is live at 0x12ab…9f3c. It is waiting for funding");
  assert.equal(titleOf({ event: "game_retired", ...b, title: "ask @someone", slug: "lastclick", game, days: 7, returnedEth: null }), "A game was retired after 7 days without players. Anything won stays claimable");
  assert.equal(titleOf({ event: "game_retired", ...b, slug: "lastclick", game, days: 1, returnedEth: null, rule: "evict" }), '"Last Click" was retired to make room for a new game: it had the fewest players of the live games. Anything won stays claimable');
  assert.equal(titleOf({ event: "seq_shipped", ...b, slug: "lastclick", game, fundEth: null }), 'New game: "Last Click" is live at 0x12ab…9f3c. It is waiting for funding');
});

test("a long reason in a line is cut at a word, with an ellipsis", async () => {
  const { titleOf } = await import("../src/announce.ts");
  const t = titleOf({ event: "seq_started", build: "b1", title: "A game", reason: `${"word ".repeat(80)}tail`, record: "1" } as never);
  assert.match(t, /Why this one: (word )+word…$/);
});
