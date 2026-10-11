// The public model registry (models.json): parsing, prices (incl. prompt-length rate cards), worst case for unknown
// models, env overrides. Everything here reads the committed file (BASE) with explicit envs, never the shell's env.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyOverrides, BASE, idOf, parseRegistry, priceOf, providerOf, registryInfo, ROLES, unpriced } from "../src/models.ts";

const raw = JSON.parse(readFileSync(new URL("../models.json", import.meta.url), "utf8"));

test("registry: every role present, with the agreed defaults", () => {
  assert.deepEqual(Object.keys(BASE.roles).sort(), [...ROLES].sort());
  const m = Object.fromEntries(ROLES.map((r) => [r, BASE.roles[r].model]));
  assert.deepEqual(m, {
    brain: "claude-fable-5-1", main: "grok-4.7", research: "grok-4.7", intake: "grok-4.7", "x-voice": "grok-4.7", "x-scout": "grok-4.7", "x-audit": "claude-sonnet-5-5", redteam: "claude-opus-5-5", gate: "claude-fable-5-1", narrate: "grok-4.3",
    vision: "claude-opus-5-5", "dev-lead": "claude-opus-5-5", "dev-worker": "claude-haiku-5-5", "dev-tester": "claude-sonnet-5-5", "dev-fixer": "claude-sonnet-5-5", "dev-review": "claude-opus-5-5",
  });
  for (const r of ROLES) assert.notEqual(BASE.roles[r].backup, BASE.roles[r].model, `${r}: the backup is another model`);
  for (const r of ROLES) for (const id of [BASE.roles[r].model, BASE.roles[r].backup]) providerOf(id); // every id has a provider
  assert.throws(() => providerOf("gpt-9"), /no provider/);
  assert.deepEqual([providerOf("claude-opus-5-5"), providerOf("grok-4.7")], ["anthropic", "xai"]);
});

test("registry prices: per model, consistent across roles; prompt-length rate cards; unknown model ⇒ the priciest rate", () => {
  assert.deepEqual(priceOf("claude-opus-5-5"), { in: 4, out: 20, cached: 0.2, write: 5 });
  assert.deepEqual(priceOf("claude-fable-5-1"), { in: 10, out: 50, cached: 0.25, write: 12.5 });
  assert.deepEqual(priceOf("claude-sonnet-5-5"), { in: 2, out: 10, cached: 0.1, write: 2.5 });
  assert.deepEqual(priceOf("grok-4.3"), { in: 1.25, out: 2.5, cached: 0.2 });
  // Haiku 5.5: one card up to 100K prompt tokens, another above
  assert.deepEqual(priceOf("claude-haiku-5-5"), { in: 0.1, out: 0.5, cached: 0.01, write: 0.125 });
  assert.deepEqual(priceOf("claude-haiku-5-5", 100_000), { in: 0.1, out: 0.5, cached: 0.01, write: 0.125 });
  assert.deepEqual(priceOf("claude-haiku-5-5", 100_001), { in: 0.5, out: 2.5, cached: 0.05, write: 0.625 });
  assert.deepEqual(priceOf("claude-opus-5-5", 900_000), priceOf("claude-opus-5-5"), "one card at any length");
  assert.deepEqual(priceOf("claude-unknown"), { in: 10, out: 50, cached: 1, write: 12.5 }); // cached: Grok 4.7 over 200K tokens
  assert.deepEqual(priceOf("grok-4.7", 200_001), { in: 4, out: 12, cached: 1 });
  // the same model priced differently in two roles is refused
  const bad = structuredClone(raw);
  bad.roles["dev-review"].priceIn = 5;
  assert.throws(() => parseRegistry(bad), /claude-opus-5-5 is priced differently/);
  // a role without prices is allowed (its model is charged the worst case), but not a partial price
  const none = structuredClone(raw);
  for (const k of ["priceIn", "priceOut", "priceCached", "priceWrite", "longPrompt"]) delete none.roles["dev-worker"][k];
  assert.equal(parseRegistry(none).prices.has("claude-haiku-5-5"), false);
  const partial = structuredClone(raw);
  delete partial.roles["dev-worker"].priceOut;
  assert.throws(() => parseRegistry(partial), /priceIn, priceOut and priceCached together/);
  // unknown roles and missing roles are refused
  assert.throws(() => parseRegistry({ ...raw, roles: { ...raw.roles, extra: raw.roles.brain } }));
  const missing = structuredClone(raw);
  delete missing.roles.gate;
  assert.throws(() => parseRegistry(missing));
});

test("env overrides (outside the enclave): applied per role and reported", () => {
  const o = applyOverrides(BASE, { GROK_MODEL: "grok-4.3", REDTEAM_GATE_MODEL: "claude-opus-5-5", UNRELATED: "x" });
  assert.equal(o.roles.main.model, "grok-4.3");
  assert.equal(o.roles.intake.model, "grok-4.3");
  assert.equal(o.roles["x-voice"].model, "grok-4.3");
  assert.equal(o.roles.gate.model, "claude-opus-5-5");
  assert.equal(o.roles.brain.model, "claude-fable-5-1");
  assert.deepEqual(o.overrides, { main: "grok-4.3", research: "grok-4.3", intake: "grok-4.3", "x-voice": "grok-4.3", "x-scout": "grok-4.3", gate: "claude-opus-5-5" });
  assert.throws(() => applyOverrides(BASE, { NARRATE_MODEL: "claude-unknown" }), /no OpenRouter slug/);
  assert.throws(() => applyOverrides(BASE, { GROK_MODEL: "claude-opus-5-5" }), /research runs server-side search on xAI, grok only/);
  assert.deepEqual(applyOverrides(BASE, {}).overrides, {});
  assert.deepEqual(applyOverrides(BASE, { NARRATE_MODEL: "" }).overrides, {}, "an empty env is unset");
  assert.throws(() => applyOverrides(BASE, { NARRATE_MODEL: "gpt-9" }), /no provider/);
  // the registry file's hash and the active overrides go into every brain and model-change record
  const info = registryInfo(o);
  assert.match(info.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(info.overrides, o.overrides);
});

test("the site's model table (web/app/models/models.json) is the registry plus the studio's pinned models", async () => {
  const { TABLE_FILE, modelsTable } = await import("../scripts/models-table.ts");
  const { STUDIO_DEFAULTS } = await import("../src/studio.ts");
  assert.equal(readFileSync(TABLE_FILE, "utf8"), modelsTable(), "stale: run node scripts/models-table.ts");
  const rows = JSON.parse(modelsTable());
  assert.deepEqual(rows.map((r: { part: string }) => r.part), [...ROLES, "studio-image", "studio-rubric"]);
  for (const r of ROLES) {
    const row = rows.find((x: { part: string }) => x.part === r);
    assert.equal(row.model.id, raw.roles[r].model, r);
    assert.equal(row.backup.id, raw.roles[r].backup, r);
  }
  assert.equal(rows.at(-2).model.id, STUDIO_DEFAULTS.model);
  assert.equal(rows.at(-1).model.id, STUDIO_DEFAULTS.rubricModel);
  assert.doesNotMatch(modelsTable(), /price|usd|budget/i, "the site shows no prices");
});

test("an OpenRouter id back to ours, and which of an order's models have no price", () => {
  assert.equal(idOf("anthropic/claude-haiku-5.5"), "claude-haiku-5-5");
  assert.equal(idOf("claude-haiku-5-5"), "claude-haiku-5-5", "our own id as is");
  assert.equal(idOf("anthropic/claude-unknown-9"), undefined);
  assert.equal(idOf("constructor"), undefined);
  // every dev role's model and backup is priced today
  const dev = ROLES.filter((r) => r.startsWith("dev-")).flatMap((r) => [BASE.roles[r].model, BASE.roles[r].backup]);
  assert.deepEqual(unpriced(dev.map((id) => BASE.openrouter[id])), []);
  assert.deepEqual(unpriced(["anthropic/claude-opus-5.5", "anthropic/claude-unknown-9", "anthropic/claude-haiku-5.5"]), ["anthropic/claude-unknown-9"]);
  // a model with an OpenRouter id but no price in any role
  const none = structuredClone(raw);
  for (const k of ["priceIn", "priceOut", "priceCached", "priceWrite", "longPrompt"]) delete none.roles["dev-worker"][k];
  assert.deepEqual(unpriced(["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"], parseRegistry(none)), ["anthropic/claude-haiku-5.5"]);
});
