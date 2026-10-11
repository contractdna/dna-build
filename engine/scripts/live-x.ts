// The one public X test before launch, run by an operator with a go: the engine's own code against the real services.
//  1. ONE image through the studio pipeline (src/studio.ts generate with 1 candidate and 1 round: OpenAI Images edits
//     with the style references, moderation, near-duplicate check, rubric), then the enclave's re-check (src/card.ts:
//     size, visible pixels, the vision check) and the card; a copy is saved. No passing art → the production fallback
//     (a plate card), reported.
//  2. The writer drafts a reply (src/voice.ts writePosts on a rules_question reply fact sheet) through the production
//     filter (postFilter), before X is touched.
//  3. X: refresh (src/x.ts exchangeRefreshToken). The refresh token is single-use: the rotated one goes to the operator's
//     store FIRST (LIVE_X_TOKEN_SINK, a command that gets it on stdin; nothing posts unless it exits 0). Then one post
//     (fixed text + the card, src/x.ts uploadImage) and at most two replies TO THAT POST ONLY (a fixed text, the
//     writer's draft), each read back (text, media, thread). Every post is deleted in a finally block (replies first),
//     each delete verified; a failed delete prints the ids loudly.
//  4. A short report: post URL, latencies, image path, filter verdict, rate-limit headers (stage/out/live-x-<UTC>/).
// Hard caps: 1 image, 1 post, 2 replies. No mention of any account, no wallet address (checked before posting).
//   node scripts/live-x.ts --i-have-a-go     env: X_CLIENT_ID, X_CLIENT_SECRET, X_REFRESH_TOKEN, OPENAI_API_KEY,
//                                            OPENROUTER_API_KEY_ENGINE, LIVE_X_TOKEN_SINK
//   node scripts/live-x.ts --i-have-a-go --dry   the local fakes (tests); LIVE_X_DRY_FAIL=reply|accepted|accepted-writer|delete simulates failures
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { die, dryFakes, guardEnv, memLedger, outDir, writeJson } from "./stage-lib.ts";

const NAME = "live-x";
const POST_TEXT = "Test post: checking images and replies before launch. This will be deleted in a few minutes.";
const REPLY_TEXT = "Test reply: checking threads.";
const { values: arg } = parseArgs({ options: { "i-have-a-go": { type: "boolean", default: false }, dry: { type: "boolean", default: false }, "delete-after": { type: "string", default: "180" }, out: { type: "string" } } });
if (!arg["i-have-a-go"]) die(NAME, "this posts on the project's public X account. It runs only with --i-have-a-go (a go for this run).");
const deleteAfter = Number(arg["delete-after"]);
if (!(deleteAfter >= 0 && deleteAfter <= 600)) die(NAME, "--delete-after is seconds in 0..600");
// X credentials are this run's own (allowed); never a wallet key, a database or another channel's token
guardEnv(NAME, ["X_CLIENT_ID", "X_CLIENT_SECRET", "X_REFRESH_TOKEN"]);
for (const k of ["X_API_BASE", "OPENAI_API_BASE", "OPENROUTER_API_BASE", "XAI_API_BASE", "MEDIA_VISION_MODEL", "STUDIO_VIA", "STUDIO_DAILY_ROUNDS"]) delete process.env[k];
const dir = outDir("live-x", arg.out);
Object.assign(process.env, { STUDIO_DIR: join(dir, "studio"), STUDIO_DAILY_ROUNDS: "1" });
const fakes = arg.dry ? await dryFakes() : null;
if (fakes && process.env.LIVE_X_DRY_WRITER) { // tests: the writer's one candidate
  const base = fakes.llm.xai;
  fakes.llm.xai = (b) => {
    const r = base(b);
    if (b.response_format?.json_schema?.schema?.properties?.candidates) r.output[0].content[0].text = JSON.stringify({ candidates: [process.env.LIVE_X_DRY_WRITER] });
    return r;
  };
}
if (fakes) fakes.x.mediaLink = process.env.LIVE_X_DRY_MEDIA_LINK ?? "https://t.co/Ab12Cd34Ef"; // as X does; tests: another suffix
if (fakes) Object.assign(process.env, { X_CLIENT_ID: "cid", X_CLIENT_SECRET: "cs", X_REFRESH_TOKEN: "seed", OPENAI_API_KEY: "dry", OPENROUTER_API_KEY_ENGINE: "dry" });
const env = { clientId: process.env.X_CLIENT_ID, secret: process.env.X_CLIENT_SECRET, refresh: process.env.X_REFRESH_TOKEN, sink: process.env.LIVE_X_TOKEN_SINK };
for (const [k, v] of Object.entries({ X_CLIENT_ID: env.clientId, X_CLIENT_SECRET: env.secret, X_REFRESH_TOKEN: env.refresh, LIVE_X_TOKEN_SINK: env.sink, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENROUTER_API_KEY_ENGINE: process.env.OPENROUTER_API_KEY_ENGINE })) if (!v) die(NAME, `needs ${k}`);
// the engine's config refuses X credentials without a seal key (it seals the rotated token into its database): this
// run hands the rotated token to the operator's store instead, so they stay out of the engine modules' env
for (const k of ["X_CLIENT_ID", "X_CLIENT_SECRET", "X_REFRESH_TOKEN"]) delete process.env[k];

const ledger = await memLedger(1);
const studio = await import("../src/studio.ts");
const { artIssue, composite, plateIndex, plates, slotsOf, visiblePixels, visionIssue } = await import("../src/card.ts");
const x = await import("../src/x.ts");
const { factNumbers, factSheet, linkIssues, postFilter, writePosts } = await import("../src/voice.ts");

const t0 = Date.now();
const ms: Record<string, number> = {};
const timed = async <T>(k: string, f: () => Promise<T>) => { const t = Date.now(); try { return await f(); } finally { ms[k] = Date.now() - t; } };
const report: Record<string, unknown> = { mode: arg.dry ? "dry (local fakes)" : "live", at: new Date().toISOString(), out: dir };
const finish = async (code: number) => { report.ms = { ...ms, total: Date.now() - t0 }; report.llmUsd = Number(ledger.spent().toFixed(4)); writeJson(dir, "report.json", report); await fakes?.close(); process.exit(code); };
/** Public text guard on top of the filters: no account mention, no wallet address or hash, no link. */
const publicIssue = (t: string) => (/@/.test(t) ? "mentions an account" : /0x[0-9a-fA-F]{6,}/.test(t) ? "a wallet address or hash" : linkIssues(t.normalize("NFKC")).join(", ") || null);
for (const t of [POST_TEXT, REPLY_TEXT]) if (publicIssue(t)) die(NAME, `fixed text refused: ${publicIssue(t)}`);

// ---------------------------------------------------------------- 1. one image through the studio and the enclave's re-check
console.error(`${NAME}: image`);
Object.assign(studio.STUDIO, { candidates: 1, rounds: 1 });
let images = 0;
const base = studio.activeClient();
const client: typeof base = { ...base, async images(prompt, refs, n, size) {
  if (images + n > 1) throw new Error("hard cap: 1 image per run");
  const r = await base.images(prompt, refs, n, size);
  images += r.images.length;
  return r;
} };
const key = `live-x:${report.at}`;
const layer = { badge: "TEST", headline: "TEST POST", figures: [] };
let card: Buffer, image: Record<string, unknown>;
const meta = await timed("image", () => studio.generate(key, slotsOf({ event: "outcome", outcome: "kept (promoted)" }, key, "lab"), "wide", client)).catch((e) => ({ status: "error", reasons: [(e as Error).message.slice(0, 300)] }) as const);
const art = meta.status === "ready" ? (await import("node:fs")).readFileSync(join(process.env.STUDIO_DIR!, `${(await import("node:crypto")).createHash("sha256").update(key).digest("hex").slice(0, 32)}.art`)) : null;
const recheck = art ? await timed("recheck", async () => artIssue(art, "wide") ?? (visiblePixels(art) === 0 ? "fully transparent" : null) ?? (await visionIssue(art))) : "no studio art";
if (art && !recheck) {
  writeFileSync(join(dir, "art.jpg"), art);
  card = composite(art, layer, "wide");
  image = { source: "studio", art: join(dir, "art.jpg"), scores: (meta as { scores?: unknown }).scores };
} else {
  // the production fallback: a pinned plate with the same fact layer
  const p = plates();
  const i = plateIndex(key, p.plates, null, []);
  card = composite(p.bytes(i), layer, "wide");
  image = { source: "plate", plate: p.plates[i].file, why: recheck === "no studio art" ? (meta as { reasons?: string[] }).reasons ?? meta.status : recheck };
}
writeFileSync(join(dir, "card.png"), card);
report.image = { ...image, card: join(dir, "card.png"), bytes: card.length, generated: images };

// ---------------------------------------------------------------- 2. the writer's reply through the production filter
console.error(`${NAME}: writer`);
const facts = factSheet({ event: "reply", category: "rules_question" });
const w = await timed("writer", () => writePosts(facts, [])).catch((e) => ({ error: (e as Error).message.slice(0, 300) }));
const candidates = "error" in w ? [] : w.data.candidates.map((text) => ({ text, issues: [...postFilter(text, factNumbers(facts), 0), ...(publicIssue(text) ? [publicIssue(text)!] : [])] }));
const pick = candidates.find((c) => !c.issues.length);
const writerText = pick ? pick.text.normalize("NFKC").trim() : null;
report.filter = { model: "error" in w ? null : w.model, error: "error" in w ? w.error : undefined, candidates, picked: writerText };


// ---------------------------------------------------------------- 3. X: refresh, hand over the rotated token, post, reply, read back, delete
// Ctrl-C, a kill or a closed terminal (SIGINT, SIGTERM, SIGHUP) from here on never skips the cleanup: the first one
// ends the viewing wait (or stops before the next step), and every further one is ignored until the cleanup has run and
// its banner, if any, has printed. A closed terminal makes writes fail: those errors are dropped, never fatal.
let interrupted = false;
let wake: (() => void) | undefined;
for (const out of [process.stdout, process.stderr]) out.on("error", () => {});
const onSignal = (sig: string) => {
  if (interrupted) return void console.error(`${NAME}: cleaning up, please wait (deleting what this run posted)`);
  interrupted = true;
  console.error(`${NAME}: interrupted (${sig}): deleting what this run posted, then stopping`);
  wake?.();
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => onSignal(sig));
const notInterrupted = () => { if (interrupted) throw new Error("interrupted (Ctrl-C)"); };

console.error(`${NAME}: X token`);
let tok: Awaited<ReturnType<typeof x.exchangeRefreshToken>>;
try {
  tok = await timed("refresh", () => x.exchangeRefreshToken(env.refresh!, env.clientId, env.secret));
} catch (e) {
  report.error = `${(e as Error).message}: the refresh token is spent or revoked. Log in again (one-time X login), then rerun. Nothing was posted.`;
  console.error(`${NAME}: ${report.error}`);
  await finish(1);
  throw e;
}
if (tok.refresh_token) {
  const r = spawnSync(env.sink!, ["store-token"], { input: `${tok.refresh_token}\n`, stdio: ["pipe", "ignore", "inherit"], timeout: 60_000 });
  if (r.status !== 0) {
    // spent, and not stored: keep it in a private temp file (never in the repository) so the login is not lost; post nothing
    const f = join(mkdtempSync(join(tmpdir(), "live-x-")), "rotated-refresh-token");
    writeFileSync(f, `${tok.refresh_token}\n`, { mode: 0o600 });
    report.error = `the token store failed (exit ${r.status}): the rotated refresh token is in ${f} (mode 600). Store it, delete the file. Nothing was posted.`;
    report.tokenFile = f;
    console.error(`${NAME}: ${report.error}`);
    await finish(1);
  }
}
report.tokenRotated = !!tok.refresh_token;
if (interrupted) { report.error = "interrupted before posting: nothing was posted"; await finish(1); }
x.useAccessToken(tok.access_token, Math.max(60, (tok.expires_in ?? 7200) - 300));
const granted = new Set((tok.scope ?? "").split(/\s+/).filter(Boolean));
report.scopesMissing = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"].filter((s) => !granted.has(s));

const rate: Record<string, unknown> = {};
const call = async <T>(label: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => {
  const r = await timed(label, () => x.xApi<T>(method, path, body));
  const h = (k: string) => r.headers.get(`x-rate-limit-${k}`);
  rate[label] = h("limit") ? `${h("remaining")}/${h("limit")}, resets ${new Date(Number(h("reset")) * 1000).toISOString()}` : "no rate-limit headers";
  return r;
};
type Tweet = { id: string; text?: string; conversation_id?: string; referenced_tweets?: { type: string; id: string }[]; attachments?: { media_keys?: string[] } };
/** Read a post back until it is there (`present`) or gone (`!present`): reads after a write or a delete can lag. Any
 *  status but 200 throws: an unreadable post is never taken for a deleted one. */
const readBack = async (label: string, id: string, present = true) => {
  for (let i = 0; ; i++) {
    const r = await call<{ data?: Tweet }>(label, "GET", `/2/tweets/${id}?tweet.fields=conversation_id,referenced_tweets,attachments,author_id`);
    if (r.status !== 200) throw Object.assign(new Error(`${label}: GET /2/tweets/${id} ${r.status}`), { status: r.status });
    if (!!r.body.data === present || i >= 4) return r.body.data;
    await new Promise((res) => setTimeout(res, 2000));
  }
};

const me = await call<{ data?: { id: string; username: string } }>("me", "GET", "/2/users/me");
if (!me.body.data?.username) { report.error = `users/me ${me.status}`; await finish(1); }
const { id: myId, username: user } = me.body.data!;
const posted: { what: string; id: string }[] = [];
const checks: { what: string; ok: boolean; detail?: unknown }[] = [];
const check = (what: string, ok: boolean, detail?: unknown) => checks.push({ what, ok, detail });
const tweet = async (what: string, body: Record<string, unknown>) => {
  notInterrupted();
  if (posted.length >= 3) throw new Error("hard cap: 1 post and 2 replies");
  const r = await call<{ data?: { id: string } }>(what, "POST", "/2/tweets", body);
  if (r.status !== 201 || !r.body.data?.id) throw new Error(`${what}: POST /2/tweets ${r.status}`);
  posted.push({ what, id: r.body.data.id });
  return r.body.data.id;
};
const OURS = new Set([POST_TEXT, REPLY_TEXT, ...(writerText ? [writerText] : [])]);
/** X returns `text` with &, < and > HTML-escaped, and a post with media with a t.co link to it appended: compare the
 *  text as posted. Only one trailing ` https://t.co/<id>` (and trailing whitespace) is dropped, nothing else. */
const unescapeX = (t: string | undefined) => t?.replace(/\s+https:\/\/t\.co\/[A-Za-z0-9]+\s*$/, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
let code = 0;
try {
  console.error(`${NAME}: post`);
  const mediaId = await timed("upload", () => x.uploadImage(card));
  const postId = await tweet("post", { text: POST_TEXT, media: { media_ids: [mediaId] } });
  report.postUrl = `https://x.com/${user}/status/${postId}`;
  console.error(`${NAME}: posted ${report.postUrl}`);
  if (fakes && process.env.LIVE_X_DRY_FAIL === "reply") fakes.x.tweetStatus = 503;
  if (fakes && process.env.LIVE_X_DRY_FAIL === "accepted") fakes.x.acceptThenFail = true;
  const p = await readBack("read post", postId);
  check("post text", unescapeX(p?.text) === POST_TEXT, p?.text);
  check("post media", !!p?.attachments?.media_keys?.some((k) => k.endsWith(`_${mediaId}`)), { mediaId, keys: p?.attachments?.media_keys });
  // replies: to the post this run made, never to anyone else
  for (const [what, text] of [["reply fixed", REPLY_TEXT], ["reply writer", writerText]] as const) {
    if (!text) { check(what, false, "no writer candidate passed the filter: not posted"); continue; }
    if (fakes && process.env.LIVE_X_DRY_FAIL === "accepted-writer" && what === "reply writer") fakes.x.acceptThenFail = true;
    const id = await tweet(what, { text, reply: { in_reply_to_tweet_id: postId } });
    const t = await readBack(`read ${what}`, id);
    check(`${what} text`, unescapeX(t?.text) === text, t?.text);
    check(`${what} threaded`, t?.conversation_id === postId && !!t?.referenced_tweets?.some((r) => r.type === "replied_to" && r.id === postId), { conversation: t?.conversation_id, refs: t?.referenced_tweets });
  }
  notInterrupted();
  if (deleteAfter) {
    console.error(`${NAME}: deleting in ${deleteAfter} s (Ctrl-C deletes now): look at ${report.postUrl}`);
    await new Promise<void>((r) => { const t = setTimeout(r, deleteAfter * 1000); wake = () => { clearTimeout(t); r(); }; });
  }
  notInterrupted();
} catch (e) {
  report.error = (e as Error).message.slice(0, 300);
  console.error(`${NAME}: ${report.error}`);
  code = 1;
} finally {
  // replies first, then the post; each delete verified by reading it back
  if (fakes && process.env.LIVE_X_DRY_FAIL === "delete") fakes.x.deleteStatus = 500;
  if (fakes) fakes.x.deleteDelayMs = Number(process.env.LIVE_X_DRY_DELETE_MS ?? 0); // tests: a slow cleanup to interrupt
  if (fakes) fakes.x.listStatus = Number(process.env.LIVE_X_DRY_LIST_STATUS ?? 200); // tests: the own-posts listing refused
  const left: string[] = [];
  const remove = async (what: string, id: string) => {
    const d = await call<{ data?: { deleted?: boolean } }>(`delete ${what}`, "DELETE", `/2/tweets/${id}`).catch(() => null);
    if (d?.body.data?.deleted !== true) { check(`deleted ${what}`, false, id); left.push(id); return; }
    // X said deleted: a rate-limited read-back can't confirm it, but is no reason to call it not deleted
    const still = await readBack(`verify delete ${what}`, id, false).then((t) => (t ? "still readable" : null), (e) => ((e as { status?: number }).status === 429 ? "rate-limited" : "unreadable"));
    if (still === "rate-limited") { check(`deleted ${what}`, true, `${id}: delete answered deleted:true; read-back rate-limited`); return; }
    check(`deleted ${what}`, !still, still ? `${id}: ${still}` : id);
    if (still) left.push(id);
  };
  for (const p of [...posted].reverse()) await remove(p.what, p.id);
  // a post X accepted but answered with an error or a timeout is not in `posted`: find it among our posts since the start
  const unknown: string[] = [];
  try {
    const since = new Date(Date.parse(String(report.at)) - 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const mine = await call<{ data?: Tweet[] }>("list own posts", "GET", `/2/users/${myId}/tweets?max_results=5&start_time=${since}`);
    if (mine.status !== 200) throw new Error(`GET /2/users/<me>/tweets ${mine.status}`);
    for (const t of mine.body.data ?? []) {
      if (posted.some((p) => p.id === t.id)) continue;
      if (t.text && OURS.has(unescapeX(t.text)!)) await remove("orphan", t.id);
      else unknown.push(t.id);
    }
  } catch (e) {
    // a post X created but answered with an error can't be found without this list: a human checks
    check("listed own posts since the start", false, (e as Error).message.slice(0, 200));
    report.LIST_FAILED = true;
    code = 1;
  }
  if (left.length || unknown.length || report.LIST_FAILED) {
    code = 1;
    if (left.length) report.NOT_DELETED = left;
    if (unknown.length) report.UNKNOWN_POSTS = unknown;
    console.error(`\n${"!".repeat(72)}\n${left.length ? `${NAME}: NOT DELETED, delete these by hand on @${user}: ${left.join(", ")}\n` : ""}${unknown.length ? `${NAME}: posts since the start that are not this run's texts (left alone, check them): ${unknown.join(", ")}\n` : ""}${report.LIST_FAILED ? `${NAME}: could not list own posts: check @${user} by hand for a post this run made\n` : ""}${"!".repeat(72)}\n`);
  }
}
if (interrupted) code = 1;
report.checks = checks;
report.rateLimits = rate;
if (checks.some((c) => !c.ok)) code = 1;
console.error(`${NAME}: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed; image ${(report.image as { source: string }).source} (${join(dir, "card.png")}); report ${join(dir, "report.json")}`);
console.log(JSON.stringify({ postUrl: report.postUrl, ms: { ...ms, total: Date.now() - t0 }, image: report.image, filter: { picked: writerText, verdicts: candidates.map((c) => c.issues.length ? c.issues : "ok") }, rateLimits: rate, scopesMissing: report.scopesMissing, tokenRotated: report.tokenRotated, notDeleted: report.NOT_DELETED ?? [], unknownPosts: report.UNKNOWN_POSTS ?? [], failed: checks.filter((c) => !c.ok).map((c) => c.what) }, null, 2));
await finish(code);
