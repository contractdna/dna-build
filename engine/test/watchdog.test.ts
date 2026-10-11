// The jackpot watchdog's loop (src/watchdog.ts) and its chain reads (src/ticket-source.ts): a slow or hung rebuild
// never blocks detecting new lists or the health check, and pages "not verified" at the deadline; a mismatch pages
// with the veto; chunked getLogs survive provider range limits; block timestamps are fetched with bounded concurrency.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hex, PublicClient } from "viem";

import type { Settled } from "../src/draw-verify.ts";
import { fromRpc, getLogsChunked, mapLimit, RPC_CONCURRENCY, type Dep } from "../src/ticket-source.ts";
import { type DrawList, pickWinners } from "../src/tickets.ts";
import { createWatchdog, WATCH } from "../src/watchdog.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const dep = { startBlock: 0, gamePot: a(0xd2), token: a(0xd0), convictionVault: a(0xd1) } as Dep;
const root = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const T0 = 1_800_000_000;

/** A chain with ListPosted logs at given blocks; draw() says which list is pending. */
function chain() {
  const c = {
    head: 100n,
    posted: [] as { window: bigint; root: Hex; blockNumber: bigint }[],
    pending: { window: 0n, root: root(0), reqId: 0n },
    getLogsCalls: [] as [bigint, bigint][],
    drawn: [] as { window: bigint; blockNumber: bigint }[],
  };
  const client = {
    getBlockNumber: async () => c.head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(T0) + blockNumber * 12n, number: blockNumber, hash: root(Number(blockNumber)) }),
    getLogs: async (q: { fromBlock: bigint; toBlock: bigint; event?: { name: string } }) => {
      if (q.event?.name === "RewardQueued") return []; // the reward loop: tested in rewards.test.ts
      if (q.event?.name === "Drawn") return c.drawn.filter((x) => x.blockNumber >= q.fromBlock && x.blockNumber <= q.toBlock)
        .map((x) => ({ blockNumber: x.blockNumber, transactionHash: root(0xd000 + Number(x.blockNumber)), args: { window: x.window, rand: 0n, prize: 0n, share: 0n, winners: 0n, ticketsUsed: 0n } }));
      c.getLogsCalls.push([q.fromBlock, q.toBlock]);
      return c.posted.filter((p) => p.blockNumber >= q.fromBlock && p.blockNumber <= q.toBlock).map((p) => ({
        blockNumber: p.blockNumber, args: { window: p.window, capBps: 100n, minBalance: 1n, root: p.root, totalTickets: 10n, holders: 2n, uri: "u", dataHash: root(1), eta: BigInt(T0 + 3600) },
      }));
    },
    readContract: async () => [c.pending.window, 0, 0, 0, 0n, c.pending.reqId, c.pending.root, 0n, 0n, 0n],
  } as unknown as PublicClient;
  return { c, client };
}
const cfg = { ...WATCH, lookbackBlocks: 50n };
/** A tick must return promptly whatever the rebuild does. */
const quick = (p: Promise<void>) => Promise.race([p, new Promise<void>((_, rej) => setTimeout(() => rej(new Error("tick blocked on a rebuild")), 2_000))]);

test("a hung rebuild never blocks the loop: new lists are still found, health stays up, the deadline pages 'not verified'", async () => {
  const { c, client } = chain();
  let t = T0 * 1000;
  const pages: string[] = [];
  const verified: bigint[] = [];
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => t, cfg,
    verify: async ({ posted }) => { verified.push(posted.window); return new Promise(() => {}); } }); // never answers
  c.posted.push({ window: 3n, root: root(33), blockNumber: 90n });
  c.pending = { window: 3n, root: root(33), reqId: 0n };
  t = (T0 + 90 * 12) * 1000 + 60_000; // a minute after the post
  await quick(wd.tick());
  assert.deepEqual(c.getLogsCalls[0], [50n, 100n], "boot: from head − lookback");
  assert.deepEqual(verified, [3n], "the rebuild started");
  assert.deepEqual(wd.health().watching, [{ window: 3, state: "checking" }]);
  // the next window's list arrives while the first rebuild still hangs
  c.head = 120n;
  c.posted.push({ window: 4n, root: root(44), blockNumber: 110n });
  c.pending = { window: 4n, root: root(44), reqId: 0n }; // it replaced the unrequested one
  await quick(wd.tick());
  assert.deepEqual(verified, [3n, 4n], "found and started although the first check never finished");
  assert.ok(wd.health().ok, "health is up");
  assert.deepEqual(wd.health().watching, [{ window: 4, state: "checking" }], "the replaced list is no longer watched");
  // 30 min after the post: page, with the veto
  t = (T0 + 110 * 12 + WATCH.verifyDeadlineS + 1) * 1000;
  await quick(wd.tick());
  const page = pages.find((p) => /NOT VERIFIED IN 30 MIN — window 4: the rebuild is still running\. Safe: cancelList\(4\)/.test(p));
  assert.ok(page, pages.join("\n"));
  // repeated every REPEAT, not every tick
  const n = pages.length;
  t += 60_000;
  await quick(wd.tick());
  assert.equal(pages.length, n);
  t += WATCH.repeatMs;
  await quick(wd.tick());
  assert.ok(pages.length > n);
});

test("a mismatch pages at once with the veto; a cancelled list closes with a note", async () => {
  const { c, client } = chain();
  const pages: string[] = [];
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => (T0 + 95 * 12) * 1000, cfg,
    verify: async () => ({ window: 3, problems: ["a rebuild from rpc.example gives root 0xbad"], list: {} as never, holders: 2, totalTickets: "10" }) });
  c.posted.push({ window: 3n, root: root(33), blockNumber: 90n });
  c.pending = { window: 3n, root: root(33), reqId: 0n };
  await wd.tick();
  await wd.settled();
  await wd.tick();
  assert.match(pages.join("\n"), /JACKPOT LIST MISMATCH — window 3: a rebuild from rpc\.example gives root 0xbad\. Safe: cancelList\(3\)/);
  c.pending = { window: 0n, root: root(0), reqId: 0n }; // the Safe cancelled it
  await wd.tick();
  assert.match(pages.at(-1)!, /window 3: no longer the pending list/);
  assert.deepEqual(wd.health().watching, []);
});

test("an honest list is verified once and stays quiet", async () => {
  const { c, client } = chain();
  const pages: string[] = [];
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => (T0 + 95 * 12) * 1000, cfg,
    verify: async () => ({ window: 3, problems: [], list: {} as never, holders: 2, totalTickets: "10" }) });
  c.posted.push({ window: 3n, root: root(33), blockNumber: 90n });
  c.pending = { window: 3n, root: root(33), reqId: 0n };
  await wd.tick();
  await wd.settled();
  await wd.tick();
  assert.deepEqual(pages, ["Jackpot list window 3 verified: 2 holders, 10 tickets, rebuilt from 2 providers."]);
});

test("a settled draw of a verified window is re-walked: an honest settle pages 'verified', a swapped winner pages a mismatch", async () => {
  // the golden vector's list (GamePot.t.sol test_goldenVector): 3 accounts, 5 / 3 / 7 tickets
  const list = { root: "0x3b953545397409c5773e5f6520cfd629d63970a82385f05bb115abb9ebf90198", totalTickets: "15", holders: 3,
    leaves: [[0x1111, 0, 5], [0x2222, 5, 3], [0x3333, 8, 7]].map(([x, c0, t], index) => ({ index, account: `0x${x.toString(16).repeat(10)}` as Hex, cumStart: String(c0), tickets: String(t) })) } as unknown as DrawList;
  const rand = 77n, prize = 10n ** 18n;
  const walk = pickWinners(list, rand);
  const honest: Settled = { rand, prize, share: prize / 10n, winners: BigInt(walk.winners.length), ticketsUsed: BigInt(walk.used.length),
    paid: walk.winners.map((account, i) => ({ rank: BigInt(i), account, share: prize / 10n })), excluded: [] };
  for (const [settle, want] of [[honest, /^Jackpot draw window 3 verified: 3 winners, the walk over 32 tickets/],
    [{ ...honest, paid: [honest.paid[1], { ...honest.paid[0], rank: 1n }, honest.paid[2]].map((p, i) => ({ ...p, rank: BigInt(i) })) }, /JACKPOT DRAW MISMATCH — window 3: rank 0: the walk picks/]] as const) {
    const { c, client } = chain();
    const pages: string[] = [];
    const asked: bigint[] = [];
    const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => (T0 + 95 * 12) * 1000, cfg,
      verify: async () => ({ window: 3, problems: [], list, holders: 3, totalTickets: "15" }),
      settled: async (_c, _d, dr) => { asked.push(dr.window); return settle; } });
    c.posted.push({ window: 3n, root: root(33), blockNumber: 90n });
    c.pending = { window: 3n, root: root(33), reqId: 0n };
    await wd.tick();
    await wd.settled();
    c.drawn.push({ window: 3n, blockNumber: 101n }, { window: 9n, blockNumber: 101n }); // window 9: never verified here
    c.head = 102n;
    await wd.tick();
    assert.deepEqual(asked, [3n], "only the window it verified");
    assert.ok(pages.some((p) => want.test(p)), pages.join("\n"));
    assert.equal(pages.filter((p) => /window 9 .*predates this watchdog's lookback/.test(p)).length, 1, "window 9: one page, its list was never seen");
    await wd.tick();
    assert.deepEqual(asked, [3n], "checked once");
  }
});

test("a draw whose list this watchdog never verified pages once after the deadline, pointing at verify-draw", async () => {
  const { c, client } = chain();
  let t = (T0 + 95 * 12) * 1000;
  const pages: string[] = [];
  const asked: bigint[] = [];
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => t, cfg,
    verify: async () => new Promise(() => {}), settled: async (_c, _d, dr) => { asked.push(dr.window); return {} as Settled; } });
  // window 9's list is posted and requested before this watchdog ever rebuilt it: its watch closes, nothing runs
  c.posted.push({ window: 9n, root: root(99), blockNumber: 90n });
  c.pending = { window: 9n, root: root(99), reqId: 7n };
  c.drawn.push({ window: 9n, blockNumber: 99n });
  await wd.tick();
  t += (WATCH.verifyDeadlineS - 1) * 1000;
  await wd.tick();
  assert.deepEqual(pages, [], "not yet: the list may still be verified");
  t += 2_000;
  await wd.tick();
  await wd.tick();
  assert.deepEqual(pages, ["Jackpot draw window 9 settled but its list was not verified by this watchdog: run scripts/verify-draw.ts --window 9"], "once");
  assert.deepEqual(asked, [], "never checked against nothing");
});

test("a draw's deadline starts only once its window's rebuild is done; a draw whose list predates the lookback pages once", async () => {
  const { c, client } = chain();
  let t = (T0 + 95 * 12) * 1000;
  const pages: string[] = [];
  let fail: (e: Error) => void = () => {};
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => t, cfg,
    verify: () => new Promise((_, rej) => { fail = rej; }), settled: async () => { throw new Error("never asked"); } });
  const notVerified = () => pages.filter((p) => /settled but its list was not verified/.test(p));
  c.posted.push({ window: 3n, root: root(33), blockNumber: 90n });
  c.pending = { window: 3n, root: root(33), reqId: 0n };
  await wd.tick(); // window 3's rebuild starts (slow)
  c.pending = { window: 3n, root: root(33), reqId: 7n }; // requested: the watch closes, the rebuild keeps running
  c.drawn.push({ window: 3n, blockNumber: 101n }, { window: 1n, blockNumber: 101n }); // window 1: posted before the lookback
  c.head = 102n;
  await wd.tick();
  t += 3 * WATCH.verifyDeadlineS * 1000;
  await wd.tick();
  assert.deepEqual(notVerified(), [], "window 3's rebuild still runs: no deadline yet");
  const early = () => pages.filter((p) => /window 1 .*predates this watchdog's lookback; not checked here: run scripts\/verify-draw\.ts --window 1$/.test(p));
  assert.equal(early().length, 1, "window 1: one page");
  fail(new Error("upstream 503")); // the rebuild could not run; a closed watch is not retried: no list will come
  await wd.settled();
  await new Promise((r) => setTimeout(r, 0));
  await wd.tick(); // the deadline starts now
  t += (WATCH.verifyDeadlineS - 1) * 1000;
  await wd.tick();
  assert.deepEqual(notVerified(), []);
  t += 2_000;
  await wd.tick();
  await wd.tick();
  assert.deepEqual(notVerified(), ["Jackpot draw window 3 settled but its list was not verified by this watchdog: run scripts/verify-draw.ts --window 3"], "once");
  assert.equal(early().length, 1, "window 1: never again");
});

test("a rebuild that ends bad after its watch closed (draw requested) pages the mismatch once, then one settle note for its draw", async () => {
  const { c, client } = chain();
  const pages: string[] = [];
  let t = (T0 + 95 * 12) * 1000;
  let finish: (r: Awaited<ReturnType<NonNullable<Parameters<typeof createWatchdog>[0]["verify"]>>>) => void = () => {};
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => t, cfg,
    verify: () => new Promise((res) => { finish = res; }), settled: async () => { throw new Error("never asked"); } });
  c.posted.push({ window: 3n, root: root(33), blockNumber: 90n });
  c.pending = { window: 3n, root: root(33), reqId: 0n };
  await wd.tick(); // the rebuild starts (slow)
  c.pending = { window: 3n, root: root(33), reqId: 7n }; // requested: the watch closes
  await wd.tick();
  assert.deepEqual(wd.health().watching, []);
  finish({ window: 3, problems: ["a rebuild gives root 0xbad"], list: {} as never, holders: 2, totalTickets: "10" });
  await wd.settled();
  await new Promise((r) => setTimeout(r, 0));
  await wd.tick();
  c.drawn.push({ window: 3n, blockNumber: 101n }); // the draw settles anyway
  c.head = 102n;
  await wd.tick();
  t += 2 * WATCH.verifyDeadlineS * 1000;
  await wd.tick();
  await wd.tick();
  assert.deepEqual(pages.filter((p) => /window 3\b/.test(p)), [
    "🚨 JACKPOT LIST MISMATCH — window 3: a rebuild gives root 0xbad (found after its draw was requested)",
    `Jackpot draw window 3 (tx ${root(0xd000 + 101)}) settled on the list already flagged MISMATCH above: run scripts/verify-draw.ts --window 3`,
  ], "exactly these two: no later 'not verified' for its draw");
});

test("after a late MISMATCH on A, a replacement B that is drawn unverified still pages 'not verified' once", async () => {
  const { c, client } = chain();
  const pages: string[] = [];
  let t = (T0 + 95 * 12) * 1000;
  const A = root(33), B = root(34);
  let failA: () => void = () => {};
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => t, cfg,
    verify: ({ posted }) => (posted.root === A
      ? new Promise((res) => { failA = () => res({ window: 3, problems: ["a rebuild gives root 0xbad"], list: {} as never, holders: 2, totalTickets: "10" }); })
      : new Promise((_, rej) => { if (posted.root === B) setTimeout(() => rej(new Error("upstream 503")), 0); })),
    settled: async () => { throw new Error("never asked"); } });
  c.posted.push({ window: 3n, root: A, blockNumber: 90n });
  c.pending = { window: 3n, root: A, reqId: 0n };
  await wd.tick(); // A's rebuild starts (slow)
  c.pending = { window: 3n, root: A, reqId: 7n }; // A requested: its watch closes
  await wd.tick();
  failA(); // A ends bad, late: MISMATCH
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(pages.filter((p) => /MISMATCH/.test(p)).length, 1);
  // VRF abort → the Safe cancels A → B is posted for the same window; its rebuild cannot run; B is requested and drawn
  c.posted.push({ window: 3n, root: B, blockNumber: 101n });
  c.pending = { window: 3n, root: B, reqId: 0n };
  c.head = 102n;
  await wd.tick();
  await wd.settled();
  c.pending = { window: 3n, root: B, reqId: 8n };
  c.drawn.push({ window: 3n, blockNumber: 103n });
  c.head = 104n;
  await wd.tick();
  await wd.settled();
  t += (WATCH.verifyDeadlineS + 1) * 1000;
  await wd.tick();
  await wd.tick();
  assert.deepEqual(pages.filter((p) => /settled/.test(p)), ["Jackpot draw window 3 settled but its list was not verified by this watchdog: run scripts/verify-draw.ts --window 3"],
    "B's draw is not silenced by A's MISMATCH");
});

test("a requested list replaced after an abort (cancel, repost) whose rebuild then ends bad stays silent", async () => {
  const { c, client } = chain();
  const pages: string[] = [];
  const A = root(33), B = root(34);
  let failA: () => void = () => {};
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => (T0 + 95 * 12) * 1000, cfg,
    verify: ({ posted }) => (posted.root === A
      ? new Promise((res) => { failA = () => res({ window: 3, problems: ["a rebuild gives another root"], list: {} as never, holders: 2, totalTickets: "10" }); })
      : Promise.resolve({ window: 3, problems: [], list: { root: B } as never, holders: 2, totalTickets: "10" })) });
  c.posted.push({ window: 3n, root: A, blockNumber: 90n });
  c.pending = { window: 3n, root: A, reqId: 0n };
  await wd.tick(); // A's rebuild starts (slow)
  c.pending = { window: 3n, root: A, reqId: 7n }; // requested: A's watch closes as "requested"
  await wd.tick();
  // VRF timeout → abortDraw → the Safe cancels A → B is posted for the same window
  c.posted.push({ window: 3n, root: B, blockNumber: 101n });
  c.pending = { window: 3n, root: B, reqId: 0n };
  c.head = 102n;
  await wd.tick();
  await new Promise((r) => setTimeout(r, 0));
  failA();
  await new Promise((r) => setTimeout(r, 0));
  await wd.tick();
  assert.ok(!pages.some((p) => /MISMATCH/.test(p)), "A is no longer the window's newest list: " + pages.join("\n"));
});

test("a cancelled list whose rebuild then ends bad stays silent (no false MISMATCH)", async () => {
  const { c, client } = chain();
  const pages: string[] = [];
  let finish: (r: Awaited<ReturnType<NonNullable<Parameters<typeof createWatchdog>[0]["verify"]>>>) => void = () => {};
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => (T0 + 95 * 12) * 1000, cfg,
    verify: () => new Promise((res) => { finish = res; }) });
  c.posted.push({ window: 3n, root: root(33), blockNumber: 90n });
  c.pending = { window: 3n, root: root(33), reqId: 0n };
  await wd.tick(); // the rebuild starts (slow)
  c.pending = { window: 0n, root: root(0), reqId: 0n }; // the Safe cancelled it
  await wd.tick();
  assert.deepEqual(wd.health().watching, []);
  finish({ window: 3, problems: ["a rebuild gives root 0xbad"], list: {} as never, holders: 2, totalTickets: "10" });
  await wd.settled();
  await new Promise((r) => setTimeout(r, 0));
  await wd.tick();
  assert.ok(!pages.some((p) => /MISMATCH/.test(p)), pages.join("\n"));
});

test("a slow rebuild that fails late, of a replaced list, never drops the replacement's verified entry", async () => {
  const { c, client } = chain();
  const pages: string[] = [];
  const asked: bigint[] = [];
  const A = root(33), B = root(34);
  let failA: () => void = () => {};
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => (T0 + 95 * 12) * 1000, cfg,
    verify: ({ posted }) => (posted.root === A
      ? new Promise((res) => { failA = () => res({ window: 3, problems: ["a rebuild gives another root"], list: {} as never, holders: 2, totalTickets: "10" }); })
      : Promise.resolve({ window: 3, problems: [], list: { root: B } as never, holders: 2, totalTickets: "10" })),
    settled: async (_c, _d, dr) => { asked.push(dr.window); throw new Error("rpc trouble"); } }); // retried; what matters is the ask
  c.posted.push({ window: 3n, root: A, blockNumber: 90n });
  c.pending = { window: 3n, root: A, reqId: 0n };
  await wd.tick(); // A's rebuild starts and hangs
  c.posted.push({ window: 3n, root: B, blockNumber: 101n }); // A cancelled, B posted
  c.pending = { window: 3n, root: B, reqId: 0n };
  c.head = 102n;
  await wd.tick(); // B's rebuild runs and passes
  await new Promise((r) => setTimeout(r, 0));
  failA(); // A fails, late
  await new Promise((r) => setTimeout(r, 0));
  c.drawn.push({ window: 3n, blockNumber: 103n });
  c.head = 104n;
  await wd.tick();
  assert.deepEqual(asked, [3n], "the draw is checked against B, the verified replacement");
  assert.ok(!pages.some((p) => /settled but its list was not verified/.test(p)), pages.join("\n"));
  assert.ok(!pages.some((p) => /MISMATCH/.test(p)), "A was replaced, not requested: no MISMATCH");
});

test("a replacement list: a draw that lands before it is verified is never checked against the list it replaced", async () => {
  const { c, client } = chain();
  const pages: string[] = [];
  const asked: bigint[] = [];
  const A = { root: root(33) }, B = { root: root(34) };
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => (T0 + 95 * 12) * 1000, cfg,
    verify: async ({ posted }) => (posted.root === A.root ? { window: 3, problems: [], list: { root: A.root } as never, holders: 2, totalTickets: "10" } : new Promise(() => {})),
    settled: async (_c, _d, dr) => { asked.push(dr.window); return {} as Settled; } });
  c.posted.push({ window: 3n, root: A.root, blockNumber: 90n });
  c.pending = { window: 3n, root: A.root, reqId: 0n };
  await wd.tick();
  await wd.settled();
  assert.match(pages.join(), /Jackpot list window 3 verified/);
  c.posted.push({ window: 3n, root: B.root, blockNumber: 101n }); // A cancelled, B posted for the same window
  c.pending = { window: 3n, root: B.root, reqId: 7n }; // B requested (and drawn) before its rebuild finished
  c.drawn.push({ window: 3n, blockNumber: 102n });
  c.head = 103n;
  await wd.tick();
  assert.deepEqual(asked, [], "not checked against A");
  assert.ok(!pages.some((p) => /MISMATCH/.test(p)), pages.join("\n"));
});

test("chunked getLogs halves a window a provider refuses and still returns everything once", async () => {
  const seen: [bigint, bigint][] = [];
  const logs = await getLogsChunked(async (from, to) => {
    if (to - from + 1n > 1_000n) throw new Error("Log response size exceeded. block range is too wide");
    seen.push([from, to]);
    return Array.from({ length: Number(to - from + 1n) }, (_, i) => from + BigInt(i));
  }, 0n, 25_000n);
  assert.equal(logs.length, 25_001);
  assert.deepEqual(logs.slice(0, 3), [0n, 1n, 2n]);
  assert.equal(new Set(logs.map(String)).size, 25_001, "no block twice");
  assert.ok(seen.every(([f, t]) => t - f + 1n <= 1_000n));
  await assert.rejects(getLogsChunked(async () => { throw new Error("connection reset"); }, 0n, 10n), /connection reset/, "other errors are not retried here");
});

test("block timestamps for a rebuild: at most RPC_CONCURRENCY in flight, every block once", async () => {
  let inflight = 0, max = 0;
  const asked: bigint[] = [];
  const client = {
    getLogs: async (q: { address: Hex; fromBlock: bigint; toBlock: bigint }) => (q.address === dep.token
      ? Array.from({ length: 40 }, (_, i) => BigInt(i + 1)).filter((b) => b >= q.fromBlock && b <= q.toBlock)
        .map((b) => ({ blockNumber: b, args: { from: a(0), to: a(0x1000 + Number(b)), value: 1n } }))
      : []),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      asked.push(blockNumber);
      max = Math.max(max, ++inflight);
      await new Promise((r) => setTimeout(r, 2));
      inflight--;
      return { timestamp: 1000n + blockNumber };
    },
  } as unknown as PublicClient;
  const r = await fromRpc(client, dep, 100);
  assert.equal(r.transfers.length, 40);
  assert.equal(r.transfers[0].at, 1001);
  assert.ok(max <= RPC_CONCURRENCY && max > 1, `max in flight ${max}`);
  assert.equal(new Set(asked.map(String)).size, asked.length, "each block once");
  assert.deepEqual(await mapLimit([3, 1, 2], 2, async (x) => x * 2), [6, 2, 4], "order kept");
});



test("a check that fails (RPC trouble) is retried with exponential backoff, at most every REPEAT", async () => {
  const { c, client } = chain();
  let t = (T0 + 95 * 12) * 1000;
  let calls = 0;
  const wd = createWatchdog({ clients: [client, client], dep, page: async () => {}, now: () => t, cfg, verify: async () => { calls++; throw new Error("upstream 503"); } });
  c.posted.push({ window: 3n, root: root(33), blockNumber: 90n });
  c.pending = { window: 3n, root: root(33), reqId: 0n };
  const at: number[] = [];
  for (let k = 0; k < 40; k++) { // 40 minutes of ticks, one a minute
    const before = calls;
    await wd.tick();
    await wd.settled();
    if (calls > before) at.push(k);
    t += 60_000;
  }
  // after each failure the wait doubles: 2, 4, then the 5-minute cap
  assert.deepEqual(at.slice(0, 4), [0, 2, 6, 11]);
  assert.ok(at.slice(3).every((k, i, a) => i === 0 || k - a[i - 1] === 5), `${at}`);
});

test("a RewardQueued found by the watchdog's tick is checked against its records; a mismatch pages cancelReward with the deadline", async () => {
  const q = { id: 4n, to: a(0xa1), amount: 10n ** 17n, ideaRef: root(0xee), eta: BigInt(T0 + 3600) };
  const client = {
    getBlockNumber: async () => 100n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(T0) + blockNumber * 12n, number: blockNumber, hash: root(Number(blockNumber)) }),
    getLogs: async (f: { event?: { name: string } }) => (f.event?.name === "RewardQueued" ? [{ args: q, blockNumber: 90n }] : []),
    readContract: async () => [0n, 0, 0, 0, 0n, 0n, root(0), 0n, 0n, 0n],
  } as unknown as PublicClient;
  const pages: string[] = [];
  const checked: bigint[] = [];
  const wd = createWatchdog({ clients: [client, client], dep, page: async (x) => { pages.push(x); }, now: () => T0 * 1000, cfg,
    checkReward: async ({ q: r }) => { checked.push(r.id); return ["the record pays someone else"]; } });
  await quick(wd.tick());
  await wd.settled();
  assert.deepEqual(checked, [4n]);
  assert.deepEqual(pages, [`🚨 IDEA REWARD #4 MISMATCH — the record pays someone else. Safe: cancelReward(4) on GamePot ${dep.gamePot} before ${new Date((T0 + 3600) * 1000).toISOString()}.`]);
  assert.deepEqual(wd.health().rewards, [], "checked once");
});

test("a reward check that hangs never blocks the jackpot list checks", async () => {
  const { c, client } = chain();
  const q = { id: 5n, to: a(0xa1), amount: 10n ** 17n, ideaRef: root(0xef), eta: BigInt(T0 + 3600) };
  const logs = { ...client, getLogs: async (f: { event?: { name: string }; fromBlock: bigint; toBlock: bigint }) =>
    (f.event?.name === "RewardQueued" ? [{ args: q, blockNumber: 90n }] : client.getLogs(f as never)) } as unknown as PublicClient;
  const verified: bigint[] = [];
  const wd = createWatchdog({ clients: [logs, logs], dep, page: async () => {}, now: () => (T0 + 95 * 12) * 1000, cfg,
    checkReward: () => new Promise(() => {}), verify: async ({ posted }) => { verified.push(posted.window); return new Promise(() => {}); } });
  c.posted.push({ window: 3n, root: root(33), blockNumber: 90n });
  c.pending = { window: 3n, root: root(33), reqId: 0n };
  await quick(wd.tick());
  assert.deepEqual(verified, [3n], "the list check started although the reward check hangs");
  assert.deepEqual(wd.health().rewards, [5]);
});

test("the watchdog's pages go to TELEGRAM_API_BASE (as the engine's do), to the signers' group, plain text ≤ 4000; no token = stdout only", async () => {
  const { startFakes } = await import("../scripts/fakes.ts");
  const { telegramPager } = await import("../src/watchdog.ts");
  const fakes = await startFakes();
  try {
    await telegramPager({ TELEGRAM_API_BASE: fakes.url, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_ID: "-100" })(`🚨 JACKPOT LIST MISMATCH — window 3: ${"x".repeat(5000)}`);
    const sent = fakes.calls.filter((c) => c.path === "/bott/sendMessage");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.chat_id, -100);
    assert.equal(sent[0].body.text.length, 4000);
    assert.ok(sent[0].body.text.startsWith("🚨 JACKPOT LIST MISMATCH — window 3"));
    assert.equal(sent[0].body.parse_mode, undefined, "plain text");
    await telegramPager({ TELEGRAM_API_BASE: fakes.url })("no token: stdout only");
    assert.equal(fakes.calls.filter((c) => c.path.endsWith("/sendMessage")).length, 1);
  } finally {
    await fakes.close();
  }
});

test("a refused page (HTTP 404/401, or 200 with ok:false) is reported on stderr, never thrown", async () => {
  const { createServer } = await import("node:http");
  const { telegramPager } = await import("../src/watchdog.ts");
  const answers = [[404, { ok: false, error_code: 404, description: "Not Found" }], [200, { ok: false, description: "Bad Request: chat not found" }], [200, { ok: true, result: {} }]] as const;
  let n = 0;
  const server = createServer((_req, res) => { const [status, body] = answers[n++]; res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const errors: string[] = [];
  const saved = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
  try {
    const page = telegramPager({ TELEGRAM_API_BASE: base, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_ID: "-100" });
    await page("one");
    await page("two");
    await page("three");
  } finally {
    console.error = saved;
    server.close();
  }
  assert.deepEqual(errors, ["telegram: sendMessage refused: HTTP 404 Not Found", "telegram: sendMessage refused: HTTP 200 Bad Request: chat not found"]);
});

test("engine liveness: one page when /health fails or its watcher is stuck for > 10 min, one when it is back", async () => {
  const { engineLiveness } = await import("../src/watchdog.ts");
  let t = 0;
  let answer: () => Response = () => Response.json({ mode: "dry_run", lastWatcherBlock: "100" });
  const pages: string[] = [];
  const page = async (p: string) => { pages.push(p); }; // bound before assert.deepEqual narrows `pages`
  const urls: string[] = [];
  const lv = engineLiveness({ url: "https://engine.example/health", page, now: () => t, fetch: (async (u: string) => { urls.push(u); return answer(); }) as typeof fetch });
  const step = async (min: number) => { t += min * 60_000; await lv.tick(); };
  await step(0);
  assert.deepEqual(urls, ["https://engine.example/health"]);
  // a crash-loop: nothing answers. 10 min of grace, one page after it, then silence while it stays down
  answer = () => { throw new TypeError("fetch failed"); };
  for (let i = 0; i < 10; i++) await step(1);
  assert.deepEqual(pages, [], "10 min down: not yet");
  await step(1);
  assert.equal(pages.length, 1);
  assert.match(pages[0], /^ENGINE DOWN\? no good \/health answer for 11 min \(last error: fetch failed\)/);
  answer = () => new Response("bad gateway", { status: 502 });
  for (let i = 0; i < 30; i++) await step(1);
  assert.equal(pages.length, 1, "deduped: one page per outage");
  assert.notEqual(lv.health().engineDown, null);
  // back
  answer = () => Response.json({ mode: "halted", lastWatcherBlock: "105" });
  await step(1);
  assert.deepEqual(pages.slice(1), ["Engine back: /health answers (mode halted)."]);
  assert.equal(lv.health().engineDown, null);
  // it answers, but the head watcher is stuck: down after 10 min, back once the block moves
  for (let i = 0; i < 10; i++) await step(1);
  assert.equal(pages.length, 2);
  await step(1);
  assert.match(pages[2], /^ENGINE DOWN\? \/health answers, but its head watcher has been stuck at block 105 for 11 min/);
  answer = () => Response.json({ mode: "halted", lastWatcherBlock: "106" });
  await step(1);
  assert.equal(pages[3], "Engine back: /health answers (mode halted).");
  assert.match(pages[2], /chain reads are failing.*restarting the CVM won't fix it/);
  // pre-launch: no head watcher by design, so a null block is never "stuck"
  const pre = engineLiveness({ url: "https://engine.example/health", page, now: () => t, fetch: (async () => Response.json({ mode: "dry_run", prelaunch: true, lastWatcherBlock: null })) as typeof fetch });
  for (let i = 0; i < 30; i++) { t += 60_000; await pre.tick(); }
  assert.equal(pages.length, 4);
  // launched, but the watcher never reported a block: down after 10 min
  const never = engineLiveness({ url: "https://engine.example/health", page, now: () => t, fetch: (async () => Response.json({ mode: "dry_run", prelaunch: false, lastWatcherBlock: null })) as typeof fetch });
  for (let i = 0; i < 10; i++) { t += 60_000; await never.tick(); }
  assert.equal(pages.length, 4, "10 min: not yet");
  t += 60_000;
  await never.tick();
  assert.match(pages[4], /^ENGINE DOWN\? \/health answers, but its head watcher never reported a block in 11 min/);
});

test("watchdog boot: the liveness check runs in balances mode too, and only with ENGINE_HEALTH_URL", async () => {
  const { spawn } = await import("node:child_process");
  const script = new URL("../scripts/watchdog.ts", import.meta.url).pathname;
  const hits: string[] = [];
  const { createServer } = await import("node:http");
  const engine = createServer((req, res) => { hits.push(req.url ?? ""); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ mode: "halted", lastWatcherBlock: "1" })); });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(engine.address() as { port: number }).port}/health`;
  const boot = async (env: Record<string, string>) => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", PORT: String(port), WATCHDOG_MODE: "balances", ...env } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    try {
      for (let i = 0; i < 100; i++) {
        const r = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
        if (r && (!env.ENGINE_HEALTH_URL || hits.length)) return { body: await r.json(), out };
        await new Promise((res) => setTimeout(res, 100));
      }
      return { body: null, out };
    } finally { child.kill(); }
  };
  try {
    const on = await boot({ ENGINE_HEALTH_URL: url });
    assert.match(on.out, /liveness: the engine's \/health every 60 s, a page after 10 min down/);
    assert.deepEqual(hits, ["/health"]);
    assert.deepEqual(on.body, { ok: true, mode: "balances", engineDown: null });
    const off = await boot({});
    assert.match(off.out, /liveness: not watched \(no ENGINE_HEALTH_URL\)/);
    assert.equal(hits.length, 1);
  } finally {
    engine.close();
  }
});
