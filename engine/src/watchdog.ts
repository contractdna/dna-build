// The jackpot list watchdog's loop, run by scripts/watchdog.ts (a read-only service OUTSIDE the
// enclave, no keys). Each tick finds new ListPosted events (chunked getLogs) and never waits on a rebuild: every posted
// list is verified in the background (src/draw-verify.ts, through every provider). A mismatch pages the Safe signers at
// once; a list not verified within VERIFY_DEADLINE of its post pages "not verified" (the rebuild keeps running and a
// later success says so); pages repeat every REPEAT until the list is no longer pending (cancelled, replaced, drawn)
// or its draw was requested. With a 1 h veto (GamePot.LIST_DELAY) this is the critical path.
// Once a window it verified is drawn, the settle is checked too (checkWinners: the 10-winner walk recomputed from the
// verified list and the word, every Winner / WinnerExcluded, isExcluded at the settle block); a mismatch pages once.
// Every RewardQueued is checked against its signed records (src/rewards.ts); a mismatch pages cancelReward(id).
import type { PublicClient } from "viem";
import * as abi from "./abi.ts";
import { checkWinners, type Drawn, drawnLogs, type Fetch, type Posted, postedLists, settledOf, verifyPosted } from "./draw-verify.ts";
import { checkReward, rewardWatch } from "./rewards.ts";
import { type SeqDep, seqWatch } from "./seq-watch.ts";
import type { Dep } from "./ticket-source.ts";
import type { DrawList } from "./tickets.ts";

export const WATCH = { pollMs: 60_000, verifyDeadlineS: 30 * 60, repeatMs: 5 * 60_000, lookbackBlocks: 50_000n /* ≈ 7 days */ };

/** The watchdog's page: to stdout always, and to the signers' group when a bot token and group are set. The Bot API base
 *  is TELEGRAM_API_BASE (as the engine's, src/config.ts TG.api), else Telegram's. Plain text, ≤ 4000 characters; a
 *  failed send is logged, never fatal (the next tick pages again while it matters). */
export function telegramPager(env: Record<string, string | undefined>) {
  const api = env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
  return async (text: string) => {
    console.log(text);
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_GROUP_ID) return;
    try {
      const r = await fetch(`${api}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: Number(env.TELEGRAM_GROUP_ID), text: text.slice(0, 4000) }),
        signal: AbortSignal.timeout(15_000),
      });
      // a refused send (HTTP error or ok:false: a revoked token, a wrong group) is reported, never thrown
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (!r.ok || !b.ok) console.error(`telegram: sendMessage refused: HTTP ${r.status}${b.description ? ` ${b.description}` : ""}`);
    } catch (e) {
      console.error("telegram:", (e as Error).message);
    }
  };
}

/** Engine liveness from outside the enclave (public logs are off, so a crash-loop is otherwise silent): GET the
 *  engine's /health (ENGINE_HEALTH_URL) every pollMs. Down = no HTTP 200 JSON answer for staleMs, or answers whose
 *  lastWatcherBlock has not moved for staleMs (the head watcher is stuck; a 12 s chain never pauses that long), or has
 *  never reported a block for staleMs outside pre-launch (the watcher never started). One
 *  page when it goes down, one when it is back; nothing in between (deduped per outage). The watchdog's boot counts as
 *  a good read, so a watchdog started before the engine pages after staleMs, not at once. */
export const LIVENESS = { pollMs: 60_000, staleMs: 10 * 60_000, timeoutMs: 15_000 };
export function engineLiveness(o: { url: string; page: (text: string) => Promise<void>; fetch?: typeof fetch; now?: () => number; cfg?: typeof LIVENESS }) {
  const f = o.fetch ?? fetch, now = o.now ?? Date.now, cfg = o.cfg ?? LIVENESS;
  let lastOk = now(), lastError = "none yet", mode = "?", prelaunch = false;
  let block: string | null = null, blockAt = now();
  let down: string | null = null;
  const min = (ms: number) => Math.round(ms / 60_000);
  async function tick() {
    try {
      const r = await f(o.url, { signal: AbortSignal.timeout(cfg.timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const h = (await r.json()) as { mode?: string; lastWatcherBlock?: string | null; prelaunch?: boolean };
      const t = now();
      lastOk = t;
      mode = String(h.mode ?? "?");
      prelaunch = h.prelaunch === true;
      if ((h.lastWatcherBlock ?? null) !== block) { block = h.lastWatcherBlock ?? null; blockAt = t; }
    } catch (e) {
      lastError = String((e as Error).message ?? e).slice(0, 200);
    }
    const t = now();
    const failing = t - lastOk > cfg.staleMs;
    const stuck = !failing && t - blockAt > cfg.staleMs && (block !== null || !prelaunch);
    const why = failing ? `no good /health answer for ${min(t - lastOk)} min (last error: ${lastError})`
      : stuck ? (block === null ? `/health answers, but its head watcher never reported a block in ${min(t - blockAt)} min` : `/health answers, but its head watcher has been stuck at block ${block} for ${min(t - blockAt)} min`) : null;
    if (why && !down) {
      down = why;
      const act = failing ? "Public logs are off: check the CVM in the Phala dashboard (status, restarts)." : "The engine is up and its chain reads are failing: check the Alchemy and dRPC keys and balances; restarting the CVM won't fix it.";
      await o.page(`ENGINE DOWN? ${why}. ${act} Until it is back, a signer checks Queued on Etherscan every 30 min: the veto window is 1 h.`);
    } else if (!why && down) {
      down = null;
      await o.page(`Engine back: /health answers (mode ${mode}).`);
    }
  }
  return { tick, health: () => ({ engineDown: down }) };
}

type State = "checking" | "ok" | "bad" | "unverified" | "closed";
type Watch = { posted: Posted; at: number; state: State; lastPage: number; why?: string; running?: Promise<void>; lastError?: string; failures: number; nextTry: number;
  closedBy?: "requested" | "gone" }; // why the loop dropped it: its draw was requested, or it is no longer the pending list

export function createWatchdog(o: {
  clients: PublicClient[]; dep: Dep & SeqDep; page: (text: string) => Promise<void>; logSigner?: string | null; fromBlock?: bigint;
  logBase?: string; releaseHead?: () => Promise<string | null>; // the Sequencer checks: where signed records are read, the site's release head
  verify?: typeof verifyPosted; settled?: typeof settledOf; now?: () => number; cfg?: typeof WATCH; checkReward?: typeof checkReward; fetch?: Fetch;
}) {
  const cs = o.clients, dep = o.dep, cfg = o.cfg ?? WATCH;
  const now = o.now ?? Date.now;
  const verify = o.verify ?? verifyPosted;
  const settled = o.settled ?? settledOf;
  const watches = new Map<string, Watch>();
  const lists = new Map<bigint, DrawList>(); // window → the latest list verified for it, until its draw is checked
  const latest = new Map<bigint, bigint>(); // window → the block of its newest ListPosted (a replaced list never counts)
  // a Drawn waits here until its window's list is verified. Its deadline (VERIFY_DEADLINE) runs only once no rebuild
  // of that window is pending or running; then, still without a list, it pages once and leaves
  const draws: (Drawn & { seen: number })[] = [];
  const running = new Set<Watch>(); // rebuilds in flight, also of watches already closed
  const lateBad = new Set<bigint>(); // windows whose requested list ended bad after closing: already paged MISMATCH
  const rewards = rewardWatch({ clients: cs, dep, page: o.page, logSigner: o.logSigner, fetch: o.fetch, now, cfg, check: o.checkReward });
  let seqFrom: bigint | undefined;
  let seqError: string | undefined;
  const seq = o.logBase ? seqWatch({ client: cs[0], dep, page: o.page, logSigner: o.logSigner, base: o.logBase, fetch: o.fetch, now, releaseHead: o.releaseHead }) : undefined;
  let from = o.fromBlock;
  let lastTick = 0;
  const veto = (w: Watch) => `Safe: cancelList(${w.posted.window}) on GamePot ${dep.gamePot} before ${new Date(Number(w.posted.eta) * 1000).toISOString()}.`;

  /** No longer the pending list (cancelled, replaced, drawn), or its draw was requested. */
  async function closed(w: Watch, head: bigint): Promise<{ why: string; by: "requested" | "gone" } | null> {
    const d = (await cs[0].readContract({ address: dep.gamePot, abi: abi.gamePotAbi, functionName: "draw", blockNumber: head })) as readonly unknown[];
    if (d[0] !== w.posted.window || String(d[6]).toLowerCase() !== w.posted.root.toLowerCase()) return { why: "no longer the pending list (cancelled, replaced or drawn)", by: "gone" };
    return d[5] !== 0n ? { why: "its draw was requested", by: "requested" } : null;
  }

  function start(w: Watch) {
    w.running = verify({ clients: cs, dep, posted: w.posted, logSigner: o.logSigner ?? null }).then(async (r) => {
      const was = w.state;
      // no lists.delete here: posting this list already cleared its window, and a replaced list failing late must not
      // drop the replacement's verified entry
      if (r.problems.length) {
        w.state = "bad"; w.why = r.problems.join("; "); w.lastPage = 0;
        // the watch closed because its draw was requested, and this is still the window's newest list: the loop no
        // longer pages it, so page once here. A replaced or cancelled list ("gone") stays silent. Its Drawn is then
        // not paged again as "not verified" (lateBad)
        if (w.closedBy === "requested" && latest.get(w.posted.window) === w.posted.blockNumber) {
          lateBad.add(w.posted.window);
          await o.page(`🚨 JACKPOT LIST MISMATCH — window ${w.posted.window}: ${w.why} (found after its draw was requested)`);
        }
        return;
      }
      w.state = "ok";
      if (latest.get(w.posted.window) === w.posted.blockNumber) lists.set(w.posted.window, r.list);
      await o.page(`Jackpot list window ${w.posted.window} verified${was === "unverified" ? " (late)" : ""}: ${r.holders} holders, ${r.totalTickets} tickets, rebuilt from ${cs.length} providers.`);
    }, (e) => {
      // a check that could not run (RPC trouble) is retried with exponential backoff, at most every REPEAT
      w.lastError = (e as Error).message.slice(0, 300);
      w.failures++;
      w.nextTry = now() + Math.min(cfg.pollMs * 2 ** w.failures, cfg.repeatMs);
    }).finally(() => { w.running = undefined; running.delete(w); });
    running.add(w);
  }
  /** A rebuild of this window is still pending (an open watch still checking) or running. */
  const busy = (window: bigint) => [...running].some((w) => w.posted.window === window)
    || [...watches.values()].some((w) => w.posted.window === window && (w.state === "checking" || w.state === "unverified"));

  async function tick() {
    lastTick = now();
    const head = await cs[0].getBlockNumber();
    from ??= head > cfg.lookbackBlocks ? head - cfg.lookbackBlocks : 0n;
    for (const p of await postedLists(cs[0], dep, from, head)) {
      const at = Number((await cs[0].getBlock({ blockNumber: p.blockNumber })).timestamp);
      const key = `${p.window}:${p.blockNumber}`;
      if (!watches.has(key)) watches.set(key, { posted: p, at, state: "checking", lastPage: 0, failures: 0, nextTry: 0 });
      lists.delete(p.window); // a replacement list: its draw is never checked against the one it replaced
      lateBad.delete(p.window); // nor silenced by the MISMATCH of the one it replaced
      latest.set(p.window, p.blockNumber);
    }
    draws.push(...(await drawnLogs(cs[0], dep, from, head)).map((d) => ({ ...d, seen: now() })));
    await rewards.tick(from, head); // reads the new RewardQueued logs; each check runs in the background
    // deploys, funds, release: a check that could not run (RPC / site trouble) is retried from the same block
    if (seq) {
      seqFrom ??= from;
      try { await seq.tick(seqFrom, head); seqFrom = head + 1n; seqError = undefined; } catch (e) { seqError = (e as Error).message.slice(0, 300); }
    }
    from = head + 1n;
    for (const dr of [...draws]) {
      const list = lists.get(dr.window);
      if (!list) {
        if (!latest.has(dr.window)) {
          // its list predates this watchdog's lookback (a fresh start), or a provider dropped the ListPosted log:
          // nothing to check it against here. One page, then it leaves
          draws.splice(draws.indexOf(dr), 1);
          await o.page(`Jackpot draw window ${dr.window} (tx ${dr.transactionHash}) settled but its list predates this watchdog's lookback; not checked here: run scripts/verify-draw.ts --window ${dr.window}`);
          continue;
        }
        if (lateBad.has(dr.window)) { // its list's MISMATCH already paged: one settle note, not a "not verified"
          draws.splice(draws.indexOf(dr), 1);
          await o.page(`Jackpot draw window ${dr.window} (tx ${dr.transactionHash}) settled on the list already flagged MISMATCH above: run scripts/verify-draw.ts --window ${dr.window}`);
          continue;
        }
        if (busy(dr.window)) { dr.seen = now(); continue; } // the deadline starts once its rebuild is done
        if (now() - dr.seen < cfg.verifyDeadlineS * 1000) continue;
        draws.splice(draws.indexOf(dr), 1);
        await o.page(`Jackpot draw window ${dr.window} settled but its list was not verified by this watchdog: run scripts/verify-draw.ts --window ${dr.window}`);
        continue;
      }
      const s = await settled(cs[0], dep, dr).catch(() => undefined); // RPC trouble: retried next tick
      if (!s) continue;
      draws.splice(draws.indexOf(dr), 1);
      lists.delete(dr.window);
      const { problems, walk } = checkWinners(list, s);
      await o.page(problems.length
        ? `🚨 JACKPOT DRAW MISMATCH — window ${dr.window}: ${problems.join("; ")}. Settle tx ${dr.transactionHash}.`
        : `Jackpot draw window ${dr.window} verified: ${walk.winners.length} winners, the walk over ${walk.used.length} tickets recomputed from the verified list.`);
    }
    for (const [key, w] of watches) {
      const c = await closed(w, head);
      if (c) {
        if (w.state === "bad" || w.state === "unverified") await o.page(`Jackpot list window ${w.posted.window}: ${c.why}.`);
        w.closedBy = c.by;
        w.state = "closed";
        watches.delete(key);
        continue;
      }
      if ((w.state === "checking" || w.state === "unverified") && !w.running && now() >= w.nextTry) start(w); // a failed check retries, backed off
      if (w.state === "checking" && now() / 1000 > w.at + cfg.verifyDeadlineS) { w.state = "unverified"; w.why = w.lastError ?? "the rebuild is still running"; }
      if ((w.state === "bad" || w.state === "unverified") && now() - w.lastPage >= cfg.repeatMs) {
        w.lastPage = now();
        await o.page(`🚨 JACKPOT LIST ${w.state === "bad" ? "MISMATCH" : "NOT VERIFIED IN 30 MIN"} — window ${w.posted.window}: ${w.why}. ${veto(w)}`);
      }
    }
  }

  return {
    tick,
    /** Health: the loop ran within 3 polls (a rebuild never blocks it). */
    health: () => ({ ok: now() - lastTick < 3 * cfg.pollMs, lastTick, from, watching: [...watches.values()].map((w) => ({ window: Number(w.posted.window), state: w.state })), rewards: rewards.open(), seqError }),
    /** Tests: wait for the background checks. */
    settled: () => Promise.all([...watches.values()].map((w) => w.running as Promise<unknown> | undefined).concat(rewards.settled())),
  };
}
