// The pagecheck service: one HTTP endpoint on the compose's internal network (no egress), called by the engine only.
// It holds no secret, has no dstack socket and keeps nothing between checks: every check gets a fresh copy of the web
// app, a fresh anvil loaded from the engine's state dump and a fresh browser.
//   POST /check  { mode: "build" | "replay", slug, origin, game, factory, state, files, deep? }
//     build:  files = the game's page folder (name → text); the image's web app at /app/web is built with it as the play
//             origin and served under `origin` (a build failure is an answer: { ok: false, error }).
//     replay: files = what the live site served (path → { b64, type, csp? }: the page keeps its live CSP), served
//             under `origin`.
//     site:   files = a site change's code (path under web/ → text, null: removed), laid over the image's web app, built as the main
//             site (mock data) and served under `origin`; `routes` = the pages to check (no game, no chain state).
//   → { ok, violations, runs, requests, notes } | { ok: false, error }
// One check at a time; another request meanwhile gets 409 (the engine retries).
import { createServer, type IncomingMessage } from "node:http";
import { check, type CheckResult, type Files, PROFILES, type Profile } from "./check.ts";
import { buildSite, ownLinks, prepareSite, removeSite, startSite } from "./site.ts";
import { type ChainLook, startAnvil } from "./util.ts";

export const PAGECHECK = { port: 8090, web: "/app/web", chromium: "/usr/bin/chromium", maxBody: 64 * 1024 ** 2 };
const SLUG = /^[a-z][a-z0-9-]{2,30}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}$/;
const TABLET: Profile = { name: "tablet", userAgent: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", viewport: { width: 800, height: 1280 }, isMobile: true, hasTouch: true };

export type Request = {
  mode: "build" | "replay" | "site"; slug: string; origin: string; game: string; factory: string; state: string;
  /** site: the pages to check */
  routes?: string[];
  files: Record<string, string | null> | Record<string, { b64: string; type: string; csp?: string }>; deep?: boolean;
  /** the staging head's base fee and coinbase (the check's chain carries on from them) */
  chain?: ChainLook;
};
export type Answer = CheckResult | { ok: false; error: string };

/** Pure: why a request can't be run ([] = fine). */
export function requestIssues(r: Partial<Request>): string[] {
  if (r.mode === "site") return siteIssues(r);
  const out: string[] = [];
  if (r.mode !== "build" && r.mode !== "replay") out.push("mode: build, replay or site");
  if (!SLUG.test(String(r.slug))) out.push("slug");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(String(r.origin))) out.push("origin: https://<host>");
  if (!ADDR.test(String(r.game)) || !ADDR.test(String(r.factory))) out.push("game, factory: addresses");
  if (typeof r.state !== "string" || !/^0x[0-9a-f]+$/i.test(r.state)) out.push("state: anvil_dumpState hex");
  if (r.chain !== undefined && (!/^0x[0-9a-f]{1,32}$/i.test(String(r.chain?.baseFee)) || !ADDR.test(String(r.chain?.coinbase)) || /^0x0{40}$/.test(String(r.chain?.coinbase)))) out.push("chain: { baseFee: hex, coinbase: a non-zero address }");
  const files = r.files && typeof r.files === "object" ? Object.entries(r.files) : null;
  if (!files || files.length === 0 || files.length > 500) out.push("files: 1 to 500");
  for (const [k, v] of files ?? []) {
    if (r.mode === "build" && (!NAME.test(k) || typeof v !== "string")) out.push(`file ${k.slice(0, 80)}: a plain name and text`);
    if (r.mode === "replay" && (!/^\/[\x21-\x7e]{0,500}$/.test(k) || !v || typeof (v as { b64?: unknown }).b64 !== "string" || typeof (v as { type?: unknown }).type !== "string")) out.push(`file ${k.slice(0, 80)}: a path and { b64, type }`);
  }
  return out.slice(0, 20);
}

/** A site file: a plain path under app/ (no climbing, no hidden names). */
const SITE_FILE = /^app\/([A-Za-z0-9_()[\]-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]{0,80}$/;
const ROUTE = /^\/([a-z0-9_-]+(\/[a-z0-9_-]+)*)?$/;
function siteIssues(r: Partial<Request>): string[] {
  const out: string[] = [];
  if (!/^https:\/\/[a-z0-9.-]+$/.test(String(r.origin))) out.push("origin: https://<host>");
  const files = r.files && typeof r.files === "object" ? Object.entries(r.files) : null;
  if (!files || files.length === 0 || files.length > 200) out.push("files: 1 to 200");
  for (const [k, v] of files ?? []) if (!SITE_FILE.test(k) || k.split("/").includes("..") || (typeof v !== "string" && v !== null)) out.push(`file ${k.slice(0, 80)}: a plain path under app/ and text (or null: removed)`);
  if (!Array.isArray(r.routes) || r.routes.length === 0 || r.routes.length > 10 || !r.routes.every((x) => typeof x === "string" && ROUTE.test(x))) out.push("routes: 1 to 10 plain paths");
  return out.slice(0, 20);
}

/** A site check's settings: a few simulated hours at the gate, a day and every profile in the public hour; the routes
 *  share the budget. */
export const siteSettings = (deep: boolean, routes: number) => deep
  ? { hours: 24, stepHours: 6, rounds: 2, profiles: [...PROFILES, TABLET], randoms: [0, 0.5], budgetMs: Math.floor((80 * 60_000) / routes) }
  : { hours: 2, stepHours: 1, rounds: 1, profiles: PROFILES, randoms: [0.5], budgetMs: Math.floor((35 * 60_000) / routes) };

/** A site change: built as the main site with its files, each route checked in turn (no wallet, no game). */
async function runSite(r: Request, o: typeof PAGECHECK): Promise<Answer> {
  const dir = prepareSite(o.web, {}, undefined, r.files as Record<string, string | null>);
  try {
    try {
      await buildSite(dir, undefined, "main");
    } catch (e) {
      return { ok: false, error: `the site does not build: ${(e as Error).message.slice(-1500)}` };
    }
    const anvil = await startAnvil();
    const zero = `0x${"0".repeat(40)}`;
    try {
      const site = await startSite(dir, { rpc: anvil.url, factory: zero, role: "main" });
      try {
        const all: CheckResult = { ok: true, violations: [], requests: [], runs: [], notes: [] };
        const allowedLinks = ownLinks(o.web);
        for (const route of r.routes!) {
          // a route the change adds (its page.tsx is among its files) has its words screened too
          const textScreen = typeof r.files![`app${route}/page.tsx`] === "string";
          const c = await check({ origin: r.origin, slug: "site", game: zero, factory: zero, rpc: anvil.url, chromium: o.chromium, backend: { url: site.url }, path: route, site: true, allowedLinks, textScreen, ...siteSettings(!!r.deep, r.routes!.length) });
          all.violations.push(...c.violations.map((v) => ({ ...v, run: `${route} ${v.run}` })));
          all.requests.push(...c.requests);
          all.runs.push(...c.runs.map((x) => `${route} ${x}`));
          all.notes.push(...c.notes);
          if (c.error) return { ...all, ok: false, error: c.error };
        }
        return { ...all, ok: all.violations.length === 0, notes: all.notes.slice(0, 200) };
      } finally {
        site.stop();
      }
    } finally {
      anvil.stop();
    }
  } finally {
    removeSite(dir);
  }
}

/** The run settings: the gate's (48 h, phone + desktop) or the public hour's deep run (7 days, three profiles). Each
 *  has a budget below the engine's wait for the answer (45 and 90 min), so a timeout reaches the engine as a verdict. */
export const settings = (deep: boolean) => deep
  ? { hours: 168, stepHours: 1, rounds: 14, profiles: [...PROFILES, TABLET], budgetMs: 85 * 60_000 }
  : { hours: 48, stepHours: 1, rounds: 4, profiles: PROFILES, budgetMs: 40 * 60_000 };

export async function run(r: Request, o = PAGECHECK): Promise<Answer> {
  if (r.mode === "site") return runSite(r, o);
  const anvil = await startAnvil(r.state, r.chain);
  const s = settings(!!r.deep);
  try {
    const base = { origin: r.origin, slug: r.slug, game: r.game, factory: r.factory, rpc: anvil.url, chromium: o.chromium, ...s };
    if (r.mode === "replay") {
      const files: Files = Object.fromEntries(Object.entries(r.files as Record<string, { b64: string; type: string; csp?: string }>).map(([k, v]) =>
        [k, { body: Buffer.from(v.b64, "base64"), type: v.type, ...(typeof v.csp === "string" ? { headers: { "content-security-policy": v.csp } } : {}) }]));
      return await check({ ...base, backend: { files } });
    }
    const dir = prepareSite(o.web, { [r.slug]: r.files as Record<string, string> });
    try {
      try {
        await buildSite(dir);
      } catch (e) {
        return { ok: false, error: `the page does not build: ${(e as Error).message.slice(-1500)}` };
      }
      const site = await startSite(dir, { rpc: anvil.url, factory: r.factory });
      try {
        return await check({ ...base, backend: { url: site.url } });
      } finally {
        site.stop();
      }
    } finally {
      removeSite(dir);
    }
  } finally {
    anvil.stop();
  }
}

const body = (req: IncomingMessage, max: number) => new Promise<string>((resolve, reject) => {
  let n = 0;
  const parts: Buffer[] = [];
  req.on("data", (b: Buffer) => { n += b.length; if (n > max) { reject(new Error("too large")); req.destroy(); } else parts.push(b); });
  req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
  req.on("error", reject);
});

let busy = false;
export function serve(o = PAGECHECK) {
  return createServer(async (req, res) => {
    const reply = (code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true });
    if (req.method !== "POST" || req.url !== "/check") return reply(404, { error: "POST /check" });
    let r: Request;
    try { r = JSON.parse(await body(req, o.maxBody)) as Request; } catch (e) { return reply(400, { error: (e as Error).message }); }
    const bad = requestIssues(r);
    if (bad.length) return reply(400, { error: bad.join("; ") });
    // one check at a time: a second one is told so at once (the engine retries); nothing waits behind a stuck check
    if (busy) return reply(409, { error: "busy: one check at a time" });
    busy = true;
    try { reply(200, await run(r, o)); } catch (e) { reply(500, { error: (e as Error).message.slice(0, 1000) }); } finally { busy = false; }
  });
}

if (import.meta.filename === process.argv[1]) serve().listen(PAGECHECK.port, "0.0.0.0", () => console.log(`pagecheck on :${PAGECHECK.port}`));
