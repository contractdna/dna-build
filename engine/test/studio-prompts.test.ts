// The studio's prompt text: STUDIO_PROMPTS (base64 of `# Prompt studio.<id>` sections) over neutral defaults; a set
// but malformed env refuses to load.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IMAGE_EVENTS, STYLES } from "../src/media-slots.ts";

const studio = await import("../src/studio.ts");
const b64 = (s: string) => Buffer.from(s).toString("base64");
const IDS = ["studio.base", "studio.hero", "studio.rubric", "studio.banned", ...STYLES.map((s) => `studio.style.${s}`),
  ...IMAGE_EVENTS.map((e) => `studio.scene.${e.replaceAll("_", "-")}`), ...[1, 2, 3, 4].map((n) => `studio.plate.${n}`)];
const slots = { event: "digest", style: "riso", growth: 0, decay: 0, light: 0, seed: 1 } as const;

test("the neutral defaults cover every style, event and plate", () => {
  const p = studio.studioPrompts({});
  assert.deepEqual(Object.keys(p).sort(), [...IDS].sort());
  for (const id of IDS) assert.ok(p[id].trim(), id);
  assert.equal(studio.PLATE_SCENES.length, 4);
  for (const s of STYLES) assert.ok(studio.STYLE_PROMPTS[s], s);
  assert.ok(studio.bannedFor("lab").includes("text") && !studio.bannedFor("meme").includes("text"));
  assert.deepEqual(studio.studioPrompts({ STUDIO_PROMPTS: "" }), p, "empty is unset");
});

test("an env section overrides exactly that id", () => {
  const d = studio.studioPrompts({});
  const p = studio.studioPrompts({ STUDIO_PROMPTS: b64("# Prompt studio.style.riso\n\nprivate riso\n\n# Prompt studio.banned\nfoo\nbar\n") });
  assert.deepEqual(p, { ...d, "studio.style.riso": "private riso", "studio.banned": "foo\nbar" });
});

test("a malformed STUDIO_PROMPTS refuses", () => {
  for (const bad of ["not base64!", b64("# Charter\nx"), b64("# Prompt studio.base\n"), b64("# Prompt studio.base\na\n# Prompt studio.base\nb"),
    b64("# Prompt studio.nope\nx"), b64("# Prompt studio.plate.5\nx"), b64("# Prompt research\nx")]) {
    assert.throws(() => studio.studioPrompts({ STUDIO_PROMPTS: bad }), /STUDIO_PROMPTS/, bad);
  }
});

test("the composed prompt uses the env text when set; a malformed env stops the module from loading", async () => {
  process.env.STUDIO_PROMPTS = b64("# Prompt studio.style.riso\nprivate riso\n# Prompt studio.scene.digest\nprivate scene\n# Prompt studio.banned\nfoo\nbar");
  let s2: typeof studio;
  try { s2 = await import(`../src/studio.ts?env=${Date.now()}`); } finally { delete process.env.STUDIO_PROMPTS; }
  const p = s2.promptOf(slots);
  assert.ok(p.includes("private riso") && p.includes("private scene") && p.includes("Never: foo, bar"), p);
  assert.ok(p.includes(studio.BASE), "the base stays the default");
  assert.ok(!studio.promptOf(slots).includes("private"), "the default module is untouched");
  process.env.STUDIO_PROMPTS = "!!";
  try { await assert.rejects(import(`../src/studio.ts?bad=${Date.now()}`), /STUDIO_PROMPTS/); } finally { delete process.env.STUDIO_PROMPTS; }
});
