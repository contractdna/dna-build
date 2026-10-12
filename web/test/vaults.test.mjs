// The vaults page's chain side (app/vaults/vaults.ts): the pinned contract, the only four calls the page may send
// (and the exact approval), the 50-slot layout and the on-chain image it is willing to show.
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import { approveCall, ART_BASE, artOf, burnCall, checkTx, claimCall, DEPOSIT, MAX_LIVE, mintCall, OPENSEA_URL, slotsOf, VAULTS, VAULTS_CODEHASH, withdrawCall } from "../app/vaults/vaults.ts";

const TOKEN = "0x39772D019ed525f667a7cbBF8E64b07120378402";
const OTHER = "0x2222222222222222222222222222222222222222";

test("the pinned contract: a checksummed address and a 32-byte code hash", () => {
  assert.equal(getAddress(VAULTS), VAULTS);
  assert.match(VAULTS_CODEHASH, /^0x[0-9a-f]{64}$/);
  assert.equal(OPENSEA_URL, `https://opensea.io/assets/ethereum/${VAULTS}`);
  assert.equal(DEPOSIT, 200_000n * 10n ** 18n);
  assert.equal(MAX_LIVE, 50);
});

test("checkTx lets through only the exact approval, mint, claim(id), burn(id) and withdraw(to), all with no value", () => {
  assert.ok(checkTx(approveCall(TOKEN), TOKEN));
  assert.ok(checkTx(mintCall(), TOKEN));
  assert.ok(checkTx(claimCall(7n), TOKEN));
  assert.ok(checkTx(burnCall(7n), TOKEN));
  assert.ok(checkTx(withdrawCall(OTHER), null));
  assert.ok(!checkTx({ ...mintCall(), value: 1n }, TOKEN), "no value");
  assert.ok(!checkTx(approveCall(TOKEN), OTHER), "an approval of a token the page was not given");
  assert.ok(!checkTx({ ...approveCall(TOKEN), to: OTHER }, TOKEN), "an approval sent elsewhere");
  const bigger = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [VAULTS, DEPOSIT + 1n] });
  assert.ok(!checkTx({ to: TOKEN, value: 0n, data: bigger }, TOKEN), "only the exact amount");
  const elsewhere = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [OTHER, DEPOSIT] });
  assert.ok(!checkTx({ to: TOKEN, value: 0n, data: elsewhere }, TOKEN), "only to the vaults");
  assert.ok(!checkTx({ to: VAULTS, value: 0n, data: "0x12345678" }, TOKEN), "no other function");
  assert.ok(!checkTx({ to: VAULTS, value: 0n, data: `${mintCall().data}00` }, TOKEN), "no trailing bytes");
  assert.ok(!checkTx({ to: OTHER, value: 0n, data: mintCall().data }, TOKEN), "nowhere else");
});

test("slotsOf: 50 slots in order, taken ones carrying their token", () => {
  const t = (slot, id) => ({ id, slot, owner: OTHER, earned: 0n, pending: 0n, eligible: true });
  const slots = slotsOf([t(17, 51n), t(1, 1n)]);
  assert.equal(slots.length, 50);
  assert.equal(slots[0].n, 1);
  assert.equal(slots[0].token.id, 1n);
  assert.equal(slots[16].token.id, 51n);
  assert.equal(slots[1].token, null);
  assert.equal(slots[49].n, 50);
});

test("the slot art: the same https base the contract was deployed with, one jpg per slot", () => {
  assert.equal(ART_BASE, "https://genomedna.xyz/vaults/art/");
  assert.equal(artOf(7), "https://genomedna.xyz/vaults/art/7.jpg");
});
