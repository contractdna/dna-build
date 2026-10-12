// The Sequencer's gates: the checks a build's pull request must pass before the brain sees it (plan §4). CI runs them
// as advice (from the base branch's copy of this file, never the PR's); the enclave runs them again from its image
// and its result decides. This file holds the pure gates (inputs: the PR's changed files, their text, the compiler's
// AST/ABI/bytecode); src/seq-forge.ts builds the workspace and runs forge (tests, mutants, gas, fork sim).
//  G1 paths, G2 deps, G3 Solidity patterns, G4 bytecode, G5 ABI/structure, G11 web, G12 text/secrets, G13 address,
//  G14 identity. Every gate has planted-violation fixtures (test/seq-gates.test.ts).
// Each order kind has its own reach (scopeIssue): a game its three new folders, a site change the site's pages and the
// public docs. Behind every kind's reach stands one list no order ever reaches (NEVER).
import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import { type Address, getAddress, getContractAddress, type Hex, keccak256 } from "viem";
import { publicTextIssues } from "./llm.ts";
import type { Kind } from "./seq-order.ts";

export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9" | "G11" | "G12" | "G13" | "G14" | "G15" | "G16";
export type GateResult = { gate: GateId; name: string; ok: boolean; issues: string[] };
export const gate = (g: GateId, name: string, issues: string[]): GateResult => ({ gate: g, name, ok: issues.length === 0, issues: [...new Set(issues)].slice(0, 50) });

/** A file the PR adds, changes or removes (git's name-status plus mode and size). */
export type Change = { path: string; status: "A" | "M" | "D" | "R" | "C" | "T"; mode: string; size: number; binary?: boolean; oldPath?: string };

/** `git diff --raw -z --no-abbrev -M`: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0" per entry, with
 *  two paths (old, new) for renames and copies. Sizes are filled in by the caller. */
export function parseRaw(raw: string): (Change & { sha: string })[] {
  const parts = raw.split("\0");
  const out: (Change & { sha: string })[] = [];
  for (let i = 0; i < parts.length - 1;) {
    const m = parts[i].match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([ACDMRTUX])\d*$/);
    if (!m) throw new Error(`git diff --raw: unexpected entry ${JSON.stringify(parts[i].slice(0, 120))}`);
    const two = m[5] === "R" || m[5] === "C";
    out.push({ path: parts[i + (two ? 2 : 1)], ...(two ? { oldPath: parts[i + 1] } : {}), status: m[5] as Change["status"], mode: m[5] === "D" ? m[1] : m[2], size: 0, sha: m[4] });
    i += two ? 3 : 2;
  }
  return out;
}

export const SLUG = /^[a-z][a-z0-9-]{2,30}$/;
/** Slugs no build may take: the reference game, the page template, Next's names and the game templates' folders. */
export const RESERVED = new Set(["example", "template", "layout", "api", "daily-checkin", "last-buyer", "raffle"]);
/** The only folders a build may write: a game's own three; a site change's pages and docs (scopeIssue narrows them). */
export const roots = (slug: string, kind: Kind = "game") =>
  kind === "site" ? ["web/app/", "docs/"]
    : kind === "engine" ? ["engine/src/", "engine/test/"]
    : kind === "module" ? [`contracts/src/modules/${slug}/`, `contracts/test/modules/${slug}/`]
      : [`contracts/src/games/${slug}/`, `contracts/test/games/${slug}/`, `web/app/g/${slug}/`];
/** `path` is under one of `rs` (a folder ends with "/", anything else is one file). */
export const under = (path: string, rs: string[]) => rs.some((r) => (r.endsWith("/") ? path.startsWith(r) : path === r));
const MAX_FILE = 100_000;

/** What no order reaches, whatever its kind: a second wall behind each kind's own reach. */
export const NEVER: [RegExp, string][] = [
  [/^\.github\//, "the repository's workflows and settings"],
  [/^contracts\/src\/DNAHook\.sol$/, "the hook"],
  [/^contracts\/src\/DNAToken\.sol$/, "the token"],
  // everything under contracts/ but a game's or a module's own folder: the core contracts, the kit, the interfaces,
  // the scripts and the compiler settings
  [/^contracts\/(?!(src|test)\/(games|modules)\/[a-z][a-z0-9-]{2,30}\/[^/])/, "the core contracts"],
  [/^deploy\//, "the measured compose and its pins"],
  [/^persona\//, "the private personality file"],
  [/^engine\/src\/(enclave|config|mode)\.ts$/, "the enclave lockdown"],
  [/^engine\/src\/(sealed|signed)\.ts$|^scripts\//, "keys"],
  [/^engine\/src\/(approve|owner-sig)\.ts$/, "owner approvals and signatures"],
  [/^engine\/src\/(log|canonical|head)\.ts$|^engine\/migrations\//, "the signed log"],
  // tx.ts sends; keepers.ts is the agent key's queue (Safe-only ops refused there) and lib.ts the op table it reads
  [/^engine\/src\/(tx|keepers|lib)\.ts$/, "the transaction guards"],
  // what the engine says in public and to its owners, the chain reads it judges, GitHub (merges, releases) and the brain
  [/^engine\/src\/(x|voice|telegram|chainref|github|brain)\.ts$/, "the engine's voice, its owners' channel, chain reads, GitHub and the brain"],
  // every file that loads or holds a model prompt: the bundle's ids and their neutral defaults (ct: the CT takes' scout)
  [/^engine\/src\/(agents|character|card|studio|games|persona|ct)\.ts$/, "the model prompts and the persona"],
  [/^engine\/src\/(seq-[a-z]+|sequencer|pages|limited|sandbox)\.ts$|^sequencer\/|^pagecheck\//, "the Sequencer's own gates"],
  [/^engine\/src\/(llm|policy|funding|rewards|anonymity|attest|proof)\.ts$/, "spend caps, money and what may be published"],
  [/^web\/(security|proxy|next\.config)\.ts$|^web\/app\/_ui\/(guard|tx)\.ts$|^web\/app\/(layout\.tsx|g\/layout\.tsx|api\/|proof\/)/, "the site's security layer"],
  [/(^|\/)(package(-lock)?\.json|\.npmrc|\.gitattributes|\.gitmodules)$/, "dependencies and repository settings"],
  // the tests that hold all of the above in place: weakening them would hide the next change that breaks it
  [/^engine\/test\/((seq-[a-z-]+|sequencer[a-z-]*|pages|anonymity|approve|owner-approve|enclave[a-z-]*|sandbox|caps|image|workflow-lint|funding|rewards|llm-limits|lib|github|brain|brain-db|proof|voice|persona|ct|ct-db|swap|live-x|records\.typecheck)(\.test)?\.ts|fixtures\/seq\/)/, "the tests of what no order reaches"],
];
const neverIssue = (path: string) => NEVER.find(([re]) => re.test(path))?.[1];

/** A site change's files: page.tsx, PascalCase components, CSS modules and lowercase .ts modules, in plain route
 *  folders; never the site's data, game, API or proof code, its shared shell and scene, or the security and Sequencer
 *  pages. Docs: docs/<name>.md, but not the docs that tell people how to verify, operate or build with DNA (in any
 *  case), and no new doc named like an existing one but for case. */
const SITE_OFF = /^web\/app\/(_data|_live|_ui|_dna|g|api|proof|security|sequencer|play)\//; // play: the game panel sends transactions
const SITE_DIR = /^([a-z0-9_][a-z0-9_-]*|\([a-z0-9-]+\))$/; // no dynamic segment: every page a change reaches can be opened as it is
const SITE_NAME = /^(page\.tsx|[A-Z][A-Za-z0-9]*\.tsx|[A-Za-z0-9_-]+\.module\.css|[a-z][a-z0-9-]*\.ts)$/;
const DOC = /^docs\/[A-Za-z0-9_-]+\.md$/;
/** An engine change's files: a source file, a test, or a test fixture (the parts no order reaches are in NEVER). */
const ENGINE_FILE = /^engine\/(src\/[a-z][a-z0-9-]*\.ts|test\/[a-z][a-z0-9-]*(\.test)?\.ts|test\/fixtures\/([a-z0-9_-]+\/)*[a-z0-9_-]+\.(json|txt))$/;
// [b]: the publish guard (src/anonymity.ts) refuses that doc's plain name in a published file; this matches it as written
const DOCS_OFF = /^docs\/(verify|security-model|run[b]ook|operations|sequencer)\.md$/i;

/** Why `path` is out of an order's reach (null: within it). */
export function scopeIssue(kind: Kind, slug: string, path: string): string | null {
  if (path.split("/").some((s) => s === "" || s === "." || s === "..") || path.includes("\\")) return "not a plain path";
  const never = neverIssue(path);
  if (never) return `never reachable (${never})`;
  if (kind === "game" || kind === "module") return under(path, roots(slug, kind)) ? null : `outside the ${kind}'s folders`;
  if (kind === "engine") return ENGINE_FILE.test(path) ? null : "not an engine source or test file (engine/src/<name>.ts, engine/test/<name>.test.ts or a test fixture)";
  if (path.startsWith("docs/")) return DOC.test(path) && !DOCS_OFF.test(path) ? null : "not a public doc (docs/<name>.md; not the verify, security, operations or Sequencer docs)";
  if (!path.startsWith("web/app/")) return "outside the site's pages and public docs";
  if (SITE_OFF.test(path)) return "the site's data, shared shell, games, API, proof, security or Sequencer pages";
  const parts = path.slice("web/app/".length).split("/");
  const name = parts.pop()!;
  if (!parts.every((p) => SITE_DIR.test(p))) return "a folder that is not a plain route";
  if (NEXT_FILES.test(name) || !SITE_NAME.test(name)) return "not page.tsx, a PascalCase component, a CSS module or a lowercase .ts module";
  return null;
}

// ---------------------------------------------------------------- G1 paths

/** G1: a game (or a module): every change is a new regular text file inside its own folders, which are new at the base. A
 *  site change: files added, changed or removed, each regular text within its reach (scopeIssue). Nothing in NEVER,
 *  ever. */
export function pathGate(changes: Change[], slug: string, baseHasSlug: boolean, kind: Kind = "game", base: { paths: string[] } = { paths: [] }): GateResult {
  if (kind === "site" || kind === "engine") return scopedPathGate(changes, slug, kind, base.paths);
  const out: string[] = [];
  if (!SLUG.test(slug) || RESERVED.has(slug)) out.push(`slug ${JSON.stringify(slug)} is not a valid new ${kind} name`);
  if (baseHasSlug) out.push(`the ${kind}'s folders already exist at the base: a build adds a new ${kind} only`);
  if (changes.length === 0) out.push("no changes");
  const rs = roots(slug, kind);
  for (const c of changes) {
    const inside = (p: string) => !p.includes("..") && !p.includes("\\") && rs.some((r) => p.startsWith(r));
    if (!inside(c.path)) out.push(`${c.path}: outside the ${kind}'s folders`);
    for (const p of c.oldPath ? [c.path, c.oldPath] : [c.path]) if (neverIssue(p)) out.push(`${p}: never reachable (${neverIssue(p)})`);
    if (c.oldPath && !inside(c.oldPath)) out.push(`${c.oldPath}: renamed from outside the ${kind}'s folders`);
    if (c.status !== "A") out.push(`${c.path}: ${c.status === "D" ? "deleted" : c.status === "R" ? "renamed" : "changed"} (a build only adds files)`);
    if (c.mode === "120000") out.push(`${c.path}: a symlink`);
    else if (c.mode === "160000") out.push(`${c.path}: a submodule`);
    else if (c.mode !== "100644") out.push(`${c.path}: file mode ${c.mode} (only 100644)`);
    if (c.binary) out.push(`${c.path}: a binary file`);
    if (c.size > MAX_FILE) out.push(`${c.path}: ${c.size} bytes (max ${MAX_FILE})`);
    // contract folders hold Solidity and the spec only (a .gitattributes there could hide files from the publish scan);
    // the page folder's names are G11's
    if (c.path.startsWith("contracts/") && !/\/[^/]+\.sol$/.test(c.path) && !c.path.endsWith("/SPEC.json")) out.push(`${c.path}: only .sol files and SPEC.json in the contract folders`);
  }
  return gate("G1", "paths", out);
}

function scopedPathGate(changes: Change[], slug: string, kind: Kind, basePaths: string[]): GateResult {
  const out: string[] = [];
  if (!SLUG.test(slug)) out.push(`name ${JSON.stringify(slug)} is not valid`);
  if (changes.length === 0) out.push("no changes");
  const lower = new Map(basePaths.map((p) => [p.toLowerCase(), p]));
  for (const c of changes) {
    for (const p of c.oldPath ? [c.path, c.oldPath] : [c.path]) {
      const why = scopeIssue(kind, slug, p);
      if (why) out.push(`${p}: ${why}`);
    }
    if (c.status === "D") continue;
    // a new file named like an existing one but for case (docs/Verify.md beside docs/VERIFY.md)
    const twin = lower.get(c.path.toLowerCase());
    if (c.status !== "M" && twin && twin !== c.path) out.push(`${c.path}: named like ${twin} but for case`);
    if (c.status === "T") out.push(`${c.path}: its type changed`);
    if (c.mode === "120000") out.push(`${c.path}: a symlink`);
    else if (c.mode === "160000") out.push(`${c.path}: a submodule`);
    else if (c.mode !== "100644") out.push(`${c.path}: file mode ${c.mode} (only 100644)`);
    if (c.binary) out.push(`${c.path}: a binary file`);
    if (c.size > MAX_FILE) out.push(`${c.path}: ${c.size} bytes (max ${MAX_FILE})`);
  }
  // a test goes only with its code: removing engine/test/<name>… needs engine/src/<name>.ts removed in the same change
  if (kind === "engine") {
    for (const c of changes) {
      if (c.status !== "D" || !c.path.startsWith("engine/test/")) continue;
      const name = posix.basename(c.path).replace(/(\.test)?\.(ts|json|txt)$/, "");
      if (!changes.some((x) => x.status === "D" && x.path === `engine/src/${name}.ts`)) out.push(`${c.path}: a test removed while engine/src/${name}.ts stays`);
    }
  }
  // an engine change comes with its tests
  if (kind === "engine" && changes.some((c) => c.path.startsWith("engine/src/")) && !changes.some((c) => c.status !== "D" && /^engine\/test\/[a-z][a-z0-9-]*\.test\.ts$/.test(c.path))) {
    out.push("an engine change needs its tests: add or change a test in engine/test/");
  }
  return gate("G1", "paths", out);
}

// ---------------------------------------------------------------- G2 deps

/** Solidity source without comments or string contents (so a commented-out import or a string can't confuse a scan). */
export function solCode(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => (m.startsWith("/") ? " ".repeat(m.length) : `"${" ".repeat(Math.max(0, m.length - 2))}"`));
}
/** The same blanking, byte for byte (each comment or string becomes as many spaces as it has UTF-8 bytes): solc's
 *  source offsets are byte offsets. */
export const solCodeBytes = (src: string) =>
  Buffer.from(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => " ".repeat(Buffer.byteLength(m))));
/** The import paths of a Solidity file. */
export function solImports(src: string): string[] {
  const out: string[] = [];
  const re = /\bimport\b([^;]*);/g;
  const code = solCode(src);
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const lit = src.slice(m.index, m.index + m[0].length).match(/["']([^"']*)["']/);
    out.push(lit ? lit[1] : "<unparsed import>");
  }
  return out;
}
const KIT = ["contracts/src/games/GameKit.sol", "contracts/src/games/IGames.sol"];
/** A module's kit: the policy interfaces (source), the conformance suite (tests). */
export const MODULE_IFACE = "contracts/src/interfaces/IPolicies.sol";
export const MODULE_SUITE = "contracts/test/modules/ModuleConformance.sol";
const KIT_TEST = ["contracts/test/games/GameKitConformance.sol"];
/** Where a relative or remapped Solidity import points, repo-relative; null when it is neither. */
export function resolveSol(from: string, spec: string): string | null {
  if (spec.startsWith("forge-std/")) return spec.split("/").includes("..") ? null : `forge-std:${spec}`;
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  return posix.normalize(posix.join(posix.dirname(from), spec));
}
const TS_PACKAGES = new Set(["react", "next/link", "next/image"]);
const TS_KIT = ["web/app/_ui/tx", "web/app/_ui/ui"];
/** An engine change adds no dependency (engine/package.json is out of its reach) and runs no other code. */
const ENGINE_PACKAGES = new Set(["postgres", "viem", "zod", "typescript", "@phala/dstack-sdk", "@resvg/resvg-js"]); // the image's dependencies only
const ENGINE_NODE_OFF = new Set(["node:child_process", "node:vm", "node:worker_threads", "node:cluster", "node:inspector", "node:module", "node:v8", "node:wasi", "node:repl", "node:process"]);
/** What a site page may import from the rest of the app (an allowlist): the shared UI, the shell, its icons, and the
 *  data layer's public read side (never the database client or request internals). Beyond these, only its own folder. */
const SITE_SHARED = /^web\/app\/(_ui\/(ui|Shell|icons)|_data\/(source|types|flags|chain|launchFee))(\.tsx?)?$/;

/** G2: no new dependency. Game sources import only the kit and their own files; tests also forge-std and the
 *  conformance suite; pages only react, next/link, next/image, the tx helper, the shared UI, and their own files. A
 *  site change's code imports only react, next/link, next/image, types from next, SITE_SHARED and files in its own
 *  folder. */
export function depGate(files: Record<string, string>, slug: string, kind: Kind = "game"): GateResult {
  const out: string[] = [];
  if (kind === "site") {
    for (const [path, text] of Object.entries(files)) {
      if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(path)) continue;
      for (const { spec, typeOnly } of tsImports(path, text)) {
        const r = posix.normalize(posix.join(posix.dirname(path), spec));
        const ok = TS_PACKAGES.has(spec) || (spec === "next" && typeOnly) || (spec.startsWith(".") && (SITE_SHARED.test(r) || posix.dirname(r) === posix.dirname(path)));
        if (!ok) out.push(`${path}: import ${JSON.stringify(spec)} is not allowed`);
      }
    }
    return gate("G2", "dependencies", out);
  }
  if (kind === "engine") {
    // the engine's own files, node's builtins but those that run other code, and the packages it already has; a test
    // that imports what no order reaches is that part's test (NEVER keeps those tests too); no code run from strings,
    // no node internals, no import.meta but its url
    for (const [path, text] of Object.entries(files)) {
      if (!path.endsWith(".ts")) continue;
      for (const { spec } of tsImports(path, text)) {
        const r = posix.normalize(posix.join(posix.dirname(path), spec));
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        const ok = spec.startsWith(".") ? /^engine\/(src|test)\//.test(r) && !r.includes("..")
          : spec.startsWith("node:") ? !ENGINE_NODE_OFF.has(spec) : ENGINE_PACKAGES.has(pkg);
        if (!ok) out.push(`${path}: import ${JSON.stringify(spec)} is not allowed`);
        const never = spec.startsWith(".") && path.startsWith("engine/test/") ? neverIssue(r) ?? neverIssue(`${r}.ts`) : undefined;
        if (never) out.push(`${path}: a test of what no order reaches (imports ${r}: ${never})`);
      }
      out.push(...engineCodeIssues(path, text));
    }
    return gate("G2", "dependencies", out);
  }
  if (kind === "module") {
    // a module's source: the policy interfaces and its own files; its tests also forge-std and the conformance suite
    const [msrc, mtest] = roots(slug, kind);
    for (const [path, text] of Object.entries(files)) {
      if (!path.endsWith(".sol")) continue;
      const isTest = path.startsWith(mtest);
      for (const spec of solImports(text)) {
        const r = resolveSol(path, spec);
        const ok = r !== null && (r.startsWith(msrc) || r === MODULE_IFACE || (isTest && (r.startsWith(mtest) || r === MODULE_SUITE || r.startsWith("forge-std:"))));
        if (!ok) out.push(`${path}: import ${JSON.stringify(spec)} is not allowed`);
      }
    }
    return gate("G2", "dependencies", out);
  }
  const [src, test, web] = roots(slug);
  for (const [path, text] of Object.entries(files)) {
    if (path.endsWith(".sol")) {
      const isTest = path.startsWith(test);
      for (const spec of solImports(text)) {
        const r = resolveSol(path, spec);
        const ok = r !== null && (r.startsWith(src) || KIT.includes(r) || (isTest && (r.startsWith(test) || KIT_TEST.includes(r) || r.startsWith("forge-std:"))));
        if (!ok) out.push(`${path}: import ${JSON.stringify(spec)} is not allowed`);
      }
    } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(path)) {
      for (const { spec } of tsImports(path, text)) {
        const r = spec.startsWith(".") ? posix.normalize(posix.join(posix.dirname(path), spec)).replace(/\.(tsx?|jsx?)$/, "") : spec;
        const ok = TS_PACKAGES.has(spec) || (spec.startsWith(".") && (r.startsWith(web) || TS_KIT.includes(r))) || (spec.startsWith(".") && r.endsWith(".module.css") && r.startsWith(web));
        if (!ok) out.push(`${path}: import ${JSON.stringify(spec)} is not allowed`);
      }
    }
  }
  return gate("G2", "dependencies", out);
}

function tsImports(path: string, text: string): { spec: string; typeOnly: boolean }[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { spec: string; typeOnly: boolean }[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ spec: n.moduleSpecifier.text, typeOnly: ts.isImportDeclaration(n) ? !!n.importClause?.isTypeOnly : n.isTypeOnly });
    }
    if (ts.isImportEqualsDeclaration(n)) out.push({ spec: "<import =>", typeOnly: false });
    // import("x"): its specifier when written out, else refused
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      out.push({ spec: a && ts.isStringLiteralLike(a) ? a.text : "<dynamic import>", typeOnly: false });
    }
    if (ts.isIdentifier(n) && n.text === "require" && ts.isCallExpression(n.parent) && n.parent.expression === n) out.push({ spec: "<require>", typeOnly: false });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------- Solidity AST

export type Ast = { nodeType: string; [k: string]: unknown };
/** Every AST node under `n`, depth first. */
export function nodes(n: unknown, out: Ast[] = []): Ast[] {
  if (Array.isArray(n)) for (const x of n) nodes(x, out);
  else if (n && typeof n === "object") {
    if (typeof (n as Ast).nodeType === "string") out.push(n as Ast);
    for (const v of Object.values(n)) if (v && typeof v === "object") nodes(v, out);
  }
  return out;
}
const typeOf = (n: unknown) => ((n as { typeDescriptions?: { typeString?: string } })?.typeDescriptions?.typeString ?? "");
const at = (unit: { file: string; text: string }, n: Ast) => {
  const start = Number(String(n.src ?? "0").split(":")[0]);
  return `${unit.file}:${unit.text.slice(0, start).split("\n").length}`;
};
export type Unit = { file: string; text: string; ast: Ast };

/** forge-std cheatcodes a game's tests may not use: processes, files, environment, network, forks, gas metering, and
 *  code put in place without an import (etch, deployCode: a test reaches only what G2 lets it import). */
export const BANNED_CHEATS = /^(etch|deployCode\w*|ffi|tryFfi|rpc|rpcUrl\w*|createFork|createSelectFork|selectFork|makePersistent|env\w*|setEnv|readFile\w*|writeFile\w*|readLine|writeLine|readDir|closeFile|removeFile|removeDir|copyFile|createDir|fsMetadata|isFile|isDir|exists|projectRoot|serialize\w*|writeJson|writeToml|prompt\w*|pauseGasMetering|resumeGasMetering|setArbitraryStorage|sleep|unixTime)$/;
const VM_TYPE = /^contract (Vm|VmSafe|VmContractHelper\d*)$/;
const LOW_LEVEL = new Set(["call", "delegatecall", "staticcall", "callcode", "send", "transfer"]);
const HEVM = "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d";

/** G3: forbidden patterns. In the game's sources: delegatecall, callcode, selfdestruct, contract creation, inline
 *  assembly, tx.origin, low-level calls, any external call, prevrandao/blockhash randomness, emitting Played itself,
 *  unchecked blocks, receive/fallback, immutables (contract creation; new arrays are fine), a function named like a
 *  banned cheatcode. In its tests: the cheatcodes
 *  above (through any Vm-typed value, or the cheatcode contract converted to an address, or a function re-declared under
 *  a banned name), forge-std's deployCode helpers, low-level calls, inline assembly, the cheatcode address and its seed, any string with "://", and a
 *  URL assembled from pieces. A module's sources also keep no storage at all (constants only). */
export function solPatternGate(srcUnits: Unit[], testUnits: Unit[], o: { module?: boolean } = {}): GateResult {
  const out: string[] = [];
  for (const u of srcUnits) {
    for (const n of nodes(u.ast)) {
      const where = at(u, n);
      if (o.module && n.nodeType === "VariableDeclaration" && n.stateVariable === true && n.mutability !== "constant") out.push(`${where}: a storage variable (a module keeps no state)`);
      if (n.nodeType === "InlineAssembly") out.push(`${where}: inline assembly`);
      if (n.nodeType === "UncheckedBlock") out.push(`${where}: unchecked block`);
      if (n.nodeType === "NewExpression" && (n.typeName as Ast)?.nodeType !== "ArrayTypeName") out.push(`${where}: creates a contract with new`);
      if (n.nodeType === "VariableDeclaration" && n.mutability === "immutable") out.push(`${where}: an immutable (the game's code hash must be known before it is deployed)`);
      if (n.nodeType === "FunctionDefinition" && (n.kind === "receive" || n.kind === "fallback")) out.push(`${where}: ${n.kind} function`);
      if (n.nodeType === "Identifier" && ["selfdestruct", "suicide", "blockhash"].includes(String(n.name))) out.push(`${where}: ${n.name}`);
      if (n.nodeType === "MemberAccess") {
        const m = String(n.memberName);
        const base = n.expression as Ast;
        if (base?.nodeType === "Identifier" && base.name === "tx" && m === "origin") out.push(`${where}: tx.origin`);
        if (base?.nodeType === "Identifier" && base.name === "block" && (m === "prevrandao" || m === "difficulty")) out.push(`${where}: block.${m}`);
        if (LOW_LEVEL.has(m) && /^address/.test(typeOf(base))) out.push(`${where}: low-level .${m}`);
        if (m === "delegatecall" || m === "callcode") out.push(`${where}: ${m}`);
      }
      if (n.nodeType === "FunctionCall" && /\bexternal\b/.test(typeOf(n.expression))) out.push(`${where}: external call ${String((n.expression as Ast).memberName ?? "")}`.trimEnd());
      if (n.nodeType === "EmitStatement" && ((n.eventCall as Ast)?.expression as Ast)?.name === "Played") out.push(`${where}: emits Played itself (use _played)`);
      // the game's own files are the tests' imports: a function there named like a banned cheatcode (an interface's) is
      // a way for a test to call the cheatcode outside the Vm type
      if (n.nodeType === "FunctionDefinition" && BANNED_CHEATS.test(String(n.name))) out.push(`${where}: declares a function named like a banned cheatcode (${n.name})`);
    }
  }
  for (const u of testUnits) {
    for (const n of nodes(u.ast)) {
      const where = at(u, n);
      if (n.nodeType === "InlineAssembly") out.push(`${where}: inline assembly in a test`);
      if (n.nodeType === "MemberAccess") {
        const m = String(n.memberName);
        if (VM_TYPE.test(typeOf(n.expression)) && BANNED_CHEATS.test(m)) out.push(`${where}: cheatcode vm.${m}`);
        // a module's tests may not fake what the module answers or rewrite code or storage under the suite
        if (o.module && VM_TYPE.test(typeOf(n.expression)) && /^(mockCall\w*|mockFunction|etch|store)$/.test(m)) out.push(`${where}: cheatcode vm.${m} in a module's test`);
        if (LOW_LEVEL.has(m) && m !== "transfer" && /^address/.test(typeOf(n.expression))) out.push(`${where}: low-level .${m} in a test`);
      }
      if (n.nodeType === "Literal") {
        const v = String(n.value ?? "");
        if (v.includes("://")) out.push(`${where}: a URL in a test`);
        if (v.toLowerCase().includes(HEVM.slice(2)) || String(n.hexValue ?? "").toLowerCase() === HEVM.slice(2)) out.push(`${where}: the cheatcode address`);
        if (/hevm cheat code/i.test(v)) out.push(`${where}: the cheatcode address's seed`);
      }
      // the cheatcode contract reached another way: converted to an address, or re-declared under a banned name
      if (n.nodeType === "FunctionCall" && n.kind === "typeConversion" && ((n.arguments as Ast[]) ?? []).some((a) => VM_TYPE.test(typeOf(a)))) out.push(`${where}: the cheatcode contract converted (address(vm))`);
      if (n.nodeType === "FunctionDefinition" && BANNED_CHEATS.test(String(n.name))) out.push(`${where}: declares a function named like a banned cheatcode (${n.name})`);
      // forge-std's own deployCode/deployCodeTo helpers (StdCheats), called without vm.
      if (n.nodeType === "Identifier" && /^deployCode\w*$/.test(String(n.name))) out.push(`${where}: deploys code from an artifact (${n.name})`);
      // a URL or path assembled from pieces
      if (n.nodeType === "FunctionCall") {
        const e = n.expression as Ast;
        const base = e?.expression as Ast | undefined; // abi.encodePacked: an Identifier; string.concat: an elementary type name
        const name = `${base?.name ?? ((base?.typeName as Ast)?.name ?? "")}.${e?.memberName ?? ""}`;
        if ((name === "string.concat" || name === "abi.encodePacked" || name === "bytes.concat") && ((n.arguments as Ast[]) ?? []).some((a) => a.nodeType === "Literal" && /:$|^\/\//.test(String(a.value ?? "")))) out.push(`${where}: a URL assembled with ${name}`);
      }
    }
  }
  return gate("G3", "Solidity patterns", out);
}

// ---------------------------------------------------------------- G4 bytecode

const BANNED_OPS = new Set([0xf0, 0xf2, 0xf4, 0xf5, 0xff]);
/** A module also writes nothing, calls nothing and reads nothing of its environment: SSTORE, TSTORE, LOG0-LOG4, CALL,
 *  STATICCALL; BALANCE, ORIGIN, CALLER, GASPRICE, EXTCODESIZE, EXTCODECOPY, EXTCODEHASH, the block opcodes (BLOCKHASH
 *  to BLOBBASEFEE) and GAS. Not CALLVALUE: solc reads it in every non-payable function (G5 refuses a payable one). */
export const MODULE_OPS = new Set([...BANNED_OPS, 0x55, 0x5d, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xf1, 0xfa, 0x31, 0x32, 0x33, 0x3a, 0x3b, 0x3c, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x5a]);
/** The same walk as GameFactory.banned: CREATE, CALLCODE, DELEGATECALL, CREATE2, SELFDESTRUCT outside PUSH data. */
export function bannedOpcode(code: Hex | string, banned: Set<number> = BANNED_OPS): number | null {
  const b = Buffer.from(code.replace(/^0x/, ""), "hex");
  for (let i = 0; i < b.length;) {
    const op = b[i];
    if (banned.has(op)) return i;
    i += op >= 0x60 && op <= 0x7f ? op - 0x5e : 1;
  }
  return null;
}
export const MAX_CODE = 24_576;
/** G4: the deployed code has no banned opcode (the factory would refuse it) and fits the size limit; a module's, none of
 *  MODULE_OPS (G3 refuses its immutables: its code hash must be its compiled runtime). */
export function bytecodeGate(deployed: Hex | string, o: { module?: boolean; links?: number } = {}): GateResult {
  const out: string[] = [];
  // a library placeholder (__$…$__) or other text would cut the opcode walk short: only plain bytecode is read
  if (!/^(0x)?([0-9a-fA-F]{2})*$/.test(deployed)) return gate("G4", "bytecode", ["not plain bytecode (a library placeholder or other text)"]);
  if (o.links) out.push(`${o.links} library link reference(s): the code must stand alone`);
  const at = bannedOpcode(deployed, o.module ? MODULE_OPS : BANNED_OPS);
  if (at !== null) out.push(`banned opcode 0x${Buffer.from(deployed.replace(/^0x/, ""), "hex")[at].toString(16)} at byte ${at} (a long constant can hold such a byte: use custom errors and short constants)`);
  const size = deployed.replace(/^0x/, "").length / 2;
  if (size > MAX_CODE) out.push(`${size} bytes (max ${MAX_CODE})`);
  if (size === 0) out.push("no deployed code");
  return gate("G4", "bytecode", out);
}

// ---------------------------------------------------------------- G5 ABI / structure

type AbiItem = { type: string; name?: string; stateMutability?: string; inputs?: { type: string; components?: unknown[] }[] };
const sig = (f: AbiItem) => `${f.name}(${(f.inputs ?? []).map((i) => i.type).join(",")})`;
/** What the order's spec, the game's SPEC.json, says the build is. */
export type Spec = { spec: string; specSha256: string; interface: string[]; files: string[] };
export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** A game's interface as SPEC.json lists it: its compiled ABI's functions beyond the kit's, sorted. The build writes it
 *  from its own compile; G5 checks it against the enclave's. */
export function gameInterface(abi: AbiItem[], kitAbi: AbiItem[]): string[] {
  const kit = new Set(kitAbi.filter((f) => f.type === "function").map(sig));
  return [...new Set(abi.filter((f) => f.type === "function" && !kit.has(sig(f))).map(sig))].sort();
}

/** G5: exactly one deployable contract, and it inherits GameKit (every kit function in its ABI); nothing payable but the
 *  kit's fund(); no receive/fallback; no function named like selfdestruct; SPEC.json's interface is exactly the ABI's
 *  functions beyond the kit's; SPEC.json carries the order's spec. */
export function abiGate(o: { srcUnits: Unit[]; kitId: number; abi: AbiItem[]; kitAbi: AbiItem[]; spec: Spec | null; orderSpecSha256: string; changed: string[] }): GateResult {
  const out: string[] = [];
  const deployable = o.srcUnits.flatMap((u) => nodes(u.ast).filter((n) => n.nodeType === "ContractDefinition" && n.contractKind === "contract" && !n.abstract));
  if (deployable.length !== 1) out.push(`${deployable.length} deployable contracts in the game's sources (exactly 1)`);
  else if (!(deployable[0].linearizedBaseContracts as number[]).includes(o.kitId)) out.push(`${deployable[0].name} does not inherit GameKit`);
  const kit = new Set(o.kitAbi.filter((f) => f.type === "function").map(sig));
  // a list only: a string would match by substring
  const listed: string[] = Array.isArray(o.spec?.interface) ? o.spec.interface : [];
  for (const f of o.abi) {
    if (f.type === "receive" || f.type === "fallback") out.push(`${f.type} in the ABI`);
    if (f.type !== "function") continue;
    if (f.stateMutability === "payable" && sig(f) !== "fund()") out.push(`${sig(f)} is payable`);
    if (/self_?destruct|suicide/i.test(f.name ?? "")) out.push(`${sig(f)} is named like selfdestruct`);
    if (!kit.has(sig(f)) && !listed.includes(sig(f))) out.push(`${sig(f)} is not in SPEC.json's interface`);
  }
  const abi = new Set(o.abi.filter((f) => f.type === "function").map(sig));
  for (const k of kit) if (!abi.has(k)) out.push(`${k} of the kit is not in the ABI`);
  for (const s of listed) if (!abi.has(s)) out.push(`${s} is in SPEC.json's interface but not in the ABI`);
  if (!o.spec) out.push("no SPEC.json");
  else {
    if (o.spec.specSha256 !== o.orderSpecSha256) out.push("SPEC.json's specSha256 is not the order's");
    if (sha256(o.spec.spec) !== o.spec.specSha256) out.push("SPEC.json's spec text does not hash to its specSha256");
    const listed = new Set(o.spec.files);
    for (const p of o.changed) if (!listed.has(p) && !p.endsWith("/SPEC.json")) out.push(`${p} is not in SPEC.json's files`);
  }
  return gate("G5", "ABI and structure", out);
}

// ---------------------------------------------------------------- G5 for a module

export type ModuleKind = "fee" | "split";
/** A module's SPEC.json: the order's spec, its kind, its files, and the bounds proposed to the Safe (each a list of four
 *  decimal words: lowest, highest, and the params it starts with). */
export type ModuleSpec = { spec: string; specSha256: string; module: ModuleKind; interface: string[]; files: string[]; bounds: { min: string[]; max: string[]; start: string[] } };
export const MODULE_FN: Record<ModuleKind, string> = { fee: "projectFee", split: "split" };
const word = (s: unknown) => (typeof s === "string" && /^\d{1,78}$/.test(s) && BigInt(s) < 2n ** 256n ? BigInt(s) : null);
/** The bounds in a SPEC.json as words, or why they can't be. */
export function specBounds(b: unknown): { min: bigint[]; max: bigint[]; start: bigint[] } | string {
  const x = b as { min?: unknown[]; max?: unknown[]; start?: unknown[] } | null;
  const parse = (a: unknown[] | undefined) => (Array.isArray(a) && a.length === 4 ? a.map(word) : null);
  const [min, max, start] = [parse(x?.min), parse(x?.max), parse(x?.start)];
  if (!min || !max || !start || [...min, ...max, ...start].some((v) => v === null)) return "bounds: min, max and start, four decimal words each";
  for (let i = 0; i < 4; i++) if (!(min[i]! <= start[i]! && start[i]! <= max[i]!)) return `bounds: param ${i} is not lowest ≤ start ≤ highest`;
  return { min: min as bigint[], max: max as bigint[], start: start as bigint[] };
}

/** G5 for a module: exactly one deployable contract, implementing IFeePolicy or ISplitPolicy (the one SPEC.json names);
 *  its ABI is that one function, pure, and no constructor input (nothing to fill in at deploy, so its code hash
 *  is known now); SPEC.json carries the order's spec, every file and the bounds to propose. */
export function moduleAbiGate(o: { srcUnits: Unit[]; testUnits?: Unit[]; ifaceIds: Record<ModuleKind, number | undefined>; abi: AbiItem[]; spec: ModuleSpec | null; orderSpecSha256: string; changed: string[] }): GateResult {
  const out: string[] = [];
  const deployable = o.srcUnits.flatMap((u) => nodes(u.ast).filter((n) => n.nodeType === "ContractDefinition" && n.contractKind === "contract" && !n.abstract));
  if (deployable.length !== 1) out.push(`${deployable.length} deployable contracts in the module's sources (exactly 1)`);
  // a test contract that inherits the module could stand in for it (override its function) in front of the suite
  const mainId = deployable[0]?.id as number | undefined;
  for (const u of o.testUnits ?? []) for (const n of nodes(u.ast)) {
    if (mainId !== undefined && n.nodeType === "ContractDefinition" && n.id !== mainId && ((n.linearizedBaseContracts as number[]) ?? []).includes(mainId)) out.push(`${u.file}: ${n.name} inherits the module`);
  }
  const bases = (deployable[0]?.linearizedBaseContracts as number[] | undefined) ?? [];
  const is = (Object.keys(MODULE_FN) as ModuleKind[]).filter((k) => o.ifaceIds[k] !== undefined && bases.includes(o.ifaceIds[k]!));
  if (deployable.length === 1 && is.length !== 1) out.push(`${deployable[0].name} must implement exactly one of IFeePolicy and ISplitPolicy`);
  const fn = is.length === 1 ? MODULE_FN[is[0]] : undefined;
  for (const f of o.abi) {
    if (f.type === "receive" || f.type === "fallback") out.push(`${f.type} in the ABI`);
    if (f.type === "constructor" && (f.inputs ?? []).length) out.push("a constructor with inputs (the code hash must be known before it is deployed)");
    if (f.type !== "function") continue;
    if (f.name !== fn) out.push(`${sig(f)}: a module's ABI is its one policy function`);
    else if (f.stateMutability !== "pure") out.push(`${sig(f)} is ${f.stateMutability} (pure only: a module reads nothing but its inputs)`);
  }
  if (fn && !o.abi.some((f) => f.type === "function" && f.name === fn)) out.push(`no ${fn}`);
  if (!o.spec) out.push("no SPEC.json");
  else {
    if (o.spec.specSha256 !== o.orderSpecSha256) out.push("SPEC.json's specSha256 is not the order's");
    if (sha256(o.spec.spec ?? "") !== o.spec.specSha256) out.push("SPEC.json's spec text does not hash to its specSha256");
    if (o.spec.module !== "fee" && o.spec.module !== "split") out.push("SPEC.json's module: fee or split");
    else if (is.length === 1 && is[0] !== o.spec.module) out.push(`SPEC.json says a ${o.spec.module} module, the contract is a ${is[0]} module`);
    const b = specBounds(o.spec.bounds);
    if (typeof b === "string") out.push(`SPEC.json's ${b}`);
    const listed = new Set(o.spec.files ?? []);
    for (const p of o.changed) if (!listed.has(p) && !p.endsWith("/SPEC.json")) out.push(`${p} is not in SPEC.json's files`);
  }
  return gate("G5", "ABI and structure", out);
}

// ---------------------------------------------------------------- G11 web

/** A game's page folder holds only these: its page, its components (PascalCase), CSS modules, game.json. */
const FILE_OK = /^(page\.tsx|game\.json|[A-Za-z0-9_-]+\.module\.css|[A-Z][A-Za-z0-9]*\.tsx)$/;
/** Every Next file convention (any extension, any case): none may appear in a game's folder. */
const NEXT_FILES = /^(opengraph-image|twitter-image|icon|apple-icon|favicon|sitemap|robots|manifest|global-error|global-not-found|forbidden|unauthorized|route|layout|template|loading|error|not-found|default|middleware|proxy|instrumentation(-client)?)(\.|$)/i;
const BANNED_IDS = new Set([
  "window", "globalThis", "self", "top", "parent", "opener", "frames", "document", "view", "cookie", "cookieStore", "localStorage", "sessionStorage",
  "indexedDB", "serviceWorker", "postMessage", "eval", "Function", "Reflect", "Proxy", "constructor", "__proto__", "prototype", "atob", "btoa",
  "fromCharCode", "fromCodePoint", "location", "history", "iframe", "frame", "srcdoc", "srcDoc", "contentWindow", "contentDocument", "defaultView",
  "ownerDocument", "open", "WebSocket", "EventSource", "XMLHttpRequest", "fetch", "sendBeacon", "Worker", "SharedWorker", "importScripts",
  "require", "process", "dangerouslySetInnerHTML", "innerHTML", "outerHTML", "insertAdjacentHTML", "createElement", "appendChild", "setAttribute",
  "write", "clipboard", "ethereum", "web3", "unescape", "decodeURIComponent", "escape",
  "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel",
]);
/** Banned globals that are also plain local names (a menu's `open` state): allowed where the name is a local binding
 *  (a variable, parameter, function or array-destructured element) or a reference to one bound in an enclosing scope
 *  of the same file. Never a member (x.open), a destructured property ({ open } = x) or an unbound reference (the
 *  global itself). */
const LOCAL_OK = new Set(["open"]);
/** The plain names a binding declares: an identifier, or an array pattern's elements (an object pattern reads members). */
const boundNames = (b: ts.BindingName): string[] =>
  ts.isIdentifier(b) ? [b.text] : ts.isArrayBindingPattern(b) ? b.elements.flatMap((e) => (ts.isBindingElement(e) && !e.dotDotDotToken ? boundNames(e.name) : [])) : [];
const declaresHere = (scope: ts.Node, name: string): boolean => {
  const vars = (l: ts.VariableDeclarationList | undefined) => !!l && l.declarations.some((d) => boundNames(d.name).includes(name));
  if (ts.isFunctionLike(scope) && (scope.parameters.some((p) => boundNames(p.name).includes(name)) || (ts.isFunctionExpression(scope) && scope.name?.text === name))) return true;
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
    return scope.statements.some((st) => (ts.isVariableStatement(st) && vars(st.declarationList)) || (ts.isFunctionDeclaration(st) && st.name?.text === name));
  }
  if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) return vars(scope.initializer);
  if (ts.isCatchClause(scope)) return !!scope.variableDeclaration && boundNames(scope.variableDeclaration.name).includes(name);
  return false;
};
/** `id` declares a local of that name, or refers to one in an enclosing scope. */
function localName(id: ts.Identifier): boolean {
  const p = id.parent;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p)) && p.name === id) return true;
  if (ts.isBindingElement(p) && p.name === id) return ts.isArrayBindingPattern(p.parent);
  // a member name, a property key or a destructured property is not a local
  if ((ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isPropertyAssignment(p) && p.name === id) || ts.isBindingElement(p)) return false;
  for (let a: ts.Node | undefined = p; a; a = a.parent) if (declaresHere(a, id.text)) return true;
  return false;
}
const BANNED_TAGS = new Set(["iframe", "frame", "frameset", "script", "meta", "link", "base", "object", "embed", "form", "portal", "applet"]);
const BANNED_ATTRS = new Set(["httpEquiv", "formAction", "ping", "srcDoc", "dangerouslySetInnerHTML"]);
const BANNED_STRINGS = [/eth_/i, /wallet_/i, /personal_sign/i, /\bapprove\b/i, /\bpermit\b/i, /setapprovalforall/i, /increaseallowance/i, /:\/\//, /^\s*\/\//, /javascript:/i, /<script/i, /use server/i, /data:[a-z]+\/[a-z0-9.+-]+[;,]/i, /eip6963/i];
/** A site page has no wallet at all (G15 refuses any request to one), so plain words like "approve" are just words. */
const SITE_STRINGS = BANNED_STRINGS.filter((re) => !/approve|permit/.test(re.source));
const ADDRESS = /0x[0-9a-fA-F]{40}/;
/** A game's page files together, in UTF-8 bytes: about 12× the largest template (game.json's ABI is most of it). */
const MAX_PAGE = 200_000;

/** G11: the static tripwire on the game's page. Only page.tsx, PascalCase components, CSS modules and game.json, at most
 *  MAX_PAGE bytes together, and no Next file convention; every .tsx starts with "use client" (game code never runs on the server); page.tsx exports
 *  only its default; no reach for globals, the wallet, the network, frames, eval, storage or the DOM's HTML sinks; no
 *  computed member access (only a numeric literal key); no tags that load, navigate or post (meta, link, base, object,
 *  embed, form, frames, scripts) and no attributes that do; no strings (template parts included) naming wallet methods,
 *  approvals, URLs (protocol-relative too) or addresses (game.json holds the one address). G15 and the CSP stand behind
 *  it. A site change's code is held to the same reach rules, but may run on the server (no "use client" needed), its
 *  page.tsx may also export its metadata, and its file names are G1's. */
export function webGate(files: Record<string, string>, slug: string, kind: Kind = "game"): GateResult {
  const out: string[] = [];
  const site = kind === "site";
  const web = site ? "web/app/" : roots(slug)[2];
  if (!site) {
    const total = Object.entries(files).reduce((s, [path, text]) => s + (path.startsWith(web) ? Buffer.byteLength(text) : 0), 0);
    if (total > MAX_PAGE) out.push(`${web}: ${total} bytes in its files (max ${MAX_PAGE})`);
  }
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith(web)) continue;
    const name = site ? posix.basename(path) : path.slice(web.length);
    if (site && !/\.(tsx?|css)$/.test(name)) continue;
    if (!site && (NEXT_FILES.test(name) || !FILE_OK.test(name))) { out.push(`${path}: not page.tsx, a PascalCase component, a CSS module or game.json`); continue; }
    if (name.endsWith(".css")) {
      if (/@import|url\s*\(|expression\s*\(|behavior\s*:|-moz-binding/i.test(text)) out.push(`${path}: CSS @import, url(), expression or binding`);
      continue;
    }
    if (name === "game.json") {
      const issue = gameJsonShape(text);
      if (issue) out.push(`${path}: ${issue}`);
      continue;
    }
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, name.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
    const where = (n: ts.Node) => `${path}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const first = sf.statements[0];
    if (!site && (!first || !ts.isExpressionStatement(first) || !ts.isStringLiteral(first.expression) || first.expression.text !== "use client")) out.push(`${path}: must start with "use client" (game code never runs on the server)`);
    if (name === "page.tsx") {
      for (const st of sf.statements) {
        const named = (ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && !(ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) || ts.isExportDeclaration(st);
        const metadata = site && ts.isVariableStatement(st) && st.declarationList.declarations.every((x) => ts.isIdentifier(x.name) && x.name.text === "metadata");
        if (named && !metadata) out.push(`${where(st)}: page.tsx exports only its default${site ? " and its metadata" : ""} (no route segment config)`);
      }
    }
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
        // an attribute's name on a site page (<details open>) reaches no global; its value is still read
        const attrName = site && ts.isJsxAttribute(n.parent) && n.parent.name === n;
        const local = LOCAL_OK.has(n.text) && ts.isIdentifier(n) && localName(n);
        if (BANNED_IDS.has(n.text) && !attrName && !local) out.push(`${where(n)}: ${n.text}`);
      } else if (ts.isStringLiteralLike(n) || ts.isJsxText(n) || n.kind === ts.SyntaxKind.TemplateHead || n.kind === ts.SyntaxKind.TemplateMiddle || n.kind === ts.SyntaxKind.TemplateTail) {
        const s = (n as ts.LiteralLikeNode).text;
        for (const re of site ? SITE_STRINGS : BANNED_STRINGS) if (re.test(s)) out.push(`${where(n)}: string matching ${re}`);
        if (ADDRESS.test(s)) out.push(`${where(n)}: an address literal (only game.json holds the game's address)`);
      } else if (ts.isNumericLiteral(n) || ts.isBigIntLiteral(n)) {
        if (/^0x[0-9a-f]{30,}/i.test(n.text)) out.push(`${where(n)}: a long hex literal`);
      } else if (n.kind === ts.SyntaxKind.ImportKeyword && ts.isCallExpression(n.parent)) {
        out.push(`${where(n)}: dynamic import()`);
      } else if (ts.isElementAccessExpression(n)) {
        if (!ts.isNumericLiteral(n.argumentExpression)) out.push(`${where(n)}: computed member access (only a numeric literal key)`);
      } else if (ts.isTaggedTemplateExpression(n)) {
        out.push(`${where(n)}: tagged template`);
      } else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        // intrinsic elements only (lowercase, as React reads them); a capitalised tag is a component, e.g. next/link's <Link>
        const tag = n.tagName.getText(sf);
        if (/^[a-z]/.test(tag) && BANNED_TAGS.has(tag)) out.push(`${where(n)}: <${tag}>`);
      } else if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name)) {
        if (BANNED_ATTRS.has(n.name.text)) out.push(`${where(n)}: attribute ${n.name.text}`);
        if (/^on[A-Z]/.test(n.name.text) && n.initializer && ts.isStringLiteral(n.initializer)) out.push(`${where(n)}: inline event handler string`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return gate("G11", "web page", out);
}

/** game.json: what the page and tx.ts need, nothing else. */
export type GameJson = { slug: string; title: string; chainId: 1; address: Address; codehash: Hex; abi: AbiItem[] };
export function gameJsonShape(text: string): string | null {
  let j: Record<string, unknown>;
  try { j = JSON.parse(text); } catch { return "not JSON"; }
  const keys = Object.keys(j).sort().join(",");
  if (keys !== "abi,address,chainId,codehash,slug,title") return `keys must be exactly abi, address, chainId, codehash, slug, title (got ${keys})`;
  if (j.chainId !== 1) return "chainId must be 1";
  if (typeof j.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(j.address)) return "address";
  if (typeof j.codehash !== "string" || !/^0x[0-9a-f]{64}$/.test(j.codehash)) return "codehash";
  if (typeof j.title !== "string" || j.title.length > 60 || publicTextIssues(j.title).length) return "title";
  if (!Array.isArray(j.abi)) return "abi";
  return null;
}

// ---------------------------------------------------------------- G12 text and secrets

const BANNED_WORDS = /\b(delve|tapestry|testament|seamless(ly)?|leverag(e|es|ing)|cutting-edge|game-changer|revolutionary|unleash|elevate|in conclusion|furthermore|moreover|robust)\b/i;
const SECRETS = [/sk-ant-[A-Za-z0-9_-]{8,}/, /sk-or-[A-Za-z0-9_-]{8,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bgh[su]_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bxai-[A-Za-z0-9]{20,}/];

/** G12: the PR body is short plain English (≤ 120 words, no links, handles, cashtags, em dashes or stock AI words),
 *  and no file carries a key-shaped string. */
export function textGate(prBody: string, files: Record<string, string>): GateResult {
  const out: string[] = [];
  const words = prBody.trim().split(/\s+/).filter(Boolean).length;
  if (words > 120) out.push(`PR body is ${words} words (max 120)`);
  for (const i of publicTextIssues(prBody)) out.push(`PR body: ${i}`);
  if (/[—–]/.test(prBody)) out.push("PR body: dash punctuation (use plain sentences)");
  const w = prBody.match(BANNED_WORDS);
  if (w) out.push(`PR body: stock wording "${w[0]}"`);
  for (const [path, text] of Object.entries({ "PR body": prBody, ...files })) for (const re of SECRETS) if (re.test(text)) out.push(`${path}: a key-shaped string`);
  return gate("G12", "text and secrets", out);
}

// ---------------------------------------------------------------- engine changes: G2's code checks, G16 reach

const tsFile = (path: string, text: string) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const walk = (n: ts.Node, f: (n: ts.Node) => void) => { f(n); ts.forEachChild(n, (c) => walk(c, f)); };
/** Node's ways around the module system and the sandbox. */
const PROCESS_OFF = new Set(["binding", "_linkedBinding", "dlopen", "mainModule", "getBuiltinModule"]);

/** An engine file's code that G2 refuses: code run from strings and the ways to the globals (the page gate's eval,
 *  Function, __proto__, globalThis, Reflect, and `constructor` as a property), node internals (process.binding,
 *  _linkedBinding, dlopen, mainModule, getBuiltinModule), `process` anywhere but as `process.<name>` (no alias, no
 *  destructuring, no computed member: so every environment read is a plain `process.env.NAME` G16 can see) and
 *  import.meta other than its url. */
export function engineCodeIssues(path: string, text: string): string[] {
  const ids = new Set(["eval", "Function", "__proto__", "globalThis", "Reflect"].filter((x) => BANNED_IDS.has(x)));
  const sf = tsFile(path, text);
  const out: string[] = [];
  const where = (n: ts.Node) => `${path}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  walk(sf, (n) => {
    if (ts.isIdentifier(n) && ids.has(n.text)) out.push(`${where(n)}: ${n.text}`);
    if (ts.isPropertyAccessExpression(n) && n.name.text === "constructor") out.push(`${where(n)}: .constructor`);
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === "constructor") out.push(`${where(n)}: ["constructor"]`);
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "process" && PROCESS_OFF.has(n.name.text)) out.push(`${where(n)}: process.${n.name.text}`);
    // `process` only ever as the object of `process.<name>`
    if (ts.isIdentifier(n) && n.text === "process" && !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) out.push(`${where(n)}: process used other than as process.<name> (an alias, a destructuring or a computed member)`);
    // and process.env only as process.env.NAME (or a literal name)
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "process" && n.name.text === "env") {
      const p = n.parent;
      const named = (ts.isPropertyAccessExpression(p) && p.expression === n) || (ts.isElementAccessExpression(p) && p.expression === n && ts.isStringLiteralLike(p.argumentExpression));
      if (!named) out.push(`${where(n)}: process.env other than process.env.NAME`);
    }
    if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) {
      const p = n.parent;
      if (!(ts.isPropertyAccessExpression(p) && p.expression === n && p.name.text === "url")) out.push(`${where(n)}: import.meta other than its url`);
    }
  });
  return out;
}

/** What an engine file reaches, read from its code: the environment names it reads, its network sinks (fetch, sockets,
 *  node:http(s)/net/dns/tls/dgram, a postgres client, viem's http/webSocket transports, the dstack SDK), the URL hosts
 *  and host-like text it names, string building passed to a sink, node:fs/os, eval, and its calls into the watched
 *  modules. */
type Reach = {
  env: Set<string>; sinks: number; hosts: Set<string>; urls: Set<string>; hostish: Set<string>; built: string[];
  watched: Set<string>; calls: Map<string, number>; fsOs: Set<string>; evals: number;
};
const SINK_IDS = new Set(["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]);
const SINK_CALLS = new Set(["postgres", "http", "webSocket"]);
const SINK_MODULES = /^(node:(https?|http2|net|dns|tls|dgram)(\/|$)|@phala\/dstack-sdk)/;
const URLISH = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)]+/gi;
const HOSTISH = /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;
/** The modules whose use an owner should see: keys, config, sending, GitHub, the owners' channel, posts, the models,
 *  the enclave, approvals and the log. */
const WATCHED = new Set(["sealed", "signed", "config", "tx", "keepers", "github", "telegram", "x", "llm", "enclave", "approve", "log"]);
const moduleOf = (spec: string) => (spec.startsWith(".") ? posix.basename(spec).replace(/\.tsx?$/, "") : spec === "@phala/dstack-sdk" ? "dstack" : null);

function reachOf(path: string, text: string): Reach {
  const r: Reach = { env: new Set(), sinks: 0, hosts: new Set(), urls: new Set(), hostish: new Set(), built: [], watched: new Set(), calls: new Map(), fsOs: new Set(), evals: 0 };
  if (!text) return r;
  const sf = tsFile(path, text);
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  // local name → "module.export" for the watched modules' named imports
  const bound = new Map<string, string>();
  // every import, static or import("…"): sinks, node:fs/os, the watched modules
  for (const { spec } of tsImports(path, text)) {
    if (SINK_MODULES.test(spec)) r.sinks++;
    if (/^node:(fs|os)(\/|$)/.test(spec)) r.fsOs.add(spec);
    const m = moduleOf(spec);
    if (m && (WATCHED.has(m) || m === "dstack")) r.watched.add(m);
  }
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const m = moduleOf(st.moduleSpecifier.text);
    if (!m || !(WATCHED.has(m) || m === "dstack")) continue;
    const nb = st.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) bound.set(e.name.text, `${m}.${(e.propertyName ?? e.name).text}`);
    if (nb && ts.isNamespaceImport(nb)) bound.set(nb.name.text, `${m}.*`);
  }
  const call = (k: string) => r.calls.set(k, (r.calls.get(k) ?? 0) + 1);
  const literal = (n: ts.Node | undefined) => !!n && (ts.isStringLiteralLike(n) || ts.isNumericLiteral(n));
  walk(sf, (n) => {
    if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "process" && n.expression.name.text === "env") r.env.add(n.name.text);
    if (ts.isElementAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "process" && n.expression.name.text === "env") {
      r.env.add(ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : "<computed>");
    }
    if (ts.isIdentifier(n) && SINK_IDS.has(n.text)) r.sinks++;
    if (ts.isIdentifier(n) && (n.text === "eval" || n.text === "Function")) r.evals++;
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const sink = ts.isIdentifier(c) && (SINK_IDS.has(c.text) || SINK_CALLS.has(c.text));
      if (ts.isIdentifier(c) && SINK_CALLS.has(c.text)) r.sinks++;
      // a sink given a built string (a template or a concatenation) rather than a literal
      if (sink && n.arguments.length && !literal(n.arguments[0])) r.built.push(`${(c as ts.Identifier).text}(…) at line ${line(n)}`);
      if (ts.isIdentifier(c) && bound.has(c.text)) call(bound.get(c.text)!);
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && bound.get(c.expression.text)?.endsWith(".*")) call(`${bound.get(c.expression.text)!.slice(0, -2)}.${c.name.text}`);
      // (await import("./tx.ts")).send(…)
      if (ts.isPropertyAccessExpression(c)) {
        let e: ts.Expression = c.expression;
        while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
        if (ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword && e.arguments[0] && ts.isStringLiteralLike(e.arguments[0])) {
          const m = moduleOf(e.arguments[0].text);
          if (m && WATCHED.has(m)) { r.watched.add(m); call(`${m}.${c.name.text}`); }
        }
      }
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && SINK_IDS.has(n.expression.text) && n.arguments?.length && !literal(n.arguments[0])) r.built.push(`new ${n.expression.text}(…) at line ${line(n)}`);
    if (ts.isStringLiteralLike(n) || n.kind === ts.SyntaxKind.TemplateHead || n.kind === ts.SyntaxKind.TemplateMiddle || n.kind === ts.SyntaxKind.TemplateTail) {
      const t = (n as ts.LiteralLikeNode).text;
      for (const u of t.match(URLISH) ?? []) {
        r.urls.add(u);
        try { r.hosts.add(new URL(u).host.toLowerCase()); } catch { r.hosts.add(u.toLowerCase()); }
      }
      // host-like text that is not a file name the engine uses (x.ts, a.json)
      for (const h of t.replace(URLISH, " ").match(HOSTISH) ?? []) if (!/\.(ts|tsx|js|mjs|json|md|sql|sol|txt|png|svg|css|toml|yml|yaml|sh|env)$/i.test(h)) r.hostish.add(h.toLowerCase());
    }
  });
  return r;
}
/** Lines added and removed (as multisets: moved lines count as neither). */
function lineDelta(base: string, head: string) {
  const count = (t: string) => { const m = new Map<string, number>(); for (const l of t ? t.replace(/\n$/, "").split("\n") : []) m.set(l, (m.get(l) ?? 0) + 1); return m; };
  const a = count(base), b = count(head);
  let plus = 0, minus = 0;
  for (const [l, n] of b) plus += Math.max(0, n - (a.get(l) ?? 0));
  for (const [l, n] of a) minus += Math.max(0, n - (b.get(l) ?? 0));
  return { plus, minus };
}
/** Where a reviewer should start in one changed engine file; a pointer, not a guarantee: read the whole diff. */
export type Touch = {
  path: string; status: string; plus: number; minus: number;
  /** every watched module the file imports (not only new ones), and how its calls into them changed */
  imports: string[]; calls: Record<string, number>;
  /** environment names it newly reads; node:fs/os it newly imports; eval/Function; new URLs, new host-like text, and
   *  strings built for a sink */
  env: string[]; fsOs: string[]; evals: boolean; urls: string[]; hosts: string[]; built: string[];
};

/** G16 for an engine change, against the base: no environment name the file did not read before, no network sink in a
 *  file that had none, no URL host the file did not name before. And the touch report, for the brain and the owner. */
export function engineReachGate(changes: Change[], files: Record<string, string>, baseFiles: Record<string, string>): { result: GateResult; touch: Touch[] } {
  const out: string[] = [];
  const touch: Touch[] = [];
  for (const c of changes) {
    const head = c.status === "D" ? "" : files[c.path] ?? "";
    const base = baseFiles[c.oldPath ?? c.path] ?? "";
    if (!c.path.endsWith(".ts")) { touch.push({ path: c.path, status: c.status, ...lineDelta(base, head), imports: [], calls: {}, env: [], fsOs: [], evals: false, urls: [], hosts: [], built: [] }); continue; }
    const [h, b] = [reachOf(c.path, head), reachOf(c.path, base)];
    const env = [...h.env].filter((x) => !b.env.has(x)).sort();
    if (env.length) out.push(`${c.path}: new environment reads (${env.join(", ")})`);
    if (b.sinks === 0 && h.sinks > 0) out.push(`${c.path}: a network sink in a file that had none (fetch, sockets, node:http(s)/net/dns/tls/dgram, a database client, an RPC transport, the dstack SDK)`);
    for (const host of h.hosts) if (!b.hosts.has(host)) out.push(`${c.path}: a new URL host ${JSON.stringify(host.slice(0, 80))}`);
    const calls: Record<string, number> = {};
    for (const k of new Set([...h.calls.keys(), ...b.calls.keys()])) {
      const d = (h.calls.get(k) ?? 0) - (b.calls.get(k) ?? 0);
      if (d) calls[k] = d;
    }
    touch.push({
      path: c.path, status: c.status, ...lineDelta(base, head), imports: [...h.watched].sort(), calls, env,
      fsOs: [...h.fsOs].filter((m) => !b.fsOs.has(m)).sort(), evals: h.evals > 0,
      urls: [...h.urls].filter((u) => !b.urls.has(u)).slice(0, 10), hosts: [...h.hostish].filter((x) => !b.hostish.has(x)).slice(0, 10), built: h.built.slice(0, 10),
    });
  }
  return { result: gate("G16", "engine reach", out), touch };
}
/** The touch report in a few lines (the owners' alert). A pointer to start from, not a guarantee. */
export const touchLines = (t: Touch[]) => t.map((x) => [
  `${x.path} +${x.plus}/-${x.minus}`,
  x.imports.length ? `uses ${x.imports.join(", ")}` : "",
  Object.keys(x.calls).length ? `calls ${Object.entries(x.calls).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", ")}` : "",
  x.env.length ? `new env ${x.env.join(", ")}` : "", x.fsOs.length ? x.fsOs.join(", ") : "", x.evals ? "eval/Function" : "",
  x.urls.length ? `URLs ${x.urls.join(" ")}` : "", x.hosts.length ? `hosts ${x.hosts.join(" ")}` : "", x.built.length ? `built for a sink: ${x.built.join(", ")}` : "",
].filter(Boolean).join("; "));

// ---------------------------------------------------------------- G13 address

/** The code the chain will hold for a contract whose only immutables are GameKit's: `factory` and `safe` written in
 *  (each a 32-byte word: the address left-padded), so its hash is the on-chain extcodehash, the one GameDeployed, the
 *  watchdog and the page's helper see. Null when the code has another immutable. */
export function runtimeOf(deployed: Hex, refs: Record<string, { start: number; length: number }[]>, values: Record<string, Hex>): Hex | null {
  const b = Buffer.from(deployed.replace(/^0x/, ""), "hex");
  for (const [id, places] of Object.entries(refs ?? {})) {
    const v = values[id];
    if (!v) return null;
    const word = Buffer.from(v.replace(/^0x/, "").padStart(64, "0"), "hex");
    for (const p of places) word.copy(b, p.start, 32 - p.length);
  }
  return `0x${b.toString("hex")}`;
}

/** G13: game.json names the address the factory will deploy the enclave's compile to, and the hash of the code it
 *  will hold there (immutables written in). */
export function addressGate(game: GameJson | null, o: { factory: Address; salt: Hex; initCode: Hex; runtime: Hex | null; slug: string }): GateResult {
  if (!game) return gate("G13", "address", ["no game.json"]);
  const out: string[] = [];
  const want = getContractAddress({ opcode: "CREATE2", from: o.factory, salt: o.salt, bytecode: o.initCode });
  if (getAddress(game.address) !== want) out.push(`game.json address ${game.address} is not the factory's ${want}`);
  if (!o.runtime) out.push("the code has immutables other than the kit's: its hash can't be known before deploy");
  else if (game.codehash.toLowerCase() !== keccak256(o.runtime)) out.push("game.json codehash is not the deployed code's hash");
  if (game.slug !== o.slug) out.push("game.json slug");
  return gate("G13", "address", out);
}

// ---------------------------------------------------------------- G14 identity (enclave)

export type PrFacts = {
  headRepo: string; baseRepo: string; author: string; headRef: string; headSha: string;
  commits: { sha: string; parents: string[]; author: string; committer: string; verified: boolean }[];
};
const GITHUB_COMMITTER = "web-flow";
/** G14: the PR is the bot's, from this repo, on the order's branch, at the sha that was gated, and is exactly one
 *  signed commit by the bot (committed by the bot or by GitHub for it) on top of the order's base. */
export function identityGate(pr: PrFacts, o: { orderId: string; round: number; baseSha: string; gatedSha: string; bot: string }): GateResult {
  const out: string[] = [];
  if (pr.headRepo !== pr.baseRepo) out.push("the PR comes from a fork");
  if (pr.author !== o.bot) out.push(`opened by ${pr.author}, not the bot`);
  if (pr.headRef !== `seq/${o.orderId}-r${o.round}`) out.push(`branch ${pr.headRef} is not the order's`);
  if (pr.headSha !== o.gatedSha) out.push("the head moved since it was gated");
  if (pr.commits.length !== 1) out.push(`${pr.commits.length} commits (exactly 1)`);
  const c = pr.commits[0];
  if (c) {
    if (c.sha !== pr.headSha) out.push("the commit is not the head");
    if (c.parents.length !== 1 || c.parents[0] !== o.baseSha) out.push("the commit's parent is not the order's base");
    if (c.author !== o.bot) out.push(`the commit's author ${c.author} is not the bot`);
    // a commit the bot makes through the API is committed by GitHub (web-flow): accepted only for the bot's own signed commit
    const byGitHub = c.committer === GITHUB_COMMITTER && c.author === o.bot && c.verified;
    if (c.committer !== o.bot && !byGitHub) out.push(`the commit's committer ${c.committer} is not the bot, nor GitHub for the bot's signed commit`);
    if (!c.verified) out.push("the commit is not signed by GitHub for the bot");
  }
  return gate("G14", "identity", out);
}

// ---------------------------------------------------------------- G7 mutation sites

export type Mutant = { file: string; at: number; from: string; to: string; what: string };
const FLIP: Record<string, string> = { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "==": "!=", "!=": "==", "+": "-", "-": "+", "&&": "||", "||": "&&" };
/** Up to `n` deterministic planted bugs in the game's sources (operator flips, dropped requires and revert guards),
 *  chosen by the gated sha. Each is a text edit at a source offset. */
export function mutants(units: Unit[], seed: string, n = 8, o: { views?: boolean } = {}): Mutant[] {
  const all: Mutant[] = [];
  for (const u of units) {
    const off = (src: unknown) => String(src).split(":").map(Number);
    const code = solCodeBytes(u.text);
    // no planted bug where no test could see it: inside an event's arguments, or in a view or pure function
    const skip = nodes(u.ast).filter((x) => x.nodeType === "EmitStatement" || (!o.views && x.nodeType === "FunctionDefinition" && (x.stateMutability === "view" || x.stateMutability === "pure"))).map((x) => off(x.src));
    const skipped = (at: number) => skip.some(([s, l]) => at >= s && at < s + l);
    for (const x of nodes(u.ast)) {
      if (x.nodeType === "BinaryOperation" && FLIP[String(x.operator)]) {
        const [ls, ll] = off((x.leftExpression as Ast).src);
        const [rs] = off((x.rightExpression as Ast).src);
        const gap = code.subarray(ls + ll, rs).toString("latin1"); // byte offsets, comments and strings blanked
        const i = gap.indexOf(String(x.operator));
        if (i >= 0 && !skipped(ls + ll + i)) all.push({ file: u.file, at: ls + ll + i, from: String(x.operator), to: FLIP[String(x.operator)], what: `${x.operator} → ${FLIP[String(x.operator)]}` });
      }
      // a dropped check: the require's condition becomes true, the revert guard's condition false (Solidity has no
      // empty statement, so the text stays a statement)
      const call = x.nodeType === "ExpressionStatement" ? (x.expression as Ast) : null;
      if (call?.nodeType === "FunctionCall" && (call.expression as Ast)?.name === "require") {
        const [s, l] = off(((call.arguments as Ast[]) ?? [])[0]?.src);
        if (l && !skipped(s)) all.push({ file: u.file, at: s, from: bytes(u.text, s, l), to: "true", what: "drop a require" });
      }
      if (x.nodeType === "IfStatement" && nodes(x.trueBody).some((b) => b.nodeType === "RevertStatement") && !x.falseBody) {
        const [s, l] = off((x.condition as Ast).src);
        if (!skipped(s)) all.push({ file: u.file, at: s, from: bytes(u.text, s, l), to: "false", what: "drop a revert guard" });
      }
    }
  }
  const key = (m: Mutant) => sha256(`${seed}:${m.file}:${m.at}:${m.to.trim() || "drop"}`);
  return all.sort((a, b) => (key(a) < key(b) ? -1 : 1)).slice(0, n);
}
const bytes = (text: string, at: number, len: number) => Buffer.from(text).subarray(at, at + len).toString("utf8");
/** The mutated source (offsets are UTF-8 byte offsets, as solc reports them). */
export function applyMutant(text: string, m: Mutant) {
  const b = Buffer.from(text);
  return Buffer.concat([b.subarray(0, m.at), Buffer.from(m.to), b.subarray(m.at + Buffer.byteLength(m.from))]).toString("utf8");
}
