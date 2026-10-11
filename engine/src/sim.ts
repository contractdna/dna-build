// Simulation (labelled "uncalibrated" everywhere it is shown). Two parts:
//  - SAFETY (fork): ONE long-lived anvil fork per engine process, reset to the finalized block (forkAt), evm_snapshot → replay the recorded swaps through the real
//    hook with the current route (baseline) → evm_revert → impersonate the registry, hook.setRoute(candidate as an
//    always-in-window canary) → replay again. Measures reverts the candidate adds, ModuleFailed, the breaker, the gas
//    the module adds per swap, and how often the hook's ±1 pt canary clamp bound the candidate.
//  - REVENUE / VOLUME (analytic, no fork): project fee × volume × (f_new / f_old)^−ε on the total fee (project +
//    0.30% platform), for ε ∈ {0.5, 1, 2}, a published assumption. Replay can't tell how traders would react.
// Needs `anvil` on PATH and an RPC that serves the finalized block's state (SIM_FORK_RPC_URL, default RPC_URL; an
// archive endpoint for anything older than ~128 blocks). Tests fork the local devchain.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { type Address, createPublicClient, encodeAbiParameters, encodeDeployData, encodeFunctionData, type Hex, http, keccak256, maxUint256, parseEventLogs } from "viem";
import * as abi from "./abi.ts";
import { HOOK_FEES } from "./hook-fees.ts";
import { type Paired } from "./observe.ts";
import { GATES, type Vector } from "./policy.ts";

export const HARNESS = `harness ${createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex").slice(0, 12)}`;
const PLATFORM = HOOK_FEES.platform; // DNAHook.PLATFORM_FEE (0.30%, Programmable profile 3.6.0)
const MAX_PROJECT_FEE = 50_000;

/** AdaptiveFee: min(base + mult·volEma/1e4, cap). */
export const adaptive = (v: Vector, volEma: number) => Math.min(v[0] + Math.floor((v[1] * volEma) / 1e4), v[2]);

/** The hook's volEma before each swap, rebuilt from the recorded post-swap ticks (EMA α = 1/8 of |Δtick|·100).
 *  Starts from `ema0` (the hook's observables at the window start; 0 if unknown: the error decays 7/8 per swap). */
export function volEmas(swaps: Paired[], ema0 = 0): number[] {
  const out: number[] = [];
  let ema = ema0;
  for (let i = 0; i < swaps.length; i++) {
    out.push(ema);
    const move = i ? Math.abs(swaps[i].tick - swaps[i - 1].tick) * 100 : 0; // the move into swaps[0] is unknown: 0
    ema = Math.floor((ema * 7 + move) / 8);
  }
  return out;
}

export type Analytic = { baseline: { projectEthPerDay: number; swapsPerDay: number; meanPips: number; atCapShare: number }; candidate: { meanPips: number; atCapShare: number }; elasticity: { eps: number; projectEthPerDay: number; swapRetention: number }[] };

/** Fee-paying swaps over `days`: what the candidate (promoted, unclamped) would have charged and earned. */
export function analytic(swaps: Paired[], v: Vector, days: number, capOld: number, ema0 = 0): Analytic {
  const paid = swaps.filter((s) => s.fee);
  const emas = volEmas(swaps, ema0);
  const idx = new Map(swaps.map((s, i) => [s, i]));
  const rows = paid.map((s) => ({ s, pNew: adaptive(v, emas[idx.get(s)!]), pOld: s.fee!.pips }));
  const r6 = (x: number) => Number(x.toFixed(6));
  const n = rows.length || 1;
  const baseRev = paid.reduce((t, s) => t + Number(s.fee!.project) / 1e18, 0);
  return {
    baseline: { projectEthPerDay: r6(baseRev / days), swapsPerDay: r6(paid.length / days), meanPips: Math.round(rows.reduce((t, r) => t + r.pOld, 0) / n), atCapShare: r6(rows.filter((r) => r.pOld >= capOld).length / n) },
    candidate: { meanPips: Math.round(rows.reduce((t, r) => t + r.pNew, 0) / n), atCapShare: r6(rows.filter((r) => r.pNew >= v[2]).length / n) },
    elasticity: GATES.eps.map((eps) => {
      let rev = 0, kept = 0;
      for (const r of rows) {
        const w = ((r.pNew + PLATFORM) / (r.pOld + PLATFORM)) ** -eps; // volume kept at the new total fee
        rev += (Number(r.s.fee!.gross) / 1e18) * (r.pNew / 1e6) * w;
        kept += w;
      }
      return { eps, projectEthPerDay: r6(rev / days), swapRetention: r6(rows.length ? kept / rows.length : 1) };
    }),
  };
}

export type Safety = { replayed: number; candidateReverts: number; moduleFailed: number; breakerFailCount: number; maxGasDelta: number; clamped: number };

/** Deterministic candidate gates. Returns the failed gates ([] = pass). */
export function candidateGates(a: Analytic, safety: Safety | null, swaps: number, g = GATES): string[] {
  const out: string[] = [];
  if (swaps < g.minSwaps) out.push(`only ${swaps} recorded swaps (< ${g.minSwaps})`);
  const e = a.elasticity.find((x) => x.eps === g.gateEps)!;
  if (e.projectEthPerDay < a.baseline.projectEthPerDay * (1 + g.minRevenueLift)) out.push(`project ETH/day at ε=${g.gateEps} ${e.projectEthPerDay} < baseline ${a.baseline.projectEthPerDay}`);
  if (e.swapRetention < g.minRetention) out.push(`swap retention at ε=${g.gateEps} ${(e.swapRetention * 100).toFixed(1)}% < ${g.minRetention * 100}%`);
  if (a.candidate.atCapShare > g.maxCapShare) out.push(`time at cap ${(a.candidate.atCapShare * 100).toFixed(1)}% > ${g.maxCapShare * 100}%`);
  if (!safety) out.push("no fork replay (safety unmeasured)");
  else {
    if (safety.candidateReverts > 0) out.push(`${safety.candidateReverts} replayed swaps revert only with the candidate`);
    if (safety.moduleFailed > 0) out.push(`${safety.moduleFailed} ModuleFailed in replay`);
    if (safety.breakerFailCount > 0) out.push(`breaker failCount ${safety.breakerFailCount} after replay`);
    if (safety.maxGasDelta > g.maxGasDelta) out.push(`module adds ${safety.maxGasDelta} gas per swap (> ${g.maxGasDelta})`);
  }
  return out;
}

// ---------------------------------------------------------------- fork replay

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }).on("error", rej);
});
const MIN_SQRT = 4295128740n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
const TRADER = "0x000000000000000000000000000000000000c0de" as Address;

type Fork = { url: string; block: number; hook: Address; registry: Address; token: Address; poolManager: Address };

/** Swaps to replay: every swap after the last sim's fork block plus a fixed recent window, the newest `max` kept
 *  (instead of the newest SIM_MAX_SWAPS every cycle: 96 sims a day replay mostly the same flow). */
export function replaySet(swaps: Paired[], sinceBlock: number | undefined, window: number, max: number): Paired[] {
  const pick = new Set([...swaps.slice(-window), ...(sinceBlock === undefined ? [] : swaps.filter((s) => s.block > sinceBlock))]);
  return swaps.filter((s) => pick.has(s)).slice(-max);
}

// ---------------------------------------------------------------- the long-lived fork

type Live = { child: ChildProcess; exited: Promise<unknown>; url: string; block: number; clean: Hex; c: ReturnType<typeof createPublicClient> };
let live: Live | undefined;
/** Process-lifetime counters (tests + /health): one spawn, then a reset per new finalized block. */
export const forkStats = { spawns: 0, resets: 0, reuses: 0 };
const call = (l: Live, method: string, params: unknown[] = []) => l.c.request({ method: method as never, params: params as never }) as Promise<unknown>;

/** ONE anvil fork per engine process, rolled forward: spawned once, then `anvil_reset` to each new finalized block
 *  (same block: revert to the clean snapshot taken right after the reset). Saves the spawn and keeps the process warm;
 *  anvil still fetches the new block's state lazily, so the upstream cost per sim is the replay's state reads. */
export async function forkAt(url: string, block: number): Promise<Live> {
  if (live && (live.child.exitCode !== null || live.url !== url)) await closeFork();
  if (!live) {
    const port = await freePort();
    const child = spawn("anvil", ["--fork-url", url, "--fork-block-number", String(block), "--port", String(port), "--auto-impersonate", "--silent", "--no-storage-caching"], { stdio: "ignore" });
    const l: Live = { child, exited: new Promise((r) => child.once("exit", r)), url, block, clean: "0x", c: createPublicClient({ cacheTime: 0, transport: http(`http://127.0.0.1:${port}`, { retryCount: 0 }) }) };
    live = l;
    try {
      for (let i = 0; ; i++) {
        try { await l.c.getBlockNumber(); break; } catch { if (i > 150 || child.exitCode !== null) throw new Error("anvil fork did not start"); await new Promise((r) => setTimeout(r, 200)); }
      }
    } catch (e) { await closeFork(); throw e; }
    forkStats.spawns++;
  } else if (live.block !== block) {
    await call(live, "anvil_reset", [{ forking: { jsonRpcUrl: url, blockNumber: block } }]);
    live.block = block;
    forkStats.resets++;
  } else {
    // same block: drop the last run's local txs. A revert that does not return true leaves an unknown state: re-fork
    if ((await call(live, "evm_revert", [live.clean]).catch(() => false)) !== true) {
      await closeFork();
      return forkAt(url, block);
    }
    forkStats.reuses++;
  }
  live.clean = (await call(live, "evm_snapshot")) as Hex;
  return live;
}

export async function closeFork() {
  const l = live;
  live = undefined;
  if (!l) return;
  l.child.kill("SIGKILL");
  await l.exited;
}
process.once("exit", () => live?.child.kill("SIGKILL"));

/** A fork RPC call, retried on a thrown error (transport, upstream fetch): `tries` attempts, 100 ms × n apart. */
export async function retried<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (e) {
      if (n >= tries) throw e;
      await new Promise((r) => setTimeout(r, 100 * n));
    }
  }
}

/** Baseline replay, revert, candidate replay on the long-lived fork (forkAt). A failed run discards the fork. */
export async function forkReplay(f: Fork, plate: Address, v: Vector, swaps: Paired[]): Promise<Safety> {
  const l = await forkAt(f.url, f.block);
  try {
    const c = l.c;
    const rpc = (method: string, params: unknown[] = []) => call(l, method, params);
    // anvil mines a reverting tx (receipt status "reverted"): only a receipt is a swap's result. A thrown error is the
    // fork or its transport (an upstream state fetch, a dropped connection: retryCount 0) and is retried, never counted
    // as a revert.
    const send = async (from: Address, to: Address | null, data: Hex, value = 0n) => {
      // explicit gas: anvil skips eth_estimateGas, which would THROW on a reverting swap (and be retried as a transport
      // error) instead of mining it; with it, a revert always surfaces as a receipt with status "reverted"
      const hash = (await retried(() => rpc("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data, value: `0x${value.toString(16)}`, gas: "0x1e8480" }]))) as Hex;
      return retried(() => c.waitForTransactionReceipt({ hash, pollingInterval: 20 }));
    };
    const buys = swaps.filter((s) => s.buy).reduce((t, s) => t + s.ethWei, 0n);
    await rpc("anvil_setBalance", [TRADER, `0x${(buys + 10n ** 21n).toString(16)}`]);
    await rpc("anvil_setBalance", [f.registry, "0x56bc75e2d63100000"]);
    // OZ ERC20 (non-upgradeable): _balances is storage slot 0
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [TRADER, 0n]));
    await rpc("anvil_setStorageAt", [f.token, slot, `0x${(10n ** 27n).toString(16).padStart(64, "0")}`]);
    const router = (await send(TRADER, null, encodeDeployData({ abi: [{ type: "constructor", inputs: [{ type: "address" }], stateMutability: "nonpayable" }], bytecode: abi.poolSwapTestBytecode as Hex, args: [f.poolManager] }))).contractAddress!;
    await send(TRADER, f.token, encodeFunctionData({ abi: abi.tokenAbi, functionName: "approve", args: [router, maxUint256] }));
    const key = await c.readContract({ address: f.hook, abi: abi.hookAbi, functionName: "poolKey" });
    const route = await c.readContract({ address: f.hook, abi: abi.hookAbi, functionName: "route" });
    const events = [...abi.hookAbi].filter((x) => x.type === "event");

    // both passes run in the SAME blocks at the SAME timestamps: the baseline burns the block the candidate's setRoute
    // takes, then swap i lands in block start + 1 + i at t0 + 1 + i in either pass (the hook's canary window, breaker
    // window and anything else block- or time-keyed see identical inputs; only the route differs)
    const t0 = Number((await c.getBlock()).timestamp) + 1;
    const pin = (t: number) => rpc("evm_setNextBlockTimestamp", [`0x${t.toString(16)}`]);
    const replay = async (candidate: boolean, first: () => Promise<unknown>) => {
      const out: { ok: boolean; gas: bigint; failed: number; pips?: number; raw?: number }[] = [];
      await pin(t0);
      await first();
      for (const [i, s] of swaps.entries()) {
        await pin(t0 + 1 + i);
        const amount = s.buy ? s.ethWei : s.tokenWei;
        let raw: number | undefined;
        if (candidate) {
          const [, volEma] = await retried(() => c.readContract({ address: f.hook, abi: abi.hookAbi, functionName: "observables" }));
          raw = adaptive(v, Number(volEma));
        }
        const data = encodeFunctionData({ abi: abi.poolSwapTestAbi, functionName: "swap", args: [key, { zeroForOne: s.buy, amountSpecified: -amount, sqrtPriceLimitX96: s.buy ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, "0x"] });
        const r = await send(TRADER, router, data, s.buy ? amount : 0n);
        const logs = parseEventLogs({ abi: events, logs: r.logs });
        const fee = logs.find((l) => l.eventName === "FeeTaken") as { args: { pips: number } } | undefined;
        out.push({ ok: r.status === "success", gas: r.gasUsed, failed: logs.filter((l) => l.eventName === "ModuleFailed").length, pips: fee?.args.pips, raw });
      }
      return out;
    };

    const snap = await rpc("evm_snapshot");
    const base = await replay(false, () => rpc("anvil_mine", ["0x1"]));
    // the candidate must start from the baseline's state; anything but true would compare against a dirty fork
    if ((await rpc("evm_revert", [snap])) !== true) throw new Error("evm_revert to the pre-baseline snapshot failed");
    // the candidate as an always-in-window canary: exactly what SetCanary would route, ±1 pt clamp included
    const cand = { ...route, canary: plate, canaryParams: v.map((x) => `0x${x.toString(16).padStart(64, "0")}`).concat([`0x${"0".repeat(64)}`]) as [Hex, Hex, Hex, Hex], canaryStart: 0n, canaryPeriod: 0xffffffff, canaryLen: 0xfffffffe };
    const run = await replay(true, () => send(f.registry, f.hook, encodeFunctionData({ abi: abi.hookAbi, functionName: "setRoute", args: [cand] })));
    const [failCount] = await c.readContract({ address: f.hook, abi: abi.hookAbi, functionName: "breaker" });
    let maxGasDelta = 0;
    for (let i = 0; i < run.length; i++) if (run[i].ok && base[i].ok) maxGasDelta = Math.max(maxGasDelta, Number(run[i].gas - base[i].gas));
    return {
      replayed: swaps.length,
      candidateReverts: run.filter((r, i) => !r.ok && base[i].ok).length,
      moduleFailed: run.reduce((t, r) => t + r.failed, 0),
      breakerFailCount: Number(failCount),
      maxGasDelta,
      clamped: run.filter((r) => r.pips !== undefined && r.raw !== undefined && r.pips !== Math.min(r.raw, MAX_PROJECT_FEE)).length,
    };
  } catch (e) {
    await closeFork();
    throw e;
  }
}
