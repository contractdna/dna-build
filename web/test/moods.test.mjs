// Section moods for the helix field: every mood is a palette of hex colours, News has its own, tints stay in range,
// and the retired glyph rain is gone from the app.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MOODS, tint } from "../app/_ui/moods.ts";

test("every mood is 4 hex colours, News included", () => {
  assert.ok("news" in MOODS);
  for (const [name, colours] of Object.entries(MOODS)) {
    assert.equal(colours.length, 4, name);
    for (const c of colours) assert.match(c, /^#[0-9a-f]{6}$/, name);
  }
});

test("each tint is key, rim, accent in 0–1, and moods differ only a little in the key", () => {
  const live = tint("live");
  for (const name of Object.keys(MOODS)) {
    const t = tint(name);
    assert.equal(t.length, 9, name);
    for (const v of t) assert.ok(v >= 0 && v <= 1, `${name}: ${v}`);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(t[i] - live[i]) < 0.2, `${name}: key stays amber`);
  }
});

test("no GlyphRain left in the app", () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.(tsx?|css)$/.test(e.name) ? [join(dir, e.name)] : []);
  for (const f of walk(fileURLToPath(new URL("../app", import.meta.url)))) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/GlyphRain|data-rain/.test(src), f);
  }
});
