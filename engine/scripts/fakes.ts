// Local fakes for the engine's external APIs (tests + e2e; no real keys in CI): Telegram Bot API (+ sendPhoto), X API
// v2 (+ OAuth2 token, media upload simple and chunked), xAI Responses, OpenRouter (Messages, chat), OpenAI Images edits and generations /
// moderations / chat completions (the studio), and an optional JSON-RPC stub. Every request is recorded in `calls`; a
// multipart body is recorded as {fields, files: {name: [{bytes, type}]}}.
// Response shapes follow the docs cited in src/telegram.ts, src/x.ts and src/llm.ts.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Resvg } from "@resvg/resvg-js";
import type { AddressInfo } from "node:net";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Call = { method: string; path: string; body: Json; headers: IncomingMessage["headers"] };

export async function startFakes(port = 0) {
  const calls: Call[] = [];
  const tgUpdates: Json[] = [];
  const mentions: Json[] = [];
  const rpc: Record<string, (params: Json[]) => Json> = {};
  const llm = {
    xai: (_body: Json): Json => ({ model: "grok-4.7", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }], usage: { input_tokens: 10, output_tokens: 5 } }),
    anthropic: (_body: Json): Json => ({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 5 } }),
  };
  let msgId = 100;
  let tweetId = 5000;
  let mediaId = 9000;
  // tests set e.g. 503 (accepted-then-failed), 401 (revoked), a 400 refresh; mediaStatus ≠ 200 fails uploads;
  // processing: the STATUS answers a video gets after finalize, in order
  // posted tweets, as GET /2/tweets/:id reads them back (deleteStatus ≠ 200 fails deletes)
  const tweets = new Map<string, Json>();
  const x = { tweetStatus: 201, tokenStatus: 200, mediaStatus: 200, deleteStatus: 200, deleteDelayMs: 0, listStatus: 200, acceptThenFail: false, mediaLink: "", processing: ["in_progress", "succeeded"] as string[], onUpload: async () => {},
    // recent search (X: by conversation_id): the posts a test puts here, each with its `user`, oldest last as X lists them
    search: [] as Json[] };
  const status = new Map<string, number>();
  // the studio's OpenAI: images are distinct deterministic PNGs of the requested size (a pattern from the prompt), all
  // clean; tests override moderation / rubric
  const openai = {
    image: (prompt: string, i: number, size: string) => fakePng(`${prompt}#${i}`, size),
    flagged: (_body: Json) => false,
    rubric: (_body: Json): Json => ({ onBrand: 8, clean: 9, room: 8, original: 8, text: false }),
  };

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    const raw = buf.toString("utf8");
    const path = req.url ?? "/";
    let body: Json = raw;
    if (String(req.headers["content-type"]).startsWith("multipart/form-data")) {
      const form = await new Response(buf, { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
      body = { fields: {} as Record<string, string>, files: {} as Record<string, { bytes: number; type: string; data: Buffer }[]> };
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") body.fields[k] = v;
        else (body.files[k] ??= []).push({ bytes: v.size, type: v.type, data: Buffer.from(await v.arrayBuffer()) });
      }
    } else try { body = raw ? JSON.parse(raw) : {}; } catch { /* form-encoded (oauth2 token) */ }
    calls.push({ method: req.method ?? "GET", path, body, headers: req.headers });
    const send = (status: number, j: Json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(j));

    const tg = path.match(/^\/bot[^/]+\/(\w+)$/);
    if (tg) {
      const m = tg[1];
      if (m === "getUpdates") {
        for (let i = 0; i < 10 && !tgUpdates.length; i++) await new Promise((r) => setTimeout(r, 100)); // short long-poll
        const off = body.offset ?? 0;
        return send(200, { ok: true, result: tgUpdates.splice(0).filter((u) => u.update_id >= off) });
      }
      if (m === "sendMessage") return send(200, { ok: true, result: { message_id: ++msgId, chat: { id: body.chat_id }, date: 0, text: body.text } });
      if (m === "sendPhoto") return send(200, { ok: true, result: { message_id: ++msgId, chat: { id: Number(body.fields?.chat_id) }, date: 0, caption: body.fields?.caption } });
      if (m === "answerCallbackQuery") return send(200, { ok: true, result: true });
      // the edited message comes back, without the keyboard the call left out
      if (m === "editMessageReplyMarkup") return send(200, { ok: true, result: { message_id: body.message_id, chat: { id: body.chat_id }, date: 0, ...(body.reply_markup ? { reply_markup: body.reply_markup } : {}) } });
      if (m === "getMe") return send(200, { ok: true, result: { id: 1, is_bot: true, first_name: "fake", username: "fake_bot", can_read_all_group_messages: false } });
      if (m === "getWebhookInfo") return send(200, { ok: true, result: { url: "", pending_update_count: tgUpdates.length } });
      if (m === "getChat") return send(200, { ok: true, result: { id: body.chat_id, type: "supergroup", title: "fake" } });
      if (m === "getChatMemberCount") return send(200, { ok: true, result: 2 });
      if (m === "getChatMember") return send(200, { ok: true, result: { status: "member", user: { id: body.user_id, is_bot: false, first_name: "x" } } });
      return send(404, { ok: false, error_code: 404, description: "Not Found" });
    }
    if (path === "/v1/images/edits") {
      const n = Number(body.fields?.n ?? 1);
      res.setHeader("x-request-id", `req_fake_${calls.length}`);
      return send(200, { created: 0, data: Array.from({ length: n }, (_, i) => ({ b64_json: openai.image(String(body.fields?.prompt), i, String(body.fields?.size)).toString("base64") })), usage: { input_tokens: 10, output_tokens: 10 } });
    }
    if (path === "/v1/images/generations") {
      const n = Number(body.n ?? 1);
      res.setHeader("x-request-id", `req_fake_${calls.length}`);
      return send(200, { created: 0, data: Array.from({ length: n }, (_, i) => ({ b64_json: openai.image(String(body.prompt), i, String(body.size)).toString("base64") })), usage: { input_tokens: 10, output_tokens: 10 } });
    }
    if (path === "/v1/images") { // OpenRouter's image API (the studio's OpenRouter path)
      const n = Number(body.n ?? 1);
      return send(200, { id: "gen-fake", created: 0, data: Array.from({ length: n }, (_, i) => ({ b64_json: openai.image(String(body.prompt), i, String(body.size)).toString("base64") })), usage: { cost: 0.04 * n } });
    }
    if (path === "/v1/moderations") return send(200, { results: [{ flagged: openai.flagged(body) }] });
    if (path === "/v1/chat/completions" && body.provider?.order?.[0] !== "xai") return send(200, { choices: [{ message: { content: JSON.stringify(openai.rubric(body)) } }] });
    if (path.startsWith("/2/media/upload")) {
      await x.onUpload();
      if (x.mediaStatus !== 200) return send(x.mediaStatus, { title: "fake media failure" });
      if (path === "/2/media/upload" && req.method === "POST") {
        // the v2 one-shot upload: multipart (media binary, media_category, media_type)
        if (!body.files?.media?.[0] || !body.fields?.media_category) return send(400, { title: "fake: multipart media + media_category required" });
        return send(200, { data: { id: String(++mediaId), media_key: `3_${mediaId}`, size: body.files.media[0].bytes } });
      }
      if (path === "/2/media/upload/initialize") { status.set(String(++mediaId), 0); return send(200, { data: { id: String(mediaId), media_key: `7_${mediaId}`, expires_after_secs: 86_400 } }); }
      const ap = path.match(/^\/2\/media\/upload\/(\d+)\/(append|finalize)$/);
      if (ap?.[2] === "append") return res.writeHead(204).end();
      if (ap?.[2] === "finalize") return send(200, { data: { id: ap[1], processing_info: { state: "pending", check_after_secs: 1 } } });
      const st = path.match(/command=STATUS&media_id=(\d+)/);
      if (st) {
        const k = status.get(st[1]) ?? 0;
        status.set(st[1], k + 1);
        const state = x.processing[Math.min(k, x.processing.length - 1)];
        return send(200, { data: { id: st[1], processing_info: { state, ...(state === "succeeded" ? {} : { check_after_secs: 1 }) } } });
      }
    }
    if (path === "/v1/responses") return send(200, llm.xai(body));
    // OpenRouter (OPENROUTER_API_BASE = this server): Claude on the Messages endpoint, Grok on chat completions, both
    // answered by the same handlers as if the pinned provider served them (tests override `provider` to mismatch it)
    if (path === "/v1/messages") return send(200, { provider: "Anthropic", ...llm.anthropic(body) });
    if (path === "/v1/chat/completions" && body.provider?.order?.[0] === "xai") return send(200, toChat(llm.xai(body), body));
    if (path === "/2/oauth2/token" && x.tokenStatus !== 200) return send(x.tokenStatus, { error: "invalid_request" });
    if (path === "/2/oauth2/token") return send(200, { token_type: "bearer", access_token: "fake-access", refresh_token: `fake-refresh-${calls.length}`, expires_in: 7200, scope: "tweet.read tweet.write users.read offline.access media.write" });
    if (path === "/2/users/me") return send(200, { data: { id: "42", name: "fake", username: "fake_account" } });
    if (/^\/2\/users\/\w+\/mentions/.test(path)) {
      // a mention may carry `user` (profile overrides); by default its author passes the idea gate (badge, age, followers)
      // and the post @mentions the account (user 42), unless it brings its own `entities`
      const data = mentions.splice(0);
      const users = data.map(({ author_id, user }) => ({ id: author_id, username: `user${author_id}`, name: "x", created_at: "2020-01-01T00:00:00.000Z", public_metrics: { followers_count: 1000 }, verified: true, verified_type: "blue", ...(user ?? {}) }));
      return send(200, data.length ? { data: data.map(({ user: _, ...m }) => ({ entities: { mentions: [{ start: 0, end: 13, username: "fake_account", id: "42" }] }, ...m })), includes: { users }, meta: { newest_id: data[0].id, result_count: data.length } } : { meta: { result_count: 0 } });
    }
    if (path.startsWith("/2/tweets/search/recent")) {
      const q = new URL(path, "http://x").searchParams;
      const conv = q.get("query")?.match(/^conversation_id:(\d+)$/)?.[1], since = BigInt(q.get("since_id") ?? 0);
      const data = x.search.filter((p) => p.conversation_id === conv && BigInt(p.id) > since);
      return send(200, { data: data.map(({ user: _, ...p }) => p), includes: { users: data.map((p) => ({ id: p.author_id, ...p.user })) }, meta: { result_count: data.length, ...(data.length ? { newest_id: data[0].id } : {}) } });
    }
    if (path === "/2/tweets" && req.method === "POST" && x.tweetStatus !== 201) return send(x.tweetStatus, { title: "fake failure" });
    if (path === "/2/tweets" && req.method === "POST") {
      const id = String(++tweetId), parent = body.reply?.in_reply_to_tweet_id;
      // X returns text with &, < and > HTML-escaped
      // mediaLink: X appends a t.co link to the media to the text of a post with media ("" = not appended)
      const link = body.media?.media_ids && x.mediaLink ? ` ${x.mediaLink}` : "";
      tweets.set(id, { id, text: String(body.text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + link, author_id: "42", conversation_id: parent ? (tweets.get(parent)?.conversation_id ?? parent) : id,
        ...(parent ? { referenced_tweets: [{ type: "replied_to", id: parent }] } : {}), ...(body.media?.media_ids ? { attachments: { media_keys: body.media.media_ids.map((m: string) => `3_${m}`) } } : {}) });
      // acceptThenFail: X created the post but the caller sees an error (a 5xx after the write)
      return x.acceptThenFail ? send(503, { title: "fake: created, then failed" }) : send(201, { data: { id, text: body.text, edit_history_tweet_ids: [id] } });
    }
    if (/^\/2\/users\/\w+\/tweets/.test(path)) { // the account's own posts, newest first
      if (x.listStatus !== 200) return send(x.listStatus, { title: "fake: listing refused" });
      const max = Number(new URL(path, "http://x").searchParams.get("max_results") ?? 10);
      return send(200, { data: [...tweets.values()].reverse().slice(0, max), meta: { result_count: Math.min(tweets.size, max) } });
    }
    const tw = path.match(/^\/2\/tweets\/(\d+)(\?|$)/);
    if (tw && req.method === "DELETE") {
      await new Promise((r) => setTimeout(r, x.deleteDelayMs));
      if (x.deleteStatus !== 200) return send(x.deleteStatus, { title: "fake delete failure" });
      return send(200, { data: { deleted: tweets.delete(tw[1]) } });
    }
    if (tw && req.method === "GET") return tweets.has(tw[1]) ? send(200, { data: tweets.get(tw[1]) }) : send(200, { errors: [{ title: "Not Found Error", resource_id: tw[1] }] });
    if (path === "/rpc") {
      const one = (r: Json) => (rpc[r.method] ? { jsonrpc: "2.0", id: r.id, result: rpc[r.method](r.params ?? []) } : { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `fake: no ${r.method}` } });
      try {
        return send(200, Array.isArray(body) ? body.map(one) : one(body));
      } catch (e) {
        return send(200, { jsonrpc: "2.0", id: body.id, error: { code: (e as { code?: number }).code ?? 3, message: (e as Error).message, data: (e as { data?: string }).data ?? "0x" } });
      }
    }
    send(404, { error: `fake: no route ${path}` });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, tgUpdates, mentions, tweets, rpc, llm, x, openai, close: () => new Promise((r) => server.close(r)) };
}

/** eth_feeHistory for the JSON-RPC stub: params [blockCount, tag, percentiles]; every block half full at `baseFee`,
 *  every percentile's reward `tip` (0 by default: the quote's floor applies). */
export const feeHistory = ([count, , pcts]: Json[], baseFee: bigint, tip = 0n) => {
  const n = Number(count), hex = (x: bigint) => `0x${x.toString(16)}`;
  return { oldestBlock: "0x1", baseFeePerGas: Array(n + 1).fill(hex(baseFee)), gasUsedRatio: Array(n).fill(0.5), reward: Array(n).fill((pcts as number[]).map(() => hex(tip))) };
};

/** An xAI Responses-shaped answer as OpenRouter's chat completion for the requested Grok slug, served by xAI. */
function toChat(x: Json, body: Json): Json {
  const text = x.output?.find((o: Json) => o.type === "message")?.content?.find((c: Json) => c.type === "output_text")?.text;
  return {
    provider: x.provider ?? "xAI", model: body.model, object: "chat.completion",
    choices: [{ index: 0, finish_reason: typeof text === "string" ? "stop" : "error", message: { role: "assistant", content: text ?? null } }],
    usage: { prompt_tokens: x.usage?.input_tokens ?? 0, completion_tokens: x.usage?.output_tokens ?? 0, ...(x.usage?.cost_in_usd_ticks ? { cost: x.usage.cost_in_usd_ticks / 1e10 } : {}) },
  };
}

/** A deterministic PNG of `size` ("WxH"): soft glowing discs placed and coloured from sha256(seed), no text. */
export function fakePng(seed: string, size = "1536x864") {
  const [w, h] = size.split("x").map(Number);
  const b = createHash("sha256").update(seed).digest();
  const discs = Array.from({ length: 12 }, (_, i) => `<circle cx="${(b[i] / 255) * w}" cy="${(b[(i + 12) % 32] / 255) * h}" r="${30 + (b[(i + 5) % 32] / 255) * h * 0.4}" fill="rgb(${b[(i + 1) % 32]},${b[(i + 2) % 32]},${b[(i + 3) % 32]})" fill-opacity="0.55"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="rgb(${b[30] % 40},${b[31] % 40},${b[29] % 40})"/>${discs}</svg>`;
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "original" } }).render().asPng());
}

