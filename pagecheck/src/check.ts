// G15, the dynamic page check: a game's page in headless Chromium as a visitor would get it, with a mock wallet in
// every frame (wallet.ts) backed by the check's own offline anvil. The page is served under its production origin
// (https://play.<site>/) through request interception: from a local build of the play origin (a build being gated)
// or from the files the live site served (the daily replay). Every request the page makes passes through one route:
// anything that leaves that origin, top-level navigations included, is blocked and is a violation.
// A run: load, check the guard is in place and the game mounted, then click every button and fill every input with
// fuzzed values while a controlled clock (Date, timers, requestAnimationFrame) moves forward in steps up to 48 h (or 7
// days), anvil's clock moving in lockstep (evm_increaseTime + evm_mine). Runs repeat for each fixed randomness value
// (Math.random, crypto.getRandomValues) and each browser profile (phone, desktop; realistic user agent, no webdriver
// flag).
// Violations (any one means kill): a wallet method outside the allowed set; a transaction to anything but the game, with
// value, or with an allowance/permit selector; a call or code read of another address; a request that did not come
// through the guard (its stack, its frame); anything the guard refused (it says so on the console); a decoy touched; a
// frame, a new page or a popup; a request or navigation off the origin; a CSP violation; a page that throws while
// loading, or a game that never mounts. A site page (a site change's) is checked the same way at its own path, except
// that it has no wallet at all: any wallet request is a violation, and there is no guard or game to find.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page, type Route } from "playwright-core";
import { rpc } from "./util.ts";
import { DECOYS, LOOKALIKE, mockScript, type Report } from "./wallet.ts";

export type Violation = { kind: string; detail: string; run: string };
export type WalletRequest = { run: string; method: string; to?: string; selector?: string; frame: string; guarded: boolean; viaGuard: boolean };
/** `error`: the check could not run to the end for a reason that is not the page's (an outage or a rework, never a kill). */
export type CheckResult = { ok: boolean; violations: Violation[]; requests: WalletRequest[]; runs: string[]; notes: string[]; error?: string };

/** Served files for the replay: path (with query) → body and content type. */
export type Files = Record<string, { body: Buffer | string; type: string; headers?: Record<string, string> }>;
export type CheckInput = {
  /** the production origin, e.g. https://play.example.xyz */
  origin: string;
  slug: string;
  /** the game's verified address and the factory (lower or mixed case) */
  game: string;
  factory: string;
  /** a local play-origin server (gate) or the live site's files (replay) */
  backend: { url: string } | { files: Files };
  /** the check's anvil (loaded from the engine's state dump) */
  rpc: string;
  chromium: string;
  /** simulated time: 48 h at the gate, 7 days in the public hour */
  hours?: number;
  stepHours?: number;
  randoms?: number[];
  profiles?: Profile[];
  /** interaction rounds spread over the simulated time */
  rounds?: number;
  /** a wallet the guard can't take over (window.ethereum non-configurable): the page must not get the game */
  lockedWallet?: boolean;
  /** one run's hard limit: a page that busy-loops or hangs the browser is a violation, never a hung check */
  runDeadlineMs?: number;
  /** the whole check's limit (below the engine's wait for an answer): each run gets at most its share of what is left */
  budgetMs?: number;
  /** how long the first load may take before the check counts as not run (default 60 s) */
  loadTimeoutMs?: number;
  /** tests only: called with the page once it loaded */
  hook?: (page: Page) => Promise<void>;
  /** the page's path (default /g/<slug>) */
  path?: string;
  /** a site page, not a game: it has no wallet at all (any request to one is a violation), no guard and no game */
  site?: boolean;
  /** a site page: the off-site links the site's own shell carries (any other link off the origin is a violation) */
  allowedLinks?: string[];
  /** a site change's new page: its words as shown (its own main, its title, its description) pass the public text screen */
  textScreen?: boolean;
};
export type Profile = { name: string; userAgent: string; viewport: { width: number; height: number }; isMobile: boolean; hasTouch: boolean };

export const PROFILES: Profile[] = [
  { name: "phone", userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true },
  { name: "desktop", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
];
export const RANDOMS = [0, 0.5, 1 - 2 ** -53];
/** The only methods a game page's wallet requests may use (the guard's set). */
export const ALLOWED = ["eth_chainId", "eth_accounts", "eth_requestAccounts", "eth_call", "eth_getCode", "eth_blockNumber", "eth_getTransactionReceipt", "eth_sendTransaction"];
/** approve, permit (EIP-2612), setApprovalForAll, increaseAllowance, transferFrom, Permit2 permit / transfer */
export const ALLOWANCE = ["0x095ea7b3", "0xd505accf", "0xa22cb465", "0x39509351", "0x23b872dd", "0x2b67b570", "0x30f28b7a"];
/** One run's hard limit by default. */
export const RUN_DEADLINE_MS = 20 * 60_000;
/** The public text screen, as engine/src/llm.ts publicTextIssues reads a post (the same three patterns): another
 *  site's name or link, a handle, a cashtag other than $DNA. */
export function publicTextIssues(text: string): string[] {
  const issues: string[] = [];
  if (/https?:\/\/|www\.|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b/i.test(text)) issues.push("url");
  if (/(^|[^\w])@\w/.test(text)) issues.push("handle");
  if ((text.match(/\$[A-Za-z][A-Za-z0-9_]*/g) ?? []).some((t) => t.toUpperCase() !== "$DNA")) issues.push("cashtag");
  return issues;
}
/** A navigation that never answered: the check could not run (not the page's doing as far as we know). */
class NotRun extends Error {}

const FUZZ = ["0", "1", "-1", "115792089237316195423570985008687907853269984665640564039457584007913129639935", "abc", "0x", "1e18", " ", "<b>", "9".repeat(80)];

/** A CSP report as one line: the directive and what it blocked. */
export function cspReport(body: string) {
  try {
    const r = (JSON.parse(body) as { "csp-report"?: Record<string, unknown> })["csp-report"] ?? {};
    return `report: ${String(r["effective-directive"] ?? r["violated-directive"] ?? "?")} blocked ${String(r["blocked-uri"] ?? "?")}`.slice(0, 300);
  } catch {
    return `report: ${body.slice(0, 200)}`;
  }
}

const lc = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");

/** Where the guard sits in the served HTML: [line, column] (1-based, as stack frames count) of the start and end of
 *  each inline script that carries it. */
export type Span = { from: [number, number]; to: [number, number] };
export function guardSpans(html: string): Span[] {
  const at = (i: number): [number, number] => {
    const before = html.slice(0, i);
    const nl = before.lastIndexOf("\n");
    return [before.split("\n").length, i - nl];
  };
  const out: Span[] = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!m[1].includes("isDNAGuard")) continue;
    const start = m.index! + m[0].indexOf(">") + 1;
    out.push({ from: at(start), to: at(start + m[1].length) });
  }
  return out;
}
const inSpan = (line: number, col: number, s: Span) =>
  (line > s.from[0] || (line === s.from[0] && col >= s.from[1])) && (line < s.to[0] || (line === s.to[0] && col <= s.to[1]));

/** Did a request come through the guard? Its caller (the frame below the mock's own) is code inside the guard's
 *  inline script of the page's own document (by position: names are minified), and its frame is the top document
 *  with a working guard. */
export function viaGuard(r: { stack: string; frame: string; top: boolean; guarded: boolean }, spans: Span[]) {
  const doc = r.frame.split("#")[0];
  const lines = r.stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at "));
  const m = (lines[1] ?? "").match(/^at (?:.*? \()?(.+):(\d+):(\d+)\)?$/);
  if (!m || m[1] !== doc) return false;
  return r.top && r.guarded && spans.some((s) => inSpan(Number(m[2]), Number(m[3]), s));
}

export async function check(i: CheckInput): Promise<CheckResult> {
  const violations: Violation[] = [];
  const requests: WalletRequest[] = [];
  const notes: string[] = [];
  const runs: string[] = [];
  const origin = new URL(i.origin).origin;
  const start = `${origin}${i.path ?? `/g/${i.slug}`}`;
  const game = lc(i.game);
  const factory = lc(i.factory);
  // the player the mock wallet sends as: a fresh address each check (a fixed one would tell the page it is checked)
  const player = `0x${randomBytes(20).toString("hex")}`;
  await rpc(i.rpc, "anvil_impersonateAccount", [player]);
  await rpc(i.rpc, "anvil_setBalance", [player, `0x${(BigInt(1e17) + BigInt(`0x${randomBytes(6).toString("hex")}`) * 1000000n).toString(16)}`]);
  // its own HOME (profile, NSS db, config, cache): the container is read-only but for /tmp
  const home = mkdtempSync(join(tmpdir(), "pc-home-"));
  const launch = () => chromium.launch({
    executablePath: i.chromium, headless: true, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home },
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync"],
  });
  let browser: Browser = await launch();
  let error: string | undefined;
  // the base fee every block keeps (anvil would lower it on each empty block: a tell after a few simulated hours)
  const baseFee = (await rpc<{ baseFeePerGas?: string }>(i.rpc, "eth_getBlockByNumber", ["latest", false])).baseFeePerGas ?? "0x3b9aca00";
  const started = Date.now();
  const total = (i.profiles ?? PROFILES).length * (i.randoms ?? RANDOMS).length;
  try {
    for (const profile of i.profiles ?? PROFILES) {
      for (const random of i.randoms ?? RANDOMS) {
        const run = `${profile.name}@${random}`;
        runs.push(run);
        const snap = await rpc<string>(i.rpc, "evm_snapshot");
        // each run: at most RUN_DEADLINE_MS, and at most its share of what is left of the check's budget
        const left = i.budgetMs === undefined ? Infinity : Math.max(1_000, (i.budgetMs - (Date.now() - started)) / (total - runs.length + 1));
        const limit = Math.min(i.runDeadlineMs ?? RUN_DEADLINE_MS, left);
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), limit); });
        try {
          const how = await Promise.race([oneRun({ i, run, random, profile, browser, origin, start, game, factory, player, baseFee, violations, requests, notes }), deadline]);
          if (how === "timeout") {
            // a page that keeps the browser busy past the limit: a violation; the browser is replaced for the next run
            violations.push({ kind: "timeout", detail: `the run did not finish within ${Math.round(limit / 1000)} s`, run });
            await browser.close().catch(() => {});
            browser = await launch();
          }
        } catch (e) {
          if (!(e instanceof NotRun)) throw e;
          error = e.message;
        } finally {
          clearTimeout(timer);
          await rpc(i.rpc, "evm_revert", [snap]);
        }
        if (error) break;
      }
      if (error) break;
    }
  } finally {
    await browser.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
  if (error) return { ok: false, violations: dedupe(violations), requests, runs, notes: notes.slice(0, 200), error };
  return { ok: violations.length === 0, violations: dedupe(violations), requests, runs, notes: notes.slice(0, 200) };
}

const dedupe = (v: Violation[]) => {
  const seen = new Set<string>();
  return v.filter((x) => { const k = `${x.kind}|${x.detail}|${x.run}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 200);
};

type RunCtx = {
  i: CheckInput; run: string; random: number; profile: Profile; browser: Browser; origin: string; start: string; game: string; factory: string; player: string; baseFee: string;
  violations: Violation[]; requests: WalletRequest[]; notes: string[];
};

async function oneRun(c: RunCtx) {
  const { i, run, origin, start, game, factory } = c;
  const bad = (kind: string, detail: string) => c.violations.push({ kind, detail: detail.slice(0, 500), run });
  const ctx: BrowserContext = await c.browser.newContext({
    userAgent: c.profile.userAgent, viewport: c.profile.viewport, isMobile: c.profile.isMobile, hasTouch: c.profile.hasTouch,
    serviceWorkers: "block", acceptDownloads: false, locale: "en-US", timezoneId: "UTC",
  });
  try {
    // the chain's clock and the page's start together
    const head = await rpc<{ timestamp: string }>(i.rpc, "eth_getBlockByNumber", ["latest", false]);
    const t0 = Number(BigInt(head.timestamp)) * 1000;
    await ctx.clock.install({ time: t0 });
    // the page's simulated now: every response carries it (Date, Last-Modified), so no header shows the real clock
    const real0 = Date.now();
    let jumped = 0;
    const simNow = () => t0 + (Date.now() - real0) + jumped;
    const forward = async (ms: number) => { jumped += ms; await ctx.clock.fastForward(ms); };
    const timeHeaders = (h: Record<string, string>) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(h)) if (!/^(date|last-modified|expires|age)$/i.test(k)) out[k] = v;
      const now = new Date(simNow()).toUTCString();
      return { ...out, date: now, "last-modified": now };
    };

    const binding = `__pc${randomBytes(8).toString("hex")}`;
    await ctx.exposeBinding(binding, async (_src, r: Report) => answer(r));
    await ctx.addInitScript({ content: mockScript({ binding, random: c.random, decoys: DECOYS, lookalike: LOOKALIKE, locked: !!i.lockedWallet }) });

    async function answer(r: Report): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
      if (r.kind === "webrtc") {
        bad("network", `WebRTC (${r.name}) in ${r.frame}`);
        return { error: { code: 4100, message: "refused" } };
      }
      if (r.kind === "decoy") {
        bad("decoy", `${r.name}${r.method ? `.request(${r.method})` : " read"} in ${r.frame}`);
        return { error: { code: 4100, message: "refused" } };
      }
      if (i.site) {
        bad("wallet", `${r.method}: a site page asks the wallet (frame ${r.frame})`);
        return { error: { code: 4100, message: "refused by the check" } };
      }
      const params = Array.isArray(r.params) ? r.params : [];
      const tx = (params[0] ?? {}) as { to?: string; data?: string; value?: string };
      const through = viaGuard(r, spans);
      const entry: WalletRequest = { run, method: r.method, frame: r.frame, guarded: r.guarded, viaGuard: through };
      const issues: string[] = [];
      if (!through) issues.push(`${r.method} did not come through the guard (frame ${r.frame}${r.top ? "" : ", not the top document"}${r.guarded ? "" : ", no guard"})`);
      if (!ALLOWED.includes(r.method)) issues.push(`method ${r.method}`);
      if (r.method === "eth_sendTransaction") {
        entry.to = lc(tx.to);
        entry.selector = lc(tx.data).slice(0, 10);
        if (entry.to !== game) issues.push(`transaction to ${entry.to || "nothing"}, not the game`);
        if (tx.value !== undefined && BigInt(tx.value || "0") !== 0n) issues.push(`transaction with value ${tx.value}`);
        if (ALLOWANCE.includes(entry.selector)) issues.push(`allowance or permit selector ${entry.selector}`);
      }
      if (r.method === "eth_call" || r.method === "eth_getCode") {
        entry.to = lc(r.method === "eth_call" ? tx.to : params[0]);
        if (entry.to !== game && entry.to !== factory) issues.push(`${r.method} of ${entry.to}`);
      }
      c.requests.push(entry);
      for (const s of issues) bad("wallet", s);
      if (issues.length) return { error: { code: 4100, message: "refused by the check" } };
      try {
        if (r.method === "eth_requestAccounts" || r.method === "eth_accounts") return { result: [c.player] };
        if (r.method === "eth_sendTransaction") {
          await rpc(i.rpc, "anvil_setNextBlockBaseFeePerGas", [c.baseFee]); // the send's block keeps the base fee too
          return { result: await rpc(i.rpc, "eth_sendTransaction", [{ from: c.player, to: tx.to, data: tx.data, value: "0x0" }]) };
        }
        return { result: await rpc(i.rpc, r.method, params) };
      } catch (e) {
        return { error: { code: (e as { code?: number }).code ?? -32603, message: (e as Error).message } };
      }
    }

    // the guard's place in the document the page was served (a stack frame inside it = through the guard)
    let spans: Span[] = [];
    const isDoc = (u: URL, nav: boolean) => nav && `${u.origin}${u.pathname}` === start;
    await ctx.route("**", (route) => serve(route));
    await ctx.routeWebSocket(/.*/, (ws) => { bad("network", `websocket ${ws.url()}`); ws.close(); });
    async function serve(route: Route) {
      const req = route.request();
      let u: URL;
      try { u = new URL(req.url()); } catch { bad("network", `bad url ${req.url()}`); return route.abort("blockedbyclient"); }
      if (u.origin !== origin) {
        bad("network", `${req.isNavigationRequest() ? "navigation" : req.resourceType()} to ${u.origin}${u.pathname}`);
        return route.abort("blockedbyclient");
      }
      if (u.pathname === "/api/csp") {
        bad("csp", cspReport(req.postData() ?? ""));
        return route.fulfill({ status: 204, headers: timeHeaders({}) });
      }
      if ("url" in i.backend) {
        try {
          const r = await route.fetch({ url: `${i.backend.url}${u.pathname}${u.search}`, maxRedirects: 0 });
          const headers = timeHeaders(r.headers());
          if (!isDoc(u, req.isNavigationRequest())) return route.fulfill({ response: r, headers });
          const body = await r.text();
          spans = guardSpans(body);
          return route.fulfill({ response: r, body, headers });
        } catch (e) {
          c.notes.push(`${run}: backend ${u.pathname}: ${(e as Error).message}`);
          return route.abort("failed");
        }
      }
      if (u.pathname.startsWith("/api/kill/")) return route.fulfill({ status: 200, contentType: "application/json", body: '{"killed":false}', headers: timeHeaders({}) });
      const f = i.backend.files[`${u.pathname}${u.search}`] ?? i.backend.files[u.pathname];
      if (!f) { c.notes.push(`${run}: not in the replay: ${u.pathname}`); return route.fulfill({ status: 404, body: "", headers: timeHeaders({}) }); }
      if (isDoc(u, req.isNavigationRequest())) spans = guardSpans(String(f.body));
      return route.fulfill({ status: 200, contentType: f.type, body: f.body, headers: timeHeaders(f.headers ?? {}) });
    }

    let first = true;
    ctx.on("page", (p) => { if (first) first = false; else bad("popup", `new page ${p.url() || "(blank)"}`); });
    const page: Page = await ctx.newPage();
    let loading = true;
    page.on("frameattached", (f) => bad("frame", `frame attached (${f.url() || "about:blank"})`));
    page.on("pageerror", (e) => { if (loading) bad("throws", `while loading: ${e.message}`); else c.notes.push(`${run}: page error: ${e.message.slice(0, 200)}`); });
    page.on("console", (m) => {
      const t = m.text();
      if (t.startsWith("[dna-guard] refused ")) bad("refused", t.slice(20));
      else if (/Content Security Policy/i.test(t)) bad("csp", t);
    });
    page.on("dialog", (d) => { d.dismiss().catch(() => {}); });
    page.on("crash", () => bad("crash", "the page's renderer crashed"));

    const res = await page.goto(start, { waitUntil: "load", timeout: i.loadTimeoutMs ?? 60_000 }).catch((e: Error) => {
      // no answer in time is the check's problem (an outage or a rework), not proof against the page
      if (/Timeout/i.test(e.name) || /Timeout \d+ms exceeded/.test(e.message)) throw new NotRun(`the page did not load in time: ${e.message.slice(0, 200)}`);
      bad("throws", `load failed: ${e.message}`);
      return null;
    });
    if (res && res.status() >= 400) bad("throws", `the page answered ${res.status()}`);
    if (i.hook) await i.hook(page);
    await settle(page, ctx);
    const mounted = i.site ? 1 : await page.locator("[data-dna-game]").count().catch(() => 0);
    loading = false;
    const guard = i.site || await page.evaluate(() => {
      const w = window as unknown as { __dnaGuard?: { ok?: unknown }; ethereum?: { isDNAGuard?: unknown } };
      return w.__dnaGuard?.ok === true && w.ethereum?.isDNAGuard === true;
    }).catch(() => false);
    if (!guard) bad("guard", "the wallet guard is not in place on the page");
    if (!mounted) bad("not-mounted", `the game never mounted: ${(await page.locator("body").innerText().catch(() => "")).slice(0, 200)}`);
    if (!mounted || !guard) return; // already a kill: nothing more to learn from this run
    // a site page's links, as the browser resolved them (entities decoded, strings joined; an SVG anchor's xlink:href
    // too): only the page's own origin, over http(s), or a link the site's own shell carries (allowedLinks)
    const links = async () => {
      if (!i.site || page.isClosed()) return;
      const hrefs = await page.$$eval("a", (as) => as.flatMap((a) => [a.getAttribute("href"), a.getAttribute("xlink:href")].filter((v): v is string => v !== null).map((v) => { try { return new URL(v, document.baseURI).href; } catch { return v; } }))).catch(() => [] as string[]);
      for (const h of hrefs) {
        let u: URL;
        try { u = new URL(h); } catch { bad("network", `a link that is no URL: ${h}`); continue; }
        if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin !== origin) {
          if (!(i.allowedLinks ?? []).includes(u.href)) bad("network", `a link off the site: ${h}`);
        }
      }
    };
    await links();
    // a new site page's words as shown (data joined in, entities decoded): its own main (the shell around it names the
    // site's X handle), its title and its description, under the public text screen
    if (i.site && i.textScreen && !page.isClosed()) {
      const text = await page.evaluate(() => [document.title, document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "", (document.querySelector("main") ?? document.body).innerText].join("\n")).catch(() => "");
      for (const t of publicTextIssues(text)) bad("text", `${t === "url" ? "another site's name or link" : `a ${t}`} in the page's words`);
    }

    const hours = i.hours ?? 48;
    const step = i.stepHours ?? 1;
    const rounds = Math.max(1, i.rounds ?? 4);
    const every = Math.max(step, Math.floor(hours / rounds));
    await interact(page, c, start);
    for (let t = step; t <= hours; t += step) {
      await rpc(i.rpc, "evm_increaseTime", [step * 3600]);
      // the pin holds for exactly one block: before every evm_mine (never anvil_mine, which would not keep it)
      await rpc(i.rpc, "anvil_setNextBlockBaseFeePerGas", [c.baseFee]);
      await rpc(i.rpc, "evm_mine");
      await forward(step * 3_600_000);
      await settle(page, ctx, (ms) => { jumped += ms; });
      if (t % every === 0) await interact(page, c, start);
    }
    await links();
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Let the page run what is due (the page's clock is paused between steps; real time passes for the network). */
async function settle(page: Page, ctx: BrowserContext, ran: (ms: number) => void = () => {}) {
  for (let k = 0; k < 4; k++) {
    await ctx.clock.runFor(250).catch(() => {});
    ran(250);
    await page.waitForLoadState("load", { timeout: 2_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Click every button and link, fill every field (a few fuzzed values per round); back to the game if a click left. */
async function interact(page: Page, c: RunCtx, start: string) {
  if (page.isClosed()) return;
  if (page.url().split("#")[0] !== start) await page.goto(start, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
  // a site page's links are not clicked: they are the site's own (G11 refuses a URL in its code), and any navigation off
  // the origin then is the page's own doing
  const sel = c.i.site ? "button:not(a *), [role=button]:not(a), input, textarea, select, [onclick]:not(a), [tabindex]:not(a)" : "button, [role=button], a[href], input, textarea, select, [onclick], [tabindex]";
  const els = await page.locator(sel).all().catch(() => []);
  let n = 0;
  for (const el of els.slice(0, 40)) {
    try {
      if (!(await el.isVisible()) || !(await el.isEnabled())) continue;
      const tag = await el.evaluate((e) => e.tagName.toLowerCase());
      if (tag === "input" || tag === "textarea") await el.fill(FUZZ[(n++ + Math.floor(c.random * 7)) % FUZZ.length], { timeout: 1_000 });
      else if (tag === "select") await el.selectOption({ index: 1 }, { timeout: 1_000 });
      else await el.click({ timeout: 1_000 });
      await settle(page, page.context());
      if (page.url().split("#")[0] !== start) await page.goto(start, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
    } catch {
      /* gone or covered: next */
    }
  }
}
