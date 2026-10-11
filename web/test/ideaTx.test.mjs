// The idea forms' calls (app/proposals/ideaTx.ts): a submit approves exactly stake + the burned fee, each call is the
// contract's own selector and arguments, and IdeaMarket's reverts read as plain words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeErrorResult, erc20Abi, parseEther, toFunctionSelector } from "viem";
import { approveCall, dnaOf, ideaMarketAbi, PLAIN, plainError, stakeCall, submitCall, submitNeeds } from "../app/proposals/ideaTx.ts";

const T = "0x1111111111111111111111111111111111111111", M = "0x2222222222222222222222222222222222222222";

test("submit approves stake + 1,000 DNA fee; calls carry the contract's selectors", () => {
  assert.equal(submitNeeds(parseEther("10000")), parseEther("11000"));
  const a = approveCall(T, M, parseEther("11000"));
  assert.equal(a.to, T);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: a.data }).args, [M, parseEther("11000")]);
  const s = submitCall(M, "t", "b", parseEther("10000"));
  assert.equal(s.data.slice(0, 10), toFunctionSelector("submit(string,string,uint256)"));
  assert.deepEqual(decodeFunctionData({ abi: ideaMarketAbi, data: s.data }).args, ["t", "b", parseEther("10000")]);
  const k = stakeCall(M, 7n, parseEther("1000"));
  assert.equal(k.data.slice(0, 10), toFunctionSelector("stake(uint256,uint256)"));
});

test("amounts: positive decimals only", () => {
  assert.equal(dnaOf("10000"), parseEther("10000"));
  assert.equal(dnaOf(" 1.5 "), parseEther("1.5"));
  for (const v of ["", "0", "-1", "abc", "1e3"]) assert.equal(dnaOf(v), null, v);
});

test("reverts: IdeaMarket's errors in plain words, wherever the data sits in the cause chain", () => {
  const data = encodeErrorResult({ abi: ideaMarketAbi, errorName: "NotCurrentRound" });
  assert.equal(plainError({ cause: { cause: { data } } }), PLAIN.NotCurrentRound);
  assert.equal(plainError({ data: { data: encodeErrorResult({ abi: ideaMarketAbi, errorName: "TooSmall" }) } }), PLAIN.TooSmall);
  assert.equal(plainError({ data: "0x08c379a0" }), null, "not one of the market's");
  assert.equal(plainError(new Error("user rejected")), null);
});
