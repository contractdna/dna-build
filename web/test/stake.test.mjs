// The stake panel's chain side (app/play/stake.ts): the pinned vault and token, the only four calls the panel may send
// (the exact approval, lock, withdraw, recommit), the amount and term rules, where a position stands, and the vault's
// refusals in plain words.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPublicClient, encodeErrorResult, encodeFunctionData, getAddress, http, keccak256, parseAbi } from "viem";
import { amountProblem, approveCall, checkTx, DNA, fmtDna, lockCall, MAX_BATCH, MIN_LOCK, parseAmount, recommitCall, refusal, STAKE_VAULT, STAKE_VAULT_CODEHASH, stakeAbi, stateOf, TIERS, withdrawCall } from "../app/play/stake.ts";

const OTHER = "0x2222222222222222222222222222222222222222";
const E18 = 10n ** 18n;
const AMT = 25_000n * E18;
const raw = (sig, args) => encodeFunctionData({ abi: parseAbi([sig]), args });

test("the pinned vault and token: the mainnet deployment, a checksummed address and a 32-byte code hash", () => {
  const dep = JSON.parse(readFileSync(new URL("../../engine/deployments/1.json", import.meta.url), "utf8"));
  assert.equal(STAKE_VAULT, dep.convictionVault);
  assert.equal(DNA, dep.token);
  assert.equal(getAddress(STAKE_VAULT), STAKE_VAULT);
  assert.equal(getAddress(DNA), DNA);
  assert.match(STAKE_VAULT_CODEHASH, /^0x[0-9a-f]{64}$/);
  assert.equal(MIN_LOCK, 10_000n * E18);
});

// the pin against mainnet itself: opt in with STAKE_RPC=<an RPC url> (the suite stays offline by default)
test("the pinned code hash and token are what mainnet has at the vault", { skip: !process.env.STAKE_RPC && "set STAKE_RPC to check against mainnet" }, async () => {
  const c = createPublicClient({ transport: http(process.env.STAKE_RPC) });
  assert.equal(keccak256(await c.getCode({ address: STAKE_VAULT })), STAKE_VAULT_CODEHASH);
  assert.equal(await c.readContract({ address: STAKE_VAULT, abi: stakeAbi, functionName: "token" }), DNA);
});

test("the terms: the vault's three tiers with their lengths and multipliers", () => {
  assert.deepEqual(TIERS.map((t) => [t.tier, t.label, t.mult, t.secs]), [[0, "12 hours", "×2", 43_200], [1, "3 days", "×2.5", 259_200], [2, "7 days", "×3", 604_800]]);
});

test("the calls: exactly the vault's functions with the given arguments, no value", () => {
  assert.equal(approveCall(DNA, AMT).to, DNA);
  assert.equal(approveCall(DNA, AMT).data, raw("function approve(address,uint256)", [STAKE_VAULT, AMT]));
  assert.equal(lockCall(AMT, 1).data, raw("function lock(uint256,uint8)", [AMT, 1]));
  assert.equal(withdrawCall([1n, 3n]).data, raw("function withdraw(uint256[])", [[1n, 3n]]));
  assert.equal(recommitCall([2n], 2).data, raw("function recommit(uint256[],uint8)", [[2n], 2]));
  for (const t of [lockCall(AMT, 0), withdrawCall([1n]), recommitCall([1n], 0)]) assert.equal(t.to, STAKE_VAULT);
  for (const t of [approveCall(DNA, AMT), lockCall(AMT, 0), withdrawCall([1n]), recommitCall([1n], 0)]) assert.equal(t.value, 0n);
});

test("checkTx lets through only the exact approval, lock, withdraw and recommit, all with no value", () => {
  assert.ok(checkTx(approveCall(DNA, AMT), DNA, AMT));
  assert.ok(checkTx(lockCall(AMT, 0), DNA, AMT));
  assert.ok(checkTx(lockCall(AMT, 2), DNA, AMT));
  assert.ok(checkTx(withdrawCall([1n, 2n]), DNA, null));
  assert.ok(checkTx(recommitCall([5n], 1), DNA, null));
  assert.ok(!checkTx({ ...lockCall(AMT, 0), value: 1n }, DNA, AMT), "no value");
  assert.ok(!checkTx({ ...withdrawCall([1n]), value: 1n }, DNA, null), "no value");
  assert.ok(!checkTx(approveCall(DNA, AMT), DNA, AMT - 1n), "only the amount typed");
  assert.ok(!checkTx(approveCall(DNA, AMT), DNA, null), "no approval without an amount");
  assert.ok(!checkTx(approveCall(DNA, AMT), OTHER, AMT), "an approval of a token the page was not given");
  assert.ok(!checkTx({ ...approveCall(DNA, AMT), to: OTHER }, DNA, AMT), "an approval sent elsewhere");
  assert.ok(!checkTx({ to: DNA, value: 0n, data: raw("function approve(address,uint256)", [OTHER, AMT]) }, DNA, AMT), "only to the vault");
  assert.ok(!checkTx({ to: DNA, value: 0n, data: raw("function approve(address,uint256)", [STAKE_VAULT, 2n ** 256n - 1n]) }, DNA, AMT), "never unlimited");
  assert.ok(!checkTx({ to: DNA, value: 0n, data: raw("function transfer(address,uint256)", [STAKE_VAULT, AMT]) }, DNA, AMT), "no other token call");
  assert.ok(!checkTx(approveCall(DNA, MIN_LOCK - 1n), DNA, MIN_LOCK - 1n), "never an approval below the minimum");
  assert.ok(!checkTx(lockCall(AMT, 0), DNA, AMT + 1n), "only the amount typed");
  assert.ok(!checkTx(lockCall(AMT, 0), DNA, null), "no lock without an amount");
  assert.ok(!checkTx(lockCall(MIN_LOCK - 1n, 0), DNA, MIN_LOCK - 1n), "never below the minimum");
  assert.ok(!checkTx({ to: STAKE_VAULT, value: 0n, data: raw("function lock(uint256,uint8)", [AMT, 3]) }, DNA, AMT), "no fourth term");
  assert.ok(!checkTx({ to: STAKE_VAULT, value: 0n, data: raw("function recommit(uint256[],uint8)", [[1n], 7]) }, DNA, null), "no fourth term");
  assert.ok(!checkTx({ to: STAKE_VAULT, value: 0n, data: raw("function withdraw(uint256[])", [[]]) }, DNA, null), "no empty batch");
  assert.ok(!checkTx({ to: STAKE_VAULT, value: 0n, data: raw("function withdraw(uint256[])", [[0n]]) }, DNA, null), "no id 0");
  assert.ok(!checkTx(withdrawCall(Array.from({ length: MAX_BATCH + 1 }, (_, i) => BigInt(i + 1))), DNA, null), "batches are capped");
  assert.ok(checkTx(withdrawCall(Array.from({ length: MAX_BATCH }, (_, i) => BigInt(i + 1))), DNA, null));
  assert.ok(!checkTx({ to: STAKE_VAULT, value: 0n, data: `${lockCall(AMT, 0).data}00` }, DNA, AMT), "no trailing bytes");
  assert.ok(!checkTx({ to: STAKE_VAULT, value: 0n, data: `${withdrawCall([1n]).data}${"00".repeat(32)}` }, DNA, null), "no trailing words");
  assert.ok(!checkTx({ to: STAKE_VAULT, value: 0n, data: "0x12345678" }, DNA, null), "no other function");
  assert.ok(!checkTx({ to: STAKE_VAULT, value: 0n, data: raw("function token()", []) }, DNA, null), "no other function");
  assert.ok(!checkTx({ to: STAKE_VAULT, value: 0n, data: raw("function initialize(address)", [OTHER]) }, DNA, null), "no other function");
  assert.ok(!checkTx({ to: STAKE_VAULT, value: 0n, data: approveCall(DNA, AMT).data }, DNA, AMT), "no approval call on the vault");
  assert.ok(!checkTx({ to: OTHER, value: 0n, data: lockCall(AMT, 0).data }, DNA, AMT), "nowhere else");
  assert.ok(!checkTx({ to: OTHER, value: 0n, data: withdrawCall([1n]).data }, DNA, null), "nowhere else");
});

test("amounts: whole or decimal DNA, commas ignored; at least 10,000 and no more than the wallet holds", () => {
  assert.equal(parseAmount("10000"), MIN_LOCK);
  assert.equal(parseAmount("10,000"), MIN_LOCK);
  assert.equal(parseAmount(" 25 000 "), AMT);
  assert.equal(parseAmount("10000."), MIN_LOCK);
  assert.equal(parseAmount("10000.5"), MIN_LOCK + E18 / 2n);
  assert.equal(parseAmount("0.000000000000000001"), 1n);
  for (const bad of ["", ".", "abc", "1e5", "-10000", "1.2.3", "0.0000000000000000001", "0x10"]) assert.equal(parseAmount(bad), null, bad);
  assert.equal(amountProblem(null, null), "Enter an amount of DNA.");
  assert.equal(amountProblem(MIN_LOCK - 1n, null), "The minimum stake is 10,000 DNA.");
  assert.equal(amountProblem(MIN_LOCK, null), null);
  assert.equal(amountProblem(MIN_LOCK, MIN_LOCK), null);
  assert.equal(amountProblem(AMT, MIN_LOCK), "That is more DNA than this wallet holds.");
});

test("fmtDna: exact, with separators, never rounded", () => {
  assert.equal(fmtDna(MIN_LOCK), "10,000");
  assert.equal(fmtDna(1_234_567n * E18 + 1n), "1,234,567.000000000000000001");
  assert.equal(fmtDna(999n * E18), "999");
});

test("stateOf: in term until the term in force ends, then open (withdraw or recommit) until withdrawn", () => {
  const p = { id: 1n, amount: AMT, tier: 1, start: 1_000, withdrawn: false, termStart: 1_000, termTier: 1 };
  const end = 1_000 + 3 * 86_400;
  assert.deepEqual({ ...stateOf(p, end - 1), term: undefined }, { term: undefined, unlock: end, open: false, label: "In term: counts ×2.5" });
  assert.equal(stateOf(p, end).open, true);
  assert.equal(stateOf(p, end).label, "Term over: counts at least ×2 until you withdraw");
  const re = { ...p, termStart: end + 50, termTier: 0 };
  assert.equal(stateOf(re, end + 60).unlock, end + 50 + 43_200, "a recommit's term counts from its own start");
  assert.equal(stateOf(re, end + 60).open, false);
  assert.equal(stateOf(re, end + 60).term.label, "12 hours");
  assert.equal(stateOf({ ...p, withdrawn: true }, end + 1).open, false);
  assert.equal(stateOf({ ...p, withdrawn: true }, end + 1).label, "Withdrawn");
});

test("refusal: the vault's and DNA's custom errors, in plain words with their name, from anywhere in the error chain", () => {
  const err = (data) => ({ shortMessage: "Execution reverted for an unknown reason.", cause: { cause: { data } } });
  assert.equal(refusal(err(encodeErrorResult({ abi: stakeAbi, errorName: "Excluded" }))), "This wallet can't stake: the vault refuses team and operator wallets. (Excluded)");
  assert.equal(refusal(err("0x8a1aee18")), "This wallet can't stake: the vault refuses team and operator wallets. (Excluded)", "the selector the mainnet vault returns");
  assert.match(refusal(err(encodeErrorResult({ abi: stakeAbi, errorName: "TooEarly" }))), /term isn't over yet. \(TooEarly\)$/);
  assert.match(refusal(err(encodeErrorResult({ abi: stakeAbi, errorName: "ERC20InsufficientAllowance", args: [STAKE_VAULT, 0n, AMT] }))), /\(ERC20InsufficientAllowance\)$/);
  assert.match(refusal({ data: { data: encodeErrorResult({ abi: stakeAbi, errorName: "NotOwner" }) } }), /\(NotOwner\)$/);
  assert.equal(refusal(err("0xdeadbeef")), null, "an unknown error");
  assert.equal(refusal(new Error("user rejected")), null);
  assert.equal(refusal(null), null);
});
