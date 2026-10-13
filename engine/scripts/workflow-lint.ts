// Lint the GitHub workflows (CI step; `node scripts/workflow-lint.ts [dir]`, default ../.github/workflows):
//  - every action pinned to a full commit sha (local ./ actions excepted), no docker:// actions;
//  - no pull_request_target (it runs with secrets on fork code);
//  - a top-level `permissions:` block, and no `write` anywhere in a permissions block (top level or job; block, flow
//    mapping or write-all): the workflows here only read, and anything that writes uses its own app token;
//  - secrets only from each file's allow-list;
//  - the Sequencer's workflows use no cache at all (actions/cache or a setup action's `cache:` input): a cache a build
//    job writes could poison a later run.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SECRETS: Record<string, string[]> = {
  "export-check.yml": ["PERSONAL_IDS"],
  "sequencer.yml": ["OPENROUTER_API_KEY_SEQUENCER", "SEQ_PROMPTS", "SEQ_APP_ID", "SEQ_APP_KEY"],
  "site-deploy.yml": ["RAILWAY_SITE_TOKEN", "RAILWAY_SITE_SERVICE", "RAILWAY_PLAY_SERVICE", "RAILWAY_SITE_ENV"],
};
const NO_CACHE = new Set(["sequencer.yml", "sequencer-gates.yml"]);
/** Triggers that run with the base repository's rights on events outsiders cause: none is allowed. */
const RISKY_TRIGGERS = /\b(workflow_run|issue_comment|pull_request_review_comment|discussion_comment)\b/;

/** Is line i inside a `permissions:` block (top level or a job's)? */
function inPermissions(lines: string[], i: number) {
  const ind = (l: string) => l.length - l.trimStart().length;
  for (let k = i - 1; k >= 0; k--) {
    if (!lines[k].trim()) continue;
    if (ind(lines[k]) < ind(lines[i])) return /^\s*permissions:\s*$/.test(lines[k]);
  }
  return false;
}

export function lintWorkflow(file: string, text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    const code = line.replace(/\s+#.*$/, "");
    const uses = code.match(/^\s*(?:-\s+)?uses:\s*["']?([^"'\s]+)/);
    if (uses) {
      const u = uses[1];
      if (u.startsWith("docker://")) out.push(`${at}: docker action ${u}`);
      else if (!u.startsWith("./") && !/@[0-9a-f]{40}$/.test(u)) out.push(`${at}: ${u} is not pinned to a commit sha`);
      if (NO_CACHE.has(file) && /^actions\/cache(\/|@)/.test(u)) out.push(`${at}: actions/cache in a Sequencer workflow`);
    }
    if (/\bpull_request_target\b/.test(code)) out.push(`${at}: pull_request_target`);
    if (RISKY_TRIGGERS.test(code) && !/^\s*(name|run|#)/.test(code)) out.push(`${at}: a trigger outsiders can fire (${code.match(RISKY_TRIGGERS)![1]})`);
    if (/^\s*secrets:\s*inherit\b/.test(code)) out.push(`${at}: secrets: inherit`);
    // permissions that grant write: write-all, a flow mapping with a write, or a write key inside a permissions block
    if (/^\s*permissions:\s*write-all\b/.test(code) || /^\s*permissions:\s*\{[^}]*\bwrite\b/.test(code)
      || (/^\s+[a-z-]+:\s*write\b/.test(code) && inPermissions(lines, i))) out.push(`${at}: grants write permission`);
    for (const m of code.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!(SECRETS[file] ?? []).includes(m[1])) out.push(`${at}: secret ${m[1]} is not allowed in ${file}`);
    }
    if (/\$\{\{\s*secrets\s*\[/.test(code) || /toJSON\(\s*secrets\s*\)/.test(code)) out.push(`${at}: secrets accessed dynamically`);
    // a cache input, as a block key or inside a flow mapping; `cache: false` (turning a default cache off) is fine
    if (NO_CACHE.has(file) && /(^|[\s{,-])cache(-dependency-path)?\s*:(?!\s*false\b)/.test(code)) out.push(`${at}: a cache input in a Sequencer workflow`);
  });
  if (!lines.some((l) => /^permissions:/.test(l))) out.push(`${file}: no top-level permissions`);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? new URL("../../.github/workflows/", import.meta.url).pathname;
  const issues = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).flatMap((f) => lintWorkflow(f, readFileSync(join(dir, f), "utf8")));
  for (const i of issues) console.error(i);
  console.log(issues.length ? `workflow lint: ${issues.length} issue(s)` : "workflow lint: clean");
  process.exit(issues.length ? 1 : 0);
}
