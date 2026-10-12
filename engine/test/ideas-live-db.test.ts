// Live idea mode (IDEA_MODE=live) against a real Postgres, a fake chain and the synthetic models: a site submit and an
// X idea are each judged as they come in (the reader, the brain's outcome, the red team on an acceptance) and an
// accepted build or fee idea queues for the Sequencer at once; nothing goes on-chain for an X idea; every verdict is a
// public `idea` record and an announcement (a site idea's to X too); a closed round gets the all-void report.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { type Abi, type AbiEvent, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, decodeFunctionData, type Hex, parseGwei, toHex, zeroAddress } from "viem";
import { feeHistory, startFakes } from "../scripts/fakes.ts";
import { synthetic } from "../scripts/synthetic.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
fakes.llm.xai = (b) => synthetic("xai", b);
fakes.llm.anthropic = (b) => synthetic("anthropic", b); // the brain and the red team (Claude)
const dbName = `dna_ideas_live_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc`, ENGINE_MODE: "live", TX_POLL_MS: "5", LLM_MODE: "live", XAI_API_BASE: fakes.url, XAI_API_KEY: "k", OPENROUTER_API_BASE: fakes.url, OPENROUTER_API_KEY_ENGINE: "k",
    AGENT_PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", X_USER_ID: "42", IDEA_MODE: "live",
  });
}
const { edb: sql, migrate } = await import("../src/db.ts");
const abi = await import("../src/abi.ts");
const ideas = await import("../src/ideas.ts");
const q = await import("../src/idea-queue.ts");
const tx = await import("../src/tx.ts");
const modeM = await import("../src/mode.ts");
const { d, IDEAS_LIVE } = await import("../src/config.ts");

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
const T = Math.floor(Date.now() / 1000);
const PERSON = "0x00000000000000000000000000000000000000b0";

// ---------------------------------------------------------------- fake chain: IdeaMarket views and logs
type Log = { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex; blockHash: Hex; transactionIndex: Hex; removed: false };
const st = { round: 0, start: T - 3600, rounds: {} as Record<number, number>, logs: [] as Log[], sent: 0 };
const VIEW: Record<string, (args: readonly unknown[]) => unknown> = {
  agent: () => agent, agentPaused: () => false, currentRound: () => BigInt(st.round), ROUND_LENGTH: () => BigInt(LEN), RESOLVE_WINDOW: () => BigInt(3 * LEN),
  roundEnd: ([r]) => BigInt(st.start + (Number(r) + 1) * LEN),
  rounds: ([r]) => [0, st.rounds[Number(r)] ?? 0, st.rounds[Number(r)] ?? 0, 0, 0, zeroAddress, 0n, 0n, 0n, 0n],
};
const ABIS: [string, readonly unknown[]][] = [[d.ideaMarket!, abi.ideaMarketAbi], [d.registry, abi.registryAbi]];
const abiOf = (to: string) => ABIS.find(([a]) => a.toLowerCase() === to.toLowerCase())?.[1] as Abi | undefined;
const match = (want: unknown, got: Hex | undefined) => want == null || (Array.isArray(want) ? want.some((w) => String(w).toLowerCase() === got?.toLowerCase()) : String(want).toLowerCase() === got?.toLowerCase());
Object.assign(fakes.rpc, {
  eth_chainId: () => toHex(31337),
  eth_blockNumber: () => toHex(1000n),
  eth_getBlockByNumber: () => ({ number: toHex(1000n), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"00".repeat(32)}`, timestamp: toHex(T), baseFeePerGas: toHex(parseGwei("1")), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], miner: zeroAddress, difficulty: "0x0", extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, size: "0x0", stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, uncles: [], totalDifficulty: "0x0", mixHash: `0x${"00".repeat(32)}` }),
  eth_maxPriorityFeePerGas: () => "0x0",
  eth_feeHistory: (p: unknown[]) => feeHistory(p, parseGwei("1")),
  eth_estimateGas: () => toHex(100_000n),
  eth_call: ([c]: [{ to: string; data: Hex }]) => {
    const a = abiOf(c.to);
    if (!a) return "0x";
    const { functionName, args = [] } = decodeFunctionData({ abi: a, data: c.data });
    return encodeFunctionResult({ abi: a, functionName, result: VIEW[functionName](args) as never });
  },
  eth_getLogs: ([f]: [{ address?: string; topics?: unknown[]; fromBlock?: Hex; toBlock?: string }]) =>
    st.logs.filter((l) => (!f.address || l.address === f.address.toLowerCase()) && (!f.fromBlock || BigInt(l.blockNumber) >= BigInt(f.fromBlock)) && (!f.toBlock || f.toBlock === "latest" || BigInt(l.blockNumber) <= BigInt(f.toBlock))
      && (f.topics ?? []).every((t, k) => match(t, l.topics[k]))),
  eth_getTransactionCount: () => "0x0",
  eth_sendRawTransaction: () => { st.sent++; throw Object.assign(new Error("no transaction expected"), { code: -32000 }); },
});

/** A site submit: IdeaSubmitted on the fake chain and as the indexer's chain_log row. */
let blk = 10, nextId = 1;
async function submit(author: string, title: string, body: string) {
  const id = nextId++, b = blk++;
  const index = st.rounds[st.round] ?? 0;
  st.rounds[st.round] = index + 1;
  const args = { id: BigInt(id), round: BigInt(st.round), author, index: BigInt(index), stake: 10_000n * 10n ** 18n, title, body };
  const ev = abi.ideaMarketAbi.find((x) => x.type === "event" && x.name === "IdeaSubmitted") as AbiEvent;
  const plain = ev.inputs.filter((x) => !x.indexed);
  st.logs.push({
    address: d.ideaMarket!.toLowerCase(), topics: encodeEventTopics({ abi: abi.ideaMarketAbi, eventName: "IdeaSubmitted", args } as never) as Hex[],
    data: encodeAbiParameters(plain, plain.map((x) => (args as Record<string, unknown>)[x.name!]) as never),
    blockNumber: toHex(b), transactionHash: `0x${b.toString(16).padStart(64, "0")}`, logIndex: "0x0", blockHash: `0x${"22".repeat(32)}`, transactionIndex: "0x0", removed: false,
  });
  const j = JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  await sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (${b}, 0, '0x1', '0x', now(), ${d.ideaMarket!.toLowerCase()}, 'IdeaSubmitted', ${sql.json(j as never)})`;
  return id;
}
const GATED_IN = { verified_type: "blue", created_at: "2020-01-01T00:00:00.000Z", public_metrics: { followers_count: 1000 } };
let nextMention = 9000;
async function mention(author: string, text: string) {
  const id = String(nextMention++);
  await sql`insert into x_mention (id, author_id, text, created_at, raw) values (${id}, ${author}, ${text}, now(), ${sql.json({ id, text, user: GATED_IN } as never)})`;
  return id;
}
const queueRow = async (id: string) => (await sql<{ kind: string; status: string; data: Record<string, any> }[]>`select kind, status, data from idea_queue where id = ${id}`)[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
const doc = async (kind: string, ref: string) => (await sql<{ doc: Record<string, any> }[]>`select doc from log where kind = ${kind} and ref = ${ref} order by seq desc limit 1`)[0]?.doc; // eslint-disable-line @typescript-eslint/no-explicit-any

test("live: switched on with ideas already indexed, the cursor starts after the newest: the rounds mode's ideas are never judged again", { skip }, async () => {
  await submit(PERSON, "An old staked idea", "Build a raffle app that the rounds mode already judged and paid out.");
  assert.deepEqual(await ideas.liveHandler.run(job()), {});
  assert.equal((await sql`select 1 from idea_queue`).length, 0);
});

test("live: a site submit is judged at once and an accepted build idea queues for the Sequencer; the verdict is public; each idea once", { skip }, async () => {
  assert.equal(IDEAS_LIVE, true);
  const build = await submit(PERSON, "A coin flip game", "Build a small coin flip game where holders guess heads or tails each hour for a share of the game pot.");
  await submit(agent, "Our own", "an idea the agent submitted itself, never judged here: a game");
  const out = await ideas.liveHandler.run(job()) as Record<number, string>;
  assert.deepEqual(out, { [build]: "queued" });
  assert.ok(fakes.calls.some((c) => c.path.endsWith("/v1/messages") && JSON.stringify(c.body).includes("nothing is simulated at this stage")), "the red team hears a build idea is gated later, not simulated now");
  const r = await queueRow(`im:${build}`);
  assert.equal(r.kind, "build");
  assert.equal(r.status, "queued");
  assert.equal(r.data.idea, build);
  assert.deepEqual(r.data.source, { source: "ideamarket", author: PERSON.replace("b0", "B0") });
  assert.ok(r.data.rubric, "a build idea carries its rubric");
  assert.equal((await q.buildQueue(5))[0]?.id, `im:${build}`, "the Sequencer sees it");
  const rec = await doc("idea", String(build));
  assert.equal(rec.status, "accepted");
  assert.equal(rec.live, true);
  assert.equal(rec.from, "site");
  assert.match(rec.resolution, /^Accepted and queued for the sequencer \(the stake is refunded once its round closes\)/);
  const ann = await doc("announce", `idea:live:im:${build}`);
  assert.equal(ann.type, "idea_judged");
  assert.match(ann.title, /^Idea "Synthetic idea \d+" was accepted and is queued for the sequencer/);
  assert.equal((await sql`select 1 from x_outbox where event_key = ${`idea:live:im:${build}`}`).length, 1, "a site idea's verdict goes to X");
  assert.deepEqual(await ideas.liveHandler.run(job()), {}, "the cursor moved past it");
  assert.equal(st.sent, 0, "nothing on-chain");
  // a run cut short after the verdict (cursor not moved) gets the same verdict back, with no second model call
  const brains = (await sql`select 1 from log where kind = 'brain'`).length;
  const again = await ideas.judgeLive(`im:${build}`, { idea: build, round: 0, index: 0, title: "x", body: "y" }, null, String(build));
  assert.deepEqual([again.status, again.idea], ["queued", build]);
  assert.equal((await sql`select 1 from log where kind = 'brain'`).length, brains);
  const { onX } = await import("../src/announce.ts");
  for (const e of ["idea_judged", "seq_declined", "seq_pr", "seq_verdict"]) assert.ok(onX(e), e);
});

test("live: an X idea past the screen is judged in the same run, queued under its own number with its X author; nothing goes on-chain", { skip }, async () => {
  const m = await mention("71", "@contractdna lower the base fee during quiet night hours so that small traders keep swapping");
  const out = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.equal(out[m], "queued");
  const row = (await sql<{ status: string; idea_id: number }[]>`select status, idea_id::int as idea_id from intake where mention_id = ${m}`)[0];
  assert.equal(row.status, "queued");
  assert.equal(row.idea_id, q.X_IDEA_BASE + 1);
  const r = await queueRow(`x:${m}`);
  assert.equal(r.kind, "fee");
  assert.equal(r.data.idea, q.X_IDEA_BASE + 1);
  assert.deepEqual(r.data.source, { source: "x", authorId: "71", postId: m });
  assert.equal((await doc("intake", m)).status, "queued");
  assert.equal((await doc("idea", `x:${m}`)).from, "x");
  assert.equal((await sql`select 1 from x_outbox where event_key = ${`idea:live:x:${m}`}`).length, 0, "an X idea gets its reply, not a post");
  const { intakeFact } = await import("../src/x.ts");
  assert.match(String((await intakeFact(m)).intake), /queued for the sequencer/);
  assert.deepEqual(await ideas.intakeHandler.run(job()), {}, "judged once");
  assert.equal(st.sent, 0, "no on-chain submit in live mode");
});

test("live: an idea whose form can't be built is queued as its closest buildable version, credited to its author; the reply says what is built instead", { skip }, async () => {
  const m = await mention("73", "@contractdna mint a holder NFT for wallets that hold a million DNA for a week, with art that evolves");
  const out = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.equal(out[m], "queued", "screened impossible, judged anyway in live mode, and its variant queued");
  const r = await queueRow(`x:${m}`);
  assert.equal(r.kind, "build");
  assert.match(r.data.title, /^Synthetic game version of idea/);
  assert.deepEqual(r.data.source, { source: "x", authorId: "73", postId: m }, "credited (and paid) to the person whose idea it is");
  assert.equal(r.data.variant?.target, "game", JSON.stringify(r.data));
  assert.ok(r.data.variant.of, "it names the idea it stands in for");
  assert.ok(r.data.rubric);
  const rec = await doc("idea", `x:${m}`);
  assert.match(rec.resolution, /^Queued for the sequencer as a buildable version: Synthetic game version/);
  assert.equal(rec.variant.target, "game");
  const { intakeFact } = await import("../src/x.ts");
  const f = await intakeFact(m);
  assert.equal(f.verdict, "a buildable version");
  assert.equal(f.instead, undefined, "a title with a digit is never said (the writer may only use code's numbers)");
  assert.match(String(f.why), /^Synthetic plain reason/);
  assert.match(String(f.understood), /^Synthetic: idea/);
  assert.match(String(f.next), /credit/);
});

test("live: one idea per author per UTC day, counting ideas only (a question uses no slot); a near repeat is turned away", { skip }, async () => {
  const a = await mention("72", "@contractdna raise the buyback share of the fee when volume runs hot so that more DNA burns");
  const q = await mention("72", "@contractdna how much DNA was burned so far?");
  const b = await mention("72", "@contractdna cut the base fee on weekends so that small traders keep swapping through the pool");
  const c = await mention("72", "@contractdna raise the buyback share of the fee when volume runs hot, so that more DNA burns");
  await ideas.intakeHandler.run(job());
  const st = async (id: string) => (await sql<{ status: string; reason: string | null }[]>`select status, reason from intake where mention_id = ${id}`)[0];
  assert.ok(["candidate", "queued", "rejected"].includes((await st(a)).status), JSON.stringify(await st(a)));
  assert.deepEqual(await st(q), { status: "screened", reason: "screened as question" }, "a question is never spam, and never meets the cap");
  assert.deepEqual(await st(b), { status: "gated", reason: "already 1 idea from this author the same UTC day" });
  assert.deepEqual(await st(c), { status: "gated", reason: "near-duplicate of an idea received in the last 7 days" });
  const { intakeFact } = await import("../src/x.ts");
  assert.match(String((await intakeFact(c)).intake), /repeats one someone already sent this week/);
});

test("live: switching from rounds mode, an X idea the rounds mode picked but never judged is judged now, once", { skip }, async () => {
  const { record } = await import("../src/records.ts");
  const m = await mention("88", "@contractdna build a raffle game where every swap in the official pool is a ticket");
  await record("intake", m, { mention: m, round: 0, status: "candidate", reason: "genuine build idea", score: 21, title: "Swap raffle", body: "A raffle game: each swap is a ticket.", class: "build", at: new Date().toISOString() });
  await record("intake", m, { mention: m, round: 0, status: "picked", reason: "in the round's top 16", at: new Date().toISOString() });
  await sql`insert into intake (mention_id, round, status, author_id, score, title, body) values (${m}, 0, 'picked', '88', 21, 'Swap raffle', 'A raffle game: each swap is a ticket.')`;
  const out = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.equal(out[m], "queued");
  assert.equal((await queueRow(`x:${m}`)).kind, "build");
  assert.deepEqual(await ideas.intakeHandler.run(job()), {}, "once");
  assert.equal(st.sent, 0);
});

test("live: every X idea the pre-2b judge rejected is judged again once, 2 a run, through the normal path; a later rejection and a gated row are untouched", { skip }, async () => {
  const { record } = await import("../src/records.ts");
  const at = new Date().toISOString();
  // an X idea judged and rejected in live mode; the pre-2b judge's idea record has no `judge` note
  const rejected = async (author: string, title: string, body: string, judge?: string) => {
    const m = await mention(author, `@contractdna ${body}`);
    await record("intake", m, { mention: m, round: 0, status: "candidate", reason: "genuine build idea; judged now", score: 20, title, body, class: "build", live: true, screen: ideas.SCREEN_VERSION, at });
    await record("idea", `x:${m}`, { id: 0, round: 0, status: "rejected", live: true, from: "x", kind: "build", title, brain: "1", resolution: "Not taken: reject: no", ...(judge === undefined ? {} : { judge, plain: "it was not clear" }) });
    await record("intake", m, { mention: m, round: 0, status: "rejected", reason: "reject: no", score: 20, live: true, screen: ideas.SCREEN_VERSION, at });
    await sql`insert into intake (mention_id, round, status, reason, author_id, score, title, body, title_key) values (${m}, 0, 'rejected', 'reject: no', ${author}, 20, ${title}, ${body}, ${ideas.titleKey(title)})`;
    return m;
  };
  const a = await rejected("501", "Swap raffle", "A raffle game: each swap in the official pool is a ticket.");
  const b = await rejected("502", "Kite race", "A kite racing game: holders steer kites through gusts, the fastest lap wins a credit.");
  const c = await rejected("503", "Bowling alley", "A bowling game where strikes earn points on a monthly ladder for holders.");
  const later = await rejected("504", "Penguin slide", "A sliding penguin game on ice floes, longest slide of the week wins.", "reject: not clear");
  const g = await mention("505", "@contractdna build a dice game for holders");
  await record("intake", g, { mention: g, round: 0, status: "gated", reason: "near-duplicate of an idea received in the last 7 days", live: true, screen: ideas.SCREEN_VERSION, at });
  await sql`insert into intake (mention_id, round, status, reason, author_id) values (${g}, 0, 'gated', 'near-duplicate of an idea received in the last 7 days', '505')`;
  const ours = (out: Record<string, string>) => Object.keys(out).filter((k) => [a, b, c, later, g].includes(k)).sort();

  const one = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.deepEqual(ours(one), [a, b], "the oldest two this run, never a burst");
  assert.equal(one[a], "queued", "judged again and accepted: queued for the sequencer");
  const r = await queueRow(`x:${a}`);
  assert.equal(r.kind, "build");
  assert.equal(r.data.rejudged, true);
  assert.deepEqual(r.data.source, { source: "x", authorId: "501", postId: a }, "credited to the original author");
  const rec = await doc("idea", `x:${a}`);
  assert.equal(rec.rejudged, true);
  assert.equal(rec.status, "accepted");
  assert.match(rec.resolution, /^Judged again under the new rules\. Accepted and queued for the sequencer/);
  assert.equal(typeof rec.judge, "string", "the new record is the current judge's");
  const ia = await doc("intake", a);
  assert.deepEqual([ia.status, ia.rejudged, ia.backfill], ["queued", true, undefined], "no backfill: no second reply");
  assert.equal((await sql<{ status: string }[]>`select status from intake where mention_id = ${a}`)[0].status, "queued");
  assert.match((await doc("announce", `idea:rejudge:x:${a}`)).title, /^Judged again under the new rules: Idea /);
  assert.equal((await sql`select 1 from x_outbox where reply_to = ${a} or event_key like ${`%${a}%`}`).length, 0, "no new reply to the author");

  const two = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.deepEqual(ours(two), [c], "the rest on the next run");
  const brains = (await sql`select 1 from log where kind = 'brain'`).length;
  const three = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.deepEqual(ours(three), [], "each once: a second run does nothing");
  assert.equal((await sql`select 1 from log where kind = 'brain'`).length, brains, "no model call");
  assert.equal((await sql`select 1 from log where kind = 'idea' and ref = ${`x:${a}`}`).length, 2, "one new idea record");

  assert.equal((await sql<{ status: string }[]>`select status from intake where mention_id = ${later}`)[0].status, "rejected", "the current judge's rejection stands");
  assert.equal((await doc("idea", `x:${later}`)).rejudged, undefined);
  assert.equal((await queueRow(`x:${later}`)), undefined);
  assert.equal((await sql<{ status: string }[]>`select status from intake where mention_id = ${g}`)[0].status, "gated", "a gated row is untouched");
  assert.equal(await doc("idea", `x:${g}`), undefined);
  // a run cut short after the new verdict (its intake record not written): the verdict comes back, no model call
  const v = await ideas.judgeLive(`x:${a}`, { round: 0, index: -1, title: "x", body: "y" }, null, `x:${a}`, true);
  assert.equal(v.status, "queued");
  assert.equal((await sql`select 1 from log where kind = 'brain'`).length, brains);
  assert.equal(st.sent, 0);
});

test("live: mentions an earlier gate turned away are screened again from their row, once each, under one idea per author a day", { skip }, async () => {
  const young = { verified_type: "none", created_at: new Date().toISOString(), public_metrics: { followers_count: 3 } };
  const turnedAway = async (author: string, text: string, reason: string) => {
    const id = String(nextMention++);
    await sql`insert into x_mention (id, author_id, text, created_at, raw) values (${id}, ${author}, ${text}, now(), ${sql.json({ id, text, user: young } as never)})`;
    await sql`insert into intake (mention_id, round, status, reason, author_id) values (${id}, 0, 'gated', ${reason}, ${author})`;
    return id;
  };
  const a = await turnedAway("91", "@contractdna build a loot hunt game: a clue each day, the first to solve it gets a credit from the game pot", "account younger than 30 days");
  const b = await turnedAway("91", "@contractdna publish the brain's accuracy score every week on the site", "no verified badge (blue, business or government)");
  const bind = await turnedAway("92", "@contractdna bind 0x00000000000000000000000000000000000000c3", "binding: account younger than 30 days");
  const out = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.equal(out[a], "queued", "no badge, age or follower bar in live mode: screened and judged in the same run");
  assert.equal((await doc("intake", a)).live, true);
  assert.equal(out[b], "gated", "a second idea of the same UTC day meets the author's cap");
  assert.equal((await sql<{ reason: string }[]>`select reason from intake where mention_id = ${b}`)[0].reason, "already 1 idea from this author the same UTC day");
  assert.equal(out[bind], undefined, "a wallet binding is never taken again");
  assert.deepEqual(await ideas.intakeHandler.run(job()), {}, "each once");
  assert.equal(st.sent, 0);
});

test("live: a post an older live screen turned away is screened once more; only one that is an idea gets the backfill reply", { skip }, async () => {
  const { record } = await import("../src/records.ts");
  const old = async (author: string, text: string) => {
    const id = String(nextMention++);
    await sql`insert into x_mention (id, author_id, text, created_at, raw) values (${id}, ${author}, ${text}, now() - interval '2 days', ${sql.json({ id, text, user: { created_at: new Date().toISOString() } } as never)})`;
    await sql`insert into intake (mention_id, round, status, reason, author_id) values (${id}, 0, 'screened', 'screened as spam', ${author})`;
    await record("intake", id, { mention: id, round: 0, status: "screened", reason: "screened as spam", live: true, at: new Date().toISOString() });
    return id;
  };
  const q = await old("401", "@contractdna how much DNA was burned so far?");
  const idea = await old("402", "@contractdna build a weekly trivia game about onchain history with a small prize from the game pot");
  const spam = await old("403", "@contractdna Can I get follow back?");
  const out = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.equal((await doc("intake", q)).reason, "screened as question");
  assert.equal((await doc("intake", q)).backfill, undefined, "an old question gets no late reply");
  assert.equal((await doc("intake", q)).screen, ideas.SCREEN_VERSION);
  assert.deepEqual([(await doc("intake", spam)).reason, (await doc("intake", spam)).screen, (await doc("intake", spam)).backfill], ["screened as spam", ideas.SCREEN_VERSION, undefined], "still spam: screened once, no reply");
  assert.ok(["queued", "rejected"].includes(out[idea]), out[idea]);
  assert.ok((await sql`select 1 from log where kind = 'intake' and ref = ${idea} and doc->>'backfill' = 'true'`).length, "an idea the old screen missed gets its reply");
  const again = await ideas.intakeHandler.run(job()) as Record<string, string>;
  assert.deepEqual([again[q], again[spam]], [undefined, undefined], "once");
});

test("live: a closed round's report is all-void (every stake refunded), never researched", { skip }, async () => {
  st.round = 1;
  const before = Date.now();
  fakes.rpc.eth_getBlockByNumber = () => ({ number: toHex(1000n), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"00".repeat(32)}`, timestamp: toHex(st.start + LEN + 60), baseFeePerGas: toHex(parseGwei("1")), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], miner: zeroAddress, difficulty: "0x0", extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, size: "0x0", stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, uncles: [], totalDifficulty: "0x0", mixHash: `0x${"00".repeat(32)}` });
  await ideas.roundsHandler.run(job());
  const rep = await doc("report", "round:0");
  assert.equal(rep.allVoid, true);
  assert.equal(rep.reason, ideas.LIVE_VOID);
  assert.equal((await sql`select 1 from log where kind = 'brain' and ref = 'outcome:round:0' and at >= ${new Date(before)}`).length, 0, "no round research");
});

test("live: backfilled ideas get one reply each under the reply ceilings (overflow waits for the next run); an idea answered before gets none; no second reply", { skip }, async () => {
  const { X } = await import("../src/config.ts");
  const xM = await import("../src/x.ts");
  const saved = { ...X };
  try {
    // everything earlier in this file is already answered: only the backfill is in play here
    await sql`insert into x_outbox (type, event_key, event, reply_to, status, error) select 'reply', 'reply:' || id, '{}', id, 'skipped', 'earlier test' from x_mention on conflict do nothing`;
    const young = { verified_type: "none", created_at: new Date().toISOString(), public_metrics: { followers_count: 3 } };
    const SUMMONS = { entities: { mentions: [{ start: 0, end: 13, username: "contractdna", id: "42" }] } };
    // posted 3 days ago, turned away by the old author gate (some with the old skipped reply row)
    const old = async (author: string, text: string, replied?: "skipped" | "posted") => {
      const id = String(nextMention++);
      await sql`insert into x_mention (id, author_id, text, created_at, raw) values (${id}, ${author}, ${text}, now() - interval '3 days', ${sql.json({ id, text, user: young, ...SUMMONS } as never)})`;
      await sql`insert into intake (mention_id, round, status, reason, author_id) values (${id}, 0, 'gated', 'account younger than 30 days', ${author})`;
      if (replied === "skipped") await sql`insert into x_outbox (type, event_key, event, reply_to, status, error) values ('reply', ${`reply:${id}`}, '{}', ${id}, 'skipped', 'author: account younger than 30 days')`;
      if (replied === "posted") await sql`insert into x_outbox (type, event_key, event, reply_to, status, tweet_id, created_at) values ('reply', ${`reply:${id}`}, '{}', ${id}, 'posted', ${`7${id}`}, now() - interval '2 days')`;
      return id;
    };
    const five = [
      await old("301", "@contractdna build a treasure map game where each swap reveals one tile of the map", "skipped"),
      await old("306", "@contractdna let holders vote on a weekly theme for the arcade games page", "skipped"),
      await old("302", "@contractdna send part of the fee to a prize pool for the longest holder each month"),
      await old("303", "@contractdna show a live chart of every burn on the home page with a running total", "skipped"),
      await old("304", "@contractdna make a daily riddle game whose first solver wins a small credit"),
    ];
    const answered = await old("305", "@contractdna add a leaderboard of the biggest buyers of the week to the site", "posted");
    for (let k = 0; k < 3; k++) await ideas.intakeHandler.run(job());
    for (const id of [...five, answered]) assert.ok((await sql`select 1 from log where kind = 'intake' and ref = ${id} and doc->>'backfill' = 'true'`).length, `${id}: a backfill record`);
    Object.assign(X, { aiRepliesApproved: true, dailyReplies: 1000, hourlyReplies: 3 });
    const replies = async () => (await sql<{ reply_to: string; status: string; category: string }[]>`select reply_to, status, event->>'category' as category from x_outbox
      where type = 'reply' and reply_to = any(${[...five, answered]}) and status <> 'skipped'`);
    await xM.repliesHandler.run(job());
    assert.equal((await replies()).filter((r) => r.status === "queued").length, 3, "the hourly ceiling: 3 now, the rest wait");
    X.hourlyReplies = 1000;
    await xM.repliesHandler.run(job());
    await xM.repliesHandler.run(job());
    const rs = await replies();
    assert.deepEqual(rs.filter((r) => r.status === "queued").map((r) => r.reply_to).sort(), [...five].sort(), "exactly 5: one under each idea");
    assert.ok(rs.filter((r) => r.status === "queued").every((r) => r.category === "idea"), "the idea reply (the intake's read), whatever the reader called it");
    assert.deepEqual(rs.filter((r) => r.reply_to === answered).map((r) => r.status), ["posted"], "answered before: never a second reply");
    // taken once: the intake and the replies job add nothing more
    await ideas.intakeHandler.run(job());
    await xM.repliesHandler.run(job());
    assert.equal((await replies()).length, 6);
  } finally {
    Object.assign(X, saved);
  }
});
