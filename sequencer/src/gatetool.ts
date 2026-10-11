// The dev team's only way to run anything: forge_build and forge_test, in a fresh gate workspace (the kit from the
// checkout, which no role can write, plus the game's current files), under the gates' limits (engine/src/seq-forge.ts:
// no secrets in the env, prlimit, process group killed on timeout). Output is cut to 8 KB.
import { readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { forge, workspace } from "../../engine/src/seq-forge.ts";
import { roots } from "../../engine/src/seq-gates.ts";
import type { Kind } from "../../engine/src/seq-order.ts";

const MAX_OUT = 8_000;
const FORGE_MS = 10 * 60_000;

/** The game's (or module's) contract files on disk, by repo path. */
export function gameFiles(root: string, slug: string, kind: Kind = "game"): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    const abs = join(root, rel);
    let names: string[];
    try { names = readdirSync(abs); } catch { return; }
    for (const n of names) {
      const r = `${rel}${n}`;
      const st = statSync(join(root, r));
      if (st.isDirectory()) walk(`${r}/`);
      else if (st.isFile() && st.size <= 100_000) out[r] = readFileSync(join(root, r), "utf8");
    }
  };
  for (const g of roots(slug, kind).slice(0, 2)) walk(g);
  return out;
}

/** Run forge on the game as it is now. `match`: one test name pattern (letters, digits, _). `signal`: kills the run
 *  (its whole process group) when it aborts. */
export async function runForge(root: string, slug: string, what: "build" | "test", match?: string, timeoutMs = FORGE_MS, signal?: AbortSignal, kind: Kind = "game") {
  if (match !== undefined && !/^[A-Za-z0-9_]{1,64}$/.test(match)) return "refused: match must be letters, digits and _ only";
  const ws = workspace(join(root, "contracts"), gameFiles(root, slug, kind), slug, kind);
  try {
    const args = what === "build" ? ["build"] : ["test", "--match-path", `*/${kind === "module" ? "modules" : "games"}/${slug}/*`, ...(match ? ["--match-test", match] : [])];
    const r = await forge(ws, args, Math.min(timeoutMs, FORGE_MS), { FOUNDRY_FUZZ_RUNS: "256" }, signal);
    const head = r.aborted ? "STOPPED (the query ended)\n" : r.timedOut ? "TIMED OUT\n" : r.code === 0 ? "OK\n" : "FAILED\n";
    return (head + r.out.split(realpathSync(ws)).join("<workspace>").split(ws).join("<workspace>")).slice(-MAX_OUT);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** A forge run a role asks for ends with its query: at the query's end (`end`, ms since the epoch; the query's time is
 *  already clipped to the build's deadline) or when the query aborts (`signal`), whichever comes first. */
export function gatesServer(root: string, slug: string, signal: AbortSignal, end: number, kind: Kind = "game") {
  const run = async (what: "build" | "test", match?: string) => {
    const left = Math.min(FORGE_MS, end - Date.now());
    return left <= 0 || signal.aborted ? "refused: the query's time is up" : runForge(root, slug, what, match, left, signal, kind);
  };
  return createSdkMcpServer({
    name: "gates",
    version: "1.0.0",
    tools: [
      tool("forge_build", "Compile the game (and its tests) with the games profile.", {}, async () => ({ content: [{ type: "text", text: await run("build") }] })),
      tool("forge_test", "Run the game's tests; `match` narrows to tests whose name matches (letters, digits, _).", { match: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).optional() }, async (a) => ({ content: [{ type: "text", text: await run("test", a.match) }] })),
    ],
  });
}
