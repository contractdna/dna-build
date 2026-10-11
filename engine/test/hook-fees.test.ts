// The engine's copy of DNAHook's fee constants (src/hook-fees.ts) must be the contract's: one change, caught here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HOOK_FEES, pctOf } from "../src/hook-fees.ts";
import { flatRevenue } from "../src/loop.ts";

test("hook fees: the engine's constants are DNAHook's (2.2% + 0.30% = 2.5%; 3% at launch over 1 h)", () => {
  const sol = readFileSync(new URL("../../contracts/src/DNAHook.sol", import.meta.url), "utf8");
  const num = (name: string) => Number(new RegExp(`${name} = ([0-9_]+);`).exec(sol)![1].replaceAll("_", ""));
  assert.equal(HOOK_FEES.baseline, num("BASELINE_PROJECT_FEE"));
  assert.equal(HOOK_FEES.platform, num("PLATFORM_FEE"));
  assert.equal(HOOK_FEES.launch, num("LAUNCH_PROJECT_FEE"));
  assert.equal(HOOK_FEES.max, num("MAX_PROJECT_FEE"));
  assert.match(sol, /LAUNCH_DECAY = 1 hours;/);
  assert.equal(pctOf(HOOK_FEES.baseline + HOOK_FEES.platform), "2.50%", "what a trader pays after the launch hour");
  assert.equal(pctOf(HOOK_FEES.launch + HOOK_FEES.platform), "3.30%", "at launch");
  assert.equal(flatRevenue(HOOK_FEES.baseline, 1), 1, "the baseline earns 1x itself");
  assert.equal(flatRevenue(25_000, 0.5), Number(((25 / 22) * (28 / 25) ** -0.5).toFixed(3)), "the platform fee is on both totals");
});
