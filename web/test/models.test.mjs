// /models: the table is engine-generated (engine/scripts/models-table.ts); every row has its copy, the registry rows
// match engine/models.json, and the page shows no prices.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PAGE, PARTS } from "../app/models/content.ts";

const rows = JSON.parse(readFileSync(new URL("../app/models/models.json", import.meta.url), "utf8"));
const registry = JSON.parse(readFileSync(new URL("../../engine/models.json", import.meta.url), "utf8"));

test("one row per part, each with its copy", () => {
  assert.deepEqual(PARTS.map((p) => p.part).sort(), rows.map((r) => r.part).sort());
  assert.equal(new Set(PARTS.map((p) => p.part)).size, PARTS.length);
});

test("registry rows match engine/models.json", () => {
  for (const [role, e] of Object.entries(registry.roles)) {
    const r = rows.find((x) => x.part === role);
    assert.ok(r, `${role} is on the page`);
    assert.equal(r.model.id, e.model, role);
    assert.equal(r.backup?.id, e.backup, role);
  }
  for (const r of rows) for (const m of [r.model, r.backup].filter(Boolean)) assert.ok(["Anthropic", "xAI", "OpenAI"].includes(m.provider), `${r.part}: ${m.provider}`);
});

test("plain copy: no prices, no superlatives, no em dashes", () => {
  const text = JSON.stringify([PAGE, PARTS, rows]);
  for (const bad of [/price/i, /budget/i, /\$/, /usd/i, /\bbest\b/i, /world-class/i, /cutting-edge/i, /—/]) assert.doesNotMatch(text, bad);
  assert.equal(PAGE.lede, "Every job runs on a frontier model picked for it. These are the defaults: the brain can swap a model after a public tryout on fixed tests, and swapping the brain itself needs the Safe.");
});
