// The collect panel's chain side (app/play/collect.ts): the pinned pot, which records a wallet may still collect, the
// one call it sends, and the pot's refusals in plain words.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeFunctionData, encodeErrorResult, getAddress } from "viem";
import { CLAIM_WINDOW, collectable, collectCall, destProblem, GAME_POT, GAME_POT_CODEHASH, potAbi, potRefusal } from "../app/play/collect.ts";

const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

test("the pinned pot: the mainnet deployment, checksummed, a 32-byte code hash, the contract's 7-day window", () => {
  const dep = JSON.parse(readFileSync(new URL("../../engine/deployments/1.json", import.meta.url), "utf8"));
  assert.equal(GAME_POT, dep.gamePot);
  assert.equal(getAddress(GAME_POT), GAME_POT);
  assert.match(GAME_POT_CODEHASH, /^0x[0-9a-f]{64}$/);
  const sol = readFileSync(new URL("../../contracts/src/GamePot.sol", import.meta.url), "utf8");
  assert.match(sol, /CLAIM_WINDOW = 7 days/);
  assert.equal(CLAIM_WINDOW, 7 * 86_400);
});

test("collectable: only this wallet's (any case) with an amount still on-chain; past 7 days stays until expireClaim zeroes it", () => {
  const now = 1_800_000_000;
  const rows = [
    { id: 1n, winner: ME, amount: 5n, wonAt: now - 100 },
    { id: 2n, winner: OTHER, amount: 5n, wonAt: now - 100 },
    { id: 3n, winner: ME.toUpperCase().replace("0X", "0x"), amount: 7n, wonAt: now - CLAIM_WINDOW + 1 },
    { id: 4n, winner: ME, amount: 0n, wonAt: now - 100 },            // collected or expired on-chain
    { id: 5n, winner: ME, amount: 9n, wonAt: now - CLAIM_WINDOW },   // still collectable until someone calls expireClaim
  ];
  assert.deepEqual(collectable(rows, ME).map((o) => o.id), [1n, 3n, 5n]);
});

test("collectCall: value 0, to the pot, claim(ids, to) and nothing else", () => {
  const t = collectCall([1n, 3n], OTHER);
  assert.equal(t.to, GAME_POT);
  assert.equal(t.value, 0n);
  const d = decodeFunctionData({ abi: potAbi, data: t.data });
  assert.equal(d.functionName, "claim");
  assert.deepEqual(d.args, [[1n, 3n], OTHER]);
});

test("potRefusal: the pot's errors in plain words, anything else null", () => {
  assert.match(potRefusal({ data: encodeErrorResult({ abi: potAbi, errorName: "NotWinner" }) }), /isn't this wallet's.*NotWinner/);
  assert.match(potRefusal({ cause: { data: encodeErrorResult({ abi: potAbi, errorName: "AlreadyClaimed" }) } }), /already collected.*AlreadyClaimed/);
  assert.equal(potRefusal(new Error("user rejected")), null);
});

test("destProblem: a real address passes (any case); junk, 0x0 and the pot itself are refused", () => {
  assert.equal(destProblem(OTHER), null);
  assert.equal(destProblem(getAddress(OTHER)), null);
  assert.match(destProblem("0x123"), /enter the address/);
  assert.match(destProblem("0x0000000000000000000000000000000000000000"), /lose the prize/);
  assert.match(destProblem(GAME_POT.toLowerCase()), /lose the prize/);
});
