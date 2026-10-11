// Post media end to end against a real Postgres and the fakes: the card on a post is the art the
// enclave re-checked + the facts it drew from its signed values; sha256 + provenance are in the signed x_post record
// before the upload; a card that passes every check posts on its own; the style is picked once per event, signed, and
// never one of the last 3 image posts'; a meme whose words are not exactly its caption never posts; the send loop
// never waits (queued until ready, then a plate, then text only); every post uploads its media again; the logo MP4
// goes up chunked; the daily digest; the /delete brake.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { fakePng, startFakes } from "../scripts/fakes.ts";
import { synthetic } from "../scripts/synthetic.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
const dbName = `dna_media_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc`, ENGINE_MODE: "live", LLM_MODE: "live",
    TELEGRAM_API_BASE: fakes.url, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_ID: "-100", TELEGRAM_ALLOWED_USER_IDS: "731954862", // a realistic id: the privacy test looks for it in every record
    XAI_API_BASE: fakes.url, OPENROUTER_API_BASE: fakes.url, XAI_API_KEY: "k", OPENROUTER_API_KEY_ENGINE: "k",
    X_API_BASE: fakes.url, X_CLIENT_ID: "cid", X_REFRESH_TOKEN: "seed", X_USER_ID: "42", SECRET_SEAL_KEY: "11".repeat(32),
    STUDIO_URL: "https://studio.test", STUDIO_TOKEN: "studio-test-token",
  });
}
const { edb: sql, migrate } = await import("../src/db.ts");
const xM = await import("../src/x.ts");
const card = await import("../src/card.ts");
const tgM = await import("../src/telegram.ts");
const modeM = await import("../src/mode.ts");
const { d: dep, MEDIA, X } = await import("../src/config.ts");

before(async () => { if (ADMIN) { await migrate(); await modeM.initMode(); } });
after(async () => {
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await fakes.close();
});

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const job = () => ({ id: "0", kind: "t", payload: {}, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null }) as never;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const winner = "0x00000000000000000000000000000000000000c1";

// the LLMs: the writer synthetic; the in-enclave vision check answers `vision`
const vision = { letters: false, digits: false, logos: false, ui: false, walletAddress: false, nsfw: false };
fakes.llm.xai = (b) => synthetic("xai", b);
let memeText: string[] = []; // what the reader transcribes off a meme
const read = (system: string) => (/Transcribe/.test(system) ? { text: memeText, digits: false, logos: false, ui: false, walletAddress: false, nsfw: false } : vision);
fakes.llm.anthropic = (b) => (String(b.system).startsWith("agent: media-check")
  ? { model: b.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(read(String(b.system))) }], usage: { input_tokens: 10, output_tokens: 5 } }
  : synthetic("anthropic", b));
// the studio (outside the enclave), behind card.ts's fetch seam
const art = new Map<string, Buffer>();
/** keys the studio "generates" the moment it is asked (the art is ready when the request arrived) */
const onRequest = new Map<string, Buffer>();
const requests: { eventKey: string; slots: Record<string, unknown>; shape: string; auth: string | null; at: number }[] = [];
const timeouts: Record<string, number | undefined> = {};
const oversized = new Set<string>(); // serve a body larger than declared / allowed
const styleServed = new Map<string, string>(); // the studio claims another style than the one asked for
card.STUDIO.fetch = async (url: string, init?: RequestInit, timeoutMs?: number) => {
  const u = new URL(url);
  if (u.pathname === "/request") {
    const r = JSON.parse(String(init!.body));
    requests.push({ ...r, auth: new Headers(init!.headers).get("authorization"), at: Date.now() });
    if (onRequest.has(r.eventKey)) art.set(r.eventKey, onRequest.get(r.eventKey)!);
    return new Response("{}", { status: 202 });
  }
  const m = decodeURIComponent(u.pathname).match(/^\/studio\/(.+)\.(art|json)$/);
  timeouts[m?.[2] ?? "?"] = timeoutMs;
  const png = m && art.get(m[1]);
  if (!png) return new Response("{}", { status: 404 });
  if (m[2] === "art" && oversized.has(m[1])) {
    // a lying server: no content-length, then more than 5 MB of bytes
    const big = new ReadableStream({ start(c) { for (let i = 0; i < 6; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); } });
    return new Response(big);
  }
  if (m[2] === "art") return new Response(new Uint8Array(png));
  const style = styleServed.get(m[1]) ?? requests.findLast((q) => q.eventKey === m[1])?.slots.style; // the style asked for
  return new Response(JSON.stringify({ status: "ready", style, sha256: sha(png), openaiId: `req_${m[1]}`, studioCommit: "c0ffee", refsetHash: "ab".repeat(32) }));
};
const uploaded = (c: { body: { files: { media: { data: Buffer }[] } } }) => c.body.files.media[0].data;
xM.MEDIA_WAIT.sleep = async () => {};

const tweets = () => fakes.calls.filter((c) => c.path === "/2/tweets");
const uploads = () => fakes.calls.filter((c) => c.path === "/2/media/upload" && c.method === "POST");
const outbox = async (key: string) => (await sql<{ status: string; created_at: Date }[]>`select status, created_at from x_outbox where event_key = ${key}`)[0];
const attempt = async (key: string) => (await sql<{ doc: Record<string, any> }[]>`select doc from log where kind = 'x_post' and ref = ${key} and doc->>'status' = 'attempt' order by log.seq desc limit 1`)[0]?.doc; // eslint-disable-line @typescript-eslint/no-explicit-any
const drawn = (n: number) => xM.onChainEvent({ eventName: "Drawn", args: { window: BigInt(n), rand: 15n, prize: 10n ** 18n, share: 10n ** 17n, winners: 1n, ticketsUsed: 1n, paid: [{ rank: 0n, account: winner, share: 10n ** 17n, prizeId: 0n }] }, transactionHash: H(n), logIndex: 0 });
const keyOf = (n: number) => `Drawn:${H(n)}:0`;
const age = (key: string, min: number) => sql`update x_outbox set created_at = now() - make_interval(mins => ${min}) where event_key = ${key}`;
const clean = () => sql`update x_outbox set status = 'skipped' where status = 'queued'`;

before(() => { Object.assign(X, { spacingMs: 0, dailyPosts: 1000 }); });

test("a day with nothing in it: no digest post (silence when nothing happened)", { skip }, async () => {
  assert.match(String(await xM.digestHandler.run(job())), /nothing happened today: no digest/);
  assert.equal((await sql`select 1 from x_outbox where event->>'event' = 'digest'`).length, 0);
});

test("the card: the studio's art re-checked here, the facts drawn from the signed values; sha256 + provenance signed before the upload", { skip }, async () => {
  await clean();
  await drawn(1);
  art.set(keyOf(1), fakePng("art-1"));
  let atUpload: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  fakes.x.onUpload = async () => { atUpload = await attempt(keyOf(1)); };
  try {
    const r = await xM.sendHandler.run(job()) as { tweetId?: string };
    assert.ok(r.tweetId, JSON.stringify(r));
  } finally { fakes.x.onUpload = async () => {}; }
  const rec = await attempt(keyOf(1));
  const [ob] = await sql<{ event: Record<string, unknown> }[]>`select event from x_outbox where event_key = ${keyOf(1)}`;
  // the facts on the image are the signed record's facts and the signed outbox event's winner
  assert.deepEqual(rec.media.layer, card.factLayer(rec.facts, ob.event, 0));
  assert.deepEqual(rec.media.layer.addresses, [`${winner.slice(0, 6)}…${winner.slice(-4)}`]);
  assert.deepEqual(rec.media.layer.figures, [{ label: "winners", value: "1" }, { label: "each", value: "0.1 ETH" }, { label: "window", value: "#1" }]);
  // the uploaded bytes are the image whose sha256 the record names, and the record existed before the upload
  const up = uploads().at(-1)!;
  assert.deepEqual([up.body.fields.media_category, up.body.fields.media_type], ["tweet_image", "image/png"], "multipart, per the v2 docs");
  // a JPEG (a studio draft) is sent as image/jpeg: the type comes from the bytes
  await xM.uploadImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]));
  assert.equal(uploads().at(-1)!.body.fields.media_type, "image/jpeg");
  const bytes = uploaded(up);
  assert.ok(bytes.length <= 5 * 1024 * 1024, "a card is at most 5 MB");
  assert.equal(sha(bytes), rec.media.sha256);
  assert.equal(card.artIssue(bytes, "wide"), null);
  assert.deepEqual(rec.media.provenance, { openaiId: `req_${keyOf(1)}`, studioCommit: "c0ffee", refsetHash: "ab".repeat(32) });
  assert.equal(atUpload?.media?.sha256, rec.media.sha256, "the signed attempt record (with the hash) was written before the upload");
  assert.equal(rec.media.source, "studio");
  const [posted] = await sql<{ doc: { mediaId: string } }[]>`select doc from log where kind = 'x_post' and ref = ${keyOf(1)} and doc->>'status' = 'posted'`;
  assert.deepEqual(tweets().at(-1)!.body.media, { media_ids: [posted.doc.mediaId] }, "the tweet carries the fresh upload");
});

test("queue, never wait: an item whose art isn't ready stays queued while others post; the studio gets only slots; after 20 min a plate", { skip }, async () => {
  await clean();
  await drawn(2);
  await xM.onChainEvent({ eventName: "RolledBack", args: { kind: 0 }, transactionHash: H(200), logIndex: 0 }); // no art for this event
  const r = await xM.sendHandler.run(job()) as { tweetId?: string };
  assert.ok(r.tweetId, "the next item went out");
  assert.equal(tweets().at(-1)!.body.media, undefined, "a text-only event");
  assert.equal((await outbox(keyOf(2))).status, "queued", "the jackpot post waits for its art");
  const req = requests.find((q) => q.eventKey === keyOf(2))!;
  const { auth: _a, at: _t, ...body } = req;
  assert.deepEqual(Object.keys(body).sort(), ["eventKey", "shape", "slots"]);
  assert.deepEqual(Object.keys(req.slots).sort(), ["decay", "event", "growth", "light", "seed", "style"], "the event enum, the style and numbers, nothing else");
  assert.equal(req.slots.event, "jackpot_drawn");
  assert.match(String(await xM.sendHandler.run(job())), /^waiting for images: Drawn:/);
  // 20 minutes on: a plate, with the same enclave-drawn facts
  await age(keyOf(2), 21);
  assert.ok((await xM.sendHandler.run(job()) as { tweetId?: string }).tweetId);
  const rec = await attempt(keyOf(2));
  const set = card.plates().plates;
  assert.equal(rec.media.source, "plate");
  assert.ok(set.some((p) => p.file === rec.media.plate));
  assert.equal(rec.media.style, card.plateStyle(set.find((p) => p.file === rec.media.plate)!), "a plate post records its plate's style");
  assert.equal(rec.media.layer.headline, "GENE POOL WINNER");
  // the next plate post never repeats the previous plate
  await drawn(3);
  await age(keyOf(3), 21);
  await xM.sendHandler.run(job());
  const next = await attempt(keyOf(3));
  assert.notEqual(next.media.plate, rec.media.plate);
  // no studio configured (it isn't deployed yet): nothing to wait for, the plate goes at once
  const url = MEDIA.studioUrl;
  MEDIA.studioUrl = undefined;
  try {
    await drawn(10);
    assert.ok((await xM.sendHandler.run(job()) as { tweetId?: string }).tweetId);
    assert.equal((await attempt(keyOf(10))).media.source, "plate");
  } finally { MEDIA.studioUrl = url; }
});

test("the in-enclave re-check rejects art the studio passed: wrong size, or the vision check sees text", { skip }, async () => {
  await clean();
  await drawn(4);
  art.set(keyOf(4), fakePng("square", "1088x1088"));
  assert.match(String(await xM.sendHandler.run(job())), /^waiting for images/);
  const checks = await sql<{ doc: { art: string; issue: string } }[]>`select doc from log where kind = 'x_post' and ref = ${keyOf(4)} and doc->>'status' = 'art-check'`;
  assert.match(checks[0].doc.issue, /size 1088×1088, want 1536×864/);
  await drawn(5);
  art.set(keyOf(5), fakePng("letters"));
  vision.letters = true;
  try {
    assert.match(String(await xM.sendHandler.run(job())), /^waiting for images/);
    const [c] = await sql<{ doc: { issue: string } }[]>`select doc from log where kind = 'x_post' and ref = ${keyOf(5)} and doc->>'status' = 'art-check'`;
    assert.equal(c.doc.issue, "vision check: letters");
    const calls = fakes.calls.filter((x) => x.path === "/v1/messages" && String(x.body.system).startsWith("agent: media-check")).length;
    await xM.sendHandler.run(job());
    assert.equal(fakes.calls.filter((x) => x.path === "/v1/messages" && String(x.body.system).startsWith("agent: media-check")).length, calls, "the verdict is cached by the art's hash");
  } finally { vision.letters = false; }
  await age(keyOf(4), 21); await age(keyOf(5), 21);
  await xM.sendHandler.run(job()); await xM.sendHandler.run(job());
  assert.deepEqual([(await attempt(keyOf(4))).media.source, (await attempt(keyOf(5))).media.source], ["plate", "plate"], "rejected art never posts");
});

test("auto-post: a card that passes every check posts on its own: no draft, nothing sent to the signers, no signature", { skip }, async () => {
  await clean();
  await drawn(6);
  art.set(keyOf(6), fakePng("art-6"));
  const asked = () => fakes.calls.filter((c) => c.path.endsWith("/sendPhoto") || c.path.endsWith("/sendMessage")).length;
  const before = asked();
  assert.ok((await xM.sendHandler.run(job()) as { tweetId?: string }).tweetId);
  assert.equal((await attempt(keyOf(6))).media.source, "studio");
  assert.equal((await sql`select 1 from draft`).length, 0, "no draft for an image");
  assert.equal(asked(), before, "nothing asked of the signers");
});

test("styles: picked once per event and signed before the art is asked for; never one of the last 3 image posts; art in another style never posts", { skip }, async () => {
  await clean();
  const used: string[] = [];
  for (let n = 50; n < 58; n++) {
    await drawn(n);
    const [pick] = await sql<{ doc: { style: string } }[]>`select doc from log where kind = 'x_post' and ref = ${keyOf(n)} and doc->>'status' = 'style'`;
    assert.ok(pick, "the pick is a signed record");
    assert.equal(requests.findLast((q) => q.eventKey === keyOf(n))!.slots.style, pick.doc.style, "the studio is asked for exactly that style");
    art.set(keyOf(n), fakePng(`art-${n}`));
    assert.ok((await xM.sendHandler.run(job()) as { tweetId?: string }).tweetId);
    const rec = await attempt(keyOf(n));
    assert.deepEqual([rec.media.source, rec.media.style], ["studio", pick.doc.style]);
    assert.ok(!used.slice(-3).includes(rec.media.style), `${rec.media.style} after ${used.slice(-3)}`);
    used.push(rec.media.style);
  }
  assert.ok(new Set(used).size >= 4, `a run of one event rotates styles: ${used}`);
  // the studio serves art in a style it was not asked for: rejected, then the plate
  await drawn(58);
  art.set(keyOf(58), fakePng("art-58"));
  styleServed.set(keyOf(58), "pixel");
  assert.match(String(await xM.sendHandler.run(job())), /^waiting for images/);
  const [c] = await sql<{ doc: { issue: string } }[]>`select doc from log where kind = 'x_post' and ref = ${keyOf(58)} and doc->>'status' = 'art-check'`;
  assert.match(c.doc.issue, /^style pixel, asked /);
  await age(keyOf(58), 21);
  await xM.sendHandler.run(job());
  assert.equal((await attempt(keyOf(58))).media.source, "plate");
});

test("a meme: its words are read back in the enclave; a misspelled, extra or missing word never posts and the plate goes; the exact words post", { skip }, async () => {
  // a caption the post filter refuses never reaches an image: that roast gets another style and no words
  assert.ok(await card.requestArtFor("roast:test:banned", { event: "roast", caption: ["SEND ETH", "NOW"] }));
  const banned = requests.findLast((q) => q.eventKey === "roast:test:banned")!;
  assert.notEqual(banned.slots.style, "meme");
  assert.equal(banned.slots.caption, undefined);
  const key = "roast:test:1";
  const facts = { event: "roast", caption: ["THEIR ROADMAP", "MY CHANGELOG"] };
  assert.ok(await card.requestArtFor(key, facts));
  const req = requests.findLast((q) => q.eventKey === key)!;
  assert.deepEqual([req.slots.style, req.slots.caption], ["meme", ["THEIR ROADMAP", "MY CHANGELOG"]], "a roast with a caption is a meme");
  const now = new Date();
  const issue = async () => (await sql<{ doc: { issue: string | null } }[]>`select doc from log where kind = 'x_post' and ref = ${key} and doc->>'status' = 'art-check' order by log.seq desc limit 1`)[0]?.doc.issue;
  art.set(key, fakePng("meme-misspelled"));
  memeText = ["THEIR ROADMAP", "MY CHANGLOG"];
  assert.equal(await card.cardFor(key, now, {}, facts), "wait");
  assert.match(String(await issue()), /CHANGLOG/);
  art.set(key, fakePng("meme-swapped"));
  memeText = ["THEIR CHANGELOG", "MY ROADMAP"];
  assert.equal(await card.cardFor(key, now, {}, facts), "wait", "every word right, the labels swapped: rejected");
  assert.match(String(await issue()), /read "THEIR CHANGELOG", "MY ROADMAP"/);
  art.set(key, fakePng("meme-extra"));
  memeText = ["THEIR ROADMAP", "MY CHANGELOG", "SOON"];
  assert.equal(await card.cardFor(key, now, {}, facts), "wait");
  assert.match(String(await issue()), /"SOON"/);
  art.set(key, fakePng("meme-missing"));
  memeText = ["THEIR ROADMAP"];
  assert.equal(await card.cardFor(key, now, {}, facts), "wait");
  assert.match(String(await issue()), /read "THEIR ROADMAP", want/);
  // 20 minutes on with no clean meme: the plate, never the misspelled art
  const late = await card.cardFor(key, new Date(Date.now() - 21 * 60_000), {}, facts);
  assert.ok(late !== "wait" && late.kind === "image" && late.source === "plate");
  // the exact words (case and punctuation aside): the meme goes
  art.set(key, fakePng("meme-exact"));
  memeText = ["Their roadmap", "My changelog."];
  const ok = await card.cardFor(key, now, {}, facts);
  assert.ok(ok !== "wait" && ok.kind === "image" && ok.source === "studio" && ok.style === "meme");
  assert.equal(await issue(), null);
});

test("a broken plate set → text only; every post uploads its media again (ids expire); the logo MP4 goes up chunked", { skip }, async () => {
  await clean();
  // plates whose bytes don't match the manifest are never drawn: the post goes out text-only
  const dir = mkdtempSync(join(tmpdir(), "dna-media-"));
  mkdirSync(join(dir, "plates"));
  const m = card.plates();
  writeFileSync(join(dir, "plates", "manifest.json"), JSON.stringify(m));
  for (const p of m.plates) writeFileSync(join(dir, "plates", p.file), "not the plate");
  copyFileSync(new URL("logo.png", MEDIA.dir), join(dir, "logo.png"));
  const saved = MEDIA.dir;
  MEDIA.dir = new URL(`file://${dir}/`);
  try {
    await drawn(7);
    await age(keyOf(7), 21);
    const n = uploads().length;
    assert.ok((await xM.sendHandler.run(job()) as { tweetId?: string }).tweetId);
    const rec = await attempt(keyOf(7));
    assert.equal(rec.media.kind, "none");
    assert.match(rec.media.why, /plate failed/);
    assert.equal(uploads().length, n, "nothing uploaded");
    assert.equal(tweets().at(-1)!.body.media, undefined);
  } finally { MEDIA.dir = saved; }
  // two mystery posts with the same logo: two chunked uploads, two ids
  const mp4 = readFileSync(card.LOGO_MP4);
  const sealed = (n: number) => xM.onChainEvent({ eventName: "Sealed", args: { mystery: BigInt(n), commitment: H(900 + n), revealAt: BigInt(Math.floor(Date.now() / 1000) + 2 * 86_400), by: winner }, transactionHash: H(800 + n), logIndex: 0 });
  const ids: string[] = [];
  for (const n of [1, 2]) {
    await sealed(n);
    const from = fakes.calls.length;
    fakes.x.processing = ["in_progress", "in_progress", "succeeded"];
    assert.ok((await xM.sendHandler.run(job()) as { tweetId?: string }).tweetId);
    const calls = fakes.calls.slice(from);
    const init = calls.find((c) => c.path === "/2/media/upload/initialize")!;
    assert.deepEqual(init.body, { media_type: "video/mp4", total_bytes: mp4.length, media_category: "tweet_video" });
    const appends = calls.filter((c) => /\/append$/.test(c.path));
    assert.equal(appends.length, Math.ceil(mp4.length / (5 * 1024 * 1024)));
    assert.deepEqual(appends.map((a) => Number(a.body.fields.segment_index)), appends.map((_, i) => i));
    assert.ok(appends.every((a) => a.body.files.media[0].bytes <= 5 * 1024 * 1024));
    assert.equal(sha(Buffer.concat(appends.map((a) => a.body.files.media[0].data))), sha(mp4), "the segments are the file");
    assert.ok(calls.some((c) => /\/finalize$/.test(c.path)));
    assert.equal(calls.filter((c) => /command=STATUS/.test(c.path)).length, 3, "polled until succeeded");
    const id = calls.filter((c) => c.path === "/2/tweets").at(-1)!.body.media.media_ids[0];
    assert.ok(id);
    ids.push(id);
    const rec = await (async () => (await sql<{ doc: Record<string, any> }[]>`select doc from log where kind = 'x_post' and doc->>'status' = 'attempt' order by log.seq desc limit 1`)[0].doc)(); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual([rec.media.kind, rec.media.source, rec.media.sha256], ["video", "logo", sha(mp4)]);
  }
  assert.notEqual(ids[0], ids[1], "a fresh upload per post");
  // two image posts: two uploads too
  await drawn(8); await drawn(9);
  art.set(keyOf(8), fakePng("art-8")); art.set(keyOf(9), fakePng("art-9"));
  const before = uploads().length;
  await xM.sendHandler.run(job()); await xM.sendHandler.run(job());
  assert.equal(uploads().length, before + 2);
  const [t8, t9] = tweets().slice(-2).map((t) => t.body.media.media_ids[0]);
  assert.notEqual(t8, t9);
});

test("the daily digest: the day's numbers in the fact sheet and on a square card", { skip }, async () => {
  await clean();
  const { record } = await import("../src/records.ts");
  for (const [ref, type, facts] of [["d1", "outcome", { outcome: "kept (promoted)" }], ["d2", "outcome", { outcome: "killed" }], ["d3", "jackpot_drawn", { prizeEth: 0.5, winners: 10 }]] as const) {
    await record("announce", `digest-test:${ref}`, { type, title: "t", facts: { event: type, ...facts }, tx: null, proof: null, priority: 1, at: new Date().toISOString() });
  }
  await sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (5000, 0, '0x1', '0x', now(), ${dep.token.toLowerCase()}, 'Transfer', ${sql.json({ from: winner, to: "0x0000000000000000000000000000000000000000", value: String(1_250_000n * 10n ** 18n) } as never)})`;
  // a run caught up at boot hours after 23:00 posts nothing
  const late = { ...(job() as object), payload: { due: new Date(Date.now() - 3 * 3600_000).toISOString() } } as never;
  assert.match(String(await xM.digestHandler.run(late)), /missed the digest hour/);
  assert.equal((await sql`select 1 from x_outbox where event->>'event' = 'digest'`).length, 0);
  const r = await xM.digestHandler.run(job()) as { digest: string };
  const [d] = await sql<{ event_key: string; event: Record<string, number> }[]>`select event_key, event from x_outbox where event->>'event' = 'digest' order by id desc limit 1`;
  assert.ok(d.event_key.startsWith(`digest:${r.digest}:`));
  assert.ok(d.event.survived >= 1 && d.event.extinct >= 1 && d.event.winners >= 10 && d.event.ethPaid >= 0.5, "a draw counts its 10 winners");
  assert.equal(d.event.dnaBurned, 1_250_000);
  art.set(d.event_key, fakePng("digest-art", "1088x1088"));
  assert.ok((await xM.sendHandler.run(job()) as { tweetId?: string }).tweetId);
  const rec = await attempt(d.event_key);
  assert.equal(rec.facts.dnaBurned, 1_250_000, "FIELDS.digest lets the day's numbers through");
  assert.equal(rec.media.layer.headline, "DAILY DIGEST");
  assert.equal(card.artIssue(uploaded(uploads().at(-1)!), "square"), null);
});

test("art is requested at enqueue (with the studio's token): ready by the time the spacing lets the post go", { skip }, async () => {
  await clean();
  onRequest.set(keyOf(20), fakePng("art-20"));
  await drawn(20);
  const req = requests.find((r) => r.eventKey === keyOf(20));
  assert.ok(req, "asked when the event was enqueued, before any send tick");
  assert.equal(req.auth, "Bearer studio-test-token");
  // the post is first eligible 30 min later (spacing): the art was requested at enqueue, so it is the studio's, not a plate
  await age(keyOf(20), 30);
  assert.ok((await xM.sendHandler.run(job()) as { tweetId?: string }).tweetId);
  assert.equal((await attempt(keyOf(20))).media.source, "studio");
  // still generating 5 min in: the item waits
  await drawn(21);
  await age(keyOf(21), 5);
  assert.match(String(await xM.sendHandler.run(job())), /^waiting for images/);
});

test("studio bodies are bounded, the art must show something, an oversize card falls to a plate, a vision outage isn't cached", { skip }, async () => {
  await clean();
  // more than 5 MB with no declared length: never read past the cap
  await drawn(30);
  art.set(keyOf(30), fakePng("art-30"));
  oversized.add(keyOf(30));
  assert.match(String(await xM.sendHandler.run(job())), /^waiting for images/);
  assert.equal(timeouts.art, 15_000, "15 s for the art");
  assert.equal(timeouts.json, 5_000, "5 s for the metadata");
  oversized.delete(keyOf(30));
  assert.equal((await sql`select 1 from log where kind = 'x_post' and ref = ${keyOf(30)} and doc->>'status' = 'art-check'`).length, 0, "an unread body is no verdict");
  await clean();
  // fully transparent art: rejected before the vision check
  const clear = Buffer.from(new (await import("@resvg/resvg-js")).Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="864"></svg>', { fitTo: { mode: "original" } }).render().asPng());
  await drawn(31);
  art.set(keyOf(31), clear);
  const visions = () => fakes.calls.filter((x) => x.path === "/v1/messages" && String(x.body.system).startsWith("agent: media-check")).length;
  const v0 = visions();
  await xM.sendHandler.run(job());
  const [c31] = await sql<{ doc: { issue: string } }[]>`select doc from log where kind = 'x_post' and ref = ${keyOf(31)} and doc->>'status' = 'art-check'`;
  assert.equal(c31.doc.issue, "fully transparent");
  assert.equal(visions(), v0, "no vision call for an empty image");
  // the vision check can't run (provider down): no verdict cached, it runs again next tick
  art.set(keyOf(32), fakePng("art-32"));
  const saved = fakes.llm.anthropic;
  fakes.llm.anthropic = () => ({ type: "error", error: { message: "overloaded" } });
  await clean(); await drawn(32);
  try { await xM.sendHandler.run(job()); } finally { fakes.llm.anthropic = saved; }
  assert.equal((await sql`select 1 from log where kind = 'x_post' and ref = ${keyOf(32)} and doc->>'status' = 'art-check'`).length, 0, "an outage is not a verdict");
  // a card over the limit: the plate goes now (no 20-min wait); a plate over it too: text only
  await clean();
  await drawn(33);
  // grain-heavy art makes a big PNG card (pixel noise doesn't compress); the plate's card is smaller
  const noisy = Buffer.from(new (await import("@resvg/resvg-js")).Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="864"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3"/></filter><rect width="1536" height="864" filter="url(#n)"/></svg>', { fitTo: { mode: "original" } }).render().asPng());
  art.set(keyOf(33), noisy);
  const limit = card.CARD.maxBytes;
  try {
    const layer33 = card.factLayer({ event: "jackpot_drawn", winners: 1, shareEth: 0.1, prizeEth: 0.1, window: 33 }, { args: { paid: [{ account: winner }] } }, 0);
    const studioCard = card.composite(noisy, layer33, "wide").length;
    const plateCard = Math.max(...card.plates().plates.map((_, i) => card.composite(card.plates().bytes(i), layer33, "wide").length)); // whichever plate goes
    assert.ok(plateCard < studioCard, `${plateCard} < ${studioCard}`);
    card.CARD.maxBytes = studioCard - 1;
    await xM.sendHandler.run(job());
    const r33 = await attempt(keyOf(33));
    assert.equal(r33.media.source, "plate", "oversize art → the plate at once, not a 20-min wait or text only");
    card.CARD.maxBytes = 1000;
    await drawn(34);
    await age(keyOf(34), 21);
    await xM.sendHandler.run(job());
    assert.match((await attempt(keyOf(34))).media.why, /plate card \d+ bytes: over 1000/);
  } finally { card.CARD.maxBytes = limit; }
});

test("the /delete brake: removes one of our own posts and nothing else; an id we never posted never reaches X; it never posts", { skip }, async () => {
  await clean();
  await drawn(70);
  art.set(keyOf(70), fakePng("art-70"));
  const { tweetId } = await xM.sendHandler.run(job()) as { tweetId: string };
  assert.ok(tweetId);
  const posts = () => tweets().filter((c) => c.method === "POST").length;
  const deletes = () => fakes.calls.filter((c) => c.method === "DELETE");
  const [p0, d0] = [posts(), deletes().length];
  for (const bad of [undefined, "", "abc", "12/../../2/tweets", "1".repeat(21)]) assert.match(await xM.deletePost(bad, "telegram:signer-1"), /^usage: \/delete <tweet id>/, String(bad));
  assert.match(await xM.deletePost("1234567890", "telegram:signer-1"), /not one of our posts/);
  assert.equal(deletes().length, d0, "an id the log doesn't name as ours never reaches X");
  // it works while muted or halted too: a brake
  await xM.setMuted(true, "test");
  try {
    assert.match(await xM.deletePost(tweetId, "telegram:signer-1"), new RegExp(`deleted post ${tweetId}`));
  } finally { await xM.setMuted(false, "test"); }
  assert.equal(deletes().at(-1)!.path, `/2/tweets/${tweetId}`);
  const [rec] = await sql<{ doc: { status: string; tweetId: string; by: string } }[]>`select doc from log where kind = 'x_post' and ref = ${keyOf(70)} and doc->>'status' = 'deleted'`;
  assert.deepEqual([rec.doc.tweetId, rec.doc.by], [tweetId, "telegram:signer-1"], "a signed record says who deleted what");
  assert.match(await xM.deletePost(tweetId, "telegram:signer-1"), /already deleted/);
  assert.equal(deletes().length, d0 + 1, "once");
  fakes.x.deleteStatus = 500;
  try {
    await drawn(71);
    art.set(keyOf(71), fakePng("art-71"));
    const { tweetId: t71 } = await xM.sendHandler.run(job()) as { tweetId: string };
    assert.match(await xM.deletePost(t71, "telegram:signer-1"), /X refused to delete/);
    assert.equal((await sql`select 1 from log where kind = 'x_post' and ref = ${keyOf(71)} and doc->>'status' = 'deleted'`).length, 0, "no record of a delete that didn't happen");
  } finally { fakes.x.deleteStatus = 200; }
  assert.equal(posts(), p0 + 1, "the brake never posts (the one new post is the test's own)");
});

test("privacy: a signer's Telegram id never reaches the public log; brakes and rejects record the allowlist place", { skip }, async () => {
  const signer = 731954862;
  await clean();
  await drawn(80);
  art.set(keyOf(80), fakePng("art-80"));
  const { tweetId } = await xM.sendHandler.run(job()) as { tweetId: string };
  const draft = await tgM.createDraft("x_post", { text: "privacy check" });
  const msg = (update_id: number, text: string) => ({ update_id, message: { message_id: update_id, chat: { id: -100 }, from: { id: signer }, text } });
  fakes.tgUpdates.push(msg(1, "/mute"), msg(2, "/unmute"), msg(3, `/delete ${tweetId}`),
    { update_id: 4, callback_query: { id: "q4", from: { id: signer }, message: { message_id: 9, chat: { id: -100 } }, chat_instance: "1", data: `d:${draft}:r` } }, msg(5, "/halt"));
  // the engine's brakes, as src/engine.ts wires them
  const brakes = {
    "/halt": async (by: string) => `Mode: ${(await modeM.setOverride("halted", by)).mode}`,
    "/mute": async (by: string) => { await xM.setMuted(true, by); return "muted"; },
    "/unmute": async (by: string) => { await xM.setMuted(false, by); return "unmuted"; },
    "/delete": async (by: string, args: string[]) => xM.deletePost(args[0], by),
  };
  let polls = 0;
  await tgM.pollTelegram(brakes, () => polls++ > 0);
  const docs = await sql<{ kind: string; doc: { by?: string; status?: string } }[]>`select kind, doc from log where doc ? 'by' order by log.seq`;
  const bys = (kind: string, status?: string) => docs.filter((d) => d.kind === kind && (!status || d.doc.status === status)).map((d) => d.doc.by);
  assert.ok(bys("x_post", "deleted").includes("telegram:signer-1"), "the delete");
  assert.ok(bys("draft", "rejected").includes("telegram:signer-1"), "the reject");
  assert.ok(bys("mode").filter((b) => b === "telegram:signer-1").length >= 3, "mute, unmute and halt");
  const leaks = await sql`select seq from log where body like ${`%${signer}%`}`;
  assert.equal(leaks.length, 0, "no record body holds the raw Telegram id");
  assert.equal(tgM.signerTag(signer), "telegram:signer-1");
  assert.equal(tgM.signerTag(42), "telegram:signer-unknown");
});

test("plate events never wait for the studio: each gets its plate card at once; the engine going live gets the logo MP4", { skip }, async () => {
  await clean();
  const { PLATE_SAMPLES } = await import("./fixtures/plate-samples.ts");
  for (const [event, facts] of Object.entries(PLATE_SAMPLES)) {
    const c = await card.cardFor(`${event}:t`, new Date(), { link: `https://etherscan.io/tx/0x${"cd".repeat(32)}` }, { event, ...facts });
    assert.ok(c !== "wait" && c.kind === "image" && c.source === "plate" && c.png.length <= card.CARD.maxBytes, `${event}: ${c === "wait" ? c : c.kind}`);
  }
  const v = await card.cardFor("online", new Date(), {}, { event: "online" });
  assert.ok(v !== "wait" && v.kind === "video" && v.source === "logo");
  const r = await card.cardFor("reply:1", new Date(), {}, { event: "reply" });
  assert.ok(r !== "wait" && r.kind === "none", "anything else stays text only");
});
