// The holder-jackpot ticket list (src/tickets.ts): TWAB over held and staked DNA, eligibility,
// the water-filled cap, the tree (the same golden vector contracts/test/GamePot.t.sol checks), the canonical list and
// the verifier's shape checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, keccak256, stringToHex } from "viem";
import { canonical } from "../src/canonical.ts";
import {
  accumulate, buildList, candidates, checkList, type DrawList, leafHash, type ListMeta, multAt, pickWinners, proofOf, rootOf, ticketAt, toLeaf, type Transfer, tree, type VaultEvent, verifyProof, waterfill, winnerOf, ZERO,
} from "../src/tickets.ts";

const H = 3600, D = 86_400, E = 10n ** 18n;
const S = 1_800_000_000;
const A = "0x00000000000000000000000000000000000000aa" as Address, B = "0x00000000000000000000000000000000000000bb" as Address, C = "0x00000000000000000000000000000000000000cc" as Address;
const V = "0x00000000000000000000000000000000000000fe" as Address; // the vault
const tr = (at: number, from: Address, to: Address, dna: bigint): Transfer => ({ at, from, to, value: dna * E });
const W = { window: 4, start: S, end: S + 100 };
const raw = (acc: Map<string, { weighted: bigint; plain: bigint }>, a: string, w = W) => (acc.get(a.toLowerCase())?.weighted ?? 0n) / (BigInt(w.end - w.start) * 10_000n) / E;
const avg = (acc: Map<string, { weighted: bigint; plain: bigint }>, a: string, w = W) => (acc.get(a.toLowerCase())?.plain ?? 0n) / BigInt(w.end - w.start) / E;

test("TWAB, held DNA: end-of-block balances from their block's time, clipped to [start, end); mints, burns, self-transfers", () => {
  const acc = accumulate([
    tr(S - 10, ZERO, A, 100n), // minted before the window: the whole window
    tr(S + 25, A, B, 40n), // A 100 for 25 s then 60 for 75 s = 70; B 40 for 75 s = 30
    tr(S + 50, B, B, 40n), // a self-transfer is a no-op
    tr(S + 60, ZERO, C, 1_000n), tr(S + 80, C, ZERO, 1_000n), // C held 1,000 for 20 s = 200; the burn is not an account
    tr(S + 100, ZERO, A, 9_999n), // at exactly `end`: outside the window
  ], [], V, W);
  assert.deepEqual([raw(acc, A), raw(acc, B), raw(acc, C)], [70n, 30n, 200n]);
  assert.equal(acc.has(ZERO), false, "0x0 never holds");
  const start = accumulate([tr(S, ZERO, A, 100n)], [], V, W);
  assert.equal(raw(start, A), 100n, "a block at exactly `start` counts from the start");
});

test("TWAB, staked DNA: the owner at the vault's weight, piecewise (streak step mid-window), the vault's own balance excluded", () => {
  const lockAt = S - 1.5 * D;
  const Wd = { window: 4, start: S, end: S + D };
  const evs: VaultEvent[] = [{ at: lockAt, event: "Locked", id: 1, owner: A, amount: 10_000n * E, tier: 2 }];
  const acc = accumulate([tr(lockAt - 1, ZERO, A, 10_000n), tr(lockAt, A, V, 10_000n)], evs, V, Wd);
  // ×3 (7 d tier in term) for 12 h, then age 2 d: ×3 × ×1.25 = ×3.75 for 12 h → 3.375 × 10,000
  assert.equal(raw(acc, A, Wd), 33_750n);
  assert.equal(avg(acc, A, Wd), 10_000n, "unweighted average: the staked amount");
  assert.equal(acc.has(V.toLowerCase()), false, "the vault's own balance never counts (no double count)");
});

test("TWAB, staked DNA: withdraw mid-window stops the weight and the wallet holds it again; recommit restarts the tier", () => {
  const Wd = { window: 4, start: S, end: S + D };
  const lockAt = S - 10 * D;
  const evs: VaultEvent[] = [
    { at: lockAt, event: "Locked", id: 1, owner: A, amount: 1_000n * E, tier: 0 },
    { at: S + 12 * H, event: "Withdrawn", id: 1 },
  ];
  const acc = accumulate([tr(lockAt, ZERO, V, 1_000n), tr(S + 12 * H, V, A, 1_000n)], evs, V, Wd);
  // 12 h at ×2 (after term) × ×2 (10 d streak) = ×4, then 12 h held at ×1: (4 + 1) / 2 × 1,000
  assert.equal(raw(acc, A, Wd), 2_500n);
  const re: VaultEvent[] = [
    { at: S - 3 * D, event: "Locked", id: 2, owner: B, amount: 1_000n * E, tier: 0 },
    { at: S, event: "Recommitted", id: 2, tier: 2, termStart: S }, // a 7 d term from the window's start: ×3 × ×1.25
  ];
  assert.equal(raw(accumulate([tr(S - 3 * D, ZERO, V, 1_000n)], re, V, Wd), B, Wd), 3_750n);
  assert.equal(multAt({ id: 2, owner: B, amount: 1n, start: S - 3 * D, terms: [{ termStart: S - 3 * D, tier: 0 }, { termStart: S, tier: 2 }], withdrawnAt: null }, S - 1), 25_000, "before the recommit: ×2 × ×1.25");
  const p7 = { id: 3, owner: C, amount: 1n, start: S, terms: [{ termStart: S, tier: 2 }], withdrawnAt: null };
  assert.deepEqual([multAt(p7, S + 7 * D - 1), multAt(p7, S + 7 * D)], [40_000, 30_000], "7 d tier: ×3 × ×1.5 capped at ×4, then ×2 × ×1.5 once the term ends");
  assert.equal(multAt(p7, S + 12 * D), 40_000, "×2 × ×2 = ×4");
});

test("water-filling: no cap when nobody is above it; else the top wallets get exactly L and L / Σ ≤ cap; infeasible = null", () => {
  const rows = (xs: number[]) => xs.map((x, i) => ({ account: `0x${String(i).padStart(40, "0")}`, raw: BigInt(x) }));
  const flat = rows(Array(200).fill(10));
  assert.deepEqual(waterfill(flat, 100)!.map((r) => r.tickets), Array(200).fill(10n), "1/200 each is under 1%: untouched");
  const whale = rows([1_000_000, ...Array(199).fill(10)]); // Σ others 1,990; L = 0.01 × (L + 1,990) → L = 20
  const w = waterfill(whale, 100)!;
  assert.equal(w[0].tickets, 20n);
  const total = w.reduce((s, r) => s + r.tickets, 0n);
  assert.ok(w[0].tickets * 10_000n <= 100n * total);
  assert.equal(waterfill(rows(Array(99).fill(10)), 100), null, "99 wallets can't satisfy a 1% cap");
  assert.equal(waterfill(rows([5, 0, 0]), 200), null, "zero-ticket wallets don't count");
  // random cases: the cap always holds, capped wallets share one level, uncapped keep their raw tickets
  let seed = 7;
  const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  for (let k = 0; k < 200; k++) {
    const xs = rows(Array.from({ length: 50 + Math.floor(rnd() * 300) }, () => Math.floor(rnd() ** 4 * 1e9) + 1));
    const cap = 50 + Math.floor(rnd() * 151);
    const out = waterfill(xs, cap);
    if (!out) { assert.ok(xs.length * cap < 10_000, "null only below 1/cap wallets"); continue; }
    const sum = out.reduce((s, r) => s + r.tickets, 0n);
    const max = out.reduce((m, r) => (r.tickets > m ? r.tickets : m), 0n);
    assert.ok(max * 10_000n <= BigInt(cap) * sum, "no wallet above the cap");
    const byAcc = new Map(xs.map((r) => [r.account, r.raw]));
    for (const r of out) assert.ok(r.tickets === byAcc.get(r.account) || r.tickets === max, "capped at the one level, or untouched");
    assert.ok(out.every((r) => r.tickets <= byAcc.get(r.account)!), "never more than raw");
  }
});

test("tree: the golden vector GamePot.t.sol checks; every leaf's proof verifies (OZ sorted pairs, odd node promoted)", () => {
  const L = [
    { index: 0, account: "0x1111111111111111111111111111111111111111" as Address, cumStart: 0n, tickets: 5n },
    { index: 1, account: "0x2222222222222222222222222222222222222222" as Address, cumStart: 5n, tickets: 3n },
    { index: 2, account: "0x3333333333333333333333333333333333333333" as Address, cumStart: 8n, tickets: 7n },
  ];
  const t = tree(L.map(leafHash));
  assert.equal(leafHash(L[0]), "0x5a329d02646ff492373482f02964df08c6b2faebdc11392292d2b2564f9759cd");
  assert.equal(rootOf(t), "0x3b953545397409c5773e5f6520cfd629d63970a82385f05bb115abb9ebf90198");
  assert.deepEqual(proofOf(t, 2), ["0x7b6271f0e74dca2c0acc6bf899c1462b4850fee661350460d5578607010c9edd"]);
  for (let n = 1; n <= 17; n++) {
    const hs = Array.from({ length: n }, (_, i) => leafHash({ index: i, account: `0x${String(i + 1).padStart(40, "0")}` as Address, cumStart: BigInt(i), tickets: 1n }));
    const tt = tree(hs);
    hs.forEach((h, i) => assert.ok(verifyProof(proofOf(tt, i), rootOf(tt), h), `n=${n} i=${i}`));
    if (n > 1) assert.ok(!verifyProof(proofOf(tt, 0), rootOf(tt), hs[n - 1]), "a proof is for its own leaf");
  }
});

const meta = (over: Partial<ListMeta> = {}): ListMeta => ({ window: 4, start: S, end: S + 100, capBps: 100, minBalance: 100n * E, startBlock: 10, endBlock: 20, endBlockHash: `0x${"ab".repeat(32)}`, paramsSeq: "77", ...over });
const holders = (n: number, dna = 1_000n) => Array.from({ length: n }, (_, i) => tr(S - 1, ZERO, `0x${(i + 1).toString(16).padStart(40, "0")}` as Address, dna));

test("the list: eligible by the unweighted average, excluded accounts dropped, sorted by account, canonical bytes = dataHash", () => {
  const ts = [...holders(150), tr(S - 1, ZERO, A, 99n), tr(S - 1, ZERO, B, 50_000n)];
  const acc = accumulate(ts, [], V, meta());
  assert.equal(candidates(acc).length, 152);
  const built = buildList(meta(), acc, [B]);
  assert.ok(!("skip" in built));
  const { list, bytes, dataHash } = built;
  assert.equal(list.holders, 150, "A below 100 DNA average, B excluded");
  assert.ok(!list.leaves.some((l) => l.account === A || l.account === B));
  assert.deepEqual(list.leaves.map((l) => l.account), [...list.leaves.map((l) => l.account)].sort());
  assert.equal(bytes, canonical(list));
  assert.equal(dataHash, keccak256(stringToHex(bytes)));
  assert.deepEqual(checkList(list, [B]), []);
  assert.equal(list.totalTickets, String(150n * 1_000n));
  // eligibility is the unweighted average: a large balance held briefly, or a stake whose weight (not amount) clears it
  const short = accumulate([...holders(150), tr(S + 99, ZERO, C, 5_000n)], [], V, meta());
  assert.ok(!(buildList(meta(), short, []) as { list: DrawList }).list.leaves.some((l) => l.account === C), "50 DNA average < 100");
  const m = meta({ minBalance: 1_500n * E });
  const staked = accumulate([...holders(150, 2_000n), tr(S - D, ZERO, V, 1_000n)], [{ at: S - D, event: "Locked", id: 1, owner: C, amount: 1_000n * E, tier: 2 }], V, m);
  assert.equal(raw(staked, C), 3_000n, "×3: weighted 3,000");
  assert.ok(!(buildList(m, staked, []) as { list: DrawList }).list.leaves.some((l) => l.account === C), "but 1,000 staked < 1,500 average");
});

test("the list is sorted by account whatever the balances (ties and the cap order by tickets first)", () => {
  const ts = Array.from({ length: 150 }, (_, i) => tr(S - 1, ZERO, `0x${(150 - i).toString(16).padStart(40, "0")}` as Address, BigInt(1_000 + ((i * 37) % 150) * 7)));
  const built = buildList(meta(), accumulate(ts, [], V, meta()), []);
  assert.ok(!("skip" in built));
  const accs = built.list.leaves.map((l) => l.account);
  assert.deepEqual(accs, [...accs].sort());
  assert.deepEqual(checkList(built.list, []), []);
});

test("the list: too few wallets for the cap → no list (the window is skipped)", () => {
  const built = buildList(meta(), accumulate(holders(60), [], V, meta()), []);
  assert.ok("skip" in built && /1% cap with 60 eligible wallets/.test(built.skip));
  // eligible = wallets with tickets (the same count a posted list's holders is): dust holders below one ticket don't count
  const dust = buildList(meta({ minBalance: 0n }), accumulate([...holders(60), tr(S - 1, ZERO, A, 0n), { at: S - 1, from: ZERO, to: B, value: E / 2n }], [], V, meta()), []);
  assert.ok("skip" in dust && dust.eligible === 60, JSON.stringify(dust));
});

test("checkList catches every tampering the watchdog looks for", () => {
  const built = buildList(meta(), accumulate(holders(120), [], V, meta()), []);
  assert.ok(!("skip" in built));
  const L = built.list;
  const mutate = (f: (l: DrawList) => void) => { const c = structuredClone(L); f(c); return checkList(c, []); };
  assert.match(mutate((l) => { l.leaves[3].cumStart = "1"; }).join(), /not contiguous/);
  assert.match(mutate((l) => { l.totalTickets = "1"; }).join(), /Σ tickets/);
  assert.match(mutate((l) => { [l.leaves[1].account, l.leaves[2].account] = [l.leaves[2].account, l.leaves[1].account]; }).join(), /not sorted/);
  assert.match(mutate((l) => { l.leaves[0].tickets = String(BigInt(l.leaves[0].tickets) + 10_000n); for (const x of l.leaves.slice(1)) x.cumStart = String(BigInt(x.cumStart) + 10_000n); l.totalTickets = String(BigInt(l.totalTickets) + 10_000n); }).join(), /over the 1% cap/);
  assert.match(mutate((l) => { l.root = `0x${"00".repeat(32)}`; }).join(), /root/);
  assert.match(checkList(L, [L.leaves[5].account]).join(), /excluded/);
  assert.match(mutate((l) => { l.holders = 1; }).join(), /holders/);
  assert.match(mutate((l) => { l.leaves[0].tickets = "0"; for (const x of l.leaves.slice(1)) x.cumStart = String(BigInt(x.cumStart) - 1_000n); l.totalTickets = String(BigInt(l.totalTickets) - 1_000n); }).join(), /no tickets/);
});

/** The golden vector's list (5, 3, 7 tickets), as a DrawList. */
const GOLDEN = {
  totalTickets: "15", holders: 3,
  leaves: [["0x1111111111111111111111111111111111111111", 0, 5], ["0x2222222222222222222222222222222222222222", 5, 3], ["0x3333333333333333333333333333333333333333", 8, 7]]
    .map(([account, c, t], index) => ({ index, account: account as Address, cumStart: String(c), tickets: String(t) })),
} as unknown as DrawList;
const GOLDEN_RAND = BigInt(keccak256(stringToHex("dna.ten-winners.golden")));

test("ticketAt: the golden vector GamePot.t.sol and the browser pin (first 12 tickets)", () => {
  const t = (total: bigint) => Array.from({ length: 12 }, (_, j) => Number(ticketAt(GOLDEN_RAND, j, total)));
  assert.deepEqual(t(15n), [0, 6, 1, 5, 6, 13, 5, 9, 10, 10, 2, 12]);
  assert.deepEqual(t(1_000_003n), [993783, 57593, 632966, 272017, 880431, 158056, 940297, 250201, 589891, 972677, 164111, 197800]);
});

test("pickWinners: the contract's walk; 3 accounts → 3 winners after all 32 tickets, duplicates skipped", () => {
  const { used, winners } = pickWinners(GOLDEN, GOLDEN_RAND);
  assert.equal(used.length, 32);
  assert.deepEqual(winners, GOLDEN.leaves.map((l) => l.account), "tickets 0, 6, then 13 at j = 5 (GamePot.t.sol test_goldenVector)");
  assert.deepEqual(used.slice(0, 6).map((u) => [u.index, u.skip ?? "win"]), [[0, "win"], [1, "win"], [0, "duplicate"], [1, "duplicate"], [1, "duplicate"], [2, "win"]]);
  // an excluded account is skipped every time it is drawn and never wins
  const ex = pickWinners(GOLDEN, GOLDEN_RAND, new Set([GOLDEN.leaves[1].account]));
  assert.deepEqual(ex.winners, [GOLDEN.leaves[0].account, GOLDEN.leaves[2].account]);
  assert.equal(ex.used[1].skip, "excluded");
  assert.equal(ex.used.filter((u) => u.skip === "excluded").length, ex.used.filter((u) => u.index === 1).length);
  // a wide list stops at 10 distinct accounts
  const built = buildList(meta(), accumulate(holders(120), [], V, meta()), []);
  assert.ok(!("skip" in built));
  const w = pickWinners(built.list, 12345n);
  assert.equal(w.winners.length, 10);
  assert.equal(new Set(w.winners).size, 10);
  assert.equal(w.used.filter((u) => !u.skip).length, 10);
  assert.ok(!w.used.at(-1)!.skip, "the walk ends on the 10th winner");
});

test("winnerOf: the leaf whose [cumStart, cumStart + tickets) holds the ticket, at both edges", () => {
  const built = buildList(meta(), accumulate(holders(120), [], V, meta()), []);
  assert.ok(!("skip" in built));
  const L = built.list;
  for (const i of [0, 1, 57, 119]) {
    const l = L.leaves[i];
    assert.equal(winnerOf(L, BigInt(l.cumStart)).index, i);
    assert.equal(winnerOf(L, BigInt(l.cumStart) + BigInt(l.tickets) - 1n).index, i);
    assert.ok(verifyProof(proofOf(built.layers, i), L.root, leafHash(toLeaf(l))));
  }
});
