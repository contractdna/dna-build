// Maintenance mode (SITE_MAINTENANCE=1): proxy.ts in process, then the built server (when a build exists: CI runs this
// file again after `npm run build`). Everything gets the 503 page except the paths that stay up; /token.png stays
// byte-identical.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import { NextRequest } from "next/server.js";
import { proxy } from "../proxy.ts";
import { HSTS, maintenanceOn, mainCsp, staysUp } from "../security.ts";

const WEB = new URL("..", import.meta.url).pathname;
const TOKEN = readFileSync(new URL("../public/token.png", import.meta.url));
const DOWN = ["/", "/trade", "/live", "/api/core", "/api/stream", "/api/log", "/g/lastclick", "/token.png.bak", "/_next/data/x.json",
  // a 404 renders the root layout: nothing that falls to it stays up (/icon.png and /apple-icon.png skip the proxy)
  "/robots.txt", "/favicon.ico", "/icon-x", "/apple-icon-x.png", "/no-such-page"];
const UP = ["/token.png", "/api/log/12", "/api/log/seq/ship"];

const withEnv = async (env, f) => {
  const old = { ...process.env };
  Object.assign(process.env, env);
  try { return await f(); } finally { for (const k of Object.keys(env)) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
};
const call = (path, headers = {}) => proxy(new NextRequest(`https://genomedna.xyz${path}`, { headers }));
const passes = (res) => res.headers.get("x-middleware-next") === "1";

test("the switch: only SITE_MAINTENANCE=1", () => {
  assert.equal(maintenanceOn({ SITE_MAINTENANCE: "1" }), true);
  for (const v of [undefined, "", "0", "true", "yes"]) assert.equal(maintenanceOn({ SITE_MAINTENANCE: v }), false, String(v));
  for (const p of [...UP, "/api/health"]) assert.ok(staysUp(p), p);
  for (const p of DOWN) assert.ok(!staysUp(p), p);
});

test("maintenance on: every page, router prefetch and API but the kept paths gets the 503 page", async () => {
  await withEnv({ SITE_MAINTENANCE: "1", SITE_ROLE: "" }, async () => {
    for (const [p, h] of [...DOWN.map((p) => [p, {}]), ["/trade", { "next-router-prefetch": "1", rsc: "1" }]]) {
      const res = call(p, h);
      assert.equal(res.status, 503, p);
      assert.equal(res.headers.get("retry-after"), "600");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("content-security-policy"), mainCsp());
      assert.equal(res.headers.get("strict-transport-security"), HSTS);
      const html = await res.text();
      assert.match(html, /We'll be right back\./);
      assert.match(html, /href="https:\/\/x\.com\/contractdna"/);
      assert.doesNotMatch(html, /<script|launch|0x[0-9a-f]{6}|\d{1,2}:\d{2}|src=|https?:\/\/(?!x\.com\/contractdna")/i, "no script, no other link, no launch words, addresses or times");
    }
    for (const p of UP) assert.ok(passes(call(p)), p);
  });
});

test("maintenance on: /api/health is 200 with a fixed body (the healthcheck passes, says nothing else)", async () => {
  for (const role of ["", "play"]) {
    await withEnv({ SITE_MAINTENANCE: "1", SITE_ROLE: role }, async () => {
      const res = call("/api/health");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match(res.headers.get("content-type"), /^application\/json/);
      assert.equal(await res.text(), '{"ok":true}');
    });
  }
});

test("maintenance on, play origin: the 503 page with the play CSP (fresh nonce)", async () => {
  await withEnv({ SITE_MAINTENANCE: "1", SITE_ROLE: "play" }, async () => {
    const res = call("/g/lastclick");
    assert.equal(res.status, 503);
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'; script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}'/);
    assert.notEqual(res.headers.get("content-security-policy"), call("/g/lastclick").headers.get("content-security-policy"));
  });
});

test("maintenance off: unchanged (main passes through; play keeps its nonce, prefetches pass)", async () => {
  await withEnv({ SITE_MAINTENANCE: "0", SITE_ROLE: "" }, () => {
    for (const p of [...DOWN, ...UP, "/api/health"]) assert.ok(passes(call(p)), p);
  });
  await withEnv({ SITE_ROLE: "play" }, () => {
    const res = call("/g/lastclick");
    assert.ok(passes(res));
    assert.match(res.headers.get("content-security-policy"), /'nonce-/);
    const pre = call("/g/lastclick", { "next-router-prefetch": "1", rsc: "1" });
    assert.ok(passes(pre));
    assert.equal(pre.headers.get("content-security-policy"), null);
  });
});

// the built server: `next start` with and without the flag on one build (no rebuild), real requests
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); }); });
async function serve(env, f) {
  const port = await freePort();
  const child = spawn(process.execPath, [`${WEB}node_modules/next/dist/bin/next`, "start", "-p", String(port)], { cwd: WEB, env: { ...process.env, ...env }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      try { await fetch(`${base}/api/health`); break; } catch { if (i > 150) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
    }
    await f(base);
  } finally { child.kill(); }
}
const built = existsSync(`${WEB}.next/BUILD_ID`);

test("built server, maintenance on: / and /trade 503 with the page; /token.png 200 and byte-identical", { skip: !built && "no build" }, async () => {
  await serve({ SITE_MAINTENANCE: "1", SITE_ROLE: "" }, async (base) => {
    for (const p of ["/", "/trade"]) {
      const res = await fetch(base + p);
      assert.equal(res.status, 503, p);
      assert.equal(res.headers.get("retry-after"), "600");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("content-security-policy"), mainCsp());
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.match(await res.text(), /We'll be right back\./);
    }
    const tok = await fetch(`${base}/token.png`);
    assert.equal(tok.status, 200);
    assert.equal(tok.headers.get("content-type"), "image/png");
    assert.equal(tok.headers.get("access-control-allow-origin"), "*"); // launchpads and wallets may fetch it cross-origin
    assert.ok(Buffer.from(await tok.arrayBuffer()).equals(TOKEN), "same bytes as public/token.png");
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), '{"ok":true}');
    assert.equal((await fetch(`${base}/icon.png`)).status, 200);
    for (const p of ["/robots.txt", "/favicon.ico", "/no-such-page"]) assert.equal((await fetch(base + p)).status, 503, p);
  });
});

test("built server, maintenance off: / and /trade render, /token.png the same bytes", { skip: !built && "no build" }, async () => {
  await serve({ SITE_MAINTENANCE: "", SITE_ROLE: "" }, async (base) => {
    for (const p of ["/", "/trade"]) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
      assert.doesNotMatch(await res.text(), /We'll be right back\./);
    }
    assert.ok(Buffer.from(await (await fetch(`${base}/token.png`)).arrayBuffer()).equals(TOKEN));
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { live: false, commit: null });
  });
});
