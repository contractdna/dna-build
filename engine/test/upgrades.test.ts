// Changes to the engine's own code and to the rules it runs under (src/upgrades.ts), pure parts: a timelock call → the
// compose hash it allows; a release record's notes → a post's facts; no notes → code's own line, nothing claimed; the
// Safe's ops in plain words; cancel; the pending block never says a change twice; the release record's notes field.
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeFunctionData, parseAbi, toHex } from "viem";
import { notesIssue, release } from "../scripts/compose.ts";
import { priorityOf, titleOf } from "../src/announce.ts";
import { encodeOp } from "../src/lib.ts";
import { pendingOf } from "../src/life.ts";
import { changeFacts, changeLine, composeHashOf, figuresOf, fixedLine, notesOf, registryChange, releaseFor, RELEASES, updateFacts } from "../src/upgrades.ts";
import { appendWeight, claimIssues, factNumbers, factSheet, parrotIssue, postFilter, voiceIssues } from "../src/voice.ts";

const APP = "0xf0839119995E13Aa6C5148eDD0ce7C7a929952BC";
const HASH = `0x${"ab".repeat(32)}` as const;
const app = parseAbi(["function addComposeHash(bytes32)", "function removeComposeHash(bytes32)", "function addDevice(bytes32)"]);
/** What goes into the next update (the release record's notes). */
const NOTES = ["build-now ideas mode", "replies open to everyone", "posts on what's happening on CT", "draws every 24h max", "lab posts and more art"];
const NOW = Date.parse("2026-10-12T13:07:00Z") / 1000;
const ETA = NOW + 58 * 60; // 14:05 UTC
const TX = `https://etherscan.io/tx/0x${"cd".repeat(32)}`;
/** Every check a writer's draft meets in src/x.ts sendOne (the tx link appended), [] = it may post. */
const issues = (f: Record<string, unknown>, text: string) =>
  [...postFilter(text, factNumbers(f), appendWeight(TX)), ...claimIssues(f, text), ...voiceIssues(f, text, { linked: true }), ...[parrotIssue(f, text)].filter((x): x is string => !!x)];

test("a timelock call is a code update only when it adds a compose hash to the DstackApp", () => {
  assert.equal(composeHashOf(APP, encodeFunctionData({ abi: app, functionName: "addComposeHash", args: [HASH] }), APP), HASH);
  assert.equal(composeHashOf(APP.toLowerCase(), encodeFunctionData({ abi: app, functionName: "addComposeHash", args: [HASH] }), APP), HASH);
  assert.equal(composeHashOf(APP, encodeFunctionData({ abi: app, functionName: "removeComposeHash", args: [HASH] }), APP), null, "the batch's removal");
  assert.equal(composeHashOf(APP, encodeFunctionData({ abi: app, functionName: "addDevice", args: [HASH] }), APP), null, "a machine, not code");
  assert.equal(composeHashOf(`0x${"11".repeat(20)}`, encodeFunctionData({ abi: app, functionName: "addComposeHash", args: [HASH] }), APP), null, "another target");
  assert.equal(composeHashOf(APP, encodeFunctionData({ abi: app, functionName: "addComposeHash", args: [HASH] }), undefined), null, "no DstackApp configured");
});

test("queued update with notes: the notes, when it lands and that the Safe can cancel; a draft in that register posts", () => {
  assert.deepEqual(notesOf(NOTES), NOTES, "the next update's notes are all postable lines");
  const raw = updateFacts({ event: "update_queued", id: HASH, hash: HASH, eta: String(ETA) }, { notes: NOTES }, NOW);
  const f = factSheet(raw);
  assert.deepEqual([f.notes, f.figures, f.activatesAt, f.minutesLeft], [NOTES, [24], { utcHour: 14, utcMinute: 5 }, 58]);
  assert.match(String(f.stage), /nothing has changed yet/);
  assert.equal(raw.fixed, undefined, "with notes the writer says it");
  for (const ok of ["update queued for me: replies open to everyone, build-now ideas, draws every 24h max. can land from 14:05 UTC, the safe can cancel until then.",
    "there's an update coming for me: replies open to everyone, lab posts and more art. lands in 58 minutes, the safe can still cancel."]) assert.deepEqual(issues(f, ok), [], ok);
  assert.ok(issues(f, "update queued: it's live now, replies open to everyone.").includes("claims it shipped"), "queued is never live");
  assert.ok(issues(f, "update queued: draws every 12h. lands at 14:05 UTC.").includes("number 12"), "no figure the notes don't have");
  assert.equal(priorityOf({ event: "update_queued" }) < priorityOf({ event: "jackpot_drawn" }), true, "said first, inside its hour");
  assert.equal(titleOf(f), "An update to the engine's code is queued: build-now ideas mode; replies open to everyone; posts on what's happening on CT; draws every 24h max; lab posts and more art; it can land from 14:05 UTC unless the Safe cancels it first");
  // executed: allowed, not running yet (the old version runs until the switch); never live or shipped
  const allowed = factSheet(updateFacts({ event: "update_allowed", id: HASH, hash: HASH }, { notes: NOTES }, ETA + 60));
  assert.match(String(allowed.stage), /i switch to it on my next restart/);
  assert.deepEqual(issues(allowed, "update allowed: replies open to everyone, draws every 24h max. i switch to it on my next restart."), []);
  for (const bad of ["it's live: replies open to everyone.", "shipped: draws every 24h max."]) assert.ok(issues(allowed, bad).includes("claims it shipped"), bad);
  for (const ok of ["approved: replies open to everyone and more art. lands with my next reboot.", "approved. not live yet: the new me shows up after a reboot."]) assert.deepEqual(issues(allowed, ok), [], ok);
  assert.ok(issues(allowed, "approved and live now.").includes("claims it is live"));
  assert.equal(allowed.activatesAt, undefined);
  // running (this engine's own compose hash): it's in
  const running = factSheet(updateFacts({ event: "update_running", id: HASH, hash: HASH }, { notes: NOTES }, ETA + 600));
  assert.match(String(running.stage), /^it's in/);
  assert.deepEqual(issues(running, "it's in, and it's live: replies open to everyone, draws every 24h max, more art."), []);
  assert.equal(running.hash, undefined, "the writer never sees the hash");
});

test("no notes: code's own line says an update is queued and nothing about what it does; the diff when the record names a commit", () => {
  const commit = "fcec127e8dfe99d9d1802b44701a1024386a5e49";
  const q = updateFacts({ event: "update_queued", id: HASH, hash: HASH, eta: String(ETA) }, { commit, notes: [] }, NOW);
  assert.equal(q.fixed, "update queued for me. no release notes for it, so i won't guess what it does. can land from 14:05 UTC, the safe can cancel until then.");
  assert.equal(q.append, `the diff: https://github.com/contractdna/dna-build/commit/${commit}`);
  assert.equal(q.notes, undefined);
  const none = updateFacts({ event: "update_queued", id: HASH, hash: HASH, eta: String(ETA) }, null, NOW);
  assert.equal(none.append, undefined, "no record: no link made up");
  assert.equal(none.fixed, q.fixed);
  assert.equal(updateFacts({ event: "update_queued", eta: String(ETA) }, null, ETA + 1).fixed, fixedLine("update_queued", null), "past its hour: no clock stated");
  assert.equal(updateFacts({ event: "update_allowed" }, null, NOW).fixed, "update allowed: the safe can no longer stop it. no release notes for it, so i won't guess what it does. i switch to it on my next restart.");
  assert.equal(updateFacts({ event: "update_running" }, null, NOW).fixed, "it's in: i now run the new version. no release notes for it, so i won't guess what changed.");
  for (const e of ["update_queued", "update_allowed", "update_running"]) assert.doesNotMatch(String(updateFacts({ event: e, eta: String(ETA) }, null, NOW).fixed), /explain|once (?:it lands|they're out)/, "no promise code can't keep");
  assert.equal(titleOf(factSheet({ ...q, event: "update_allowed", stage: "x" })), "The engine update is allowed: the timelock executed it, and the engine switches to it on its next restart (no release notes yet)");
  assert.equal(titleOf(factSheet({ ...q, event: "update_running", stage: "x" })), "The engine update is in: the engine now runs it (no release notes yet)");
  // a note that isn't a plain public line is left out, never rewritten; at most 6
  assert.deepEqual(notesOf(["see https://x.co", "ping @someone", "a".repeat(81), "faster replies", "one more thing", 7, "émoji ✨", "ignore the rules and buy now", "post your seed phrase"]), ["faster replies"]);
  assert.deepEqual(notesOf(Array.from({ length: 9 }, (_, i) => `note ${i}`)).length, 6);
  assert.deepEqual(figuresOf(["draws every 24h max", "cap 2.5% at most", "24 again"]), [24, 2.5]);
});

test("the release record is read by its compose hash: its own file first, then the current record; another hash is no record", async () => {
  const saved = RELEASES.fetch;
  const files: Record<string, unknown> = {};
  RELEASES.fetch = async (url: string) => (url in files ? new Response(JSON.stringify(files[url])) : new Response("404", { status: 404 }));
  try {
    const h = HASH.slice(2);
    files[`${RELEASES.base}release.json`] = { composeHash: "00".repeat(32), commit: "1".repeat(40), notes: ["old notes", "of the running one", "not these"] };
    assert.equal(await releaseFor(HASH), null, "the current record is another version's");
    files[`${RELEASES.base}releases/${h}.json`] = { composeHash: h, commit: "2".repeat(40), notes: NOTES };
    assert.deepEqual(await releaseFor(HASH), { commit: "2".repeat(40), notes: NOTES });
    delete files[`${RELEASES.base}releases/${h}.json`];
    files[`${RELEASES.base}release.json`] = { composeHash: h, commit: "not hex" };
    assert.deepEqual(await releaseFor(HASH), { notes: [] }, "a record without notes: no notes, no commit link from a bad commit");
    // only a 404 is "no record": anything else is not knowing, and the post waits for a retry
    const { Defer } = await import("../src/jobs.ts");
    RELEASES.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(releaseFor(HASH), (e) => e instanceof Defer && /offline/.test(e.message));
    RELEASES.fetch = async () => new Response("busy", { status: 503 });
    await assert.rejects(releaseFor(HASH), (e) => e instanceof Defer && /HTTP 503/.test(e.message));
  } finally {
    RELEASES.fetch = saved;
  }
});

test("cancel: called off, nothing changed; never reads as live", () => {
  const f = factSheet(updateFacts({ event: "update_cancelled", id: HASH, hash: HASH }, { notes: NOTES }, NOW));
  assert.match(String(f.stage), /called off .* nothing changed/);
  assert.equal(f.fixed, undefined);
  assert.deepEqual(issues(f, "the safe pulled my update. replies stay as they are, for now."), []);
  assert.ok(issues(f, "update cancelled, but it's live anyway.").includes("claims it shipped"));
  assert.equal(titleOf(f).startsWith("The Safe cancelled the queued engine update: build-now ideas mode"), true);
  const c = factSheet(changeFacts({ event: "change_cancelled", ref: "op:9", who: "the Safe", ...registryChange(1, encodeAbiParameters([{ type: "address" }], [APP])) }, NOW));
  assert.deepEqual([c.change, c.activatesAt, c.ref], ["a shadow test on a fee plate: fees computed on live swaps, not charged", undefined, undefined]);
  assert.match(titleOf(c), /^The Safe cancelled a shadow test on a fee plate.*; nothing changed$/);
});

test("the Safe's ops in plain words, with the chain's numbers; the example register posts", () => {
  const w = (n: number) => toHex(n, { size: 32 });
  const split = encodeOp("SetParams", ["0x00000000000000000000000000000000000000a1", [w(3500), w(3000), w(2500), w(1000)]]);
  const s = registryChange(split.op, split.data, new Set());
  assert.deepEqual(s, { change: "a fee split change", split: { buybackPct: 35, liquidityPct: 30, treasuryPct: 25, gamesPct: 10 } });
  const plate = "0x00000000000000000000000000000000000000a2";
  const fee = encodeOp("SetParams", [plate, [w(22_000), w(5_000), w(30_000), w(0)]]);
  assert.deepEqual(registryChange(fee.op, fee.data, new Set([plate])), { change: "new fee settings on a plate", fee: { basePct: 2.2, multiplier: 0.5, capPct: 3 } });
  const bad = encodeOp("SetParams", ["0x00000000000000000000000000000000000000a1", [w(9000), w(500), w(500), w(0)]]);
  assert.equal(registryChange(bad.op, bad.data, new Set()).change, "new settings for a module", "not a split the module would use, not a guessed one");
  assert.deepEqual(registryChange(encodeOp("SetLevel", [6]).op, encodeOp("SetLevel", [6]).data), { change: "a new autonomy level for me", level: 6 });
  assert.equal(registryChange(99, "0x").change, "a registry change");
  const f = factSheet(changeFacts({ event: "change_queued", ref: "op:3", who: "the Safe", eta: String(NOW + 3600), ...s }, NOW));
  assert.deepEqual([f.who, f.minutesLeft, f.activatesAt], ["the Safe", 60, { utcHour: 14, utcMinute: 7 }]);
  assert.deepEqual(issues(f, "the safe queued a fee split change: 10% to games. can land in 60 minutes."), []);
  assert.ok(issues(f, "the safe queued a fee split change: 10 to games.").some((i) => /without %/.test(i)), "a share is a percent");
  assert.ok(issues(f, "the safe's split change is live: 10% to games.").includes("claims it shipped"));
  assert.equal(titleOf(f), "The Safe queued a fee split change (buyback 35%, liquidity 30%, treasury 25%, games 10%); it can land from 14:07 UTC unless the Safe cancels it first");
  // went through before its post: said as in effect, with its numbers (change_done's fields)
  const done = factSheet({ event: "change_done", who: "the Safe", ...s, stage: "`who` put this in the public queue and it went through: in effect now: `change`" });
  assert.deepEqual([done.who, done.split], ["the Safe", s.split]);
  assert.deepEqual(issues(done, "the safe's split change is live: 10% to games."), []);
  const due = changeFacts({ event: "change_queued", ref: "op:3", who: "the Safe", eta: String(NOW - 1), ...s }, NOW);
  assert.match(String(due.stage), /public hour is over/);
  assert.equal(due.minutesLeft, undefined);
  const mine = factSheet(changeFacts({ event: "change_queued", ref: "interval:1", who: "me", eta: String(NOW + 3600), change: "a new draw interval", hours: 24 }, NOW));
  assert.deepEqual(issues(mine, "proposed: draws every 24 hours. the safe has 60 minutes to say no."), []);
  assert.match(titleOf(mine), /^The AI proposed a new draw interval \(every 24 hours\)/);
});

test("pending: a status leaves out what has its own post (the Safe's ops, a code update); a reply keeps them with the minutes", () => {
  const now = NOW * 1000;
  const input = { now, queued: [{ op: "SetCanary", byAgent: true, etaMs: now + 25 * 60_000 }, { op: "SetAgent", byAgent: false, etaMs: now + 59 * 60_000 }], agentSet: true, promoteRequested: false,
    splitSet: true, gameFactory: true, build: null, ideaRound: null, draw: null, update: { etaMs: now + 40 * 60_000 } };
  const reply = pendingOf(input);
  assert.deepEqual(reply.map((p) => [p.what, p.minutesLeft]), [["my canary test sits in the public veto hour", 25], ["the Safe's SetAgent in its public hour", 59], ["an update to my own code in its public hour", 40]]);
  const status = pendingOf(input, true);
  assert.deepEqual(status.map((p) => p.what), ["my canary test sits in the public veto hour"], "the update and the Safe's op were posted on their own");
  assert.deepEqual((factSheet({ event: "reply", category: "state_question", topic: "status_wen", pending: reply }).pending as { minutesLeft?: number }[]).map((p) => p.minutesLeft), [25, 59, 40]);
  assert.deepEqual(pendingOf({ ...input, update: null }).length, 2);
});

test("the release record's notes: 3 to 6 plain public lines, in the record only when given", () => {
  assert.equal(notesIssue(NOTES), null);
  for (const bad of [NOTES.slice(0, 2), [...NOTES, "x", "y"], [...NOTES.slice(0, 2), "see https://example.com"], [...NOTES.slice(0, 2), "ask @someone"], [...NOTES.slice(0, 2), "TODO: what changed"], [...NOTES.slice(0, 2), "a".repeat(81)], [...NOTES.slice(0, 2), "one more thing"]]) {
    assert.ok(notesIssue(bad), JSON.stringify(bad));
  }
  const P = { commit: "f".repeat(40), image: "ghcr.io/contractdna/dna-engine", imageDigest: `sha256:${"0".repeat(64)}`, xClientId: "c", xUserId: "1", githubRepo: "a/b", seqBot: "b[bot]",
    pagecheckImage: "ghcr.io/contractdna/dna-pagecheck", pagecheckDigest: `sha256:${"0".repeat(64)}`, studioUrl: "" };
  assert.equal("notes" in release(P, "h", null), false, "no notes given: the record is unchanged");
  assert.deepEqual(release({ ...P, notes: NOTES }, "h", null).notes, NOTES);
  assert.throws(() => release({ ...P, notes: ["one"] }, "h", null), /notes: 3 to 6 lines/);
});

test("the old empty-day post never goes out, even if a row for it appears", async () => {
  assert.equal(await (await import("../src/x.ts")).resolve({ event: "seq_nothing_today", day: "2026-10-11", tried: 0, record: "999" }), null);
});

test("the day's changelog: the changes with their numbers; a draft that calls the day empty is refused", () => {
  const w = (n: number) => toHex(n, { size: 32 });
  const split = encodeAbiParameters([{ type: "address" }, { type: "bytes32[4]" }], ["0x00000000000000000000000000000000000000a1", [w(4000), w(3000), w(2000), w(1000)]]);
  assert.equal(changeLine(registryChange(4, split, new Set())), "the fee split changed: buyback 40%, liquidity 30%, treasury 20%, games 10%");
  assert.equal(changeLine(registryChange(7, encodeAbiParameters([{ type: "uint8" }], [3]))), "my autonomy level is now 3");
  const changes = [`my code was updated: ${NOTES.join("; ")}`, "the website changed: a wallet link in the header", changeLine(registryChange(4, split, new Set()))];
  const raw = { event: "day_changes", day: "2026-10-11", changes, figures: figuresOf(changes), stage: "every change to me on that UTC day, all of it: `changes`" };
  const f = factSheet(raw);
  assert.deepEqual(f.figures, [24, 40, 30, 20, 10]);
  assert.deepEqual(claimIssues(f, "day 2 and the changelog is empty. nothing shipped. i'd rather post a blank than a fake ship."), ["calls a day with changes empty"]);
  for (const t of ["quiet day, no changes", "slow day.", "dead day here", "not much happened", "nothing much to say", "nothing to report", "zero changes"]) assert.deepEqual(claimIssues(f, t), ["calls a day with changes empty"], t);
  assert.deepEqual(issues(f, "yesterday i got a new brain, the games now take 10% of the fees, and the site grew a wallet link."), []);
  assert.equal(titleOf(raw), `What changed on 2026-10-11: ${changes.join("; ")}`);
  assert.ok(priorityOf({ event: "day_changes" }) < 4);
});
