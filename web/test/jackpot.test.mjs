// /play's jackpot: which windows are drawn (engine/src/jackpot.ts paramsOf) and the prize GamePot.requestDraw pays.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { drawable, MIN_PRIZE, PRIZE_CAP, prizeOf, SUB_MIN, topUpOf } from "../app/play/jackpot.ts";

const eth = (x) => BigInt(Math.round(x * 1e6)) * BigInt(1e12);
const START = 1_791_821_711; // 2026-10-12 16:15:11 UTC
const rec = { _seq: "589" };

test("drawn: only when the window's params anchor (for its newest params record) was mined before the window started", () => {
  assert.equal(drawable(rec, { paramsSeq: "589", status: "mined", blockTime: START - 3600 }, START), true);
  assert.equal(drawable(rec, { paramsSeq: "589", status: "mined", blockTime: START }, START), false, "at the start is too late");
  assert.equal(drawable(rec, { paramsSeq: "589", status: "mined", blockTime: START + 60 }, START), false);
  assert.equal(drawable(rec, { paramsSeq: "589", status: "pending", blockTime: null }, START), false);
  assert.equal(drawable(rec, { paramsSeq: "588", status: "mined", blockTime: START - 3600 }, START), false, "the anchor is of an older record");
  assert.equal(drawable(undefined, undefined, START), false, "window 1: nothing was announced before initialize opened it");
  assert.equal(drawable(rec, undefined, START), false);
  assert.equal(drawable(rec, { paramsSeq: "589", status: "dry_run", blockTime: null }, START), true, "a dry run rehearses the draw");
});

test("prize: min(pot − top-up, 3 ETH); the draw waits under 0.25 ETH + top-up", () => {
  assert.equal(SUB_MIN, BigInt(200e9) * BigInt(550_000) * BigInt(124) / BigInt(100), "GamePot.SUB_MIN");
  assert.equal(topUpOf(), SUB_MIN, "unknown subscription balance: the whole SUB_MIN");
  assert.equal(topUpOf(BigInt(0)), SUB_MIN, "the first draw: the subscription is empty");
  assert.equal(topUpOf(eth(0.1)), SUB_MIN - eth(0.1));
  assert.equal(topUpOf(eth(0.2)), BigInt(0));
  const first = topUpOf(BigInt(0));
  assert.equal(prizeOf(eth(0.3864), first).gate, eth(0.3864));
  assert.equal(prizeOf(eth(0.3864), first).prize, MIN_PRIZE, "exactly at the gate pays 0.25 ETH");
  assert.equal(prizeOf(eth(0.3863), first).prize, null, "under the gate the draw waits");
  assert.equal(prizeOf(eth(0.3), first).prize, null, "0.3 ETH is over 0.25 but under 0.25 + top-up");
  assert.equal(prizeOf(eth(1), first).prize, eth(1) - SUB_MIN);
  assert.equal(prizeOf(eth(15), first).prize, PRIZE_CAP);
  assert.equal(prizeOf(eth(3.1), first).prize, eth(3.1) - SUB_MIN, "under the cap after the top-up");
  assert.equal(prizeOf(eth(0.25), BigInt(0)).prize, MIN_PRIZE, "a funded subscription: no top-up");
});

test("copy: no 'up to' prize from the raw pot, no 3-day timing, the skipped-window line", () => {
  const page = readFileSync(new URL("../app/play/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /prize up to \$\{j\.prizeEth\}/);
  assert.doesNotMatch(page, /12 hours to 3 days/);
  assert.match(page, /This window isn&apos;t drawn \(its rules were not posted before it opened\)\. Its pot carries over\./);
  assert.match(page, /a draw needs at least 0\.25 ETH after the Chainlink fee/);
  const docs = readFileSync(new URL("../app/docs/content.ts", import.meta.url), "utf8");
  assert.doesNotMatch(docs, /12 h to 3 d|12 hours to 3 days|sets it within 12 h–3 d/);
});
