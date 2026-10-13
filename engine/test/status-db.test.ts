// The status, recap, milestone and module-approval posts against a real Postgres: each key is announced on the site and
// queued for X once (a retried job, a second run in the same window or an hourly re-check never doubles it), a quiet
// window posts nothing, a stale run posts nothing, the proof link is the signed record. Needs TEST_DATABASE_URL (CI).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { startFakes } from "../scripts/fakes.ts";
import { synthetic } from "../scripts/synthetic.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
/** What the X writer drafts next (null: the synthetic writer). */
let drafts: string[] | null = null;
fakes.llm.xai = (b) => {
  const r = synthetic("xai", b);
  const schema = b.text?.format?.schema ?? b.response_format?.json_schema?.schema; // the Responses or the chat shape
  if (drafts && "candidates" in (schema?.properties ?? {})) r.output[0].content[0].text = JSON.stringify({ candidates: drafts });
  return r;
};
const dbName = `dna_status_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, ENGINE_MODE: "live", RPC_URL: `${fakes.url}/rpc`,
    TELEGRAM_API_BASE: fakes.url, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_ID: "-100", TELEGRAM_ALLOWED_USER_IDS: "7", TELEGRAM_POLL_TIMEOUT_S: "1",
    XAI_API_BASE: fakes.url, OPENROUTER_API_BASE: fakes.url, XAI_API_KEY: "k", OPENROUTER_API_KEY_ENGINE: "k", LLM_MODE: "record", LLM_FIXTURES: `${mkdtempSync(join(tmpdir(), "dna-llm-"))}/`,
    X_API_BASE: fakes.url, X_CLIENT_ID: "cid", X_REFRESH_TOKEN: "seed", X_USER_ID: "42", SECRET_SEAL_KEY: "11".repeat(32), X_POST_SPACING_MIN: "0",
  });
}
// imported only after the env is set (config is read at import)
const { edb: sql, migrate } = await import("../src/db.ts");
const status = await import("../src/status.ts");
const xM = await import("../src/x.ts");
const modeM = await import("../src/mode.ts");
const { d, MEDIA } = await import("../src/config.ts");
const card = await import("../src/card.ts");
/** What `f` returns, and the art requests a studio (stubbed: it accepts every request) got meanwhile, as "key scene". */
async function artAsked(f: () => Promise<unknown>) {
  const asked: string[] = [];
  const [url, fetch0] = [MEDIA.studioUrl, card.STUDIO.fetch];
  MEDIA.studioUrl = "https://studio.test";
  card.STUDIO.fetch = async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init!.body)) as { eventKey: string; slots: { event: string } };
    asked.push(`${b.eventKey} ${b.slots.event}`);
    return new Response("{}", { status: 202 });
  };
  try { return { r: await f(), asked: asked.sort() }; } finally { MEDIA.studioUrl = url; card.STUDIO.fetch = fetch0; }
}
const { announce, recordUrl } = await import("../src/announce.ts");

before(async () => { if (ADMIN) { await migrate(); await modeM.initMode(); } });
after(async () => {
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await fakes.close();
});

const ZERO = "0x0000000000000000000000000000000000000000";
let block = 0;
/** An indexed burn (a Transfer to 0x0) of `dna` whole tokens, now: DNA's own log unless `address` says otherwise. */
const burn = (dna: bigint, address = d.token.toLowerCase()) => sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args)
  values (${++block}, 0, ${`0x${block.toString(16)}`}, '0x', now(), ${address}, 'Transfer', ${sql.json({ from: "0x00000000000000000000000000000000000000b8", to: ZERO, value: String(dna * 10n ** 18n) })})`;
/** The indexer's snapshot with a jackpot pot of `eth` after `draws` draws. */
const pot = (eth: number, draws: number) => sql`insert into state (key, block, value) values ('chain', 1, ${sql.json({ game: { pot: { jackpotPot: String(BigInt(Math.round(eth * 1000)) * 10n ** 15n), drawCount: String(draws) } } })})
  on conflict (key) do update set value = excluded.value`;
const job = (kind: string, payload: Record<string, unknown> = {}) => ({ id: "0", kind, payload, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null }) as never;
const rows = (like: string) => sql<{ ref: string }[]>`select ref from log where kind = 'announce' and ref like ${like}`;
const outbox = (like: string) => sql<{ event_key: string; link: string; event: Record<string, unknown> }[]>`select event_key, link, event from x_outbox where event_key like ${like}`;

test("status: a quiet window posts nothing; otherwise one post per window, its proof link the signed record; a stale run posts nothing", { skip }, async () => {
  const hour = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
  const run = (due = hour) => status.statusHandler.run(job("x:status", { due: due.toISOString() }));
  assert.match(String(await run()), /quiet window/, "no swaps, nothing burned, nothing to compare");
  await burn(5_000n);
  await run();
  await run(); // the same window again (a retried job)
  const key = `status:${hour.toISOString().slice(0, 13)}`;
  assert.deepEqual((await rows("status:%")).map((r) => r.ref), [key], "announced once");
  const [o] = await outbox("status:%");
  assert.equal((await outbox("status:%")).length, 1, "queued once");
  const [{ seq }] = await sql<{ seq: string }[]>`select seq::text from log where kind = 'announce' and ref = ${key}`;
  assert.equal(o.link, recordUrl(seq));
  assert.equal(o.event.burnedDna, 5_000, "the number is the chain's");
  assert.equal(o.event.swaps, 0);
  assert.deepEqual(o.event.devTeam, { stage: "idle" });
  assert.match(String(await run(new Date(hour.getTime() - 2 * 3600_000))), /missed the status hour/);
});

test("milestones: each threshold once, however often the hourly check runs; only DNA's own burns count", { skip }, async () => {
  await burn(9_000_000n, "0x00000000000000000000000000000000000000aa"); // another token's Transfer to 0x0
  await status.milestonesHandler.run(job("x:milestones"));
  assert.equal((await outbox("milestone:%")).length, 0, "another token's burn is not DNA burned");
  await burn(1_200_000n);
  await status.milestonesHandler.run(job("x:milestones"));
  await status.milestonesHandler.run(job("x:milestones"));
  assert.deepEqual((await outbox("milestone:%")).map((r) => r.event_key), ["milestone:dna_burned:1000000"]);
  await burn(1_400_000n); // 2,605,000 in total
  await status.milestonesHandler.run(job("x:milestones"));
  await status.milestonesHandler.run(job("x:milestones"));
  assert.deepEqual((await outbox("milestone:%")).map((r) => r.event_key).sort(), ["milestone:dna_burned:1000000", "milestone:dna_burned:2500000"]);
  assert.equal((await rows("milestone:%")).length, 2);
});

test("jackpot milestones: once per climb; a draw empties the pot and the next climb past 1 ETH posts again", { skip }, async () => {
  const run = () => status.milestonesHandler.run(job("x:milestones"));
  const keys = async () => (await outbox("milestone:jackpot_pot:%")).map((r) => r.event_key).sort();
  await pot(1.1, 4); await run(); await run();
  await pot(1.3, 4); await run();
  assert.deepEqual(await keys(), ["milestone:jackpot_pot:4:1"]);
  await pot(0.1, 5); await run(); // drawn
  await pot(1.05, 5); await run(); await run();
  assert.deepEqual(await keys(), ["milestone:jackpot_pot:4:1", "milestone:jackpot_pot:5:1"]);
  const [o] = await outbox("milestone:jackpot_pot:5:%");
  assert.deepEqual([o.event.threshold, o.event.value], [1, 1.05], "the chain's numbers");
});

test("recap: the week's signed announcements, once a week", { skip }, async () => {
  await announce("seq:b1:seq_shipped", { event: "seq_shipped", build: "b1", title: "Last Click", slug: "last-click-1", game: ZERO, fundEth: null, record: "1" });
  await announce("seq:b2:seq_killed", { event: "seq_killed", build: "b2", title: "Dice", rounds: 4, record: "1" });
  const due = new Date().toISOString();
  await status.recapHandler.run(job("x:recap", { due }));
  await status.recapHandler.run(job("x:recap", { due }));
  const r = await outbox("recap:%");
  assert.equal(r.length, 1);
  assert.equal(r[0].event.gamesShipped, 1);
  assert.equal(r[0].event.buildsKilled, 1);
});

test("module code the Safe approved: one post per chain log", { skip }, async () => {
  const ev = { eventName: "CodehashApproved", args: { codehash: `0x${"ab".repeat(32)}`, kind: 0n }, transactionHash: `0x${"cd".repeat(32)}` as `0x${string}`, logIndex: 2 };
  assert.ok(await xM.onChainEvent(ev));
  assert.equal(await xM.onChainEvent(ev), undefined, "one row per chain log");
  const [o] = await outbox("CodehashApproved:%");
  assert.equal(o.event.event, "module_approved");
  assert.match(o.link, /\/tx\/0xcdcd/);
  assert.equal((await rows("CodehashApproved:%")).length, 1);
});

test("a sequencer event posts code's template, never the writer: a build just started never reads as shipped", { skip }, async () => {
  await sql`delete from x_outbox`; // only this post queued
  drafts = ["The sequencer shipped Last Click."]; // never asked
  try {
    const key = "seq:b9:seq_started";
    await xM.enqueueX(key, "post", { event: "seq_started", build: "b9", title: "Last Click", record: "1" }, { link: recordUrl("1") });
    const r = await xM.sendHandler.run(job("x:send")) as { tweetId?: string };
    assert.ok(r.tweetId, JSON.stringify(r));
    const [rec] = await sql<{ doc: { text: string; model: string; candidates: { text: string; issues: string[] }[] } }[]>`select doc from log where kind = 'x_post' and ref = ${key} and doc->>'status' = 'attempt'`;
    assert.equal(rec.doc.model, "code");
    assert.equal(rec.doc.text, `The sequencer started building "Last Click".\n${recordUrl("1")}`);
  } finally { drafts = null; }
});

// ---------------------------------------------------------------- launch day and chain progress

const tweets = () => fakes.calls.filter((c) => c.path === "/2/tweets");
const { TX_URL } = await import("../src/voice.ts");

test("launch day: 'online' once the engine is live and unmuted (the opening post, linking the T0 initialize tx), 'contracts connected' once; never queued in dry_run or muted", { skip }, async () => {
  const run = () => status.launchHandler.run(job("x:launch"));
  await xM.setMuted(true, "telegram:signer-1");
  assert.equal(await run(), "waiting: muted");
  await xM.setMuted(false, "telegram:signer-1");
  await modeM.setOverride("dry_run", "telegram:signer-1");
  assert.equal(await run(), "waiting: dry_run");
  await sql`update engine_flags set override = null`;
  assert.equal(await run(), "waiting: the registry's Initialized is not indexed yet", "never a post about the Safe's batch without its tx");
  assert.equal((await outbox("online")).length + (await outbox("contracts_connected")).length, 0, "nothing spent while it could not post");
  const init = `0x${"1a".repeat(32)}`;
  await sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (${++block}, 0, ${init}, '0x', now(), ${d.registry.toLowerCase()}, 'Initialized', ${sql.json({ hook: d.hook })})`;
  await sql`update x_outbox set status = 'skipped' where status = 'queued'`; // only the launch posts queued
  // from the Safe's initialize on, no post goes before "online", even one queued before x:launch ran
  await xM.enqueueX("early:1", "post", { event: "fees_distributed", hours: 6, distributions: 1, totalEth: 0.1 });
  const n0 = tweets().length;
  assert.match(String(await xM.sendHandler.run(job("x:send"))), /posts after the online post/);
  assert.equal(tweets().length, n0);
  await sql`update x_outbox set status = 'skipped' where event_key = 'early:1'`;
  assert.deepEqual(await run(), { queued: ["online", "contracts_connected"] });
  assert.equal(await run(), "launch posts queued", "once ever");
  // a /mute drops them from the queue: alerted, then queued again after /unmute (they post once, not "once queued")
  await xM.setMuted(true, "telegram:signer-1");
  assert.equal(await run(), "waiting: muted");
  assert.equal((await sql`select 1 from job where kind = 'alert' and payload->>'text' like 'The launch post "%" was skipped (muted)%'`).length, 2);
  await xM.setMuted(false, "telegram:signer-1");
  assert.deepEqual(await run(), { queued: ["online", "contracts_connected"] });
  assert.deepEqual((await sql<{ status: string }[]>`select status from x_outbox where event_key in ('online', 'contracts_connected')`).map((r) => r.status), ["queued", "queued"]);
  for (const key of ["online", "contracts_connected"]) {
    const [o] = await outbox(key);
    assert.deepEqual([o.event.event, o.link], [key, `${TX_URL}${init}`]);
    assert.equal((await rows(key)).length, 1, "on the site too");
  }
  // the opening post goes first: code's template (never the writer), which never says the engine deployed its contracts
  const n = tweets().length;
  assert.ok((await xM.sendHandler.run(job("x:send")) as { tweetId?: string }).tweetId);
  assert.equal(await xM.onlineAhead(), false, "once it is out, nothing waits on it");
  assert.equal(tweets()[n].body.text, `The engine is live and runs on its own from here. Its contracts were deployed by the team and connected by the Safe's owners.\n${TX_URL}${init}`);
  assert.ok((await xM.sendHandler.run(job("x:send")) as { tweetId?: string }).tweetId);
  assert.equal(tweets()[n + 1].body.text, `The Safe's owners connected the registry and the vaults to the hook in a single batch and queued the first fee plates.\n${TX_URL}${init}`);
});

test("chain progress: one combined post a 6 h window (DNA's own contracts only), once per window, linking its latest tx", { skip }, async () => {
  // the latest window that has ended 30 min ago (the scheduler's due is a period start: 00:30, 06:30 …)
  const H = 3600_000, to = Math.floor((Date.now() - 30 * 60_000) / (6 * H)) * 6 * H;
  const at = new Date(to - 2 * H);
  const E = (eth: number) => String(BigInt(Math.round(eth * 1e6)) * 10n ** 12n);
  const put = (event: string, address: string, args: Record<string, string>, tx: string, when = at) => sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args)
    values (${++block}, 0, ${tx}, '0x', ${when}, ${address.toLowerCase()}, ${event}, ${sql.json(args)})`;
  const T = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  await put("Distributed", d.feeVault, { amount: E(0.4), buyback: E(0.14), lp: E(0.12), treasury: E(0.1), game: E(0.04), baseline: "false" }, T(0xd1));
  await put("Distributed", d.feeVault, { amount: E(0.1), buyback: E(0.035), lp: E(0.03), treasury: E(0.025), game: E(0.01), baseline: "false" }, T(0xd2));
  await put("Distributed", "0x00000000000000000000000000000000000000aa", { amount: E(9), buyback: E(9), lp: "0", treasury: "0", game: "0", baseline: "false" }, T(0xd3)); // not ours
  await put("Buyback", d.buybackBurn, { spent: E(0.5), burned: String(1_234_567n * 10n ** 18n), pending: "0" }, T(0xb1));
  await put("LiquidityAdded", d.liquidityVault, { salt: "1", tickLower: "1", tickUpper: "2", liquidity: "1", eth: E(0.26) }, T(0xa1), new Date(to - 8 * H)); // before the window
  const due = new Date(to + 30 * 60_000).toISOString();
  const run = (when = due) => status.progressHandler.run(job("x:progress", { due: when }));
  const key = `progress_day:${new Date(to - 6 * H).toISOString().slice(0, 13)}`;
  const first = await artAsked(() => run());
  assert.deepEqual(first.r, { [key]: true });
  assert.deepEqual(first.asked, [`${key} digest`], "studio art asked for at enqueue, under the digest's scene");
  assert.deepEqual(await run(), { [key]: false }, "a retried run queues nothing twice");
  const [o] = await outbox("progress_day:%");
  assert.deepEqual(o.event, { event: "progress_day", hours: 6, distributions: 2, totalEth: 0.5, buybackEth: 0.175, liquidityEth: 0.15, treasuryEth: 0.125, gamesEth: 0.05,
    buybacks: 1, spentEth: 0.5, burnedDna: 1_234_567 });
  assert.equal(o.link, `${TX_URL}${T(0xb1)}`, "the window's latest tx");
  assert.equal((await outbox("fees_distributed:%")).length + (await outbox("burn_summary:%")).length + (await outbox("liquidity_added:%")).length, 0, "one post, never one per kind");
  assert.match(String(await run(new Date(to + 6.5 * H).toISOString())), /no progress post/, "a quiet window: silence");
  assert.match(String(await run(new Date(to - 11.5 * H).toISOString())), /missed the progress hour/, "more than a window late: the next run has it");
  assert.match(String(await run(new Date(to + 2.5 * H).toISOString())), /not a 6 h window's end/, "a run queued under the old 2 h schedule");
  // as posted: code's template from the facts (never the writer, so no flourish) and the tx link code appends
  await sql`update x_outbox set status = 'skipped' where status = 'queued' and event_key not like 'progress_day:%'`;
  drafts = ["6 h of work: fees split, DNA burned. Gone for good."]; // never asked
  try {
    const n = tweets().length;
    assert.ok((await xM.sendHandler.run(job("x:send")) as { tweetId?: string }).tweetId);
    assert.equal(tweets()[n].body.text, `Last 6 h on-chain. Fees distributed: 0.5 ETH total. 0.175 ETH to buyback, 0.15 ETH to liquidity, 0.125 ETH to treasury, 0.05 ETH to games. Buyback and burn: 0.5 ETH bought 1,234,567 DNA, all of it burned.\n${TX_URL}${T(0xb1)}`);
  } finally { drafts = null; }
  // the old engine's once-a-day post for that UTC day (progress_day:<date>) already told this window: not again
  await sql`insert into x_outbox (event_key, type, status, event) values (${`progress_day:${new Date(to).toISOString().slice(0, 10)}`}, 'post', 'posted', '{}'::jsonb)`;
  await put("LiquidityAdded", d.liquidityVault, { salt: "3", tickLower: "1", tickUpper: "2", liquidity: "1", eth: E(0.1) }, T(0xa3), new Date(to + 2 * H));
  assert.match(String(await run(new Date(to + 6.5 * H).toISOString())), /already covered/);
});

test("site changes: each one posted once, oldest first, linking the changed page; an unreadable list waits without an alert", { skip }, async () => {
  const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  const list = [
    { id: "c3", at: at(1), title: "Burn page", summary: "the burn page shows every burn", url: "/burn" },
    { id: "c2", at: at(2), title: "Play page", summary: "games sort by players", url: "/play" },
    { id: "old", at: at(49), title: "Old", summary: "", url: "/" },
  ];
  const saved = status.SITE.changes;
  try {
    status.SITE.changes = async () => list;
    const first = await artAsked(() => status.siteChangesHandler.run(job("site:changes")));
    assert.deepEqual(first.r, { "site:c2": true }, "the oldest new one first");
    assert.deepEqual(first.asked, ["site:c2 outcome"], "studio art asked for at enqueue, under the experiment's scene");
    const [row] = await sql<{ link: string; event: Record<string, unknown> }[]>`select link, event from x_outbox where event_key = 'site:c2'`;
    assert.equal(row.link, "https://genomedna.xyz/play");
    assert.equal(row.event.event, "site_changed");
    assert.equal((await sql`select 1 from log where kind = 'announce' and ref = 'site:c2'`).length, 1);
    assert.deepEqual(await status.siteChangesHandler.run(job("site:changes")), { "site:c3": true });
    assert.equal(await status.siteChangesHandler.run(job("site:changes")), "no new site change", "each once; past 48 h never");
    const alerts = (await sql`select 1 from job where kind = 'alert'`).length;
    status.SITE.changes = async () => { throw new Error("down"); };
    assert.equal(await status.siteChangesHandler.run(job("site:changes")), "the site's change list was not readable");
    assert.equal((await sql`select 1 from job where kind = 'alert'`).length, alerts, "no alert for a failed fetch");
  } finally { status.SITE.changes = saved; }
});

test("the treasury's DNA moves: every move from treasuryFromBlock on, however old, each posted once linking its tx; a buy only when the Safe executed it", { skip }, async () => {
  const old = new Date(Date.now() - 3 * 86_400_000); // past any time window: the block floor decides
  const put = (event: string, address: string, args: Record<string, string>, tx: string, b = ++block) => sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args)
    values (${b}, ${block++ % 1000}, ${tx}, '0x', ${old}, ${address.toLowerCase()}, ${event}, ${sql.json(args)})`;
  const T = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const W = "0x1d9fA8780090C08065F9d52fB40755100966F7B7";
  await put("Transfer", d.token, { from: d.safe, to: W, value: String(7n * 10n ** 18n) }, T(0xa0)); // before the floor
  const floor = block + 10_000;
  // the Safe's buy, shaped like the real one (tx 0x7785…dc9a): a Swap on the pool, the hook's fee, DNA from the pool manager
  await put("Swap", d.poolManager, { amount0: "-2062829589843750000", amount1: "5006260336505336000000000" }, T(0xa1), floor);
  await put("FeeTaken", d.hook, { buy: "true", exactInput: "true", gross: "0", project: "0", platform: "0", pips: "0" }, T(0xa1), floor);
  await put("Transfer", d.token, { from: d.poolManager, to: d.safe, value: "5006260336505336000000000" }, T(0xa1), floor);
  await put("Transfer", d.token, { from: d.safe, to: W, value: String(1_000n * 10n ** 18n) }, T(0xa2), floor + 1);
  block = floor + 10; // later tests' rows stay above these
  const saved = { from: d.treasuryFromBlock, labels: d.labels, bySafe: status.TREASURY.bySafe };
  const read: string[] = [];
  try {
    Object.assign(d, { treasuryFromBlock: floor, labels: { [W]: "fomo team wallet" } });
    const run = () => status.treasuryHandler.run(job("treasury"));
    // a receipt that can't be read: that tx waits whole (no buy lost), the cursor stays, the next run reads it
    status.TREASURY.bySafe = async () => { throw new Error("rpc down"); };
    assert.deepEqual(Object.keys(await run() as object), [`treasury:${T(0xa2)}:out:${W.toLowerCase()}`]);
    assert.equal((await sql`select 1 from state where key = 'treasury'`).length, 0, "no cursor past an unread receipt");
    status.TREASURY.bySafe = async (tx) => { read.push(tx); return tx === T(0xa1); };
    assert.deepEqual(Object.keys(await run() as object), [`treasury:${T(0xa1)}:buy`], "the buy once its receipt reads; days old; nothing before the floor");
    assert.equal((await sql<{ block: number }[]>`select block::int from state where key = 'treasury'`)[0].block, floor + 1, "the cursor past every handled move");
    const [buy] = await outbox(`treasury:${T(0xa1)}:buy`);
    assert.equal(buy.link, `https://etherscan.io/tx/${T(0xa1)}`);
    assert.deepEqual([buy.event.event, buy.event.dnaAmount, buy.event.ethSpent], ["treasury_buy", 5_006_260, 2.06]);
    const [out] = await outbox(`treasury:${T(0xa2)}:out:%`);
    assert.deepEqual([out.event.event, out.event.dnaAmount, out.event.label], ["treasury_transfer", 1_000, "fomo team wallet"]);
    assert.equal(await run(), "no new treasury DNA moves", "once per move");
    assert.deepEqual(read, [T(0xa1)], "each receipt read once");
  } finally {
    Object.assign(d, { treasuryFromBlock: saved.from, labels: saved.labels });
    status.TREASURY.bySafe = saved.bySafe;
  }
});

test("the Genome Vaults: a mint, the Safe's fund and a burn from the vaults address post once each, code's template with the contract's count; nothing before the vaults are deployed", { skip }, async () => {
  const vaults = await import("../src/vaults.ts");
  const VAULTS = "0xA69836A27706ED710811250a4A0E62Fe475b04d9";
  const T = (n: number) => `0x${"e".repeat(60)}${n.toString(16).padStart(4, "0")}` as `0x${string}`;
  const minted = (n: number, address?: string) => ({ eventName: "Minted", args: { id: 3n, owner: "0x00000000000000000000000000000000000000b8", slot: 7 }, transactionHash: T(n), logIndex: 0, address });
  const was = d.genomeVaults;
  const read = vaults.VAULT_READ.state;
  vaults.VAULT_READ.state = async () => ({ live: 12, maxLive: 50, depositDna: 200_000 });
  try {
    delete d.genomeVaults;
    assert.equal(await xM.onChainEvent(minted(1, VAULTS)), undefined, "not in the deployment: not live, nothing posts");
    d.genomeVaults = VAULTS;
    assert.equal(await xM.onChainEvent(minted(2)), undefined, "a Minted from elsewhere is not the vaults'");
    assert.ok(await xM.onChainEvent(minted(3, VAULTS.toLowerCase())));
    assert.equal(await xM.onChainEvent(minted(3, VAULTS)), undefined, "one row per chain log");
    assert.ok(await xM.onChainEvent({ eventName: "Funded", args: { fromBlock: 100n, toBlock: 200n, amount: 10n ** 17n, perToken: 10n ** 16n, eligible: 10n }, transactionHash: T(4), logIndex: 1, address: VAULTS }));
    assert.ok(await xM.onChainEvent({ eventName: "Burned", args: { id: 3n, owner: "0x00000000000000000000000000000000000000b8", eth: 10n ** 16n }, transactionHash: T(5), logIndex: 0, address: VAULTS }));
    const [m] = await outbox(`Minted:${T(3)}:%`);
    assert.deepEqual([m.event.event, m.event.name, (m.event.args as { slot: number }).slot], ["vault", "Minted", 7]);
    assert.match(m.link, new RegExp(`/tx/${T(3)}`));
    assert.equal((await rows(`Minted:${T(3)}:%`)).length, 1, "announced on the site");
    // the burned vault's slot comes from its indexed mint
    await sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (${++block}, 0, ${T(3)}, '0x', now(), ${VAULTS.toLowerCase()}, 'Minted', ${sql.json({ id: "3", owner: "0x00000000000000000000000000000000000000b8", slot: "7" })})`;
    const n = tweets().length;
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) { await xM.sendHandler.run(job("x:send")); }
    for (const t of tweets().slice(n)) texts.push((t.body as { text: string }).text.split("\n")[0]);
    assert.deepEqual(texts.sort(), [
      "Genome Vault burned: slot 7 is free again. Its owner got the 200,000 DNA back; the 0.01 ETH it had not collected is theirs too. 12 vaults live now.",
      "Genome Vault minted: slot 7 of 50. 200,000 DNA locked in it until its owner burns it. 12 vaults live now.",
      "Genome Vaults funded: 0.1 ETH from the treasury. Each of the 10 eligible vaults gets 0.01 ETH, any remainder from earlier funds included.",
    ]);
  } finally {
    vaults.VAULT_READ.state = read;
    if (was) d.genomeVaults = was; else delete d.genomeVaults;
  }
});
