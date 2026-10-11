// The 15-minute loop: cadence, red-team skip rules, research triggers, replay window, cost at 96 cycles/day, and the
// long-lived anvil fork (reuse at the same block, anvil_reset to a new one; skipped without `anvil` on PATH).
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { test } from "node:test";
import { createPublicClient, http } from "viem";
import { LLM } from "../src/config.ts";
import { periodStart } from "../src/jobs.ts";
import { overCap, parseAnthropic, parseXai, partition } from "../src/llm.ts";
import { briefOf, candidateHash, deltasOf, flatRevenue, killLookback, paramsFree, redTeamPlan, regimeOf, researchTrigger, reuseSafety } from "../src/loop.ts";
import { LEAK_STALE_BLOCKS, leakageFor } from "../src/clones.ts";
import type { Paired, Stats } from "../src/observe.ts";
import { LIMITS, TIMING } from "../src/policy.ts";
import { closeFork, forkAt, forkStats, replaySet } from "../src/sim.ts";

const MIN = 60_000;
const H = 3600_000;

test("cadence: 96 distinct 15-min periods a day; every instant inside a period maps to the same dedupe key", () => {
  const day = Date.UTC(2026, 9, 7);
  const starts = new Set<number>();
  for (let t = day; t < day + 86_400_000; t += MIN) starts.add(periodStart(t, 15 * MIN).getTime());
  assert.equal(starts.size, 96);
  assert.equal(periodStart(day + 14 * MIN + 59_999, 15 * MIN).getTime(), day);
  assert.equal(periodStart(day + 15 * MIN, 15 * MIN).getTime(), day + 15 * MIN);
  // observe every 5 min: 288 periods; the record itself is per finalized block (observe.ts)
  const obs = new Set<number>();
  for (let t = day; t < day + 86_400_000; t += MIN) obs.add(periodStart(t, 5 * MIN).getTime());
  assert.equal(obs.size, 288);
});

test("red team: skipped on failed gates, reused for a known candidate+regime for ≤ 24 h, capped per day, else run", () => {
  const now = Date.UTC(2026, 9, 8);
  const seen = [{ hash: "a", pass: true, at: now - H }, { hash: "b", pass: false, at: now - H }, { hash: "old", pass: false, at: now - 24 * H }];
  assert.equal(redTeamPlan(["retention 80% < 90%"], "new", seen, 0, 12, now), "gates");
  assert.equal(redTeamPlan([], "a", seen, 0, 12, now), "reuse-pass");
  assert.equal(redTeamPlan([], "b", seen, 0, 12, now), "reuse-block");
  assert.equal(redTeamPlan([], "old", seen, 0, 12, now), "run"); // a day-old verdict is not reused: red-team again
  assert.equal(redTeamPlan([], "a", seen, 0, 12, now + 23 * H), "run");
  assert.equal(redTeamPlan([], "a", [{ hash: "a", pass: true } as never], 0, 12, now), "run"); // pre-TTL state: expired
  assert.equal(redTeamPlan([], "new", seen, LIMITS.redteamPerDay, LIMITS.redteamPerDay, now), "limit");
  assert.equal(redTeamPlan([], "new", seen, LIMITS.redteamPerDay - 1, LIMITS.redteamPerDay, now), "run");
  // "materially different" = plate, vector or regime bucket changed
  const r = regimeOf({ realizedVolPct: 3, swapsPerDay: 100 });
  assert.equal(candidateHash("0xAB", [20_000, 0, 23_000], r), candidateHash("0xab", [20_000, 0, 23_000], regimeOf({ realizedVolPct: 3.4, swapsPerDay: 110 })));
  assert.notEqual(candidateHash("0xab", [20_000, 0, 23_000], r), candidateHash("0xab", [20_500, 0, 23_000], r));
  assert.notEqual(candidateHash("0xab", [20_000, 0, 23_000], r), candidateHash("0xab", [20_000, 0, 23_000], regimeOf({ realizedVolPct: 9, swapsPerDay: 100 })));
});

test("research: only on a trigger, never more than hourly", () => {
  const cur = { vol: 2, mentions: 5, rounds: 1 };
  const last = { at: 0, ...cur };
  assert.equal(researchTrigger(0, undefined, cur), "no research yet");
  assert.equal(researchTrigger(30 * MIN, last, { ...cur, vol: 4 }), null); // < 1 h: nothing, whatever moved
  assert.equal(researchTrigger(H, last, cur), null); // nothing moved
  assert.equal(researchTrigger(H, last, { ...cur, vol: 3 }), "the volatility regime changed");
  assert.equal(researchTrigger(H, last, { ...cur, mentions: 6 }), "new X mentions");
  assert.equal(researchTrigger(H, last, { ...cur, rounds: 2 }), "an idea round closed");
  assert.equal(TIMING.researchEveryMs, 24 * H, "deep research daily by default");
  assert.equal(researchTrigger(TIMING.researchEveryMs, last, cur), "the last research is 24 h old");
});

test("replay set: the swaps since the last sim + a fixed recent window, newest max kept", () => {
  const s = Array.from({ length: 300 }, (_, i) => ({ block: 1000 + i }) as Paired);
  assert.deepEqual(replaySet(s, undefined, 50, 200).map((x) => x.block), s.slice(-50).map((x) => x.block));
  assert.equal(replaySet(s, 1199, 50, 200).length, 100); // 100 new swaps ⊇ the window
  assert.equal(replaySet(s, 1279, 50, 200).length, 50); // 20 new ⊂ the window
  assert.equal(replaySet(s, 999, 50, 200).length, 200); // everything new: capped
  assert.equal(replaySet(s.slice(0, 10), 999, 50, 200).length, 10);
});

test("fork safety reuse: same candidate + regime on a fork younger than SIM_REUSE_BLOCKS, else a fresh replay", () => {
  const safety = { replayed: 50, candidateReverts: 0, moduleFailed: 0, breakerFailCount: 0, maxGasDelta: 900, clamped: 0 };
  const prev = { hash: "h1", block: 1000, safety, sim: "sim #4" };
  assert.equal(reuseSafety(prev, "h1", 1299, 300), prev);
  assert.equal(reuseSafety(prev, "h1", 1300, 300), undefined); // ≥ 1 h of blocks old
  assert.equal(reuseSafety(prev, "h2", 1001, 300), undefined); // another candidate or regime
  assert.equal(reuseSafety(prev, "h1", 1001, 0), undefined); // SIM_REUSE_BLOCKS=0: always replay
  assert.equal(reuseSafety(undefined, "h1", 1001, 300), undefined);
});

test("brief + deltas: compact numbers per cycle, change since the last one", () => {
  const st = { feeSwaps: 40, swapsPerDay: 40, volumeEth: 12.5, projectEth: 0.25, realizedVolPct: 1.2, meanPips: 20_000, atCapShare: 0.05, moduleFailed: 0, shadowSamples: 3 } as Stats;
  const a = briefOf(st, 100);
  const b = briefOf({ ...st, feeSwaps: 43, projectEth: 0.27 }, 132);
  assert.equal(a.atCapPct, 5);
  assert.equal(deltasOf(undefined, a), null);
  assert.deepEqual([deltasOf(a, b)!.feeSwaps, deltasOf(a, b)!.projectEth, deltasOf(a, b)!.block], [3, 0.02, 32]);
  // leakage: the copies' share of DNA volume, from a leakage record at most LEAK_STALE_BLOCKS old; unknown stays null
  const lk = { fromBlock: 0, toBlock: 120, canonicalDna: "3", cloneDna: "1", pct: 25, byClone: [] };
  assert.equal(leakageFor(lk, 132), 25);
  assert.equal(leakageFor(lk, 120 + LEAK_STALE_BLOCKS + 1), null);
  assert.equal(leakageFor(undefined, 132), null);
  const c = briefOf(st, 140, 31.5);
  assert.equal(a.leakagePct, null);
  assert.equal(deltasOf(briefOf(st, 132, 25), c)!.leakagePct, 6.5);
  assert.equal(deltasOf(a, c)!.leakagePct, null);
  assert.equal(deltasOf({ ...a, leakagePct: undefined } as never, c)!.leakagePct, null, "a brief saved before the field existed");
});

test("params epoch: a plate takes a SetParams queued now only if its epoch has passed by execution time", () => {
  const t = { minDelay: 3600, paramsEpoch: 3600 }; // the 1 h registry
  assert.equal(paramsFree(1000, 1000, t), true); // set just now: free again when the op becomes executable
  assert.equal(paramsFree(1000, 1000, { minDelay: 3600, paramsEpoch: 86_400 }), false); // the 24 h registry
  assert.equal(paramsFree(0, 82_800, { minDelay: 3600, paramsEpoch: 86_400 }), true);
});

test("kill look-back: 1 h or one full canary period + window, whichever is longer", () => {
  assert.equal(killLookback(1, 600, 100), 700); // mainnet schedule: 1 h (300 blocks) alone could hold only a just-opened window
  assert.equal(killLookback(12, 600, 100), 3600);
  assert.equal(killLookback(48, 100, 50), 14_400); // the devchain e2e values
});

test("pre-launch analytic sweep: flat fee revenue vs the hook's 2.2% baseline", () => {
  assert.equal(flatRevenue(22_000, 1), 1);
  assert.ok(flatRevenue(35_000, 0.5) > 1 && flatRevenue(35_000, 2) < flatRevenue(35_000, 0.5));
});

test("cost accounting at 96 cycles/day: cached-input pricing, and the caps hold for the assumed day", () => {
  // grok-4.7: cached tokens are a subset of input_tokens at $0.50/M (docs.x.ai); Anthropic cache reads at $0.20/M (Opus 5.5)
  const x = parseXai({ model: "grok-4.7", output: [], usage: { input_tokens: 100_000, input_tokens_details: { cached_tokens: 40_000 }, output_tokens: 0 } }, "grok-4.7");
  assert.equal(Number(x.costUsd.toFixed(6)), 0.14); // 60K × $2/M + 40K × $0.50/M (under the 200K long-prompt rate)
  const a = parseAnthropic({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [], usage: { input_tokens: 100_000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 1_000_000, output_tokens: 0 } }, "claude-opus-5-5");
  assert.equal(Number(a.costUsd.toFixed(6)), 1.1); // $0.40 + $0.50 write + $0.20 read
  // the docs/CAPACITY.md "busy" day: every cycle a search (Main on grok-4.7, low effort), 12 Opus red teams (the daily
  // maximum), 24 research calls (the hourly maximum), 2 Fable gates, 96 lessons/notes worth of narration on grok-4.3
  const main = parseXai({ model: "grok-4.7", output: [], usage: { input_tokens: 3000, input_tokens_details: { cached_tokens: 600 }, output_tokens: 2000 } }, "grok-4.7").costUsd;
  const note = parseXai({ model: "grok-4.3", output: [], usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 400 }, output_tokens: 600 } }, "grok-4.3").costUsd;
  const opus = parseAnthropic({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [], usage: { input_tokens: 3000, output_tokens: 8000 } }, "claude-opus-5-5").costUsd;
  const fable = parseAnthropic({ model: "claude-fable-5-1", stop_reason: "end_turn", content: [], usage: { input_tokens: 4000, output_tokens: 8000 } }, "claude-fable-5-1").costUsd;
  const research = parseXai({ model: "grok-4.7", output: [], usage: { input_tokens: 20_000, output_tokens: 3000 }, __toolTurns: 2 }, "grok-4.7").costUsd;
  const spent = { total: 0, by: {} as Record<string, number> };
  const charge = (budget: string, usd: number) => {
    assert.equal(overCap(spent, budget, usd), null, `${budget} over its cap at $${spent.total.toFixed(2)}`);
    spent.by[budget] = (spent.by[budget] ?? 0) + usd;
    spent.total += usd;
  };
  for (let i = 0; i < 96; i++) { charge("rest", main); charge("rest", note); }
  for (let i = 0; i < LIMITS.redteamPerDay; i++) charge("redteam", opus);
  for (let i = 0; i < 2; i++) charge("redteam", fable);
  for (let i = 0; i < 24; i++) charge("research", research);
  assert.ok(spent.total < partition(LLM.dailyCapUsd).shared * LLM.alertPct, `busy day $${spent.total.toFixed(2)} stays under the 70% alert of the shared part`);
  assert.deepEqual([Number(main.toFixed(4)), Number(opus.toFixed(3)), Number(research.toFixed(3))], [0.0171, 0.172, 0.158]);
});

test("fork replay RPC: a thrown error (transport, upstream fetch) is retried, never taken as a swap's result", async () => {
  const { retried } = await import("../src/sim.ts");
  let n = 0;
  assert.equal(await retried(async () => { if (++n < 3) throw new Error("ECONNRESET"); return "receipt"; }), "receipt");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(retried(async () => { n++; throw new Error("fork backend: upstream timeout"); }), /upstream timeout/);
  assert.equal(n, 3, "after 3 attempts the replay fails loudly (a 'fork replay failed' gate), it never counts a revert");
});

const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
test("long-lived fork: one anvil per process; same block → reverted to clean; new block → anvil_reset", { skip: hasAnvil ? false : "anvil not on PATH" }, async () => {
  const port = 18_000 + (process.pid % 1000);
  const up = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const upc = createPublicClient({ transport: http(url) });
  try {
    for (let i = 0; ; i++) { try { await upc.getBlockNumber(); break; } catch { if (i > 100) throw new Error("upstream anvil"); await new Promise((r) => setTimeout(r, 100)); } }
    await upc.request({ method: "anvil_mine" as never, params: ["0xa"] as never });
    const who = "0x000000000000000000000000000000000000beef";
    const s0 = { ...forkStats };
    const f1 = await forkAt(url, 3);
    const pid = f1.child.pid;
    assert.equal(await f1.c.getBlockNumber(), 3n);
    await f1.c.request({ method: "anvil_setBalance" as never, params: [who, "0x1"] as never });
    const f2 = await forkAt(url, 3); // same block: the local change is gone
    assert.equal(f2.child.pid, pid);
    assert.equal(await f2.c.getBalance({ address: who }), 0n);
    const f3 = await forkAt(url, 8); // new finalized block: rolled forward in place
    assert.equal(f3.child.pid, pid);
    assert.equal(await f3.c.getBlockNumber(), 8n);
    assert.deepEqual([forkStats.spawns - s0.spawns, forkStats.reuses - s0.reuses, forkStats.resets - s0.resets], [1, 1, 1]);
    // a clean snapshot that no longer reverts (evm_revert ≠ true): never reuse an unknown state, re-fork instead
    f3.clean = "0xdead";
    const f4 = await forkAt(url, 8);
    assert.notEqual(f4.child.pid, pid);
    assert.equal(await f4.c.getBlockNumber(), 8n);
    assert.equal(forkStats.spawns - s0.spawns, 2);

    // the replay's two passes (sim.ts forkReplay) must run in identical blocks at identical timestamps: pinned
    // timestamps are reusable after reverting to the pre-baseline snapshot, and the baseline's burned block lines its
    // swaps up with the candidate's (whose first block is the setRoute tx)
    const rpc = (method: string, params: unknown[] = []) => f4.c.request({ method: method as never, params: params as never }) as Promise<unknown>;
    const t0 = Number((await f4.c.getBlock()).timestamp) + 1;
    const pass = async (first: () => Promise<unknown>) => {
      const seen: [bigint, bigint][] = [];
      await rpc("evm_setNextBlockTimestamp", [`0x${t0.toString(16)}`]);
      await first();
      for (let i = 0; i < 3; i++) {
        await rpc("evm_setNextBlockTimestamp", [`0x${(t0 + 1 + i).toString(16)}`]);
        await rpc("anvil_mine", ["0x1"]); // stands in for a swap tx (one per block, automine)
        const b = await f4.c.getBlock();
        seen.push([b.number, b.timestamp]);
      }
      return seen;
    };
    const snap = await rpc("evm_snapshot");
    await new Promise((r) => setTimeout(r, 1100)); // wall clock moves on between the passes, as in a real replay
    const base = await pass(() => rpc("anvil_mine", ["0x1"]));
    assert.equal(await rpc("evm_revert", [snap]), true);
    const cand = await pass(() => rpc("anvil_setBalance", [who, "0x2"]).then(() => rpc("anvil_mine", ["0x1"])));
    assert.deepEqual(cand, base);
  } finally {
    await closeFork();
    up.kill("SIGKILL");
  }
});
