// Character memory against Postgres and the local fakes: every post and reply text is a log record before X sees it;
// the writer gets its own recent posts and refuses to repeat them; people by X id; running jokes; the weekly voice audit.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import postgres from "postgres";
import { startFakes } from "../scripts/fakes.ts";
import { synthetic } from "../scripts/synthetic.ts";

/** A signer's Telegram user id: distinctive, so a leak of it into any record is found by a plain text search. */
const SIGNER = 5550001234;
const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
fakes.llm.xai = (b) => synthetic("xai", b); // the writer (Grok)
fakes.llm.anthropic = (b) => synthetic("anthropic", b); // the voice audit (Claude)
const dbName = `dna_char_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;

if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc`, ENGINE_MODE: "live",
    TELEGRAM_API_BASE: fakes.url, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_ID: "-100", TELEGRAM_ALLOWED_USER_IDS: String(SIGNER), TELEGRAM_POLL_TIMEOUT_S: "1",
    XAI_API_BASE: fakes.url, OPENROUTER_API_BASE: fakes.url, XAI_API_KEY: "k", OPENROUTER_API_KEY_ENGINE: "k", LLM_MODE: "record", LLM_FIXTURES: `${mkdtempSync(join(tmpdir(), "dna-llm-"))}/`,
    X_API_BASE: fakes.url, X_CLIENT_ID: "cid", X_REFRESH_TOKEN: "seed", X_USER_ID: "42", SECRET_SEAL_KEY: "11".repeat(32),
  });
}
// imported only after the env is set (config is read at import)
const { edb: sql, migrate } = await import("../src/db.ts");
const { SHAPE_KEYS, shapesFor } = await import("../src/voice.ts");
const log = await import("../src/log.ts");
const modeM = await import("../src/mode.ts");
const xM = await import("../src/x.ts");
const ch = await import("../src/character.ts");
const persona = await import("../src/persona.ts");
const { X } = await import("../src/config.ts");

before(async () => {
  if (!ADMIN) return;
  await migrate();
  await modeM.initMode();
  xM.CHARACTER_MEMORY.context = ch.characterContext; // what src/engine.ts does
});
after(async () => {
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await fakes.close();
});

const job = () => ({ id: "0", kind: "t", payload: {}, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null }) as never;
const tweets = () => fakes.calls.filter((c) => c.path === "/2/tweets" && c.method === "POST");
const attempt = async (text: string) => (await sql<{ doc: Record<string, any> }[]>`select doc from log where kind = 'x_post' and doc->>'status' = 'attempt' and doc->>'text' = ${text}`)[0]?.doc; // eslint-disable-line @typescript-eslint/no-explicit-any
/** A mention that tagged us (replies go only to posts that summoned the account). */
const putMention = (id: string, author: string) =>
  sql`insert into x_mention (id, author_id, text, raw) values (${id}, ${author}, 'what is the fee cap rule?', ${sql.json({ id, text: "what is the fee cap rule?", entities: { mentions: [{ start: 0, end: 13, username: "fake_account", id: "42" }] } } as never)})`;
// grok calls go to xAI direct (Responses: instructions + input); the OpenRouter chat shape is their fallback
const writerInputs = () => fakes.calls.filter((c) => String(c.body.instructions ?? c.body.messages?.[0]?.content).startsWith("agent: x-writer")).map((c) => JSON.parse(c.body.input?.[0]?.content ?? c.body.messages[1].content));

test("every post and reply text is in a log record before the X API call; the writer remembers and does not repeat itself", { skip }, async () => {
  const saved = { ...X };
  // at the moment X is called, the exact text must already be a record
  const before: string[] = [];
  const real = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/2/tweets") && init?.method === "POST") {
      const text = JSON.parse(String(init.body)).text as string;
      before.push((await attempt(text)) ? text : `NO RECORD: ${text}`);
    }
    return real(input, init);
  });
  try {
    X.spacingMs = 0;
    const link = (n: number) => `https://etherscan.io/tx/0x${String(n).repeat(64)}`;
    await xM.enqueueX("char:1", "post", { event: "rolled_back", route: "fee" }, { link: link(1) });
    assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
    await xM.enqueueX("char:2", "post", { event: "rolled_back", route: "split" }, { link: link(2) });
    assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
    await putMention("6001", "777");
    X.aiRepliesApproved = true;
    await xM.enqueueX("reply:6001", "reply", { event: "reply", category: "rules_question", author: "777" }, { replyTo: "6001" });
    assert.ok(((await xM.sendHandler.run(job())) as { tweetId: string }).tweetId);
    // an important account's reply before X's approval: held, then sent by a signer's tap (the same deliver())
    await putMention("6002", "779");
    X.aiRepliesApproved = false;
    await xM.enqueueX("reply:6002", "reply", { event: "reply", category: "state_question", tier: "important", author: "779" }, { replyTo: "6002" });
    const held = (await xM.sendHandler.run(job())) as { held: string };
    assert.ok(held.held, JSON.stringify(held));
    assert.match(await xM.pressReply(held.held, true, "telegram:signer-1"), /sent: /);
    await xM.postDraft({ text: "the official account says hello. it never asks you to connect anything." }, "d-char");

    const sent = tweets().map((t) => t.body.text as string);
    assert.equal(sent.length, 5);
    assert.deepEqual(before, sent, "each text was a record before its POST");
    assert.deepEqual((await log.verify(sql)).ok, true);

    // the first post had no history; the second repeated its opening, was refused, and the fresh candidate went
    assert.equal(sent[0], `Synthetic post about a rolled back event.\n${link(1)}`);
    assert.match(sent[1], /^Zq[a-z]{6} rolled back\.\n/);
    const second = await attempt(sent[1]);
    assert.deepEqual(second.candidates[1].issues, ['too similar: repeat opening "synthetic post about"']);
    assert.equal(second.draft, sent[1].split("\n")[0]);
    assert.ok((SHAPE_KEYS as readonly string[]).includes(second.shape));
    assert.notEqual(second.shape, (await attempt(sent[0])).shape, "the shape rotates: never twice in a row for an event");
    assert.equal(second.mood, "stung", "a rollback today stings");
    // the persona by hash (null here: no persona configured, the neutral default), never its text
    assert.ok("personaSha256" in second && second.personaSha256 === persona.PERSONA.sha256);
    assert.ok(!JSON.stringify(second).includes(persona.PERSONA.voice.split("\n")[1]));
    const input = writerInputs()[1]; // the writer's input for the second post
    assert.deepEqual(input.character.recent.map((p: { text: string }) => p.text), ["Synthetic post about a rolled back event."]);
    assert.match(input.character.recent[0].at, /^\d{4}-\d{2}-\d{2}T/, "with when it went out");
    assert.ok(Number.isInteger(input.facts.day) && input.facts.day >= 1, "the day of the run on every post");
    assert.deepEqual(input.character.avoid.openings, ["synthetic post about"]);

    // the reply: deadpan, the reader's X id in the record (never in the writer's facts), remembered by id
    const reply = await attempt(sent[2]);
    assert.deepEqual([shapesFor("reply", reply.facts).includes(reply.shape), reply.author, reply.facts.author], [true, "777", undefined], "a reply's shape");
    assert.equal(writerInputs()[2].facts.author, undefined);
    const known = await ch.characterContext({ authorId: "777" });
    assert.deepEqual([known.person?.replies, known.person?.lastTopic], [1, "rules_question"]);
    assert.equal((await ch.characterContext({ authorId: "778" })).person, undefined);
    const tapped = await attempt(sent[3]);
    assert.deepEqual([tapped.by, tapped.author, shapesFor("reply", tapped.facts).includes(tapped.shape), tapped.draft], ["telegram:signer-1", "779", true, sent[3]], "the tapped reply carries its memory fields");
    assert.equal(known.recent[0].text, "the official account says hello. it never asks you to connect anything.", "newest first, human drafts too");

    // /proof: the tweet id finds the signed text through the `posted` record
    const [{ id }] = await sql<{ id: string }[]>`select tweet_id as id from x_outbox where event_key = 'char:2'`;
    const [p] = await sql<{ ref: string }[]>`select ref from log where kind = 'x_post' and doc->>'tweetId' = ${id}`;
    assert.equal(p.ref, "char:2");
  } finally {
    mock.restoreAll();
    Object.assign(X, saved);
  }
});

test("running jokes and the weekly voice audit feed the writer's banned list", { skip }, async () => {
  const drafts = ["kept it. nobody asked.", "rolled back. nobody asked, again.", "spread tax paid, in full.", "the spread tax is a feature now.", "quiet pool, quiet book."];
  for (const [i, draft] of drafts.entries()) {
    await log.append("x_post", `char:j${i}`, { type: "post", status: "attempt", draft, text: draft, ...(draft.includes("spread tax") ? { joke: "spread tax" } : {}) });
  }
  const r = (await ch.auditHandler.run(job())) as { patterns: string[] };
  // the two pipeline drafts that open "synthetic post about" (the first post and the first reply) are a real repeat
  assert.deepEqual(r.patterns, ["nobody asked", "synthetic post about"], "only phrases that really repeat; never the injection or a lexicon word");
  const c = await ch.characterContext();
  assert.ok(c.banned.includes("nobody asked"));
  assert.deepEqual(c.jokes, [{ label: "spread tax", ageDays: 0, uses: 2 }]);
  assert.equal(c.recent.length, drafts.length + 5, "the 5 texts sent above and these");
});

test("signers appear in the log by allowlist place, never by Telegram user id (a Send tap, /mute)", { skip }, async () => {
  const tg = await import("../src/telegram.ts");
  assert.deepEqual([tg.signerTag(SIGNER), tg.signerTag(1)], ["telegram:signer-1", "telegram:signer-unknown"]);
  const saved = { ...X };
  try {
    X.aiRepliesApproved = false;
    await putMention("6003", "780");
    await xM.enqueueX("reply:6003", "reply", { event: "reply", category: "rules_question", tier: "important", author: "780" }, { replyTo: "6003" });
    const held = (await xM.sendHandler.run(job())) as { held: string };
    assert.ok(held.held, JSON.stringify(held));
    // the real Telegram path: a Send tap and a /mute command from the signer
    fakes.tgUpdates.push(
      { update_id: 1, callback_query: { id: "q1", from: { id: SIGNER }, message: { message_id: 1, chat: { id: -100 } }, chat_instance: "1", data: `x:${held.held}:s` } },
      { update_id: 2, message: { message_id: 2, chat: { id: -100 }, from: { id: SIGNER }, text: "/mute" } },
    );
    let polls = 0;
    await tg.pollTelegram({ "/mute": async (by) => { await xM.setMuted(true, by); return "muted"; } }, () => polls++ > 0, xM.pressReply);
    const by = async (kind: string, ref: string, status?: string) =>
      (await sql<{ by: string }[]>`select doc->>'by' as by from log where kind = ${kind} and ref = ${ref} ${status ? sql`and doc->>'status' = ${status}` : sql``} order by log.seq desc limit 1`)[0]?.by;
    assert.equal(await by("x_post", "reply:6003", "attempt"), "telegram:signer-1");
    assert.equal(await by("mode", "x_mute"), "telegram:signer-1");
    assert.equal((await sql`select seq from log where body like ${`%${SIGNER}%`}`).length, 0, "no record holds the raw Telegram id");
  } finally {
    await xM.setMuted(false, "test");
    Object.assign(X, saved);
  }
});
