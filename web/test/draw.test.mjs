// /play/draw's browser check: the same tree as engine/src/tickets.ts and GamePot (the golden vector
// contracts/test/GamePot.t.sol and engine/test/tickets.test.ts pin), proofs for every leaf, the ticket → holder search.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, stringToHex } from "viem";
import { holderOf, leafHash, proofOf, rootOf, ticketAt, tree, verifyProof, walk } from "../app/play/draw/tickets.ts";

const L = [
  { index: 0, account: "0x1111111111111111111111111111111111111111", cumStart: "0", tickets: "5" },
  { index: 1, account: "0x2222222222222222222222222222222222222222", cumStart: "5", tickets: "3" },
  { index: 2, account: "0x3333333333333333333333333333333333333333", cumStart: "8", tickets: "7" },
];

test("the golden vector: leaf hashes, root and proofs as the contract and the engine compute them", () => {
  const t = tree(L.map(leafHash));
  assert.deepEqual(L.map(leafHash), [
    "0x5a329d02646ff492373482f02964df08c6b2faebdc11392292d2b2564f9759cd",
    "0x4ba59f79dc6980bf6b4ade0c1fb219c1806af0b9c084c39fa956c84f39f448a1",
    "0x596f0ad70f0bce67c7c5682d63726425257a002804eededede3cca7a405e9b85",
  ]);
  assert.equal(rootOf(t), "0x3b953545397409c5773e5f6520cfd629d63970a82385f05bb115abb9ebf90198");
  assert.deepEqual(proofOf(t, 2), ["0x7b6271f0e74dca2c0acc6bf899c1462b4850fee661350460d5578607010c9edd"]);
});

test("every leaf's proof verifies for 1..17 leaves; a proof is for its own leaf only", () => {
  for (let n = 1; n <= 17; n++) {
    const leaves = Array.from({ length: n }, (_, i) => ({ index: i, account: `0x${String(i + 1).padStart(40, "0")}`, cumStart: String(i), tickets: "1" }));
    const hs = leaves.map(leafHash);
    const t = tree(hs);
    hs.forEach((h, i) => assert.ok(verifyProof(proofOf(t, i), rootOf(t), h), `n=${n} i=${i}`));
    if (n > 1) assert.ok(!verifyProof(proofOf(t, 0), rootOf(t), hs[n - 1]));
  }
});

test("the 10-winner golden vector: the same tickets and walk as GamePot.t.sol and engine/test/tickets.test.ts", () => {
  const rand = BigInt(keccak256(stringToHex("dna.ten-winners.golden")));
  const t = (total) => Array.from({ length: 12 }, (_, j) => Number(ticketAt(rand, j, total)));
  assert.deepEqual(t(15n), [0, 6, 1, 5, 6, 13, 5, 9, 10, 10, 2, 12]);
  assert.deepEqual(t(1_000_003n), [993783, 57593, 632966, 272017, 880431, 158056, 940297, 250201, 589891, 972677, 164111, 197800]);
  const list = { leaves: L, totalTickets: "15" };
  const w = walk(list, rand);
  assert.equal(w.used.length, 32, "3 accounts: the walk runs to MAX_TICKETS");
  assert.deepEqual(w.winners, L.map((l) => l.account), "tickets 0, 6, then 13 at j = 5");
  assert.deepEqual(w.used.slice(0, 6).map((u) => u.skip ?? "win"), ["win", "win", "duplicate", "duplicate", "duplicate", "win"]);
  const ex = walk(list, rand, new Set([L[1].account]));
  assert.deepEqual(ex.winners, [L[0].account, L[2].account]);
  assert.equal(ex.used[1].skip, "excluded");
});

test("the winning ticket's holder, at both edges of each range", () => {
  const list = { leaves: L };
  for (const [ticket, i] of [[0n, 0], [4n, 0], [5n, 1], [7n, 1], [8n, 2], [14n, 2]]) assert.equal(holderOf(list, ticket).index, i, `ticket ${ticket}`);
});
