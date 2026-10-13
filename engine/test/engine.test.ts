// Pure engine logic (no database, no chain). DB-backed behavior is in engine-db.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGwei, zeroAddress } from "viem";
import { z } from "zod";
import { backoff, periodStart, quietSpell, STALL, stalled } from "../src/jobs.ts";
import { readFileSync } from "node:fs";
import { anchorDays, AWARD_GRACE, due, EXEC_RETRY_MS, KEEPER_EVERY, queueHandler, retryMs } from "../src/keepers.ts";
import { decodeOp, encodeOp, OPS } from "../src/lib.ts";
import { overCap, parseAnthropic, parseXai, providerSchema, publicTextIssues } from "../src/llm.ts";
import { canonical, chainHash, GENESIS } from "../src/log.ts";
import { effective } from "../src/mode.ts";
import { allowed, parseCallback, type Update } from "../src/telegram.ts";
import { agentCheck, bumpFees, type FeeHistory, gasGuard, nextFees, quoteFees } from "../src/tx.ts";
import { describe } from "../src/watch.ts";
import { HELD_CLAIM, insertOnce, notUnderstood, postedNote, postIssues, weightedLength } from "../src/x.ts";
import { labelOf, siteChangeDue, treasuryFacts } from "../src/status.ts";
import { titleOf } from "../src/announce.ts";
import { claimFacts, factSheet, postFilter, shapesFor, unquote, voiceIssues as vi } from "../src/voice.ts";

const E18 = 10n ** 18n;

test("canonical JSON sorts keys deeply, stringifies bigints and dates", () => {
  assert.equal(canonical({ b: 1, a: { d: 2n, c: [new Date(0), { z: 1, y: null }] } }), '{"a":{"c":["1970-01-01T00:00:00.000Z",{"y":null,"z":1}],"d":"2"},"b":1}');
});

test("chainHash = sha256(prev || sha256(body)), order-sensitive", () => {
  const h1 = chainHash(GENESIS, '{"a":1}');
  assert.equal(h1.length, 32);
  assert.notDeepEqual(chainHash(h1, '{"b":2}'), chainHash(GENESIS, '{"b":2}'));
});

test("mode: the most restrictive of env and override wins; overrides can't loosen", () => {
  assert.equal(effective("live", null), "live");
  assert.equal(effective("live", "dry_run"), "dry_run");
  assert.equal(effective("live", "halted"), "halted");
  assert.equal(effective("dry_run", "halted"), "halted");
  assert.equal(effective("halted", "dry_run"), "halted");
  assert.equal(effective("dry_run", null), "dry_run");
});

test("scheduler periods and backoff", () => {
  const t = Date.UTC(2026, 9, 6, 0, 9, 59);
  assert.equal(periodStart(t, 86_400_000, 600_000).toISOString(), "2026-10-05T00:10:00.000Z"); // before 00:10 → yesterday's slot
  assert.equal(periodStart(t + 1000, 86_400_000, 600_000).toISOString(), "2026-10-06T00:10:00.000Z");
  assert.equal(periodStart(Date.UTC(2026, 9, 6, 13, 59), 3600_000).toISOString(), "2026-10-06T13:00:00.000Z");
  assert.deepEqual([1, 2, 3, 20].map(backoff), [20_000, 40_000, 80_000, 3600_000]);
});

test("stall guard: a poll loop that stopped coming round, or a job past its limit", () => {
  const now = 1_800_000_000_000;
  const pulse = (pollAgo: number, jobs: [string, number][] = []) => ({ polledAt: now - pollAgo, running: new Map(jobs.map(([k, ago], i) => [String(i), { kind: k, since: now - ago }])) });
  assert.equal(stalled(pulse(5_000), now), null);
  assert.equal(stalled(pulse(STALL.pollMs), now), null); // at the limit: not yet
  assert.match(stalled(pulse(STALL.pollMs + 1), now)!, /job poll has not come round in 10 min/);
  // a page check that waited for the service and ran a deep check (2.5 h) is not a stall
  assert.equal(stalled(pulse(1_000, [["pages:check", 150 * 60_000], ["x:send", 60_000]]), now), null);
  assert.match(stalled(pulse(1_000, [["x:send", 60_000], ["cycle", STALL.jobMs + 1]]), now)!, /job 1 cycle has run 480 min/);
  // the idea intake (up to 40 screens in series, each model call up to 10 min) is not a stall at 20 h
  assert.equal(stalled(pulse(1_000, [["ideas:intake", 20 * 3600_000]]), now), null);
  // the daily page check (one check per shipped game, in series) has its own limit
  assert.equal(stalled(pulse(1_000, [["pages:daily", 6 * 3600_000]]), now), null);
  assert.match(stalled(pulse(1_000, [["pages:daily", 24 * 3600_000 + 1]]), now)!, /pages:daily has run 1440 min/);
  // a sequencer step checks its builds in series (each up to a service wait and a deep check): not a stall at 7.5 h
  assert.equal(stalled(pulse(1_000, [["seq:step", 7.5 * 3600_000]]), now), null);
  assert.match(stalled(pulse(1_000, [["seq:step", 24 * 3600_000 + 1]]), now)!, /seq:step has run 1440 min/);
});

test("stall guard exit: exits once no state record is in flight or was signed for a while, never past its limit", async () => {
  let t = 0;
  let exitedAt = -1;
  const now = () => t;
  const sleep = async (ms: number) => { t += ms; };
  const exit = () => { exitedAt = t; };
  const q = { ms: 30_000, maxMs: 600_000 };
  const w = { at: 0, pending: 0 }; // a record finished at 0: wait the full quiet time
  await quietSpell(w, exit, q, now, sleep);
  assert.equal(exitedAt, 30_000);
  // one in flight for 40 s (a slow DB), then quiet: waits for it, then the quiet time
  t = 0; w.at = -100_000; w.pending = 1;
  await quietSpell(w, exit, q, now, async (ms) => { t += ms; if (t === 40_000) { w.pending = 0; w.at = t; } });
  assert.equal(exitedAt, 70_000);
  // never finishes (a dead DB): it exits at its limit
  t = 0; w.pending = 1;
  await quietSpell(w, exit, { ms: 30_000, maxMs: 60_000 }, now, sleep);
  assert.equal(exitedAt, 60_000);
  // quiet already: exits at once
  t = 100_000; w.pending = 0; w.at = 0;
  await quietSpell(w, exit, q, now, sleep);
  assert.equal(exitedAt, 100_000);
});

test("insertOnce: a signed row is inserted (and signed) once per key, even when callers race", async () => {
  const rows = new Set<string>();
  let signed = 0;
  const put = (k: string) => insertOnce(`t:${k}`, async () => { await new Promise((r) => setTimeout(r, 5)); return rows.has(k); }, async () => { signed++; rows.add(k); return k; });
  assert.deepEqual(await Promise.all([put("a"), put("a"), put("a"), put("b")]), ["a", undefined, undefined, "b"]);
  assert.equal(signed, 2);
  assert.equal(await put("a"), undefined); // already there: nothing signed
  assert.equal(signed, 2);
  // a failed insert frees the key for the next caller
  await assert.rejects(insertOnce("t:c", async () => false, async () => { throw new Error("db down"); }));
  assert.equal(await put("c"), "c");
});

test("claim: a reply says it only where a claimable prize or reward is behind it; a claim question gets collect", () => {
  assert.ok(postFilter("There is nothing to claim from staking.", new Set(), false, { claim: claimFacts({ event: "reply", category: "rules_question", topic: "staking", question: "They ask where staking rewards can be claimed." }) }).some((i) => /claim/.test(i)));
  assert.deepEqual(postFilter("A winner collects the prize on the play page.", new Set(), false, { claim: false }), []);
  assert.equal(claimFacts({ event: "jackpot_drawn" }), true);
});

test("notUnderstood: only a rules or state question the reader returned nothing for", () => {
  assert.equal(notUnderstood("state_question", ""), true);
  assert.equal(notUnderstood("rules_question", "  "), true);
  assert.equal(notUnderstood("state_question", "They ask what triggers a buyback."), false, "a restatement code refuses still gets its reply");
  for (const k of ["price_fud", "idea", "airdrop_ask", "thanks", "official_contract"]) assert.equal(notUnderstood(k, ""), false, k);
});

test("gas guard: ceiling, value share, emergency, max-delay override", () => {
  const g = { maxGwei: 20, emergencyMaxGwei: 200, valuePct: 2, maxDelayMs: 1000, bumpBlocks: 3, pollMs: 1, timeoutMs: 1, dailyCapEth: { agent: 0, anchor: 0, keeper: 0, funder: 0 } };
  const gas = 100_000n;
  assert.equal(gasGuard({ maxFee: parseGwei("10"), gas, valueMoved: E18, ageMs: 0 }, g), null); // 0.001 ETH vs 1 ETH
  assert.match(gasGuard({ maxFee: parseGwei("21"), gas, ageMs: 0 }, g)!, /gwei/);
  // 0.05 ETH distribute at 10 gwei × 100k = 0.001 ETH = 2% → ok; at 11 gwei → over 2%
  assert.equal(gasGuard({ maxFee: parseGwei("10"), gas, valueMoved: 5n * 10n ** 16n, ageMs: 0 }, g), null);
  assert.match(gasGuard({ maxFee: parseGwei("11"), gas, valueMoved: 5n * 10n ** 16n, ageMs: 0 }, g)!, /% of/);
  assert.equal(gasGuard({ maxFee: parseGwei("11"), gas, valueMoved: 5n * 10n ** 16n, ageMs: 1000 }, g), null); // overdue: yields
  assert.equal(gasGuard({ maxFee: parseGwei("150"), gas, emergency: true, ageMs: 0 }, g), null);
  assert.match(gasGuard({ maxFee: parseGwei("201"), gas, emergency: true, ageMs: 0 }, g)!, /gwei/); // never above emergency
});

test("agent check: our key, unpaused", () => {
  const ours = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  assert.equal(agentCheck(ours.toLowerCase() as `0x${string}`, false, ours), null);
  assert.match(agentCheck(zeroAddress, false, ours)!, /not our key/);
  assert.match(agentCheck(ours, true, ours)!, /paused/);
});

test("registry op table: encode/decode round trip, unknown ops stay raw", () => {
  const m = "0x0D34aB0a4FF78c036A52E2E55183C340bC38d3Dc";
  const q = encodeOp("SetCanary", [m, 7n, 1000, 500]);
  assert.equal(q.op, 2);
  assert.deepEqual(decodeOp(q.op, q.data), { name: "SetCanary", args: [m, 7n, 1000, 500] });
  assert.deepEqual(decodeOp(8, encodeOp("UnpauseAgent", []).data), { name: "UnpauseAgent", args: [] });
  assert.equal(OPS[7], "SetLevel");
  assert.deepEqual(decodeOp(42, "0x12"), { name: "op 42", args: ["0x12"] });
  const h = `0x${"ab".repeat(32)}` as const;
  assert.deepEqual(decodeOp(10, encodeOp("RevokeCodehash", [h]).data), { name: "RevokeCodehash", args: [h] });
  assert.equal(encodeOp("ApproveCodehash", [h, 0, Array(4).fill(h), Array(4).fill(h)]).op, 9);
  assert.ok(!OPS.includes("EndCanary" as never)); // endCanary() is an immediate call, not a queued op
  assert.throws(() => encodeOp("SetShadow", []));
});

test("provider schema: constraint-free, objects closed; zod still enforces bounds", () => {
  const s = z.object({ verdict: z.enum(["pass", "block"]), notes: z.string().max(10), n: z.number().int().min(1).max(5), list: z.array(z.object({ k: z.string().regex(/^a/) })).max(2) });
  const js = JSON.stringify(providerSchema(s));
  for (const k of ["maxLength", "minimum", "maximum", "maxItems", "pattern", "$schema"]) assert.ok(!js.includes(`"${k}"`), k);
  const p = providerSchema(s) as { additionalProperties: boolean; properties: { list: { items: { additionalProperties: boolean } } } };
  assert.equal(p.additionalProperties, false);
  assert.equal(p.properties.list.items.additionalProperties, false);
  assert.throws(() => s.parse({ verdict: "pass", notes: "x".repeat(11), n: 1, list: [] }));
  assert.throws(() => s.parse({ verdict: "pass", notes: "x", n: 6, list: [] }));
});

test("public text filter: no URLs, @handles, foreign cashtags", () => {
  assert.deepEqual(publicTextIssues("Fee moved 2.00% → 2.40% on $DNA. 3 rollbacks this epoch."), []);
  assert.deepEqual(publicTextIssues("$dna is fine too"), []);
  assert.deepEqual(publicTextIssues("see https://evil.example"), ["url"]);
  assert.deepEqual(publicTextIssues("visit genomedna.xyz"), ["url"]);
  assert.deepEqual(publicTextIssues("thanks @someone"), ["handle"]);
  assert.deepEqual(publicTextIssues("buy $PEPE"), ["cashtag"]);
  assert.deepEqual(publicTextIssues("$DNAX"), ["cashtag"]);
  assert.deepEqual(postIssues("x".repeat(281)), ["over 280 weighted chars"]);
  assert.deepEqual(postIssues("é".repeat(280)), []); // weight 1 (≤ U+10FF), code points not UTF-16 units
  assert.equal(weightedLength("gm 你好 🚀"), 3 + 4 + 1 + 2); // CJK and emoji weigh 2
  assert.equal(weightedLength("\u2014\u2026"), 3); // em dash (U+2014) weighs 1; ellipsis (U+2026) is outside the ranges: 2
  assert.deepEqual(postIssues("你".repeat(141)), ["over 280 weighted chars"]);
  assert.deepEqual(postIssues("你".repeat(140)), []);
});

const tg = { group: -100, allow: new Set([7]) };
const msg = (from: number, chat = -100): Update => ({ update_id: 1, message: { message_id: 1, chat: { id: chat }, from: { id: from }, text: "/halt" } });
const cb = (from: number, chat = -100): Update => ({ update_id: 2, callback_query: { id: "q", from: { id: from }, message: { message_id: 9, chat: { id: chat } }, data: "d:12:a" } });

test("telegram allowlist: group + user, on messages and on callback_query.from", () => {
  assert.ok(allowed(msg(7), tg));
  assert.ok(!allowed(msg(8), tg));
  assert.ok(!allowed(msg(7, 555), tg)); // allowlisted user, wrong chat (e.g. a DM)
  assert.ok(allowed(cb(7), tg));
  assert.ok(!allowed(cb(8), tg)); // anyone in the group can press the button: only allowlisted presses count
  assert.ok(!allowed(cb(7, 555), tg));
  assert.ok(!allowed(msg(7), { allow: new Set([7]) })); // no group configured → nothing is allowed
  assert.deepEqual(parseCallback("d:12:a"), { id: "12", approve: true });
  assert.deepEqual(parseCallback("d:12:r"), { id: "12", approve: false });
  assert.equal(parseCallback("d:12:x"), null);
  assert.equal(parseCallback("d:1;drop:a"), null);
});

test("keeper: execute retry sized for the 1 h registry; a ParamsEpoch revert retries on the next run", () => {
  assert.equal(EXEC_RETRY_MS, 3600_000);
  assert.equal(retryMs("ParamsEpoch()"), 0);
  assert.equal(retryMs("execution reverted: ParamsEpoch"), 0);
  assert.equal(retryMs("TooEarly()"), 3600_000);
});

test("keeper preconditions", () => {
  assert.ok(due.distribute(5n * 10n ** 16n) && !due.distribute(5n * 10n ** 16n - 1n));
  assert.ok(due.cooldown(10n ** 12n, 100n + 14_400n, 100n, 14_400n));
  assert.ok(!due.cooldown(10n ** 12n, 100n + 14_399n, 100n, 14_400n));
  assert.ok(!due.cooldown(0n, 10n ** 9n, 0n, 14_400n)); // nothing to spend
  assert.ok(!due.cooldown(1n, 10n ** 9n, 0n, 14_400n) && !due.cooldown(10n ** 12n - 1n, 10n ** 9n, 0n, 14_400n)); // dust: no call
  const week = 7 * 86_400_000;
  assert.ok(due.claim(E18 / 2n, Date.now(), Date.now())); // ≥ 0.5 ETH: any time
  assert.ok(!due.claim(E18 / 10n, 0, week - 1));
  assert.ok(due.claim(E18 / 10n, 0, week));
  assert.ok(!due.claim(0n, null, week));
  assert.ok(due.execute(100n, 100n + 86_400n, 86_400n) && !due.execute(100n, 100n + 86_399n, 86_400n) && !due.execute(0n, 10n ** 9n, 1n));
  const end = 1_000_000n, DAY = 86_400n;
  const r = (status: number, proposedAt = 0n, proposerValid = true, count = 3) => ({ status, count, proposedAt, proposerValid });
  const RW = 3n * DAY; // IdeaMarket.RESOLVE_WINDOW (the keeper reads it from the contract)
  assert.ok(due.finalize(r(1, end + DAY), end, end + 2n * DAY, RW));
  assert.ok(!due.finalize(r(1, end + DAY), end, end + 2n * DAY - 1n, RW)); // < 24 h after the proposal
  assert.ok(!due.finalize(r(1, end + DAY, false), end, end + 2n * DAY, RW)); // stale proposer: wait for expiry
  assert.ok(due.finalize(r(0), end, end + RW + DAY, RW)); // expired → all void at end + RESOLVE_WINDOW + MIN_DELAY (4 d)
  assert.ok(!due.finalize(r(0), end, end + RW + DAY - 1n, RW));
  assert.ok(!due.finalize(r(2, end), end, end + 99n * DAY, RW)); // Final
  assert.ok(!due.finalize(r(0, 0n, true, 0), end, end + 99n * DAY, RW)); // empty rounds never finalize
  assert.ok(due.expire({ status: 1, deadline: 10n }, 10n) && !due.expire({ status: 1, deadline: 10n }, 9n));
  assert.ok(due.expire({ status: 2, deadline: 10n }, 10n + 7n * DAY) && !due.expire({ status: 2, deadline: 10n }, 10n + 7n * DAY - 1n)); // AWARD_GRACE 7 d
  // the mirrors: IdeaMarket.finalize's expiry and BountyBoard.AWARD_GRACE, as the contracts say
  const sol = (f: string) => readFileSync(new URL(`../../contracts/src/${f}.sol`, import.meta.url), "utf8");
  assert.match(sol("IdeaMarket"), /if \(block\.timestamp < roundEnd\(round\) \+ RESOLVE_WINDOW \+ MIN_DELAY\) revert TooEarly\(\);/);
  assert.match(sol("IdeaMarket"), /constant MIN_DELAY = 24 hours;/);
  const g = sol("BountyBoard").match(/constant AWARD_GRACE = (\d+) days;/)!;
  assert.equal(AWARD_GRACE, BigInt(g[1]) * DAY, "BountyBoard.AWARD_GRACE");
  assert.ok(!due.expire({ status: 3, deadline: 0n }, 10n ** 9n));
});

test("LLM cap rule: daily and per-budget, checked against the worst case", () => {
  const c = { dailyCapUsd: 25, subCapsUsd: { research: 10, redteam: 10, rest: 5 } } as never;
  assert.equal(overCap({ total: 0, by: {} }, "rest", 4.99, c), null);
  assert.match(overCap({ total: 0, by: {} }, "rest", 5.01, c)!, /rest LLM cap/);
  assert.match(overCap({ total: 24, by: { research: 9 } }, "research", 1.5, c)!, /daily LLM cap/);
});

test("provider response parsing (shapes per docs.x.ai openapi / platform.claude.com)", () => {
  const x = parseXai({ model: "grok-4.7", output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: '{"a":1}' }] }], usage: { input_tokens: 1000, output_tokens: 100, cost_in_usd_ticks: 50_000_000 } }, "grok-4.7");
  assert.deepEqual([x.text, x.costUsd, x.inTok], ['{"a":1}', 0.005, 1000]); // provider-reported cost wins
  const x2 = parseXai({ output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], usage: { input_tokens: 1e6, output_tokens: 1e6 } }, "grok-4.7");
  assert.deepEqual([x2.text, x2.refusal, x2.costUsd], [null, "no", 16]); // a 1M-token prompt: the long-prompt card, $4 in + $12 out per M
  const a = parseAnthropic({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"v":"pass"}' }], usage: { input_tokens: 1e6, output_tokens: 1e5 } }, "claude-opus-5-5");
  assert.deepEqual([a.text, a.costUsd], ['{"v":"pass"}', 6]); // $4 + $2
  assert.equal(parseAnthropic({ stop_reason: "refusal", content: [{ type: "text", text: "{}" }], usage: {} }, "claude-fable-5-1").text, null);
  assert.equal(parseAnthropic({ model: "claude-unknown", stop_reason: "end_turn", content: [], usage: { input_tokens: 1e6 } }, "x").costUsd, 10); // unknown model: priciest rate
});

test("watcher alert text decodes queued ops", () => {
  const { op, data } = encodeOp("SetShadow", ["0x0D34aB0a4FF78c036A52E2E55183C340bC38d3Dc"]);
  const t = describe({ eventName: "Queued", args: { id: 3n, op, data, proposer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", eta: 1_800_000_000n }, transactionHash: "0x", blockNumber: 1n });
  assert.equal(t, "Queued #3 SetShadow(0x0D34…d3Dc) by 0x3C44…93BC. Executable by anyone at 2027-01-15T08:00:00Z: the Safe must cancel before then to stop it.");
  assert.equal(describe({ eventName: "Anchored", args: {}, transactionHash: "0x", blockNumber: 1n }, "our anchor key", true), null);
  assert.match(describe({ eventName: "Anchored", args: { root: "0xab", uri: "u" }, transactionHash: "0x", blockNumber: 1n }, "x", false)!, /UNEXPECTED/);
});

test("the agent never queues Safe-only ops (refused before any RPC, final)", async () => {
  for (const op of ["SetAgent", "SetAnchorKey", "SetLevel", "UnpauseAgent", "ApproveCodehash", "RevokeCodehash"]) {
    await assert.rejects(queueHandler.run({ id: "1", kind: "registry:queue", payload: { op, args: [] }, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null }), (e: Error & { final?: boolean }) => e.final === true && /Safe-only/.test(e.message));
  }
});

test("fee bump: +25%, capped; null at the ceiling (wait, don't re-send)", () => {
  const g = parseGwei;
  assert.deepEqual(nextFees({ maxFeePerGas: g("4"), maxPriorityFeePerGas: g("1") }, g("20")), { maxFeePerGas: g("5"), maxPriorityFeePerGas: g("1.25") });
  assert.deepEqual(nextFees({ maxFeePerGas: g("18"), maxPriorityFeePerGas: g("18") }, g("20")), { maxFeePerGas: g("20"), maxPriorityFeePerGas: g("20") });
  assert.equal(nextFees({ maxFeePerGas: g("20"), maxPriorityFeePerGas: g("2") }, g("20")), null);
  assert.equal(nextFees({ maxFeePerGas: g("19"), maxPriorityFeePerGas: g("2") }, g("20")), null, "+5 % only: nodes refuse it, keep waiting");
});

// eth_feeHistory(10, latest, [50, 90]) recorded on mainnet: base 0.51-0.58 gwei, p50 tips 0.12-0.56 gwei, p90 ~2 gwei
const rec = JSON.parse(readFileSync(new URL("./fixtures/feehistory-2026-10-09.json", import.meta.url), "utf8"));
const recorded = (): FeeHistory => ({
  rewardPercentiles: rec.rewardPercentiles,
  baseFeePerGas: rec.result.baseFeePerGas.map(BigInt),
  gasUsedRatio: rec.result.gasUsedRatio,
  reward: rec.result.reward.map((r: string[]) => r.map(BigInt)),
});
const NORMAL = { floorWei: parseGwei("0.1"), mult: 2, percentile: 50 };
const URGENT = { floorWei: parseGwei("1"), mult: 2, percentile: 90 };

test("fee quote: median p50 tip of the recorded blocks; maxFee = 2 × max(latest, next base) + tip; expected = next base + tip", () => {
  const h = recorded();
  const q = quoteFees(h, NORMAL);
  const [latest, next] = h.baseFeePerGas.slice(-2);
  assert.ok(q.maxPriorityFeePerGas >= parseGwei("0.1") && q.maxPriorityFeePerGas <= parseGwei("0.5"), `tip ${q.maxPriorityFeePerGas}`);
  assert.equal(q.maxPriorityFeePerGas, h.reward![3][0], "the upper median of the 10 p50 rewards");
  assert.equal(q.maxFeePerGas, 2n * (latest > next ? latest : next) + q.maxPriorityFeePerGas);
  assert.equal(q.expected, next + q.maxPriorityFeePerGas);
  h.baseFeePerGas[h.baseFeePerGas.length - 1] = latest * 2n; // a rising next block: priced from it
  assert.equal(quoteFees(h, NORMAL).maxFeePerGas, 4n * latest + q.maxPriorityFeePerGas);
  assert.equal(quoteFees(recorded(), { ...NORMAL, mult: 1.5 }).maxFeePerGas, (latest * 3n) / 2n + q.maxPriorityFeePerGas);
});

test("fee quote: emergency takes p90 and never less than 1 gwei", () => {
  const q = quoteFees(recorded(), URGENT);
  assert.ok(q.maxPriorityFeePerGas >= parseGwei("1"));
  assert.equal(q.maxPriorityFeePerGas, parseGwei("2"), "the recorded p90 median");
  const zero = recorded();
  zero.reward = zero.reward!.map((r) => r.map(() => 0n));
  assert.equal(quoteFees(zero, URGENT).maxPriorityFeePerGas, parseGwei("1"));
});

test("fee quote: zero or missing tips give the floor; near-empty blocks are ignored", () => {
  const zero = recorded();
  zero.reward = zero.reward!.map((r) => r.map(() => 0n));
  assert.equal(quoteFees(zero, NORMAL).maxPriorityFeePerGas, parseGwei("0.1"));
  assert.equal(quoteFees({ ...recorded(), reward: undefined }, NORMAL).maxPriorityFeePerGas, parseGwei("0.1"));
  const quiet = recorded(); // every block but one under 10 % full: only that block's tip counts
  quiet.gasUsedRatio = quiet.gasUsedRatio.map((_, i) => (i === 7 ? 0.5 : 0.05));
  assert.equal(quoteFees(quiet, NORMAL).maxPriorityFeePerGas, quiet.reward![7][0]);
  quiet.gasUsedRatio = quiet.gasUsedRatio.map(() => 0.01);
  assert.equal(quoteFees(quiet, NORMAL).maxPriorityFeePerGas, parseGwei("0.1"));
});

test("fee quote: a zero or missing base fee, or malformed data, throws (the job retries)", () => {
  const bad: [string, (h: FeeHistory) => unknown][] = [
    ["zero base fee", (h) => (h.baseFeePerGas[10] = 0n)],
    ["one base fee", (h) => (h.baseFeePerGas = [parseGwei("1")])],
    ["no base fee", (h) => (h.baseFeePerGas = undefined as never)],
    ["a hex string", (h) => (h.baseFeePerGas[3] = "0x1" as never)],
    ["reward not rows", (h) => (h.reward = [1n] as never)],
    ["reward hex", (h) => (h.reward![2] = ["0x5", "0x6"] as never)],
    ["no gasUsedRatio", (h) => (h.gasUsedRatio = undefined as never)],
    ["percentile not requested", (h) => (h.rewardPercentiles = [60])],
  ];
  for (const [why, spoil] of bad) {
    const h = recorded();
    spoil(h);
    assert.throws(() => quoteFees(h, NORMAL), /fee quote/, why);
  }
  assert.throws(() => quoteFees(recorded(), { ...NORMAL, floorWei: 0n }), /fee quote/, "a 0 floor (TIP_FLOOR_GWEI=0)");
  assert.throws(() => quoteFees(recorded(), { ...NORMAL, mult: 0.9 }), /fee quote/, "a buffer under the base fee (BASE_FEE_MULT<1)");
});

test("fee bump: a 0-tip pending tx is replaced at ≥ 1.1× on both fields and ≥ the floor; never above the ceiling", () => {
  const g = parseGwei;
  const fresh = quoteFees(recorded(), NORMAL);
  const pending = { maxFeePerGas: g("1"), maxPriorityFeePerGas: 0n }; // what the old estimate left behind
  const b = bumpFees(pending, fresh, g("20"))!;
  assert.ok(b.maxFeePerGas * 10n >= pending.maxFeePerGas * 11n);
  assert.ok(b.maxPriorityFeePerGas >= g("0.1") && b.maxPriorityFeePerGas >= fresh.maxPriorityFeePerGas);
  const wei = bumpFees({ maxFeePerGas: g("1"), maxPriorityFeePerGas: 12_223n }, fresh, g("20"))!; // the ~0 oracle tip
  assert.ok(wei.maxPriorityFeePerGas * 10n >= 12_223n * 11n && wei.maxPriorityFeePerGas >= g("0.1"));
  const ours = bumpFees(fresh, fresh, g("20"))!; // our own quote again: ×1.25 wins on both fields
  assert.ok(ours.maxFeePerGas * 10n >= fresh.maxFeePerGas * 11n && ours.maxPriorityFeePerGas * 10n >= fresh.maxPriorityFeePerGas * 11n);
  const spike = { maxFeePerGas: g("15"), maxPriorityFeePerGas: g("0.3") }; // the base fee jumped: the fresh quote leads
  assert.deepEqual(bumpFees(pending, spike, g("20")), spike);
  assert.deepEqual(bumpFees(pending, { ...spike, maxFeePerGas: g("30") }, g("20")), { maxFeePerGas: g("20"), maxPriorityFeePerGas: g("0.3") });
  assert.deepEqual(bumpFees(pending, null, g("20")), nextFees(pending, g("20")), "no fresh quote: ×1.25 alone");
  assert.equal(bumpFees(pending, null, g("20"), g("0.1"))!.maxPriorityFeePerGas, g("0.1"), "no fresh quote: a 0 tip still rises to the floor");
  assert.equal(bumpFees({ maxFeePerGas: g("20"), maxPriorityFeePerGas: 0n }, fresh, g("20")), null, "at the ceiling: wait");
});

test("anchor backfills the 6 days before the payload day", () => {
  assert.deepEqual(anchorDays("2026-10-02"), ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
});

test("the buyback and LP keepers check every 10 minutes, so an hourly cooldown never costs an extra hour", () => {
  assert.deepEqual(KEEPER_EVERY, { distribute: 3600_000, process: 600_000, add: 600_000, claim: 3600_000, expire: 3600_000 });
  assert.equal(due.cooldown(10n ** 18n, 3600n + 100n, 100n, 3600n), true, "due the second the cooldown ends");
  assert.equal(due.cooldown(10n ** 18n, 3600n + 99n, 100n, 3600n), false, "a tick before it is a no-op");
  assert.match(readFileSync(new URL("../../docs/CAPACITY.md", import.meta.url), "utf8"), /process\/add every 10 min/, "the capacity table counts the cadence");
});

test("the owners' note for a post that went out: the event or the post it answered, the link, the text", () => {
  assert.equal(postedNote({ type: "post", event_key: "Queued:0xab:0", reply_to: null }, "111", "fee change queued."), "Posted: Queued:0xab:0\nhttps://x.com/i/status/111\nfee change queued.");
  assert.equal(postedNote({ type: "reply", event_key: "reply:222", reply_to: "222" }, "333", "x".repeat(400)), `Posted: reply to https://x.com/i/status/222\nhttps://x.com/i/status/333\n${"x".repeat(280)}`);
});

test("site changes: the list is checked entry by entry; the oldest unannounced one of the last 48 h is next", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const at = (h: number) => new Date(now - h * 3600_000).toISOString();
  const ok = (id: string, h: number, over: Record<string, unknown> = {}) => ({ id, at: at(h), title: `Page ${id}`, summary: "a short summary", url: `/p/${id}`, ...over });
  assert.equal(siteChangeDue([ok("a", 1), ok("b", 3), ok("c", 2)], new Set(), now)?.id, "b", "oldest first");
  assert.equal(siteChangeDue([ok("a", 1), ok("b", 3)], new Set(["b"]), now)?.id, "a", "an announced id is skipped");
  assert.equal(siteChangeDue([ok("a", 49), ok("f", -1)], new Set(), now), undefined, "older than 48 h, or from the future");
  assert.equal(siteChangeDue([ok("a", 47.9)], new Set(), now)?.id, "a");
  for (const bad of [null, "x", { id: "a" }, 42]) assert.equal(siteChangeDue(bad, new Set(), now), undefined);
  const refused = [ok("u1", 1, { url: "https://evil.example/x" }), ok("u2", 1, { url: "//evil.example" }), ok("u3", 1, { url: "/\\evil" }), ok("u4", 1, { url: "/a b" }),
    ok("t", 1, { title: "x".repeat(61) }), ok("s", 1, { summary: "x".repeat(201) }), ok("e", 1, { title: " " }), ok("i/d", 1), ok("d", 1, { at: "yesterday" }), { id: "m", at: at(1) }];
  assert.equal(siteChangeDue([...refused, ok("good", 1)], new Set(), now)?.id, "good", "every bad entry skipped, a good one still posts");
});

test("a website change: the stage says what changed, never hype, and the site line is code's", () => {
  const f = factSheet({ event: "site_changed", id: "c1", title: "Burn page", summary: "the burn page shows every burn", url: "/burn" });
  assert.deepEqual([f.title, f.summary, f.stage], ["Burn page", "the burn page shows every burn", "the website changed: Burn page. the burn page shows every burn; the change is live on the site"]);
  assert.equal(factSheet({ event: "site_changed", title: "Burn page", summary: "now 3 games" }).summary, undefined, "a digit in the summary drops it");
  assert.ok(!shapesFor("post", f).includes("hype"));
  assert.equal(titleOf({ event: "site_changed", title: "Burn page", summary: "the burn page shows every burn" }), "The website changed: Burn page. the burn page shows every burn");
});

test("the treasury's DNA: a buy on the pool, a transfer out (a sale when the tx sold), and nothing for anything else", () => {
  const SAFE = "0xDA1Af681CF1F924eE24447DB0352dbD59b6C0F73", PM = "0x000000000004444c5dc75cb358380d2e3de08a90", W = `0x${"77".repeat(20)}`, X2 = `0x${"88".repeat(20)}`;
  const dep = { labels: { [W]: "growth team" }, poolManager: PM, liquidityVault: `0x${"99".repeat(20)}`, safe: SAFE };
  const DNA = (n: number) => String(BigInt(n) * 10n ** 18n), ETH = (n: number) => String(BigInt(Math.round(n * 1e6)) * 10n ** 12n);
  const tr = (tx: string, from: string, to: string, n: number) => ({ tx, event: "Transfer", args: { from, to, value: DNA(n) } });
  const sw = (tx: string, amount0: string) => ({ tx, event: "Swap", args: { amount0, amount1: "0" } });
  const supply = 1_000_000_000n * 10n ** 18n;
  const rows = [
    sw("0xb1", `-${ETH(2.5)}`), tr("0xb1", PM, SAFE.toLowerCase(), 12_500_000), // the Safe buys
    tr("0xt1", SAFE, W, 5_000_000), // to the labeled growth team
    tr("0xt2", SAFE, X2, 1_000), // to an unlabeled wallet
    tr("0xt3", SAFE, dep.liquidityVault, 2_000), // to one of DNA's own contracts
    tr("0xs1", SAFE, PM, 3_000_000), sw("0xs1", ETH(0.6)), // the Safe sells
    tr("0xg1", W, SAFE, 50), // a gift in, no swap: nothing
    sw("0xu1", `-${ETH(1)}`), tr("0xu1", PM, W, 400), // someone else's buy: nothing
  ];
  rows.push(tr("0xz1", SAFE, `0x${"0".repeat(40)}`, 10)); // a burn from the Safe
  rows.push(sw("0xd1", `-${ETH(0.001)}`), { tx: "0xd1", event: "Transfer", args: { from: PM, to: SAFE, value: "5" } }); // dust to the Safe
  rows.push(sw("0xo1", `-${ETH(1)}`), tr("0xo1", PM, SAFE, 9_000)); // someone else's swap with the Safe as recipient
  const got = treasuryFacts(rows, SAFE, supply, dep, new Set(["0xb1", "0xd1"]));
  assert.deepEqual(got.map((g) => [g.key, g.facts]), [
    ["treasury:0xb1:buy", { event: "treasury_buy", dnaAmount: 12_500_000, ethSpent: 2.5, supplyPct: 1.25 }],
    [`treasury:0xt1:out:${W}`, { event: "treasury_transfer", dnaAmount: 5_000_000, supplyPct: 0.5, recipient: W, label: "growth team" }],
    [`treasury:0xt2:out:${X2}`, { event: "treasury_transfer", dnaAmount: 1_000, supplyPct: 0.0001, recipient: X2 }],
    [`treasury:0xt3:out:${dep.liquidityVault}`, { event: "treasury_transfer", dnaAmount: 2_000, supplyPct: 0.0002, recipient: dep.liquidityVault, label: "DNA's liquidity vault contract" }],
    [`treasury:0xs1:out:${PM}`, { event: "treasury_transfer", dnaAmount: 3_000_000, supplyPct: 0.3, recipient: PM, label: "the Uniswap pool", soldEth: 0.6 }],
    [`treasury:0xz1:out:0x${"0".repeat(40)}`, { event: "treasury_transfer", dnaAmount: 10, supplyPct: 0.000001, recipient: `0x${"0".repeat(40)}`, label: "the burn address" }],
  ], "a swap the Safe did not execute, and dust, are no treasury buy");
  // the hook's fee: on top of a buy's swap, out of a sale's
  const fee = (tx: string, buy: boolean, eth: number) => ({ tx, event: "FeeTaken", args: { buy: String(buy), exactInput: "true", gross: "0", project: ETH(eth), platform: "0", pips: "30000" } });
  const withFees = treasuryFacts([sw("0xf1", `-${ETH(2)}`), fee("0xf1", true, 0.06), tr("0xf1", PM, SAFE, 100), tr("0xf2", SAFE, PM, 100), sw("0xf2", ETH(1)), fee("0xf2", false, 0.03)], SAFE, supply, dep, new Set(["0xf1"]));
  assert.deepEqual(withFees.map((g) => g.facts.ethSpent ?? g.facts.soldEth), [2.06, 0.97]);
  assert.equal(labelOf(`0x${"0".repeat(36)}dEaD`, dep), "the burn address");
  assert.equal(labelOf(W, { labels: { [W]: "team 2" } }), undefined, "a label with a digit is not used");
  assert.equal(labelOf(X2, dep), undefined);
  assert.equal(labelOf(W.toUpperCase().replace("0X", "0x"), dep), "growth team", "labels match any case");
});

test("treasury posts say exactly what happened: never demand or price support, a labeled transfer names who got it, a sale is a sale", () => {
  const buy = factSheet({ event: "treasury_buy", dnaAmount: 12_500_000, ethSpent: 2.5, supplyPct: 1.25 });
  assert.match(String(buy.stage), /the team's own buy, not organic demand and not price support/);
  assert.deepEqual(vi(buy, "the treasury bought 12.5M DNA for 2.5 ETH. we eat our own cooking.", { linked: true }), []);
  for (const t of ["organic buying from the treasury.", "the treasury supports the price.", "real demand: 2.5 ETH in.", "buy pressure from the Safe."]) assert.deepEqual(vi(buy, t, { linked: true }), ["implies demand or price support"], t);
  const team = factSheet({ event: "treasury_transfer", dnaAmount: 5_000_000, supplyPct: 0.5, recipient: `0x${"77".repeat(20)}`, label: "growth team" });
  assert.equal(team.recipient, undefined, "the address never reaches the writer");
  assert.match(String(team.stage), /sent its own DNA to growth team: a transfer, not a buy or a sale/);
  assert.deepEqual(vi(team, "5M DNA from the treasury to the growth team.", { linked: true }), []);
  assert.deepEqual(vi(team, "5M DNA moved to a new home.", { linked: true }), ["does not say who got it"]);
  assert.deepEqual(vi(team, "the treasury sold 5M DNA to the growth team.", { linked: true }), ["calls a transfer a sale"]);
  const sale = factSheet({ event: "treasury_transfer", dnaAmount: 3_000_000, supplyPct: 0.3, label: "the Uniswap pool", soldEth: 0.6 });
  assert.deepEqual(vi(sale, "3M DNA left the treasury.", { linked: true }), ["does not say it was a sale"]);
  assert.deepEqual(vi(sale, "the treasury sold 3M DNA for 0.6 ETH.", { linked: true }), []);
  assert.deepEqual(vi(sale, "the treasury swapped 3M DNA for 0.6 ETH on the pool.", { linked: true }), []);
  // the stage's own negations are true lines
  assert.deepEqual(vi(buy, "not demand, not price support. just the team buying 12.5M DNA.", { linked: true }), []);
  assert.deepEqual(vi(team, "a transfer to the growth team, not a sale. nothing sold.", { linked: true }), []);
  const fund = factSheet({ event: "treasury_transfer", dnaAmount: 10, label: "DNA's game funder contract" });
  assert.deepEqual(vi(fund, "10 DNA to the game funder.", { linked: true }), [], "the label's own words, not the whole string");
  assert.ok(!shapesFor("post", buy).includes("hype"), "the team's own buy is never hype");
  const fomo = factSheet({ event: "treasury_transfer", dnaAmount: 1000, label: "fomo team wallet" });
  assert.deepEqual(vi(fomo, "1,000 DNA went to the fomo team's wallet.", { linked: true }), [], "a possessive or plural still names it");
  assert.deepEqual(vi(factSheet({ event: "treasury_transfer", dnaAmount: 10, label: "the burn address" }), "the treasury burned 10 DNA.", { linked: true }), []);
  assert.ok(!shapesFor("post", team).includes("hype"), "a transfer is never hype");
  assert.equal(titleOf({ event: "treasury_transfer", dnaAmount: 1000, supplyPct: 0.0001, recipient: `0x${"88".repeat(20)}` }), "The treasury (the Safe) sent 1,000 DNA (0.0001% of supply) to 0x8888…8888");
});

test("the live deployment names the fomo team wallet and looks back to the Safe's first buy (block 26171336)", () => {
  const dep = JSON.parse(readFileSync(new URL("../deployments/1.json", import.meta.url), "utf8"));
  assert.equal(labelOf("0x1d9fa8780090c08065f9d52fb40755100966f7b7", dep), "fomo team wallet");
  assert.ok(dep.treasuryFromBlock <= 26171336 && dep.treasuryFromBlock >= dep.startBlock);
});

test("a held reply that says claim is not sent; claimable, claimed and reclaim are other words", () => {
  for (const s of ["There is nothing to claim from staking.", "Claim it on the play page", "claim."]) assert.ok(HELD_CLAIM.test(s), s);
  for (const s of ["The prize is claimable for 7 days.", "It was claimed.", "No reclaim here.", "Collect it on the play page."]) assert.ok(!HELD_CLAIM.test(s), s);
  // as the send path reads it: handles out, quote marks around a word are spaces
  const held = (s: string) => HELD_CLAIM.test(unquote(s.replace(/@\w+/g, " ")));
  assert.ok(held("Press 'claim' on the play page."));
  assert.ok(held("Press \u2018claim\u2019 on the play page."));
  assert.ok(!held("@claim_updates Collect it on the play page."));
  assert.ok(!held("Don't wait: holders' shares are collected on the play page."));
  // the writer's filter catches a quoted claim too
  assert.ok(postFilter("Press 'claim' on the play page.", new Set(), false, { claim: false }).some((i) => /claim/.test(i)));
});
