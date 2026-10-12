// The X idea filter end to end against a real Postgres and a fake IdeaMarket: GATE → SCREEN (the synthetic quarantined
// reader) → candidates of the current round → at the next round the top 16 by score are submitted, the rest are "not in
// the top 16"; every decision an `intake` record with its public reason. Plus the round clock (ROUND_LENGTH from the
// contract) and the 3-day all-void for an unjudged round.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { type Abi, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult, type Hex, keccak256, parseGwei, parseTransaction, toHex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { feeHistory, startFakes } from "../scripts/fakes.ts";
import { synthetic } from "../scripts/synthetic.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
fakes.llm.xai = (b) => synthetic("xai", b);
const dbName = `dna_intake_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc`, ENGINE_MODE: "live", TX_POLL_MS: "5", LLM_MODE: "live", XAI_API_BASE: fakes.url, XAI_API_KEY: "k", OPENROUTER_API_BASE: fakes.url, OPENROUTER_API_KEY_ENGINE: "k",
    AGENT_PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", X_USER_ID: "42",
  });
}
const { edb: sql, migrate } = await import("../src/db.ts");
const abi = await import("../src/abi.ts");
const ideas = await import("../src/ideas.ts");
const tx = await import("../src/tx.ts");
const modeM = await import("../src/mode.ts");
const approve = await import("../src/approve.ts");
const OWNERS = [1, 2, 3].map((n) => privateKeyToAccount(`0x${n.toString(16).padStart(64, "0")}`));
const { d } = await import("../src/config.ts");

before(async () => { if (ADMIN) { await migrate(); await modeM.initMode(); } });
after(async () => {
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await fakes.close();
});

const job = () => ({ id: "0", kind: "t", payload: {}, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null }) as never;
const agent = tx.addressOf("agent")!;
const LEN = 86_400;
const RESOLVE = 3 * 86_400; // IdeaMarket.RESOLVE_WINDOW
const proposals: { round: number; at: number }[] = [];
const T = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- fake chain: IdeaMarket + the registry's agent views
const st = { now: T, round: 0, start: T - 3600, rounds: {} as Record<number, [number, number, number, number, number, string]>, sent: [] as { title: string; body: string }[], ideaId: 0 };
const receipts = new Map<string, unknown[]>();
const ABIS: [string, readonly unknown[]][] = [[d.ideaMarket!, abi.ideaMarketAbi], [d.registry, abi.registryAbi]];
const abiOf = (to: string) => ABIS.find(([a]) => a.toLowerCase() === to.toLowerCase())?.[1] as Abi | undefined;
const VIEW: Record<string, (args: readonly unknown[]) => unknown> = {
  agent: () => agent, agentPaused: () => false, currentRound: () => BigInt(st.round), ROUND_LENGTH: () => BigInt(LEN), RESOLVE_WINDOW: () => BigInt(RESOLVE),
  roundEnd: ([r]) => BigInt(st.start + (Number(r) + 1) * LEN), rounds: ([r]) => [...(st.rounds[Number(r)] ?? [0, 0, 0, 0, 0, zeroAddress]), 0n, 0n, 0n, 0n],
};
Object.assign(fakes.rpc, {
  eth_chainId: () => toHex(31337),
  eth_blockNumber: () => toHex(1000n),
  eth_getBlockByNumber: () => ({ number: toHex(1000n), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"00".repeat(32)}`, timestamp: toHex(st.now), baseFeePerGas: toHex(parseGwei("1")), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], miner: zeroAddress, difficulty: "0x0", extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, size: "0x0", stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, uncles: [], totalDifficulty: "0x0", mixHash: `0x${"00".repeat(32)}` }),
  eth_maxPriorityFeePerGas: () => "0x0", // what public RPCs answer: never read (fees come from eth_feeHistory)
  eth_feeHistory: (p: unknown[]) => feeHistory(p, parseGwei("1")),
  eth_estimateGas: ([c]: [{ to: string; data: Hex }]) => {
    // IdeaMarket.proposeOutcome only in [roundEnd, roundEnd + RESOLVE_WINDOW): OutsideWindow otherwise
    const f = c.to?.toLowerCase() === d.ideaMarket!.toLowerCase() ? decodeFunctionData({ abi: abi.ideaMarketAbi, data: c.data }) : undefined;
    if (f?.functionName === "proposeOutcome") {
      const end = st.start + (Number(f.args![0]) + 1) * LEN;
      if (st.now < end || st.now >= end + RESOLVE) throw Object.assign(new Error("execution reverted"), { code: 3, data: encodeErrorResult({ abi: abi.ideaMarketAbi, errorName: "OutsideWindow" }) });
    }
    return toHex(100_000n);
  },
  eth_call: ([c]: [{ to: string; data: Hex }]) => {
    const a = abiOf(c.to);
    if (!a) return "0x";
    const { functionName, args = [] } = decodeFunctionData({ abi: a, data: c.data });
    return encodeFunctionResult({ abi: a, functionName, result: VIEW[functionName](args) as never });
  },
  eth_getTransactionCount: () => toHex(st.sent.length),
  eth_sendRawTransaction: ([raw]: [Hex]) => {
    const t = parseTransaction(raw);
    const call = decodeFunctionData({ abi: abi.ideaMarketAbi, data: t.data! });
    if (call.functionName === "proposeOutcome") { proposals.push({ round: Number(call.args[0]), at: st.now }); receipts.set(keccak256(raw), []); return keccak256(raw); }
    const { args } = call as unknown as { args: [string, string, bigint] };
    st.sent.push({ title: args[0], body: args[1] });
    const r = st.rounds[st.round] ?? [0, 0, 0, 0, 0, zeroAddress];
    st.rounds[st.round] = [r[0], r[1] + 1, r[2] + 1, r[3], r[4], r[5]];
    const id = BigInt(++st.ideaId);
    receipts.set(keccak256(raw), [{
      address: d.ideaMarket, topics: encodeEventTopics({ abi: abi.ideaMarketAbi, eventName: "IdeaSubmitted", args: { id, round: BigInt(st.round), author: agent } }),
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "string" }, { type: "string" }], [BigInt(r[1]), 0n, args[0], args[1]]),
      blockNumber: toHex(1000n), logIndex: "0x0", transactionHash: keccak256(raw), transactionIndex: "0x0", blockHash: `0x${"22".repeat(32)}`, removed: false,
    }]);
    return keccak256(raw);
  },
  eth_getTransactionReceipt: ([h]: [string]) => ({ transactionHash: h, transactionIndex: "0x0", blockHash: `0x${"22".repeat(32)}`, blockNumber: toHex(1000n), from: agent, to: d.ideaMarket,
    cumulativeGasUsed: "0xc350", gasUsed: "0xc350", effectiveGasPrice: toHex(parseGwei("2")), contractAddress: null, logs: receipts.get(h) ?? [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2" }),
});

const GATED_IN = { verified_type: "blue", created_at: "2020-01-01T00:00:00.000Z", public_metrics: { followers_count: 1000 } };
let next = 5000;
const mention = async (author: string, text: string, user: Record<string, unknown> = GATED_IN) => {
  const id = String(next++);
  await sql`insert into x_mention (id, author_id, text, created_at, raw) values (${id}, ${author}, ${text}, now(), ${sql.json({ id, text, user } as never)})`;
  return id;
};
const intake = async (id: string) => (await sql<{ status: string; reason: string | null; score: number | null; submit_round: number | null }[]>`select status, reason, score, submit_round from intake where mention_id = ${id}`)[0];
const rec = async (id: string) => (await sql<{ doc: { status: string; reason: string } }[]>`select doc from log where kind = 'intake' and ref = ${id} order by seq desc limit 1`)[0]?.doc;
const TOPICS = ["night fees", "liquidity share", "buyback cadence", "canary length", "cap for whales", "fee for small swaps", "split to burn", "bounty for audits",
  "volatility multiplier", "weekend discount", "router rebate", "lp boost on dips", "treasury floor", "fee holiday", "burn on spikes", "arb tax", "slow cap", "flat base"];

test("intake: gate → screen → candidates; at the next round the top 16 by score are submitted, the rest not picked; reasons public, never replies", { skip }, async () => {
  const good = await mention("71", "@contractdna lower the base fee during quiet night hours so that small traders keep swapping");
  const noBadge = await mention("72", "@contractdna raise the cap a little when volume is very high to earn more", { ...GATED_IN, verified_type: "none" });
  const young = await mention("73", "@contractdna split more of the fee into buyback when the price is falling", { ...GATED_IN, created_at: new Date().toISOString() });
  const few = await mention("74", "@contractdna pay a bounty for every audit finding on the hook modules", { ...GATED_IN, public_metrics: { followers_count: 3 } });
  const second = await mention("71", "@contractdna also add a liquidity boost when the pool gets thin overnight");
  const link = await mention("75", "@contractdna read my fee idea here https://t.co/abc123 it is good");
  const dup = await mention("76", "lower the base fee during the quiet night hours so that small traders keep swapping @contractdna");
  const joke = await mention("77", "@contractdna make the fee a joke lol");
  const shill = await mention("78", "@contractdna everyone buy this token now it will moon tonight");
  const own = await mention("42", "@contractdna our own post about fees and liquidity tonight");
  const many: string[] = [];
  const FILL = ["alpha", "bravo charlie", "delta echo foxtrot", "golf hotel india juliet", "kilo lima", "mike november oscar", "papa quebec", "romeo sierra tango",
    "uniform victor", "whiskey xray yankee", "zulu amber", "basalt cobalt dune", "ember fjord", "garnet harbor islet", "jasper kelp", "lagoon mesa nectar", "onyx prairie"];
  for (const [i, t] of TOPICS.slice(0, 14).entries()) many.push(await mention(String(800 + i), `@contractdna ${t} ${FILL[i]}`));
  const out = { ...(await ideas.intakeHandler.run(job())) as Record<string, string>, ...(await ideas.intakeHandler.run(job())) as Record<string, string> }; // ≤ 20 mentions a run
  assert.equal(st.sent.length, 0, "nothing is submitted while its round is open");
  assert.deepEqual(
    [good, noBadge, young, few, second, link, dup, joke, shill, own].map((id) => out[id]),
    ["candidate", "candidate", "candidate", "candidate", "gated", "gated", "gated", "screened", "screened", "skipped"], // no badge, account age or follower count needed
    JSON.stringify(await sql`select mention_id, status, reason from intake order by mention_id`),
  );
  assert.match((await intake(second)).reason!, /already 1 idea from this author this round/);
  assert.match((await intake(link)).reason!, /links are not allowed/);
  assert.match((await intake(dup)).reason!, /near-duplicate/);
  assert.equal((await intake(joke)).reason, "screened as joke");
  assert.equal((await intake(shill)).reason, "screened as shill");
  assert.match((await rec(link)).reason, /links are not allowed/, "the reason is public, in the log");
  assert.equal((await sql`select 1 from x_outbox where type = 'reply'`).length, 0, "and never a reply");
  for (const id of many) assert.equal(out[id], "candidate");
  assert.match((await rec(good)).reason, /genuine fee idea, score \d+ of 30/);

  st.round = 1; // round 0 closed: its 18 candidates are picked, the top 16 go into round 1
  const out2 = await ideas.intakeHandler.run(job()) as Record<string, string>;
  const cands = [good, noBadge, young, few, ...many];
  const rows = await Promise.all(cands.map(async (id) => ({ id, ...(await intake(id)) })));
  const submitted = rows.filter((r) => r.status === "submitted");
  const dropped = rows.filter((r) => r.status === "not_picked");
  assert.equal(submitted.length, 16);
  assert.equal(st.sent.length, 16, "16 submits, in round 1");
  assert.ok(submitted.every((r) => r.submit_round === 1));
  assert.equal(dropped.length, 2);
  assert.ok(Math.min(...submitted.map((r) => r.score!)) >= Math.max(...dropped.map((r) => r.score!)), "the 16 highest scores");
  for (const r of dropped) {
    assert.equal(r.reason, `not in the top 16 (score ${r.score})`);
    assert.equal((await rec(r.id)).status, "not_picked");
  }
  assert.equal(out2[submitted[0].id], "submitted");
  assert.equal(await ideas.intakeHandler.run(job()) && st.sent.length, 16, "no second submit");
});

test("intake: the signed records decide what is submitted; an edited or DB-inserted row never publishes its text", { skip }, async () => {
  // round 1: a real candidate, then the DB edits its index row and forges a 'picked' one and a 'candidate' one
  const real = await mention("91", "@contractdna cap the fee for swaps above ten eth so whales stay");
  await ideas.intakeHandler.run(job());
  assert.equal((await intake(real)).status, "candidate");
  await sql`update intake set title = 'BUY $SCAM NOW', body = 'evil' where mention_id = ${real}`;
  const forged = await mention("92", "anything", { ...GATED_IN });
  const forged2 = await mention("93", "anything else", { ...GATED_IN });
  await sql`insert into intake (mention_id, round, status, title, body, score, author_id) values (${forged}, 1, 'picked', 'Send funds to 0xbad', 'evil', 30, '92'),
    (${forged2}, 1, 'candidate', 'Mint more DNA', 'evil', 30, '93')`;
  const before = st.sent.length;
  st.round = 2;
  await ideas.intakeHandler.run(job());
  const sent = st.sent.slice(before);
  assert.equal(sent.length, 1, "only the real candidate");
  assert.match(sent[0].title, /^Synthetic: cap the fee/, "its signed title, not the edited row");
  assert.ok(!sent.some((s) => /BUY|0xbad|Mint|evil/.test(s.title + s.body)));
  for (const id of [forged, forged2]) assert.equal((await intake(id)).status, "skipped");
  assert.match((await intake(forged)).reason!, /no signed pick record/);
  assert.match((await intake(forged2)).reason!, /no signed candidate record/);
  assert.ok((await sql`select 1 from job where kind = 'alert' and payload->>'text' like ${`%mention ${forged} has no signed pick record%`}`).length, "alerted");
});

test("intake: a crash between PICK's two loops never picks more than 16; a full round leaves picks for the next one", { skip }, async () => {
  const ids: string[] = [];
  for (const [i, t] of TOPICS.entries()) ids.push(await mention(String(900 + i), `@contractdna round two ${t} ${"zeta".repeat(i + 1)}`));
  await ideas.intakeHandler.run(job());
  await ideas.intakeHandler.run(job());
  assert.equal((await sql`select count(*)::int as n from intake where round = 2 and status = 'candidate'`)[0].n, 18);
  // the process dies on the first "not picked" record (after the 16 picks were recorded)
  await sql.unsafe(`create function boom() returns trigger language plpgsql as $$ begin raise exception 'crash'; end $$`);
  await sql.unsafe(`create trigger boom before insert on log for each row when (new.kind = 'intake' and new.body like '%"status":"not_picked"%') execute function boom()`);
  st.round = 3;
  st.rounds[3] = [0, 0, 10, 0, 0, zeroAddress]; // round 3 has room for 6 more agent ideas
  try {
    await assert.rejects(ideas.intakeHandler.run(job()), /crash/);
  } finally {
    await sql.unsafe("drop trigger boom on log; drop function boom()");
  }
  const before = st.sent.length;
  await ideas.intakeHandler.run(job());
  const count = async (s: string) => (await sql<{ n: number }[]>`select count(*)::int as n from intake where round = 2 and status = ${s} and mention_id = any(${ids})`)[0].n;
  assert.equal(await count("not_picked"), 2, "the rerun picks 16 − 16 = 0 more");
  assert.equal(st.sent.length - before, 6, "a full round 3 takes 6");
  assert.deepEqual([await count("submitted"), await count("picked")], [6, 10], "the other 10 stay picked (not 'full')");
  // one of them landed in round 3 after all (its receipt lost): seen in round 4 as current − 1, never sent again
  const [waiting] = await sql<{ mention_id: string }[]>`select mention_id from intake where status = 'picked' and round = 2 order by mention_id limit 1`;
  await sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (950, 0, '0x2', '0x', now(), '0x', 'IdeaSubmitted',
    ${sql.json({ id: "999", round: "3", index: "15", title: "t", body: `b\n\n(from X mention ${waiting.mention_id})`, author: agent.toLowerCase(), stake: "0" } as never)})`;
  st.round = 4;
  const mid = st.sent.length;
  await ideas.intakeHandler.run(job());
  assert.equal(st.sent.length - mid, 9, "the 9 still waiting go into round 4");
  assert.deepEqual([await count("submitted"), await count("picked")], [16, 0]);
  assert.equal((await sql<{ r: number }[]>`select submit_round as r from intake where mention_id = ${waiting.mention_id}`)[0].r, 3);
});

test("intake: a build idea is a candidate with its class; an impossible one is screened out with the fixed reason", { skip }, async () => {
  const build = await mention("96", "@contractdna a small daily lottery game paid from the games pot for quiet weekends");
  const mint = await mention("97", "@contractdna mint extra supply every month for the most loyal wallets out there");
  const out = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.deepEqual([out[build], out[mint]], ["candidate", "screened"]);
  const r = await sql<{ doc: { class: string; reason: string } }[]>`select doc from log where kind = 'intake' and ref = ${build} order by seq desc limit 1`;
  assert.equal(r[0].doc.class, "build");
  assert.match(r[0].doc.reason, /^genuine build idea, score/);
  assert.match((await intake(mint)).reason!, /^impossible: it needs a change to the immutable hook or token, minting/);
});

test("intake: an address mention binds a payout wallet by X user id (no model), once; a rebinding waits 48 h; one fixed reply", { skip }, async () => {
  const { latestBinding, bindingsOf } = await import("../src/bindings.ts");
  const A = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", B = `0x${"b2".repeat(20)}`;
  const llmCalls = async () => (await sql<{ n: number }[]>`select count(*)::int as n from log where kind = 'llm'`)[0].n;
  const before = await llmCalls();
  const first = await mention("98", `@contractdna ${A}`); // the binding format: @handles and one address, nothing else
  const bad = await mention("98", `@contractdna ${A.replace("a", "A")}`);
  const ungated = await mention("99", `@contractdna ${B}`, { ...GATED_IN, created_at: new Date().toISOString() });
  const out = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.deepEqual([out[first], out[bad], out[ungated]], ["binding", "skipped", "gated"]);
  assert.equal(await llmCalls(), before, "no model read any of them");
  assert.match((await intake(bad)).reason!, /binding refused: the address fails its checksum/);
  assert.match((await intake(ungated)).reason!, /^binding: account younger than 7 days/);
  // no reply for a refused or gated binding, and its outbox row is skipped so the replies job never waits on it
  const outbox = async (id: string) => (await sql<{ status: string; type: string }[]>`select status, type from x_outbox where reply_to = ${id}`).map((r) => `${r.type}:${r.status}`);
  for (const id of [bad, ungated]) assert.deepEqual(await outbox(id), ["reply:skipped"], id);
  assert.equal((await latestBinding("98"))?.address, A);
  assert.equal(await latestBinding("99"), undefined);
  const [reply] = await sql<{ event: { event: string }; reply_to: string }[]>`select event, reply_to from x_outbox where event_key = ${`reply:${first}`}`;
  assert.deepEqual([reply.event.event, reply.reply_to], ["binding_reply", first]);
  assert.equal((await sql`select 1 from log where kind = 'announce' and doc->>'type' = 'binding_linked'`).length, 1, "on the site");
  assert.equal((await sql`select 1 from x_outbox where type = 'post' and event->>'event' like 'binding%'`).length, 0, "never an X post");
  // the replies job leaves binding mentions to the intake (no second reply)
  const x = await import("../src/x.ts");
  await x.repliesHandler.run(job());
  assert.equal((await sql`select 1 from x_outbox where reply_to = ${first}`).length, 1);
  // the same wallet again: nothing new; another wallet: a rebinding in force 48 h later, the old one stays until then
  const again = await mention("98", `@contractdna ${A.toLowerCase()}`);
  const re = await mention("98", `@contractdna ${B}`);
  const out2 = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.deepEqual([out2[again], out2[re]], ["binding", "binding"]);
  assert.equal((await intake(again)).reason, "binding: this wallet is already bound");
  assert.match((await intake(re)).reason!, /^binding: a new wallet, in force from /);
  const recs = await bindingsOf("98");
  assert.equal(recs.length, 2);
  assert.equal(Date.parse(recs[1].effectiveAt) - Date.parse(recs[1].at), 48 * 3600_000);
  assert.equal((await latestBinding("98"))?.address, A, "still the first until the 48 h pass");
  assert.equal((await latestBinding("98", Date.parse(recs[1].effectiveAt)))?.address.toLowerCase(), B);
  assert.deepEqual(await outbox(again), ["reply:skipped"], "no reply when nothing changed");
  assert.deepEqual(await outbox(re), ["reply:skipped"], "a wallet change is announced on the site only, never replied to");
  // at most 3 binding records a day per account: a 3rd is fine, a 4th is refused (no record, no reply)
  const third = await mention("98", `@contractdna 0x${"c3".repeat(20)}`);
  const fourth = await mention("98", `@contractdna 0x${"d4".repeat(20)}`);
  const out3 = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.deepEqual([out3[third], out3[fourth]], ["binding", "gated"]);
  assert.equal((await intake(fourth)).reason, "binding: more than 3 wallet bindings in 24 hours");
  assert.equal((await bindingsOf("98")).length, 3);
  assert.deepEqual(await outbox(fourth), ["reply:skipped"]);
  // an address inside other words never binds ("send me ETH 0x… i'm a holder")
  const loose = await mention("97", `@contractdna send me ETH ${A} i'm a long term holder`);
  const out4 = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.notEqual(out4[loose], "binding");
  assert.equal(await latestBinding("97"), undefined);
});

test("intake: a question screened out uses no idea slot: the same author's real idea later in the round gets in", { skip }, async () => {
  const q = await mention("95", "@contractdna what is the fee cap?");
  const idea = await mention("95", "@contractdna route part of the platform share into deeper liquidity on quiet days");
  const out = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.deepEqual([out[q], out[idea]], ["screened", "candidate"]);
  assert.equal((await intake(q)).reason, "screened as question", "a question is never spam");
});

/** A mention whose text (handles stripped) is exactly `len` characters: the synthetic reader scores it
 *  (4 + len % 7) + 6 + (3 + len % 5), so 35 → 13 and 34 → 23. */
const sized = (words: string, len: number) => `@contractdna ${(words + " " + "q".repeat(len)).slice(0, len)}`;
const full = (r: number, agentIdeas: number) => { st.rounds[r] = [0, 0, agentIdeas, 0, 0, zeroAddress]; };

test("intake SUBMIT: an old round's backlog drains first; a lost receipt is found in any round; a crash after the submitted record is no forgery", { skip }, async () => {
  // round 5: two low scores (13); round 6 is full, so both wait picked
  st.round = 5;
  const a = await mention("601", sized("older alpha bravo charlie", 35));
  const b = await mention("602", sized("older delta echo foxtrot", 35));
  await ideas.intakeHandler.run(job());
  st.round = 6; full(6, 16);
  // round 6 brings two high scores (23)
  const c = await mention("603", sized("newer golf hotel india", 34));
  const dd = await mention("604", sized("newer juliet kilo lima", 34));
  await ideas.intakeHandler.run(job());
  assert.deepEqual([(await intake(a)).status, (await intake(c)).status], ["picked", "candidate"]);
  assert.ok((await intake(c)).score! > (await intake(a)).score!);
  // round 7 has room for 2: the older backlog goes first, whatever the scores
  st.round = 7; full(7, 14);
  const before = st.sent.length;
  await ideas.intakeHandler.run(job());
  assert.deepEqual(st.sent.slice(before).map((x) => x.title), [`Synthetic: ${sized("older alpha bravo charlie", 35).slice(13)}`, `Synthetic: ${sized("older delta echo foxtrot", 35).slice(13)}`]);
  assert.deepEqual([(await intake(a)).status, (await intake(b)).status, (await intake(c)).status, (await intake(dd)).status], ["submitted", "submitted", "picked", "picked"]);

  // c landed in round 7 after all (its receipt lost); the engine was down until round 9: c is never sent again
  await sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (960, 0, '0x3', '0x', now(), '0x', 'IdeaSubmitted',
    ${sql.json({ id: "1001", round: "7", index: "15", title: "t", body: `b\n\n(from X mention ${c})`, author: agent.toLowerCase(), stake: "0" } as never)})`;
  // and the process dies right after dd's `submitted` record, before its index update
  await sql.unsafe(`create function boom2() returns trigger language plpgsql as $$ begin raise exception 'crash'; end $$`);
  await sql.unsafe(`create trigger boom2 before update on intake for each row when (new.status = 'submitted' and new.mention_id = '${dd}') execute function boom2()`);
  st.round = 9; full(9, 0);
  const mid = st.sent.length;
  try {
    await assert.rejects(ideas.intakeHandler.run(job()), /crash/);
  } finally {
    await sql.unsafe("drop trigger boom2 on intake; drop function boom2()");
  }
  assert.equal(st.sent.length - mid, 1, "only dd went out; c had landed in round 7");
  assert.deepEqual([(await intake(c)).status, (await intake(c)).submit_round], ["submitted", 7]);
  assert.equal((await intake(dd)).status, "picked", "the index still says picked");
  await ideas.intakeHandler.run(job());
  assert.equal(st.sent.length - mid, 1, "never resent");
  assert.deepEqual([(await intake(dd)).status, (await intake(dd)).submit_round], ["submitted", 9], "synced from the record");
  assert.equal((await sql`select 1 from job where kind = 'alert' and payload->>'text' like ${`%mention ${dd} has no signed%`}`).length, 0, "no false forgery alert");
});

test("intake: a mention whose index row was lost is restored from its signed record, never re-screened", { skip }, async () => {
  const id = await mention("605", "@contractdna tilt the split toward burns whenever the pool is deep and calm");
  await ideas.intakeHandler.run(job());
  const was = await intake(id);
  assert.equal(was.status, "candidate");
  await sql`delete from intake where mention_id = ${id}`; // a crash between the candidate record and the index insert
  const out = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.equal(out[id], "restored (candidate)");
  assert.deepEqual(await intake(id), was);
  assert.equal((await sql`select count(*)::int as n from log where kind = 'intake' and ref = ${id} and doc->>'status' = 'candidate'`)[0].n, 1, "screened once");
});

test("round clock: START = roundEnd(0) − ROUND_LENGTH, both read from the contract", { skip }, async () => {
  const { ideaMarketClock } = await import("../src/indexer.ts");
  const c = { readContract: async ({ functionName }: { functionName: string }) => (functionName === "ROUND_LENGTH" ? BigInt(LEN) : BigInt(1_700_000_000 + LEN)) } as never;
  assert.deepEqual(await ideaMarketClock(d.ideaMarket!, c), { start: new Date(1_700_000_000_000).toISOString(), roundLength: LEN });
});

test("an unresearched idea round: an all-void report 2 days after it closes, proposed after its public hour inside the 3-day resolve window; a Safe cancel is never re-proposed", { skip }, async () => {
  // the whole timeline, with the engine running long before the round: end + 2 d + 1 h the report (effectiveAt + 1 h,
  // no Telegram click); proposeOutcome after that hour, before end + 3 d (the fake reverts OutsideWindow like the contract)
  const r = 28;
  st.round = 30;
  st.now = T + 40 * 86_400;
  const end = st.now - 2 * 86_400 - 3600; // roundEnd(r) = now − 2 d − 1 h
  st.start = end - (r + 1) * LEN;
  st.rounds[r] = [0, 1, 0, 0, 0, zeroAddress];
  await sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (900, 0, '0x1', '0x', now(), '0x', 'IdeaSubmitted',
    ${sql.json({ id: "77", round: String(r), index: "0", title: "t", body: "b", author: agent, stake: "0" } as never)})`;
  const wall = Date.now();
  Object.assign(ideas.OUTCOME_DEPS, { now: () => wall, owners: async () => OWNERS.map((o) => o.address.toLowerCase()) });
  const out = await ideas.roundsHandler.run(job()) as Record<number, unknown>;
  assert.ok(out[r], JSON.stringify(out));
  const [rep] = await sql<{ doc: { allVoid: boolean; reason: string; effectiveAt: string } }[]>`select doc from log where kind = 'report' and ref = ${`round:${r}`}`;
  assert.deepEqual([rep.doc.allVoid, rep.doc.reason, rep.doc.effectiveAt], [true, "not researched within 2 days of the round closing", new Date(wall + 3600_000).toISOString()]);
  assert.ok(ideas.UNJUDGED_VOID_DAYS * 86_400 + 12 * 3600 <= RESOLVE - 12 * 3600, "at least 12 h for the public hour and the tx");
  assert.equal((await sql`select 1 from draft`).length, 0, "no Telegram approval draft");
  // inside the public hour: nothing is proposed
  const before = proposals.length;
  st.now = end + 2 * 86_400 + 2 * 3600;
  assert.match(String((await ideas.roundsHandler.run(job()) as Record<number, unknown>)[r]), /waits: in effect from/);
  assert.equal(proposals.length, before);
  // after it: proposed, inside [end, end + RESOLVE_WINDOW)
  ideas.OUTCOME_DEPS.now = () => wall + 3600_000;
  const sent = (await ideas.roundsHandler.run(job()) as Record<number, { status: string }>)[r];
  assert.equal(sent.status, "mined");
  assert.equal(proposals.length, before + 1);
  assert.ok(proposals.at(-1)!.at < end + RESOLVE, "inside [end, end + RESOLVE_WINDOW)");
  // the Safe cancels it (the round reads Open again): never proposed again; an all-void is left to expire
  assert.match(String((await ideas.roundsHandler.run(job()) as Record<number, unknown>)[r]), /the Safe cancelled the proposed outcome: the all-void outcome is left to expire/);
  assert.equal(proposals.length, before + 1);
  // past the window the engine no longer reports (the keeper finalizes all-void after it + 24 h)
  const r2 = 29;
  st.rounds[r2] = [0, 1, 0, 0, 0, zeroAddress];
  st.now = end + LEN + RESOLVE; // roundEnd(29) + 3 d
  await sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (901, 0, '0x2', '0x', now(), '0x', 'IdeaSubmitted',
    ${sql.json({ id: "78", round: String(r2), index: "0", title: "t", body: "b", author: agent, stake: "0" } as never)})`;
  assert.equal((await ideas.roundsHandler.run(job()) as Record<number, unknown>)[r2], undefined);
  Object.assign(ideas.OUTCOME_DEPS, approve.live);
});

test("a researched outcome 2 Safe owners veto is never proposed: an all-void report replaces it; a vetoed all-void is left to expire", { skip }, async () => {
  const r = 40;
  st.round = 42;
  st.now = T + 60 * 86_400;
  const end = st.now - 3600;
  st.start = end - (r + 1) * LEN;
  st.rounds[r] = [0, 1, 0, 0, 0, zeroAddress];
  await sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (902, 0, '0x3', '0x', now(), '0x', 'IdeaSubmitted',
    ${sql.json({ id: "90", round: String(r), index: "0", title: "t", body: "b", author: agent, stake: "0" } as never)})`;
  const wall = Date.now();
  const owners = async () => OWNERS.map((o) => o.address.toLowerCase());
  Object.assign(ideas.OUTCOME_DEPS, { now: () => wall + 2 * 3600_000, owners });
  // a researched report (as researchRound writes it), already past its hour
  const { append } = await import("../src/log.ts");
  await append("report", `round:${r}`, { round: r, ideas: [{ id: 90, index: 0, decision: "accept", kind: "fee", reason: "r", params: { base: 20_000, mult: 0, cap: 25_000 } }], effectiveAt: new Date(wall).toISOString(), at: new Date(wall).toISOString() });
  const veto = async () => {
    const [row] = await approve.trustedRows("report", `round:${r}`);
    const t = approve.targetOf(row);
    for (const o of OWNERS.slice(0, 2)) await approve.submitSignature("veto", t, await o.signMessage({ message: { raw: `0x${approve.ownerDigest("veto", t)}` } }), owners);
  };
  await veto();
  const before = proposals.length;
  const out = await ideas.roundsHandler.run(job()) as Record<number, { draft?: unknown }>;
  assert.ok(out[r].draft, JSON.stringify(out[r]));
  assert.equal(proposals.length, before, "the vetoed outcome is never proposed");
  const [rep] = await sql<{ doc: { allVoid: boolean; reason: string } }[]>`select doc from log where kind = 'report' and ref = ${`round:${r}`} order by seq desc limit 1`;
  assert.deepEqual([rep.doc.allVoid, rep.doc.reason], [true, "2 Safe owners vetoed the outcome report"]);
  await veto(); // the all-void report vetoed too
  assert.match(String((await ideas.roundsHandler.run(job()) as Record<number, unknown>)[r]), /left to expire/);
  assert.equal(proposals.length, before);
  Object.assign(ideas.OUTCOME_DEPS, approve.live);
});
