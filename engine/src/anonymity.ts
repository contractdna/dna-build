// What may be published. The project is pseudonymous: nothing public may name a private account (the launch package,
// the measured compose, the site, docs, tests, posts). The identifiers to refuse are never written here: they come only
// from the secret PERSONAL_IDS (comma-separated sha256s of each lowercased token), and a publishing step with an empty
// list refuses to run. Text is tokenised on [a-z0-9]+; every token, and every two adjacent tokens of 2+ characters
// joined (an identifier split by punctuation or a space), is hashed and compared. A one-letter word is never joined.
// `publishIssues` adds the source-tree rules: no home paths or machine names, no references to material that is not
// published, no process notes, no wallet-tool names or key paths, no pull-request numbers in comments or docs.
import { createHash } from "node:crypto";

const fromEnv = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{64}$/.test(s));
/** The identifier hashes to refuse (PERSONAL_IDS). Empty without the secret: the publishing steps then refuse. */
export const PERSONAL_SHA256 = new Set(fromEnv(process.env.PERSONAL_IDS));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The listed tokens in `text` (as their hashes), single or two joined; [] = clean. */
export function personalHits(text: string, ids: Set<string> = PERSONAL_SHA256): string[] {
  const t = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const hits: string[] = [];
  for (let i = 0; i < t.length; i++) {
    for (const cand of [t[i], i + 1 < t.length && t[i].length > 1 && t[i + 1].length > 1 ? t[i] + t[i + 1] : ""]) {
      if (cand.length >= 4) {
        const h = sha256(cand);
        if (ids.has(h)) hits.push(h);
      }
    }
  }
  return hits;
}

/** Throws if any string inside `v` names a listed account, or if there is no list to check against (fail closed). */
export function assertAnonymous(what: string, v: unknown, ids: Set<string> = PERSONAL_SHA256) {
  if (!ids.size) throw new Error(`${what}: no identifier list (PERSONAL_IDS is empty): refusing to publish unchecked`);
  if (personalHits(JSON.stringify(v) ?? "", ids).length) throw new Error(`${what} names a private identifier: use the project's pseudonymous org`);
}

// ---------------------------------------------------------------- source-tree rules

const PATH_START = String.raw`(?<![\w./-])`; // a repo-relative path, not part of a URL or a longer path
const RULES: [why: string, re: RegExp][] = [
  ["home path", /(^|[\s"'`=(:,[/])\/(?:Users|home)\/[\w.-]|\$\{?HOME\}?\/\.(?!cache\b)/], // also under file:///, and dot paths under the HOME variable (the XDG cache dir is fine)
  ["machine name", /mac[b]ook/i], // [b]: so this line passes its own scan
  ["private reference", new RegExp(`${PATH_START}(?:research|prototypes|outreach)/|\\bsuperpowers\\b|claus-s[r]c|\\brunbooks?\\b`, "i")],
  ["private reference", /\bPLAN\.md\b|\bPLAN (?:step|§|v\d)/], // case-sensitive: "a plan step" is prose
  ["process note", /\bfounders?\b|\bfriends?\b|\bplan-review\b|\bround-4\b/i],
  ["tool or key path", /\bPhantom\b(?!\s+Foundry)|\bMeta\s*Mask\b|\bKeychain\b|~\/\.[\w-]/i],
  // local AI/editor tool state; "claude" alone stays allowed (model ids)
  ["tool or key path", /\.claude\/|playwright-m[c]p|(^|[\s"'`/])\.cursor(?:\/|rules\b)|\bcopilot\b/i],
  ["PR reference", /\/pull\/\d+/],
];

/** The measured compose and the release record are public: the signers' Telegram group and user ids are sealed
 *  allowed envs (src/enclave.ts), never values there. Hits a supergroup id (-100…), or any Telegram key (ENV_NAME or
 *  camelCase) set to a number, a basic-group id (-4…) included. A YAML block scalar puts the value on the next line:
 *  `>-` / `|` after a Telegram key is refused too (the compose never needs one). */
const TELEGRAM_ID_FILES = /^(?:deploy\/|web\/app\/proof\/release\.json$)/;
const TELEGRAM_ID = /-100\d{6,}|telegram\w*\W{1,4}-?\d|telegram\w*:\s*[>|]/i;

/** Nouns whose numbers are ids, not pull requests ("proposal #12", "op #13", "Informational #86"). */
const ID_NOUNS = new Set(["proposal", "proposals", "op", "ops", "window", "idea", "ideas", "round", "informational", "winner", "draw", "epoch", "plate", "ballot",
  "reward", "mystery", "item", "cycle", "thread", "game", "list", "id", "step", "no", "number", "rank", "seq", "record", "block", "nonce", "slot", "result", "results", "sim", "and"]);
const PR_EXPLICIT = /\b(?:PRs?|pull request|pull)\s*#\d+|\(#\d{1,3}\)/i;

/** The comment text of one line (or the whole line for prose); "" = no comment. */
function commentOf(path: string, line: string): string {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? path.split("/").pop()!.toLowerCase();
  if (/^(md|mdx|txt)$/.test(ext)) return line;
  if (/^(ts|tsx|js|mjs|cjs|sol|css|scss)$/.test(ext)) {
    if (/^\s*\*/.test(line)) return line.replace(/^\s*\*+/, "");
    return line.match(/(?:^|\s)(?:\/\/+|\/\*+)(.*)$/)?.[1] ?? "";
  }
  if (/^(sh|bash|yml|yaml|toml|py|dockerfile|gitignore|dockerignore|gitmodules|example|nvmrc)$/.test(ext)) return line.match(/(?:^|\s)#+(.*)$/)?.[1] ?? "";
  if (ext === "sql") return line.match(/--(.*)$/)?.[1] ?? "";
  return "";
}

function prRef(comment: string): boolean {
  if (PR_EXPLICIT.test(comment)) return true;
  for (const m of comment.matchAll(/#(\d{2,3})\b/g)) {
    const before = comment.slice(0, m.index);
    if (/[\w&`]$/.test(before) || before.endsWith("](") || /^[;\w]/.test(comment.slice(m.index + m[0].length))) continue; // colour, entity, anchor
    if (!ID_NOUNS.has(before.match(/([A-Za-z]+)\W*$/)?.[1]?.toLowerCase() ?? "")) return true;
  }
  return false;
}

/** The persona (src/persona.ts) is private: no persona/ directory and no persona.md is ever published. */
const PERSONA_PATH = /(^|\/)persona(\/|\.md$)/i;
// letters and digits only: a copy with other quotes, punctuation, case or spacing is still the same text
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** A persona file's distinctive text, folded: every sentence and quoted phrase of 20+ characters after its first
 *  `# Charter` heading (markdown markers stripped). A published file holding one of them leaks the persona. */
export function personaLines(text: string): string[] {
  const body = text.slice(Math.max(0, text.search(/^# Charter\s*$/m)));
  const out = new Set<string>();
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^\s*(#+|-|\d+\.)\s+/, "").replace(/\*\*/g, "");
    for (const q of line.matchAll(/"([^"]{20,})"/g)) out.add(fold(q[1]));
    for (const s of line.split(/(?<=[.!?:;])\s+/)) if (s.trim().length >= 20) out.add(fold(s));
  }
  return [...out];
}

/** Words of a bundle's run check: letters and digits, lower case (a copy re-quoted, re-spaced or re-cased is the same). */
const RUN = 8;
const wordsAt = (text: string) => [...text.toLowerCase().matchAll(/[a-z0-9]+/g)];
/** The private bundle's text as 8-word runs: every section after the first `# ` heading (charter, voice, prompts). */
export function bundleShingles(text: string): Set<string> {
  const out = new Set<string>();
  for (const body of text.split(/^# .*$/m).slice(1)) {
    const w = wordsAt(body).map((m) => m[0]);
    for (let i = 0; i + RUN <= w.length; i++) out.add(w.slice(i, i + RUN).join(" "));
  }
  return out;
}
/** Lines (1-based) where an 8-word run of the bundle starts; runs may cross lines and string quotes. */
export function bundleHits(text: string, shingles: Set<string>): number[] {
  if (!shingles.size) return [];
  const w = wordsAt(text);
  const lines = new Set<number>();
  for (let i = 0; i + RUN <= w.length; i++) {
    if (shingles.has(w.slice(i, i + RUN).map((m) => m[0]).join(" "))) lines.add(text.slice(0, w[i].index).split("\n").length);
  }
  return [...lines];
}

// simplification: one allowance. The site's wallet finder (web/app/_ui/discover.ts) names a wallet the tool-or-key-path
// rule blocks, as a public brand: its name and its documented open-in-app link. Only in that file, only those two
// strings; the rest of each line is still scanned, and every other file still fails on them. ([m]: so this file passes.)
const ALLOWED = new Map([["web/app/_ui/discover.ts", /\bMeta[M]ask\b|https:\/\/link\.meta[m]ask\.io\/dapp\//g]]);

/** Why `text` (the file at `path`) must not be published, per line; never echoes the match. `persona`: personaLines
 *  of the private persona file, when the scan has it; `bundle`: bundleShingles of the private bundle. */
export function publishIssues(path: string, text: string, persona: string[] = [], bundle: Set<string> = new Set()): { line: number; why: string }[] {
  const out: { line: number; why: string }[] = [];
  for (const line of bundleHits(text, bundle)) out.push({ line, why: "bundle text" });
  if (PERSONA_PATH.test(path)) out.push({ line: 1, why: "private persona file" });
  text.split("\n").forEach((line, i) => {
    const add = (why: string) => { if (!out.some((o) => o.line === i + 1 && o.why === why)) out.push({ line: i + 1, why }); };
    if (persona.length) {
      const l = fold(line);
      if (persona.some((p) => l.includes(p))) add("persona text");
    }
    if (personalHits(line).length) add("private identifier");
    const allowed = ALLOWED.get(path);
    const scanned = allowed ? line.replace(allowed, "wallet") : line; // a word, not "": "~/." before the name still fails
    for (const [why, re] of RULES) if (re.test(scanned)) add(why);
    if (prRef(commentOf(path, line))) add("PR reference");
    if (TELEGRAM_ID_FILES.test(path) && TELEGRAM_ID.test(line)) add("Telegram id");
  });
  return out;
}
