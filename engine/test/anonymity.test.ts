// Nothing published may name a private account or leak private process notes. The identifier list exists only as a
// secret of sha256s (src/anonymity.ts PERSONAL_IDS); this test uses obviously fake tokens for the guard's own checks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { assertAnonymous, PERSONAL_SHA256, personaLines, personalHits, publishIssues } from "../src/anonymity.ts";
import { PUBLIC_ROOTS, scanFiles, trackedFiles } from "../scripts/publish-scan.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const FAKE = new Set([sha("0xexample"), sha("janedoe")]);
const why = (path: string, text: string, persona: string[] = []) => publishIssues(path, text, persona).map((i) => i.why);
const bad = (path: string, text: string, rule: string, persona: string[] = []) => assert.deepEqual(why(path, text, persona), [rule], `${path}: ${text}`);
const ok = (path: string, text: string, persona: string[] = []) => assert.deepEqual(why(path, text, persona), [], `${path}: ${text}`);

test("the hash guard: tokens and adjacent pairs, any case or separator; only hashes are stored", () => {
  assert.equal(personalHits("see github.com/0xExample/dna", FAKE).length, 1);
  assert.equal(personalHits("by Jane Doe", FAKE).length, 1, "a name split in two");
  assert.equal(personalHits("0x-example", FAKE).length, 1, "a split identifier");
  assert.equal(personalHits("janedoe@example.com", FAKE).length, 1, "an email");
  assert.deepEqual(personalHits("0xexamples and doe alone", FAKE), []);
  assert.deepEqual(personalHits("j anedoe", FAKE), [], "a one-letter word is never joined");
  assert.ok([...PERSONAL_SHA256].every((h) => /^[0-9a-f]{64}$/.test(h)), "hashes only");
  assert.throws(() => assertAnonymous("x", { a: ["ok", { b: "JANE DOE" }] }, FAKE), /private identifier/);
});

test("the hash guard fails closed: no list, nothing is published unchecked; no identifier hash is written in the code", () => {
  assert.throws(() => assertAnonymous("x", { a: "anything" }, new Set()), /no identifier list/);
  const src = readFileSync(new URL("../src/anonymity.ts", import.meta.url), "utf8");
  assert.ok(!/[0-9a-f]{64}/i.test(src), "the list comes only from the PERSONAL_IDS secret");
});

test("the hash guard: a listed address is caught with or without 0x, in any case, inside a list", () => {
  const owner = `0x${"ab12".repeat(10)}`; // a fake address, listed with and without 0x
  const ids = new Set([sha(owner), sha(owner.slice(2))]);
  assert.equal(personalHits(`EXCLUDED_WALLETS=0x${"0".repeat(39)}1,${owner.toUpperCase().replace("0X", "0x")}`, ids).length, 1);
  assert.equal(personalHits(`owner ${owner.slice(2)}`, ids).length, 1, "without the prefix");
  assert.deepEqual(personalHits(`0x${"ab12".repeat(9)}ab13`, ids), [], "a different address");
});

test("publishIssues: home paths and machine names fail, ordinary paths and URLs pass", () => {
  const U = "/" + "Users/", H = "/" + "home/"; // split so this file passes its own scan
  for (const t of [`cd ${U}somebody/x`, `HOME: "${H}node"`, `path=${U}a`, `file://${U}a/x.json`, `$${"HOME"}/.dna-keys`, `\${${"HOME"}}/.ssh`]) bad("a.ts", t, "home path");
  bad("a.md", `built on a Mac${"Book"}`, "machine name");
  for (const t of ["/usr/bin", "https://docs.example.org/home/quickstart", "/root", "src/home/page.tsx", "macro", `\${XDG_CACHE_HOME:-$${"HOME"}/.cache}/x`]) ok("a.ts", t);
});

test("publishIssues: private paths, process words and tool names fail anywhere", () => {
  const r = "research", R = "RUN" + "BOOK", P = "PL" + "AN"; // split so this file passes its own scan
  for (const t of [`// see ${r}/13 §3`, `(${r}/01-x.md)`, `docs/${R}.md P1`, `the ${R.toLowerCase()} rule`, `${P}.md §1`, `${P} step 7`, "proto" + "types/genome",
    "out" + "reach/x.md", "docs/super" + "powers/plans", "claus" + "-src"]) bad("a.ts", t, "private reference");
  for (const t of [`// (${"found" + "er"} 2026-10-07)`, `the ${"Found" + "ers"} decided`, `a ${"fri" + "end"}`, `plan-${"review"} agent`]) bad("a.ts", t, "process note");
  for (const t of ["the " + "Phan" + "tom wallet", "Meta" + "Mask", "Meta" + " Mask", "macOS " + "Key" + "chain", "keys in ~" + "/.dna-keys"]) bad("a.md", t, "tool or key path");
  for (const t of [".clau" + "de/settings.local.json", "playwright-" + "mcp/", ".cur" + "sor/rules", "a .cur" + "sorrules file", "Co" + "pilot"]) bad("a.md", t, "tool or key path");
  for (const t of ["model: claude-opus-5-5", "the claude model", ".cursor { width: 1px }", "<span className={s.cursor} />"]) ok("a.md", t);
  for (const t of ["Karrik (Phantom Foundry / Velvetyne)", "a friendly name", "https://docs.example.org/research/x", "grep -r . | ~ /x", "the researcher"]) ok("a.md", t);
});

test("publishIssues: PR refs in comments and markdown only, never ids, colors or anchors", () => {
  const n = "#" + "56"; // split so this file passes its own scan
  for (const [p, t] of [["a.ts", `x(); // fixed in PR ${n}`], ["a.ts", ` *  the cap (${n} Q1)`], ["a.sol", `/// @dev see ${n}`], ["a.sh", `# merged ${n}`],
    ["a.yml", `  run: x # PR ${n}`], ["a.sql", `-- after ${n}`], ["a.md", `Run on the PR ${n} head`], ["a.md", `fix (${n})`],
    ["a.ts", `const u = "https://github.com/o/r/${"pull"}/56";`]] as const) bad(p, t, "PR reference");
  for (const [p, t] of [["a.ts", `const s = "duplicate of ${n}";`], ["a.ts", `// proposal ${n} queued`], ["a.ts", `// op ${n} (SetLevel)`], ["a.md", `Informational ${n}`],
    ["a.css", ".x { color: #000; } /* #fff */"], ["a.md", "Deep petrol: `#05090b` to `#0a1a1e`, bone `#000`"], ["a.md", "[see](#12-games)"], ["a.json", `{"t": "PR ${n}"}`],
    ["a.sh", 'echo "${#arr[@]}"'], ["a.ts", "const url = 'https://x.org/a#123';"],
    ["a.ts", "// on its own near-black (#020405)"], ["a.ts", 'ref?: string; // "sim #8421"']] as const) ok(p, t);
});

test("publishIssues: no Telegram group or user id in the public compose or release record", () => {
  for (const t of ['      TELEGRAM_GROUP_ID: "-1001234567890"', '"docker_compose_file":"…TELEGRAM_ALLOWED_USER_IDS: \\"11,22\\"…"', '"telegramGroupId": "-1009876543"', "TELEGRAM_GROUP_ID=-42",
    '"telegramAllowedUserIds": "123456789,987654321"', '"telegramGroupId": "-4123456789"', "      TELEGRAM_ALLOWED_USER_IDS: >-", "  TELEGRAM_GROUP_ID: |"]) {
    for (const p of ["deploy/app-compose.json", "deploy/docker-compose.template.yml", "deploy/x.params.json", "web/app/proof/release.json"]) bad(p, t, "Telegram id");
  }
  for (const t of ["      TELEGRAM_GROUP_ID: ${TELEGRAM_GROUP_ID}", '    "TELEGRAM_ALLOWED_USER_IDS",']) ok("deploy/app-compose.json", t);
  ok("engine/test/x.test.ts", 'TELEGRAM_GROUP_ID: "-100"'); // test fixtures elsewhere are fine
});

test("every file this repo publishes passes the guard (listed ids, private references, process notes, PR refs)", () => {
  const files = trackedFiles(new URL("../../", import.meta.url).pathname);
  for (const must of ["engine/package.json", "engine/test/engine.test.ts", "contracts/test/GamePot.t.sol", "web/app/proof/page.tsx", "contracts/SPEC.md"]) assert.ok(files.includes(must), `scans ${must}`);
  assert.ok(files.every((f) => PUBLIC_ROOTS.some((r) => f === r || f.startsWith(`${r}/`))), "public roots only");
  assert.deepEqual(scanFiles(new URL("../../", import.meta.url).pathname, files, PERSONA_LINES), []);
});

// the private persona file, when this checkout has it (the private repository does; the public one never)
const PERSONA_FILE = new URL("../../persona/persona.md", import.meta.url);
const PERSONA_LINES = existsSync(PERSONA_FILE) ? personaLines(readFileSync(PERSONA_FILE, "utf8")) : [];

test("persona: never published; its distinctive text is caught in any published file", () => {
  const fixture = "Private header line that is not persona text at all.\n# Charter\n## Who I am\nI am a test persona with a very particular line.\n# Voice\n- \"A quoted example that only this persona says.\" (a note)\n";
  const lines = personaLines(fixture);
  assert.ok(lines.includes("i am a test persona with a very particular line"));
  assert.ok(lines.includes("a quoted example that only this persona says"));
  assert.ok(!lines.some((l) => l.includes("private header")), "the preamble is not persona text");
  bad("docs/x.md", "As it says: I am a test   persona with a VERY particular line. Indeed.", "persona text", lines);
  bad("engine/src/x.ts", 'const s = "A quoted example that only this persona says.";', "persona text", lines);
  bad("engine/test/x.ts", "text: 'a quoted-example, that ONLY this persona says!'", "persona text", lines); // other quotes and punctuation
  ok("docs/x.md", "A persona with a particular line.", lines);
  for (const p of ["persona/persona.md", "persona/notes.txt", "web/persona.md", "engine/Persona/x.json"]) bad(p, "anything", "private persona file");
  ok("engine/src/persona.ts", "export const PERSONA = loadPersona();");
  // this repository: the file exists, is not in any published root, and its text is checked above
  if (!PERSONA_LINES.length) return;
  const files = trackedFiles(new URL("../../", import.meta.url).pathname);
  assert.ok(!files.some((f) => /(^|\/)persona(\/|\.md$)/i.test(f)), "no persona file among the published files");
  assert.ok(PERSONA_LINES.length >= 10, "the persona file yields its distinctive lines");
});

test("the launch package and the measured compose refuse a listed identifier", async () => {
  const { packConfig } = await import("../scripts/route-a.ts");
  const { render } = await import("../scripts/compose.ts");
  const f = { launchWallet: `0x${"1".repeat(40)}`, nonce: "0x2", revision: "c".repeat(40), publicOrigin: "https://example.org/project-org/dna", xUrl: "https://x.com/contractdna", image: "assets/token.png",
    imageUri: "https://genomedna.xyz/token.png", website: "https://genomedna.xyz/", description: "d", fee: "20000", validAfter: 0, permitWindowS: 3600, checkedAt: "2026-10-08T00:00:00Z" };
  // the real list: a hash planted through PERSONAL_IDS reaches both gates
  PERSONAL_SHA256.add(sha("0xexample"));
  try {
    assert.throws(() => packConfig({} as never, { ...f, publicOrigin: "https://github.com/0xExample/dna" }, {}), /private identifier/);
    assert.throws(() => packConfig({} as never, { ...f, imageUri: "https://0XEXAMPLE.example/t.png" }, {}), /private identifier/, "any field, any case");
    const P = { commit: "a".repeat(40), image: "ghcr.io/0xexample/dna-engine", imageDigest: `sha256:${"b".repeat(64)}`, xClientId: "c", xUserId: "2" };
    assert.throws(() => render(P as never), /private identifier/);
    assert.throws(() => render({ ...P, image: "ghcr.io/<project-org>/dna-engine" } as never), /placeholder/, "the placeholder must be filled");
  } finally {
    PERSONAL_SHA256.delete(sha("0xexample"));
  }
});
