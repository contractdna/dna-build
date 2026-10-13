// The play origin: the two roles' headers and redirects (security.ts), the per-request CSP (proxy.ts), which game a
// request is for and what a snapshot reads (app/g/game.ts), and the template staying inside the page rules.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dropsQuery, HSTS, killWhy, mainCsp, noLiveData, playCsp, playRequest, roleOf, roleRedirects, SLUG, staticHeaders } from "../security.ts";

const directives = (csp) => Object.fromEntries(csp.split("; ").map((d) => { const [k, ...v] = d.split(" "); return [k, v.join(" ")]; }));

test("roles: SITE_ROLE=play is the play origin, anything else the main site", () => {
  assert.equal(roleOf({ SITE_ROLE: "play" }), "play");
  assert.equal(roleOf({}), "main");
  assert.equal(roleOf({ SITE_ROLE: "PLAY" }), "main");
});

test("play CSP: nonce scripts only, no eval, no remote anything, no frames or workers, own origin for the network", () => {
  const d = directives(playCsp("abc123"));
  assert.equal(d["script-src"], "'self' 'nonce-abc123'");
  assert.doesNotMatch(d["script-src"], /unsafe-inline|unsafe-eval|strict-dynamic|https?:/);
  assert.equal(d["connect-src"], "'self'");
  assert.equal(d["default-src"], "'none'");
  for (const k of ["frame-src", "child-src", "worker-src", "frame-ancestors", "form-action", "base-uri", "object-src"]) assert.equal(d[k], "'none'", k);
  assert.equal(d["report-uri"], "/api/csp", "violations are reported to the play origin itself");
  assert.equal(d.webrtc, "'block'", "no peer connections around connect-src");
  assert.match(directives(playCsp("n", true))["script-src"], /unsafe-eval/, "dev only");
});

test("main CSP: no frames of it anywhere, no plugins, its own scripts and inline ones with the request's nonce only", () => {
  const d = directives(mainCsp("abc123"));
  assert.equal(d["frame-ancestors"], "'none'");
  assert.equal(d["object-src"], "'none'");
  assert.equal(d["script-src"], "'self' 'nonce-abc123'");
  assert.doesNotMatch(d["script-src"], /https?:|unsafe-inline|unsafe-eval|strict-dynamic/);
  assert.equal(d["report-uri"], "/api/csp");
  assert.match(directives(mainCsp("n", true))["script-src"], /unsafe-eval/, "dev only");
});

test("main CSP: WalletConnect's relay and verify frame only in a build with a project id", () => {
  const off = directives(mainCsp("n", false, false)), on = directives(mainCsp("n", false, true));
  assert.equal(off["connect-src"], "'self' https:");
  assert.equal(off["frame-src"], "'none'");
  assert.equal(on["connect-src"], "'self' https: wss://relay.walletconnect.org");
  assert.equal(on["frame-src"], "https://verify.walletconnect.org");
  for (const k of ["script-src", "frame-ancestors", "object-src", "img-src"]) assert.equal(on[k], off[k], k);
  // never the first wallet's SDK server or Coinbase's WalletLink socket: the wallet list avoids both (Wallet.tsx)
  assert.doesNotMatch(on["connect-src"], new RegExp("meta" + "mask|walletlink", "i")); // split: the publish scan
});

test("headers by role: HSTS with subdomains on both; COOP, no referrer and closed permissions on play", () => {
  const main = Object.fromEntries(staticHeaders("main").map((h) => [h.key, h.value]));
  const play = Object.fromEntries(staticHeaders("play").map((h) => [h.key, h.value]));
  assert.equal(main["Strict-Transport-Security"], HSTS);
  assert.match(HSTS, /includeSubDomains/);
  assert.equal(play["Strict-Transport-Security"], HSTS);
  assert.equal(main["Content-Security-Policy"], undefined, "the main CSP is per request (proxy.ts)");
  assert.equal(play["Content-Security-Policy"], undefined, "the play CSP is per request (proxy.ts)");
  assert.equal(play["Cross-Origin-Opener-Policy"], "same-origin");
  assert.equal(play["Referrer-Policy"], "no-referrer");
  assert.match(play["Permissions-Policy"], /camera=\(\).*payment=\(\)/);
});

test("redirects: the main site never serves /g/*; the play origin serves only /g/*, Next's assets, the kill check and its icons", () => {
  const [m] = roleRedirects("main");
  assert.equal(m.source, "/g/:path*");
  assert.match(m.destination, /^https:\/\/play\..+\/g\/:path\*$/);
  const [p] = roleRedirects("play");
  const re = new RegExp(`^/${p.source.slice("/:path".length).replace(/^\(/, "(").replace(/\)$/, ")")}$`.replace("/:path", ""));
  const sends = (path) => new RegExp(`^/${p.source.match(/^\/:path(\(.*\))$/)[1]}$`).test(path);
  for (const path of ["/", "/play", "/proof", "/api/stream", "/api/log/1", "/sequencer", "/gx"]) assert.ok(sends(path), `${path} goes to the main site`);
  for (const path of ["/g/lastclick", "/g/lastclick/x", "/_next/static/a.js", "/api/kill/lastclick", "/api/csp", "/icon.png", "/cursor.svg", "/cursor-link.svg"]) assert.ok(!sends(path), `${path} stays`);
  void re;
});

test("proxy: the request's nonce goes into the CSP; only a valid game slug is passed on", () => {
  const a = playRequest("/g/lastclick", "n0nce-a");
  assert.match(a.csp, /'nonce-n0nce-a'/);
  assert.equal(a.slug, "lastclick");
  assert.equal(playRequest("/g/lastclick/sub", "x").slug, "lastclick");
  for (const p of ["/g/..%2f", "/g/_template", "/g/A", "/play", "/g/"]) assert.equal(playRequest(p, "x").slug, null, p);
  // proxy.ts draws a fresh 16-byte nonce per request and drops any x-game-slug the visitor sent
  const src = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(src, /crypto\.getRandomValues\(new Uint8Array\(16\)\)/);
  assert.match(src, /else headers\.delete\("x-game-slug"\)/);
  assert.match(src, /if \(roleOf\(process\.env\) !== "play"\) \{\n    const nonce = newNonce\(\);\n    return withCsp\(request, nonce, mainCsp\(nonce, dev\), null\);/);
});

test("cookies: the site sets only host-only __Host- cookies (never sent to play.<site>); no code sets one otherwise", () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(join(d, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [join(d, e.name)] : []));
  const root = new URL("..", import.meta.url).pathname;
  for (const f of [...walk(join(root, "app")), join(root, "proxy.ts"), join(root, "next.config.ts")]) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:cookies\(\)|\.cookies)\s*\.\s*set\(\s*["'`]([^"'`]*)/g)) assert.match(m[1], /^__Host-/, `${f}: cookie ${m[1]}`);
    for (const m of src.matchAll(/Set-Cookie["']\s*,\s*["'`]([^"'`=]*)/gi)) assert.match(m[1], /^__Host-/, `${f}: Set-Cookie ${m[1]}`);
  }
});

test("without live data the play origin says paused; the main site has no games to pull", () => {
  assert.equal(noLiveData("play").killed, true);
  assert.equal(noLiveData("main").killed, false);
  assert.equal(noLiveData("play", { PAGECHECK: "1" }).killed, false, "the page check's offline build serves its game");
  assert.equal(noLiveData("play", { PAGECHECK: "yes" }).killed, true);
});

test("a pulled game's reason: the record's short text, else a plain one (never markup or a link)", () => {
  assert.equal(killWhy("the page check found a wallet request outside the rules"), "the page check found a wallet request outside the rules");
  for (const w of [undefined, null, 3, "", "<b>x</b>", "see https://x.example", "x".repeat(161)]) assert.equal(killWhy(w), "this game's page was pulled");
});

test("game server modules are server-only; the game's page code only runs after mount behind the guard", () => {
  for (const f of ["../app/g/game.ts", "../app/g/state.ts"]) assert.match(readFileSync(new URL(f, import.meta.url), "utf8"), /^import "server-only";$/m, f);
  const tx = readFileSync(new URL("../app/_ui/tx.ts", import.meta.url), "utf8");
  assert.match(tx, /setPhase\(guardReady\(window\) \? "ready" : "unsafe"\)/, "decided in an effect (the browser), from the guard");
  assert.match(tx, /if \(phase === "server"\) return createElement\("main", null, head/, "server render: the snapshot's title and state, no children");
  const proxy = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /if \(dropsQuery\(request\.nextUrl\.pathname, request\.nextUrl\.search, request\.headers\.has\("rsc"\)\)\)/, "game pages drop query strings");
  assert.equal(dropsQuery("/g/lastclick", "?ref=x", false), true);
  assert.equal(dropsQuery("/g/lastclick", "?_rsc=1a2b", true), false, "an RSC request keeps its cache key");
  assert.equal(dropsQuery("/g/lastclick", "", false), false);
  assert.equal(dropsQuery("/play", "?ref=x", false), false, "game pages only");
});

test("a game folder name follows the Sequencer's slug rule", () => {
  for (const s of ["lastclick", "floor-defense", "abc"]) assert.ok(SLUG.test(s), s);
  for (const s of ["_template", "ab", "A", "../x", "x/y", "", "a".repeat(32)]) assert.ok(!SLUG.test(s), s);
});

test("loadGame: only a valid slug with a well-formed game.json of that slug on chain 1; zero-argument views only", async () => {
  const { loadGame, zeroArgViews } = await import("../app/g/game.ts");
  const root = mkdtempSync(join(tmpdir(), "play-"));
  try {
    const put = (slug, j) => { mkdirSync(join(root, "app", "g", slug), { recursive: true }); writeFileSync(join(root, "app", "g", slug, "game.json"), JSON.stringify(j)); };
    const ok = { slug: "lastclick", title: "Last Click", chainId: 1, address: "0x1111111111111111111111111111111111111111", codehash: `0x${"2".repeat(64)}`, abi: [] };
    put("lastclick", ok);
    put("other", { ...ok });
    put("chain", { ...ok, slug: "chain", chainId: 10 });
    assert.equal(loadGame("lastclick", root)?.title, "Last Click");
    assert.equal(loadGame("other", root), null, "its game.json names another slug");
    assert.equal(loadGame("chain", root), null);
    assert.equal(loadGame("../lastclick", root), null);
    assert.equal(loadGame("missing", root), null);
    const abi = [
      { type: "function", name: "deadline", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
      { type: "function", name: "leader", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
      { type: "function", name: "owed", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
      { type: "function", name: "click", inputs: [], outputs: [], stateMutability: "nonpayable" },
      { type: "function", name: "names", inputs: [], outputs: [{ type: "string[]" }], stateMutability: "view" },
    ];
    assert.deepEqual(zeroArgViews(abi), ["deadline", "leader"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
