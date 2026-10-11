// Every game template, built the way the dev team builds from one: the lead's plan names it, the workers copy its
// contract, tests and page into a new game's folders, the build's own suite run and self-check pass on the first test
// round, and the published result passes the enclave's gates (G1 to G9, G11 to G13) through the real runGates. A held
// template (kept, not offered to the lead) is gated the same way, copied by a plan that names no template.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import type { Hex } from "viem";
import { runGates } from "../../engine/src/seq-forge.ts";
import { parseRaw, RESERVED } from "../../engine/src/seq-gates.ts";
import type { Order } from "../../engine/src/seq-order.ts";
import { scriptDriver, type Query } from "../src/driver.ts";
import { HELD_TEMPLATES, Plan, TEMPLATES, templateRoots } from "../src/roles.ts";
import { build } from "../src/run.ts";
import { checkout } from "./checkout.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const hasForge = (() => { try { execFileSync("forge", ["--version"], { stdio: "ignore" }); return existsSync(join(REPO, "contracts/lib/forge-std/src/Test.sol")); } catch { return false; } })();

/** Each template's contract name and an order's spec that asks for it. */
const T: Record<(typeof TEMPLATES)[number] | (typeof HELD_TEMPLATES)[number], { name: string; spec: string }> = {
  "daily-checkin": { name: "DailyCheckin", spec: "A daily check-in: each address checks in once a UTC day and the day's check-ins split a small share of the pot. Template: daily-checkin." },
  "last-buyer": { name: "LastBuyer", spec: "Last player wins: each play restarts a countdown and the last player when it runs out wins a tenth of the pot. Template: last-buyer." },
  raffle: { name: "Raffle", spec: "A raffle: players enter with a hidden ticket, reveal it once entries close, and one revealed entrant wins a tenth of the pot. Template: raffle." },
};
/** The kit's own functions: a plan's interface lists the rest. */
const KIT = new Set(["SWEEP_BACKSTOP", "claim", "factory", "freeBalance", "fund", "owed", "owedTotal", "pause", "paused", "retire", "retired", "retiredAt", "safe", "sweep"]);
type AbiFn = { type: string; name: string; inputs: { type: string }[] };

test("no build may take a template's folder name; only the offered templates are a plan's choice", () => {
  for (const t of [...TEMPLATES, ...HELD_TEMPLATES]) assert.ok(RESERVED.has(t), `${t} is not reserved`);
  const plan = { title: "Raffle", interface: [], tasks: [{ goal: "Write the game contract.", files: ["contracts/src/games/x/X.sol"] }], tests: [] };
  for (const t of TEMPLATES) assert.equal(Plan.safeParse({ ...plan, template: t }).success, true, t);
  for (const t of HELD_TEMPLATES) assert.equal(Plan.safeParse({ ...plan, template: t }).success, false, `${t} is held`);
});

describe("a game built from each template", { skip: hasForge ? false : "needs forge and forge-std" }, () => {
  const made: string[] = [];
  after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

  for (const t of [...TEMPLATES, ...HELD_TEMPLATES]) {
    const held = (HELD_TEMPLATES as readonly string[]).includes(t);
    test(`${t}${held ? " (held)" : ""}: copied, it passes the build's self-check and every gate of runGates`, async () => {
      const { dir, base } = checkout();
      made.push(dir);
      const slug = `my-${t}`;
      const { name, spec } = T[t];
      const [src, tst, web] = templateRoots(t);
      // the copy: the template's files in the game's folders, the test's import pointed at the game's folder
      const files: Record<string, string> = {
        [`contracts/src/games/${slug}/${name}.sol`]: readFileSync(join(dir, src, `${name}.sol`), "utf8"),
        [`contracts/test/games/${slug}/${name}.t.sol`]: readFileSync(join(dir, tst, `${name}.t.sol`), "utf8").replaceAll(`games/${t}/`, `games/${slug}/`),
        [`web/app/g/${slug}/page.tsx`]: readFileSync(join(dir, web, "page.tsx"), "utf8"),
        [`web/app/g/${slug}/page.module.css`]: readFileSync(join(dir, web, "page.module.css"), "utf8"),
      };
      const abi = JSON.parse(readFileSync(join(dir, web, "game.json"), "utf8")).abi as AbiFn[];
      const iface = abi.filter((f) => f.type === "function" && !KIT.has(f.name)).map((f) => `${f.name}(${f.inputs.map((i) => i.type).join(",")})`);
      const keys = Object.keys(files);
      const plan = {
        title: name.replace(/([a-z])([A-Z])/g, "$1 $2"), template: held ? "none" : t, interface: iface, tests: ["the template's tests", "the conformance suite"],
        tasks: [
          { goal: `Copy the ${t} template's contract.`, files: [keys[0]] },
          { goal: `Copy the ${t} template's tests.`, files: [keys[1]] },
          { goal: `Copy the ${t} template's page.`, files: [keys[2], keys[3]] },
        ],
      };
      const o: Order = {
        v: 1, id: `o-tpl-${t}`, build: "b-tpl", round: 1, slug, salt: `0x${"cd".repeat(32)}`, factory: "0x5fbdb2315678afecb367f032d93f642f64180aa3", safe: "0x00000000000000000000000000000000000005af",
        baseSha: base, spec, specSha256: createHash("sha256").update(spec).digest("hex"), rubric: { value: 4, fit: 5, clarity: 4, originality: 3 },
        models: { lead: "anthropic/claude-opus-5.5", worker: "anthropic/claude-haiku-5.5", tester: "anthropic/claude-sonnet-5.5", fixer: "anthropic/claude-sonnet-5.5", review: "anthropic/claude-opus-5.5" },
        effort: { lead: "medium", worker: "max", tester: "high", fixer: "high", review: "high" },
        budget: { ceilingUsd: 12, perQueryUsd: { lead: 2, worker: 0.5, tester: 1, fixer: 1, review: 2 } }, fixRounds: 3, issues: [], expiresAt: "2099-01-01T00:00:00Z",
      };
      const calls: Query[] = [];
      const driver = scriptDriver((q) => {
        calls.push(q);
        if (q.role === "lead") return { output: plan };
        if (q.role === "worker") {
          for (const f of q.access.write) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), files[f]); }
          return {};
        }
        if (q.role === "tester") return { output: { pass: true, findings: [] } };
        if (q.role === "review") return { output: { ready: true, review: "Matches the spec.", prBody: `${plan.title}, built from the ${t} template with its tests and the shared conformance suite.` } };
        return {};
      });
      const r = await build(o, dir, driver, {});
      assert.equal(r.ok, true, r.why);
      // the suite and the self-check passed on the first round: nothing went to the fixer
      assert.deepEqual(r.report.tests, [{ round: 1, pass: true, findings: [] }]);
      assert.deepEqual(calls.map((c) => c.role), ["lead", "worker", "worker", "worker", "tester", "review"]);
      assert.equal(r.plan?.template, held ? "none" : t);

      // the enclave's view of the committed result
      const g = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]).toString();
      g("add", "-A"); g("commit", "-qm", "build");
      const changes = parseRaw(g("diff", "--raw", "-z", "--no-abbrev", "-M", base, "HEAD"));
      const texts = Object.fromEntries(changes.map((c) => [c.path, readFileSync(join(dir, c.path), "utf8")]));
      for (const c of changes) c.size = texts[c.path].length;
      const run = await runGates({ slug, changes, files: texts, baseHasSlug: false, prBody: r.prBody!, kit: join(dir, "contracts"), order: { seed: `seed-${t}`, specSha256: o.specSha256, factory: o.factory as Hex, salt: o.salt as Hex, safe: o.safe as Hex } });
      assert.deepEqual(run.results.filter((x) => !x.ok), []);
      assert.deepEqual(run.results.map((x) => x.gate).sort(), ["G1", "G11", "G12", "G13", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"]);
    });
  }
});
