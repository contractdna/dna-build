// Character memory (src/character.ts) feeds the X writer only. No module that decides or moves money may reach it,
// directly or through any chain of imports (static, re-export or dynamic import()). The X send path reads it through
// a slot that only the process entry point fills.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";

const SRC = resolve(import.meta.dirname, "../src");
const SPEC = /\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|\bimport\s*["'](\.{1,2}\/[^"']+)["']/g;

/** Every local module `file` reaches, with the import chain that reaches it. */
function reach(file: string) {
  const seen = new Map<string, string[]>();
  const walk = (f: string, chain: string[]) => {
    if (seen.has(f)) return;
    seen.set(f, chain);
    for (const m of readFileSync(f, "utf8").matchAll(SPEC)) walk(resolve(dirname(f), m[1] ?? m[2] ?? m[3]), [...chain, f]);
  };
  walk(resolve(file), []);
  return seen;
}

const CHARACTER = resolve(SRC, "character.ts");
const MONEY = ["brain.ts", "rewards.ts", "funding.ts", "sequencer.ts", "tx.ts"];

test("character memory is unreachable from the brain and from every money path", () => {
  for (const m of MONEY) {
    const r = reach(resolve(SRC, m));
    const chain = r.get(CHARACTER);
    assert.equal(chain, undefined, `${m} reaches character.ts via ${chain?.map((c) => relative(SRC, c)).join(" → ")}`);
  }
});

test("only the process entry point wires character memory in (src/x.ts gets it through CHARACTER_MEMORY)", () => {
  const importers = readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== "character.ts")
    .filter((f) => [...readFileSync(resolve(SRC, f), "utf8").matchAll(SPEC)].some((m) => resolve(SRC, m[1] ?? m[2] ?? m[3]) === CHARACTER));
  assert.deepEqual(importers, ["engine.ts"]);
});

test("the import walk follows static, re-export and dynamic imports", () => {
  const r = reach(resolve(SRC, "log.ts")); // log.ts imports signed.ts only through import()
  assert.ok(r.has(resolve(SRC, "signed.ts")));
  assert.ok(reach(resolve(SRC, "engine.ts")).has(CHARACTER), "the entry point does reach it (the walk is not vacuous)");
});
