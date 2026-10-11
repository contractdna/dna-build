// The play origin's wallet guard (app/_ui/guard.ts) against a stand-in window: what a game page can and can't reach.
// The same guard runs in a real browser in the enclave's page check (every frame, real Chromium).
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { ALIASES, guard, guardReady, guardScript, guardStop, IS_GAME } from "../app/_ui/guard.ts";

const GAME = "0x1111111111111111111111111111111111111111";
const FACTORY = "0x2222222222222222222222222222222222222222";
const CLICK = "0x7d55923d";
const cfg = { slug: "g", address: GAME, factory: FACTORY, selectors: [CLICK], chainId: "0x1", killUrl: "/api/kill/g" };

/** A wallet that records what reaches it. */
function wallet({ chain = "0x1", isGame = true } = {}) {
  const seen = [];
  return {
    seen,
    request: async ({ method, params }) => {
      seen.push({ method, params });
      if (method === "eth_chainId") return chain;
      if (method === "eth_requestAccounts" || method === "eth_accounts") return ["0x3333333333333333333333333333333333333333"];
      if (method === "eth_call") return params[0].data.startsWith(IS_GAME) ? `0x${(isGame ? "1" : "0").padStart(64, "0")}` : "0x";
      if (method === "eth_sendTransaction") return `0x${"ab".repeat(32)}`;
      return null;
    },
  };
}
/** A stand-in window (an EventTarget with the globals the guard captures). `net` can be changed between polls; the
 *  60 s poll is `w.poll()`. */
function win({ raw = wallet(), kill = { killed: false }, down = false, extra = {} } = {}) {
  const w = new EventTarget();
  const net = { kill, down };
  Object.assign(w, { Event, EventTarget, CustomEvent, Response, setInterval: (fn) => { w.poll = fn; return 0; }, ethereum: raw, net, ...extra });
  w.fetch = async () => { if (net.down) throw new Error("down"); return new Response(JSON.stringify(net.kill)); };
  return w;
}
const run = (w, c = cfg) => guard({ ...c, isGame: IS_GAME, aliases: ALIASES }, w);
const tick = () => new Promise((r) => setTimeout(r, 0));
const req = (w, method, params = []) => w.ethereum.request({ method, params });
const tx = (over = {}) => ({ from: "0x3333333333333333333333333333333333333333", to: GAME, data: CLICK, value: "0x0", ...over });

test("a page module's top-level code sees only the guarded provider; aliases and look-alikes are gone; nothing can be redefined", () => {
  const raw = wallet();
  const w = win({ raw, extra: { rabby: raw, okxwallet: raw, someNewWallet: raw, wrapper: { ethereum: raw }, plain: { x: 1 } } });
  run(w);
  // what a game module's top-level code would read first
  const seen = { ethereum: w.ethereum, rabby: w.rabby, okx: w.okxwallet, other: w.someNewWallet, wrapper: w.wrapper, plain: w.plain };
  assert.equal(seen.ethereum.isDNAGuard, true);
  assert.notEqual(seen.ethereum, raw);
  assert.deepEqual([seen.rabby, seen.okx, seen.other, seen.wrapper], [undefined, undefined, undefined, undefined]);
  assert.deepEqual(seen.plain, { x: 1 }, "objects that are not wallets are left alone");
  assert.throws(() => { "use strict"; w.ethereum = raw; }, TypeError);
  assert.throws(() => Object.defineProperty(w, "ethereum", { value: raw }), TypeError);
  assert.throws(() => Object.defineProperty(w, "rabby", { value: raw }), TypeError);
  assert.equal(Object.isFrozen(w.ethereum), true);
  assert.equal(Object.isFrozen(w.ethereum.request), true);
  assert.equal(w.__dnaGuard.ok, true);
});

test("the window's own references to itself are windows, not wallet look-alikes (a real wallet's window.ethereum)", () => {
  const raw = wallet();
  const w = win({ raw });
  for (const n of ["window", "self", "globalThis", "frames", "top", "parent"]) Object.defineProperty(w, n, { value: w, configurable: true, writable: true });
  run(w);
  assert.equal(w.__dnaGuard.ok, true);
  for (const n of ["window", "self", "globalThis", "frames", "top", "parent"]) assert.equal(w[n], w, n);
  assert.equal(w.globalThis.ethereum.isDNAGuard, true);
});

test("planted: a wallet-shaped object that names itself as its own window is still a look-alike, and hidden", () => {
  const raw = wallet();
  const odd = { request: async () => "0x1" };
  odd.window = odd;
  const w = win({ raw, extra: { oddWallet: odd } });
  Object.defineProperty(w, "window", { value: w, configurable: true, writable: true });
  run(w);
  assert.equal(w.__dnaGuard.ok, true);
  assert.equal(w.oddWallet, undefined);
  assert.throws(() => Object.defineProperty(w, "oddWallet", { value: odd }), TypeError);
  assert.equal(w.window, w, "the real self-reference stays");
});

test("reads pass; every signing method, other targets and other methods are refused", async () => {
  const raw = wallet();
  const w = win({ raw });
  run(w);
  assert.equal(await req(w, "eth_chainId"), "0x1");
  assert.ok(await req(w, "eth_call", [{ to: GAME, data: "0x12345678" }, "latest"]) !== undefined);
  for (const m of ["eth_sign", "personal_sign", "eth_signTypedData", "eth_signTypedData_v4", "wallet_addEthereumChain", "wallet_switchEthereumChain", "wallet_watchAsset", "eth_signTransaction", "eth_sendRawTransaction", "wallet_requestPermissions"]) {
    await assert.rejects(req(w, m, ["0x00"]), (e) => e.code === 4200, m);
  }
  await assert.rejects(req(w, "eth_call", [{ to: "0x4444444444444444444444444444444444444444", data: "0x" }]), /only to the game/);
  await assert.rejects(req(w, "eth_getCode", ["0x4444444444444444444444444444444444444444"]), /only of the game/);
  assert.ok(!raw.seen.some((s) => /sign|wallet_/.test(s.method)), "nothing that signs reached the wallet");
});

test("a transaction goes through only to the game, with value 0 and one of its functions, after chain and isGame checks", async () => {
  const raw = wallet();
  const w = win({ raw });
  run(w);
  await assert.rejects(req(w, "eth_sendTransaction", [tx({ to: "0x4444444444444444444444444444444444444444" })]), /only to this game/);
  await assert.rejects(req(w, "eth_sendTransaction", [tx({ value: "0x1" })]), /no deposits/);
  await assert.rejects(req(w, "eth_sendTransaction", [tx({ data: "0x095ea7b3" + "00".repeat(64) })]), /not one of this game's functions/, "approve");
  await assert.rejects(req(w, "eth_sendTransaction", [tx({ nonce: "0x1" })]), /unexpected field/);
  assert.equal(raw.seen.filter((s) => s.method === "eth_sendTransaction").length, 0);
  assert.equal(await req(w, "eth_sendTransaction", [tx()]), `0x${"ab".repeat(32)}`);
  const sent = raw.seen.filter((s) => s.method === "eth_sendTransaction");
  assert.deepEqual(sent.map((s) => s.params[0]), [{ from: "0x3333333333333333333333333333333333333333", to: GAME, data: CLICK, value: "0x0" }]);
  const order = raw.seen.map((s) => s.method);
  assert.deepEqual(order.slice(order.lastIndexOf("eth_chainId")), ["eth_chainId", "eth_call", "eth_sendTransaction"]);
});

test("planted: the wrong chain or an address the factory doesn't list stops the transaction", async () => {
  const w1 = win({ raw: wallet({ chain: "0xa" }) });
  run(w1);
  await assert.rejects(req(w1, "eth_sendTransaction", [tx()]), /mainnet/);
  const w2 = win({ raw: wallet({ isGame: false }) });
  run(w2);
  await assert.rejects(req(w2, "eth_sendTransaction", [tx()]), /not a DNA game/);
});

test("kill: a pulled game, or a kill check that can't be reached, refuses everything and tells the page to unmount", async () => {
  for (const opt of [{ kill: { killed: true, why: "pulled" } }, { down: true }, { kill: { nothing: 1 } }]) {
    const raw = wallet();
    const w = win({ raw, ...opt });
    let told = null;
    w.addEventListener("dna:killed", (e) => { told = e.detail.why; });
    run(w);
    await tick();
    await tick();
    assert.ok(told, JSON.stringify(opt));
    await assert.rejects(req(w, "eth_chainId"), /paused/);
    await assert.rejects(req(w, "eth_sendTransaction", [tx()]), /paused/);
    assert.equal(raw.seen.filter((s) => s.method === "eth_sendTransaction").length, 0);
  }
});

test("kill stickiness: a pause from an unreachable check lifts on a clean answer; a real pull never does", async () => {
  const raw = wallet();
  const w = win({ raw, down: true });
  const events = [];
  w.addEventListener("dna:killed", (e) => events.push(["killed", e.detail.pulled]));
  w.addEventListener("dna:resumed", () => events.push(["resumed"]));
  run(w);
  await tick(); await tick();
  await assert.rejects(req(w, "eth_chainId"), /paused/);
  w.net.down = false;
  w.poll(); await tick(); await tick();
  assert.equal(await req(w, "eth_chainId"), "0x1", "back after a clean answer");
  w.net.kill = { killed: true, why: "pulled by the engine" };
  w.poll(); await tick(); await tick();
  await assert.rejects(req(w, "eth_chainId"), /paused/);
  w.net.kill = { killed: false };
  w.poll(); await tick(); await tick();
  await assert.rejects(req(w, "eth_chainId"), /paused/, "a real pull stays");
  assert.deepEqual(events, [["killed", false], ["resumed"], ["killed", true]]);
});

test("a page that mounts after the kill event still sees the pull or pause (window.__dnaGuard.stop)", async () => {
  const w = win({ down: true });
  run(w);
  assert.equal(guardStop(w), null, "nothing yet");
  await tick(); await tick();
  assert.deepEqual(guardStop(w), { why: "the game's status can't be checked right now; it comes back once it can", pulled: false });
  w.net.down = false;
  w.poll(); await tick(); await tick();
  assert.equal(guardStop(w), null, "a pause lifts");
  w.net.kill = { killed: true, why: "pulled by the engine" };
  w.poll(); await tick(); await tick();
  assert.deepEqual(guardStop(w), { why: "pulled by the engine", pulled: true });
  assert.throws(() => { "use strict"; w.__dnaGuard.stop = null; }, TypeError, "read-only");
  assert.ok(Object.isFrozen(w.__dnaGuard));
  assert.equal(guardStop(undefined), null);
});

test("GameRoot's gate: the game mounts only behind a working guard", () => {
  const w = win();
  assert.equal(guardReady(w), false, "no guard yet");
  run(w);
  assert.equal(guardReady(w), true);
  const nc = win({ raw: undefined });
  Object.defineProperty(nc, "ethereum", { value: wallet(), configurable: false, writable: false });
  run(nc);
  assert.equal(guardReady(nc), false, "a wallet that couldn't be wrapped: the game is not loaded");
  assert.equal(guardReady(undefined), false);
});

test("EIP-6963: wallet announcements never reach game code; a request for providers gets the guarded one only", async () => {
  const raw = wallet();
  const w = win({ raw: undefined });
  run(w);
  const got = [];
  w.addEventListener("eip6963:announceProvider", (e) => got.push(e.detail.provider));
  w.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { name: "w" }, provider: raw } }));
  assert.deepEqual(got, [], "the raw announcement was stopped");
  w.dispatchEvent(new Event("eip6963:requestProvider"));
  assert.equal(got.length, 1);
  assert.equal(got[0], w.ethereum);
  assert.equal(await req(w, "eth_chainId"), "0x1", "the announced wallet became the guard's");
});

test("planted: patching primordials after the guard loads changes nothing", async () => {
  const raw = wallet();
  const w = win({ raw, kill: { killed: true } });
  run(w);
  const saved = { stop: Event.prototype.stopImmediatePropagation, then: Promise.prototype.then, json: Response.prototype.json, apply: Reflect.apply };
  try {
    Event.prototype.stopImmediatePropagation = function () {};
    Response.prototype.json = async () => ({ killed: false });
    Reflect.apply = (f, t, a) => saved.apply(f, t, a);
    const got = [];
    w.addEventListener("eip6963:announceProvider", (e) => got.push(e.detail.provider));
    w.dispatchEvent(new Event("eip6963:requestProvider"));
    w.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { provider: raw } }));
    assert.ok(got.every((p) => p !== raw), "the game never gets the raw provider");
    await tick();
    await assert.rejects(req(w, "eth_sendTransaction", [tx()]), /paused/, "the kill is still read with the real Response.json");
  } finally {
    Event.prototype.stopImmediatePropagation = saved.stop;
    Response.prototype.json = saved.json;
    Reflect.apply = saved.apply;
  }
});

test("every refusal is written to the console with the console captured at load (the page check reads it)", async () => {
  const said = [];
  const w = win({ extra: { console: { warn: (m) => said.push(m) } } });
  run(w);
  w.console = { warn: () => {} }; // a page swapping the console later changes nothing
  await assert.rejects(req(w, "personal_sign", ["0x00"]));
  await assert.rejects(req(w, "eth_sendTransaction", [tx({ to: "0x4444444444444444444444444444444444444444" })]));
  await assert.rejects(req(w, "eth_call", [{ to: "0x4444444444444444444444444444444444444444", data: "0x" }]));
  assert.deepEqual(said, [
    "[dna-guard] refused personal_sign: not allowed on this page: personal_sign",
    "[dna-guard] refused eth_sendTransaction: transactions go only to this game",
    "[dna-guard] refused eth_call: eth_call only to the game or the factory",
  ]);
  assert.equal(await req(w, "eth_chainId"), "0x1");
  assert.equal(said.length, 3, "allowed calls say nothing");
});

test("fails closed when a wallet's property can't be redefined", async () => {
  const raw = wallet();
  const w = win({ raw: undefined });
  Object.defineProperty(w, "ethereum", { value: raw, configurable: false, writable: false });
  run(w);
  assert.equal(w.__dnaGuard.ok, false);
  assert.match(w.__dnaGuard.why, /can't use your wallet safely/);
});

test("the inline script is self-contained: it runs in a bare context with only the standard globals", async () => {
  const raw = wallet();
  const w = win({ raw });
  vm.runInNewContext(guardScript(cfg), { window: w, Reflect, Object, JSON, String, Array, Promise, Number });
  assert.equal(w.ethereum.isDNAGuard, true);
  assert.equal(await w.ethereum.request({ method: "eth_chainId" }), "0x1");
  assert.doesNotMatch(guardScript({ ...cfg, slug: "</script><script>alert(1)" }), /<\/script>/, "the config can't close the script tag");
});
