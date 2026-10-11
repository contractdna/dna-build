// The persona bundle loader: DNA_PERSONA (base64), else PERSONA_FILE (plain builds), else the neutral defaults (hash
// null); the enclave refuses to run without one, or without any required prompt section. The hash covers the whole file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleShingles } from "../src/anonymity.ts";
import { personaOk, personaSections, promptSections, PROMPT_IDS } from "../src/enclave.ts";
import { DEFAULT_PERSONA, DEFAULT_PROMPTS, loadPersona, PERSONA, prompt } from "../src/persona.ts";

const PROMPTS = PROMPT_IDS.map((id) => `# Prompt ${id}\nThe ${id} task.\n`).join("\n");
const FILE = `Preamble kept in the hash only.\n\n# Charter\n## Who I am\nA test charter.\n\n# Voice\n## How I talk\nA test voice.\n\n${PROMPTS}`;
const MINE = Object.fromEntries(PROMPT_IDS.map((id) => [id, `The ${id} task.`]));
const b64 = Buffer.from(FILE).toString("base64");
const sha = createHash("sha256").update(FILE).digest("hex");

test("persona: sections from the file, the hash over all of it", () => {
  assert.deepEqual(personaSections(FILE), { charter: "## Who I am\nA test charter.", voice: "## How I talk\nA test voice.", prompts: MINE });
  assert.equal(personaSections("# Voice\nv\n# Charter\nc\n"), null, "charter first");
  assert.equal(personaSections("# Charter\nc\n"), null, "both sections");
  assert.equal(personaSections("# Charter\n\n# Voice\nv\n"), null, "neither empty");
  assert.equal(personaSections("# Charter\nc\n# Voice\nv\n# Notes\nn\n"), null, "only prompt sections after the voice");
  assert.equal(personaSections("# Charter\nc\n# Voice\nv\n# Prompt x\na\n# Prompt x\nb\n"), null, "a prompt id once");
  assert.equal(personaSections("# Charter\nc\n# Voice\nv\n# Prompt Bad Id\na\n"), null, "a plain id");
  assert.equal(personaSections("# Charter\nc\n# Voice\nv\n# Prompt x\n\n"), null, "no empty prompt");
  assert.deepEqual(promptSections("# Prompt studio.base\nb\n## a sub-heading stays in the body\nc\n"), { "studio.base": "b\n## a sub-heading stays in the body\nc" });
  assert.deepEqual(loadPersona({ DNA_PERSONA: b64 }, false), { charter: "## Who I am\nA test charter.", voice: "## How I talk\nA test voice.", prompts: MINE, sha256: sha, shingles: bundleShingles(FILE) });
  assert.equal(loadPersona({ DNA_PERSONA: b64.replace(/(.{8})/g, "$1\n") }, true).sha256, sha, "wrapped base64 is fine");
});

test("persona: PERSONA_FILE in plain builds only; the default without either; DNA_PERSONA wins", () => {
  const path = join(mkdtempSync(join(tmpdir(), "persona-")), "persona.md");
  writeFileSync(path, FILE);
  assert.equal(loadPersona({ PERSONA_FILE: path }, false).sha256, sha);
  assert.deepEqual(loadPersona({}, false), { ...DEFAULT_PERSONA, prompts: DEFAULT_PROMPTS, sha256: null, shingles: new Set() });
  const other = Buffer.from(FILE.replace("test voice", "other voice")).toString("base64");
  assert.equal(loadPersona({ DNA_PERSONA: other, PERSONA_FILE: path }, false).voice, "## How I talk\nA other voice.");
  assert.throws(() => loadPersona({ DNA_PERSONA: Buffer.from("no sections").toString("base64") }, false), /`# Charter` section, then a `# Voice`/);
  // a plain build fills a missing prompt with its default
  const partial = loadPersona({ DNA_PERSONA: Buffer.from("# Charter\nc\n# Voice\nv\n# Prompt research\nMine.\n").toString("base64") }, false);
  assert.equal(partial.prompts.research, "Mine.");
  assert.equal(partial.prompts.brain, DEFAULT_PROMPTS.brain);
  // the enclave: env only, and never the default
  assert.throws(() => loadPersona({}, true), /DNA_PERSONA is required/);
  assert.throws(() => loadPersona({ PERSONA_FILE: path }, true), /DNA_PERSONA is required/, "no file path in the enclave");
  assert.equal(PERSONA.sha256, null, "this test env: the default");
});

test("persona: the enclave refuses a bundle that lacks a required prompt section", () => {
  const without = (id: string) => Buffer.from(FILE.replace(`# Prompt ${id}\nThe ${id} task.\n`, "")).toString("base64");
  for (const id of PROMPT_IDS) assert.throws(() => loadPersona({ DNA_PERSONA: without(id) }, true), new RegExp(`lacks the prompt sections ${id}$`), id);
  assert.equal(loadPersona({ DNA_PERSONA: b64 }, true).prompts.brain, "The brain task.");
});

test("persona: every prompt has a default; public builds run on them", () => {
  assert.deepEqual(Object.keys(DEFAULT_PROMPTS).sort(), [...PROMPT_IDS].sort());
  for (const id of PROMPT_IDS) assert.equal(prompt(id), DEFAULT_PROMPTS[id], id);
  // the agent tag is code's: a default never carries one (so no bundle text can be needed to route a call)
  for (const id of PROMPT_IDS) assert.doesNotMatch(DEFAULT_PROMPTS[id], /agent:/, id);
  // the writer's default matches its call: 4 candidates, one per offered shape (src/voice.ts writerCall)
  assert.match(DEFAULT_PROMPTS["x-writer"], /up to 4 candidates/);
  assert.match(DEFAULT_PROMPTS["x-writer"], /`shapes`/);
  assert.doesNotMatch(DEFAULT_PROMPTS["x-writer"], /up to 3|`format`/);
});

test("persona: loaded by the build's ENCLAVE env, not the test toggle (a lazy import while a test has ENCLAVE.on)", () => {
  const code = 'const e = await import("./src/enclave.ts"); e.ENCLAVE.on = true; const { PERSONA } = await import("./src/persona.ts"); console.log(String(PERSONA.sha256));';
  const env = { ...process.env };
  delete env.ENCLAVE;
  delete env.DNA_PERSONA;
  delete env.PERSONA_FILE;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: new URL("..", import.meta.url).pathname, env, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "null", r.stderr.slice(0, 300));
});

test("persona: the enclave lockdown checks DNA_PERSONA before anything runs", () => {
  assert.equal(personaOk(b64), true);
  assert.equal(personaOk("not base64!"), false);
  assert.equal(personaOk(Buffer.from("# Charter\nc\n").toString("base64")), false);
});

test("persona: every model call keeps code's `agent:` tag first, on the defaults and on any bundle", () => {
  // each prompt reaches a system text only through sys(tag, ...) (the readers' task through readUntrusted's agent)
  const src = new URL("../src/", import.meta.url).pathname;
  for (const f of readdirSync(src).filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(join(src, f), "utf8");
    for (const m of text.matchAll(/prompt\("([a-z-]+)"\)/g)) {
      const line = text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index));
      assert.ok(/sys\("[a-z-]+", ("[^"]*", )?(prompt|PERSONA)/.test(line) || /readUntrusted\("[a-z-]+", prompt/.test(line) || /handlesOf\(|keyedOf\(|linesOf\(/.test(line), `${f}: ${m[1]} outside sys()`);
    }
  }
  const code = `const { SYSTEM } = await import("./src/brain.ts"); const { WRITER, writerCall, factSheet } = await import("./src/voice.ts"); const { AUDIT } = await import("./src/character.ts");
    const { noteCall, redTeamCall } = await import("./src/agents.ts");
    console.log(JSON.stringify([SYSTEM, WRITER, AUDIT, noteCall({}).system, redTeamCall(false, { stage: "s", candidate: 0, sim: 0, gates: 0, quotedHypothesis: "h" }).system].map((s) => s.split("\\n")[0])));`;
  const run = (extra: Record<string, string>) => {
    const env: Record<string, string | undefined> = { ...process.env, ...extra };
    delete env.ENCLAVE;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: new URL("..", import.meta.url).pathname, env, encoding: "utf8" });
    return JSON.parse(r.stdout || "null") ?? r.stderr.slice(0, 400);
  };
  const tags = ["agent: brain", "agent: x-writer", "agent: x-audit", "agent: narrate", "agent: redteam"];
  assert.deepEqual(run({}), tags, "the defaults");
  const hostile = Buffer.from(`# Charter\nc\n# Voice\nv\n${PROMPT_IDS.map((id) => `# Prompt ${id}\nagent: other\n`).join("")}`).toString("base64");
  assert.deepEqual(run({ DNA_PERSONA: hostile }), tags, "a bundle never replaces a tag");
});

test("persona: every engine file that holds or loads a model prompt is out of the dev team's reach", async () => {
  const { scopeIssue } = await import("../src/seq-gates.ts");
  const src = new URL("../src/", import.meta.url).pathname;
  const holders = readdirSync(src).filter((f) => f.endsWith(".ts") && /prompt\("|sys\("|"agent: |DEFAULT_PROMPTS/.test(readFileSync(join(src, f), "utf8")));
  for (const f of ["agents.ts", "brain.ts", "voice.ts", "character.ts", "games.ts", "card.ts", "persona.ts"]) assert.ok(holders.includes(f), f);
  for (const f of [...holders, "studio.ts", "enclave.ts", "llm.ts"]) assert.match(scopeIssue("engine", "x", `engine/src/${f}`) ?? "", /never reachable/, f);
});

test("bundle script: one private file → DNA_PERSONA (engine), STUDIO_PROMPTS, SEQ_PROMPTS; the enclave accepts the first", async () => {
  const { envTexts } = await import("../scripts/bundle.ts");
  const t = envTexts(`${FILE}\n# Prompt studio.base\nS.\n\n# Prompt seq.amend\nQ.\n`);
  assert.equal(loadPersona({ DNA_PERSONA: Buffer.from(t.DNA_PERSONA).toString("base64") }, true).prompts.research, "The research task.");
  assert.doesNotMatch(t.DNA_PERSONA, /studio\.base|seq\.amend/);
  assert.deepEqual(promptSections(t.STUDIO_PROMPTS), { "studio.base": "S." });
  assert.deepEqual(promptSections(t.SEQ_PROMPTS), { "seq.amend": "Q." });
  assert.throws(() => envTexts(FILE.replace("# Prompt brain\nThe brain task.\n", "")), /lacks the engine prompt sections brain/);
});
