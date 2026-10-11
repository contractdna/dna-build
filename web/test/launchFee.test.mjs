// The site's fee figures use the hook's own constants and formula: pinned to contracts/src/DNAHook.sol.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { baselineAt, FEE, FEE_LINE, LAUNCH_FEE, pct, PLATFORM_NOTE, PROJECT_FEE_CAP } from "../app/_data/launchFee.ts";

test("launch fee: the hook's constants, and its formula at 0 / 30 min / 59:59 / 1 h", () => {
  const sol = readFileSync(new URL("../../contracts/src/DNAHook.sol", import.meta.url), "utf8");
  const num = (name) => Number(new RegExp(`${name} = ([0-9_]+);`).exec(sol)[1].replaceAll("_", ""));
  assert.equal(LAUNCH_FEE.launch, num("LAUNCH_PROJECT_FEE"), "same launch fee as the hook (a flat-2% switch there needs this too)");
  assert.equal(LAUNCH_FEE.baseline, num("BASELINE_PROJECT_FEE"));
  assert.equal(LAUNCH_FEE.platform, num("PLATFORM_FEE"));
  assert.equal(PROJECT_FEE_CAP, num("MAX_PROJECT_FEE"));
  const total = (p) => pct(p + LAUNCH_FEE.platform).replace(/0%$/, "%");
  assert.ok(FEE_LINE.includes(`= ${total(LAUNCH_FEE.baseline)}`) && FEE_LINE.includes(`${total(LAUNCH_FEE.launch)} for the first hour`), "the sentence is the constants");
  assert.match(sol, /LAUNCH_DECAY = 1 hours;/);
  assert.equal(LAUNCH_FEE.decayS, 3600);
  assert.deepEqual([0, 1800, 3599, 3600, 99_999].map(baselineAt), [30_000, 26_000, 22_002, 22_000, 22_000]);
  assert.equal(baselineAt(-5), 30_000, "clock skew before the launch block: the opening fee");
  assert.deepEqual([pct(30_000), pct(26_000), pct(22_000)], ["3.00%", "2.60%", "2.20%"]);
});

test("copy figures: DNA's fee, Programmable's on top, the total", () => {
  assert.deepEqual(FEE, { ours: "2.2%", oursLaunch: "3%", platform: "0.30%", total: "2.5%", totalLaunch: "3.3%", cap: "5%", capAllIn: "5.3%" });
  assert.equal(PLATFORM_NOTE, "+0.30% Programmable launchpad fee (not ours)");
  assert.equal(FEE_LINE, "2.2% + Programmable's 0.30% = 2.5%; 3.3% for the first hour, sliding to 2.5%");
});
