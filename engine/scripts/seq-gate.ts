// Run the Sequencer's gates on a pull request checkout (CI: advisory; the enclave runs them again and decides).
//   node engine/scripts/seq-gate.ts --pr <checkout> --base <sha> --kit <trusted contracts/ dir>
//     [--kind game|site|module|engine] [--slug <name>] [--body-file <file>] [--factory <address> --salt <bytes32>] [--out <results.json>]
// The checkout is only read (git objects and files); its code runs only inside forge, in the gates' workspace. Exit 1
// when any gate fails.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Address, type Hex } from "viem";
import { runGates } from "../src/seq-forge.ts";
import { parseRaw, roots } from "../src/seq-gates.ts";
import { type Kind, KINDS } from "../src/seq-order.ts";

const { values: a } = parseArgs({ options: { kind: { type: "string" }, pr: { type: "string" }, base: { type: "string" }, kit: { type: "string" }, slug: { type: "string" }, "body-file": { type: "string" }, factory: { type: "string" }, salt: { type: "string" }, out: { type: "string" } } });
if (!a.pr || !a.base || !a.kit) throw new Error("usage: seq-gate.ts --pr <checkout> --base <sha> --kit <contracts dir> [--slug] [--body-file] [--factory --salt] [--out]");
const git = (...args: string[]) => execFileSync("git", ["-C", a.pr!, ...args], { maxBuffer: 64 * 1024 ** 2 });

const head = git("rev-parse", "HEAD").toString().trim();
const changes = parseRaw(git("diff", "--raw", "-z", "--no-abbrev", "-M", a.base, head).toString("utf8"));
const files: Record<string, string> = {};
for (const c of changes) {
  if (c.status === "D" || c.mode === "160000") continue;
  const blob = git("cat-file", "blob", c.sha);
  c.size = blob.length;
  c.binary = blob.includes(0);
  if (!c.binary && c.size <= 100_000) files[c.path] = blob.toString("utf8");
}
const gameSlug = changes.map((c) => c.path.match(/^(?:contracts\/src\/games|contracts\/test\/games|web\/app\/g)\/([^/]+)\//)?.[1]).find(Boolean);
const moduleSlug = changes.map((c) => c.path.match(/^contracts\/(?:src|test)\/modules\/([^/]+)\//)?.[1]).find(Boolean);
// the order's kind decides in the enclave; here (advice): a game's or a module's folders, engine code, else a site change
const kind = (a.kind ?? (gameSlug ? "game" : moduleSlug ? "module" : changes.some((c) => /^engine\/(src|test)\//.test(c.path)) ? "engine" : "site")) as Kind;
if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`--kind: one of ${KINDS.join(", ")}`);
const slug = a.slug ?? (kind === "game" ? gameSlug ?? "" : kind === "module" ? moduleSlug ?? "" : `${kind}-change`);
const baseHasSlug = (kind === "game" || kind === "module") && roots(slug, kind).some((r) => {
  try { git("cat-file", "-e", `${a.base}:${r.slice(0, -1)}`); return true; } catch { return false; }
});
const run = await runGates({
  // an engine change: the edited and removed files' base texts (G16 compares against them)
  baseFiles: kind === "engine" ? Object.fromEntries(changes.filter((c) => c.status !== "A").flatMap((c) => {
    const p = c.oldPath ?? c.path;
    try { return [[p, git("show", `${a.base}:${p}`).toString("utf8")]]; } catch { return []; }
  })) : undefined,
  kind, slug, changes, files, baseHasSlug, basePaths: kind === "site" ? git("ls-tree", "-r", "--name-only", a.base).toString().split("\n").filter(Boolean) : [], prBody: a["body-file"] ? readFileSync(a["body-file"], "utf8") : "", kit: a.kit,
  order: { seed: head, ...(a.factory && a.salt ? { factory: a.factory as Address, salt: a.salt as Hex } : {}) },
});
for (const r of run.results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.gate} ${r.name}${r.ok ? "" : `\n${r.issues.map((i) => `       - ${i}`).join("\n")}`}`);
if (a.out) writeFileSync(a.out, `${JSON.stringify({ kind, slug, head, base: a.base, results: run.results }, null, 2)}\n`);
process.exit(run.results.every((r) => r.ok) ? 0 : 1);
