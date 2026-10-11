// The private bundle (persona/bundle.md: `# Charter`, `# Voice`, `# Prompt <id>` sections) → its three env values,
// each the base64 of its own sections:
//   DNA_PERSONA     the charter, the voice and every engine prompt (the enclave refuses one without a PROMPT_IDS section)
//   STUDIO_PROMPTS  the studio.* prompts (the media studio's Railway env)
//   SEQ_PROMPTS     the seq.* prompts (the `seq-build` environment secret of the Sequencer workflow; ≤ 48 KB)
// Usage: node scripts/bundle.ts [--file persona/bundle.md] [--out DIR]
// Each value goes to <DIR>/<NAME> (mode 0600; DIR defaults to a fresh temp dir); the script prints only names, sizes and
// sha256s, never a value. Then, e.g.: gh secret set SEQ_PROMPTS --env seq-build < DIR/SEQ_PROMPTS
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingPrompts, personaSections } from "../src/enclave.ts";

/** GitHub's limit for one secret. */
export const SECRET_MAX = 48 * 1024;
const section = (id: string, body: string) => `# Prompt ${id}\n${body}\n`;

/** The bundle's text → {NAME: plain text of that env's sections}; throws on anything the loaders would refuse. */
export function envTexts(text: string): Record<"DNA_PERSONA" | "STUDIO_PROMPTS" | "SEQ_PROMPTS", string> {
  const s = personaSections(text);
  if (!s) throw new Error("bundle: needs `# Charter`, then `# Voice`, then only `# Prompt <id>` sections (each id once, none empty)");
  const missing = missingPrompts(s.prompts);
  if (missing.length) throw new Error(`bundle: lacks the engine prompt sections ${missing.join(", ")}`);
  const of = (keep: (id: string) => boolean) => Object.entries(s.prompts).filter(([id]) => keep(id)).map(([id, b]) => section(id, b)).join("\n");
  const own = (id: string) => id.startsWith("studio.") || id.startsWith("seq.");
  return {
    DNA_PERSONA: `# Charter\n${s.charter}\n\n# Voice\n${s.voice}\n\n${of((id) => !own(id))}`,
    STUDIO_PROMPTS: of((id) => id.startsWith("studio.")),
    SEQ_PROMPTS: of((id) => id.startsWith("seq.")),
  };
}

if (import.meta.main) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const file = arg("--file") ?? new URL("../../persona/bundle.md", import.meta.url).pathname;
  const out = arg("--out") ?? mkdtempSync(join(tmpdir(), "dna-bundle-"));
  for (const [name, text] of Object.entries(envTexts(readFileSync(file, "utf8")))) {
    const value = Buffer.from(text).toString("base64");
    if (name === "SEQ_PROMPTS" && value.length > SECRET_MAX) throw new Error(`SEQ_PROMPTS is ${value.length} bytes: over GitHub's ${SECRET_MAX}`);
    writeFileSync(join(out, name), value, { mode: 0o600 });
    console.log(`${name}: ${value.length} bytes, sha256 ${createHash("sha256").update(text).digest("hex")} (of the decoded text) → ${join(out, name)}`);
  }
}
