// Unit tests for the pure chain-row mapping (node --test; Node 24 strips the .ts types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { activeModules, compact, elogToFeed, eth, fmtParam, OPS, SEQ_STAGES, STATUS, toFeed, toSeqEvent } from "../app/_data/chain.ts";

test("engine log records → feed lines (ids e:<seq>, JSON only)", () => {
  const r = (kind, doc) => elogToFeed({ seq: 9, at: "2026-10-12T11:06:33.000Z", kind, ref: null, doc });
  assert.deepEqual(r("step", { kind: "hypothesis", agent: "Main" }), { id: "e:9", at: "2026-10-12T11:06:33.000Z", kind: "testing" });
  assert.equal(r("step", { kind: "counter", agent: "Red-team" }).text, "red-team · counter");
  assert.equal(r("step", { kind: "counter", agent: "Red-team" }).tone, "alert");
  assert.equal(r("sim", { id: "sim #3" }).text, "simulation completed · sim #3 (uncalibrated)");
  assert.equal(r("memory", { id: 4, decision: "rejected" }).kind, "rejected");
  assert.equal(r("memory", { id: 4, decision: "accepted" }).tone, "good");
  assert.equal(r("journal", { day: 3 }).text, "journal day 3 published");
  assert.equal(r("journal", { day: 3, pulse: true, summary: "Today so far (14:00 UTC): 56 cycles" }).text, "pulse · Today so far (14:00 UTC): 56 cycles");
  assert.equal(r("observe", { block: 26135810, feeSwaps: 41, realizedVolPct: 1.2 }).text, "observed block 26,135,810 · 41 swaps in 24 h · volatility 1.2%");
  assert.equal(r("plate", { event: "stage", run: "T-0002", to: "queued_canary" }).text, "experiment T-0002 · queued canary");
  assert.equal(r("anchor", { mode: "dry_run" }), null);
  assert.equal(r("llm", {}), null); // cost/model records stay off the feed
});

const row = (event, args) => ({ block: 46, logIndex: 1, at: "2026-10-12T11:06:33.000Z", event, args });

test("toFeed maps lifecycle and vault events; ids are block:logIndex", () => {
  assert.deepEqual(toFeed(row("StatusChanged", { to: "4" })), { id: "46:1", at: "2026-10-12T11:06:33.000Z", block: 46, kind: "activated" });
  assert.equal(toFeed(row("StatusChanged", { to: 2 })).kind, "testing");
  assert.equal(toFeed(row("StatusChanged", { to: 3 })).kind, "canary");
  assert.equal(toFeed(row("StatusChanged", { to: 1 })), null); // Proposed: not a feed moment
  assert.equal(toFeed(row("StatusChanged", { to: 6 })), null); // RolledBack has its own event
  assert.equal(toFeed(row("RolledBack", {})).kind, "rollback");
  assert.deepEqual(toFeed(row("Queued", { id: "12", op: 7 })), { id: "46:1", at: "2026-10-12T11:06:33.000Z", block: 46, kind: "chain", text: "proposal #12 queued · SetLevel", tone: "plain" });
  assert.equal(toFeed(row("Cancelled", { id: "12" })).tone, "reject");
  assert.equal(toFeed(row("Buyback", { spent: "8000000000000000", burned: "1500000000000000000000000" })).text, "buyback 0.008 ETH · burned 1.50M DNA");
  assert.equal(toFeed(row("LevelSet", { from: 5, to: 4 })).tone, "alert");
  assert.equal(toFeed(row("Swap", {})), null); // swaps come from the head tier only
  assert.equal(toFeed(row("Queued", { id: "13", op: 9 })).text, "proposal #13 queued · ApproveCodehash");
  assert.equal(toFeed(row("Queued", { id: "14", op: "10" })).text, "proposal #14 queued · RevokeCodehash");
  assert.equal(toFeed(row("CanaryEnded", { module: "0xd93560DeC9296f408Da11A0Ff81ef0A66af2CdAb" })).text, "canary ended · 0xd935…CdAb back to proposed");
});

test("registry enums: op order matches ModuleRegistry.Op; Retired reads as proposed (plate reuse)", () => {
  assert.equal(OPS.length, 11);
  assert.deepEqual([OPS[9], OPS[10]], ["ApproveCodehash", "RevokeCodehash"]);
  assert.equal(STATUS[5], "proposed");
  assert.equal(STATUS[6], "rolled_back");
});

test("amount formatting", () => {
  assert.equal(eth("394000000000000000"), "0.394");
  assert.equal(eth("200000000000000"), "0.00020"); // dust stays visible
  assert.equal(eth("0"), "0.000");
  assert.equal(compact("116795906646381824821670237"), "116.80M");
  assert.equal(fmtParam("0x" + (20000).toString(16).padStart(64, "0"), "pips"), "2.00%");
  assert.equal(fmtParam("0x" + (13000).toString(16).padStart(64, "0"), "x1e4"), "1.3×");
  assert.equal(fmtParam(undefined), "—");
});

test("active modules: baseline counts as one", () => {
  const Z = "0x0000000000000000000000000000000000000000", A = "0xd93560DeC9296f408Da11A0Ff81ef0A66af2CdAb";
  assert.equal(activeModules({ active: Z }, { module: Z }), 1);
  assert.equal(activeModules({ active: A }, { module: Z }), 1);
  assert.equal(activeModules({ active: A }, { module: A }), 2);
  assert.equal(activeModules(undefined, undefined), 1);
});

test("Sequencer feed: only its announcements, with the build and the record they rest on", () => {
  const at = "2026-10-09T10:00:00.000Z";
  assert.deepEqual(toSeqEvent({ type: "seq_pr", title: "line", at, facts: { event: "seq_pr", build: "b7", record: "41", round: 1 } }),
    { at, stage: "seq_pr", build: "b7", text: "line", record: "41" });
  assert.equal(toSeqEvent({ type: "seq_pr", title: "line", at, facts: { build: "b7", record: "gates:41" } }).record, null, "only a log seq links publicly");
  assert.deepEqual(toSeqEvent({ type: "seq_nothing_today", title: "none", at, facts: { day: "2026-10-09", tried: 0 } }),
    { at, stage: "seq_nothing_today", build: null, text: "none", record: null });
  assert.equal(toSeqEvent({ type: "jackpot_drawn", title: "x", at, facts: { build: "b7" } }), null);
  assert.equal(toSeqEvent({ type: "seq_shipped", title: "x", at }).build, null, "an old record without facts still maps");
  assert.deepEqual(toSeqEvent({ type: "seq_started", title: "start", at, facts: { build: "b7", record: "40" } }), { at, stage: "seq_started", build: "b7", text: "start", record: "40" }, "round 1 is the build's start");
  assert.equal(toSeqEvent({ type: "seq_killed", title: "x", at, facts: { build: "b7", record: "44" } }).stage, "seq_killed");
  assert.equal(SEQ_STAGES.length, 9);
});
