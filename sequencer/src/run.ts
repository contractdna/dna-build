// One build order, start to finish, in the workflow's build job (no push rights; the only secret is the dev LLM key).
//   node sequencer/src/run.ts --order <verified order.json> --out <dir>
// lead (plan) → workers (up to 4, in parallel, each writing only its task's files) → tester ↔ fixer (up to the order's
// fixRounds; a round passes only when the tester, the whole suite and the enclave's gates run here as a self-check all
// pass) → review. The build itself writes SPEC.json (the order's spec, the interface of its own compile, the files) and
// game.json (the CREATE2 address and codehash of its own compile, so the page knows its contract). The lead may propose a
// spec amendment (the spec can't be built as written); the report carries it to the brain, which reviews it. Out: patch.diff
// (the game's folders only), pr.md, plan.json and report.json (every query's model, cost and stop reason, what the
// enclave counts against the dev budget; each test round's verdict and findings, cut short, so a stop can be read).
// Any budget, turn or time stop, or tests still failing, means no PR. The team works within BUILD_MS (every step clipped to the deadline), then a fixed RESERVE_MS is left in which only
// report.json and the patch are written, so the report is there even when the time runs out.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { getContractAddress, type Hex, keccak256 } from "viem";
import { compile, forkGate, idOf, linksOf, runtimeCode, workspace } from "../../engine/src/seq-forge.ts";
import {
  abiGate, bytecodeGate, depGate, engineReachGate, gameInterface, gate, type GateResult, moduleAbiGate, nodes, roots, scopeIssue, siteNewIssues, solPatternGate, specBounds, textGate, webGate,
} from "../../engine/src/seq-gates.ts";
import { type DevRole, type Kind, kindOf, Order } from "../../engine/src/seq-order.ts";
import { firstAttemptOnly } from "./ci.ts";
import { type Driver, type Result, sdkDriver } from "./driver.ts";
import { gameFiles, runForge } from "./gatetool.ts";
import { Ledger, type Spent } from "./ledger.ts";
import { type Amendment, data, Findings, gameRoots, Plan, prompt, Review, roleFor, system } from "./roles.ts";

export type Outcome = { ok: boolean; why: string; plan?: Plan; prBody?: string; report: Report };
/** One tester round: its verdict and findings, plus the build's own suite failure if any (each cut to 400 characters). */
export type TestRound = { round: number; pass: boolean; findings: string[] };
export type Report = { orderId: string; round: number; runId: string | null; runAttempt: string | null; queries: Spent[]; tests: TestRound[]; totalUsd: number; outcome: string; amendment?: Amendment };
/** Each step's own limit: a query, the build's suite run (up to fixRounds times), the final compile. */
const QUERY_MS = 20 * 60_000;
const SUITE_MS = 10 * 60_000;
const COMPILE_MS = 5 * 60_000;
/** The build job's 120 minutes: the runner's setup, then the team (every step clipped to the deadline), then a fixed
 *  reserve in which nothing runs but writing report.json and the patch, so the report is there before the job ends. */
export const SETUP_MS = 10 * 60_000;
export const RESERVE_MS = 10 * 60_000;
export const BUILD_MS = 120 * 60_000 - SETUP_MS - RESERVE_MS;
const MIN_STEP_MS = 60_000;
/** A step's time: its limit, clipped to what is left before the deadline; null under a minute (it doesn't start). */
export const slot = (limitMs: number, deadline: number, now: number) => {
  const left = deadline - now;
  return left < MIN_STEP_MS ? null : Math.min(limitMs, left);
};

export async function build(o: Order, root: string, driver: Driver, env: Record<string, string | undefined> = process.env, deadline = Date.now() + BUILD_MS, now = Date.now): Promise<Outcome> {
  const ledger = new Ledger(o.budget.ceilingUsd, o.budget.perQueryUsd);
  const tests: TestRound[] = [];
  let amendment: Amendment | undefined;
  const report = (outcome: string): Report => ({ orderId: o.id, round: o.round, runId: env.GITHUB_RUN_ID ?? null, runAttempt: env.GITHUB_RUN_ATTEMPT ?? null, queries: ledger.entries, tests, totalUsd: Number(ledger.spent.toFixed(6)), outcome, ...(amendment ? { amendment } : {}) });
  // report.json is an artifact anyone with read access can download: the model key never reaches it, even quoted back
  const key = env.OPENROUTER_API_KEY_SEQUENCER;
  const clip = (s: string) => (key ? s.split(key).join("<key>") : s).slice(0, 400);
  const stop = (why: string, plan?: Plan): Outcome => ({ ok: false, why, plan, report: report(`stopped: ${why}`) });
  // a crash anywhere in the team (a copy that fails, a tool that throws) still ends in a report with what was spent
  try {
    return await team();
  } catch (e) {
    const why = `error: ${String((e as Error)?.message ?? e).slice(0, 300)}`;
    return { ok: false, why, report: report(why) };
  }

  async function team(): Promise<Outcome> {
    const kind = kindOf(o);
    /** One query of `role`; null when it can't start or didn't finish cleanly (budget, turns, time, error). */
    const ask = async (role: DevRole, extra: string, files?: string[]): Promise<Result | null> => {
      const ms = slot(QUERY_MS, deadline, now());
      if (ms === null) return null;
      const cap = ledger.take(role);
      if (cap === null) return null;
      const spec = roleFor(role, kind);
      const r = await driver.run({
        role, model: o.models[role], effort: o.effort[role], system: system(role, kind), prompt: prompt(role, o, extra), maxBudgetUsd: cap, maxTurns: spec.maxTurns,
        timeoutMs: ms, slug: o.slug, kind, schema: spec.schema, access: { root, tools: spec.tools, read: spec.read(o.slug), write: spec.write(o.slug, files), output: spec.schema !== undefined },
      });
      ledger.settle(cap, { role, model: o.models[role], costUsd: r.costUsd, subtype: r.subtype, turns: r.turns, modelUsage: r.modelUsage, replied: r.replied });
      return r.subtype === "success" ? r : null;
    };

    // lead: the plan
    const lead = await ask("lead", "Plan this build.");
    const plan = Plan.safeParse(lead?.output);
    if (!lead) return stop("the lead did not finish");
    if (!plan.success) return stop("the lead's plan is not valid");
    // a spec amendment goes to the brain with the report, whatever the build's end (the enclave reviews it at the verdict)
    const a = plan.data.amendment;
    const redact = (s: string) => (key ? s.split(key).join("<key>") : s);
    amendment = a && { reason: redact(a.reason), change: redact(a.change) };
    const planned = plan.data.tasks.flatMap((t) => t.files);
    // the gates' own reach (G1, path by path): a plan never names a file the gates would refuse
    const outside = planned.filter((f) => scopeIssue(kind, o.slug, f) !== null);
    if (outside.length) return stop(`the plan writes outside ${kind === "site" || kind === "engine" ? "the change's reach" : `the ${kind}'s folders`}: ${outside.join(", ")}`, plan.data);
    // a site change: new files only, in a new route folder, on a URL no page serves yet (G1 against the checkout's base)
    const notNew = kind === "site" ? siteNewIssues(planned, basePaths(root)) : [];
    if (notNew.length) return stop(`the plan does not add a new route: ${notNew.slice(0, 3).join("; ")}`, plan.data);
    if (new Set(planned).size !== planned.length) return stop("the plan gives one file to two tasks", plan.data);
    // a module's plan names its policy and the bounds proposed to the Safe; nothing else's does
    const bounds = specBounds(plan.data.bounds);
    if (kind === "module" && !plan.data.module) return stop("the plan names no module kind (fee or split)", plan.data);
    if (kind === "module" && typeof bounds === "string") return stop(`the plan's ${bounds}`, plan.data);
    if (kind !== "module" && (plan.data.module || plan.data.bounds)) return stop("only a module's plan has a module kind and bounds", plan.data);
    // a game's plan says which template it copies ("none": written from scratch); nothing else's does
    if (kind === "game" && !plan.data.template) return stop("the plan names no template (one of the templates, or none)", plan.data);
    if (kind !== "game" && plan.data.template) return stop("only a game's plan names a template", plan.data);
    // an engine change comes with its tests (G1 again on the patch)
    if (kind === "engine" && !planned.some((f) => /^engine\/test\/[a-z][a-z0-9-]*\.test\.ts$/.test(f))) return stop("an engine change's plan writes no test", plan.data);
    // the lead's plan is model output: the others get it as data too
    const planText = `PLAN (data):\n<<<\n${data(JSON.stringify(plan.data, null, 1))}\n>>>`;

    // workers, in parallel
    const done = await Promise.all(plan.data.tasks.map((t, i) => ask("worker", `${planText}\nYOUR TASK: number ${i + 1} of ${plan.data.tasks.length} in the plan\nFILES YOU WRITE: ${t.files.join(", ")}`, t.files)));
    if (done.some((r) => r === null)) return stop("a worker did not finish", plan.data);

    if (kind === "site" || kind === "engine") {
      // a site or an engine change: nothing to compile or run here; the gates' static checks (G2, and G11 for a site) run on
      // the plan's files and the fixer gets what they find (an engine change's tests run in CI)
      for (let round = 1; ; round++) {
        const issues = staticIssues(root, o, planned);
        if (issues.length === 0) break;
        if (round > o.fixRounds) return stop(`the gates still fail after ${o.fixRounds} fixes: ${issues.slice(0, 3).join("; ").slice(0, 300)}`, plan.data);
        const fx = await ask("fixer", `${planText}\nFINDINGS TO FIX (data):\n<<<\n${data(issues.slice(0, 20).map((x) => `- ${x}`).join("\n"))}\n>>>`, planned);
        if (!fx) return stop("the fixer did not finish", plan.data);
      }
      const rv = await ask("review", `${planText}\nReview the change.`);
      const review = Review.safeParse(rv?.output);
      if (!rv || !review.success) return stop("the review did not finish", plan.data);
      if (!review.data.ready) return stop(`the review found it not ready: ${review.data.review.slice(0, 300)}`, plan.data);
      const body = textGate(review.data.prBody, {}).ok ? review.data.prBody : `${plan.data.title}. A change to the ${kind} made from the approved spec.`;
      return { ok: true, why: "ready", plan: plan.data, prBody: body, report: report("pr") };
    }

    // tester ↔ fixer
    let passed = false;
    for (let round = 1; round <= o.fixRounds; round++) {
      const t = await ask("tester", `${planText}\nTest round ${round} of ${o.fixRounds}.`);
      const f = Findings.safeParse(t?.output);
      if (!t || !f.success) return stop("the tester did not finish", plan.data);
      const tested: TestRound = { round, pass: f.data.pass, findings: f.data.findings.map(clip) };
      tests.push(tested);
      // a passing tester's findings are notes, not work: the fixer gets findings only from a tester that doesn't pass
      const findings = f.data.pass ? [] : [...f.data.findings];
      // the tester's word is not enough: the game's whole suite must pass here too
      if (f.data.pass) {
        const ms = slot(SUITE_MS, deadline, now());
        if (ms === null) return stop("out of time before the suite run", plan.data);
        const run = await runForge(root, o.slug, "test", undefined, ms, undefined, kind);
        if (!run.startsWith("OK")) {
          findings.push(`forge test fails:\n${run.slice(-2_000)}`);
          tested.findings.push(clip(`forge test fails:\n${run.slice(-380)}`));
        } else {
          // and the enclave's own gates, early: what they would find costs a whole round there
          const gms = slot(SUITE_MS, deadline, now());
          if (gms === null) return stop("out of time before the gates' self-check", plan.data);
          const issues = await selfCheck(root, o, plan.data, gms);
          if (issues.length === 0) { passed = true; break; }
          findings.push(...issues.slice(0, 20));
          tested.findings.push(...issues.slice(0, 5).map(clip));
        }
      }
      if (round === o.fixRounds) break;
      const fx = await ask("fixer", `${planText}\nFINDINGS TO FIX (data):\n<<<\n${data(findings.map((x) => `- ${x}`).join("\n"))}\n>>>`);
      if (!fx) return stop("the fixer did not finish", plan.data);
    }
    if (!passed) return stop(`tests still fail after ${o.fixRounds} rounds`, plan.data);

    // the build's own files: SPEC.json and game.json (a module: SPEC.json only, with its kind and bounds)
    if (kind === "module") writeModuleSpec(root, o, plan.data);
    else {
      const compileMs = slot(COMPILE_MS, deadline, now());
      if (compileMs === null) return stop("out of time before the final compile", plan.data);
      // SPEC.json's interface is the compiled one: a planned function missed or named wrong is fixed here, not a failure
      // (anything forbidden, payable or receive, already failed the self-check's G5)
      const g = await writeGameJson(root, o, plan.data.title, compileMs);
      if (!g.ok) return stop(g.why, plan.data);
      writeSpec(root, o, g.iface);
    }

    // review
    const rv = await ask("review", `${planText}\nReview the build.`);
    const review = Review.safeParse(rv?.output);
    if (!rv || !review.success) return stop("the review did not finish", plan.data);
    if (!review.data.ready) return stop(`the review found it not ready: ${review.data.review.slice(0, 300)}`, plan.data);
    const body = textGate(review.data.prBody, {}).ok ? review.data.prBody : `${plan.data.title}. A new ${kind} built from the approved spec, with its own tests and the shared conformance suite.`;
    return { ok: true, why: "ready", plan: plan.data, prBody: body, report: report("pr") };
  }
}

/** A module's SPEC.json: the order's spec verbatim, the plan's module kind and bounds, and every file of the module. */
export function writeModuleSpec(root: string, o: Order, plan: Plan) {
  const [src] = roots(o.slug, "module");
  const files = Object.keys(gameFiles(root, o.slug, "module")).filter((f) => !f.endsWith("/SPEC.json")).sort();
  mkdirSync(join(root, src), { recursive: true });
  writeFileSync(join(root, src, "SPEC.json"), `${JSON.stringify({ spec: o.spec, specSha256: o.specSha256, module: plan.module, interface: [], bounds: plan.bounds, files }, null, 2)}\n`);
}

/** Every file of the checkout's base (HEAD). */
const basePaths = (root: string) => execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", "HEAD"], { maxBuffer: 64 * 1024 ** 2 }).toString().split("\n").filter(Boolean);

/** What the gates' static checks find in a site or an engine change's files as they are on disk (a planned file not written yet is
 *  an issue too). */
export function staticIssues(root: string, o: Order, planned: string[]): string[] {
  const kind = kindOf(o);
  const files: Record<string, string> = {};
  const out: string[] = [];
  for (const p of planned) {
    try { files[p] = readFileSync(join(root, p), "utf8"); } catch { out.push(`${p}: not written`); }
  }
  if (kind === "engine") {
    // G16 against the checkout's base (HEAD): no new env read, network sink or URL host
    const base: Record<string, string> = {};
    for (const p of planned) { try { base[p] = execFileSync("git", ["-C", root, "show", `HEAD:${p}`], { stdio: ["ignore", "pipe", "ignore"] }).toString(); } catch { /* new */ } }
    const changes = Object.keys(files).map((path) => ({ path, status: (path in base ? "M" : "A") as "M" | "A", mode: "100644", size: files[path].length }));
    out.push(...engineReachGate(changes, files, base).result.issues);
  }
  return [...out, ...depGate(files, o.slug, kind).issues, ...(kind === "site" ? webGate(files, o.slug, kind).issues : [])];
}

/** SPEC.json: the order's spec verbatim, the interface of the build's own compile, and every file of the game. */
export function writeSpec(root: string, o: Order, iface: string[]) {
  const [src] = gameRoots(o.slug);
  const files = Object.keys({ ...gameFiles(root, o.slug), ...webFiles(root, o.slug) }).filter((f) => !f.endsWith("/SPEC.json")).sort();
  const gameJson = `${gameRoots(o.slug)[2]}game.json`;
  if (!files.includes(gameJson)) files.push(gameJson);
  mkdirSync(join(root, src), { recursive: true });
  writeFileSync(join(root, src, "SPEC.json"), `${JSON.stringify({ spec: o.spec, specSha256: o.specSha256, interface: iface, files: files.sort() }, null, 2)}\n`);
}
function webFiles(root: string, slug: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    let names: string[];
    try { names = readdirSync(join(root, rel)); } catch { return; }
    for (const n of names) (statSync(join(root, rel, n)).isDirectory() ? walk(`${rel}${n}/`) : (out[`${rel}${n}`] = readFileSync(join(root, rel, n), "utf8")));
  };
  walk(gameRoots(slug)[2]);
  return out;
}

/** The enclave's gates on a game (or a module) whose suite passes here, called as runGates calls them, before anything
 *  is published: G2, G11 (a game's page), and on the compile G3, G4 and G5 (a game's against the interface of the
 *  compile, which SPEC.json gets, so only what G5 forbids fails; a module's against the plan's kind and bounds); then, if all of those pass, a game's G9, its conformance tests on a fresh anvil at the
 *  chain's own time (forge's own run starts at timestamp 1). An early look only: the enclave's run decides. Each issue reads as the
 *  next order would carry it ("G3 Solidity patterns: ..."). */
export async function selfCheck(root: string, o: Order, plan: Plan, timeoutMs: number): Promise<string[]> {
  const kind = kindOf(o) === "module" ? "module" : "game";
  const files = { ...gameFiles(root, o.slug, kind), ...(kind === "game" ? webFiles(root, o.slug) : {}) };
  const results: GateResult[] = kind === "module" ? [depGate(files, o.slug, kind)] : [depGate(files, o.slug), webGate(files, o.slug)];
  const end = Date.now() + timeoutMs;
  const ws = workspace(join(root, "contracts"), files, o.slug, kind);
  try {
    const c = await compile(ws, files, o.slug, timeoutMs, kind);
    if (!c.ok) results.push(gate("G6", "tests", ["does not compile"]));
    else {
      results.push(solPatternGate(c.src, c.test, { module: kind === "module" }));
      const mains = c.src.flatMap((u) => nodes(u.ast).filter((n) => n.nodeType === "ContractDefinition" && n.contractKind === "contract" && !n.abstract).map((n) => ({ u, name: String(n.name) })));
      const main = mains.length === 1 ? c.artifacts(mains[0].u.file).find((a) => a.name === mains[0].name) : undefined;
      const spec = { spec: o.spec, specSha256: o.specSha256, files: [] };
      if (kind === "module") {
        const iface = c.artifacts("IPolicies.sol")[0]?.ast;
        results.push(moduleAbiGate({ srcUnits: c.src, testUnits: c.test, ifaceIds: { fee: idOf(iface, "IFeePolicy"), split: idOf(iface, "ISplitPolicy") }, abi: main?.abi ?? [], spec: { ...spec, module: plan.module!, interface: [], bounds: plan.bounds! }, orderSpecSha256: o.specSha256, changed: [] }));
      } else {
        const kitArt = c.artifacts("GameKit.sol").find((a) => a.name === "GameKit");
        results.push(abiGate({ srcUnits: c.src, kitId: idOf(kitArt?.ast, "GameKit") ?? -1, abi: main?.abi ?? [], kitAbi: kitArt?.abi ?? [], spec: { ...spec, interface: gameInterface(main?.abi ?? [], kitArt?.abi ?? []) }, orderSpecSha256: o.specSha256, changed: [] }));
      }
      if (main) results.push(bytecodeGate(main.deployedBytecode.object, { module: kind === "module", links: linksOf(main) }));
      // G9 is a forge run: not spent on a build the static gates already refuse
      if (kind === "game" && results.every((g) => g.ok)) results.push(await forkGate(ws, o.slug, undefined, Math.max(1_000, end - Date.now())));
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
  return results.filter((g) => !g.ok).flatMap((g) => g.issues.map((i) => `${g.gate} ${g.name}: ${i}`));
}

/** Compile the game as the enclave will and write game.json: the factory's CREATE2 address for the order's salt, the
 *  deployed code's hash, the ABI. Returns the interface for SPEC.json (the ABI's functions beyond the kit's). */
export async function writeGameJson(root: string, o: Order, title: string, timeoutMs = COMPILE_MS): Promise<{ ok: true; iface: string[] } | { ok: false; why: string }> {
  const files = gameFiles(root, o.slug);
  const ws = workspace(join(root, "contracts"), files, o.slug);
  try {
    const c = await compile(ws, files, o.slug, timeoutMs);
    if (!c.ok) return { ok: false, why: "the game does not compile" };
    const mains = c.src.flatMap((u) => (u.ast as { nodes?: { nodeType: string; contractKind?: string; abstract?: boolean; name: string }[] }).nodes?.filter((n) => n.nodeType === "ContractDefinition" && n.contractKind === "contract" && !n.abstract).map((n) => ({ u, name: n.name })) ?? []);
    if (mains.length !== 1) return { ok: false, why: `${mains.length} deployable contracts (exactly 1)` };
    const art = c.artifacts(mains[0].u.file).find((a) => a.name === mains[0].name)!;
    const address = getContractAddress({ opcode: "CREATE2", from: o.factory as Hex, salt: o.salt as Hex, bytecode: art.bytecode.object });
    // the on-chain extcodehash: the kit's immutables (factory, safe) written into the runtime code
    const kitArt = c.artifacts("GameKit.sol").find((a) => a.name === "GameKit");
    const runtime = runtimeCode(art, kitArt?.ast, o.factory as Hex, o.safe as Hex);
    if (!runtime) return { ok: false, why: "the game's runtime code could not be completed with the kit's immutables" };
    const web = gameRoots(o.slug)[2];
    mkdirSync(join(root, web), { recursive: true });
    writeFileSync(join(root, web, "game.json"), `${JSON.stringify({ slug: o.slug, title, chainId: 1, address, codehash: keccak256(runtime), abi: art.abi }, null, 2)}\n`);
    return { ok: true, iface: gameInterface(art.abi, kitArt?.abi ?? []) };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}
/** The order's folders (a game's three; a site change's pages and docs) as a patch against the base (new files included). */
/** The game's folders as a patch against the base (new files included). */
export function patchOf(root: string, slug: string, kind: Kind = "game") {
  const rs = roots(slug, kind);
  execFileSync("git", ["-C", root, "add", "-A", "--", ...rs]);
  const diff = execFileSync("git", ["-C", root, "diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "HEAD", "--", ...rs], { maxBuffer: 64 * 1024 ** 2 }).toString();
  execFileSync("git", ["-C", root, "reset", "-q"]);
  return diff;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { values: a } = parseArgs({ options: { order: { type: "string" }, out: { type: "string" }, root: { type: "string" } } });
  if (!a.order || !a.out) throw new Error("usage: run.ts --order <order.json> --out <dir> [--root <checkout>]");
  firstAttemptOnly();
  const o = Order.parse(JSON.parse(readFileSync(a.order, "utf8")));
  const root = a.root ?? process.cwd();
  mkdirSync(a.out, { recursive: true });
  let r: Outcome;
  try {
    r = await build(o, root, sdkDriver(root));
  } catch (e) {
    // build() reports its own crashes; this is a failure around it (no model key, say). What was spent is unknown, so
    // the report claims the whole ceiling, as the enclave would without a report.
    const why = `error: ${String((e as Error)?.message ?? e).slice(0, 300)}`;
    const report: Report = { orderId: o.id, round: o.round, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, queries: [], tests: [], totalUsd: o.budget.ceilingUsd, outcome: why };
    writeFileSync(join(a.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.error(`no pull request: ${why}`);
    process.exit(1);
  }
  if (r.plan) writeFileSync(join(a.out, "plan.json"), `${JSON.stringify(r.plan, null, 2)}\n`);
  writeFileSync(join(a.out, "report.json"), `${JSON.stringify(r.report, null, 2)}\n`);
  if (r.ok) {
    writeFileSync(join(a.out, "patch.diff"), patchOf(root, o.slug, kindOf(o)));
    writeFileSync(join(a.out, "pr.md"), `${r.prBody}\n`);
  }
  console.log(r.ok ? `ready: ${r.plan?.title} ($${r.report.totalUsd})` : `no pull request: ${r.why} ($${r.report.totalUsd})`);
}
