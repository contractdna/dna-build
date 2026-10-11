// The Sequencer's forge-run gates and the gate runner. A build's Solidity runs only here, in child processes that get
// no secrets (an explicit env), limits (prlimit on Linux: address space, processes, open files, file size), a lower
// priority, their own process group (killed whole on timeout, and after they exit) and capped output. The workspace
// is a fresh temp dir: the trusted kit (GameKit, IGames, GameFactory, the conformance suite, forge-std and the games
// profile, from the caller's `kit` dir: the base branch in CI, the image in the enclave) plus the PR's game files
// only, so a PR can't bring its own kit or config.
//  G6 tests (+ structure: a fuzz test, an invariant, the conformance suite), G7 mutation (planted bugs must fail a
//  test), G8 gas, G9 fork sim (the conformance tests again on a fresh anvil), then runGates(): every gate in order.
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Address, concat, decodeEventLog, encodeFunctionData, getAbiItem, getContractAddress, type Hex, keccak256, parseAbi } from "viem";
import { registryAbi } from "./abi.ts";
import { encodeOp } from "./lib.ts";
import { ENCLAVE } from "./enclave.ts";
import { ANVIL_URL, type Job, MAX_LIMITS, type Ran, runJob, SANDBOX, submit } from "./limited.ts";
import { publicTextIssues } from "./llm.ts";
import {
  abiGate, addressGate, type Ast, applyMutant, bytecodeGate, runtimeOf, type Change, depGate, gate, type GameJson, type GateResult, MODULE_FN, moduleAbiGate,
  type ModuleKind, type ModuleSpec, mutants, nodes, specBounds, engineReachGate, type Touch,
  pathGate, roots, solPatternGate, type Spec, textGate, type Unit, webGate,
} from "./seq-gates.ts";
import type { Kind } from "./seq-order.ts";

// ---------------------------------------------------------------- limited child processes (src/limited.ts)

export { LIMITS, type Ran, runLimited } from "./limited.ts";
/** A run of the gates' untrusted code: here (CI, tests), or in the enclave in the `forge` container (no network but
 *  loopback, no secret), through the shared work volume. */
const run = (j: Job): Promise<Ran> => (ENCLAVE.on ? submit(j) : runJob(j));

// ---------------------------------------------------------------- the workspace

/** The trusted kit: a `contracts/` dir with the games profile, the kit sources, the conformance suite and forge-std. */
export const KIT_FILES = ["games/foundry.toml", "src/games/GameKit.sol", "src/games/IGames.sol", "src/games/GameFactory.sol", "src/games/GameFunder.sol", "test/games/GameKitConformance.sol"];

/** A module's kit: the modules profile, the policy interfaces and the module conformance suite. */
export const MODULE_KIT_FILES = ["modules/foundry.toml", "src/interfaces/IPolicies.sol", "test/modules/ModuleConformance.sol"];
/** Which kit a workspace holds (one only): forge's root, and the folder the build's tests are matched in. */
const areaOf = (ws: string) => (existsSync(join(ws, "modules", "foundry.toml")) ? "modules" : "games");

/** A fresh workspace: the kit from `kit`, the PR's game (or module) files (repo paths under contracts/) and nothing else. */
export function workspace(kit: string, files: Record<string, string>, slug: string, kind: Kind = "game"): string {
  // in the enclave: on the volume the forge container shares
  const ws = mkdtempSync(join(ENCLAVE.on ? SANDBOX.dir : tmpdir(), "seq-ws-"));
  chmodSync(ws, 0o770); // mkdtemp makes it 0700; the forge container writes here as another uid of the same group
  for (const f of kind === "module" ? MODULE_KIT_FILES : KIT_FILES) {
    mkdirSync(dirname(join(ws, f)), { recursive: true });
    cpSync(join(kit, f), join(ws, f));
  }
  // a copy, not a link: solc refuses sources outside the allowed paths
  cpSync(join(kit, "lib", "forge-std", "src"), join(ws, "lib", "forge-std", "src"), { recursive: true });
  const area = kind === "module" ? "modules" : "games";
  chmodSync(join(ws, area), 0o770); // forge's root: the forge container writes out/ and cache/ here
  const [src, test] = roots(slug, kind);
  for (const [p, text] of Object.entries(files)) {
    if (!p.startsWith(src) && !p.startsWith(test)) continue;
    const dst = join(ws, p.slice("contracts/".length));
    if (!dst.startsWith(`${ws}/`)) continue; // a path that leaves the workspace (`..`) is never written
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, text);
  }
  return ws;
}

/** The pinned solc (enclave image or CI): SEQ_SOLC, else svm's 0.8.26 if installed. */
const solc = () => process.env.SEQ_SOLC ?? [join(homedir(), ".svm", "0.8.26", "solc-0.8.26")].find((p) => existsSync(p));
/** forge's env: nothing of ours. With a pinned solc, offline and a throwaway HOME. */
export function forgeEnv(ws: string, extra: Record<string, string> = {}): Record<string, string> {
  const s = solc();
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: s ? join(ws, ".home") : homedir(), FOUNDRY_FFI: "false",
    ...(s ? { FOUNDRY_SOLC: s, FOUNDRY_OFFLINE: "true" } : {}), ...extra,
  };
}
/** forge in the workspace. JSON reports (with traces) are large: their output cap is raised. */
export const forge = (ws: string, args: string[], timeoutMs: number, extra?: Record<string, string>, signal?: AbortSignal, anvil = false) =>
  run({ cmd: "forge", args: [...args, "--root", join(ws, areaOf(ws))], cwd: ws, env: forgeEnv(ws, extra), timeoutMs, signal, limits: args.includes("--json") ? { outputBytes: MAX_LIMITS.outputBytes } : {}, anvil });

/** Compiled artifacts of one source file (by basename): every contract's JSON. */
function artifacts(ws: string, file: string): { name: string; abi: never[]; bytecode: { object: Hex; linkReferences?: Record<string, unknown> }; deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]>; linkReferences?: Record<string, unknown> }; ast: Ast }[] {
  const dir = join(ws, areaOf(ws), "out", basename(file));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => ({ name: f.slice(0, -5), ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
}
const astOf = (ws: string, file: string) => artifacts(ws, file)[0]?.ast;
/** How many library link references a compiled contract has (its init code and its runtime). */
export const linksOf = (a: { bytecode: { linkReferences?: Record<string, unknown> }; deployedBytecode: { linkReferences?: Record<string, unknown> } }) =>
  Object.keys(a.bytecode.linkReferences ?? {}).length + Object.keys(a.deployedBytecode.linkReferences ?? {}).length;
const unitsOf = (ws: string, files: Record<string, string>, under: string): Unit[] =>
  Object.entries(files).filter(([p]) => p.startsWith(under) && p.endsWith(".sol")).flatMap(([p, text]) => {
    const ast = astOf(ws, p);
    return ast ? [{ file: p, text, ast }] : [];
  });
export const idOf = (ast: Ast | undefined, name: string) => nodes(ast).find((n) => n.nodeType === "ContractDefinition" && n.name === name)?.id as number | undefined;

/** Compile the workspace (with ASTs): the game's source and test units and its artifacts by file. */
export async function compile(ws: string, files: Record<string, string>, slug: string, timeoutMs = 5 * 60_000, kind: Kind = "game") {
  const b = await forge(ws, ["build", "--ast"], timeoutMs);
  const [src, test] = roots(slug, kind);
  return { ok: b.code === 0, out: b.out, src: unitsOf(ws, files, src), test: unitsOf(ws, files, test), artifacts: (file: string) => artifacts(ws, file) };
}

// ---------------------------------------------------------------- the gates that run forge

type TestJson = Record<string, { test_results: Record<string, { status: string; reason?: string | null; kind: Record<string, unknown>; logs?: { topics: Hex[]; data: Hex }[] }> }>;
const parseJson = <T>(s: string): T | null => { try { return JSON.parse(s.slice(s.indexOf(s.trimStart()[0]))) as T; } catch { return null; } };
const tail = (s: string) => s.trim().split("\n").slice(-6).join(" | ").slice(0, 600);
const LIGHT = { FOUNDRY_FUZZ_RUNS: "64", FOUNDRY_INVARIANT_RUNS: "16", FOUNDRY_INVARIANT_DEPTH: "16" };

/** ModuleConformance's report of the bounds its tests ran with. */
const MODULE_BOUNDS = getAbiItem({ abi: parseAbi(["event ModuleBounds(bytes32[4] min, bytes32[4] max)"]), name: "ModuleBounds" });
const MODULE_CODE = getAbiItem({ abi: parseAbi(["event ModuleCode(bytes32 codehash)"]), name: "ModuleCode" });

/** G6: the game's tests pass, with at least one fuzz test and one invariant, in a contract that runs the conformance
 *  suite. A module's (`bounds` given): a fuzz test, the module conformance suite, no invariant needed, and the bounds
 *  the suite ran with are SPEC.json's. */
export async function testsGate(ws: string, slug: string, testUnits: Unit[], conformanceId: number | undefined, o: { bounds?: { min: bigint[]; max: bigint[] }; codehash?: Hex } = {}): Promise<GateResult> {
  const out: string[] = [];
  const area = areaOf(ws);
  const r = await forge(ws, ["test", "--match-path", `*/${area}/${slug}/*`, "--json", ...(area === "modules" ? ["-vv"] : [])], 20 * 60_000);
  const j = parseJson<TestJson>(r.stdout);
  if (r.timedOut) out.push("tests timed out");
  if (!j) out.push(`tests did not run: ${tail(r.out)}`);
  else {
    const results = Object.values(j).flatMap((c) => Object.entries(c.test_results));
    for (const [name, t] of results) if (t.status !== "Success") out.push(`${name}: ${t.status}`);
    if (!results.some(([, t]) => "Fuzz" in t.kind)) out.push("no fuzz test");
    if (area === "games" && !results.some(([, t]) => "Invariant" in t.kind)) out.push("no invariant test");
    if (area === "modules") {
      const logs = results.filter(([n]) => n === "test_conformance_bounds()").flatMap(([, t]) => t.logs ?? []);
      const ran = logs.flatMap((l) => { try { return [decodeEventLog({ abi: [MODULE_BOUNDS], topics: l.topics as [Hex], data: l.data }) as unknown as { args: { min: readonly Hex[]; max: readonly Hex[] } }]; } catch { return []; } });
      const words = (a: readonly Hex[]) => a.map((x) => BigInt(x).toString()).join(",");
      if (ran.length !== 1) out.push("the conformance suite did not report the bounds its tests ran with");
      else if (!o.bounds) out.push("no bounds in SPEC.json to compare with");
      else if (words(ran[0].args.min) !== o.bounds.min.join(",") || words(ran[0].args.max) !== o.bounds.max.join(",")) out.push(`the tests ran with bounds ${words(ran[0].args.min)} .. ${words(ran[0].args.max)}, SPEC.json proposes ${o.bounds.min.join(",")} .. ${o.bounds.max.join(",")}`);
      // the code the suite ran on is the module's own compile, not a stand-in from _creationCode
      const code = results.filter(([n]) => n === "test_conformance_code()").flatMap(([, t]) => t.logs ?? []).flatMap((l) => {
        try { return [(decodeEventLog({ abi: [MODULE_CODE], topics: l.topics as [Hex], data: l.data }) as unknown as { args: { codehash: Hex } }).args.codehash]; } catch { return []; }
      });
      if (code.length !== 1) out.push("the conformance suite did not report the code it ran on");
      else if (code[0] !== o.codehash) out.push(`the conformance suite ran on code ${code[0]}, not the module's own (${o.codehash})`);
    }
  }
  const conforming = testUnits.some((u) => nodes(u.ast).some((n) => n.nodeType === "ContractDefinition" && !n.abstract && conformanceId !== undefined && (n.linearizedBaseContracts as number[]).includes(conformanceId)));
  if (!conforming) out.push(`no test contract inherits ${area === "modules" ? "the module conformance suite" : "GameKitConformance"}`);
  return gate("G6", "tests", out);
}

/** G7 passes when at least this share of the planted bugs make a test fail (6 of 8). */
export const KILL_SHARE = 0.75;
/** G7: planted bugs must make a test fail, at least KILL_SHARE of them (mutants run a lighter fuzz/invariant profile). */
export async function mutationGate(ws: string, slug: string, srcUnits: Unit[], seed: string): Promise<GateResult> {
  const survivors: string[] = [];
  // a module is one pure function: its planted bugs go there (a game's views are left out)
  const ms = mutants(srcUnits, seed, 8, { views: areaOf(ws) === "modules" });
  if (ms.length === 0) return gate("G7", "mutation", ["nothing to mutate: no condition or check in the code"]);
  for (const m of ms) {
    const file = join(ws, m.file.slice("contracts/".length));
    const orig = readFileSync(file, "utf8");
    writeFileSync(file, applyMutant(orig, m));
    // --force: forge's build cache can miss an edit made right after the last build
    const r = await forge(ws, ["test", "--force", "--match-path", `*/${areaOf(ws)}/${slug}/*`], 10 * 60_000, LIGHT);
    writeFileSync(file, orig);
    if (r.timedOut) survivors.push(`${m.file}@${m.at} ${m.what}: timed out`);
    else if (r.code === 0) survivors.push(`${m.file}@${m.at} ${m.what}: survived (no test failed)`);
  }
  const killed = ms.length - survivors.length;
  return gate("G7", "mutation", killed >= Math.ceil(ms.length * KILL_SHARE) ? [] : [`${killed} of ${ms.length} planted bugs caught (at least ${Math.ceil(ms.length * KILL_SHARE)})`, ...survivors]);
}

export const GAS = { perFunction: 200_000, deploy: 6_000_000 };
type GasJson = { contract: string; deployment: { gas: number; size: number }; functions: Record<string, { max: number }> }[];
/** G8: no external function of the game above GAS.perFunction in the tests' gas report; the factory's deploy (scan
 *  included) under GAS.deploy. */
export async function gasGate(ws: string, slug: string, game: string): Promise<GateResult> {
  const out: string[] = [];
  const r = await forge(ws, ["test", "--match-path", `*/games/${slug}/*`, "--gas-report", "--json"], 20 * 60_000, LIGHT);
  const j = parseJson<GasJson>(r.stdout);
  if (!j) return gate("G8", "gas", [`no gas report: ${tail(r.out)}`]);
  const g = j.find((c) => c.contract.endsWith(`:${game}`));
  if (!g) out.push("the game is not in the gas report");
  for (const [f, v] of Object.entries(g?.functions ?? {})) if (v.max > GAS.perFunction) out.push(`${f}: ${v.max} gas (max ${GAS.perFunction})`);
  const d = j.find((c) => c.contract.endsWith(":GameFactory"))?.functions["deploy(bytes,bytes32)"];
  if (d && d.max > GAS.deploy) out.push(`deploying through the factory: ${d.max} gas (max ${GAS.deploy})`);
  return gate("G8", "gas", out);
}

/** A module answers inside the hook's and FeeVault's gas cap (DNAHook.MODULE_GAS_CAP, FeeVault.SPLIT_GAS_CAP). */
export const MODULE_GAS_CAP = 40_000;
/** G8 for a module: its policy function's worst case in the tests' gas report is under the cap. */
export async function moduleGasGate(ws: string, slug: string, name: string, fn: string): Promise<GateResult> {
  const r = await forge(ws, ["test", "--match-path", `*/modules/${slug}/*`, "--gas-report", "--json"], 20 * 60_000, LIGHT);
  const j = parseJson<GasJson>(r.stdout);
  if (!j) return gate("G8", "gas", [`no gas report: ${tail(r.out)}`]);
  const m = j.find((c) => c.contract.endsWith(`:${name}`));
  const f = Object.entries(m?.functions ?? {}).filter(([k]) => k.startsWith(`${fn}(`));
  if (!f.length) return gate("G8", "gas", [`${fn} is not in the gas report`]);
  return gate("G8", "gas", f.filter(([, v]) => v.max > MODULE_GAS_CAP).map(([k, v]) => `${k}: ${v.max} gas (the cap is ${MODULE_GAS_CAP})`));
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  s.on("error", reject);
});

/** G9: after the game's own tests, the conformance tests once more against a fresh anvil (an empty chain, started with
 *  the run: in the enclave inside the forge container; a fork of `fork` only outside it): nothing the game's tests set
 *  up survives. */
export async function forkGate(ws: string, slug: string, fork?: { url: string; block: number }, timeoutMs = 15 * 60_000): Promise<GateResult> {
  if (!fork) return conformance(await forge(ws, ["test", "--match-path", `*/games/${slug}/*`, "--match-test", "^test_conformance_", "--fork-url", ANVIL_URL, "--json"], timeoutMs, LIGHT, undefined, true));
  if (ENCLAVE.on) throw new Error("G9: no fork in the enclave (the forge container has no network)");
  const port = await freePort();
  const args = ["--port", String(port), "--silent", ...(fork ? ["--fork-url", fork.url, "--fork-block-number", String(fork.block)] : [])];
  const anvil = spawn("anvil", args, { env: { PATH: process.env.PATH ?? "" }, detached: true, stdio: "ignore" });
  try {
    for (let i = 0; i < 100; i++) {
      const up = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((x) => x.ok, () => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return conformance(await forge(ws, ["test", "--match-path", `*/games/${slug}/*`, "--match-test", "^test_conformance_", "--fork-url", `http://127.0.0.1:${port}`, "--json"], timeoutMs, LIGHT));
  } finally {
    try { process.kill(-anvil.pid!, "SIGKILL"); } catch { /* gone */ }
  }
}

function conformance(r: Ran): GateResult {
  const j = parseJson<TestJson>(r.stdout);
  if (!j) return gate("G9", "fork sim", [`did not run: ${tail(r.out)}`]);
  const results = Object.values(j).flatMap((c) => Object.entries(c.test_results));
  const out = results.filter(([, t]) => t.status !== "Success").map(([n, t]) => failedTest(n, t));
  if (results.length === 0) out.push("no conformance test ran");
  return gate("G9", "fork sim", out);
}

/** A failed test as an issue: its name, its status and forge's reason (a revert, a panic, out of gas) on one line, cut to
 *  300 characters. Issues go into the signed gates record: a reason that reads like a link, a handle or a cashtag is
 *  withheld. */
export function failedTest(name: string, t: { status: string; reason?: string | null }): string {
  const why = (t.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!why) return `${name}: ${t.status}`;
  const bad = publicTextIssues(why);
  return `${name}: ${t.status}: ${bad.length ? `(reason withheld: ${bad.join(", ")})` : why}`;
}

// ---------------------------------------------------------------- every gate

export type GateInput = {
  slug: string; changes: Change[]; files: Record<string, string>; baseHasSlug: boolean; prBody: string; kit: string;
  /** the base's paths (a site change: no new file named like one of them but for case) */
  basePaths?: string[];
  /** an engine change: the changed files' texts at the base (what G16 compares against) */
  baseFiles?: Record<string, string>;
  /** the order's kind (absent: a game) */
  kind?: Kind;
  /** what the order fixed: the spec's hash, the CREATE2 salt, the factory (absent in CI: G13 is skipped there) */
  order: { specSha256?: string; salt?: Hex; factory?: Address; safe?: Address; seed: string };
  fork?: { url: string; block: number };
};
export type GateRun = { results: GateResult[]; game?: { name: string; initCode: Hex; deployed: Hex; runtime: Hex | null }; module?: GatedModule; touch?: Touch[] };
/** A gated module as the enclave compiled it: deployed through the CREATE2 deployer with the order's salt, its code is
 *  exactly `runtime` (no immutables), so `codehash` is the extcodehash the Safe approves. */
export type GatedModule = { name: string; kind: ModuleKind; initCode: Hex; runtime: Hex; codehash: Hex; salt: Hex; address: Address; bounds: { min: string[]; max: string[]; start: string[] } };
/** The CREATE2 deployer a module goes on chain through (the same address on mainnet and in anvil; anyone may send it
 *  salt ‖ init code). */
export const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c" as Address;
export const moduleAddress = (salt: Hex, initCode: Hex) => getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: initCode });

/** What the Safe is asked to do for a shipped module; the Sequencer itself sends none of it. Deploy the code through
 *  the CREATE2 deployer (anyone may), queue ApproveCodehash for exactly this code hash with the proposed bounds (the
 *  Safe only), then queue Register at its start params (the Safe, or the agent at level 10 once the hash is approved).
 *  From there the registry's own flow decides whether it is ever tested or switched on. */
export function moduleProposal(m: GatedModule, specSha256: string, registry: Address) {
  const kind = m.kind === "fee" ? 0 : 1; // ModuleRegistry.Kind
  const words = (a: string[]) => a.map((x) => `0x${BigInt(x).toString(16).padStart(64, "0")}` as Hex);
  const specHash = `0x${specSha256}` as Hex;
  const queue = (q: { op: number; data: Hex }) => encodeFunctionData({ abi: registryAbi, functionName: "queue", args: [q.op, q.data] });
  return {
    codehash: m.codehash, address: m.address, kind: m.kind, specHash, bounds: m.bounds,
    calls: [
      { what: "deploy the module (anyone)", to: CREATE2_DEPLOYER, data: concat([m.salt, m.initCode]) },
      { what: "approve its code hash and bounds (the Safe)", to: registry, data: queue(encodeOp("ApproveCodehash", [m.codehash, kind, words(m.bounds.min), words(m.bounds.max)])) },
      { what: "register it at its start params (the Safe, or the agent at level 10 once approved)", to: registry, data: queue(encodeOp("Register", [m.address, kind, specHash, words(m.bounds.start), words(m.bounds.min), words(m.bounds.max)])) },
    ],
  };
}

/** The code the game will hold on-chain: GameKit's immutables (`factory`, `safe`) written into the compiled runtime. */
export function runtimeCode(art: { deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> } }, kitAst: Ast | undefined, factory: Address, safe: Address): Hex | null {
  const kit = nodes(kitAst).find((n) => n.nodeType === "ContractDefinition" && n.name === "GameKit");
  const idOfVar = (name: string) => nodes(kit).find((n) => n.nodeType === "VariableDeclaration" && n.name === name && n.mutability === "immutable")?.id;
  const values: Record<string, Hex> = {};
  const f = idOfVar("factory"), s = idOfVar("safe");
  if (f !== undefined) values[String(f)] = factory;
  if (s !== undefined) values[String(s)] = safe;
  return runtimeOf(art.deployedBytecode.object, art.deployedBytecode.immutableReferences ?? {}, values);
}

/** Every gate, in order. Static gates first; forge gates only when the code compiles. The workspace is removed after.
 *  A site change has static gates only here (G1, G2, G11, G12); its page check (G15) is the enclave's. */
export async function runGates(i: GateInput): Promise<GateRun> {
  const kind = i.kind ?? "game";
  if (kind === "site") return { results: [pathGate(i.changes, i.slug, false, kind, { paths: i.basePaths ?? [] }), depGate(i.files, i.slug, kind), webGate(i.files, i.slug, kind), textGate(i.prBody, i.files)] };
  if (kind === "module") return runModuleGates(i);
  // an engine change: its paths (with its tests), imports and text here; the enclave never runs its code (CI runs its
  // tests as advice, and an owner merges it, or not)
  if (kind === "engine") {
    const reach = engineReachGate(i.changes, i.files, i.baseFiles ?? {});
    return { results: [pathGate(i.changes, i.slug, false, kind), depGate(i.files, i.slug, kind), textGate(i.prBody, i.files), reach.result], touch: reach.touch };
  }
  const results: GateResult[] = [pathGate(i.changes, i.slug, i.baseHasSlug), depGate(i.files, i.slug), webGate(i.files, i.slug), textGate(i.prBody, i.files)];
  // a refused set of paths never reaches a workspace or forge
  if (!results[0].ok) return { results };
  const [src, test, web] = roots(i.slug);
  const ws = workspace(i.kit, i.files, i.slug);
  try {
    const c = await compile(ws, i.files, i.slug);
    if (!c.ok) return { results: [...results, gate("G6", "tests", [`does not compile: ${tail(c.out)}`])] };
    const srcUnits = c.src;
    const testUnits = c.test;
    results.push(solPatternGate(srcUnits, testUnits));
    const kitArt = artifacts(ws, "GameKit.sol").find((a) => a.name === "GameKit");
    const kitId = idOf(kitArt?.ast, "GameKit");
    const deployable = srcUnits.flatMap((u) => nodes(u.ast).filter((n) => n.nodeType === "ContractDefinition" && n.contractKind === "contract" && !n.abstract).map((n) => ({ u, name: String(n.name) })));
    const main = deployable.length === 1 ? artifacts(ws, deployable[0].u.file).find((a) => a.name === deployable[0].name) : undefined;
    const specText = i.files[`${src}SPEC.json`];
    let spec: Spec | null = null;
    try { spec = specText ? JSON.parse(specText) : null; } catch { spec = null; }
    results.push(abiGate({ srcUnits, kitId: kitId ?? -1, abi: (main?.abi ?? []) as never[], kitAbi: (kitArt?.abi ?? []) as never[], spec, orderSpecSha256: i.order.specSha256 ?? spec?.specSha256 ?? "", changed: i.changes.map((c) => c.path) }));
    if (!main) return { results };
    results.push(bytecodeGate(main.deployedBytecode.object, { links: linksOf(main) }));
    const gameText = i.files[`${web}game.json`];
    let gameJson: GameJson | null = null;
    try { gameJson = gameText ? JSON.parse(gameText) : null; } catch { gameJson = null; }
    const runtime = i.order.factory && i.order.safe ? runtimeCode(main, kitArt?.ast, i.order.factory, i.order.safe) : null;
    if (i.order.factory && i.order.salt && i.order.safe) results.push(addressGate(gameJson, { factory: i.order.factory, salt: i.order.salt, initCode: main.bytecode.object, runtime, slug: i.slug }));
    const conformanceId = idOf(astOf(ws, "GameKitConformance.sol"), "GameKitConformance");
    results.push(await testsGate(ws, i.slug, testUnits, conformanceId));
    results.push(await gasGate(ws, i.slug, main.name));
    results.push(await forkGate(ws, i.slug, i.fork));
    results.push(await mutationGate(ws, i.slug, srcUnits, i.order.seed)); // last: it edits the workspace
    return { results, game: { name: main.name, initCode: main.bytecode.object, deployed: main.deployedBytecode.object, runtime } };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** A module's gates, in order: G1, G2, G12; then compiled: G3 (no storage either), G5 (one policy function, the kind
 *  SPEC.json names, its bounds), G4 (no write, call or log opcode; no immutables), G6 (the module conformance suite with
 *  the bounds SPEC.json proposes, on the module's own code), G8 (under the gas cap), G7 (planted bugs). No page and no factory: the enclave's own
 *  compile gives the code hash proposed to the Safe. */
async function runModuleGates(i: GateInput): Promise<GateRun> {
  const kind = "module";
  const results: GateResult[] = [pathGate(i.changes, i.slug, i.baseHasSlug, kind), depGate(i.files, i.slug, kind), textGate(i.prBody, i.files)];
  if (!results[0].ok) return { results };
  const [src] = roots(i.slug, kind);
  // an image without the module kit can't gate a module: a failed gate, never a crash
  const missing = MODULE_KIT_FILES.filter((f) => !existsSync(join(i.kit, f)));
  if (missing.length) return { results: [...results, gate("G6", "tests", [`the module kit is not in this image (${missing.join(", ")})`])] };
  const ws = workspace(i.kit, i.files, i.slug, kind);
  try {
    const c = await compile(ws, i.files, i.slug, undefined, kind);
    if (!c.ok) return { results: [...results, gate("G6", "tests", [`does not compile: ${tail(c.out)}`])] };
    results.push(solPatternGate(c.src, c.test, { module: true }));
    const iface = astOf(ws, "IPolicies.sol");
    const deployable = c.src.flatMap((u) => nodes(u.ast).filter((n) => n.nodeType === "ContractDefinition" && n.contractKind === "contract" && !n.abstract).map((n) => ({ u, name: String(n.name) })));
    const main = deployable.length === 1 ? artifacts(ws, deployable[0].u.file).find((a) => a.name === deployable[0].name) : undefined;
    let spec: ModuleSpec | null = null;
    try { spec = i.files[`${src}SPEC.json`] ? JSON.parse(i.files[`${src}SPEC.json`]) : null; } catch { spec = null; }
    results.push(moduleAbiGate({ srcUnits: c.src, testUnits: c.test, ifaceIds: { fee: idOf(iface, "IFeePolicy"), split: idOf(iface, "ISplitPolicy") }, abi: (main?.abi ?? []) as never[], spec, orderSpecSha256: i.order.specSha256 ?? spec?.specSha256 ?? "", changed: i.changes.map((x) => x.path) }));
    if (!main) return { results };
    results.push(bytecodeGate(main.deployedBytecode.object, { module: true, links: linksOf(main) }));
    const mk: ModuleKind = spec?.module === "split" ? "split" : "fee";
    const bounds = spec ? specBounds(spec.bounds) : "no SPEC.json";
    const suite = idOf(astOf(ws, "ModuleConformance.sol"), mk === "fee" ? "FeeModuleConformance" : "SplitModuleConformance");
    results.push(await testsGate(ws, i.slug, c.test, suite, { bounds: typeof bounds === "string" ? undefined : bounds, codehash: keccak256(main.deployedBytecode.object) }));
    results.push(await moduleGasGate(ws, i.slug, main.name, MODULE_FN[mk]));
    results.push(await mutationGate(ws, i.slug, c.src, i.order.seed)); // last: it edits the workspace
    const salt = i.order.salt ?? (`0x${"0".repeat(64)}` as Hex);
    const initCode = main.bytecode.object;
    const runtime = main.deployedBytecode.object;
    const b = typeof bounds === "string" ? { min: [], max: [], start: [] } : { min: bounds.min.map(String), max: bounds.max.map(String), start: bounds.start.map(String) };
    return { results, module: { name: main.name, kind: mk, initCode, runtime, codehash: keccak256(runtime), salt, address: moduleAddress(salt, initCode), bounds: b } };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}
