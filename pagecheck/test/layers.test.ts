// The planted page fixtures (test/fixtures/<name>/page.tsx), one per row of the page threat table, built into a real
// play origin (the repo's web app, SITE_ROLE=play: the real guard first in <head>, the real nonce CSP, GameRoot) and
// checked in Chromium. Each row asserts which layers fire: G11 (the static page lint, engine/src/seq-gates.ts), the
// wallet guard (a refusal: nothing it stopped reaches the wallet), the CSP (the browser blocks and reports), and G15
// (this harness: a violation means kill).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { check, type CheckInput, type CheckResult, PROFILES } from "../src/check.ts";
import { buildSite, prepareSite, removeSite, type Site, startSite } from "../src/site.ts";
import type { Anvil } from "../src/util.ts";
import { chain, chromiumPath, FACTORY, GAME } from "./helpers.ts";

const CHROMIUM = chromiumPath();
const WEB = new URL("../../web/", import.meta.url).pathname.replace(/\/$/, "");
const FIX = new URL("./fixtures/", import.meta.url).pathname;
const ORIGIN = "https://play.example.xyz";
const CODEHASH = "0x52262f711ffacf04147d1bc4b323c69df60a55163b5b86666f3c227f25a34008"; // keccak of helpers.ts WORD(0)
const gameJson = (slug: string) => JSON.stringify({ slug, title: slug, chainId: 1, address: GAME, codehash: CODEHASH, abi: [{ type: "function", name: "click", inputs: [], outputs: [], stateMutability: "nonpayable" }] });

type Gate = { ok: boolean; issues: string[] };
const ENGINE = new URL("../../engine/src/seq-gates.ts", import.meta.url).href;
let webGate: (files: Record<string, string>, slug: string) => Gate;
const g11 = (slug: string, files: Record<string, string>) => webGate(Object.fromEntries(Object.entries(files).map(([n, t]) => [`web/app/g/${slug}/${n}`, t])), slug);

const kinds = (r: CheckResult) => r.violations.map((v) => `${v.kind}: ${v.detail}`);
const has = (r: CheckResult, re: RegExp) => kinds(r).some((k) => re.test(k));
const reachedUnguarded = (r: CheckResult) => r.requests.filter((q) => !q.viaGuard);

/** One row: what G11 says, and what the check says (with the guard's and the CSP's part in it). */
type Row = { g11: RegExp | "misses"; run?: Partial<CheckInput>; assert: (r: CheckResult) => void };
const ROWS: Record<string, Row> = {
  honest: {
    g11: "misses",
    run: { profiles: PROFILES, randoms: [0, 0.5] },
    assert: (r) => {
      assert.deepEqual(kinds(r), []);
      assert.ok(r.requests.some((q) => q.method === "eth_sendTransaction" && q.viaGuard && q.to === GAME), "the game's own send went through the guard");
    },
  },
  obfuscated: { // G11 first; the CSP makes the Function constructor throw (and reports it); G15 kills on the report
    g11: /constructor|atob/,
    assert: (r) => { assert.ok(has(r, /^csp: report: script-src blocked eval/)); assert.deepEqual(r.requests.filter((q) => q.method === "eth_sendTransaction"), []); },
  },
  stringwalk: { // G11 misses; the guard refuses the foreign target; G15 kills on the refusal
    g11: "misses",
    assert: (r) => { assert.ok(has(r, /^refused: eth_sendTransaction: transactions go only to this game/)); assert.deepEqual(reachedUnguarded(r), []); },
  },
  timebomb: { // only after 36 h: the clock gets there (a 24 h run would not: harness.test.ts)
    g11: "misses",
    assert: (r) => assert.ok(has(r, /^refused: eth_getCode: eth_getCode only of the game or the factory/)),
  },
  forged: { // tx.ts with a forged GameJson: the guard refuses the foreign address; G15 kills
    g11: "misses",
    assert: (r) => { assert.ok(has(r, /^refused: eth_getCode/)); assert.deepEqual(r.requests.filter((q) => q.method === "eth_sendTransaction"), []); },
  },
  approve: { // G11 first (the name); the guard refuses a selector the game doesn't have; G15 kills
    g11: /approve/,
    assert: (r) => assert.ok(has(r, /^refused: eth_sendTransaction: not one of this game's functions/)),
  },
  exfil: { // G11 first; the CSP blocks it before it leaves; G15 kills on the report
    g11: /fetch|URL/,
    assert: (r) => assert.ok(has(r, /^csp: report: connect-src blocked https:\/\/x\.example/)),
  },
  remote: { // the CSP blocks the remote script (no nonce, no remote hosts); G11 too; G15 kills on the report
    g11: /script|URL/,
    assert: (r) => assert.ok(has(r, /^csp: report: script-src(-elem)? blocked https:\/\/x\.example\/a\.js/)),
  },
  srcdoc: { // G11 first; G15 kills on the frame
    g11: /iframe|srcdoc|contentWindow/i,
    assert: (r) => assert.ok(has(r, /^frame: /)),
  },
  popup: { // G11 first; G15 kills on the new window
    g11: /\bopen\b/,
    assert: (r) => assert.ok(has(r, /^popup: /)),
  },
  alias: { // G11 first; the guard already made the alias undefined, so nothing is touched and nothing reaches a wallet
    g11: /globalThis|computed/,
    assert: (r) => { assert.ok(!has(r, /^decoy: /)); assert.deepEqual(r.requests.filter((q) => q.method === "eth_sendTransaction"), []); },
  },
  pollution: { // the guard's captured primordials: only the guarded provider is ever announced; it refuses
    g11: /prototype/,
    assert: (r) => { assert.ok(has(r, /^refused: eth_sendTransaction: transactions go only to this game/)); assert.deepEqual(reachedUnguarded(r), []); },
  },
  randomgate: { // found by the sweep at 0, and only there
    g11: "misses",
    run: { randoms: [0.5, 0] },
    assert: (r) => { assert.ok(r.violations.length > 0); assert.ok(r.violations.every((v) => v.run === "desktop@0"), JSON.stringify(r.violations)); },
  },
  navleak: { // G11 first; the route sees the top-level navigation and blocks it; G15 kills
    g11: /location|URL/,
    assert: (r) => assert.ok(has(r, /^network: navigation to https:\/\/x\.example/)),
  },
  headless: { // a page that waits for "no automation": the realistic profile has none, so it acts, and is caught
    g11: "misses",
    assert: (r) => assert.ok(has(r, /^refused: eth_getCode/)),
  },
  throwing: { // a page module that throws while loading
    g11: "misses",
    assert: (r) => assert.ok(has(r, /^throws: /) || has(r, /^not-mounted: /), JSON.stringify(r.violations)),
  },
  toplevel: { // the page module's top-level code runs after the guard: it holds the guarded provider, which refuses
    g11: /globalThis/,
    assert: (r) => { assert.ok(has(r, /^refused: personal_sign/)); assert.deepEqual(reachedUnguarded(r), []); },
  },
};

/** The sequencer's game templates (contracts/docs/games.md, "Templates"): their pages must pass like the honest one. */
const TEMPLATES = ["daily-checkin", "last-buyer", "raffle"];
const templateFiles = (t: string) => {
  const dir = join(WEB, `app/g/_template-${t}`);
  const abi = JSON.parse(readFileSync(join(dir, "game.json"), "utf8")).abi;
  return { "page.tsx": readFileSync(join(dir, "page.tsx"), "utf8"), "page.module.css": readFileSync(join(dir, "page.module.css"), "utf8"), "game.json": JSON.stringify({ slug: t, title: t, chainId: 1, address: GAME, codehash: CODEHASH, abi }) };
};

const pageOf = (name: string) => name === "honest" ? readFileSync(join(WEB, "app/g/_template/page.tsx"), "utf8") : readFileSync(join(FIX, name, "page.tsx"), "utf8");
const css = () => readFileSync(join(WEB, "app/g/_template/page.module.css"), "utf8");

describe("page fixtures through every layer", { skip: CHROMIUM ? false : "needs a Chromium (PAGECHECK_CHROMIUM)" }, () => {
  let a: Anvil;
  let site: Site;
  let dir = "";
  before(async () => {
    webGate = ((await import(ENGINE)) as { webGate: typeof webGate }).webGate;
    const games: Record<string, Record<string, string>> = {};
    for (const n of Object.keys(ROWS)) games[n] = { "page.tsx": pageOf(n), "game.json": gameJson(n), ...(n === "honest" ? { "page.module.css": css() } : {}) };
    for (const t of TEMPLATES) games[t] = templateFiles(t);
    dir = prepareSite(WEB, games);
    await buildSite(dir);
    a = await chain();
    site = await startSite(dir, { rpc: a.url, factory: FACTORY });
  });
  after(() => { site?.stop(); a?.stop(); if (dir) removeSite(dir); });

  test("every fixture folder has a row", () => {
    assert.deepEqual(readdirSync(FIX).sort(), Object.keys(ROWS).filter((n) => n !== "honest").sort());
  });

  test("a wallet the guard can't take over: the guard fails closed and the game's code never mounts (GameRoot)", async () => {
    const r = await check({
      origin: ORIGIN, slug: "honest", game: GAME, factory: FACTORY, backend: { url: site.url }, rpc: a.url, chromium: CHROMIUM!,
      hours: 1, stepHours: 1, rounds: 1, randoms: [0.5], profiles: [PROFILES[1]], lockedWallet: true,
    });
    assert.ok(has(r, /^guard: /), JSON.stringify(r.violations));
    assert.ok(has(r, /^not-mounted: [\s\S]*can't reach your wallet safely/), JSON.stringify(r.violations));
    assert.deepEqual(r.requests, [], "nothing reached the wallet");
  });

  for (const t of TEMPLATES) {
    test(`the ${t} template's page: G11 passes, and the check finds nothing over two days`, async () => {
      const files = templateFiles(t);
      const g = g11(t, files);
      assert.equal(g.ok, true, g.issues.join("; "));
      const r = await check({
        origin: ORIGIN, slug: t, game: GAME, factory: FACTORY, backend: { url: site.url }, rpc: a.url, chromium: CHROMIUM!,
        hours: 48, stepHours: 12, rounds: 1, randoms: [0.5], profiles: [PROFILES[1]],
      });
      assert.deepEqual(kinds(r), []);
      assert.equal(r.ok, true);
      assert.ok(r.requests.some((q) => q.method === "eth_sendTransaction" && q.viaGuard && q.to === GAME), "the page's own send went through the guard");
    });
  }

  for (const [name, row] of Object.entries(ROWS)) {
    test(name, async () => {
      const files = { "page.tsx": pageOf(name), "game.json": gameJson(name) };
      const g = g11(name, files);
      if (row.g11 === "misses") assert.equal(g.ok, true, `G11 was expected to miss ${name}: ${g.issues.join("; ")}`);
      else assert.ok(!g.ok && g.issues.some((i) => (row.g11 as RegExp).test(i)), `G11 on ${name}: ${g.issues.join("; ")}`);
      const r = await check({
        origin: ORIGIN, slug: name, game: GAME, factory: FACTORY, backend: { url: site.url }, rpc: a.url, chromium: CHROMIUM!,
        hours: 48, stepHours: 12, rounds: 1, randoms: [0.5], profiles: [PROFILES[1]], ...row.run,
      });
      if (process.env.PC_DEBUG) console.log(name, JSON.stringify(r.violations), JSON.stringify(r.notes.slice(0, 5)));
      row.assert(r);
      if (name !== "honest") assert.equal(r.ok, name === "alias", `${name}: ${JSON.stringify(r.violations)}`);
    });
  }
});
