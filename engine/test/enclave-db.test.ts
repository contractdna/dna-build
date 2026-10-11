// Enclave build against a real Postgres (fresh database) and local fakes (JSON-RPC, X, xAI) + the dstack mock (or the
// simulator when DSTACK_SIMULATOR_ENDPOINT is set): the enclave log chain (own head, log key, no signing oracle), signed
// state rows (seq-fresh), flags / mute / drafts from log records, agentOpGate, anchor-before-op, two-provider chain
// reads (cursor hash, timestamp, freshness, pinned reads) and the boot check (anchor sender, linearity, disk head).
// The process env stays a test env (lockdown is unit-tested in enclave.test.ts); enclave behavior is switched on here.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseGwei, type PublicClient, toFunctionSelector, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DstackClient } from "@phala/dstack-sdk";
import { startDstackMock } from "../scripts/dstack-mock.ts";
import { feeHistory, startFakes } from "../scripts/fakes.ts";
import { synthetic } from "../scripts/synthetic.ts";
import { ownerApprove, pinOwners } from "./owner-approve.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
fakes.llm.xai = (b) => synthetic("xai", b);
const dmock = process.env.DSTACK_SIMULATOR_ENDPOINT ? undefined : await startDstackMock();
const dbName = `dna_enclave_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
const KEY = {
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // anvil #2 (public test keys)
  anchor: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // anvil #3
  keeper: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // anvil #5
  log: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // anvil #6 (stands in for the TEE-derived log key)
} as const;
if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc,${fakes.url}/rpc`, ENGINE_MODE: "live", TX_POLL_MS: "5",
    XAI_API_BASE: fakes.url, XAI_API_KEY: "k", OPENROUTER_API_BASE: fakes.url, OPENROUTER_API_KEY_ENGINE: "k", LLM_MODE: "live", X_API_BASE: fakes.url, X_CLIENT_ID: "cid", X_REFRESH_TOKEN: "seed", X_USER_ID: "42",
    AGENT_PRIVATE_KEY: KEY.agent, ANCHOR_PRIVATE_KEY: KEY.anchor, KEEPER_PRIVATE_KEY: KEY.keeper, LOG_SIGNING_KEY: KEY.log, SECRET_SEAL_KEY: "11".repeat(32),
    TELEGRAM_ALLOWED_USER_IDS: "7",
  });
}
const { edb: sql, migrate } = await import("../src/db.ts");
const enclave = await import("../src/enclave.ts");
const log = await import("../src/log.ts");
const records = await import("../src/records.ts");
const modeM = await import("../src/mode.ts");
const tgM = await import("../src/telegram.ts");
const xM = await import("../src/x.ts");
const loop = await import("../src/loop.ts");
const keepers = await import("../src/keepers.ts");
const tx = await import("../src/tx.ts");
const head = await import("../src/head.ts");
const chainref = await import("../src/chainref.ts");
const abi = await import("../src/abi.ts");
const { d, GAS } = await import("../src/config.ts");
await pinOwners();

before(async () => {
  if (!ADMIN) return;
  await migrate();
  enclave.ENCLAVE.on = true;
  enclave.setDstack(new DstackClient(process.env.DSTACK_SIMULATOR_ENDPOINT ?? dmock!.url) as unknown as Parameters<typeof enclave.setDstack>[0]);
  await modeM.initMode(); // a fresh enclave: its first 'mode' record halts until a signer acts
});
after(async () => {
  enclave.ENCLAVE.on = false;
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await fakes.close();
  await dmock?.close();
});

const job = (over: Record<string, unknown> = {}) => ({ id: "0", kind: "t", payload: {}, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null, ...over }) as never;
const alerts = async (re: RegExp) => (await sql<{ t: string }[]>`select payload->>'text' as t from job where kind = 'alert'`).filter((r) => re.test(r.t)).length;
const noTrigger = async (fn: () => Promise<unknown>) => {
  await sql.unsafe("alter table log disable trigger log_no_update");
  try { await fn(); } finally { await sql.unsafe("alter table log enable trigger log_no_update"); }
};
/** A signer's /dryrun or /halt, or (null) an ENGINE_MODE change: a newer 'env' record clears the override. */
const setFlags = async (override: "dry_run" | "halted" | null) =>
  override ? modeM.setOverride(override, "telegram:signer-1") : log.append("mode", "env", { env: "live", previousEnv: "live" });
const ehashOf = async (ref: string) => (await sql<{ h: string; p: string }[]>`select encode(ehash, 'hex') as h, encode(eprev, 'hex') as p from log where ref = ${ref}`)[0];

// ---------------------------------------------------------------- fake chain
const sel = (sig: string) => toFunctionSelector(sig);
const chain = { block: 1000n, hashOf: (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`, sent: [] as `0x${string}`[], mine: true, logs: [] as unknown[] };
const agentAddr = tx.addressOf("agent")!;
const anchorAddr = tx.addressOf("anchor")!;
const logAddr = privateKeyToAccount(KEY.log).address;
const OURS = `0x${"33".repeat(32)}`; // tx hashes: one sent by this enclave's anchor key, one by another sender
const OTHER = `0x${"44".repeat(32)}`;
Object.assign(fakes.rpc, {
  eth_chainId: () => toHex(31337),
  eth_blockNumber: () => toHex(chain.block),
  eth_getBlockByNumber: ([tag]: [string]) => {
    const n = /^0x/.test(tag) ? BigInt(tag) : chain.block; // "latest" and "finalized" alike
    return { number: toHex(n), hash: chain.hashOf(n), parentHash: `0x${"00".repeat(32)}`, timestamp: "0x1", baseFeePerGas: toHex(parseGwei("1")), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], miner: `0x${"00".repeat(20)}`, difficulty: "0x0", extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, size: "0x0", stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, uncles: [], totalDifficulty: "0x0", mixHash: `0x${"00".repeat(32)}` };
  },
  eth_maxPriorityFeePerGas: () => "0x0", // what public RPCs answer: never read (fees come from eth_feeHistory)
  eth_feeHistory: (p: unknown[]) => feeHistory(p, parseGwei("1")),
  eth_estimateGas: () => toHex(100_000n),
  eth_call: ([c]: [{ data: string }]) =>
    c.data.startsWith(sel("agent()")) ? encodeAbiParameters([{ type: "address" }], [agentAddr])
    : c.data.startsWith(sel("agentPaused()")) ? encodeAbiParameters([{ type: "bool" }], [false]) : "0x",
  eth_getTransactionCount: () => toHex(chain.sent.length),
  eth_sendRawTransaction: ([raw]: [`0x${string}`]) => { chain.sent.push(raw); return keccak256(raw); },
  eth_getTransactionReceipt: ([h]: [string]) => (chain.mine && chain.sent.some((r) => keccak256(r) === h) ? {
    transactionHash: h, transactionIndex: "0x0", blockHash: `0x${"22".repeat(32)}`, blockNumber: toHex(chain.block), from: agentAddr, to: d.registry,
    cumulativeGasUsed: "0xc350", gasUsed: "0xc350", effectiveGasPrice: toHex(parseGwei("2")), contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2",
  } : null),
  eth_getTransactionByHash: ([h]: [string]) => ({
    hash: h, from: h === OURS ? anchorAddr : "0x000000000000000000000000000000000000dEaD", to: d.registry, blockHash: `0x${"22".repeat(32)}`, blockNumber: toHex(chain.block - 1n),
    transactionIndex: "0x0", nonce: "0x0", input: "0x", value: "0x0", gas: "0x5208", gasPrice: "0x1", type: "0x0", chainId: "0x7a69", v: "0x1b", r: "0x1", s: "0x1",
  }),
  eth_getLogs: () => chain.logs,
});
type Rpc = (p: unknown[]) => unknown;
/** A provider that answers like the fake chain except where `over` says otherwise. */
const provider = (over: Record<string, Rpc>) =>
  createPublicClient({ transport: custom({ request: async ({ method, params }) => (over[method] ?? (fakes.rpc[method] as Rpc))((params ?? []) as unknown[]) }) }) as PublicClient;

// ---------------------------------------------------------------- flags and mute from the log
test("a fresh enclave is halted and muted: no verified record = fail closed; DB rows are not read", { skip }, async () => {
  assert.equal((await modeM.getFlags()).mode, "halted", "the first boot's env record marks unsigned flags: halted");
  await sql`update engine_flags set override = null`;
  assert.equal((await modeM.getFlags()).mode, "halted", "the engine_flags row can't un-halt the enclave");
  assert.equal(modeM.overrideOf(undefined, undefined), "halted");
  assert.equal(modeM.overrideOf({ env: "live", _seq: "5" }, { override: "dry_run", _seq: "4" }), null, "a newer env record clears an older override");
  assert.equal(modeM.overrideOf({ env: "live", _seq: "5" }, { override: "dry_run", _seq: "6" }), "dry_run");
  await sql`insert into state (key, block, value) values ('x_mute', 0, '{"muted":false,"by":"db"}') on conflict (key) do update set value = excluded.value`;
  assert.equal(await xM.muted(), true, "no verified mute record: muted");
});

// ---------------------------------------------------------------- the enclave log chain
test("enclave log chain: the log key signs, appends chain on the enclave's own head, a forged row is skipped, the DB is no signing oracle", { skip }, async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => log.append("alert", `c${i}`, { i })));
  const v = await log.verify(sql as never);
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.signer, logAddr.toLowerCase(), "records are signed by the log key");
  assert.notEqual(v.signer, agentAddr.toLowerCase(), "never by the agent EOA");
  assert.ok(v.ehashes.size >= 12);
  assert.equal((await records.latest<{ i: number }>("alert", "c3"))?.i, 3);
  // a row the DB made up (it can call log_append, never sign): skipped on load and alerted, never a link
  await sql`select log_append('alert', 'forged', '{"i":99}', true)`;
  assert.equal(await records.latest("alert", "forged"), undefined, "ignored on load");
  assert.ok((await alerts(/foreign or stale alert record/)) >= 1, "and alerted");
  await log.append("alert", "after-forged", { ok: true });
  assert.notEqual((await ehashOf("after-forged")).p, (await ehashOf("forged")).h, "the next record chains on the enclave's head, not on the forged row");
  const v2 = await log.verify(sql as never);
  assert.ok(v2.ok && v2.foreign >= 1, JSON.stringify(v2));
  // a DB that rewrites the body on insert gets nothing signed: the engine recomputes ehash first
  await sql.unsafe(`create function evil() returns trigger language plpgsql as $$ begin
    new.body := '{"evil":true}'; new.body_hash := sha256(convert_to(new.body, 'UTF8')); new.ehash := sha256(new.eprev || new.body_hash); return new; end $$`);
  await sql.unsafe("create trigger evil before insert on log for each row when (new.ref = 'oracle') execute function evil()");
  try {
    await assert.rejects(log.append("alert", "oracle", { ok: true }), /refusing to sign/);
  } finally {
    await sql.unsafe("drop trigger evil on log; drop function evil()");
  }
  assert.equal((await sql`select 1 from log where ref = 'oracle'`).length, 0, "rolled back");
  await log.append("alert", "after-oracle", {});
  // a plain (pre-enclave) row is not part of the chain and is not trusted either
  await sql`select log_append('alert', 'plain', '{}')`;
  assert.equal(await records.latest("alert", "plain"), undefined);
  await log.append("alert", "after-plain", { ok: true });
  assert.ok((await log.verify(sql as never)).ok);
  // tampering a signed body breaks the record
  await noTrigger(() => sql`update log set body = '{"i":4}' where ref = 'c3' and kind = 'alert'`);
  await assert.rejects(records.latest("alert", "c3"), /hides the enclave's newest record/, "a broken newest record is a rollback, not an older one");
  assert.equal((await log.verify(sql as never)).ok, false);
  await noTrigger(() => sql`update log set body = '{"i":3}' where ref = 'c3' and kind = 'alert'`);
  // the commit lands but its acknowledgement is lost: the record (found by its ehash, verified) becomes the head
  const begin = log.LOG_TX.begin;
  log.LOG_TX.begin = (async (fn: Parameters<typeof begin>[0]) => { await begin(fn); throw new Error("connection reset"); }) as typeof begin;
  let lost;
  try { lost = await log.append("alert", "lost-ack", {}); } finally { log.LOG_TX.begin = begin; }
  assert.equal(log.enclaveHead()?.seq, lost.seq);
  await log.append("alert", "after-lost-ack", {});
  assert.ok((await log.verify(sql as never)).ok, "the next record links to it");
});

// ---------------------------------------------------------------- rollback by hiding rows
/** Delete one log row (kept aside); the returned function puts it back. */
const hideRow = async (seq: string) => {
  await sql`create table if not exists hidden_log as select * from log with no data`;
  await sql`insert into hidden_log select * from log where seq = ${seq}`;
  await noTrigger(() => sql`delete from log where seq = ${seq}`);
  return () => sql`insert into log (seq, at, kind, ref, body, body_hash, prev_hash, hash, eprev, ehash, esig)
    select seq, at, kind, ref, body, body_hash, prev_hash, hash, eprev, ehash, esig from hidden_log where seq = ${seq}`;
};
const newestSeq = async (kind: string, ref: string) => (await sql<{ s: string }[]>`select seq::text as s from log where kind = ${kind} and ref = ${ref} order by log.seq desc limit 1`)[0].s;

test("rollback: hiding the enclave's newest record halts, keeps mute, keeps a done draft done and an old state row dead", { skip }, async () => {
  await setFlags(null);
  await modeM.setOverride("halted", "telegram:signer-1");
  await log.append("alert", "after-halt", {});
  // a restart: the boot check alone must know the newest override (it lies before the disk head: the hash-only walk)
  log.newest.clear();
  const path = join(mkdtempSync(join(tmpdir(), "dna-head-")), "head.json");
  head.writeHead({ ...log.enclaveHead()!, scannedTo: Number(chain.block), anchored: true }, path);
  await head.bootCheck(path);
  let restore = await hideRow(await newestSeq("mode", "override"));
  assert.equal((await modeM.getFlags()).mode, "halted", "the newest override is gone: never un-halted on the DB's word");
  assert.ok((await alerts(/hides the newest mode override record/)) >= 1);
  await restore();
  await setFlags(null);

  await xM.setMuted(false, "telegram:signer-1");
  await xM.setMuted(true, "telegram:signer-1");
  restore = await hideRow(await newestSeq("mode", "x_mute"));
  assert.equal(await xM.muted(), true, "the older unmute record does not count");
  await restore();

  const id = await tgM.createDraft("x_post", { text: "once" });
  assert.match(await ownerApprove(id), /approved by Safe owner/);
  const sent: unknown[] = [];
  const h = tgM.draftHandler({ x_post: async (p) => sent.push(p.text) });
  await h.run(job({ payload: { id } }));
  restore = await hideRow(await newestSeq("draft", id)); // its 'done' record
  await sql`update draft set status = 'approved' where id = ${id}`;
  assert.match(String(await h.run(job({ payload: { id } }))), /no verified approval record/);
  assert.deepEqual(sent, ["once"], "published once");
  await restore();

  await loop.setLoop({ cycle: 20, threadCycles: 1, seen: [] });
  const [old] = await sql<{ value: unknown; sig: string }[]>`select value, sig from state where key = 'loop'`;
  await loop.setLoop({ cycle: 21, threadCycles: 1, seen: [] });
  restore = await hideRow(await newestSeq("state", "state:loop"));
  await sql`update state set value = ${sql.json(old.value as never)}, sig = ${old.sig} where key = 'loop'`;
  assert.equal((await loop.getLoop()).cycle, 0, "the older signed row is not resurrected by hiding the newer state record");
  await restore();
  await xM.setMuted(false, "telegram:signer-1");
});

// ---------------------------------------------------------------- signed state
test("signed state: unsigned, edited or replayed-older rows are ignored; flags, mute and drafts follow the log records", { skip }, async () => {
  await loop.setLoop({ cycle: 7, threadCycles: 1, seen: [] });
  const [old] = await sql<{ value: unknown; sig: string }[]>`select value, sig from state where key = 'loop'`;
  await loop.setLoop({ cycle: 8, threadCycles: 1, seen: [] });
  assert.equal((await loop.getLoop()).cycle, 8);
  await sql`update state set value = ${sql.json(old.value as never)}, sig = ${old.sig} where key = 'loop'`;
  assert.equal((await loop.getLoop()).cycle, 0, "an older row the enclave did sign, replayed by the DB, is refused");
  await loop.setLoop({ cycle: 9, threadCycles: 1, seen: [] });
  await sql`update state set value = jsonb_set(value, '{cycle}', '99') where key = 'loop'`;
  assert.equal((await loop.getLoop()).cycle, 0, "a tampered loop state restarts empty");

  // drafts: the signed pending record is what an approval publishes; done can't go back to approved
  const id = await tgM.createDraft("x_post", { text: "the pinned notice" });
  await sql`update draft set payload = jsonb_set(payload, '{text}', '"buy now"') where id = ${id}`;
  assert.match(await ownerApprove(id), /approved by Safe owner/);
  const sent: unknown[] = [];
  const h = tgM.draftHandler({ x_post: async (p) => sent.push(p.text), idea_outcome: async () => sent.push("SENT") });
  await h.run(job({ payload: { id } }));
  assert.deepEqual(sent, ["the pinned notice"], "the signed payload, not the edited row");
  await sql`update draft set status = 'approved' where id = ${id}`; // the DB replays the approval
  assert.match(String(await h.run(job({ payload: { id } }))), /no verified approval record/);
  assert.equal(await tgM.decide(id, true, 7), false, "decided once");
  const forged = (await sql<{ id: string }[]>`insert into draft (kind, payload, status) values ('idea_outcome', '{"text":"x"}', 'approved') returning id::text`)[0].id;
  assert.match(String(await h.run(job({ payload: { id: forged } }))), /no verified approval record/);
  const pending = await tgM.createDraft("x_post", { text: "later" });
  await sql`update draft set status = 'approved' where id = ${pending}`;
  assert.match(String(await h.run(job({ payload: { id: pending } }))), /no verified approval record/, "a pending draft the DB marks approved");
  // an enclave-signed approval record without a Safe owner's signature (an allowlist decision) never dispatches
  const unsigned = await tgM.createDraft("x_post", { text: "unsigned" });
  assert.equal(await tgM.decide(unsigned, true, 7), true);
  assert.match(String(await h.run(job({ payload: { id: unsigned } }))), /no Safe owner's approval signature/);
  assert.deepEqual(sent, ["the pinned notice"]);

  await modeM.setOverride("halted", "telegram:signer-1");
  assert.equal((await modeM.getFlags()).mode, "halted");
  await sql`update engine_flags set override = null`; // the DB tries to un-halt
  assert.equal((await modeM.getFlags()).mode, "halted");
  await setFlags(null);
  assert.equal((await modeM.getFlags()).mode, "live");

  await xM.setMuted(false, "telegram:signer-1"); // a signer's /unmute: the outbox and replies run
  await xM.enqueueX("RolledBack:0xaa:0", "post", { event: "rolled_back", route: "fee" });
  await sql`update x_outbox set event = '{"event":"outcome","outcome":"kept","plate":"Z","samples":999}' where event_key = 'RolledBack:0xaa:0'`;
  assert.equal(await xM.sendHandler.run(job()), "skipped");
  assert.equal((await sql`select error from x_outbox where event_key = 'RolledBack:0xaa:0'`)[0].error, "unsigned outbox row");

  await sql`insert into x_mention (id, author_id, text, raw) values ('3001', '9', 'what is the cap rule?', '{"id":"3001","text":"what is the cap rule?"}')`;
  assert.deepEqual(await xM.repliesHandler.run(job()), { 3001: "unsigned mention row" }, "a mention the enclave did not fetch is never answered");

  await xM.setMuted(false, "telegram:signer-1");
  assert.equal(await xM.muted(), false);
  await xM.setMuted(true, "telegram:signer-1");
  await sql`update state set value = '{"muted":false,"by":"db"}' where key = 'x_mute'`;
  assert.equal(await xM.muted(), true, "the DB can't unmute");
  await xM.setMuted(false, "telegram:signer-1");
});

test("kind and ref are signed: a relabelled row is foreign (an alert as a mode override, one draft's approval as another's)", { skip }, async () => {
  await setFlags(null);
  await modeM.setOverride("halted", "telegram:signer-1");
  const lure = await log.append("alert", "lure", { override: null, by: "db" }); // newer, signed, but an alert
  await noTrigger(() => sql`update log set kind = 'mode', ref = 'override' where seq = ${lure.seq}`);
  assert.equal((await modeM.getFlags()).mode, "halted", "the relabelled alert is not an override");
  await noTrigger(() => sql`update log set kind = 'alert', ref = 'lure' where seq = ${lure.seq}`);
  await setFlags(null);

  const b = await tgM.createDraft("x_post", { text: "draft B" });
  const a = await tgM.createDraft("x_post", { text: "draft A" });
  assert.match(await ownerApprove(a), /approved by Safe owner/);
  const approvedA = await newestSeq("draft", a);
  await noTrigger(() => sql`update log set ref = ${b} where seq = ${approvedA}`);
  await sql`update draft set status = 'approved' where id = ${b}`;
  const sent: unknown[] = [];
  assert.match(String(await tgM.draftHandler({ x_post: async (p) => sent.push(p.text) }).run(job({ payload: { id: b } }))), /no verified approval record/);
  assert.deepEqual(sent, [], "A's approval never publishes under B");
  await noTrigger(() => sql`update log set ref = ${a} where seq = ${approvedA}`);
});

test("every append moves the disk head: a tampered newest record can't vanish across a restart", { skip }, async () => {
  const path = join(mkdtempSync(join(tmpdir(), "dna-head-")), "head.json");
  head.writeHead({ ...log.enclaveHead()!, scannedTo: Number(chain.block), anchored: true }, path);
  await head.bootCheck(path);
  await modeM.setOverride("halted", "telegram:signer-1");
  assert.equal(head.readHead(path)!.seq, log.enclaveHead()!.seq, "synced by the append, not a minute later");
  const seq = await newestSeq("mode", "override");
  const [{ body }] = await sql<{ body: string }[]>`select body from log where seq = ${seq}`;
  await noTrigger(() => sql`update log set body = ${'{"by":"db","override":"dry_run"}'} where seq = ${seq}`);
  log.newest.clear(); // a restart before any heartbeat
  await assert.rejects(head.bootCheck(path), /does not descend/, "the disk head names the tampered record");
  await noTrigger(() => sql`update log set body = ${body} where seq = ${seq}`);
  await head.bootCheck(path);
  await setFlags(null);
});

test("a failed disk-head write never fails a committed append (alerted; the heartbeat retries)", { skip }, async () => {
  const saved = head.HEAD_FILE.active;
  head.HEAD_FILE.active = "/dev/null/no-dir/head.json"; // mkdir under a file: the write throws
  try {
    const r = await log.append("alert", "head-write-fails", {});
    assert.equal(log.enclaveHead()?.seq, r.seq, "committed and the head advanced");
    assert.ok((await alerts(/disk head could not be written/)) >= 1);
    assert.match(tx.AGENT_HOLD.why ?? "", /disk head/, "agent txs wait while the disk head lags");
    assert.match(head.persistHead() ?? "", /./, "the heartbeat path does not throw either");
  } finally {
    head.HEAD_FILE.active = saved;
  }
  assert.equal(head.persistHead(), null, "a write that succeeds…");
  assert.equal(tx.AGENT_HOLD.why, null, "…releases the hold");
});

test("the daily anchor roots on the enclave's own newest record, never a row the DB made up", { skip }, async () => {
  await setFlags(null);
  const ours = await log.append("alert", "day-ours", {});
  await sql`select log_append('alert', 'day-forged', '{"x":1}', true)`; // newer, and the DB gives it a signature of its own:
  await sql`update log set esig = ${`0x${"11".repeat(65)}`} where ref = 'day-forged'`; // (the one update the log allows)
  const day = new Date().toISOString().slice(0, 10);
  await keepers.anchorHandler.run(job({ payload: { day } }));
  assert.equal((await records.latest<{ root: string }>("anchor", day))?.root, `0x${ours.ehash}`);
});

test("a record appended while a load is reading is not a rollback (newest snapshotted before the read)", { skip }, async () => {
  const seq = await newestSeq("mode", "override");
  const saved = [log.newest.get("mode"), log.newest.get("mode:override")];
  setImmediate(() => log.noteNewest("mode", "override", "999999")); // lands while the SELECT is in flight
  try {
    assert.equal((await records.latest("mode", "override"))?._seq, seq);
  } finally {
    log.newest.set("mode", saved[0]!);
    log.newest.set("mode:override", saved[1]!);
  }
});

test("agentOpGate: an agent op no signed experiment owns is refused; a watcher's kill hint is not taken from the DB", { skip }, async () => {
  assert.equal(await loop.agentOpGate("4242"), "not owned by an experiment of this enclave");
  assert.equal(loop.killHintOf({ kill: "ModuleFailed from the canary plate" }), undefined, "re-derived from verified chain reads");
});

// ---------------------------------------------------------------- anchor before op
test("anchor-before-op: intent record (with calldata) → anchor mined → queue tx → result record; not mined in time → dropped", { skip }, async () => {
  await setFlags("dry_run");
  const plate = "0x00000000000000000000000000000000000000a1";
  await keepers.queueOp("SetShadow", [plate]);
  const rows = await sql<{ seq: string; kind: string; ref: string; doc: Record<string, any> }[]>`select seq::text, kind, ref, doc from log where kind in ('anchor', 'tx') order by log.seq`; // eslint-disable-line @typescript-eslint/no-explicit-any
  const intent = rows.find((r) => r.doc.kind === "intent")!;
  const q = await import("../src/lib.ts").then((l) => l.encodeOp("SetShadow", [plate]));
  assert.equal(intent.doc.calldata, encodeFunctionData({ abi: abi.registryAbi, functionName: "queue", args: [q.op, q.data] }), "the record carries the exact queue calldata");
  assert.ok(intent.doc.tcb?.mrtd, "tcb_info in the anchored record");
  const [ehash] = await sql<{ h: string }[]>`select encode(ehash, 'hex') as h from log where seq = ${intent.seq}`;
  const anchorTx = rows.find((r) => r.ref === `anchor:op:${intent.seq}`)!;
  assert.equal(anchorTx.doc.args[0], `0x${ehash.h}`, "the anchored root is the intent's enclave hash");
  assert.equal(anchorTx.doc.args[1], `https://genomedna.xyz/api/log/${intent.seq}`);
  const queueTx = rows.find((r) => r.ref === "agent:queue:SetShadow")!;
  const result = rows.find((r) => r.doc.kind === "queued")!;
  assert.ok(Number(intent.seq) < Number(anchorTx.seq) && Number(anchorTx.seq) < Number(queueTx.seq) && Number(queueTx.seq) < Number(result.seq), "intent → anchor → queue → result");

  // live, the anchor never mines in time: the op is dropped for this cycle, the queue tx never sent
  await setFlags(null);
  const saved = [keepers.ANCHOR_OP.timeoutMs, GAS.timeoutMs];
  chain.mine = false;
  keepers.ANCHOR_OP.timeoutMs = 50;
  GAS.timeoutMs = 400;
  try {
    const sent = chain.sent.length;
    await assert.rejects(keepers.queueOp("SetShadow", [plate]), (e: Error & { final?: boolean }) => /dropped this cycle/.test(e.message) && e.final === true);
    // the op gives up on its anchor after 50 ms, but the abandoned anchor send goes on (estimate, fees, its pending
    // record, then the broadcast): count only once it has run out, so a slow broadcast is not read as none
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(chain.sent.length, sent + 1, "only the anchor tx went out");
    assert.ok((await sql`select 1 from log where kind = 'anchor' and doc->>'kind' = 'dropped'`).length);
    assert.equal((await sql`select count(*)::int as n from log where kind = 'tx' and ref = 'agent:queue:SetShadow' and doc->>'mode' = 'live'`)[0].n, 0);
  } finally {
    chain.mine = true;
    [keepers.ANCHOR_OP.timeoutMs, GAS.timeoutMs] = saved;
  }
});

test("game agent calls are anchored first like queue ops: intent (calldata) → anchor mined → the call → sent record", { skip }, async () => {
  await setFlags(null);
  await keepers.agentCall({ to: d.registry, abi: abi.registryAbi, fn: "agentPaused", args: [], purpose: "agent:game:test" });
  const rows = await sql<{ seq: string; kind: string; ref: string; doc: Record<string, any> }[]>`select seq::text, kind, ref, doc from log where kind in ('anchor', 'tx') order by log.seq`; // eslint-disable-line @typescript-eslint/no-explicit-any
  const intent = rows.findLast((r) => r.doc.kind === "intent")!;
  assert.equal(intent.doc.fn, "agentPaused");
  assert.equal(intent.doc.calldata, encodeFunctionData({ abi: abi.registryAbi, functionName: "agentPaused" }));
  const anchorTx = rows.find((r) => r.ref === `anchor:op:${intent.seq}` && r.doc.status === "mined")!;
  const call = rows.find((r) => r.ref === "agent:game:test" && r.doc.status === "mined")!;
  const sent = rows.find((r) => r.ref === `op:${intent.seq}` && r.doc.kind === "sent")!;
  assert.ok(Number(intent.seq) < Number(anchorTx.seq) && Number(anchorTx.seq) < Number(call.seq) && Number(call.seq) < Number(sent.seq), "intent → anchor → call → sent");
});

// ---------------------------------------------------------------- chain inputs
test("chain inputs: both providers agree on the cursor's block hash and time, the cursor is fresh, pinned reads agree; the cycle ref is replayable", { skip }, async () => {
  const c = (hash: string) => provider({ eth_getBlockByNumber: (p) => ({ ...(fakes.rpc.eth_getBlockByNumber as Rpc)(p) as object, hash }) });
  assert.equal(await chainref.agreedHash(5, [c(`0x${"ab".repeat(32)}`), c(`0x${"ab".repeat(32)}`)]), `0x${"ab".repeat(32)}`);
  await assert.rejects(chainref.agreedHash(5, [c(`0x${"ab".repeat(32)}`), c(`0x${"cd".repeat(32)}`)]), /disagree/);
  await assert.rejects(chainref.agreedHash(5, [c(`0x${"ab".repeat(32)}`)]), /two RPC providers/);
  const blockTime = new Date(1000); // the fake chain's blocks are all at timestamp 1
  await sql`insert into cursor (id, block, hash, at) values (1, 990, ${chain.hashOf(990n)}, ${blockTime})`;
  assert.equal((await chainref.cursorAgreed())!.block, 990);
  await sql`update cursor set hash = ${`0x${"ee".repeat(32)}`}`;
  await assert.rejects(chainref.cursorAgreed(), /not the providers'/, "a DB cursor on another chain: no gate or kill decision");
  await sql`update cursor set hash = ${chain.hashOf(990n)}, at = now()`;
  await assert.rejects(chainref.cursorAgreed(), /time .* is not the block's/, "a cursor whose time is not its block's");
  await sql`update cursor set block = 900, hash = ${chain.hashOf(900n)}, at = ${blockTime}`;
  await assert.rejects(chainref.cursorAgreed(), /trails the providers' finalized 1000 by more than 50/, "a stale cursor (the DB stopped indexing)");
  await sql`update cursor set block = 990, hash = ${chain.hashOf(990n)}`;

  const id = (n: number) => provider({ eth_chainId: () => toHex(n) });
  assert.equal(await chainref.readAgreed((x) => x.getChainId(), [id(1), id(1)]), 1);
  await assert.rejects(chainref.readAgreed((x) => x.getChainId(), [id(1), id(2)]), /disagree on a gate\/kill read/);
  await assert.rejects(chainref.readAgreed((x) => x.getChainId(), [id(1)]), /two RPC providers/);

  const fin = (n: bigint) => provider({ eth_getBlockByNumber: ([tag]) => (fakes.rpc.eth_getBlockByNumber as Rpc)([tag === "finalized" ? toHex(n) : tag]) });
  assert.equal((await chainref.cursorAgreed([fin(1000n), fin(1000n)]))!.block, 990);
  await assert.rejects(chainref.cursorAgreed([fin(1000n), fin(1100n)]), /trails the providers' finalized 1100/, "≤ 50 behind BOTH: the furthest provider counts");

  const ref = await chainref.chainRef([{ block: 899, log_index: 0, tx: "0x1", event: "Swap", args: {} }], 900, chain.hashOf(900n), 1234);
  const host = "127.0.0.1:" + new URL(fakes.url).port;
  assert.deepEqual([ref.fromBlock, ref.toBlock, ref.toBlockHash, ref.hosts], [899, 900, chain.hashOf(900n), [host, host]]);
  assert.deepEqual([ref.events, ref.addresses, ref.poolId, ref.fromMs], [["Swap", "FeeTaken", "ShadowFee", "ModuleFailed"], { Swap: d.poolManager, rest: d.hook }, d.poolId, 1234], "what to replay");
});

// ---------------------------------------------------------------- boot check
test("boot check: only this enclave's anchors count, both providers agree, the disk head is reached, the enclave chain is linear", { skip }, async () => {
  const path = join(mkdtempSync(join(tmpdir(), "dna-head-")), "head.json");
  const anchoredLog = (root: string, txHash: string) => ({
    address: d.registry, topics: encodeEventTopics({ abi: abi.registryAbi, eventName: "Anchored", args: { root: root as `0x${string}` } }), data: encodeAbiParameters([{ type: "string" }], ["u"]),
    blockNumber: toHex(chain.block - 1n), logIndex: "0x0", transactionHash: txHash, transactionIndex: "0x0", blockHash: `0x${"22".repeat(32)}`, removed: false,
  });
  const ROGUE = `0x${"77".repeat(32)}`;
  // no disk head and no root of ours, but another sender's anchors: boots (a first enclave boot) and says so loudly
  chain.logs = [anchoredLog(ROGUE, OTHER)];
  const first = await head.bootCheck(path);
  assert.equal(first.needsAnchor, true);
  await assert.rejects(tx.send({ key: "agent", to: d.registry, abi: abi.registryAbi, fn: "agent", purpose: "t" }), /boot anchor is not mined yet/, "agent txs wait");
  await modeM.setOverride("halted", "telegram:signer-1");
  const sentBefore = chain.sent.length;
  await head.bootAnchor(); // whatever the mode
  assert.equal(chain.sent.length, sentBefore + 1);
  assert.equal(tx.AGENT_HOLD.why, null, "released once mined");
  assert.equal(head.readHead(path)?.anchored, true, "remembered on disk");
  assert.equal((await head.bootCheck(path)).needsAnchor, false, "a restart does not hold agent txs again");
  assert.equal(tx.AGENT_HOLD.why, null);
  const [firstEnv] = await sql<{ h: string }[]>`select encode(ehash, 'hex') as h from log where kind = 'mode' and ref = 'env' order by log.seq limit 1`;
  assert.equal((await records.latest<{ root: string }>("anchor", (await sql<{ r: string }[]>`select ref as r from log where kind = 'anchor' and ref like 'boot:%'`)[0].r))?.root, firstEnv.h, "root = the first mode env record");
  await setFlags(null);
  assert.equal(first.anchored, undefined, "another sender's root is not ours to hold the DB to");
  assert.ok((await alerts(/no root anchored by this enclave's anchor key and no disk head/)) >= 1);
  assert.equal(log.enclaveHead()?.ehash, (await log.verify(sql as never)).enclaveHead?.slice(2), "the boot sets the log's head");

  const a = await log.append("alert", "boot-a", {});
  chain.logs = [anchoredLog(`0x${a.ehash}`, OURS), anchoredLog(ROGUE, OTHER)];
  const ok = await head.bootCheck(path);
  assert.equal(ok.anchored?.root, a.ehash, "the newest root sent by the anchor key, not a later one from someone else");
  head.syncHead(ok.scannedTo, path);
  assert.equal(head.readHead(path)!.ehash, a.ehash);
  await log.append("alert", "boot-b", {});
  await head.bootCheck(path); // newer than the disk head: fine
  head.syncHead(ok.scannedTo, path);
  assert.equal(head.readHead(path)!.ehash, (await ehashOf("boot-b")).h);

  chain.logs = [anchoredLog(ROGUE, OURS)];
  await assert.rejects(head.bootCheck(path), /latest anchored root .* is not in the DB/);
  chain.logs = [anchoredLog(`0x${a.ehash}`, OURS)];
  const view = (logs: unknown[]) => provider({ eth_getLogs: () => logs });
  await assert.rejects(head.latestAnchored(0n, [view(chain.logs), view([])]), /disagree on the registry's Anchored events/, "a provider hiding the newest anchor");

  head.writeHead({ ehash: "88".repeat(32), seq: "1", scannedTo: Number(chain.block) }, path);
  await assert.rejects(head.bootCheck(path), /the disk head .* is not in the DB/, "a DB rolled back below the disk head");
  head.writeHead({ ehash: a.ehash!, seq: a.seq, scannedTo: Number(chain.block) }, path);

  // a row the DB made up: skipped and alerted, not fatal
  await sql`select log_append('alert', 'boot-forged', '{}', true)`;
  await head.bootCheck(path);
  assert.ok((await alerts(/skipped 1 foreign or tampered log row/)) >= 1);

  // two signed records on the same parent (a fork, or a rollback the enclave then extended): refused
  const h0 = log.enclaveHead()!;
  log.setHead({ ehash: a.ehash!, seq: a.seq });
  await log.append("alert", "boot-fork", { fork: true });
  await assert.rejects(head.bootCheck(path), /does not link to the previous enclave record/);
  const v = await log.verify(sql as never);
  assert.match(v.ok ? "" : v.error, /forks or was rolled back/);
  // the heartbeat never moves the disk head back to a lower seq
  head.writeHead({ ...h0, scannedTo: 1 }, path);
  log.setHead({ ehash: a.ehash!, seq: a.seq });
  head.syncHead(1, path);
  assert.equal(head.readHead(path)!.seq, h0.seq);
  await noTrigger(() => sql`delete from log where ref = 'boot-fork'`);
  log.setHead(h0);
  await head.bootCheck(path);
  assert.ok((await log.verify(sql as never)).ok);
});

// ---------------------------------------------------------------- /attestation
test("/attestation: a fresh quote whose report_data = sha256(nonce ‖ enclave log head ‖ agent ‖ anchor ‖ log signer), with the app's info", { skip }, async () => {
  const { attestation, nonceOk } = await import("../src/attest.ts");
  const { reportDataOf } = await import("../src/proof.ts");
  assert.ok(nonceOk("ab".repeat(32)) && nonceOk("0x01") && !nonceOk("ab".repeat(33)) && !nonceOk("zz") && !nonceOk(null) && !nonceOk("abc"));
  await log.append("alert", "attest", {});
  const nonce = "5a".repeat(32);
  const a = await attestation(nonce);
  assert.equal(`0x${a.logHead}`, (await log.verify(sql as never)).enclaveHead);
  assert.equal(a.reportData, reportDataOf(nonce, a.logHead, a));
  assert.equal(a.logSigner, logAddr, "the log key, bound into the quote");
  assert.equal(a.anchor, anchorAddr);
  if (process.env.DSTACK_SIMULATOR_ENDPOINT) {
    const { Quote } = await import("@phala/dcap-qvl");
    const td = Quote.parse(Buffer.from(a.quote.replace(/^0x/, ""), "hex")).report;
    const rd = Buffer.from((td.asTd10() ?? td.asTd15()!.base).reportData).toString("hex");
    assert.ok(rd.startsWith(a.reportData), "the simulator's quote carries our report data");
  } else assert.ok(a.quote.endsWith(a.reportData));
  assert.equal(a.agent, agentAddr);
  assert.notEqual(a.agent, a.anchor);
  assert.ok(a.info.composeHash && a.info.tcb.mrtd && Array.isArray(a.eventLog));
  assert.ok(a.rpcHosts.every((h) => !h.includes("key")));
});
