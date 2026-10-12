// Changes to the engine's own code and to the rules it runs under (src/upgrades.ts) against Postgres and the local
// fakes: chain log → its own outbox row → one post (tx link appended, a note to the signers); a later executed or
// cancelled row supersedes the queued one (never both posted); no release notes → code's line, no writer; the pending
// block of a status leaves out what has its own post. Needs TEST_DATABASE_URL (CI); skipped without it.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Hex, type Log, parseAbi, toHex } from "viem";
import { startFakes } from "../scripts/fakes.ts";
import { synthetic } from "../scripts/synthetic.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
fakes.llm.xai = (b) => synthetic("xai", b);
const dbName = `dna_upgrades_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;

if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc`, ENGINE_MODE: "live",
    TELEGRAM_API_BASE: fakes.url, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_ID: "-100", TELEGRAM_ALLOWED_USER_IDS: "7", TELEGRAM_POLL_TIMEOUT_S: "1",
    XAI_API_BASE: fakes.url, OPENROUTER_API_BASE: fakes.url, XAI_API_KEY: "k", OPENROUTER_API_KEY_ENGINE: "k", LLM_MODE: "record", LLM_FIXTURES: `${mkdtempSync(join(tmpdir(), "dna-llm-"))}/`,
    X_API_BASE: fakes.url, X_CLIENT_ID: "cid", X_REFRESH_TOKEN: "seed", X_USER_ID: "42", SECRET_SEAL_KEY: "11".repeat(32),
    AGENT_PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // anvil #2 (public test key)
  });
}
// imported only after the env is set (config is read at import)
const { edb: sql, migrate } = await import("../src/db.ts");
const modeM = await import("../src/mode.ts");
const xM = await import("../src/x.ts");
const up = await import("../src/upgrades.ts");
const { pendingNow } = await import("../src/life.ts");
const { d, X } = await import("../src/config.ts");
const tx = await import("../src/tx.ts");
const { encodeOp } = await import("../src/lib.ts");
const { announce, ANNOUNCEMENTS_URL } = await import("../src/announce.ts");

const APP = "0x00000000000000000000000000000000000000a9" as const;
const TIMELOCK = "0x00000000000000000000000000000000000000b9" as const;
const NOTES = ["build-now ideas mode", "replies open to everyone", "posts on what's happening on CT", "draws every 24h max", "lab posts and more art"];
let BLOCK_TS = 0; // the fake head block's time, set when the tests start
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const job = () => ({ id: "0", kind: "t", payload: {}, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null }) as never;
const tweets = () => fakes.calls.filter((c) => c.path === "/2/tweets" && c.method === "POST").map((c) => String(c.body.text));
const writerCalls = () => fakes.calls.filter((c) => String(c.body.instructions ?? c.body.messages?.[0]?.content ?? "").startsWith("agent: x-writer")).length;
const outbox = async (key: string) => (await sql<{ status: string; error: string | null; event: Record<string, unknown> }[]>`select status, error, event from x_outbox where event_key = ${key}`)[0];
const alerts = async (like: string) => (await sql<{ text: string }[]>`select payload->>'text' as text from job where kind = 'alert' and payload->>'text' like ${like}`).map((r) => r.text);

const tl = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
]);
const add = (hash: Hex) => encodeFunctionData({ abi: parseAbi(["function addComposeHash(bytes32)"]), functionName: "addComposeHash", args: [hash] });
const remove = (hash: Hex) => encodeFunctionData({ abi: parseAbi(["function removeComposeHash(bytes32)"]), functionName: "removeComposeHash", args: [hash] });
let li = 0;
const log = (topics: Hex[], data: Hex, txh: Hex) => ({ address: TIMELOCK, topics, data, blockNumber: 7n, blockHash: H(1), transactionHash: txh, transactionIndex: 0, logIndex: li++, removed: false }) as unknown as Log;
/** The Safe's batch: addComposeHash(new) + removeComposeHash(old), one timelock id, two calls. */
const scheduled = (id: Hex, hash: Hex, txh: Hex) => [add(hash), remove(H(0xdead))].map((data, index) =>
  log(encodeEventTopics({ abi: tl, eventName: "CallScheduled", args: { id, index: BigInt(index) } }) as Hex[], encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], [APP, 0n, data, H(0), 3600n]), txh));
const executed = (id: Hex, hash: Hex, txh: Hex) => [log(encodeEventTopics({ abi: tl, eventName: "CallExecuted", args: { id, index: 0n } }) as Hex[], encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [APP, 0n, add(hash)]), txh)];
const cancelled = (id: Hex, txh: Hex) => [log(encodeEventTopics({ abi: tl, eventName: "Cancelled", args: { id } }) as Hex[], "0x", txh)];

before(async () => {
  if (!ADMIN) return;
  await migrate();
  await modeM.initMode();
  Object.assign(d, { dstackApp: APP, codeTimelock: TIMELOCK });
  BLOCK_TS = Math.floor(Date.now() / 1000);
  fakes.rpc.eth_getBlockByNumber = () => ({ number: toHex(7), hash: H(1), parentHash: H(0), timestamp: toHex(BLOCK_TS), baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [],
    miner: `0x${"00".repeat(20)}`, difficulty: "0x0", extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", sha3Uncles: H(0), size: "0x0", stateRoot: H(0), receiptsRoot: H(0),
    transactionsRoot: H(0), uncles: [], totalDifficulty: "0x0", mixHash: H(0) });
  X.spacingMs = 0;
});
after(async () => {
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await fakes.close();
});

test("the day's changelog lists every change (a code update, the Safe's split change, a site change, no dev ship); a day with none posts nothing", { skip }, async () => {
  const day = new Date().toISOString().slice(0, 10);
  const hash = H(0xc0fe);
  const saved = up.RELEASES.fetch;
  up.RELEASES.fetch = async (url: string) => (url === `${up.RELEASES.base}releases/${hash.slice(2)}.json` ? new Response(JSON.stringify({ composeHash: hash.slice(2), commit: "f".repeat(40), notes: NOTES })) : new Response("", { status: 404 }));
  const savedRun = { ...up.RUNNING };
  try {
    await up.onTimelockLogs(executed(H(0x77), hash, H(0x71))); // the engine's own upgrade: allowed, then running
    Object.assign(up.RUNNING, { composeHash: async () => hash, bootAt: (BLOCK_TS + 60) * 1000 }); // restarted after the allow
    await up.runningCheck();
  } finally {
    up.RELEASES.fetch = saved;
    Object.assign(up.RUNNING, savedRun);
  }
  await sql`update x_outbox set status = 'skipped' where event_key like 'update:%'`; // their own posts: not this test's
  // a promoted fee experiment, and the Safe's PromoteActive that made it live: one line, not two
  await announce("outcome:r1", { event: "outcome", outcome: "kept (promoted)", plate: "A", samples: 50, reason: "promoted to the live fee", source: "the AI" });
  await announce("site:wallet", { event: "site_changed", id: "wallet", title: "a wallet link in the header", url: "/" }); // the website deploy
  // the Safe's split change, queued and executed (the indexer's rows), and an executed op of the agent's own (a test: not listed)
  const w = (n: number) => toHex(n, { size: 32 });
  const split = encodeAbiParameters([{ type: "address" }, { type: "bytes32[4]" }], ["0x00000000000000000000000000000000000000a1", [w(4000), w(3000), w(2000), w(1000)]]);
  const reg = d.registry.toLowerCase();
  const row = (block: number, event: string, args: Record<string, unknown>) =>
    sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (${block}, 0, ${H(block)}, ${H(1)}, now(), ${reg}, ${event}, ${sql.json(args as never)})`;
  await row(900, "Queued", { id: "7", op: 4, proposer: d.safe, data: split, eta: "1" });
  await row(901, "Executed", { id: "7", op: 4 });
  await row(902, "Queued", { id: "8", op: 1, proposer: tx.addressOf("agent"), data: "0x", eta: "1" });
  await row(903, "Executed", { id: "8", op: 1 });
  const promote = encodeOp("PromoteActive", ["0x00000000000000000000000000000000000000a2"]);
  await row(904, "Queued", { id: "9", op: promote.op, proposer: d.safe, data: promote.data, eta: "1" });
  await row(905, "Executed", { id: "9", op: promote.op });

  assert.equal(await up.changelog(day, true), "waiting: the indexer has not reached the day's end");
  await sql`insert into cursor (id, block, hash, at) values (1, 903, ${H(1)}, now() + interval '2 days') on conflict (id) do update set at = excluded.at`;
  assert.equal(await up.changelog("2020-01-01", true), "no post: nothing changed");
  assert.equal(await outbox("changes:2020-01-01"), undefined, "never an empty changelog");
  assert.equal(await up.changelog(day, true), `changelog for ${day}: 4 changes`);
  const changes = [`the engine runs a new version: ${NOTES.join("; ")}`, "a tested fee became the live fee", "the website changed: a wallet link in the header",
    "the fee split changed: buyback 40%, liquidity 30%, treasury 20%, games 10%"];
  const c = await outbox(`changes:${day}`);
  assert.deepEqual([c.event.event, c.event.changes, c.event.figures], ["day_changes", changes, [24, 40, 30, 20, 10]]);
  assert.equal(await up.changelog(day, true), `changelog for ${day}: 4 changes`, "an hour later: still the one row");
  assert.equal((await sql`select 1 from x_outbox where event_key like 'changes:%'`).length, 1);
  const n = tweets().length;
  assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
  // code's template (no writer): the lines that fit, each cut at 120 characters; the rest is on the site
  assert.equal(tweets()[n], `What changed on ${day} (UTC): The engine runs a new version: build-now ideas mode; replies open to everyone; posts on what's happening on CT; draws...; A tested fee became the live fee. The rest is on the site.\n${ANNOUNCEMENTS_URL}`);
  const [ann] = await sql<{ doc: { title: string } }[]>`select doc from log where kind = 'announce' and ref = ${`changes:${day}`}`;
  assert.equal(ann.doc.title, `What changed on ${day}: ${changes.join("; ")}`);
});

test("a code update: scheduled → its notes posted with the tx link and a note to the signers; executed → it's in, the queued post superseded", { skip }, async () => {
  const hash = H(0xc0de);
  const saved = up.RELEASES.fetch;
  up.RELEASES.fetch = async (url: string) => (url === `${up.RELEASES.base}releases/${hash.slice(2)}.json` ? new Response(JSON.stringify({ composeHash: hash.slice(2), commit: "f".repeat(40), notes: NOTES })) : new Response("", { status: 404 }));
  try {
    await up.onTimelockLogs(scheduled(H(0xa1), hash, H(0x11)));
    const q = await outbox(`update:scheduled:${H(0xa1)}:${H(0x11)}`);
    assert.deepEqual(q.event, { event: "update_queued", id: H(0xa1), hash, eta: String(BLOCK_TS + 3600) }, "one row for the batch: the removal is not an update");
    assert.equal((await alerts("Code update scheduled%")).length, 1);
    // a status now: the update has its own post; a reply keeps it with the minutes
    assert.ok(!(await pendingNow(Date.now(), "status")).some((p) => /update to my own code/.test(p.what)));
    assert.equal((await pendingNow(Date.now(), "reply")).find((p) => /update to my own code/.test(p.what))?.minutesLeft, 60);

    const n = tweets().length;
    assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
    const at = new Date((BLOCK_TS + 3600) * 1000).toISOString().slice(11, 16);
    assert.equal(tweets()[n], `Engine update queued. What it changes: ${NOTES.join("; ")}. It can land from ${at} UTC unless the Safe cancels it first.\nhttps://etherscan.io/tx/${H(0x11)}`, "code's template, no writer");
    const [rec] = await sql<{ doc: { facts: Record<string, unknown> } }[]>`select doc from log where kind = 'x_post' and ref = ${`update:scheduled:${H(0xa1)}:${H(0x11)}`} and doc->>'status' = 'attempt'`;
    assert.deepEqual([rec.doc.facts.notes, rec.doc.facts.figures, rec.doc.facts.minutesLeft], [NOTES, [24], 60]);
    assert.equal((await alerts("Posted: update:scheduled:%")).length, 1, "mirrored to Telegram like every post");
    const [ann] = await sql<{ doc: { title: string; priority: number } }[]>`select doc from log where kind = 'announce' and ref = ${`update:scheduled:${H(0xa1)}:${H(0x11)}`}`;
    assert.match(ann.doc.title, /^An update to the engine's code is queued: build-now ideas mode;/);

    // a second update scheduled, then executed before its post went out: only "allowed" posts (never "it's in": the old
    // version still runs until the switch)
    await up.onTimelockLogs(scheduled(H(0xa2), H(0xc1de), H(0x12)));
    await up.onTimelockLogs(executed(H(0xa2), H(0xc1de), H(0x13)));
    assert.equal(await xM.sendHandler.run(job()), "skipped");
    assert.equal((await outbox(`update:scheduled:${H(0xa2)}:${H(0x12)}`)).status, "skipped", "superseded: the executed post says it");
    const m = tweets().length;
    assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
    assert.equal(tweets()[m], `Engine update allowed: the Safe can no longer stop it, and the engine switches to it on its next restart. It has no release notes to show, so what it changes is not described here.\nhttps://etherscan.io/tx/${H(0x13)}`, "no notes for that hash: code's line");

    // this engine now runs that compose hash (its enclave report): "it's in", once, linking the execute tx
    const savedRun = { ...up.RUNNING };
    try {
      // not restarted since the allow: the same code would be no switch, so nothing is said
      Object.assign(up.RUNNING, { composeHash: async () => "c1de".padStart(64, "0"), bootAt: (BLOCK_TS - 60) * 1000 });
      await up.runningCheck();
      assert.equal((await sql`select 1 from x_outbox where event_key like ${`update:running:${H(0xa2)}:%`}`).length, 0, "no switch, no it's in");
      up.RUNNING.bootAt = (BLOCK_TS + 60) * 1000; // restarted after the allow, on that code
      await up.runningCheck();
      await up.runningCheck();
      assert.equal((await sql`select 1 from x_outbox where event_key = ${`update:running:${H(0xa2)}:${H(0x13)}`}`).length, 1, "once per allow");
      const r = tweets().length;
      assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
      assert.equal(tweets()[r], `Engine update is in: the engine now runs the new version. It has no release notes to show, so what it changes is not described here.\nhttps://etherscan.io/tx/${H(0x13)}`);
      // a third update allowed and already running before its "allowed" post: only "it's in" posts
      await up.onTimelockLogs(executed(H(0xa3), H(0xc2df), H(0x14)));
      up.RUNNING.composeHash = async () => `0x${"c2df".padStart(64, "0")}`;
      await up.runningCheck();
      assert.equal(await xM.sendHandler.run(job()), "skipped");
      assert.equal((await outbox(`update:executed:${H(0xa3)}:${H(0x14)}`)).status, "skipped", "superseded by it's in");
      // a release record that can't be read (not a 404) is never "no release notes": that post stays queued for the next
      // run while the others go out in this one; a signers' note once it has waited 2 h
      up.RELEASES.fetch = async () => new Response("busy", { status: 503 });
      await xM.publishEvent("change:normal", { event: "change_done", ref: "normal", change: "a normal change" }, `https://etherscan.io/tx/${H(0x15)}`);
      const runKey = `update:running:${H(0xa3)}:${H(0x14)}`;
      const b = tweets().length;
      assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId, "the next post went out");
      assert.equal(tweets()[b], `In effect: a normal change.\nhttps://etherscan.io/tx/${H(0x15)}`);
      assert.equal((await outbox(runKey)).status, "queued");
      assert.equal((await alerts("X post update:running:% still waits%")).length, 0, "not yet 2 h");
      await sql`update x_outbox set created_at = now() - interval '3 hours' where event_key = ${runKey}`;
      assert.match(String(await xM.sendHandler.run(job())), /^waiting/);
      assert.equal((await alerts("X post update:running:% still waits after 2 h: release record%HTTP 503")).length, 1);
      up.RELEASES.fetch = async () => new Response("", { status: 404 });
      assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
      assert.equal((await outbox(runKey)).status, "posted");
      // the Safe re-allowing the version this engine already ran before the allow: no "allowed", no "it's in" (alert only)
      up.RUNNING.bootAt = (BLOCK_TS - 60) * 1000;
      await up.onTimelockLogs(executed(H(0xa4), H(0xc2df), H(0x16)));
      assert.equal(await outbox(`update:executed:${H(0xa4)}:${H(0x16)}`), undefined);
      assert.equal((await sql`select 1 from x_outbox where event_key like 'update:running:%'`).length, 3, "the earlier three only");
      // the enclave report unreadable: the tick goes on, nothing said
      up.RUNNING.composeHash = async () => { throw new Error("dstack down"); };
      await up.onTimelockLogs([]);
    } finally {
      Object.assign(up.RUNNING, savedRun);
    }
  } finally {
    up.RELEASES.fetch = saved;
  }
});

test("a code update with no release notes: code's line (no writer), never a guess; a cancel supersedes the queued post", { skip }, async () => {
  const saved = up.RELEASES.fetch;
  up.RELEASES.fetch = async () => new Response("", { status: 404 });
  try {
    await up.onTimelockLogs(scheduled(H(0xb1), H(0xc2de), H(0x21)));
    const w = writerCalls(), n = tweets().length;
    assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
    const hm = new Date((BLOCK_TS + 3600) * 1000).toISOString().slice(11, 16);
    assert.equal(tweets()[n], `Engine update queued. It has no release notes to show, so what it changes is not described here. It can land from ${hm} UTC; the Safe can cancel it until then.\nhttps://etherscan.io/tx/${H(0x21)}`);
    assert.equal(writerCalls(), w, "the writer never saw it");

    await up.onTimelockLogs(scheduled(H(0xb2), H(0xc3de), H(0x22)));
    await up.onTimelockLogs(cancelled(H(0xb2), H(0x23)));
    await up.onTimelockLogs(cancelled(H(0xbeef), H(0x24))); // a timelock id that was never a code update
    assert.equal(await outbox(`update:cancelled:${H(0xbeef)}:${H(0x24)}`), undefined);
    assert.equal(await xM.sendHandler.run(job()), "skipped");
    const m = tweets().length;
    assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
    assert.equal(tweets()[m], `The Safe cancelled the queued engine update. Nothing changed.\nhttps://etherscan.io/tx/${H(0x23)}`);
    assert.equal((await alerts("Code update cancelled%")).length, 1);

    // the same batch scheduled again (same id): its own row, post and alert; the earlier cancel does not hide it
    const a0 = (await alerts("Code update scheduled%")).length;
    await up.onTimelockLogs(scheduled(H(0xb2), H(0xc3de), H(0x25)));
    assert.equal((await outbox(`update:scheduled:${H(0xb2)}:${H(0x25)}`)).status, "queued");
    assert.equal((await alerts("Code update scheduled%")).length, a0 + 1, "a signers' alert for the re-schedule too");
    const r = tweets().length;
    assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
    assert.match(tweets()[r], new RegExp(`^Engine update queued\\..*\n.*${H(0x25)}$`, "s"));
  } finally {
    up.RELEASES.fetch = saved;
  }
});

test("the Safe's queued op: its own post in plain words; the Safe's cancel supersedes it; the agent's ops stay with the queued post", { skip }, async () => {
  const w = (n: number) => toHex(n, { size: 32 });
  const data = encodeAbiParameters([{ type: "address" }, { type: "bytes32[4]" }], ["0x00000000000000000000000000000000000000a1", [w(3500), w(3000), w(2500), w(1000)]]);
  const eta = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const queued = (id: bigint, proposer: string, h: Hex) => ({ eventName: "Queued", args: { id, op: 4, proposer, data, eta }, transactionHash: h, logIndex: 0 });
  await xM.onChainEvent(queued(41n, d.safe, H(0x31)));
  const q = await outbox(`Queued:${H(0x31)}:0`);
  assert.deepEqual([q.event.event, q.event.who, q.event.change, q.event.split], ["change_queued", "the Safe", "a fee split change", { buybackPct: 35, liquidityPct: 30, treasuryPct: 25, gamesPct: 10 }]);
  assert.ok(await xM.onChainEvent(queued(42n, tx.addressOf("agent")!, H(0x32))), "the agent's own op: the existing queued post");
  assert.equal((await outbox(`Queued:${H(0x32)}:0`)).event.event, "queued");
  await sql`update x_outbox set status = 'skipped' where event_key = ${`Queued:${H(0x32)}:0`}`; // not this test's post

  const n = tweets().length;
  assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
  const at = new Date(Number(eta) * 1000).toISOString().slice(11, 16);
  assert.equal(tweets()[n], `The Safe queued a fee split change (buyback 35%, liquidity 30%, treasury 25%, games 10%). It can take effect from ${at} UTC unless the Safe cancels it first.\nhttps://etherscan.io/tx/${H(0x31)}`);

  // queued and cancelled before it went out: only the cancel posts
  await xM.onChainEvent(queued(43n, d.safe, H(0x33)));
  await xM.onChainEvent({ eventName: "Cancelled", args: { id: 43n }, transactionHash: H(0x34), logIndex: 1 });
  const c = await outbox(`Cancelled:${H(0x34)}:1`);
  assert.deepEqual([c.event.event, c.event.ref, c.event.change], ["change_cancelled", "op:43", "a fee split change"]);
  assert.equal(await xM.sendHandler.run(job()), "skipped");
  assert.equal((await outbox(`Queued:${H(0x33)}:0`)).status, "skipped");
  const m = tweets().length;
  assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
  assert.equal(tweets()[m], `The Safe cancelled a fee split change (buyback 35%, liquidity 30%, treasury 25%, games 10%). Nothing changed.\nhttps://etherscan.io/tx/${H(0x34)}`);

  // the Safe's veto of an op nobody saw queued stays with x.ts (never a change post)
  await xM.onChainEvent({ eventName: "Cancelled", args: { id: 99n }, transactionHash: H(0x35), logIndex: 0 });
  assert.equal((await outbox(`Cancelled:${H(0x35)}:0`)).event.event, "cancelled");
  // a pause is said at once; an unpause was said when its op was queued
  await xM.onChainEvent({ eventName: "AgentPaused", args: { paused: true }, transactionHash: H(0x36), logIndex: 0 });
  await xM.onChainEvent({ eventName: "AgentPaused", args: { paused: false }, transactionHash: H(0x37), logIndex: 0 });
  assert.equal((await outbox(`AgentPaused:${H(0x36)}:0`)).event.event, "change_done");
  assert.equal(await outbox(`AgentPaused:${H(0x37)}:0`), undefined);

  // the Safe's op went through before its post: said as in effect, not as waiting
  await xM.onChainEvent(queued(44n, d.safe, H(0x38)));
  await sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (800, 0, ${H(0x39)}, ${H(1)}, now(), ${d.registry.toLowerCase()}, 'Executed', ${sql.json({ id: "44", op: 4 })})`;
  const ex = await xM.resolve((await outbox(`Queued:${H(0x38)}:0`)).event);
  assert.match(String(ex?.stage), /went through: in effect now/);
  // a draw interval: proposed (the Safe's, or mine), cancelled from the latest proposal; game cancels in plain words
  await xM.onChainEvent({ eventName: "DrawIntervalProposed", args: { value: 86_400, eta: 1_900_000_000n, by: tx.addressOf("agent") }, transactionHash: H(0x3a), logIndex: 0 });
  assert.deepEqual([(await outbox(`DrawIntervalProposed:${H(0x3a)}:0`)).event.who, (await outbox(`DrawIntervalProposed:${H(0x3a)}:0`)).event.hours], ["me", 24]);
  await xM.onChainEvent({ eventName: "DrawIntervalCancelled", args: {}, transactionHash: H(0x3b), logIndex: 0 });
  assert.deepEqual([(await outbox(`DrawIntervalCancelled:${H(0x3b)}:0`)).event.event, (await outbox(`DrawIntervalCancelled:${H(0x3b)}:0`)).event.ref], ["change_cancelled", "interval:1900000000"]);
  for (const [i, name] of ["ListCancelled", "RewardCancelled", "BallotCancelled", "OutcomeCancelled", "CancelledByGuardian"].entries()) {
    await xM.onChainEvent({ eventName: name, args: {}, transactionHash: H(0x40 + i), logIndex: 0 });
    assert.equal((await outbox(`${name}:${H(0x40 + i)}:0`)).event.event, "change_cancelled", name);
  }
});
