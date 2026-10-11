// Mainnet fork check of the calls the site builds: a buy and a sell through swap.ts, then IdeaMarket submit + stake
// through ideaTx.ts, each after its bounded approval, and the market's refusals decoded to plain words.
//   anvil --fork-url <mainnet RPC>          (any mainnet endpoint)
//   node scripts/fork-check.mjs [anvil URL]  (from web/; default http://127.0.0.1:8545)
import assert from "node:assert/strict";
import { createPublicClient, createTestClient, decodeEventLog, erc20Abi, formatEther, http, parseEther } from "viem";
import * as idea from "../app/proposals/ideaTx.ts";
import * as swap from "../app/trade/swap.ts";

const RPC = process.argv[2] ?? "http://127.0.0.1:8545";
const c = createPublicClient({ transport: http(RPC) });
const t = createTestClient({ mode: "anvil", transport: http(RPC) });
const TOKEN = "0x39772D019ed525f667a7cbBF8E64b07120378402", HOOK = "0xC724dd91b41069782A1B3d19a89B1248D2c4Bfff", MARKET = "0x8C13640E90E2Fc886ee0B6fC04f8a88192330dc3";
// fresh addresses (anvil's default accounts carry EIP-7702 sweeper delegations on mainnet: they forward any ETH away)
const [A, B] = ["0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a0001", "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a0002"];
for (const a of [A, B]) {
  assert.equal(await c.getCode({ address: a }), undefined, "a plain account");
  await t.setBalance({ address: a, value: parseEther("100") });
  await t.impersonateAccount({ address: a });
}
const key = swap.poolKey(TOKEN, HOOK);
const send = async (from, tx) => {
  // the swap box's own check passes every trade call (the idea calls go to the market, or approve it)
  if (tx.to !== MARKET && !tx.data.includes(MARKET.slice(2).toLowerCase())) assert.equal(swap.checkTx({ ...tx, value: tx.value ?? 0n }, key), null);
  const hash = await c.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, data: tx.data, value: `0x${(tx.value ?? 0n).toString(16)}` }] });
  const r = await c.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `tx to ${tx.to} reverted`);
  return r;
};
const bal = (a) => c.readContract({ address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const now = async () => (await c.getBlock()).timestamp;

// 1. buy: quote, floor 1%, swap
async function buy(who, eth) {
  const q = swap.readQuote((await c.call(swap.quoteCall(key, true, eth))).data);
  const before = await bal(who);
  await send(who, swap.swapCall(key, true, eth, swap.minOut(q, 100), (await now()) + 600n));
  const got = (await bal(who)) - before;
  assert.ok(got >= swap.minOut(q, 100), "got at least the floor");
  console.log(`buy ${formatEther(eth)} ETH -> ${formatEther(got)} DNA (quote ${formatEther(q)})`);
  return got;
}
await buy(A, parseEther("10"));
await buy(B, parseEther("2"));

// 2. sell: approve DNA -> Permit2, Permit2 -> router, swap
{
  const amt = parseEther("1000");
  const q = swap.readQuote((await c.call(swap.quoteCall(key, false, amt))).data);
  await send(A, swap.approveCall(TOKEN, amt));
  await send(A, swap.permit2Call(TOKEN, amt, Number(await now()) + 4200));
  const e0 = await c.getBalance({ address: A });
  const r = await send(A, swap.swapCall(key, false, amt, swap.minOut(q, 100), (await now()) + 600n));
  const gas = r.gasUsed * r.effectiveGasPrice;
  const at = (n) => c.getBalance({ address: A, blockNumber: n });
  const got = (await at(r.blockNumber)) - (await at(r.blockNumber - 1n)) + gas;
  assert.ok(got >= swap.minOut(q, 100));
  console.log(`sell 1000 DNA -> ${formatEther(got)} ETH`);
}

// 3. submit: approve stake + fee, submit; stake moves to the market, fee burned
{
  const amount = parseEther("10000"), need = idea.submitNeeds(amount);
  assert.equal(need, parseEther("11000"));
  const supply0 = await c.readContract({ address: TOKEN, abi: erc20Abi, functionName: "totalSupply" });
  const [a0, m0] = [await bal(A), await bal(MARKET)];
  // before the approval the call can't go through (the market pulls via the allowance)
  await assert.rejects(c.call({ account: A, ...idea.submitCall(MARKET, "t", "b", amount) }));
  await send(A, idea.approveCall(TOKEN, MARKET, need));
  await c.call({ account: A, ...idea.submitCall(MARKET, "Fork check idea", "Body, ünïcode ok.", amount) }); // the page's simulation
  const r = await send(A, idea.submitCall(MARKET, "Fork check idea", "Body, ünïcode ok.", amount));
  const ev = r.logs.filter((l) => l.address.toLowerCase() === MARKET.toLowerCase()).map((l) => { try { return decodeEventLog({ abi: idea.ideaMarketAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "IdeaSubmitted");
  assert.ok(ev, "IdeaSubmitted emitted");
  assert.equal(ev.args.author.toLowerCase(), A.toLowerCase());
  assert.equal(ev.args.stake, amount);
  assert.equal(a0 - (await bal(A)), need, "author paid stake + fee");
  assert.equal((await bal(MARKET)) - m0, amount, "stake escrowed");
  assert.equal(supply0 - (await c.readContract({ address: TOKEN, abi: erc20Abi, functionName: "totalSupply" })), idea.SUBMIT_FEE, "fee burned");
  assert.equal(await c.readContract({ address: TOKEN, abi: erc20Abi, functionName: "allowance", args: [A, MARKET] }), 0n, "approval used up exactly");
  console.log(`submit: idea #${ev.args.id} round ${ev.args.round}, stake 10,000, fee 1,000 burned`);

  // 4. stake from B on that idea
  const id = ev.args.id, s = parseEther("1500");
  await send(B, idea.approveCall(TOKEN, MARKET, s));
  await send(B, idea.stakeCall(MARKET, id, s));
  assert.equal(await c.readContract({ address: MARKET, abi: idea.ideaMarketAbi, functionName: "stakeOf", args: [id, B] }), s);
  const [, , staked] = await c.readContract({ address: MARKET, abi: idea.ideaMarketAbi, functionName: "ideas", args: [id] });
  assert.equal(staked, amount + s);
  console.log(`stake: B staked 1,500 on #${id}; idea total ${formatEther(staked)}`);

  // 5. refusals in plain words (what the page shows instead of sending)
  const why = async (from, call) => { try { await c.call({ account: from, ...call }); return "no revert"; } catch (e) { return idea.plainError(e); } };
  await send(B, idea.approveCall(TOKEN, MARKET, parseEther("999")));
  assert.equal(await why(B, idea.stakeCall(MARKET, id, parseEther("999"))), idea.PLAIN.TooSmall);
  assert.equal(await why(B, idea.stakeCall(MARKET, 999n, parseEther("1000"))), idea.PLAIN.UnknownIdea);
  assert.equal(await why(A, idea.submitCall(MARKET, "", "x", amount)), idea.PLAIN.BadText);
  assert.equal(await why(A, idea.submitCall(MARKET, "x", "y", parseEther("9999"))), idea.PLAIN.TooSmall);
  // a round later the idea's round is closed
  await t.increaseTime({ seconds: 86_400 }); await t.mine({ blocks: 1 });
  await send(B, idea.approveCall(TOKEN, MARKET, parseEther("1000")));
  assert.equal(await why(B, idea.stakeCall(MARKET, id, parseEther("1000"))), idea.PLAIN.NotCurrentRound);
  console.log("refusals decode: TooSmall, UnknownIdea, BadText, NotCurrentRound");
}
console.log("FORK CHECK PASSED");
