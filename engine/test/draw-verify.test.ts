// The watchdog's / CLI's full list check (src/draw-verify.ts) against a fake chain and a fake log API: an honest list
// passes; every kind of bad list (bytes, params, late announcement, blocks, a rebuilt mismatch, an excluded holder) is
// a problem; an RPC disagreement is "could not verify" (a throw: the watchdog pages after 30 min).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, keccak256, stringToHex } from "viem";
import { canonical } from "../src/canonical.ts";
import { checkWinners, type Posted, type Settled, verifyPosted } from "../src/draw-verify.ts";
import type { Dep } from "../src/ticket-source.ts";
import { accumulate, buildList, type DrawList, excludedHash, pickWinners, ZERO } from "../src/tickets.ts";

const E = 10n ** 18n, BASE = 1_800_000_000;
const ts = (n: number) => BASE + n * 12;
const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const dep: Dep = { startBlock: 0, token: a(0xd0), convictionVault: a(0xd1), gamePot: a(0xd2), registry: a(0xd3), safe: a(0xd4), poolManager: a(0xd5), hook: a(0xd6), feeVault: a(0xd7), buybackBurn: a(0xd8), liquidityVault: a(0xd9), platformRevenue: a(0xda), bootstrap: a(0xdb) };
const W = { window: 6, start: ts(100), end: ts(200) }; // blocks 100..199
const transfers: { block: number; from: Address; to: Address; value: bigint }[] = [...Array.from({ length: 120 }, (_, i) => ({ block: 10, from: ZERO, to: a(0x1000 + i), value: 1_000n * E })), { block: 10, from: ZERO, to: dep.feeVault, value: 10n ** 9n * E }, { block: 150, from: a(0x1000), to: a(0x2000), value: 500n * E }];

/** prior: earlier ListPosted events (the cap policy's input). */
type Chain = { anchorBlock: number; disagree?: boolean; prior?: { window: number; holders: number; block: number }[] };
function client(c: Chain, flip = false) {
  return {
    transport: { url: "https://rpc.example" },
    getBlock: async (q: { blockNumber?: bigint; blockTag?: string }) => {
      const n = q.blockTag === "finalized" ? 300 : Number(q.blockNumber);
      return { number: BigInt(n), hash: flip && c.disagree && n === 199 ? hashOf(9999) : hashOf(n), timestamp: BigInt(ts(n)) };
    },
    getLogs: async (q: { address: Address; event?: { name: string }; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }) => {
      const inRange = (b: number) => b >= Number(q.fromBlock) && b <= Number(q.toBlock);
      switch (q.event?.name) {
        case "Transfer": return transfers.filter((t) => inRange(t.block)).map((t) => ({ blockNumber: BigInt(t.block), args: { from: t.from, to: t.to, value: t.value } }));
        case "Anchored": return inRange(c.anchorBlock) && q.args?.root === PARAMS.ehash ? [{ blockNumber: BigInt(c.anchorBlock), args: { root: PARAMS.ehash } }] : [];
        case "ListPosted": return (c.prior ?? []).filter((l) => inRange(l.block)).map((l) => ({ blockNumber: BigInt(l.block), args: { window: BigInt(l.window), holders: BigInt(l.holders) } }));
        case "WindowRolled": return q.args?.window === 6n ? [{ blockNumber: 99n, args: { window: 6n, start: BigInt(W.start), end: BigInt(W.end) } }] : [];
        case undefined: return []; // the vault's raw logs: nobody staked
      }
      return [];
    },
    readContract: async (q: { functionName: string }) => (q.functionName === "agent" ? a(0xe1) : a(0xe2)),
    multicall: async (q: { contracts: unknown[] }) => q.contracts.map(() => false),
  } as never;
}

type CapInput = { asOfBlock: number; lastList: { window: number; holders: number; block: number } | null };
const paramsRec = (capBps = 200, capInput: CapInput | null = { asOfBlock: 80, lastList: null }) => ({ seq: "10", kind: "game", ref: "jackpot:params:6",
  body: canonical({ kind: "jackpot-params", window: 6, start: W.start, capBps, minBalance: String(1_000n * E), cex: [], cexHash: excludedHash([]), ...(capInput ? { capInput } : {}), reasoning: "r", at: "2026-10-08T00:00:00Z" }),
  hash: hashOf(0xaaa), ehash: hashOf(0xbbb), eprev: null, esig: null });
const PARAMS = paramsRec();
const EXCLUDED = [ZERO, "0x000000000000000000000000000000000000dead", dep.safe, a(0xe1), a(0xe2), dep.poolManager, dep.hook, dep.feeVault, dep.buybackBurn, dep.liquidityVault, dep.convictionVault, dep.gamePot, dep.platformRevenue, dep.bootstrap!].map((x) => x.toLowerCase());

function honest(capBps = 200) {
  const tr = transfers.map((t) => ({ at: ts(t.block), from: t.from, to: t.to, value: t.value }));
  const built = buildList({ ...W, capBps, minBalance: 1_000n * E, startBlock: 100, endBlock: 199, endBlockHash: hashOf(199), paramsSeq: "10" }, accumulate(tr, [], dep.convictionVault, W), EXCLUDED);
  if ("skip" in built) throw new Error(built.skip);
  return built.list;
}
const LIST_URI = "https://genomedna.xyz/api/log/11";
function post(list: DrawList, over: Partial<Posted> = {}, params = PARAMS) {
  const body = canonical(list);
  const rec = { seq: "11", kind: "game", ref: "jackpot:list:6", body, hash: hashOf(0xccc), ehash: null, eprev: null, esig: null };
  const posted: Posted = { window: 6n, capBps: BigInt(list.capBps), minBalance: 1_000n * E, root: list.root, totalTickets: BigInt(list.totalTickets), holders: BigInt(list.holders), uri: LIST_URI, dataHash: keccak256(stringToHex(body)), eta: BigInt(ts(260)), blockNumber: 250n, ...over };
  const fetch = async (url: string) => (url === LIST_URI ? rec : url === "https://genomedna.xyz/api/log/10" ? params : Promise.reject(new Error(`404 ${url}`)));
  return { posted, fetch };
}
const run = (list: DrawList, over: Partial<Posted> = {}, c: Chain = { anchorBlock: 90 }, params = PARAMS) => {
  const { posted, fetch } = post(list, over, params);
  return verifyPosted({ clients: [client(c), client(c, true)], dep, posted, fetch });
};

test("an honest list is rebuilt through every provider and passes every check", async () => {
  const r = await run(honest());
  assert.deepEqual(r.problems, []);
  assert.equal(r.holders, 119, "0x…1000 moved half its balance mid-window: below the minimum average");
});

test("bad lists: bytes, params, a late announcement, blocks, a rebuild mismatch, an excluded holder", async () => {
  const L = honest();
  assert.match((await run(L, { dataHash: hashOf(1) })).problems.join(), /do not hash to the posted dataHash/);
  assert.match((await run(L, { capBps: 100n })).problems.join(), /capBps: list 200, chain 100/);
  assert.match((await run(L, {}, { anchorBlock: 100 })).problems.join(), /not anchored on-chain before the window started/, "anchored in the window's first block: too late");
  assert.deepEqual((await run(L, {}, { anchorBlock: 99 })).problems, [], "the block before is fine");
  const blocks = { ...L, endBlock: 198 };
  assert.match((await run(blocks, { root: blocks.root })).problems.join(), /not the window's blocks/);
  // a whale's tickets doubled, re-rooted and re-hashed so the record itself is consistent: only the rebuild catches it
  const whale = structuredClone(L);
  whale.leaves[0].tickets = String(BigInt(whale.leaves[0].tickets) * 2n);
  let cum = 0n;
  for (const l of whale.leaves) { l.cumStart = String(cum); cum += BigInt(l.tickets); }
  whale.totalTickets = String(cum);
  const { tree, rootOf, leafHash, toLeaf } = await import("../src/tickets.ts");
  whale.root = rootOf(tree(whale.leaves.map((l) => leafHash(toLeaf(l)))));
  const w = await run(whale, { root: whale.root, totalTickets: cum });
  assert.ok(w.problems.some((p) => /a rebuild from rpc\.example gives root/.test(p)), w.problems.join());
  // a protocol contract slipped in
  const sneaky = structuredClone(L);
  sneaky.leaves[5].account = dep.feeVault.toLowerCase() as Address;
  sneaky.leaves.sort((x, y) => (x.account < y.account ? -1 : 1)).forEach((l, i) => { l.index = i; });
  assert.match((await run(sneaky)).problems.join(), /is excluded/);
});

test("providers that disagree on a block: no verdict (the watchdog keeps trying, then pages: not verified)", async () => {
  await assert.rejects(run(honest(), {}, { anchorBlock: 90, disagree: true }), /disagree on block 199/);
});

test("the 10 winners: the walk recomputed; a swapped winner, an unjustified skip, a wrong ticketsUsed, a skip with no event are problems", () => {
  const L = honest();
  const rand = 777n, prize = 10n ** 18n + 7n, share = prize / 10n;
  // what an honest settle logs when the walk's first winner is excluded on chain
  const ex = pickWinners(L, rand).winners[0].toLowerCase();
  const walk = pickWinners(L, rand, new Set([ex]));
  const ok: Settled = {
    rand, prize, share, winners: 10n, ticketsUsed: BigInt(walk.used.length),
    paid: walk.winners.map((account, i) => ({ rank: BigInt(i), account, share })),
    excluded: walk.used.filter((u) => u.skip === "excluded").map((u) => ({ account: u.account, onChain: true })),
  };
  assert.ok(ok.excluded.length >= 1, "the excluded account was walked");
  assert.deepEqual(checkWinners(L, ok).problems, []);
  const bad = (f: (s: Settled) => void) => { const s = structuredClone(ok); f(s); return checkWinners(L, s).problems.join(); };
  assert.match(bad((s) => { [s.paid[2].account, s.paid[3].account] = [s.paid[3].account, s.paid[2].account]; }), /rank 2: the walk picks/);
  assert.match(bad((s) => { s.excluded[0].onChain = false; }), /isExcluded was false at the settle block/);
  assert.match(bad((s) => { s.ticketsUsed += 1n; }), /ticketsUsed/);
  // the chain skipped the account but logged no WinnerExcluded: the walk (without the skip) pays it at rank 0
  assert.match(bad((s) => { s.excluded = []; }), /rank 0: the walk picks/);
  assert.match(bad((s) => { s.share -= 1n; }), /share/);
  assert.match(bad((s) => { s.paid.pop(); s.winners = 9n; }), /winners 9|9 Winner logs/);
});

test("the cap policy is recomputed from the chain: the newest ListPosted before the params' read → 2% (none or < 100) or 1%", async () => {
  const small = { window: 3, holders: 80, block: 60 }, big = { window: 3, holders: 150, block: 60 }, old = { window: 2, holders: 150, block: 40 };
  // no posted draw yet: 2% (a small pool still draws); 1% there is refused
  assert.deepEqual((await run(honest(200))).problems, []);
  assert.match((await run(honest(100), {}, undefined, paramsRec(100))).problems.join(), /the cap policy gives 2% \(last posted draw none\)/);
  // the last posted draw had 150 wallets: 1%
  assert.deepEqual((await run(honest(100), {}, { anchorBlock: 90, prior: [big] }, paramsRec(100, { asOfBlock: 80, lastList: big }))).problems, []);
  // the last posted draw had 80 wallets: 2%, and the params record says which list it read
  assert.deepEqual((await run(honest(200), {}, { anchorBlock: 90, prior: [small] }, paramsRec(200, { asOfBlock: 80, lastList: small }))).problems, []);
  // a 1% list although the last posted draw had 80 wallets
  assert.match((await run(honest(100), {}, { anchorBlock: 90, prior: [small] }, paramsRec(100, { asOfBlock: 80, lastList: small }))).problems.join(), /the cap policy gives 2%/);
  // the record claims a draw the chain doesn't have (150 wallets → 1%)
  assert.match((await run(honest(100), {}, { anchorBlock: 90, prior: [small] }, paramsRec(100, { asOfBlock: 80, lastList: big }))).problems.join(), /the cap input is not the chain's/);
  // a newer list the record skipped (it read at block 80, the chain has one at 70)
  assert.match((await run(honest(100), {}, { anchorBlock: 90, prior: [big, { window: 4, holders: 60, block: 70 }] }, paramsRec(100, { asOfBlock: 80, lastList: big }))).problems.join(), /not the chain's/);
  // read after the anchor: not an input announced before the window
  assert.match((await run(honest(100), {}, { anchorBlock: 90 }, paramsRec(100, { asOfBlock: 95, lastList: null }))).problems.join(), /no cap input read before its anchor/);
  assert.match((await run(honest(100), {}, { anchorBlock: 90 }, paramsRec(100, null))).problems.join(), /no cap input/);
  // only recent draws count (windows w−2, w−3; here 4 and 3): a big draw in window 2 is too old → 2%, 1% is refused
  assert.deepEqual((await run(honest(200), {}, { anchorBlock: 90, prior: [old] }, paramsRec(200, { asOfBlock: 80, lastList: old }))).problems, []);
  assert.match((await run(honest(100), {}, { anchorBlock: 90, prior: [old] }, paramsRec(100, { asOfBlock: 80, lastList: old }))).problems.join(), /the cap policy gives 2%/);
  // the input must be fresh: read at most 300 blocks (~1 h) before the anchor (these anchors are also too late for the
  // window, a separate problem; only the age message is checked here)
  const stale = /the cap input was read more than ~1 h before the anchor/;
  assert.ok(!stale.test((await run(honest(200), { blockNumber: 500n }, { anchorBlock: 390 }, paramsRec(200, { asOfBlock: 90, lastList: null }))).problems.join()), "300 blocks: fresh");
  assert.match((await run(honest(200), { blockNumber: 500n }, { anchorBlock: 391 }, paramsRec(200, { asOfBlock: 90, lastList: null }))).problems.join(), stale);
});
