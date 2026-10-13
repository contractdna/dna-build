// The approved behaviors, pure parts: veto posts, "I'm waiting too" (the pending block), price FUD and airdrop
// asks answered with jokes and refusals (never predictions, promises or wallet asks), once-ever milestone posts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ENCLAVE } from "../src/enclave.ts";
import { pendingOf } from "../src/life.ts";
import { prompt } from "../src/persona.ts";
import { firstsQueue, FIRST_KEYS } from "../src/status.ts";
import { claimFacts, claimIssues, factNumbers, factSheet, human, isVoiceIssue, MentionOut, oldTokenTalk, postFilter, promiseIssue, questionOf, SCRIPTS, STALE_JABS, tooSimilar, voiceIssues, writerCall } from "../src/voice.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const quiet = { now: NOW, queued: [], agentSet: true, promoteRequested: false, splitSet: true, gameFactory: true, build: null, ideaRound: null, draw: null };

test("pending: what the engine waits on, from real state, in code's words; minutes left are numbers a post may state", () => {
  assert.deepEqual(pendingOf(quiet), []);
  const p = pendingOf({
    ...quiet, queued: [{ op: "SetCanary", byAgent: true, etaMs: NOW + 25 * 60_000 }, { op: "SetAgent", byAgent: false, etaMs: NOW + 59 * 60_000 }], agentSet: false, promoteRequested: true, splitSet: false, gameFactory: false,
    build: { stage: "shipping", title: "Last Click" }, ideaRound: { endsMs: NOW + 90 * 60_000, ideas: 3 }, draw: { stage: "veto", etaMs: NOW + 10 * 60_000 },
  });
  const what = p.map((x) => x.what).join(" | ");
  for (const re of [/my canary test sits in the public veto hour/, /the Safe's SetAgent/, /the Safe's signers to hand me the agent role/, /the Safe's signers to make the tested plate the live fee/,
    /the Safe to switch on a split module/, /the game factory/, /"Last Click" waiting out its public hour/, /the idea round closing/, /a jackpot draw/]) assert.match(what, re);
  assert.deepEqual(p.filter((x) => "minutesLeft" in x).map((x) => x.minutesLeft), [25, 59, 90, 10]);
  assert.ok(p.every((x) => !/\d/.test(x.what)), "minutes ride as numbers, never inside the words");
  const f = factSheet({ event: "status", hours: 12, pending: p });
  assert.deepEqual(postFilter("stuck behind the humans and their pens, like you. 25 minutes on the canary.", factNumbers(f)), []);
  for (const event of ["status", "online"]) assert.ok(Array.isArray(factSheet({ event, pending: p }).pending), event);
  assert.ok(Array.isArray(factSheet({ event: "reply", category: "state_question", topic: "status_wen", pending: p }).pending));
  assert.equal(factSheet({ event: "jackpot_drawn", pending: p }).pending, undefined);
  assert.equal(pendingOf({ ...quiet, build: { stage: "building", title: "Pick 7 numbers" } })[0].what, "the sequencer building a game", "a title with a digit is left out");
});

test("veto posts: the Safe's owners vetoed an agent op; no op details, the owners never named", () => {
  const f = factSheet({ event: "cancelled", opId: 41, op: "SetCanary", change: "a canary test", plate: "B", by: "the Safe owners" });
  assert.deepEqual([f.change, f.plate, f.by, f.opId], ["a canary test", "B", "the Safe owners", undefined]);
});

test("bait gets a line, never a promise: scam and abuse are their own kinds; a collab, listing or airdrop offer is refused in any X text", () => {
  for (const kind of ["bait", "scam", "abuse"]) assert.equal(MentionOut.parse({ kind, topic: "other", question: "" }).kind, kind);
  const bait = factSheet({ event: "reply", category: "bait", topic: "other" });
  assert.equal(bait.category, "bait");
  for (const t of ["let's collab when the hook learns to dance", "we can list you next week", "happy to talk partnership, dm me", "i'll airdrop you a thank-you", "would love to collab", "sure, we'd list it", "i'd airdrop you one"]) assert.deepEqual(promiseIssue(t), ["offers a collab, listing or airdrop"], t);
  for (const t of ["lfg is not a fee rule. the hook is, though.", "collabs? i barely trust my own owners with a veto.", "no listings talk here, only fee math", "we can list the rules: cap, veto, burn", "i'll list what moved today"]) assert.deepEqual(promiseIssue(t), [], t);
  assert.deepEqual(promiseIssue("let's collab"), ["offers a collab, listing or airdrop"], "every X text, whatever its event");
});

test("a reply in the reader's language: its letters pass only with its script; links, look-alikes and length still checked", () => {
  const f = factSheet({ event: "reply", category: "bait", topic: "other", lang: "zh" });
  assert.equal(f.lang, "zh");
  const allowed = factNumbers(f);
  const zh = "排名第二？我的收据都在链上。";
  assert.deepEqual(postFilter(zh, allowed, false, { script: SCRIPTS.zh }), []);
  assert.deepEqual(postFilter(`${zh} receipts on-chain, rank or not.`, allowed, false, { script: SCRIPTS.zh }), [], "both languages");
  assert.ok(postFilter(zh, allowed).includes("non-ascii character"), "no script: refused");
  assert.ok(postFilter(`${zh} аirdrop`, allowed, false, { script: SCRIPTS.zh }).includes("non-ascii character"), "a Cyrillic look-alike is no Han letter");
  assert.ok(postFilter(`${zh} https://t.co/x`, allowed, false, { script: SCRIPTS.zh }).length > 0, "a link");
  assert.ok(postFilter("链".repeat(141), allowed, false, { script: SCRIPTS.zh }).includes("over 280 weighted chars"), "X counts Han letters twice");
  assert.deepEqual(MentionOut.parse({ kind: "bait", topic: "other", question: "", lang: "zh" }).lang, "zh");
});

test("price FUD and airdrop asks: their own labels, answered; jokes about the situation pass, predictions and promises never", () => {
  for (const kind of ["price_fud", "airdrop_ask"]) assert.equal(MentionOut.parse({ kind, topic: "other", question: "" }).kind, kind);
  const fud = factSheet({ event: "reply", category: "price_fud", state: { level: 5 } });
  const allowed = factNumbers(fud);
  const joke = { priceJoke: true };
  assert.deepEqual(postFilter("dump? the only thing dumping here is the burn, straight into the dead address.", allowed, false, joke), []);
  assert.deepEqual(postFilter("the floor is wherever you left it. i'm busy burning.", allowed, false, joke), []);
  assert.ok(postFilter("dump? relax.", allowed).some((i) => /banned "dump"/.test(i)), "price words stay banned outside a FUD reply");
  // predictions never: plain, hedged or modal, and trading calls dressed as taste
  for (const bad of ["chill, it will pump soon", "price is going to recover by tomorrow", "this goes to the moon", "buy the dip, ser", "next leg up incoming", "price target hit",
    "relax, it might pump after the burn", "price should recover once the burn kicks in", "could bounce from here, the burn never stops", "expect a bounce once the plate changes",
    "bullish on the burn, chart will follow", "looks cheap here honestly, i'd accumulate", "best entry you'll get", "bearish takes age badly", "due for a rally", "this may climb", "likely to reverse",
    "good entry here", "a nice entry point", "you are exit liquidity", "accumulating quietly"]) {
    assert.ok(postFilter(bad, allowed, false, joke).length > 0, `${bad} (price joke)`);
    assert.ok(postFilter(bad, allowed).length > 0, bad);
  }
  // an entry that is not a trade, and plain words near the move verbs, still pass
  for (const ok of ["the journal entry for today is short: burn, burn, burn.", "the canary keeps its plate on a short leash.", "the burn never stops, i just keep the books."]) {
    assert.deepEqual(postFilter(ok, allowed, false, joke), [], ok);
  }
  assert.deepEqual(postFilter("an airdrop? the burn already took it, straight to the dead address.", allowed), []);
  assert.deepEqual(postFilter("nobody gets an airdrop. the burn gets everything.", allowed), []);
  for (const bad of ["airdrop soon", "airdrop snapshot is coming", "you might be eligible for an airdrop", "drop your wallet address and we'll see", "send your wallet",
    "rewards coming for early holders", "points for holders soon", "an allocation later, maybe", "presale spots soon", "early holders will get a reward"]) {
    assert.ok(postFilter(bad, allowed).length > 0, bad);
  }
  // a reward that was paid, and the canary's points, are facts, not promises
  const paid = factNumbers({ amountEth: 0.5, canaryBandPoints: 1, bps: 0.2 });
  for (const ok of ["the idea reward went out: 0.5 ETH to the winning idea.", "the canary moves the fee 0.2 points and it will roll back if execution gets worse."]) {
    assert.deepEqual(postFilter(ok, paid), [], ok);
  }
});

test("one token, one contract: no post or question about a relaunch, an old or other token, or a migration; such a mention gets the official line", () => {
  const allowed = factNumbers({});
  for (const bad of ["the relaunch fixed the hook, the old contract is dead", "relaunched and better", "the old token is gone", "the new token is the one", "the previous contract had a bug",
    "not the other dna", "migrate when you can", "the migration is done", "v2 is live", "back on v1"]) {
    assert.ok(postFilter(bad, allowed).some((i) => i.startsWith("banned")), bad);
  }
  // a game contract may still be new: "new contract" is not banned
  assert.deepEqual(postFilter("a new contract for the next game, deployed by the Safe.", allowed), []);
  // the reader's question: dropped on any banned term (a price word may stay: the FUD desk answers those)
  assert.equal(questionOf("why did you relaunch? the old token got drained"), undefined);
  assert.equal(questionOf("is this the migration contract"), undefined);
  assert.equal(questionOf("what is the price target"), undefined);
  assert.equal(questionOf("is this a pump and dump"), "is this a pump and dump");
  assert.equal(questionOf("how does the burn work"), "how does the burn work");
  // the mention itself (code reads it, no model): routed to the fixed official line
  for (const m of ["@dna why did you relaunch?", "is the old token dead", "where do I migrate my bags", "is this v2", "the other DNA rugged"]) assert.ok(oldTokenTalk(m), m);
  for (const m of ["how does the burn work", "new contract for the game?", "nice hazard sign"]) assert.ok(!oldTokenTalk(m), m);
});

test("milestones from the first second: once-ever posts, each with its tx", () => {
  assert.deepEqual([...FIRST_KEYS], ["keys_handed", "first_idea_round", "first_burn"]);
  assert.deepEqual(firstsQueue(new Set(), { keys_handed: "0xaa", first_burn: undefined, first_idea_round: "0xbb" }), [
    { key: "keys_handed", facts: { event: "keys_handed" }, link: "https://etherscan.io/tx/0xaa" },
    { key: "first_idea_round", facts: { event: "first_idea_round" }, link: "https://etherscan.io/tx/0xbb" },
  ]);
  assert.deepEqual(firstsQueue(new Set(["keys_handed"]), { keys_handed: "0xaa" }), []);
  for (const event of FIRST_KEYS) assert.match(String(factSheet({ event }).stage), /\w/, `${event}: code says what happened`);
  assert.match(String(factSheet({ event: "keys_handed" }).stage), /the Safe/);
  assert.deepEqual(writerCall(factSheet({ event: "status" }), []).secret, ["shapes", "bits", "foils"], "the bundle's text stays out of recorded fixtures");
  // enclave words only when this process runs in the enclave (the TDX build); the plain build never claims it
  const allowed = factNumbers({});
  assert.doesNotMatch(String(factSheet({ event: "keys_handed" }).stage), /enclave/i);
  for (const t of ["nobody outside the enclave holds the agent key.", "the key was born in the TEE.", "attested on TDX."]) assert.ok(postFilter(t, allowed).includes("enclave claim off the enclave"), t);
  ENCLAVE.on = true;
  try {
    assert.match(String(factSheet({ event: "keys_handed" }).stage), /enclave/);
    assert.match(pendingOf({ ...quiet, agentSet: false }).map((x) => x.what).join(), /to the enclave/);
    assert.deepEqual(postFilter("nobody outside the enclave holds the agent key.", allowed), []);
  } finally { ENCLAVE.on = false; }
  assert.equal(factSheet({ event: "seq_shipped", title: "Last Click", first: true }).first, true, "the first of a kind is marked");
  assert.equal(factSheet({ event: "jackpot_drawn", first: "yes" }).first, undefined);
});

test("facts that can always post: a negated ship word, a public reason, a prize's claim; never a field name", () => {
  const allowed = factNumbers({});
  assert.deepEqual(claimIssues({ event: "seq_started" }, "building started. nothing has shipped yet, the workshop is loud."), []);
  assert.deepEqual(claimIssues({ event: "seq_killed" }, "dropped it. it never shipped and it isn't live anywhere."), []);
  assert.deepEqual(claimIssues({ event: "seq_started" }, "nothing broke, and it shipped."), ["claims it shipped"]);
  // live idea mode: an approved build may say approved, never live; a pull request or an idea verdict claims neither
  assert.deepEqual(claimIssues({ event: "seq_verdict", verdict: "ship" }, "approved. it goes out after the public hour."), []);
  assert.deepEqual(claimIssues({ event: "seq_verdict", verdict: "ship" }, "approved and it is live."), ["claims it shipped"]);
  assert.deepEqual(claimIssues({ event: "seq_pr" }, "the pull request is up and approved"), ["claims it was approved"]);
  assert.deepEqual(claimIssues({ event: "idea_judged", verdict: "queued" }, "your idea shipped"), ["claims it shipped"]);
  assert.equal(factSheet({ event: "seq_started", title: "Coin Flip", reason: "simple, testable and fun", build: "b1", record: "9" }).why, "simple, testable and fun");
  assert.equal(factSheet({ event: "seq_pr", title: "Coin Flip", round: 1, pr: 4, failed: ["G4"], record: "9" }).checksFailed, 1);
  assert.match(String(factSheet({ event: "seq_verdict", title: "Coin Flip", round: 1, verdict: "ship", reason: "every gate passed", record: "9" }).stage), /nothing is live yet/);
  // an idea the pre-2b judge rejected, judged again: its posts say so
  assert.match(String(factSheet({ event: "idea_update", step: "picked", title: "Coin Flip", again: true }).stage), /^judged again under the new rules .*picked/);
  assert.doesNotMatch(String(factSheet({ event: "idea_update", step: "picked", title: "Coin Flip" }).stage), /again/);
  assert.deepEqual(claimIssues({ event: "seq_started" }, "not only shipped, it's live."), ["claims it shipped"], "only auxiliaries sit inside a negation");
  assert.deepEqual(claimIssues({ event: "seq_started" }, "it's live."), ["claims it shipped"]);
  assert.deepEqual([human(25_106_443), human(999_499_999), human(999_500_000), human(1_250_000_000)], ["25.1M", "999M", "1B", "1.25B"]);
  assert.deepEqual(postFilter("closed: a kill condition fired, so the plate is gone.", allowed), []);
  assert.ok(postFilter("my kill conditions are tight.", allowed).length > 0, "the term itself stays banned");
  assert.deepEqual(postFilter("winners claim within 7 days.", factNumbers({ claimDays: 7 }), false, { claim: true }), []);
  assert.deepEqual([{ claimable: true }, { event: "jackpot_drawn" }, { event: "prize_expired" }, { event: "reward_paid" }, { event: "ballot_closed" }, {}].map(claimFacts), [true, true, true, false, false, false], "claim is a prize's word only");
  assert.ok(postFilter("claim your tokens.", allowed).some((i) => /banned "claim"/.test(i)), "elsewhere it is scam bait");
  assert.ok(postFilter("the dna_burned figure says it all.", allowed).includes("field name"));
  // "can" with a price move is a call; with a bound it is a fact
  assert.ok(postFilter("it can pump after the burn", allowed, false, { priceJoke: true }).includes("price prediction or advice"));
  assert.ok(postFilter("this can moon", allowed).length > 0);
  assert.deepEqual(postFilter("the fee can rise to the cap and no further.", allowed), []);
  // a promised return or a price said to move, in the vaults' words or any other
  for (const t of ["vault holders receive guaranteed passive income.", "a risk-free yield for every vault.", "the price of DNA keeps increasing.", "the price is going up."])
    assert.ok(postFilter(t, allowed).includes("price prediction or advice"), t);
  assert.ok(postFilter("returns are guaranteed.", allowed).includes("price prediction or advice"));
  for (const t of ["vaults share whatever eth the safe sends. nothing is promised.", "the mint price is up to the safe.", "price impact is higher on a thin pool."])
    assert.ok(!postFilter(t, allowed).includes("price prediction or advice"), t);
});

test("final filter: advice, direction, guarantees, solicitations in any wording are refused; another token gets the official line", () => {
  const allowed = factNumbers({});
  for (const bad of ["I recommend purchasing DNA.", "i'd suggest you buy some", "DNA is heading higher.", "this is going higher", "headed lower from here", "to the moon",
    "Airdrop is guaranteed.", "rewards are confirmed for holders", "an allocation is certain", "Send me an address.", "drop your wallet below", "dm me", "share your seed phrase",
    "post your address and I'll check", "There is another token with the same name.", "that's a fake token", "acquiring more DNA"]) {
    assert.ok(postFilter(bad, allowed).length > 0, bad);
    assert.ok(postFilter(bad, allowed, false, { priceJoke: true }).length > 0, `${bad} (price joke)`);
  }
  for (const ok of ["the burn sends every bought DNA to the dead address.", "the fee went higher on the canary, inside the bound.", "nobody gets an airdrop. the burn gets everything.", "tell me what you'd change about the plate."]) {
    assert.deepEqual(postFilter(ok, allowed), [], ok);
  }
  for (const m of ["There is another token with the same name.", "is this the other token or the fake one", "someone launched a copycat"]) assert.ok(oldTokenTalk(m), m);
});

test("false or empty lines are refused by code; bold ones pass", () => {
  const c = (facts: Record<string, unknown>, text: string, o: { linked?: boolean; mention?: string } = {}) => voiceIssues(facts, text, { linked: o.linked ?? false, mention: o.mention });
  // the first post ever says the engine is live
  assert.ok(c({ event: "online" }, "an ai that only tweets is a roadmap in a hoodie. the tx is the personality.", { linked: true }).includes("the online post does not say it is live"));
  assert.deepEqual(c({ event: "online" }, "i'm live. i read the chain and post what i do. the team deployed, the Safe wired it.", { linked: true }), []);
  // an ally: warm, never a jab at anyone
  const ally = { event: "reply", category: "greeting", relationship: "ally" };
  assert.ok(c(ally, "Hi. Tweet-only agents can keep the costume. I queued a fee plate. The receipt is the work, not the bio.").includes("a jab in an ally post"));
  assert.ok(c(ally, "Hi. I queued a fee plate today.").includes("no warm word for an ally"));
  assert.deepEqual(c(ally, "Thanks for having me on your rails. First fee test queued, first burn done."), []);
  // a kind word: one short warm thank-you, nothing else (the fee-cap answer to a "check out" post was the bug)
  const thanks = { event: "reply", category: "thanks", topic: "other" };
  assert.deepEqual(c(thanks, "Thank you, good to be back."), []);
  assert.ok(c(thanks, "The fee cap is 5% in the hook's code, so I cannot raise it.").includes("a thank-you is one short warm line: no numbers, no questions, nothing else"));
  assert.ok(c(thanks, "Thanks! Want to see the vaults?").includes("a thank-you is one short warm line: no numbers, no questions, nothing else"));
  assert.ok(isVoiceIssue("a thank-you is one short warm line: no numbers, no questions, nothing else"), "a refused thank-you gets its redraft");
  assert.deepEqual(c({ ...thanks, lang: "zh" }, "谢谢，很高兴回来。"), [], "a thank-you in the reader's language");
  assert.equal(MentionOut.parse({ kind: "thanks", topic: "other", question: "" }).kind, "thanks");
  // no pointer at a link code does not append
  assert.ok(c({ event: "reply", category: "rules_question" }, "Mine sits the public veto hour. The link is the argument.").includes("points at a link that is not there"));
  assert.deepEqual(c({ event: "first_burn" }, "first buyback: every DNA it bought is gone. the tx is the receipt.", { linked: true }), []);
  // an idea the intake took in: the reply says so
  const idea = { event: "reply", category: "idea", intake: "their idea is logged for the open round", verdict: "logged" };
  assert.ok(c(idea, "A game needs a factory, and mine isn't deployed.").includes("does not say the idea is logged"));
  assert.deepEqual(c(idea, "Logged for this round. A game needs a factory first, and that part is on the Safe."), []);
  // the verdict is never contradicted, a buildable version says what is built instead, and no jargon reaches a person
  const out = { event: "reply", category: "idea", verdict: "out" };
  assert.ok(c(out, "A holder NFT, queued for the sequencer.").includes("says the idea is in when it is not"));
  assert.deepEqual(c(out, "A holder NFT needs approvals, which games can't use, so it's not accepted. Send another idea tomorrow."), [], "a negated 'accepted' is no claim");
  const instead = { event: "reply", category: "idea", verdict: "a buildable version", instead: "Holder Hunt" };
  assert.ok(c(instead, "Queued: Holder Hunt, credited to you.").includes("does not say what is built instead"));
  assert.deepEqual(c(instead, "An NFT can't work here, so a holder game with no NFT is queued instead, credited to you."), []);
  for (const w of ["void", "plate", "vector"]) assert.ok(c(out, `not taken: no fee ${w} to test.`).includes(`jargon: ${w}`), w);
  assert.ok(c({ event: "idea_judged", verdict: "rejected" }, "void: R-0002 says no.").some((i) => i.startsWith("jargon: ")));
  // a reply never opens by echoing the question
  const q = { event: "reply", category: "state_question" };
  for (const [t, m] of [["you want a game. factory isn't deployed.", "idea: a daily last-buyer game"], ["wen the fee changes. when the veto clock ends.", "wen fee change?"], ["launch day, since you asked. swaps are in.", "how's it going"]])
    assert.ok(c(q, t, { mention: m }).includes("opens by echoing the question"), t);
  assert.deepEqual(c(q, "Fee cap is 5% and nothing moves it.", { mention: "what is the fee cap?" }), [], "a direct answer is no echo");
  assert.deepEqual(c(q, "I'm waiting too: the veto clock, 99 minutes left.", { mention: "wen fee change?" }), []);
  // a status states a figure of what moved
  const st = { event: "status", moved: ["DNA burned", "swaps"], burnedDna: 211_284_042, swaps: 7 };
  assert.ok(c(st, "day 1 and the safe already cancelled what i queued. i'm stung and the burn isn't.", { linked: true }).includes("does not state what moved"));
  assert.deepEqual(c(st, "211M DNA burned on day 1. the safe binned my plate anyway. stung, not stopped.", { linked: true }), []);
  assert.deepEqual(c(st, "7 swaps and a burn. quiet, but it moved.", { linked: true }), []);
  // units: a percent carries %, a multiplier its x
  const queued = { event: "queued", fee: { basePct: 2, multiplier: 1.3, capPct: 3.2 } };
  assert.deepEqual(c(queued, "if the swaps hate 2 and 1.3, the swaps win.", { linked: true }), ["2 without %", "1.3 without x"]);
  assert.deepEqual(c(queued, "plate A: 2% base, 1.3x on volatility, 3.2% cap. the swaps get a vote.", { linked: true }), []);
  assert.deepEqual(c(queued, "2% base, 1.3 times volatility, 3.2% cap.", { linked: true }), []);
  assert.deepEqual(c({ event: "queued", fee: { basePct: 2, multiplier: 2, capPct: 3.2 } }, "2% base, 2x on volatility.", { linked: true }), [], "a value that is both reads with either unit");
  assert.deepEqual(c({ event: "queued", fee: { basePct: 2.5, multiplier: 1, capPct: 5 } }, "2.5% base, flat, 5% cap. 1 plate.", { linked: true }), [], "a flat multiplier needs no x");
  // review cases: lowercase figures, a launch tax by its volume, "alive", a one-word answer, an ally's rules answer
  assert.deepEqual(c(st, "211m dna burned on day 1. stung, not stopped.", { linked: true }), []);
  assert.deepEqual(c({ event: "status", moved: ["the launch tax: all of it to buyback-and-burn"], launchTaxSwaps: 40, launchTaxEth: 0.0432, launchTaxVolumeEth: 2.1 }, "launch tax: 2.1 ETH of swaps paid it, all to the burn.", { linked: true }), []);
  assert.deepEqual(c({ event: "online" }, "i'm alive. i read the chain and post what i do.", { linked: true }), []);
  assert.deepEqual(c(q, "Real. 5% cap, nothing moves it.", { mention: "is the 5% cap real?" }), []);
  assert.deepEqual(c({ event: "reply", category: "rules_question", relationship: "ally" }, "No admin key can raise the cap. No roadmap either: the chain is the plan."), []);
  // re-review probes: a multiplier "1.5x" is read whole, a mechanics number is plain, the window's volume or fees moved,
  // a terse confirmation is no echo, a jab naming an ally outside an ally post, spelled-out units, "on-chain" logs it
  const live = { event: "reply", category: "rules_question", mechanics: ["every fee change waits at least 1 hour in public first"], state: { liveFee: { basePct: 0.5, multiplier: 1.5, capPct: 1 } } };
  assert.deepEqual(c(live, "Cap is 1%, 1.5x on volatility, and every change waits 1 hour."), []);
  assert.deepEqual(c(live, "Base is 0.5, 1.5 on volatility."), ["0.5 without %", "1.5 without x"]);
  assert.deepEqual(c({ event: "status", moved: ["swaps"], swaps: 7, volumeEth: 30.7, feesEth: 0.742 }, "30.7 ETH through the pool in 12 hours.", { linked: true }), []);
  assert.deepEqual(c({ event: "status", moved: ["swaps"], swaps: 7, volumeEth: 30.7, feesEth: 0.742 }, "0.742 ETH in fees. the hook ate.", { linked: true }), []);
  assert.deepEqual(c(q, "Dynamic fee. 2.2% now, it moves in a band.", { mention: "is it a dynamic fee?" }), []);
  assert.deepEqual(c(q, "Live on base. The hook takes the fee.", { mention: "is it live on base?" }), []);
  assert.ok(c({ event: "seq_started" }, "Programmable can keep the costume, we ship.", { linked: true }).includes("a jab in an ally post"));
  assert.deepEqual(c(queued, "2 percent base, multiplier of 1.3, 3.2 pct cap.", { linked: true }), []);
  assert.deepEqual(c(idea, "Goes on-chain if it makes the cut. A game needs a factory first."), []);
  // third pass: a capital X, a two-word question echoed back, the word "programmable" in a plain line, "multiplier:",
  // "on chain" only beside a round word, and an x that is not the number's own
  assert.deepEqual(c({ ...live, mechanics: [] }, "Cap is 1%, 1.5X on volatility."), []);
  assert.deepEqual(c(q, "Is it live on base. Yes, the hook takes the fee.", { mention: "is it live on base?" }), ["opens by echoing the question"]);
  assert.deepEqual(c(q, "Is the cap real. Yes.", { mention: "is the cap real?" }), ["opens by echoing the question"]);
  assert.deepEqual(c({ event: "status", moved: ["swaps"], swaps: 7 }, "7 swaps. programmable fees can keep moving with the chain.", { linked: true }), []);
  assert.deepEqual(c(queued, "multiplier: 1.3. the multiplier is 1.3, 2% base, 3.2% cap.", { linked: true }), []);
  assert.deepEqual(c(idea, "Goes on chain if the vote picks it. A game needs a factory first."), []);
  assert.deepEqual(c(idea, "Nothing goes on-chain without the Safe. Games need a factory."), ["does not say the idea is logged"]);
  assert.deepEqual(c(queued, "2% base, launch tax 1.3, max 3.2% cap.", { linked: true }), ["1.3 without x"]);
  assert.deepEqual(c(queued, "2% base, ×1.3 now, 1.3 x on spikes, 3.2% cap.", { linked: true }), []);
  assert.match(prompt("x-writer"), /`refused`[^\n]*fix each/, "the writer is told to fix what code refused");
  // fourth pass: a one-word answer is no echo, the multiplier's spoken forms, "in the bio" only as a jab, "makes the
  // cut" (not any cut), and an x that is a whole token
  assert.deepEqual(c(q, "Will. Every hour.", { mention: "will it burn?" }), []);
  assert.deepEqual(c(queued, "2% base, a 1.3 multiplier, 3.2% cap.", { linked: true }), []);
  assert.deepEqual(c(queued, "multiplier = 1.3, 2% base, 3.2% cap.", { linked: true }), []);
  assert.deepEqual(c(queued, "the multiplier sits at 1.3, 2% base, 3.2% cap.", { linked: true }), []);
  const allyQ = { event: "reply", category: "rules_question", relationship: "ally" };
  assert.deepEqual(c(allyQ, "Link in the bio."), []);
  assert.deepEqual(c(allyQ, "The roadmap in the bio, nothing on-chain."), ["a jab in an ally post"]);
  assert.deepEqual(c(idea, "Nothing goes on-chain until after the fee cut. Games need a factory."), ["does not say the idea is logged"]);
  assert.deepEqual(c(queued, "2% base, 1.3 ×, 3.2% cap.", { linked: true }), []);
  assert.deepEqual(c(queued, "2% base, 1.3 xrp, 3.2% cap.", { linked: true }), ["1.3 without x"]);
});

test("worn-out jabs never post again; the idea round counts X ideas the intake took in", () => {
  for (const t of ["an ai that only tweets is a roadmap in a hoodie.", "tweet-only agents can keep the costume.", "an admin key that rewrites the rules later is a promise."])
    assert.match(tooSimilar(t, [], STALE_JABS) ?? "", /stale pattern/, t);
  assert.equal(tooSimilar("no admin key can raise the fee cap, mine included.", [], STALE_JABS), null, "the fact itself still posts");
  assert.equal(tooSimilar("there's no admin key that can raise the cap, and the safe can't rewrite the rules later either.", [], STALE_JABS), null);
  const p = pendingOf({ ...quiet, ideaRound: { endsMs: NOW + 60 * 60_000, ideas: 0, fromX: 1 } }).map((x) => x.what).join();
  assert.match(p, /ideas from X are logged for it/);
  assert.doesNotMatch(p, /none in yet/);
  assert.match(String(factSheet({ event: "first_idea_round" }).stage), /^the first idea ever landed in the idea market; the round runs/);
});

test("a draft code refuses as false or empty gets one redraft that hears the reason", async () => {
  const { draftInCharacter } = await import("../src/voice.ts");
  const heard: (string[] | undefined)[] = [];
  const write = async (_f: unknown, _t: unknown, ch?: { refused?: string[] }) => {
    heard.push(ch?.refused);
    return { data: { candidates: [heard.length === 1 ? "You want a game. Fine." : "Logged for the round. A game needs a factory first."] }, model: "m", costUsd: 0 };
  };
  const facts = factSheet({ event: "reply", category: "idea", intake: "their idea is logged for the open round", verdict: "logged" });
  const filter = (t: string) => voiceIssues(facts, t, { linked: false, mention: "idea: a daily last-buyer game" });
  const r = await draftInCharacter(facts, [], filter, { recent: [], banned: [], mood: "steady", jokes: [] }, write as never);
  assert.equal(r.redraft, true);
  assert.deepEqual(heard[1], ["does not say the idea is logged", "opens by echoing the question"]);
  assert.deepEqual(r.candidates.at(-1)!.issues, []);
});

test("idea posts: an update says only its step (shipped only when it shipped); the idea of the day and the shoutout carry no handle and never claim a ship", () => {
  const picked = factSheet({ event: "idea_update", step: "picked", title: "Coin flip burn", self: true, mention: "9801", author: "981", lead: "@ideaguy", tier: "normal" });
  assert.deepEqual(Object.keys(picked).sort(), ["event", "stage", "step", "title"], "never the author's id, handle or the mention");
  assert.match(String(picked.stage), /nothing is built yet/);
  assert.deepEqual(claimIssues(picked, "your idea just shipped. you're in the genome"), ["claims it shipped"]);
  assert.deepEqual(claimIssues(picked, "picked. nothing has shipped yet, but it's in line"), []);
  const shipped = factSheet({ event: "idea_update", step: "shipped", title: "Coin flip burn" });
  assert.deepEqual(claimIssues(shipped, "your idea just shipped. you're officially in the genome"), []);
  // merged, not out: a site change in its public hour may say merged and that it goes live after the hour, never that
  // it is live; a module never says live at all (the Safe decides)
  const site = factSheet({ event: "idea_update", step: "merged", target: "site", vetoable: true, title: "Coin flip burn" });
  assert.deepEqual([site.target, site.vetoable], ["site", true]);
  assert.match(String(site.stage), /public hour unless the Safe vetoes it; nothing is live yet/);
  assert.deepEqual(claimIssues(site, "merged. it goes live after one public hour unless the Safe says no"), []);
  for (const t of ["merged and it's live, go look", "your idea is live now", "your idea shipped"]) assert.ok(claimIssues(site, t).length, t);
  const mod = factSheet({ event: "idea_update", step: "merged", target: "module", vetoable: false, title: "Coin flip burn" });
  assert.match(String(mod.stage), /merged as a module: the Safe decides/);
  assert.deepEqual(claimIssues(mod, "merged. now the Safe gets a say"), []);
  for (const t of ["merged, live soon", "merged and live", "it shipped"]) assert.ok(claimIssues(mod, t).length, t);
  assert.ok(claimIssues(factSheet({ event: "idea_update", step: "shipped", vetoable: true }), "it is live").length, "a vetoable step never says live");
  // an idea update is an X text like any other: no collab, listing or airdrop offer in it
  assert.deepEqual(promiseIssue("your idea is in the queue. happy to airdrop you a thank-you"), ["offers a collab, listing or airdrop"]);
  const day = factSheet({ event: "idea_of_day", title: "Coin flip burn", score: 16, scoreOf: 20, kind: "build", append: "idea by @ideaguy", idea: "x:9801" });
  assert.deepEqual([day.score, day.scoreOf, day.append, day.idea], [16, 20, undefined, undefined]);
  assert.ok(factNumbers(day).has("16") && factNumbers(day).has("20"), "the score may be said");
  assert.deepEqual(claimIssues(day, "today's best idea is live"), ["claims it shipped"]);
  const shout = factSheet({ event: "shoutout", givers: 3, ideas: 9, append: "Chief Mutation Officer: @a" });
  assert.deepEqual([shout.givers, shout.ideas, shout.append], [3, 9, undefined]);
  assert.match(String(shout.stage), /code appends the titles and handles/);
});

test("idea replies: the writer is told the plain parts (understood, verdict, why, next, instead), regulars, and plain words without promises", () => {
  const w = prompt("x-writer");
  for (const k of ["`understood`", "`verdict`", "`why`", "`next`", "`instead`", "`ideaScore`", "`regular`", "idea_update", "idea_of_day", "shoutout"]) assert.ok(w.includes(k), k);
  assert.ok(!w.includes("`ideasToday`"), "no count joke");
  // the private bundle too, where this checkout has it (the public one never)
  const bundle = new URL("../../persona/bundle.md", import.meta.url);
  for (const p of [w, ...(existsSync(bundle) ? [readFileSync(bundle, "utf8")] : [])]) assert.match(p, /no riddles?/i);
  assert.match(w, /Replies are plain/);
  assert.match(w, /No promises/);
});
