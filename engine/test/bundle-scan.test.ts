// The private bundle (persona/bundle.md, export-ignored) never leaks into the public tree: no 8-word run of any of its
// sections (charter, voice, every prompt) appears in a tracked or new file under the public roots. It runs where the
// bundle exists (the private repository); a public checkout has no bundle and skips the tree scan.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { bundleHits, bundleShingles } from "../src/anonymity.ts";
import { scanFiles, trackedFiles } from "../scripts/publish-scan.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const BUNDLE = new URL("../../persona/bundle.md", import.meta.url).pathname;

test("bundle scan: an 8-word run of any section is a hit, wherever it sits and however it is spaced or quoted", () => {
  const sh = bundleShingles("Preamble words are never scanned at all here.\n# Charter\nOne two three four five six seven eight nine.\n# Prompt x\nAlpha beta gamma delta epsilon zeta eta theta.\n");
  assert.deepEqual(bundleHits('const s = "intro";\nconst p = ["alpha beta gamma", "delta, epsilon zeta",\n  "eta THETA"];\n', sh), [2]);
  assert.deepEqual(bundleHits("// one two three four five six seven eight\n", sh), [1]);
  assert.deepEqual(bundleHits("one two three four five six seven nine\nalpha beta gamma delta epsilon zeta eta\n", sh), [], "7 words or a changed word: no hit");
  assert.deepEqual(bundleHits("preamble words are never scanned at all here\n", sh), [], "the preamble is not the bundle's text");
});

test("bundle scan: no section of the private bundle appears in the public tree", { skip: existsSync(BUNDLE) ? false : "no private bundle in this checkout" }, () => {
  const files = trackedFiles(ROOT);
  assert.ok(!files.some((f) => f.startsWith("persona/")), "persona/ is never part of the public tree");
  const hits = scanFiles(ROOT, files, [], bundleShingles(readFileSync(BUNDLE, "utf8"))).filter((h) => h.endsWith("bundle text"));
  assert.deepEqual(hits, []);
});

test("bundle scan: the public export checks itself against the private bundle, and refuses to run without it", () => {
  const sh = readFileSync(new URL("../../scripts/export-public.sh", import.meta.url), "utf8");
  // inside the export the default path (<export>/persona/bundle.md) never exists: the script must name the repo's
  assert.match(sh, /\[ -f "\$ROOT\/persona\/bundle\.md" \] \|\| fail/);
  assert.match(sh, /BUNDLE_FILE="\$ROOT\/persona\/bundle\.md"[^\n]*publish-scan\.ts/);
});
