// The path guard every dev-team query runs under (a PreToolUse hook with no matcher: it sees every tool call). A role
// may read its read roots and write its write roots, nothing else: no absolute paths outside the checkout, no `..`, no
// symlinks, no /proc. Unknown tools are denied (the query also lists its tools and runs in dontAsk mode).
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** `output`: the role answers in a fixed shape (the SDK's StructuredOutput tool carries the answer, no path). */
export type Access = { root: string; read: string[]; write: string[]; tools: string[]; output?: boolean };
const MAX_WRITE = 100_000;
const MATCH = /^[A-Za-z0-9_]{1,64}$/;
/** Paths the team may name: plain ASCII only (no lookalikes, direction marks, control characters or backslashes). */
const SAFE_PATH = /^[A-Za-z0-9._\/@ -]+$/;
const climbs = (glob: string) => isAbsolute(glob) || glob.includes("..");

/** The real path of `p` (its deepest existing ancestor resolved, the rest appended): a symlink can't hide where it goes. */
function real(p: string) {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    rest.unshift(cur.slice(dirname(cur).length + 1));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
}
/** Repo-relative path of `p` when it sits under one of `roots` (dirs end with "/", others are exact files), else null. */
export function inside(a: Access, p: unknown, roots: string[]): string | null {
  if (typeof p !== "string" || p.length === 0 || p.length > 512 || !SAFE_PATH.test(p)) return null;
  if (p.split(/[\\/]/).includes("..")) return null;
  const abs = isAbsolute(p) ? p : resolve(a.root, p);
  const r = real(abs);
  const base = realpathSync(a.root);
  const rel = relative(base, r).split(sep).join("/");
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  try { if (lstatSync(abs).isSymbolicLink()) return null; } catch { /* doesn't exist yet: a new file */ }
  return roots.some((root) => (root.endsWith("/") ? `${rel}/`.startsWith(root) && rel.length >= root.length - 1 : rel === root)) ? rel : null;
}

/** Why this call is refused, or null. */
export function decide(a: Access, tool: string, input: Record<string, unknown>): string | null {
  if (tool === "StructuredOutput" && a.output) return null;
  if (!a.tools.includes(tool)) return `tool ${tool} is not allowed for this role`;
  switch (tool) {
    case "Read":
      return inside(a, input.file_path, a.read) ? null : `read outside the allowed files: ${String(input.file_path)}`;
    case "Write":
    case "Edit": {
      if (!inside(a, input.file_path, a.write)) return `write outside the game's files: ${String(input.file_path)}`;
      const size = String(input.content ?? input.new_string ?? "").length;
      return size > MAX_WRITE ? `write of ${size} bytes (max ${MAX_WRITE})` : null;
    }
    case "Glob":
    case "Grep": {
      const pattern = String(input.pattern ?? "");
      if (tool === "Glob" && climbs(pattern)) return "glob pattern outside the checkout";
      if (input.glob !== undefined && (typeof input.glob !== "string" || climbs(input.glob))) return "glob outside the checkout";
      // a Glob without a path searches from the pattern's literal folder (up to the last "/" before any wildcard)
      const lit = pattern.replace(/[*?[{].*$/, "");
      const dir = input.path ?? (tool === "Glob" ? lit.slice(0, lit.lastIndexOf("/") + 1) : undefined);
      return dir !== undefined && dir !== "" && inside(a, dir, a.read) ? null : `search outside the allowed folders: ${String(dir ?? "(the whole checkout)")}`;
    }
    case "mcp__gates__forge_build":
      return null;
    case "mcp__gates__forge_test":
      return input.match === undefined || (typeof input.match === "string" && MATCH.test(input.match)) ? null : "match must be letters, digits and _ only";
    default:
      return `tool ${tool} is not allowed`;
  }
}

/** The SDK hook (no matcher: every tool call). */
export const guardHook = (a: Access) => async (input: { hook_event_name: string; tool_name?: string; tool_input?: unknown }) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const why = decide(a, String(input.tool_name), (input.tool_input ?? {}) as Record<string, unknown>);
  return why ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: why } } : {};
};
