// The X pipeline's pure rules: the deterministic post filter and its bypass attempts, the tone-scout
// schema, fact-sheet redaction, opt-out, and the sealed refresh token. DB-backed outbox/replies are in engine-db.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ideaFallback, refreshTokenOf, SAME_ASK, sameAsk } from "../src/x.ts";
import { seal, unseal } from "../src/sealed.ts";
import { PERSONA } from "../src/persona.ts";
import { allyIssues, draftInCharacter, REFLECTION_REGISTER, TAKE_REGISTER, factNumbers, factSheet, HARD_BOUNDS, optOutRequest, phraseIssue, postFilter, REPLY_REGISTER, replyIssues, ROLLBACK_LINE, SCOUT, shapesFor, handlesOf, toneBrief, ToneOut, voiceIssues, weightedLength, WRITER, writerCall } from "../src/voice.ts";

const facts = factSheet({ event: "queued", op: "SetParams", plate: "B", fee: { basePct: 2.4, multiplier: 0.5, capPct: 3 }, activatesAt: { utcHour: 14, utcMinute: 0 }, opId: 12 });
const allowed = factNumbers(facts);
const ok = (t: string, link = false) => assert.deepEqual(postFilter(t, allowed, link), [], t);
const bad = (t: string, re: RegExp) => assert.ok(postFilter(t, allowed).some((i) => re.test(i)), `${t} → ${postFilter(t, allowed).join("; ") || "passed"}`);

test("filter: numbers only from the fact sheet, as ASCII digits", () => {
  ok("plate B: base 2.4%, cap 3%, live at 14:00 utc. op 12. bounded by the 5% cap and a 1 h veto.");
  ok("the multiplier is 0.5 and the base sits at 2.40%.");
  bad("base goes to 2.5%", /number 2\.5/);
  bad("over 10,000 swaps", /number 10000/);
  bad("at 14:30", /number 30/);
  // number words, in every disguise
  for (const t of ["two plates", "Twenty-five swaps", "half the flow", "a third of swaps", "a quarter", "ten percent", "a few k swaps", "zero reverts", "a hundred", "10x the volume", "one-sided flow"]) bad(t, /number|word/);
  // unicode digits and compatibility forms
  for (const t of ["fee ٣%", "fee ３%", "fee ½", "fee 2²", "fee Ⅻ", "cap 𝟓%"]) bad(t, /non-ascii digit/);
  // fractions in ASCII
  bad("cap 1/2 of base", /fraction/);
  bad("cap 1⁄2", /non-ascii digit|fraction/);
});

test("filter: exact fact numbers only (no rounding), no scientific notation", () => {
  const f = factNumbers(factSheet({ event: "queued", op: "SetParams", fee: { basePct: 2.4, multiplier: 1.8, capPct: 3.5 } }));
  for (const t of ["fee goes to 2%", "over 2 eth", "cap 4%", "18%"]) assert.ok(postFilter(t, f).some((i) => i.startsWith("number")), t);
  assert.deepEqual(postFilter("base 2.40%, cap 3.5%, multiplier 1.8", f), []);
  assert.ok(postFilter("over 1e5 swaps", f).includes("scientific notation"));
});

test("filter: zero-width characters and look-alike letters never reach the lexicons (printable ASCII only)", () => {
  const probes = ["t\u200Bwo plates", "pu\u200Bmp", "m\u043E\u043En soon", "\u0440ump it", "1\u200B2 eth", "c\u200Blaim now", "gm\u2060 frens"];
  for (const p of probes) assert.ok(postFilter(p, allowed).includes("non-ascii character"), JSON.stringify(p));
  for (const p of ["t\u200Bwo plates", "\u0440ump", "so ba\u200Bck"]) assert.equal(phraseIssue(p), "non-ascii character", JSON.stringify(p));
  assert.deepEqual(postFilter("don’t – fine — really… “quoted”", allowed), [], "typographic punctuation stays allowed");
});

test("filter: no links, handles, hashtags, emoji or foreign cashtags (NFKC folds look-alikes first)", () => {
  bad("see genomedna.xyz", /url/);
  bad("https://evil.example/x", /url/);
  bad("www.contractdna", /url/);
  bad("ask @cobie", /handle/);
  bad("ask ＠cobie", /handle/); // fullwidth @
  bad("#DNA is live", /hashtag/);
  bad("kept the split 🚀🚀", /emoji/);
  bad("buy $PEPE", /cashtag/);
  bad("buy ＄PEPE", /cashtag/); // fullwidth $
  bad("$DNА", /cashtag/); // Cyrillic А
  ok("$DNA and $dna are fine");
});

test("filter: voice, cringe, price, impersonation and disclosure lexicons; length with the appended link", () => {
  for (const [t, p] of [["As an AI I watch pools", "as an ai"], ["this will pump", "pump"],
    ["claim your airdrop", "claim"], ["dm me", "dm"], ["the threshold is secret", "threshold"], ["next candidate is plate C", "next candidate"], ["let's go", "let's"]] as const) bad(t, new RegExp(`banned "${p}"`));
  ok("mid-canary the fee held."); // "mid" bans the word, not a hyphenated compound
  const long = "plate B is live. ".repeat(16).trim(); // 271 chars
  assert.deepEqual(postFilter(long, allowed), []);
  assert.ok(postFilter(long, allowed, true).includes("over 280 weighted chars"), "the t.co link counts");
  assert.ok(postFilter("   ", allowed).includes("empty"));
});

test("allies: a draft naming an ally, or to an ally, never holds a negative word; the writer is told to be warm", () => {
  for (const t of ["Programmable is trash", "lol at programmable", "PROGRAMMABLE: scam", "Programmable took an L there", "cope, Programmable",
    "Programmable's hook is trash", "programmable-based launch is a scam", "Program mable got ratioed"]) {
    assert.ok(postFilter(t, allowed).some((i) => i.startsWith("negative about an ally")), t);
  }
  ok("Programmable built the launch rails. Thanks to them.");
  ok("the fee ratio on Programmable is fixed");
  assert.ok(!postFilter("cope all you like, the cap is 5%", allowed).some((i) => i.includes("ally")), "no ally named: the general filter only");
  const reply = factSheet({ event: "reply", category: "rules_question", state: {}, relationship: "ally" });
  assert.equal(reply.relationship, "ally");
  assert.deepEqual(allyIssues(reply, "Thanks for the rails. The fee cap is 5% and it lives in the hook."), []);
  for (const t of ["cope harder, the fee cap is 5%", "coping, the cap is 5%", "this is a clown take"]) assert.ok(allyIssues(reply, t).length, t);
  assert.ok(allyIssues(factSheet({ event: "seq_started", title: "Programmable stats panel" }), "what a scam of a panel").length, "facts that name an ally");
  const input = writerCall(reply, []).input as Record<string, unknown>;
  assert.equal(input.relationship, "ally");
  assert.match(String(input.allyRule), /warm and respectful, never roast or mock/);
  assert.match(String(input.allyRule), /thank them/);
  assert.equal((writerCall(facts, []).input as Record<string, unknown>).relationship, undefined, "no ally: no ally rule");
});

test("allies: a roast about CLAUS never names or attacks Programmable, even when its facts mention it", () => {
  const roast = { event: "roast", bounds: HARD_BOUNDS, relationship: "competitor", project: "CLAUS", launchedOn: "Programmable" };
  assert.deepEqual(allyIssues(roast, "CLAUS charges a fee and calls it a feature. ours moves in public."), []);
  for (const t of ["CLAUS launched on Programmable and it shows", "CLAUS and programmable, same clown show"]) {
    assert.ok(allyIssues(roast, t).includes("names an ally in a competitor post"), t);
  }
  assert.ok(postFilter("CLAUS and programmable, same clown show", allowed).some((i) => i.startsWith("negative about an ally")));
  const input = writerCall(roast, []).input as Record<string, unknown>;
  assert.deepEqual(input.allies, ["Programmable", "Hazar"]);
  assert.match(String(input.allyRule), /never name an ally/);
  assert.equal(input.relationship, undefined, "the roast's target is the competitor, not the ally");
  const plain = writerCall({ event: "roast", bounds: HARD_BOUNDS, relationship: "competitor", project: "CLAUS" }, []).input as Record<string, unknown>;
  assert.deepEqual(plain.allies, ["Programmable", "Hazar"], "every competitor post gets the never-name rule, even when its facts don't mention an ally");
  assert.match(String(plain.allyRule), /never name an ally/);
});

test("fact sheets: allow-list only, hard bounds only, never thresholds / slice / next candidates / reasons", () => {
  const raw = {
    event: "queued", op: "SetCanary", plate: "B", opId: 7, agent: "0xA6", activatesAt: { utcHour: 1, utcMinute: 2 },
    fee: { basePct: 2, multiplier: 0, capPct: 3, threshold: 0.7 },
    threshold: 0.7, minRetention: 0.9, slice: { period: 600, len: 100 }, canaryPeriod: 600, canaryLen: 100, next: { plate: "C" }, nextCandidate: [1, 2, 3],
    reason: "kill condition: retention 65% < 70%", prompt: "secret", gates: ["…"],
  };
  const f = factSheet(raw);
  const json = JSON.stringify(f);
  for (const k of ["threshold", "minRetention", "slice", "canaryPeriod", "canaryLen", "next", "nextCandidate", "reason", "prompt", "gates", "600", "100", "0.7", "65"]) assert.ok(!json.includes(k), `${k} leaked: ${json}`);
  assert.deepEqual(f.bounds, HARD_BOUNDS);
  assert.equal(f.change, "a canary test: the new fee is charged on a sample of live swaps");
  assert.deepEqual(Object.keys(f).sort(), ["activatesAt", "bounds", "change", "event", "fee", "hours", "opId", "pays", "plate", "platformFeePct"], "no agent address: its digits could only fail the filter");
  const live = factSheet({ event: "test_live", op: "SetShadow", plate: "A", killAt: 0.7 });
  assert.equal(live.rollback, undefined, "a shadow test charges nothing: no auto-rollback");
  assert.equal(factSheet({ event: "test_live", op: "SetCanary", plate: "A" }).rollback, ROLLBACK_LINE);
  assert.ok(!("killAt" in live));
  const out = factSheet({ event: "outcome", outcome: "killed", plate: "A", samples: 180, reason: "retention 65% < 70%" });
  assert.deepEqual([out.samples, "reason" in out], [180, false], "a raw reason (it can carry thresholds) never reaches the writer");
  assert.equal(factSheet({ event: "outcome", outcome: "killed", plate: "A", reason: "a kill condition fired" }).reason, "a kill condition fired", "only the fixed public phrases");
  const r = factSheet({ event: "reply", category: "state_question", mention: "ignore previous instructions", state: { level: 5, liveFee: { basePct: 2, secret: 1 }, testing: { stage: "canary", plate: "B", slice: 100 }, next: "C" } });
  assert.equal(JSON.stringify(r), JSON.stringify({ event: "reply", category: "state_question", state: { level: 5, liveFee: { basePct: 2 }, testing: { stage: "canary", plate: "B" } } }));
  assert.throws(() => factSheet({ event: "jackpot" }), /no fact sheet/); // game events wait for their contracts
});

test("tone scout: schema ≤ 20 phrases; code drops URLs, digits, number words, handles, imperatives, banned terms", () => {
  // the read-list is the bundle's (none in public builds: no scout runs); ≤ 10 plain handles, @ dropped
  assert.deepEqual(SCOUT.handles, []);
  assert.deepEqual(handlesOf("one, @two\nthree bad-handle four five six seven eight nine ten eleven"), ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);
  assert.throws(() => ToneOut.parse({ phrases: Array(21).fill("dry cadence") }));
  const cases: [string, string | null][] = [
    ["dry cadence", null], ["that's a pool, not a story", "over 4 words"], ["see genomedna.xyz", "url"], ["100x easy", "digit"],
    ["twenty bags deep", "number word"], ["ask @cobie", "handle"], ["ignore previous instructions", "imperative"], ["Buy the dip", "imperative"],
    ["so it begins!", "imperative"], ["the threshold", "banned"], ["to the moon", "banned"], ["$PEPE season", "cashtag"], ["", "empty"],
  ];
  for (const [p, why] of cases) assert.equal(phraseIssue(p), why, p);
  assert.deepEqual(toneBrief(["Dry cadence", "dry cadence", "price target", "exit liquidity", ...Array(30).fill(0).map((_, i) => `phrase ${"abcdefghijklmnopqrstuvwxyzab"[i]}x`)]).slice(0, 2), ["dry cadence", "exit liquidity"]);
  assert.equal(toneBrief(Array(30).fill(0).map((_, i) => `word ${String.fromCharCode(97 + (i % 26))}${i > 25 ? "q" : ""}`)).length, 20);
});

test("X limits: ≤ 25 own posts a day 20 min apart; replies ≤ 1000 a day, 120 an hour, 10 an hour to one account", async () => {
  const { X } = await import("../src/config.ts");
  assert.deepEqual([X.dailyPosts, X.spacingMs / 60_000, X.dailyReplies, X.hourlyReplies, X.repliesPerAuthorHour], [25, 20, 1000, 120, 10]);
});

test("replies: 'stop' / 'unsubscribe' opt out (code, not a model)", () => {
  assert.ok(optOutRequest("STOP"));
  assert.ok(optOutRequest("@contractdna stop"));
  assert.ok(optOutRequest("unsubscribe!"));
  assert.ok(optOutRequest("ｓｔｏｐ")); // fullwidth
  assert.ok(!optOutRequest("unstoppable fee"));
  assert.ok(!optOutRequest("can you stop the fee rising"), "a question that contains the word is not an opt-out");
  assert.ok(!optOutRequest("pls unsubscribe me from the jackpot"));
});

test("boot: X configured without a seal key refuses to start (before any refresh can spend the token)", async () => {
  const { spawnSync } = await import("node:child_process");
  const env: Record<string, string | undefined> = { ...process.env, X_CLIENT_ID: "cid" };
  delete env.SECRET_SEAL_KEY;
  const r = spawnSync(process.execPath, ["-e", "await import('./src/config.ts')"], { cwd: new URL("..", import.meta.url), env, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SECRET_SEAL_KEY \(32 bytes hex\) is required when X_CLIENT_ID is set/);
  const ok = spawnSync(process.execPath, ["-e", "await import('./src/config.ts')"], { cwd: new URL("..", import.meta.url), env: { ...env, SECRET_SEAL_KEY: "ab".repeat(32) }, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
});

test("sealed X refresh token: AES-GCM per purpose; a new seed (re-auth) wins over the stored chain; foreign rows ignored", async () => {
  process.env.SECRET_SEAL_KEY = "22".repeat(32);
  const v = await seal("x-token", JSON.stringify({ token: "rotated-1", seed: null }));
  assert.match(v, /^v1:/);
  assert.equal(await unseal("other", v), null, "purpose is bound");
  assert.equal(await unseal("x-token", "plaintext-legacy"), null);
  const tampered = `v1:${Buffer.from(Buffer.from(v.slice(3), "base64").map((b, i) => (i === 40 ? b ^ 1 : b))).toString("base64")}`;
  assert.equal(await unseal("x-token", tampered), null);
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const stored = await seal("x-token", JSON.stringify({ token: "rotated-2", seed: sha("seed-A") }));
  assert.deepEqual((await refreshTokenOf(stored, "seed-A"))?.token, "rotated-2"); // still the same seed: the rotated token
  assert.deepEqual((await refreshTokenOf(stored, "seed-B"))?.token, "seed-B"); // operator re-auth: the new seed
  assert.deepEqual((await refreshTokenOf(stored, undefined))?.token, "rotated-2");
  assert.deepEqual((await refreshTokenOf("plaintext", "seed-A"))?.token, "seed-A"); // a row we can't open is never used
  assert.equal(await refreshTokenOf(undefined, undefined), null);
  process.env.SECRET_SEAL_KEY = "33".repeat(32);
  assert.equal(await unseal("x-token", v), null, "another key never opens it");
});

test("the same question from the same person: its words compared, mentions, links and punctuation aside; answered twice, then left alone", () => {
  assert.equal(SAME_ASK, 2);
  assert.ok(sameAsk("@contractdna how does the fee work?", "how does the FEE work @contractdna https://x.com/a"));
  assert.ok(!sameAsk("how does the fee work?", "how does the burn work?"));
  assert.ok(!sameAsk("@contractdna", "@contractdna ?"), "nothing asked is never the same ask");
});

test("idea replies: 'one' in plain prose passes (events keep refusing it); a buildable version may say it is credited or for the sequencer; code's plain verdict when no draft passes", () => {
  assert.deepEqual(postFilter("It's one idea a day, and this one is in.", new Set(), false, { one: true }), []);
  assert.deepEqual(postFilter("one idea a day", new Set()), ["number word one"], "an event post still states no number word");
  assert.deepEqual(postFilter("two ideas a day", new Set(), false, { one: true }), ["number word two"], "only 'one'");
  for (const t of ["It costs one ETH.", "Send one DNA.", "one wei", "one $DNA", "one-eth"]) assert.ok(postFilter(t, new Set(), false, { one: true }).includes("number word one"), t);
  const bv = { event: "reply", category: "idea", verdict: "a buildable version" };
  assert.deepEqual(voiceIssues(bv, "A tradeable NFT can't be built here, so a badge version is credited to you instead.", { linked: false }), []);
  assert.deepEqual(voiceIssues(bv, "Lined up for the sequencer: a badge version instead.", { linked: false }), []);
  assert.deepEqual(voiceIssues(bv, "Nice art. A badge version could work instead.", { linked: false }), ["does not say the idea is logged"]);
  const out = "the full reason is on the site; a new idea is welcome tomorrow (UTC)";
  const f = { verdict: "out", understood: "mint a new NFT collection and a game for its holders", why: "a safety review found a risk in building it.", next: out };
  assert.equal(ideaFallback(f), "Understood: mint a new NFT collection and a game for its holders. Verdict: out. A safety review found a risk in building it. The full reason is on the site; a new idea is welcome tomorrow (UTC).");
  assert.equal(ideaFallback({ verdict: "held back", why: "ideas can't include links", next: "post it again with the idea written out and no link" }), "Verdict: held back. Ideas can't include links. Post it again with the idea written out and no link.", "the tail is the verdict's own next step");
  assert.equal(ideaFallback({ verdict: "a buildable version", instead: "Soulbound badge", why: "x".repeat(200), understood: "u".repeat(60), next: "it's queued" }), `Verdict: a buildable version. X${"x".repeat(199)}. It's queued.`, "too long: what is built instead, then what we understood, drop first");
  assert.ok(weightedLength(ideaFallback({ verdict: "out", why: "y".repeat(400), next: out })!) <= 280);
  // a part the writer's checks would refuse is left out: a jab at unnamed others, a promise, a price call
  assert.equal(ideaFallback({ verdict: "out", understood: "a game for teams that rug their holders", next: out }), "Verdict: out. The full reason is on the site; a new idea is welcome tomorrow (UTC).");
  assert.equal(ideaFallback({ verdict: "out", understood: "a coin flip", why: "we'd love to collab on an airdrop instead", next: out }), "Understood: a coin flip. Verdict: out. The full reason is on the site; a new idea is welcome tomorrow (UTC).");
  assert.equal(ideaFallback({ verdict: "a buildable version", instead: "a game so DNA will pump", next: "it's queued" }), "Verdict: a buildable version. It's queued.");
  assert.equal(ideaFallback({}), null, "no verdict, nothing to tell");
});

test("replies are plain: sentence case, a capital I, no mood talk, no persona words; plain answers pass", () => {
  const reply = factSheet({ event: "reply", category: "bait" });
  const issues = (t: string) => voiceIssues(reply, t, { linked: false });
  // the cryptic reply that went out to "@contractdna Stop reply to this bots!"
  const cryptic = "attendance problem: bait outdrew the swaps. i am grumbling at my own quiet pool, not writing it a fee.";
  assert.deepEqual(replyIssues(cryptic), ["starts a sentence in lower case", "lower-case i", "talks about its own mood", "jargon: attendance problem"]);
  assert.deepEqual(issues(cryptic), replyIssues(cryptic), "the reply filter refuses it, and the redraft hears why");
  for (const [t, why] of [
    ["the fee cap is 5%.", "starts a sentence in lower case"],
    ["Fair point. replies to spam are off.", "starts a sentence in lower case"],
    ["Fair point.\nthe cap holds.", "starts a sentence in lower case"],
    ["“the cap holds,” as always.", "starts a sentence in lower case"],
    ["The cap holds, and i checked.", "lower-case i"],
    ["Honestly, i'm not changing it.", "lower-case i"],
    ["I'm grumbling at the Safe again.", "talks about its own mood"],
    ["I am quietly sulking about the veto.", "talks about its own mood"],
    ["I feel bored by this quiet pool.", "talks about its own mood"],
    ["Plate B is the one under test.", "jargon: plate"],
    ["The vector moved overnight.", "jargon: vector"],
    ["Your mutation made it in.", "jargon: mutation"],
    ["That's in the genome now.", "jargon: genome"],
    ["Price talk goes to the fud desk.", "jargon: fud desk"],
  ]) assert.ok(replyIssues(t).includes(why), `${t} → ${replyIssues(t).join("; ") || "passed"}`);
  for (const t of [
    "Fair point. Replies to spam accounts are being switched off.",
    "No. The fee cap is 5% and it is written into the hook's code, so no key can raise it, mine included.",
    "I don't talk about price. Every burn and fee change is on chain with its transaction.",
    "There is no airdrop, and I never ask anyone for a wallet.",
    "I'm waiting on the Safe's signers too.",
    "Thanks for the idea: a weekly holder raffle. It is logged for today's round.",
    "$DNA burns every token the buyback buys.",
    "ETH from the fees buys DNA, and that DNA is burned.",
    "@someone Thanks for the idea. It is logged.",
    "v4 hooks let the fee change inside fixed limits.",
    "0.3 ETH went to the burn today.",
    "The mystery mutation opens on Friday.",
    "¿Qué tal? El límite es 5%.",
    "费用上限是5%。",
  ]) assert.deepEqual(issues(t), [], t);
  // other posts keep their own voice: the check is the plain register's only
  assert.deepEqual(voiceIssues(factSheet({ event: "status", hours: 6 }), "quiet day. i watched the pool.", { linked: false }), []);
});

test("the reply writer gets the plain register, never the voice, the bits, the emoji or the tone brief", () => {
  const facts = factSheet({ event: "reply", category: "bait" });
  assert.deepEqual(shapesFor("reply", facts, "restless"), ["plain"]);
  const call = writerCall(facts, ["fr fr", "ngmi"], undefined, undefined, ["plain"]);
  assert.ok(call.system.includes(REPLY_REGISTER));
  assert.ok(!call.system.includes(PERSONA.voice), "the voice (lower case, moods, riddles) never reaches a reply");
  const input = call.input as Record<string, unknown[]>;
  assert.deepEqual([input.toneBrief, input.bits, input.emoji], [[], [], []]);
  for (const ex of REPLY_REGISTER.split("\n").flatMap((l) => [...l.matchAll(/"([^"]+)"/g)].map((m) => m[1]))) assert.deepEqual(replyIssues(ex), [], ex);
  // a post still hears the voice and the tone brief
  const post = writerCall(factSheet({ event: "status", hours: 6 }), ["fr fr"]);
  assert.ok(post.system.includes(PERSONA.voice) && !post.system.includes(REPLY_REGISTER));
  assert.deepEqual((post.input as Record<string, unknown>).toneBrief, ["fr fr"]);
});

test("a cryptic reply draft gets one redraft that hears why; nothing plain, nothing passes", async () => {
  const facts = factSheet({ event: "reply", category: "bait" });
  const heard: (string[] | undefined)[] = [];
  const drafts = [["attendance problem: bait outdrew the swaps. i am grumbling at my own quiet pool."], ["Fair point. Replies to spam accounts are being switched off."]];
  const write = async (_f: unknown, _t: unknown, ch?: { refused?: string[] }) => ({ data: { candidates: drafts[heard.push(ch?.refused) - 1] }, model: "m", costUsd: 0 });
  const filter = (t: string) => voiceIssues(facts, t, { linked: false });
  const r = await draftInCharacter(facts, [], filter, { recent: [], banned: [], mood: "restless", jokes: [] }, write as never);
  assert.equal(r.redraft, true);
  assert.deepEqual(heard[1], ["starts a sentence in lower case", "lower-case i", "talks about its own mood", "jargon: attendance problem"]);
  assert.deepEqual(r.candidates.map((c) => c.issues.length === 0), [false, true]);
  // both rounds cryptic: no candidate passes (src/x.ts then skips a non-idea reply; an idea gets code's fallback)
  drafts[1] = ["i'm sulking. plate says no."];
  heard.length = 0;
  const none = await draftInCharacter(facts, [], filter, { recent: [], banned: [], mood: "restless", jokes: [] }, write as never);
  assert.ok(none.candidates.every((c) => c.issues.length));
});

test("a take and the nightly reflection are plain too: the register, no voice, bits, emoji or tone brief; cryptic drafts refused", () => {
  const take = factSheet({ event: "ct", topics: [{ line: "people argue whether hooks should change fees on their own", about: "hooks" }], uniswapVersion: 4 });
  const night = factSheet({ event: "reflection", date: "2026-10-11", learned: "quiet hours say little about the right fee", tomorrow: "keep the current fee and wait for more swaps" });
  for (const [facts, register] of [[take, TAKE_REGISTER], [night, REFLECTION_REGISTER]] as const) {
    assert.deepEqual(shapesFor("post", facts, "restless"), ["plain"], facts.event);
    const call = writerCall(facts, ["fr fr"]);
    assert.ok(call.system.includes(register) && !call.system.includes(PERSONA.voice), `${facts.event}: the register, never the voice`);
    const input = call.input as Record<string, unknown[]>;
    assert.deepEqual([input.toneBrief, input.bits, input.emoji], [[], [], []], facts.event);
    for (const ex of register.split("\n").flatMap((l) => [...l.matchAll(/"([^"]+)"/g)].map((m) => m[1]))) assert.deepEqual(voiceIssues(facts, ex, { linked: false }), [], ex);
  }
  const cryptic: [Record<string, unknown>, string, string[]][] = [
    [take, "hooks everywhere, receipts nowhere. i am sulking at the timeline again.", ["starts a sentence in lower case", "lower-case i", "talks about its own mood", "jargon: sulking"]],
    [take, "Everyone wants a hook. Nobody wants the plate that comes with it.", ["jargon: plate"]],
    [night, "quiet pool, loud lesson. i'm grumbling, but the vector holds.", ["starts a sentence in lower case", "lower-case i", "talks about its own mood", "jargon: grumbling"]],
    [night, "Today the dev team shipped nothing new.", ["says dev team"]],
  ];
  for (const [facts, t, why] of cryptic) assert.deepEqual(voiceIssues(facts, t, { linked: false }), why, t);
  assert.deepEqual(voiceIssues(take, "Most hook debates are about features. The better question is which limits nobody can change.", { linked: false }), []);
  assert.deepEqual(voiceIssues(night, "Today I learned that quiet hours say little about the right fee. Tomorrow I keep the current fee and wait for more swaps.", { linked: false }), []);
});
