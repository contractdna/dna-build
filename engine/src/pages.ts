// Game pages, engine side: the dynamic page check (G15) and the kill switch.
//  - G15 runs in the `pagecheck` container (pagecheck/: its own Chromium and its own offline anvil; no secrets, no
//    egress, no dstack socket). The engine prepares the chain the page will see: an anvil forked at the agreed block
//    with the gated game deployed through the real factory (as the Safe) and funded; every account and slot the page's
//    views and the guard's isGame read is then copied into a fresh chain, which is dumped (anvil_dumpState). It sends the dump and the page's files; it gets a verdict.
//    At the gate (48 h simulated, phone + desktop), in the public hour (7 days, three profiles) and daily on what the
//    live play origin serves (fetched here as plain files, nothing executed in the engine).
//    A violation is a kill (the build, or the live page); a page that does not build is a rework; a check that can't
//    run is an outage (it throws).
//  - Kill switch: a signed `page-kill` record (ref = the slug) pulls the page within seconds (web/app/g/state.ts: the
//    layout serves no game code, open tabs stop at their next check); the owners are paged. Durable: a commit on top of
//    `release` that deletes only web/app/g/<slug>/, `release` fast-forwarded to it at once (a delete only removes code:
//    no public hour), recorded as a `release` record; the same commit merged into main through a pull request (a merge
//    commit, so `release` keeps fast-forwarding from it).
// A ship cancelled by the enclave itself (the public hour's page check failed) is a `ship-cancel` record on the ship's
// ref; the ship path ends the build when it sees one (src/sequencer.ts), and the owners are paged to veto it too.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, type Address, decodeFunctionResult, encodeFunctionData, getCreate2Address, type Hex, keccak256 } from "viem";
import * as abi from "./abi.ts";
import { trustedRows } from "./approve.ts";
import { LOG_BASE_URL, RPC_URLS } from "./config.ts";
import { post } from "./http.ts";
import { Defer, enqueue, type Handler } from "./jobs.ts";
import { append } from "./log.ts";
import { gate, type GateResult } from "./seq-gates.ts";

export const PAGES = {
  /** the pagecheck service on the compose's internal network */
  service: "http://pagecheck:8090",
  /** the play origin visitors get (the live site's host with play.) */
  origin: `https://play.${new URL(LOG_BASE_URL).host}`,
  /** the main site's origin (a site change's pages) */
  siteOrigin: `https://${new URL(LOG_BASE_URL).host}`,
  gateTimeoutMs: 45 * 60_000,
  /** how long a check waits for the service to finish another one (409) */
  busyWaitMs: 60 * 60_000,
  deepTimeoutMs: 90 * 60_000,
  /** what the staged game holds (the page shows a funded game) */
  fundWei: 30_000_000_000_000_000n,
  /** the live bundle: at most this many files and bytes */
  maxFiles: 400,
  maxBytes: 40 * 1024 ** 2,
};
const SLUG = /^[a-z][a-z0-9-]{2,30}$/;

export type Violation = { kind: string; detail: string; run: string };
export type Answer = { ok: boolean; violations?: Violation[]; error?: string };
export type PageCheck = { ok: boolean; kill: boolean; why: string; violations: Violation[] };

// ---------------------------------------------------------------- pure

/** A verdict from the service's answer: a violation is a kill, a page that does not build is a rework. */
export function verdictOf(a: Answer): PageCheck {
  // a violation already seen is a kill even when the check could not finish; otherwise a check that did not run (or a
  // page that does not build) is a rework or an outage, never a kill
  if (a.error !== undefined && !(a.violations ?? []).length) return { ok: false, kill: false, why: a.error.slice(0, 500), violations: [] };
  const v = a.violations ?? [];
  if (a.ok && v.length === 0) return { ok: true, kill: false, why: "", violations: [] };
  return { ok: false, kill: true, why: v.slice(0, 5).map((x) => `${x.kind}: ${x.detail}`).join("; ").slice(0, 500) || "the page check failed", violations: v.slice(0, 50) };
}
/** A first load that never answered is the service's problem, not the page's: an outage (the build waits or is skipped,
 *  never reworked or killed for it). Anything else goes to verdictOf. */
export function answered(a: Answer): Answer {
  if (a.error !== undefined && !(a.violations ?? []).length && /did not load in time/.test(a.error)) throw new Error(`pagecheck: ${a.error.slice(0, 300)}`);
  return a;
}
/** G15 as a gate result (plus the kill flag the build's step reads). */
export const pageGateResult = (c: PageCheck): GateResult & { kill: boolean } =>
  ({ ...gate("G15", "page check", c.ok ? [] : c.violations.length ? c.violations.slice(0, 20).map((v) => `${v.kind}: ${v.detail} (${v.run})`) : [c.why]), kill: c.kill });
/** The page's own files from the gated tree (repo path → text): name → text. */
export function pageFiles(files: Record<string, string>, slug: string): Record<string, string> {
  const pre = `web/app/g/${slug}/`;
  return Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(pre) && !p.slice(pre.length).includes("/")).map(([p, t]) => [p.slice(pre.length), t]));
}
/** Same-origin asset paths a page or a chunk refers to (Next's static files; turbopack names them without /_next). */
export function assetPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:\/_next\/)?static\/(?:chunks|css|media)\/[A-Za-z0-9_\-./~]+?\.(?:js|css|woff2?|png|svg|jpe?g|webp|ico)/g)) {
    const p = m[0].startsWith("/_next/") ? m[0] : `/_next/${m[0]}`;
    if (!p.includes("..")) out.add(p);
  }
  return [...out];
}
/** The short public reason a pulled page shows (a fixed text: no model or page output reaches it). */
export const KILL_WHY = { check: "the page check found something it does not allow", owner: "the Safe owners pulled it" } as const;

// ---------------------------------------------------------------- the chain a check sees

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
let rid = 0;
async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }), signal: AbortSignal.timeout(120_000) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

/** An anvil for staging (chain id 1; a fork of `fork` when given), stopped (its whole process group) after `fn`. */
export async function withAnvil<T>(fork: { url: string; block: bigint } | undefined, fn: (url: string) => Promise<T>, extra: string[] = []): Promise<T> {
  const port = await freePort();
  const args = ["--port", String(port), "--host", "127.0.0.1", "--chain-id", "1", "--silent", ...(fork ? ["--fork-url", fork.url, "--fork-block-number", String(fork.block), "--no-storage-caching"] : []), ...extra];
  const p = spawn("anvil", args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp" }, stdio: "ignore", detached: true });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      if (await rpc(url, "eth_chainId").then(() => true, () => false)) break;
      if (i > 300) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
    return await fn(url);
  } finally {
    try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ }
  }
}

/** On the staging fork only: a full factory (MAX_LIVE games live) gets its live count cleared, so the next game stages
 *  while the real deploy still waits for its free slot (the eviction, sequencer.ts). `liveCount` is the uint8 at slot 0,
 *  byte 20, packed after `funder` (forge inspect GameFactory storageLayout); both are read back, so a layout change fails
 *  loudly here, never silently. */
export async function freeSlot(url: string, factory: Address) {
  const read = async (fn: "liveCount" | "MAX_LIVE" | "funder") => decodeFunctionResult({ abi: abi.gameFactoryAbi, functionName: fn, data: await rpc<Hex>(url, "eth_call", [{ to: factory, data: encodeFunctionData({ abi: abi.gameFactoryAbi, functionName: fn }) }, "latest"]) });
  if ((await read("liveCount")) < (await read("MAX_LIVE"))) return;
  const funder = await read("funder");
  const word = BigInt(await rpc<Hex>(url, "eth_getStorageAt", [factory, "0x0", "latest"]));
  await rpc(url, "anvil_setStorageAt", [factory, "0x0", `0x${(word & ~(0xffn << 160n)).toString(16).padStart(64, "0")}`]);
  if ((await read("liveCount")) !== 0 || (await read("funder")) !== funder) throw new Error("stage: could not free a slot in the full factory on the fork (its storage layout changed?)");
}

type Stage = { factory: Address; safe: Address; game: Address; deploy?: { initCode: Hex; salt: Hex }; gameAbi?: unknown[]; fundWei?: bigint };
/** Stage the game on `url` (deployed through the factory as the Safe when `deploy` is given, then funded), read every
 *  view the page can read so it is in the dump, and dump the state. */
export async function stage(url: string, s: Stage): Promise<Staged> {
  if (s.deploy) {
    if (getCreate2Address({ from: s.factory, salt: s.deploy.salt, bytecodeHash: keccak256(s.deploy.initCode) }).toLowerCase() !== s.game.toLowerCase()) throw new Error("stage: the game address is not the factory's CREATE2 address for this code");
    await freeSlot(url, s.factory);
    await rpc(url, "anvil_impersonateAccount", [s.safe]);
    await rpc(url, "anvil_setBalance", [s.safe, "0xde0b6b3a7640000"]);
    const data = encodeFunctionData({ abi: abi.gameFactoryAbi, functionName: "deploy", args: [s.deploy.initCode, s.deploy.salt] });
    const hash = await rpc<Hex>(url, "eth_sendTransaction", [{ from: s.safe, to: s.factory, data, gas: "0x1c9c380" }]);
    let rcpt: { status: string } | null = null;
    for (let i = 0; i < 100 && !rcpt; i++) { rcpt = await rpc<{ status: string } | null>(url, "eth_getTransactionReceipt", [hash]); if (!rcpt) await new Promise((r) => setTimeout(r, 100)); }
    if (!rcpt || rcpt.status !== "0x1") {
      const why = await rpc(url, "eth_call", [{ from: s.safe, to: s.factory, data, gas: "0x1c9c380" }, "latest"]).then(() => "", (e: Error) => e.message);
      throw new Error(`stage: factory.deploy failed ${why.slice(0, 300)}`);
    }
    await rpc(url, "anvil_stopImpersonatingAccount", [s.safe]);
  }
  if ((await rpc<string>(url, "eth_getCode", [s.game, "latest"])) === "0x") throw new Error(`stage: no code at ${s.game}`);
  if (s.fundWei !== undefined) await rpc(url, "anvil_setBalance", [s.game, `0x${s.fundWei.toString(16)}`]);
  // the reads a page and its guard make: every account and slot they touch, as the staging chain has them
  const views = [...(s.gameAbi ?? []), ...abi.gameKitAbi].filter((f) => {
    const x = f as { type?: string; stateMutability?: string; inputs?: unknown[] };
    return x.type === "function" && (x.stateMutability === "view" || x.stateMutability === "pure") && (x.inputs ?? []).length === 0;
  }) as { name: string }[];
  const calls = [
    ...views.map((f) => ({ to: s.game, data: encodeFunctionData({ abi: [f] as unknown as Abi, functionName: f.name }) })),
    { to: s.factory, data: encodeFunctionData({ abi: abi.gameFactoryAbi, functionName: "isGame", args: [s.game] }) },
  ];
  return copyState(url, calls, [s.game, s.factory]);
}

type Pre = Record<string, { balance?: Hex; nonce?: number; code?: Hex; storage?: Record<string, Hex> }>;
/** What the check's chain carries on with besides its state: the staging head's base fee and block producer. */
export type ChainLook = { baseFee: Hex; coinbase: Address };
export type Staged = { state: string; chain: ChainLook };
/** The state these calls read (prestate traces) and these accounts, copied into a fresh chain (chain id 1, no fork)
 *  and dumped. A fork's dump would not carry what it fetched from the provider; this one does, and nothing else. The
 *  fresh chain starts at the staging head (its block number and time, through a genesis file; its base fee), and the
 *  check carries on with the head's block producer: a page can't tell the check's chain from mainnet by block 1, a zero
 *  coinbase or a default base fee. */
export async function copyState(url: string, calls: { to: Address; data: Hex }[], accounts: Address[]): Promise<Staged> {
  const head = await rpc<{ number: Hex; timestamp: Hex; baseFeePerGas?: Hex; miner?: Address }>(url, "eth_getBlockByNumber", ["latest", false]);
  const baseFee = (head.baseFeePerGas ?? "0x3b9aca00") as Hex;
  const coinbase = (head.miner && !/^0x0{40}$/i.test(head.miner) ? head.miner : `0x${randomBytes(20).toString("hex")}`) as Address;
  const dir = mkdtempSync(join(tmpdir(), "seq-genesis-"));
  writeFileSync(join(dir, "genesis.json"), JSON.stringify({ config: { chainId: 1 }, number: head.number, timestamp: head.timestamp, gasLimit: "0x1c9c380", alloc: {} }));
  const pre: Pre = {};
  const add = (p: Pre) => {
    for (const [a, v] of Object.entries(p)) {
      const k = a.toLowerCase();
      pre[k] = { ...pre[k], ...v, storage: { ...pre[k]?.storage, ...v.storage } };
    }
  };
  for (const c of calls) add(await rpc<Pre>(url, "debug_traceCall", [c, "latest", { tracer: "prestateTracer" }]).catch(() => ({})));
  for (const a of accounts) {
    const [code, balance] = await Promise.all([rpc<Hex>(url, "eth_getCode", [a, "latest"]), rpc<Hex>(url, "eth_getBalance", [a, "latest"])]);
    add({ [a]: { code, balance } });
  }
  const state = await withAnvil(undefined, async (fresh) => {
    for (const [a, v] of Object.entries(pre)) {
      if (v.code && v.code !== "0x") await rpc(fresh, "anvil_setCode", [a, v.code]);
      if (v.balance) await rpc(fresh, "anvil_setBalance", [a, v.balance]);
      if (v.nonce) await rpc(fresh, "anvil_setNonce", [a, `0x${v.nonce.toString(16)}`]);
      for (const [k, x] of Object.entries(v.storage ?? {})) await rpc(fresh, "anvil_setStorageAt", [a, k, x]);
    }
    // the head's base fee for the block that closes the copy (anvil would lower it on an empty block)
    await rpc(fresh, "anvil_setNextBlockBaseFeePerGas", [baseFee]);
    await rpc(fresh, "evm_mine");
    return rpc<string>(fresh, "anvil_dumpState");
  }, ["--init", join(dir, "genesis.json"), "--base-fee", String(BigInt(baseFee))]).finally(() => rmSync(dir, { recursive: true, force: true }));
  return { state, chain: { baseFee, coinbase } };
}

// ---------------------------------------------------------------- the seams (tests replace them)

export const PAGES_DEPS = {
  now: () => Date.now(),
  /** the chain to fork: the first provider at the agreed head (undefined in tests: an empty chain) */
  fork: async (): Promise<{ url: string; block: bigint } | undefined> => ({ url: RPC_URLS[0], block: await (await import("./chainref.ts")).agreedHead() }),
  /** extra setup on the staging anvil before the game is staged (tests deploy the factory here) */
  prepare: async (_url: string) => {},
  /** One check. The service runs one at a time and answers 409 meanwhile: retried every 30 s up to PAGES.busyWaitMs.
   *  It answers only when the run is done (a deep run takes far over 5 min): not fetch, whose 300 s header limit ends it (http.ts). */
  post: async (body: unknown, timeoutMs: number): Promise<Answer> => {
    const end = Date.now() + PAGES.busyWaitMs;
    for (;;) {
      const r = await post(`${PAGES.service}/check`, JSON.stringify(body), timeoutMs, { "content-type": "application/json" });
      if (r.status === 409 && Date.now() < end) { await r.body?.cancel(); await new Promise((x) => setTimeout(x, 30_000)); continue; }
      if (r.status !== 200) throw new Error(`pagecheck: ${r.status} ${(await r.text()).slice(0, 300)}`);
      return (await r.json()) as Answer;
    }
  },
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
  github: async () => import("./github.ts"),
  alert: async (text: string, key: string) => { await (await import("./telegram.ts")).alert(text, key); },
};

const stateFor = (s: Stage) => PAGES_DEPS.fork().then((fork) => withAnvil(fork, async (url) => { await PAGES_DEPS.prepare(url); return stage(url, s); }));

// ---------------------------------------------------------------- G15: the gate and the public hour

export type BuildPage = { slug: string; files: Record<string, string>; factory: Address; safe: Address; initCode: Hex; salt: Hex; gameAbi?: unknown[] };
/** The page of a gated build: deployed on a staging chain at its CREATE2 address, built and checked. `deep`: the public
 *  hour's run. */
export async function checkBuild(b: BuildPage, deep = false): Promise<PageCheck> {
  if (!SLUG.test(b.slug)) throw new Error(`page check: bad slug ${b.slug}`);
  const files = pageFiles(b.files, b.slug);
  if (!files["page.tsx"] || !files["game.json"]) return { ok: false, kill: false, why: "the game has no page.tsx and game.json", violations: [] };
  const game = getCreate2Address({ from: b.factory, salt: b.salt, bytecodeHash: keccak256(b.initCode) });
  const state = await stateFor({ factory: b.factory, safe: b.safe, game, deploy: { initCode: b.initCode, salt: b.salt }, gameAbi: b.gameAbi, fundWei: PAGES.fundWei });
  return verdictOf(answered(await PAGES_DEPS.post({ mode: "build", slug: b.slug, origin: PAGES.origin, game, factory: b.factory, state: state.state, chain: state.chain, files, deep }, deep ? PAGES.deepTimeoutMs : PAGES.gateTimeoutMs)));
}
/** G15 at the gate stage. */
export const pageGate = async (b: BuildPage) => pageGateResult(await checkBuild(b, false));

/** The routes a site change touches: for each changed file under web/app/, the nearest folder at or above it that holds
 *  a page.tsx in the gated tree (`pages`) and has no dynamic segment, as a route (route groups dropped); at most 10. */
export function siteRoutes(changed: string[], pages: string[]): string[] {
  const has = new Set(pages.filter((p) => p.startsWith("web/app/") && p.endsWith("/page.tsx")).map((p) => p.slice(0, -"page.tsx".length)));
  const out = new Set<string>();
  for (const p of changed) {
    if (!p.startsWith("web/app/")) continue;
    for (let dir = p.slice(0, p.lastIndexOf("/") + 1); dir.length >= "web/app/".length; dir = dir.slice(0, dir.slice(0, -1).lastIndexOf("/") + 1)) {
      if (!has.has(dir)) continue;
      const segs = dir.slice("web/app/".length).split("/").filter(Boolean).filter((s) => !/^\(.*\)$/.test(s));
      // a dynamic page can't be opened as it is: its nearest static ancestor is (the home page at least, so the site
      // is always built and opened when a change touches web/app/)
      if (segs.some((s) => s.startsWith("["))) continue;
      out.add(`/${segs.join("/")}`);
      break;
    }
  }
  return [...out].sort().slice(0, 10);
}
/** A site change's files (repo path → text; null: removed by the change) and the gated tree's paths. */
export type SitePage = { files: Record<string, string | null>; pages: string[] };
/** A site change's pages (G15): built as the main site with the change's code and checked route by route. No route (a
 *  docs-only change, or code no page shows) passes with nothing to run. */
export async function checkSite(b: SitePage, deep = false): Promise<PageCheck> {
  const routes = siteRoutes(Object.keys(b.files), b.pages);
  if (!routes.length) return { ok: true, kill: false, why: "", violations: [] };
  const files = Object.fromEntries(Object.entries(b.files).filter(([p]) => p.startsWith("web/app/")).map(([p, t]) => [p.slice("web/".length), t]));
  return verdictOf(answered(await PAGES_DEPS.post({ mode: "site", origin: PAGES.siteOrigin, files, routes, deep }, deep ? PAGES.deepTimeoutMs : PAGES.gateTimeoutMs)));
}
/** G15 for a site change at the gate stage. */
export const sitePageGate = async (b: SitePage) => pageGateResult(await checkSite(b, false));

/** The enclave stops its own ship (once): a `ship-cancel` record on the ship's ref; the owners are asked to veto the
 *  ship record too (a second lock). */
export async function shipCancel(build: string, shipSeq: string, why: string) {
  if ((await trustedRows("ship-cancel", `ship:${build}`, 1)).length) return null;
  const rec = await append("ship-cancel", `ship:${build}`, { kind: "ship-cancel", build, ship: shipSeq, why: why.slice(0, 500), at: new Date(PAGES_DEPS.now()).toISOString() });
  await PAGES_DEPS.alert(`🚨 Sequencer: the page check failed in the public hour for ${build}; the enclave cancelled its ship (record ${rec.seq}). Veto ship record ${shipSeq} as well: /veto ${shipSeq} <signature>. ${why.slice(0, 300)}`, `alert:seq:shipcancel:${build}`);
  return rec;
}

// ---------------------------------------------------------------- the daily check of what visitors get

export type Bundle = Record<string, { b64: string; type: string }>;
/** What the play origin serves for a game: its page and every static file it and its chunks refer to (plain fetches;
 *  nothing runs here). The page keeps the live response's CSP. */
export async function liveBundle(slug: string, origin = PAGES.origin): Promise<Bundle> {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  const get = async (path: string) => {
    const r = await PAGES_DEPS.fetch(`${origin}${path}`, { redirect: "manual", headers: { "user-agent": ua }, signal: AbortSignal.timeout(30_000) });
    if (r.status !== 200) throw new Error(`live page check: ${path} answered ${r.status}`);
    return { body: Buffer.from(await r.arrayBuffer()), type: (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0], csp: r.headers.get("content-security-policy") };
  };
  const out: Bundle = {};
  let bytes = 0;
  const page = await get(`/g/${slug}`);
  out[`/g/${slug}`] = { b64: page.body.toString("base64"), type: "text/html" };
  if (page.csp) Object.assign(out[`/g/${slug}`], { csp: page.csp });
  const todo = assetPaths(page.body.toString("utf8"));
  const seen = new Set(todo);
  while (todo.length) {
    const p = todo.shift()!;
    if (Object.keys(out).length >= PAGES.maxFiles) throw new Error("live page check: too many files");
    const f = await get(p);
    bytes += f.body.length;
    if (bytes > PAGES.maxBytes) throw new Error("live page check: the bundle is too large");
    out[p] = { b64: f.body.toString("base64"), type: f.type };
    if (/javascript|css/.test(f.type)) for (const q of assetPaths(f.body.toString("utf8"))) if (!seen.has(q)) { seen.add(q); todo.push(q); }
  }
  return out;
}

/** The game's ABI as released (its game.json on `release`, blob-verified), for the views its page reads. */
async function releaseAbi(slug: string): Promise<unknown[] | undefined> {
  const gh = await PAGES_DEPS.github();
  const e = (await gh.treeOf(await gh.refSha("release"))).get(`web/app/g/${slug}/game.json`);
  if (!e) return undefined;
  const a = (JSON.parse((await gh.blob(e.sha)).toString("utf8")) as { abi?: unknown }).abi;
  return Array.isArray(a) ? a : undefined;
}

export type LiveGame = { slug: string; address: Address; factory: Address; safe: Address; gameAbi?: unknown[] };
/** One live game's daily check: its served files replayed under the production origin against a fork. A violation
 *  pulls the page. */
export async function checkLive(g: LiveGame): Promise<PageCheck> {
  const files = await liveBundle(g.slug);
  const state = await stateFor({ factory: g.factory, safe: g.safe, game: g.address, gameAbi: g.gameAbi ?? (await releaseAbi(g.slug).catch(() => undefined)) });
  const c = verdictOf(answered(await PAGES_DEPS.post({ mode: "replay", slug: g.slug, origin: PAGES.origin, game: g.address, factory: g.factory, state: state.state, chain: state.chain, files }, PAGES.gateTimeoutMs)));
  if (c.kill) await pageKill(g.slug, KILL_WHY.check, c.why);
  return c;
}

// ---------------------------------------------------------------- the kill switch

/** Pull a game's page now: the signed `page-kill` record (once), the owners paged, the durable revert queued. */
export async function pageKill(slug: string, why: string, detail: string) {
  if (!SLUG.test(slug)) throw new Error(`page kill: bad slug ${slug}`);
  let [row] = await trustedRows("page-kill", slug, 1);
  if (!row) {
    const rec = await append("page-kill", slug, { kind: "page-kill", slug, why, detail: detail.slice(0, 1000), at: new Date(PAGES_DEPS.now()).toISOString() });
    row = { kind: "page-kill", ref: slug, body: "", seq: rec.seq };
    await PAGES_DEPS.alert(`🚨 The page of ${slug} was pulled (record ${rec.seq}): ${detail.slice(0, 300)}. It serves no game code now; the durable revert follows. Owners: GameKit.pause or factory.retire if the contract needs it.`, `alert:page-kill:${slug}`);
  }
  await enqueue("pages:revert", { slug, kill: row.seq }, { dedupeKey: `pages:revert:${slug}`, maxAttempts: 20 });
  return row.seq;
}

const KILL_BRANCH = (slug: string) => `kill/${slug}`;
/** The durable revert, step by step (each step checks what is already done): `release` → a commit without the game's
 *  page folder (fast-forward, recorded as a `release` record); main ← the same commit through a merge commit. */
export async function revertStep(slug: string, killSeq: string): Promise<string> {
  const final = (m: string) => Object.assign(new Error(m), { final: true });
  if (!SLUG.test(slug)) throw final(`revert: bad slug ${JSON.stringify(slug).slice(0, 40)}`);
  // only for a kill the enclave signed: this record, for this page
  if (!(await trustedRows("page-kill", slug, 20)).some((r) => r.seq === killSeq)) throw final(`revert ${slug}: no signed page-kill record ${killSeq} for it`);
  const gh = await PAGES_DEPS.github();
  const dir = `web/app/g/${slug}/`;
  const rel = await gh.refSha("release");
  let k: string | null = null;
  const relTree = await gh.treeOf(rel);
  const gone = [...relTree.keys()].filter((p) => p.startsWith(dir));
  if (gone.length) {
    const base = (await gh.commit(rel)).commit.tree.sha;
    const tree = await gh.gh<{ sha: string }>("POST", "/repos/{repo}/git/trees", { base_tree: base, tree: gone.map((path) => ({ path, mode: "100644", type: "blob", sha: null })) });
    const made = (await gh.gh<{ sha: string }>("POST", "/repos/{repo}/git/commits", { message: `Pull the page of ${slug} (page-kill record ${killSeq})`, tree: tree.sha, parents: [rel] })).sha;
    // what GitHub made is checked before it is signed or released: exactly the released tree without the page's
    // folder, on top of what was released (this path never goes through releaseTo: a kill is never held)
    const c = await gh.commit(made);
    const want = [...relTree].filter(([p]) => !p.startsWith(dir)).map(([p, e]) => `${p} ${e.mode} ${e.sha}`).sort();
    const got = [...(await gh.treeOf(made))].map(([p, e]) => `${p} ${e.mode} ${e.sha}`).sort();
    if (c.parents.map((x) => x.sha).join() !== rel || JSON.stringify(got) !== JSON.stringify(want)) {
      await PAGES_DEPS.alert(`🚨 The revert commit GitHub made for ${slug} (${made}) is not the released tree without its page; release not moved.`, `alert:page-revert-tree:${slug}`);
      throw final(`revert ${slug}: commit ${made} is not release ${rel} without ${dir}`);
    }
    k = made;
    await append("release", `release:${k}`, { kind: "release", sha: k, pageKill: killSeq, slug, effectiveAt: new Date(PAGES_DEPS.now()).toISOString() });
    await gh.fastForward("release", k);
  } else {
    // release is already without the page: if a revert of this kill put it there, that commit is the one to merge
    const [r] = await trustedRows("release", `release:${rel}`, 1);
    const b = r ? (JSON.parse(r.body) as { pageKill?: string; slug?: string }) : null;
    if (b?.pageKill === killSeq && b.slug === slug) k = rel;
  }
  // main: the same deletion, merged so that release can keep moving forward
  const main = await gh.refSha("main");
  if (!gh.hasPrefix(await gh.treeOf(main), dir)) return k && gone.length ? `release → ${k}; main has no page folder` : "done";
  const branch = KILL_BRANCH(slug);
  let pr = await gh.pullOn(branch);
  if (!pr) {
    // main still has the folder, release does not, and no commit of this kill is there to merge: try again later (a
    // job that returned here would be done, and the revert lost)
    if (!k) {
      // a Defer spends no attempt: say so once a day, so a revert that can't go on is never silent
      await PAGES_DEPS.alert(`The revert of ${slug} (page-kill record ${killSeq}) is waiting: main still has the page, and release has no commit of this kill to merge. Remove web/app/g/${slug}/ on main through a pull request.`, `alert:page-revert-wait:${slug}:${new Date(PAGES_DEPS.now()).toISOString().slice(0, 10)}`);
      throw new Defer(10 * 60_000, `revert ${slug}: main still has the page; release has no commit of this kill to merge`);
    }
    await gh.gh("POST", "/repos/{repo}/git/refs", { ref: `refs/heads/${branch}`, sha: k }).catch((e: unknown) => { if ((e as { status?: number }).status !== 422) throw e; });
    await gh.gh("POST", "/repos/{repo}/pulls", { title: `Pull the page of ${slug}`, head: branch, base: "main", body: `The page check pulled this page (page-kill record ${killSeq}). This removes only web/app/g/${slug}/.` });
    pr = await gh.pullOn(branch);
    if (!pr) throw new Error(`revert ${slug}: the pull request did not open`);
  }
  if (pr.merged) return `merged: ${pr.merge_commit_sha}`;
  await gh.setStatus(pr.head.sha, "success", "a page pulled by the enclave: removes only its own folder").catch(() => {});
  try {
    const r = await gh.gh<{ sha: string; merged: boolean }>("PUT", `/repos/{repo}/pulls/${pr.number}/merge`, { sha: pr.head.sha, merge_method: "merge" });
    return `merged: ${r.sha}`;
  } catch (e) {
    await PAGES_DEPS.alert(`The revert of ${slug} (PR #${pr.number}) did not merge: ${(e as Error).message.slice(0, 200)}. release is already without the page.`, `alert:page-revert:${slug}:${new Date(PAGES_DEPS.now()).toISOString().slice(0, 13)}`);
    throw e;
  }
}
export const revertHandler: Handler = { lane: "default", run: async (j) => ({ step: await revertStep(String(j.payload.slug), String(j.payload.kill)) }) };

/** The daily check of every shipped game's live page (pulled pages skipped). */
export async function dailyPages(games: LiveGame[]) {
  const out: Record<string, string> = {};
  for (const g of games) {
    if ((await trustedRows("page-kill", g.slug, 1)).length) { out[g.slug] = "pulled"; continue; }
    try {
      const c = await checkLive(g);
      out[g.slug] = c.ok ? "ok" : c.kill ? `pulled: ${c.why.slice(0, 200)}` : `not checked: ${c.why.slice(0, 200)}`;
    } catch (e) {
      out[g.slug] = `error: ${(e as Error).message.slice(0, 200)}`;
      await PAGES_DEPS.alert(`The daily page check of ${g.slug} did not run: ${(e as Error).message.slice(0, 200)}`, `alert:page-daily:${g.slug}:${new Date(PAGES_DEPS.now()).toISOString().slice(0, 10)}`);
    }
  }
  return out;
}
