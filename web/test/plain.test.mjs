// Feed lines → plain sentences (/live).
import assert from "node:assert/strict";
import { test } from "node:test";
import { sentence } from "../app/_live/plain.ts";

test("known feed lines read as sentences", () => {
  assert.equal(sentence("analyzed 128 swaps"), "Read 128 new trades.");
  assert.equal(sentence("rollback executed"), "A test was stopped and the previous setting restored at once.");
  assert.equal(sentence("module activated"), "A module was promoted to active after its 1 h queue.");
  assert.equal(sentence("proposal #7 queued · SetShadow"), "Queued change #7 (SetShadow). It waits 1 hour in public before it can run.");
  assert.equal(sentence("simulation completed · sim #3 (uncalibrated)"), "Replayed past trades to test the idea: sim #3 (uncalibrated).");
  assert.equal(sentence("buyback 0.32 ETH · burned 1.04M DNA"), "Bought back DNA with 0.32 ETH and burned 1.04M DNA.");
  assert.equal(sentence("main · decision"), "The main agent recorded a decision.");
  assert.equal(sentence("red-team · counter"), "The red team argued against the idea.");
  assert.equal(sentence("experiment T-0002 · queued canary"), "Experiment T-0002 moved to: queued canary.");
  assert.equal(sentence("observed block 1,204 · 37 swaps in 24 h · volatility 4.2%"), "Checked the market at block 1,204: 37 trades in 24 hours, volatility 4.2%.");
  assert.equal(sentence("pulse · quiet market, no change."), "Update: quiet market, no change.");
});

test("unknown lines keep their words", () => {
  assert.equal(sentence("idea round 3 report published"), "Idea round 3 report published.");
  assert.equal(sentence("done!"), "Done!");
});
