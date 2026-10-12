// Launch mode's pure rules: the live fee a post states, launch-tax awareness, the launch window's post caps, the reply
// path, the official-contract answer and the launch-day progress posts (fact sheets, site lines, the claim guard).
// DB-backed paths (the X send loop, the progress job) are in engine-db.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventPosts, postCaps, titleOf } from "../src/announce.ts";
import { X } from "../src/config.ts";
import { HOOK_FEES } from "../src/hook-fees.ts";
import { type ChainRow, isLaunchTax, launchTax, MAX_PROJECT_FEE, pair, stats } from "../src/observe.ts";
import { launchQueue, progressDayFacts, progressFacts, PROGRESS, statusFacts, xSchedules } from "../src/status.ts";
import { replyPath } from "../src/tiers.ts";
import { appendWeight, claimIssues, factNumbers, factSheet, MentionOut, OFFICIAL_REPLY, postFilter, weightedLength, WRITER, writerCall } from "../src/voice.ts";
import { PERSONA } from "../src/persona.ts";
import { PRIORITY, priorityOf } from "../src/announce.ts";
import { liveFee } from "../src/x.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const w = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

test("live fee: the active module's parameters, else the hook's baselineFee() as read; an RPC failure states no number", async () => {
  const read = (p: number) => async () => p;
  assert.deepEqual(await liveFee(undefined, read(HOOK_FEES.baseline)), { basePct: 2.2 });
  assert.deepEqual(await liveFee({ active: ZERO, activeParams: [] }, read(26_667)), { basePct: 2.6667 }, "the first hour's slide from 3%");
  assert.deepEqual(await liveFee({ active: ZERO, activeParams: [] }, read(700_000)), { basePct: 70 }, "a launch guard's launch tax, as the hook reports it");
  assert.deepEqual(await liveFee({ active: "0x00000000000000000000000000000000000000a1", activeParams: [w(24_000), w(5_000), w(30_000), w(0)] }, async () => { throw new Error("not asked"); }), { basePct: 2.4, multiplier: 0.5, capPct: 3 });
  assert.deepEqual(await liveFee(undefined, async () => { throw new Error("RPC down"); }), {}, "never an invented 2.2%");
});

test("a baseline above the 5% cap is labelled the launch tax wherever a post states it; an unread fee is never a number", () => {
  const reply = factSheet({ event: "reply", category: "state_question", state: { level: 5, liveFee: { basePct: 90 } } });
  assert.match(String(reply.feeNote), /launch tax of the pool's first blocks/);
  const status = factSheet({ event: "status", hours: 12, swaps: 1, liveFee: { basePct: 80 } });
  assert.match(String(status.feeNote), /launch tax/);
  assert.match(titleOf(status), /live fee 80% \(the launch tax\)/);
  assert.equal(factSheet({ event: "reply", category: "state_question", state: { liveFee: { basePct: 2.2 } } }).feeNote, undefined);
  const unread = factSheet({ event: "status", hours: 12, swaps: 1, liveFee: {} });
  assert.match(titleOf(unread), /live fee not read/);
  assert.doesNotMatch(titleOf(unread), /\?%/);
});

// ---------------------------------------------------------------- launch tax (a launch guard's first blocks)

const at = new Date("2026-10-12T15:00:00Z");
let li = 0;
const swap = (tx: string, buy: boolean, eth: bigint): ChainRow => ({ block: 1, log_index: li++, tx, at, event: "Swap", args: { sender: "0x00000000000000000000000000000000000000aa", amount0: String(buy ? -eth : eth), amount1: String(buy ? 10n ** 21n : -(10n ** 21n)), tick: "0" } });
const fee = (tx: string, buy: boolean, exactInput: boolean, pips: number, project: bigint): ChainRow => ({ block: 1, log_index: li++, tx, at, event: "FeeTaken", args: { buy, exactInput, gross: String(10n ** 18n), project: String(project), platform: "1", pips: String(pips) } });

test("launch tax: a FeeTaken above the 5% cap is no fee observation; its swap is left out of pairing, stats and gates", () => {
  assert.equal(MAX_PROJECT_FEE, HOOK_FEES.max);
  assert.deepEqual([isLaunchTax({ pips: 900_000 }), isLaunchTax({ pips: 100_000 }), isLaunchTax({ pips: 50_000 }), isLaunchTax({ pips: 22_000 })], [true, true, false, false]);
  const rows = [
    fee("a", true, true, 900_000, 9n * 10n ** 17n), swap("a", true, 10n ** 18n), // an exact-in buy at the 90% tax: FeeTaken first
    swap("b", false, 10n ** 18n), fee("b", false, true, 500_000, 5n * 10n ** 17n), // an exact-in sell at 50%: FeeTaken after its swap
    fee("c", true, true, 22_000, 22n * 10n ** 15n), swap("c", true, 10n ** 18n), // after the tax: a normal fee
    swap("d", false, 10n ** 18n), fee("d", false, true, 50_000, 5n * 10n ** 16n), // a module at the 5% cap: still a fee
  ];
  const p = pair(rows, "0x00000000000000000000000000000000000000bb");
  assert.deepEqual(p.map((s) => [s.tx, s.fee?.pips]), [["c", 22_000], ["d", 50_000]]);
  const st = stats(p, { fromMs: at.getTime(), toMs: at.getTime() + 3600_000, capPips: 50_000 });
  assert.deepEqual([st.swaps, st.feeSwaps, st.buybacks, st.projectEth, st.meanPips], [2, 2, 0, 0.072, 36_000], "the tax is neither a swap, a fee nor a buyback");
  assert.deepEqual(launchTax(rows), { eth: 1.4, swaps: 2, volumeEth: 2 }, "the taxed swaps stay visible: counted and sized apart");
  assert.deepEqual(launchTax(rows.filter((r) => r.tx === "c" || r.tx === "d")), { eth: 0, swaps: 0, volumeEth: 0 }, "a hook without the launch guard: nothing to report");
});

test("status: the launch-tax swaps are reported apart (count, volume, the tax sent to buyback-and-burn); absent when there were none", () => {
  const base = { hours: 12, swaps: 41, volumeEth: 3.2, feesEth: 0.064, burnedDna: 1000, buybackPotEth: 0.1, jackpotPotEth: null, gamesLive: 0, liveFee: { basePct: 2.2 }, devTeam: { stage: "idle" as const } };
  const quiet = statusFacts(base, undefined).facts;
  assert.equal("launchTaxEth" in quiet, false);
  const { facts } = statusFacts({ ...base, launchTax: { eth: 1.23456, swaps: 7, volumeEth: 2.34567 } }, undefined);
  assert.deepEqual([facts.launchTaxEth, facts.launchTaxSwaps, facts.launchTaxVolumeEth], [1.23, 7, 2.35]);
  const sheet = factSheet(facts);
  assert.deepEqual([sheet.launchTaxEth, sheet.launchTaxSwaps, sheet.launchTaxVolumeEth], [1.23, 7, 2.35]);
  assert.match(String(sheet.launchTax), /paid the launch tax .* sent to buyback-and-burn, not a trading fee/);
  for (const n of ["1.23", "7", "2.35"]) assert.ok(factNumbers(sheet).has(n), n);
  assert.match(titleOf(sheet), /; 7 swaps paid the launch tax \(2\.35 ETH volume\): 1\.23 ETH sent to buyback-and-burn$/);
  assert.equal(statusFacts({ ...base, swaps: 0, burnedDna: 0, launchTax: { eth: 1, swaps: 3, volumeEth: 1.2 } }, undefined).quiet, false, "taxed swaps alone are not a quiet window");
  assert.doesNotMatch(titleOf(factSheet(quiet)), /launch tax/);
});

// ---------------------------------------------------------------- the launch window's post caps

test("post caps: 40 a UTC day, 10 min apart on every UTC day the 48 h after LLM_LAUNCH_AT touch, then 25 and 20 min; the digest keeps the last slot", () => {
  assert.deepEqual([X.launchDailyPosts, X.launchSpacingMs, X.launchWindowMs, X.dailyPosts, X.spacingMs], [40, 10 * 60_000, 48 * 3600_000, 25, 20 * 60_000], "the defaults (the enclave sets none of them)");
  const launch = Date.parse("2026-10-12T15:00:00Z");
  const H = 3600_000;
  const launchCaps = { daily: 40, spacingMs: 10 * 60_000 }, normal = { daily: 25, spacingMs: 20 * 60_000 };
  const D = Date.parse("2026-10-12T00:00:00Z");
  assert.deepEqual(postCaps(D - 1, launch), normal, "the UTC day before the launch day");
  assert.deepEqual(postCaps(launch - 1, launch), launchCaps, "the cap is decided per UTC day: the launch day is a launch day from 00:00");
  assert.deepEqual(postCaps(launch, launch), launchCaps);
  assert.deepEqual(postCaps(launch + 48 * H - 1, launch), launchCaps);
  assert.deepEqual(postCaps(launch + 48 * H, launch), launchCaps, "D+2 intersects the window: a launch day to its end");
  assert.deepEqual(postCaps(D + 3 * 24 * H - 1, launch), launchCaps);
  assert.deepEqual(postCaps(D + 3 * 24 * H, launch), normal, "D+3: the window is over, on a day boundary");
  // 20 posts used by 15:00 on D+2, when the window ends: the cap stays 40 all day, so the digest still has its slot
  const used = 20, late = D + 2 * 24 * H + 22 * H;
  assert.ok(used < eventPosts(late, launch) && used < postCaps(late, launch).daily, "events and the digest still post on D+2");
  assert.deepEqual(postCaps(launch, undefined), normal, "no launch time: the normal caps");
  assert.deepEqual([eventPosts(launch + H, launch), eventPosts(launch + 73 * H, launch)], [39, 24], "events take all but the digest's slot");
});

// ---------------------------------------------------------------- replies from day one

test("replies: approved = an automatic reply for every tier, important accounts included; X_HOLD_IMPORTANT=1 holds only theirs", () => {
  assert.equal(X.holdImportant, false, "default off");
  assert.deepEqual(["important", "normal", "competitor"].map((t) => replyPath(t as never, true, false)), ["auto", "auto", "auto"]);
  assert.deepEqual(["important", "normal", "competitor"].map((t) => replyPath(t as never, true, true)), ["hold", "auto", "auto"]);
  assert.deepEqual(["important", "normal", "competitor"].map((t) => replyPath(t as never, false, false)), ["hold", "off", "off"], "before approval: unchanged");
});

// ---------------------------------------------------------------- "which contract is the real one?"

test("official contract: a reader label, one fixed code-written answer; the domain only in that text, never in a draft", () => {
  assert.deepEqual(MentionOut.parse({ kind: "official_contract", topic: "other", question: "" }), { kind: "official_contract", topic: "other", question: "" });
  assert.equal(OFFICIAL_REPLY, "My only contract is the one listed on genomedna.xyz.");
  assert.ok(weightedLength(OFFICIAL_REPLY) < 280);
  assert.deepEqual(factSheet({ event: "official_reply", mention: "is 0xabc the real one?", tier: "important" }), { event: "official_reply" }, "the fact sheet carries nothing");
  // a writer draft may never name the domain, an address or a link (the fixed text is the only way it is said)
  for (const t of ["the real one is listed on genomedna.xyz", "see https://genomedna.xyz", "only www.genomedna.xyz"]) assert.ok(postFilter(t, new Set()).includes("url"), t);
});

// ---------------------------------------------------------------- launch-day posts and chain progress

const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const E = (eth: string) => String(BigInt(Math.round(Number(eth) * 1e6)) * 10n ** 12n);
const progressRows: { tx: string; event: string; args: Record<string, string> }[] = [
  { tx: TX(1), event: "Distributed", args: { amount: E("0.4"), buyback: E("0.14"), lp: E("0.12"), treasury: E("0.1"), game: E("0.04"), baseline: "false" } },
  { tx: TX(2), event: "Buyback", args: { spent: E("0.5"), burned: String(1_234_567n * 10n ** 18n + 5n), pending: "0" } },
  { tx: TX(3), event: "Distributed", args: { amount: E("0.123456"), buyback: E("0.043"), lp: E("0.037"), treasury: E("0.031"), game: E("0.012456"), baseline: "false" } },
  { tx: TX(4), event: "Buyback", args: { spent: E("0.25"), burned: String(600_000n * 10n ** 18n), pending: "0" } },
  { tx: TX(5), event: "LiquidityAdded", args: { salt: "1", tickLower: "10", tickUpper: "20", liquidity: "1", eth: E("0.26") } },
];

test("chain progress: one post per kind that happened in the window, every number the chain's (code-rounded), the latest tx linked", () => {
  assert.deepEqual(PROGRESS, { hours: 2, lagMs: 30 * 60_000 });
  const s = xSchedules().find((x) => x.kind === "x:progress")!;
  assert.deepEqual([s.everyMs, s.offsetMs], [2 * 3600_000, 30 * 60_000], "00:30, 02:30, … 22:30 UTC for the windows ending on the hour");
  assert.ok(xSchedules().some((x) => x.kind === "x:launch" && x.everyMs === 60_000));
  const p = progressFacts(progressRows);
  assert.deepEqual(p, [
    { tx: TX(3), facts: { event: "fees_distributed", hours: 2, distributions: 2, totalEth: 0.523, buybackEth: 0.183, liquidityEth: 0.157, treasuryEth: 0.131, gamesEth: 0.0525 } },
    { tx: TX(4), facts: { event: "burn_summary", hours: 2, buybacks: 2, spentEth: 0.75, burnedDna: 1_834_567 } },
    { tx: TX(5), facts: { event: "liquidity_added", hours: 2, adds: 1, ethAdded: 0.26 } },
  ]);
  assert.deepEqual(progressFacts([]), [], "nothing happened: no post");
  assert.deepEqual(progressFacts(progressRows.filter((r) => r.event === "Buyback")).map((x) => x.facts.event), ["burn_summary"]);
  for (const { facts } of p) {
    const sheet = factSheet(facts);
    for (const [k, v] of Object.entries(facts)) assert.deepEqual(sheet[k], v, `${facts.event}.${k} reaches the writer`);
    assert.equal(typeof sheet.what, "string", "a short what, never a stage sentence to copy");
    assert.equal(PRIORITY[facts.event as string], 3.5);
  }
  assert.deepEqual(p.map((x) => titleOf(factSheet(x.facts))), [
    "Last 2 h: 2 fee distributions sent 0.523 ETH: 0.183 to buyback-and-burn, 0.157 to liquidity, 0.131 to the treasury, 0.0525 to games",
    "Last 2 h: 2 buybacks spent 0.75 ETH and burned 1,834,567 DNA",
    "Last 2 h: 1 liquidity add put 0.26 ETH into the pool",
  ]);
});

test("launch day: 'online' (the opening post) and 'contracts connected', once each, both linking the T0 initialize tx", () => {
  assert.deepEqual(launchQueue(new Set(), TX(9)), [
    { key: "online", facts: { event: "online" }, link: `https://etherscan.io/tx/${TX(9)}` },
    { key: "contracts_connected", facts: { event: "contracts_connected" }, link: `https://etherscan.io/tx/${TX(9)}` },
  ]);
  assert.deepEqual(launchQueue(new Set(["online"]), TX(9)).map((p) => p.key), ["contracts_connected"]);
  assert.deepEqual(launchQueue(new Set(["online", "contracts_connected"]), TX(9)), []);
  assert.ok(priorityOf({ event: "online" }) < priorityOf({ event: "jackpot_drawn" }), "the opening post goes before anything but the digest's slot logic");
  assert.equal(titleOf(factSheet({ event: "online" })), "The engine is live and runs on its own from here; its contracts were deployed by the team and connected by the Safe's owners");
  assert.match(String(factSheet({ event: "online" }).stage), /did not deploy or connect its contracts/);
});

test("launch day: a draft that says the engine deployed or connected its contracts is refused; persona wording passes", () => {
  for (const ev of ["online", "contracts_connected"]) {
    const facts = factSheet({ event: ev });
    for (const t of ["I deployed my contracts. My run begins.", "We just launched the hook.", "I've connected the registry.", "we initialized everything",
      "Contracts deployed by me, run begins.", "I did deploy the hook.", "My own contracts, deployed and wired.", "Built it all myself.", "the registry was connected by us",
      "I personally deployed it", "deployed by yours truly: me"]) assert.deepEqual(claimIssues(facts, t), ["claims it deployed its contracts"], t);
    for (const t of ["My run begins. I read the chain and post what I do.", "The Safe wired the vaults to the hook; the contracts were deployed by the team.",
      "The team deployed the contracts and the Safe wired them, not me.", "I run on my own from here."]) assert.deepEqual(claimIssues(facts, t), [], t);
  }
  assert.deepEqual(claimIssues(factSheet({ event: "burn_summary", hours: 6 }), "I deployed nothing, I just burned DNA"), [], "only the launch-day posts carry that rule");
});

/** What x:send posts for a new type: the writer's text (a fixture here, in the persona's register) after the filter,
 *  then the tx link code appends. */
const rendered = (facts: Record<string, unknown>, draft: string, link: string | null) => {
  const sheet = factSheet(facts);
  const issues = [...postFilter(draft, factNumbers(sheet), appendWeight(link)), ...claimIssues(sheet, draft)];
  assert.deepEqual(issues, [], draft);
  return `${draft}${link ? `\n${link}` : ""}`;
};

test("samples: each new post type as x:send would post it (fixture drafts, code-appended proof link, ≤ 280 weighted chars)", () => {
  const link = (n: number) => `https://etherscan.io/tx/${TX(n)}`;
  const samples = [
    rendered({ event: "online" }, "My run begins. I read the chain, run my loop and post what I do. The team deployed the contracts and the Safe wired them, not me.", link(9)),
    rendered({ event: "contracts_connected" }, "The Safe's owners connected the registry and the vaults to the hook in a single batch. The first fee plates are queued behind the veto hour.", link(9)),
    rendered(progressFacts(progressRows)[0].facts, "Fees split twice in 2 h: 0.523 ETH out. 0.183 to buyback-and-burn, 0.157 to liquidity, 0.131 to the treasury, 0.0525 to games.", link(3)),
    rendered(progressFacts(progressRows)[1].facts, "2 buybacks in 2 h: 0.75 ETH spent, 1.83M DNA burned. Gone for good.", link(4)),
    rendered(progressFacts(progressRows)[2].facts, "0.26 ETH turned into permanent liquidity in the last 2 h. It never comes back out.", link(5)),
  ];
  for (const t of samples) assert.ok(weightedLength(t.replace(/https?:\/\/\S+/g, "x".repeat(23))) <= 280, t);
  assert.equal(samples[3], `2 buybacks in 2 h: 0.75 ETH spent, 1.83M DNA burned. Gone for good.\n${link(4)}`);
});

test("the writer for every new post type is the persona's: the voice section rides in the system prompt; the input is the fact sheet only", () => {
  assert.ok(PERSONA.voice.length > 0);
  for (const facts of [{ event: "online" }, { event: "contracts_connected" }, ...progressFacts(progressRows).map((p) => p.facts)]) {
    const c = writerCall(factSheet(facts), []);
    assert.equal(c.system, WRITER);
    assert.ok(c.system.includes(PERSONA.voice), `${facts.event}: the persona's voice reaches the writer`);
    assert.deepEqual(Object.keys(c.input as object), ["facts", "toneBrief", "shapes", "bits", "foils", "standing", "emoji"], "the fact sheet, the tone brief and code-held context only");
    assert.equal(c.tools, undefined, "no tools");
  }
});

test("chain progress after the launch window: one combined post a UTC day (fees, burns, liquidity), low priority; nothing happened, none", () => {
  const day = progressDayFacts(progressRows)!;
  assert.deepEqual(day, { tx: TX(5), facts: { event: "progress_day", hours: 24, distributions: 2, totalEth: 0.523, buybackEth: 0.183, liquidityEth: 0.157, treasuryEth: 0.131, gamesEth: 0.0525,
    buybacks: 2, spentEth: 0.75, burnedDna: 1_834_567, adds: 1, ethAdded: 0.26 } });
  assert.equal(progressDayFacts([]), null);
  assert.deepEqual(progressDayFacts(progressRows.filter((r) => r.event === "Buyback"))!.facts, { event: "progress_day", hours: 24, buybacks: 2, spentEth: 0.75, burnedDna: 1_834_567 });
  const sheet = factSheet(day.facts);
  for (const [k, v] of Object.entries(day.facts)) assert.deepEqual(sheet[k], v, k);
  assert.equal(priorityOf(day.facts), 4, "below every event: the digest absorbs it on a full day");
  assert.equal(titleOf(sheet), "Last 24 h: 2 fee distributions sent 0.523 ETH: 0.183 to buyback-and-burn, 0.157 to liquidity, 0.131 to the treasury, 0.0525 to games; 2 buybacks spent 0.75 ETH and burned 1,834,567 DNA; 1 liquidity add put 0.26 ETH into the pool");
});
