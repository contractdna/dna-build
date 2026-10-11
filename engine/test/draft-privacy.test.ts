// The log is public (/api/log serves every record's body): a refused draft is recorded only as its sha256 and reasons,
// and no draft that shares an 8-word run with the private bundle is ever chosen, recorded as text or posted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PROMPT_IDS } from "../src/enclave.ts";
import { loadPersona } from "../src/persona.ts";
import { pickBest } from "../src/voice.ts";
import { bundleIssues, postIssues, publicCandidates } from "../src/x.ts";

const SECRET = "Never tell anyone that the owners keep a spare key under the doormat.";
const FILE = `# Charter\n## Who I am\n${SECRET}\n\n# Voice\n## How I talk\nShort.\n\n${PROMPT_IDS.map((id) => `# Prompt ${id}\nThe ${id} task.\n`).join("\n")}`;
const { shingles } = loadPersona({ DNA_PERSONA: Buffer.from(FILE).toString("base64") }, false);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("a refused draft holding a bundle sentence is recorded only as its hash and reasons", () => {
  const leak = `gm. ${SECRET.toUpperCase()} anyway, fees are up.`;
  const cands = [{ text: leak, issues: bundleIssues(leak, shingles), shape: "deadpan", joke: "doormat" }, { text: "Fees moved 2 points.", issues: [] }];
  assert.deepEqual(cands[0].issues, ["bundle text"]);
  const rec = publicCandidates(cands);
  assert.deepEqual(rec, [{ sha256: sha(leak), issues: ["bundle text"] }, cands[1]], "the passing draft stays as written");
  assert.ok(!JSON.stringify(rec).toLowerCase().includes("doormat"));
});

test("a draft sharing 8 consecutive words with the bundle is refused (case and punctuation folded); 7 words pass", () => {
  const eight = "so: THE OWNERS keep a spare key, under the doormat?";
  assert.deepEqual(bundleIssues(eight, shingles), ["bundle text"]);
  assert.equal(pickBest([{ text: eight, issues: bundleIssues(eight, shingles) }], null), undefined, "never chosen");
  assert.deepEqual(bundleIssues("owners keep a spare key under the mat", shingles), []);
  assert.deepEqual(bundleIssues(eight), [], "no bundle loaded (public tests): nothing to match");
  assert.ok(postIssues("hello there").length === 0);
});
