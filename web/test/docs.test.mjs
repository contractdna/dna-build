// /docs content rules: same chapters in both modes, dumb mode stays short, no banned claims.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { LIVE } from "../app/_data/flags.ts";
import { CHAPTERS, ENGINE_BASE, parseMode, SOURCE_BASE } from "../app/docs/content.ts";

test("15 chapters with unique anchors, both modes filled, risks last", () => {
  assert.equal(CHAPTERS.length, 15);
  assert.equal(new Set(CHAPTERS.map((c) => c.id)).size, 15);
  for (const c of CHAPTERS) {
    assert.ok(/^[a-z]+$/.test(c.id), c.id);
    assert.ok(c.dumb.length >= 1 && c.dumb.length <= 3, `${c.id}: dumb mode is 1–3 lines`);
    assert.ok(c.smart.lead && c.smart.facts.length && c.smart.links.length, `${c.id}: smart mode has lead, facts, links`);
  }
  assert.equal(CHAPTERS.at(-1).id, "risks");
});

test("no banned claims, no em dashes in the copy", () => {
  const text = JSON.stringify(CHAPTERS).toLowerCase();
  for (const bad of ["unstoppable", "fully autonomous", "rug-proof", "rugproof", "no admin", "guaranteed", "passive income", "delve", "—"]) {
    assert.ok(!text.includes(bad), `copy contains "${bad}"`);
  }
  const risks = CHAPTERS.find((c) => c.id === "risks").dumb.join(" ");
  assert.match(risks, /zero/);
  assert.match(risks, /draw, not income/);
});

test("no source host before launch: every repo link is pending", { skip: LIVE && "live build (the next test pins it)" }, () => {
  assert.equal(SOURCE_BASE, null);
  assert.equal(ENGINE_BASE, null);
  const text = JSON.stringify(CHAPTERS).toLowerCase();
  for (const bad of ["github", "ghcr"]) assert.ok(!text.includes(bad), `copy contains "${bad}"`);
  for (const c of CHAPTERS) for (const l of c.smart.links) assert.ok(l.href === null || l.href.startsWith("/"), `${c.id}: ${l.label}`);
});

test("present tense: nothing in the docs waits for a launch that happened", () => {
  const copy = JSON.stringify(CHAPTERS.map((c) => [c.dumb, c.smart.lead, c.smart.facts, c.smart.notes ?? []])).toLowerCase();
  for (const bad of [/\bsoon\b/, /when its sealed engine is live/, /once the sequencer is live/, /\bin build\b/, /published at launch/]) assert.ok(!bad.test(copy), `copy matches ${bad}`);
});

test("live build: the source is the project's own org at the launched commit", () => {
  const mod = new URL("../app/docs/content.ts", import.meta.url).href;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(mod)}); console.log(JSON.stringify({ src: m.SOURCE_BASE, eng: m.ENGINE_BASE, chapters: m.CHAPTERS }))`],
    { env: { ...process.env, NEXT_PUBLIC_LIVE: "1" } }).toString().trim();
  const { src, eng, chapters } = JSON.parse(out);
  assert.match(src, /^https:\/\/github\.com\/contractdna\/dna-contracts\/blob\/[0-9a-f]{40}$/);
  assert.match(eng, /^https:\/\/github\.com\/contractdna\/dna-build\/blob\/[0-9a-f]{40}$/);
  // every link resolves: a site page, a contracts file, or an engine file; none pending
  for (const c of chapters) for (const l of c.smart.links) {
    assert.ok(l.href?.startsWith("/") || l.href?.startsWith(`${src}/contracts/`) || l.href?.startsWith(`${eng}/`), `${c.id}: ${l.label}`);
  }
  const copy = JSON.stringify(chapters.map((c) => [c.dumb, c.smart.lead, c.smart.facts, c.smart.notes ?? []])).toLowerCase();
  for (const bad of ["github", "ghcr"]) assert.ok(!copy.includes(bad), `copy contains "${bad}"`);
});

test("the idea rewards chapter carries the canonical sentence", () => {
  const r = CHAPTERS.find((c) => c.id === "rewards");
  assert.ok(r.dumb.includes("70% of the games pot is the jackpot. 30% pays the people whose ideas the AI ships. the brain sets each amount, and every payment waits one public hour."));
  assert.ok(r.smart.facts.some((f) => f.at?.includes("GamePot.queueReward")));
});

test("the vaults chapter: 50 equal vaults, the deposit, the Safe's fund, no promise", () => {
  const v = CHAPTERS.find((c) => c.id === "vaults");
  assert.ok(v, "a vaults chapter");
  const copy = JSON.stringify([v.dumb, v.smart]).toLowerCase();
  for (const must of ["200,000 dna", "at most 50", "nothing is promised", "2.5% royalty", "all equal"]) assert.ok(copy.includes(must), `vaults chapter says "${must}"`);
  for (const bad of ["apy", "apr", "yield", "income", "best vault", "rank"]) assert.ok(!copy.includes(bad), `vaults chapter never says "${bad}"`);
  assert.ok(v.smart.links.some((l) => l.href === "/vaults"));
});

test("mode parsing", () => {
  assert.equal(parseMode("dumb"), "dumb");
  assert.equal(parseMode("smart"), "smart");
  for (const v of [null, undefined, "", "SMART", "x"]) assert.equal(parseMode(v), null);
});
