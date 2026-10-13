// The play origin a check runs against, built from source: a copy of the web app (the image's, or the repo's in
// tests) with the game folders added, built and served on loopback as the play role. node_modules is copied too
// (cloned where the filesystem can): the bundler refuses a link out of the project, and a build must not be able to
// change what the next check runs with; native binaries a node_modules above the copy already holds stay out (NATIVE).
// Kill state: PAGECHECK=1 makes a build without live data answer "not killed" (app/g/state.ts); a live build ignores it.
// A site change is built the same way as the main site (no SITE_ROLE, mock data) with its files laid over the copy.
import { type ChildProcess, spawn } from "node:child_process";
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freePort, waitFor } from "./util.ts";

export type Role = "play" | "main";
/** Next's swc and sharp's binaries: left out of a copy when a node_modules above it holds them, so Node, walking up from
 *  the copy, loads those. In the image that is /node_modules, links into /app/web on the read-only filesystem: the copy
 *  lives on /tmp, a noexec tmpfs where a native binary cannot load, and nothing a build does reaches them. */
const NATIVE = /^\/node_modules\/(@next\/swc-[^/]+|@img)(\/|$)/;
/** A fresh copy of `web` with `games` (slug → file name → text) under app/g/ and `over` (path under web/ → text, or null:
 *  that file removed) laid over it. */
export function prepareSite(web: string, games: Record<string, Record<string, string>>, root = tmpdir(), over: Record<string, string | null> = {}): string {
  const dir = mkdtempSync(join(root, "pc-site-"));
  const above = createRequire(join(root, "_.js")).resolve.paths("_") ?? [];
  const shared = (rel: string) => { const m = NATIVE.exec(rel); return !!m && above.some((d) => existsSync(join(d, m[1]))); };
  cpSync(web, dir, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: (p) => { const rel = p.slice(web.length); return !/^\/(\.next|test|node_modules\/\.cache)(\/|$)/.test(rel) && !shared(rel); } });
  const put = (p: string, text: string | null) => {
    if (!p.startsWith(`${dir}/`)) throw new Error("a file outside the site copy");
    if (text === null) return rmSync(p, { force: true });
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  for (const [slug, files] of Object.entries(games)) for (const [name, text] of Object.entries(files)) put(join(dir, "app", "g", slug, name), text);
  for (const [path, text] of Object.entries(over)) put(join(dir, path), text);
  return dir;
}

const siteEnv = (role: Role, extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ...(role === "play" ? { SITE_ROLE: "play" } : {}), NEXT_TELEMETRY_DISABLED: "1", ...extra,
});
const next = (dir: string) => join(dir, "node_modules", "next", "dist", "bin", "next");

/** Why a build failed. Next's native swc binary that cannot load is the host's fault (a copy of it on a noexec /tmp: the
 *  image's /node_modules holds it, NATIVE), never the page's, and says so up front. */
export function buildFailure(code: number | null, out: string): string {
  if (/failed to map segment from shared object|Failed to load SWC binary/i.test(out)) {
    return `next build failed: the swc binary could not load (is /tmp mounted noexec?): ${out.slice(-2000)}`;
  }
  return `next build failed (${code}): ${out}`;
}

/** `next build` as the play role (or the main site); rejects with the tail of its output. */
export function buildSite(dir: string, timeoutMs = 10 * 60_000, role: Role = "play"): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [next(dir), "build"], { cwd: dir, env: siteEnv(role, { NODE_ENV: "production", HOME: dir }), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    const take = (b: Buffer) => { out = (out + b.toString()).slice(-8000); };
    p.stdout!.on("data", take);
    p.stderr!.on("data", take);
    const t = setTimeout(() => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(buildFailure(code, out))); });
  });
}

export type Site = { url: string; stop: () => void };
/** `next start` on loopback; the snapshot reads the given RPC (the check's anvil). */
export async function startSite(dir: string, o: { rpc: string; factory: string; role?: Role }): Promise<Site> {
  // the server-side snapshot reads only the check's own anvil
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(o.rpc)) throw new Error("the play build reads only a loopback RPC");
  const port = await freePort();
  const p: ChildProcess = spawn(process.execPath, [next(dir), "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: dir, env: siteEnv(o.role ?? "play", { NODE_ENV: "production", HOME: dir, PAGECHECK: "1", PLAY_RPC_URL: o.rpc, GAME_FACTORY: o.factory }), stdio: "ignore", detached: true,
  });
  const stop = () => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } };
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitFor(() => fetch(`${url}/api/kill/none-such`).then((r) => r.status > 0, () => false), 60_000);
  } catch (e) {
    stop();
    throw e;
  }
  return { url, stop };
}

export const removeSite = (dir: string) => rmSync(dir, { recursive: true, force: true });

/** The off-site links the site's own shell carries (web/app/_ui and the root layout, which no site change reaches), read
 *  from the image's copy of the web app, never the change's: a site page may show these and no other link off the
 *  site. */
export function ownLinks(web: string): string[] {
  const out = new Set<string>();
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const files = [join(web, "app", "layout.tsx"), ...(() => { try { return readdirSync(join(web, "app", "_ui")).map((f) => join(web, "app", "_ui", f)); } catch { return []; } })()];
  for (const f of files) for (const m of read(f).match(/https?:\/\/[^\s"'`<>)]+/g) ?? []) { try { out.add(new URL(m).href); } catch { /* not a URL */ } }
  return [...out].sort();
}
