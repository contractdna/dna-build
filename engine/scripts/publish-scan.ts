// Pre-publish scan (src/anonymity.ts publishIssues) over a source tree.
//   node scripts/publish-scan.ts [dir]   every text file under dir (default: the repo's public roots, tracked + new)
// With the private persona file (PERSONA_FILE, else <repo>/persona/persona.md when it exists) every file is also checked
// for its distinctive text (src/anonymity.ts personaLines), and with the private bundle (BUNDLE_FILE, else
// <repo>/persona/bundle.md) for any 8-word run of its sections (bundleShingles).
// Prints `path:line reason` per hit (never the matched text) and exits 1 on any hit.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { bundleShingles, PERSONAL_SHA256, personaLines, publishIssues } from "../src/anonymity.ts";

/** What this repository publishes: the top-level entries a release contains. */
export const PUBLIC_ROOTS = ["contracts", "engine", "sequencer", "pagecheck", "deploy", "web", "docs", ".github", "README.md", "LICENSE", "SECURITY.md", ".gitignore", ".gitmodules", ".nvmrc"];
const BINARY = /\.(png|jpe?g|gif|webp|ico|mp4|ttf|woff2?|otf|pdf|zip|gz|tar)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "out", "cache", "lib", "dist"]);

/** Tracked and new (not ignored) files under the public roots of the git repo at `root`, minus those marked
 *  `export-ignore` in .gitattributes (git archive leaves them out of a release). */
export function trackedFiles(root: string): string[] {
  const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: root, encoding: "utf8", input });
  const list = (args: string[]) => git(["ls-files", "-z", ...args, "--", ...PUBLIC_ROOTS]).split("\0").filter(Boolean);
  const files = [...new Set([...list([]), ...list(["--others", "--exclude-standard"])])];
  // -z output: path NUL attribute NUL value NUL
  const attrs = git(["check-attr", "-z", "--stdin", "export-ignore"], files.join("\0")).split("\0");
  const ignored = new Set<string>();
  for (let i = 0; i + 2 < attrs.length; i += 3) if (attrs[i + 2] === "set") ignored.add(attrs[i]);
  return files.filter((f) => !ignored.has(f));
}

/** Every file under `dir` (relative paths), skipping VCS, dependency and build directories. */
export function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walk(p, base);
    return e.isFile() ? [relative(base, p)] : [];
  });
}

/** `path:line reason` for every hit in `files` (relative to `root`); binaries, submodules and deleted files are skipped.
 *  `persona`: personaLines of the private persona file ([] = not checked); `bundle`: bundleShingles of the bundle. */
export function scanFiles(root: string, files: string[], persona: string[] = [], bundle: Set<string> = new Set()): string[] {
  const hits: string[] = [];
  for (const f of files) {
    if (BINARY.test(f)) continue;
    let text: string;
    try {
      if (!statSync(join(root, f)).isFile()) continue; // a submodule gitlink
      text = readFileSync(join(root, f), "utf8");
    } catch { continue; } // deleted in the working tree
    if (text.includes("\0")) continue;
    for (const { line, why } of publishIssues(f, text, persona, bundle)) hits.push(`${f}:${line} ${why}`);
  }
  return hits;
}

if (import.meta.main) {
  // fail closed: without the identifier list (PERSONAL_IDS) the scan would pass what it never checked
  if (!PERSONAL_SHA256.size) { console.error("publish scan: PERSONAL_IDS is empty: refusing"); process.exit(1); }
  const dir = process.argv[2];
  const root = dir ?? new URL("../../", import.meta.url).pathname;
  const personaFile = process.env.PERSONA_FILE ?? new URL("../../persona/persona.md", import.meta.url).pathname;
  const persona = existsSync(personaFile) ? personaLines(readFileSync(personaFile, "utf8")) : [];
  const bundleFile = process.env.BUNDLE_FILE ?? new URL("../../persona/bundle.md", import.meta.url).pathname;
  const bundle = existsSync(bundleFile) ? bundleShingles(readFileSync(bundleFile, "utf8")) : new Set<string>();
  const hits = scanFiles(root, dir ? walk(dir) : trackedFiles(root), persona, bundle);
  for (const h of hits) console.error(h);
  console.error(hits.length ? `publish scan: ${hits.length} issue(s)` : "publish scan: clean");
  process.exit(hits.length ? 1 : 0);
}
