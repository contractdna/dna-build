// Game pages, engine side (src/pages.ts) without a database: the verdict rules, the page's own files, the chain handed
// to the page check (a real game deployed through the real factory, then copied into a fresh chain and dumped: the
// dump must load offline with everything the page reads), and the live bundle (plain fetches of what the play origin
// serves). The records, the ship cancel and the revert run against Postgres in sequencer-db.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { type Abi, type Address, createPublicClient, createWalletClient, decodeFunctionResult, encodeFunctionData, getContractAddress, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import * as abi from "../src/abi.ts";
import { answered, assetPaths, checkSite, copyState, liveBundle, PAGES, PAGES_DEPS, pageFiles, pageGateResult, sitePageGate, siteRoutes, stage, verdictOf, withAnvil } from "../src/pages.ts";
import { compile, workspace } from "../src/seq-forge.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const KIT = join(ROOT, "contracts");
const FIX = new URL("./fixtures/seq/lastclick/", import.meta.url).pathname;
const hasForge = (() => {
  try { execFileSync("forge", ["--version"], { stdio: "ignore" }); execFileSync("anvil", ["--version"], { stdio: "ignore" }); } catch { return false; }
  return existsSync(join(KIT, "lib/forge-std/src/Test.sol"));
})();

test("verdicts: a violation is a kill, a page that does not build is a rework, a clean run passes", () => {
  assert.deepEqual(verdictOf({ ok: true, violations: [] }), { ok: true, kill: false, why: "", violations: [] });
  const k = verdictOf({ ok: false, violations: [{ kind: "network", detail: "navigation to https://x.example/", run: "phone@0" }] });
  assert.equal(k.kill, true);
  assert.match(k.why, /^network: navigation/);
  const b = verdictOf({ ok: false, error: "the page does not build: TS2304" });
  assert.equal(verdictOf({ ok: false, error: "the page did not load in time", violations: [{ kind: "refused", detail: "x", run: "phone@0" }] }).kill, true, "a violation seen before the check stopped still kills");
  assert.equal(verdictOf({ ok: false, error: "the page did not load in time", violations: [] }).kill, false, "a check that did not run is no kill");
  assert.deepEqual([b.ok, b.kill], [false, false]);
  assert.equal(verdictOf({ ok: false }).kill, true, "a failed answer without a reason still fails closed");
  const g = pageGateResult(k);
  assert.deepEqual([g.gate, g.ok, g.kill], ["G15", false, true]);
  assert.match(g.issues[0], /\(phone@0\)$/);
  assert.equal(pageGateResult(b).issues[0], "the page does not build: TS2304");
});

test("a first load that never answered is an outage (pagecheck:), not a verdict; anything else is answered", () => {
  assert.throws(() => answered({ ok: false, error: "the page did not load in time: Timeout 60000ms exceeded" }), /^Error: pagecheck: the page did not load in time/);
  assert.equal(answered({ ok: false, error: "the page does not build: TS2304" }).error, "the page does not build: TS2304");
  assert.equal(answered({ ok: false, error: "the page did not load in time", violations: [{ kind: "refused", detail: "x", run: "a" }] }).violations!.length, 1, "a violation already seen stays a verdict");
});

test("the page's own files: only its folder, no subfolders", () => {
  assert.deepEqual(pageFiles({
    "web/app/g/dice-1/page.tsx": "p", "web/app/g/dice-1/game.json": "{}", "web/app/g/dice-1/x/y.tsx": "no", "web/app/g/other/page.tsx": "no", "contracts/src/games/dice-1/D.sol": "no",
  }, "dice-1"), { "page.tsx": "p", "game.json": "{}" });
});

test("a site change's routes: each changed file's nearest page in the gated tree; groups dropped, a dynamic page's static ancestor instead, docs left out", () => {
  const pages = ["web/app/page.tsx", "web/app/faq/page.tsx", "web/app/(info)/team/page.tsx", "web/app/journal/[day]/page.tsx", "web/app/g/dice-1/page.tsx"];
  assert.deepEqual(siteRoutes(["web/app/faq/page.tsx", "web/app/faq/parts/Answer.tsx", "web/app/(info)/team/Card.tsx", "web/app/journal/[day]/Entry.tsx", "web/app/_ui/ui.tsx", "docs/FAQ.md"], pages), ["/", "/faq", "/team"]);
  assert.deepEqual(siteRoutes(["web/app/journal/[day]/Entry.tsx"], ["web/app/page.tsx", "web/app/journal/page.tsx", "web/app/journal/[day]/page.tsx"]), ["/journal"], "a dynamic page: its static ancestor is opened");
  assert.deepEqual(siteRoutes(["docs/FAQ.md"], pages), []);
  assert.equal(siteRoutes(Array.from({ length: 20 }, (_, i) => `web/app/p${i}/page.tsx`), Array.from({ length: 20 }, (_, i) => `web/app/p${i}/page.tsx`)).length, 10);
});

test("G15 for a site change: the main site's origin, the change's app files and its routes; nothing to run passes", async () => {
  const saved = PAGES_DEPS.post;
  const sent: Record<string, unknown>[] = [];
  PAGES_DEPS.post = async (body: unknown) => { sent.push(body as Record<string, unknown>); return { ok: true, violations: [] }; };
  try {
    const files = { "web/app/faq/page.tsx": "export default function P() { return null; }", "web/app/faq/Old.tsx": null, "docs/FAQ.md": "# Q" };
    assert.equal((await sitePageGate({ files, pages: ["web/app/faq/page.tsx"] })).ok, true);
    assert.deepEqual(sent[0], { mode: "site", origin: PAGES.siteOrigin, files: { "app/faq/page.tsx": files["web/app/faq/page.tsx"], "app/faq/Old.tsx": null }, routes: ["/faq"], deep: false }, "a removed file goes as null: the check builds without it");
    assert.equal(new URL(PAGES.siteOrigin).host, new URL(PAGES.origin).host.replace(/^play\./, ""));
    assert.deepEqual(await checkSite({ files: { "docs/FAQ.md": "# Q" }, pages: [] }, true), { ok: true, kill: false, why: "", violations: [] });
    assert.equal(sent.length, 1, "a docs-only change has no page to check");
    PAGES_DEPS.post = async () => ({ ok: false, violations: [{ kind: "wallet", detail: "eth_accounts: a site page asks the wallet", run: "/faq desktop@0.5" }] });
    const g = await sitePageGate({ files, pages: ["web/app/faq/page.tsx"] });
    assert.deepEqual([g.gate, g.ok, g.kill], ["G15", false, true]);
  } finally {
    PAGES_DEPS.post = saved;
  }
});

test("asset paths: Next's static files from the page and from chunks (with or without /_next), nothing else", () => {
  const html = `<script src="/_next/static/chunks/a1.js" async></script><link rel="stylesheet" href="/_next/static/css/b2.css"><img src="https://x.example/i.png">`;
  assert.deepEqual(assetPaths(html), ["/_next/static/chunks/a1.js", "/_next/static/css/b2.css"]);
  assert.deepEqual(assetPaths(`e.exports=["static/chunks/c3.js","static/media/f.woff2"];"/_next/static/chunks/../../x.js"`), ["/_next/static/chunks/c3.js", "/_next/static/media/f.woff2"]);
});

test("the live bundle: the page with its live CSP and every chunk it and its chunks name, by plain fetches; a redirect is refused", async () => {
  const site: Record<string, { body: string; type: string; csp?: string; status?: number }> = {
    "/g/dice-1": { body: `<html><script src="/_next/static/chunks/a.js"></script></html>`, type: "text/html; charset=utf-8", csp: "default-src 'none'; script-src 'self' 'nonce-abc'" },
    "/_next/static/chunks/a.js": { body: `load("static/chunks/b.js")`, type: "application/javascript" },
    "/_next/static/chunks/b.js": { body: `/* end */`, type: "application/javascript" },
    "/g/moved": { body: "", type: "text/html", status: 307 },
  };
  const asked: string[] = [];
  const saved = PAGES_DEPS.fetch;
  PAGES_DEPS.fetch = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    asked.push(u.pathname);
    assert.equal(init?.redirect, "manual");
    const f = site[u.pathname];
    return new Response(f?.body ?? "", { status: f ? (f.status ?? 200) : 404, headers: { "content-type": f?.type ?? "text/plain", ...(f?.csp ? { "content-security-policy": f.csp } : {}) } });
  };
  try {
    const b = await liveBundle("dice-1", "https://play.example.xyz");
    assert.deepEqual(Object.keys(b).sort(), ["/_next/static/chunks/a.js", "/_next/static/chunks/b.js", "/g/dice-1"]);
    assert.equal((b["/g/dice-1"] as { csp?: string }).csp, site["/g/dice-1"].csp);
    assert.equal(Buffer.from(b["/_next/static/chunks/b.js"].b64, "base64").toString(), "/* end */");
    await assert.rejects(liveBundle("moved", "https://play.example.xyz"), /answered 307/);
  } finally {
    PAGES_DEPS.fetch = saved;
  }
  assert.equal(PAGES.origin.startsWith("https://play."), true);
});

const lastclick = () => {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out[relative(FIX, p)] = readFileSync(p, "utf8"); } };
  walk(FIX);
  return out;
};

test("the chain handed to the page check: the gated game deployed through the real factory as the Safe, funded, and every slot a page reads copied into a dump that loads offline", { skip: hasForge ? false : "needs forge, anvil and contracts/lib/forge-std" }, async () => {
  const f = lastclick();
  const w = workspace(KIT, f, "lastclick");
  try {
    const cl = await compile(w, f, "lastclick");
    assert.ok(cl.ok, cl.out);
    const art = (file: string, name: string) => cl.artifacts(file).find((a) => a.name === name)!;
    const game = art("LastClick.sol", "LastClick");
    const safe = "0x00000000000000000000000000000000000005af" as Address;
    const salt = keccak256("0x42");
    let factory = "0x" as Address;
    const dump = await withAnvil(undefined, async (url) => {
      const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // anvil #0 (public test key)
      const wallet = createWalletClient({ account, chain: foundry, transport: http(url) });
      const pub = createPublicClient({ chain: foundry, transport: http(url) });
      const deploy = async (a: ReturnType<typeof art>, args: unknown[]) => (await pub.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }) })).contractAddress!;
      const registry = await deploy(art("GameKitConformance.sol", "MockAgentRegistry"), [account.address]);
      factory = await deploy(art("GameFactory.sol", "GameFactory"), [safe, registry]);
      const at = getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode: game.bytecode.object });
      await assert.rejects(stage(url, { factory, safe, game: "0x0000000000000000000000000000000000000001", deploy: { initCode: game.bytecode.object, salt } }), /not the factory's CREATE2 address/);
      return stage(url, { factory, safe, game: at, deploy: { initCode: game.bytecode.object, salt }, gameAbi: game.abi, fundWei: PAGES.fundWei });
    });
    const at = getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode: game.bytecode.object });
    // the check's side: a fresh offline anvil loading the dump
    await withAnvil(undefined, async (url) => {
      const call = async (method: string, params: unknown[]) => ((await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: string }).result;
      assert.equal(await call("anvil_loadState", [dump.state]), true as never);
      assert.notEqual(await call("eth_getCode", [at, "latest"]), "0x", "the game is there");
      const read = async (to: Address, a: Abi, fn: string, args: unknown[] = []) =>
        decodeFunctionResult({ abi: a, functionName: fn, data: await call("eth_call", [{ to, data: encodeFunctionData({ abi: a, functionName: fn, args }) }, "latest"]) as `0x${string}` });
      assert.equal(await read(factory, abi.gameFactoryAbi, "isGame", [at]), true, "the guard's isGame answers yes");
      assert.equal(await read(at, abi.gameKitAbi, "freeBalance"), PAGES.fundWei, "funded");
      assert.equal(await read(at, abi.gameKitAbi, "paused"), false);
      assert.equal(String(await read(at, abi.gameKitAbi, "factory")).toLowerCase(), factory.toLowerCase());
    });
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("copyState copies what the calls read, and the chain carries on from the staging head (number, time, base fee, producer)", { skip: hasForge ? false : "needs anvil" }, async () => {
  const A = "0x00000000000000000000000000000000000ca5e0" as Address;
  const B = "0x00000000000000000000000000000000000ca5e1" as Address;
  const call = async (url: string, method: string, params: unknown[] = []) => ((await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: string }).result;
  // a staging chain at a mainnet-like head (as a fork of mainnet is)
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const g = mkdtempSync(join(tmpdir(), "pages-test-"));
  const ts = Math.floor(Date.now() / 1000) - 12;
  writeFileSync(join(g, "genesis.json"), JSON.stringify({ config: { chainId: 1 }, number: "0x1406f40", timestamp: `0x${ts.toString(16)}`, gasLimit: "0x1c9c380", alloc: {} }));
  const staged = await withAnvil(undefined, async (url) => {
    await call(url, "anvil_setCode", [A, "0x60005460005260206000f3"]); // returns slot 0
    await call(url, "anvil_setStorageAt", [A, "0x0", `0x${"00".repeat(31)}2a`]);
    await call(url, "anvil_setCode", [B, "0x4360005260206000f3"]); // returns block.number
    await call(url, "anvil_setCoinbase", ["0x95222290dd7278aa3ddd389cc1e1d165cc4bafe5"]);
    await call(url, "evm_mine");
    return copyState(url, [{ to: A, data: "0x" }, { to: B, data: "0x" }], []);
  }, ["--init", join(g, "genesis.json"), "--base-fee", "7000000000"]);
  rmSync(g, { recursive: true, force: true });
  assert.equal(staged.chain.coinbase.toLowerCase(), "0x95222290dd7278aa3ddd389cc1e1d165cc4bafe5");
  assert.ok(BigInt(staged.chain.baseFee) > 1_000_000_000n);
  // the check's side, as pagecheck starts it
  await withAnvil(undefined, async (url) => {
    await call(url, "anvil_loadState", [staged.state]);
    await call(url, "anvil_setCoinbase", [staged.chain.coinbase]);
    await call(url, "evm_mine");
    assert.equal(await call(url, "eth_call", [{ to: A, data: "0x" }, "latest"]), `0x${"00".repeat(31)}2a`);
    const n = parseInt(await call(url, "eth_blockNumber"), 16);
    assert.ok(n > 21_000_000, `block number ${n}: not a fresh chain's`);
    assert.ok(parseInt(await call(url, "eth_call", [{ to: B, data: "0x" }, "latest"]), 16) > 21_000_000, "block.number in a call");
    const blk = (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }) })).json()) as { result: { miner: string; timestamp: string } };
    assert.equal(blk.result.miner.toLowerCase(), staged.chain.coinbase.toLowerCase());
    assert.ok(Math.abs(parseInt(blk.result.timestamp, 16) - Date.now() / 1000) < 600, "the time is the head's, about now");
  }, ["--base-fee", String(BigInt(staged.chain.baseFee))]);
});
