// src/http.ts: a POST bounded only by its own deadline (Node's fetch stops at 300 s without headers or body bytes), and
// the page check's POST going through it. Against local servers. SLOW_HTTP=1 adds the 310 s run next to fetch.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { post } from "../src/http.ts";
import { PAGES, PAGES_DEPS } from "../src/pages.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function serve(handle: (req: IncomingMessage, body: string, res: ServerResponse) => Promise<void>) {
  const s = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    await handle(req, body, res);
  }).listen(0, "127.0.0.1");
  await once(s, "listening");
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => { s.close(); s.closeAllConnections(); } };
}

test("no limit of its own: headers after 5.5 s and a pause in the body still arrive", async () => {
  const s = await serve(async (req, body, res) => {
    await sleep(5_500);
    res.writeHead(201, { "content-type": "application/json", "x-request-id": "r1" });
    res.write(`{"echo":${body},`);
    await sleep(500);
    res.end(`"type":"${req.headers["content-type"]}"}`);
  });
  try {
    const r = await post(`${s.url}/x`, JSON.stringify({ a: 1 }), 10_000, { "content-type": "application/json" });
    assert.deepEqual([r.status, r.ok, r.headers.get("x-request-id")], [201, true, "r1"]);
    assert.deepEqual(await r.json(), { echo: { a: 1 }, type: "application/json" });
  } finally {
    s.close();
  }
});

test("the deadline holds for the wait and for the body; failures read as fetch's; a form goes as multipart", async () => {
  const s = await serve(async (req, body, res) => {
    if (req.url === "/hang") return;
    if (req.url === "/drip") { res.writeHead(200); res.write("{"); return; }
    res.writeHead(400, { "content-type": req.headers["content-type"] ?? "" }).end(body);
  });
  try {
    for (const path of ["/hang", "/drip"]) {
      const t = Date.now();
      await assert.rejects(post(`${s.url}${path}`, "{}", 300), { name: "TimeoutError" }, path);
      assert.ok(Date.now() - t < 2_000, path);
    }
    const form = new FormData();
    form.set("model", "m");
    form.append("image[]", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "ref-0.png");
    const r = await post(`${s.url}/form`, form, 5_000, { authorization: "Bearer k" });
    assert.equal(r.status, 400, "any status resolves");
    const back = await new Response(await r.arrayBuffer(), { headers: { "content-type": r.headers.get("content-type")! } }).formData();
    assert.equal(back.get("model"), "m");
    assert.equal((back.get("image[]") as File).size, 3);
  } finally {
    s.close();
  }
  await assert.rejects(post(`${s.url}/x`, "{}", 1_000), (e: Error) => e.name === "TypeError" && e.message === "fetch failed" && (e.cause as { code?: string }).code === "ECONNREFUSED");
});

test("a status that forbids a body resolves with none, even when the server wrongly sends bytes (205)", async () => {
  const s = await serve(async (req, _body, res) => {
    const [status, bytes] = req.url!.slice(1).split("/");
    res.writeHead(Number(status), { "x-status": status }).end(bytes ?? "");
  });
  try {
    for (const path of ["205/oops", "205", "204", "304"]) {
      const r = await post(`${s.url}/${path}`, "{}", 5_000);
      assert.deepEqual([r.status, r.headers.get("x-status"), r.body, await r.text()], [Number(path.split("/")[0]), path.split("/")[0], null, ""], path);
    }
  } finally {
    s.close();
  }
});

test("the page check's POST goes through it, not fetch; the answer is parsed", async () => {
  const seen: { type?: string; body: unknown }[] = [];
  const s = await serve(async (req, body, res) => {
    seen.push({ type: req.headers["content-type"], body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, violations: [] }));
  });
  const saved = { service: PAGES.service, fetch: globalThis.fetch };
  PAGES.service = s.url;
  globalThis.fetch = (() => Promise.reject(new Error("fetch used"))) as typeof fetch;
  try {
    assert.deepEqual(await PAGES_DEPS.post({ mode: "site" }, 5_000), { ok: true, violations: [] });
    assert.deepEqual(seen, [{ type: "application/json", body: { mode: "site" } }]);
  } finally {
    PAGES.service = saved.service;
    globalThis.fetch = saved.fetch;
    s.close();
  }
});

test("310 s without headers: fetch fails at its 300 s limit, the helper gets the answer", { skip: !process.env.SLOW_HTTP, timeout: 400_000 }, async () => {
  const s = await serve(async (_req, _body, res) => { await sleep(310_000); res.end("done"); });
  try {
    const t = Date.now();
    const [viaFetch, viaPost] = await Promise.allSettled([
      fetch(`${s.url}/f`, { method: "POST", body: "{}", signal: AbortSignal.timeout(400_000) }).then((r) => r.text()),
      post(`${s.url}/p`, "{}", 400_000).then((r) => r.text()),
    ]);
    console.log(`fetch: ${viaFetch.status === "rejected" ? `${(viaFetch.reason as Error).message} (${((viaFetch.reason as Error).cause as { code?: string })?.code})` : "answered"}; post: ${viaPost.status === "fulfilled" ? viaPost.value : "failed"} after ${Math.round((Date.now() - t) / 1000)} s`);
    assert.equal(viaFetch.status, "rejected");
    assert.deepEqual(viaPost, { status: "fulfilled", value: "done" });
  } finally {
    s.close();
  }
});
