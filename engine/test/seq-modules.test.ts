// A module order's gates against planted modules (test/fixtures/seq/tierfee/ and edits of it), the limits its
// conformance suite tests against, and the proposal the Safe gets: the code hash in it is the extcodehash of the code
// the CREATE2 deployer puts on chain. The forge-backed part needs forge, anvil and contracts/lib/forge-std.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { before, describe, test } from "node:test";
import { createPublicClient, createWalletClient, decodeAbiParameters, decodeFunctionData, type Hex, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { registryAbi } from "../src/abi.ts";
import { OP_TABLE } from "../src/lib.ts";
import { withAnvil } from "../src/pages.ts";
import { CREATE2_DEPLOYER, type GateRun, MODULE_GAS_CAP, moduleProposal, runGates } from "../src/seq-forge.ts";
import { bannedOpcode, bytecodeGate, type Change, depGate, MODULE_OPS, pathGate, sha256, specBounds } from "../src/seq-gates.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const KIT = join(ROOT, "contracts");
const FIX = new URL("./fixtures/seq/tierfee/", import.meta.url).pathname;
const hasForge = (() => {
  try { execFileSync("forge", ["--version"], { stdio: "ignore" }); execFileSync("anvil", ["--version"], { stdio: "ignore" }); } catch { return false; }
  return existsSync(join(KIT, "lib/forge-std/src/Test.sol"));
})();
const skip = hasForge ? false : "needs forge, anvil and contracts/lib/forge-std";
const SRC = "contracts/src/modules/tierfee/TierFee.sol";
const TEST = "contracts/test/modules/tierfee/TierFee.t.sol";
const SPEC = "contracts/src/modules/tierfee/SPEC.json";

function tierfee(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out[relative(FIX, p)] = readFileSync(p, "utf8"); } };
  walk(FIX);
  return out;
}
const added = (files: Record<string, string>): Change[] => Object.entries(files).map(([path, t]) => ({ path, status: "A", mode: "100644", size: t.length }));
const spec = JSON.parse(tierfee()[SPEC]) as { spec: string; specSha256: string };
const SALT = keccak256("0x01");
const gates = (files: Record<string, string>, baseHasSlug = false) =>
  runGates({ kind: "module", slug: "tierfee", changes: added(files), files, baseHasSlug, prBody: "A fee module: bigger swaps pay one or two steps more.", kit: KIT, order: { seed: "seed", specSha256: spec.specSha256, salt: SALT } });
const failed = (r: GateRun) => r.results.filter((g) => !g.ok).map((g) => g.gate);

// ---------------------------------------------------------------- without forge

describe("module: G1, G2, G4, the bounds, the limits", () => {
  const ok = (path: string): Change => ({ path, status: "A", mode: "100644", size: 10 });
  test("the module's own new folders pass", () => assert.deepEqual(pathGate(added(tierfee()), "tierfee", false, "module").issues, []));
  for (const [what, c, want] of [
    ["the policy interfaces", ok("contracts/src/interfaces/IPolicies.sol"), /never reachable \(the core contracts\)/],
    ["the conformance suite", ok("contracts/test/modules/ModuleConformance.sol"), /never reachable \(the core contracts\)/],
    ["an existing module", ok("contracts/src/modules/AdaptiveFee.sol"), /never reachable \(the core contracts\)/],
    ["the registry", ok("contracts/src/ModuleRegistry.sol"), /never reachable \(the core contracts\)/],
    ["the hook", ok("contracts/src/DNAHook.sol"), /never reachable \(the hook\)/],
    ["the modules profile", ok("contracts/modules/foundry.toml"), /never reachable \(the core contracts\)/],
    ["another module", ok("contracts/src/modules/other/X.sol"), /outside the module's folders/],
    ["a game", ok("contracts/src/games/tierfee/X.sol"), /outside the module's folders/],
    ["a page", ok("web/app/tierfee/page.tsx"), /outside the module's folders/],
    ["a non-Solidity file", ok("contracts/src/modules/tierfee/notes.md"), /only \.sol files and SPEC\.json/],
    ["a changed file", { ...ok(SRC), status: "M" }, /changed \(a build only adds files\)/],
  ] as [string, Change, RegExp][]) {
    test(`planted: ${what}`, () => assert.match(pathGate([ok(SRC), c], "tierfee", false, "module").issues.join("\n"), want));
  }
  test("planted: the module's folder already exists at the base", () => {
    assert.match(pathGate([ok(SRC)], "tierfee", true, "module").issues.join(), /the module's folders already exist/);
  });

  test("G2: the interfaces and its own files; tests also forge-std and the suite", () => assert.deepEqual(depGate(tierfee(), "tierfee", "module").issues, []));
  const sol = (path: string, imp: string) => ({ [path]: `pragma solidity 0.8.26;\nimport ${imp};\ncontract A {}\n` });
  for (const [what, files] of [
    ["a v4 library", sol(SRC, `{FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol"`)],
    ["the hook", sol(SRC, `"../../DNAHook.sol"`)],
    ["the registry", sol(SRC, `"../../ModuleRegistry.sol"`)],
    ["an existing module", sol(SRC, `"../AdaptiveFee.sol"`)],
    ["forge-std in the source", sol(SRC, `"forge-std/Test.sol"`)],
    ["the suite from the source", sol(SRC, `"../../../test/modules/ModuleConformance.sol"`)],
    ["another module's test", sol(TEST, `"../other/O.t.sol"`)],
    ["the game kit from a test", sol(TEST, `"../../games/GameKitConformance.sol"`)],
  ] as [string, Record<string, string>][]) {
    test(`planted G2: ${what}`, () => assert.equal(depGate(files, "tierfee", "module").ok, false));
  }

  test("G4: a module writes, logs, calls and reads of its environment nothing (PUSH data skipped); CALLVALUE stays (solc's non-payable check)", () => {
    for (const op of ["55", "5d", "a0", "a1", "a2", "a3", "a4", "f1", "fa", "f0", "f2", "f4", "f5", "ff", "31", "32", "33", "3a", "3b", "3c", "3f", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "4a", "5a"]) {
      assert.equal(bytecodeGate(`0x6001${op}00`, { module: true }).ok, false, op);
    }
    assert.equal(bannedOpcode("0x7f" + "55".repeat(32) + "00", MODULE_OPS), null);
    assert.equal(bytecodeGate("0x6001600155", {}).ok, true, "a game may write storage");
    assert.equal(bytecodeGate("0x34600100", { module: true }).ok, true, "CALLVALUE: every non-payable function reads it");
    // a library placeholder would cut the walk short (and links make the code depend on another contract): games too
    for (const m of [{ module: true }, {}]) {
      assert.match(bytecodeGate("0x6001__$1234567890abcdef1234567890abcdef12$__f400", m).issues.join(), /not plain bytecode/);
      assert.match(bytecodeGate("0x600100", { ...m, links: 1 }).issues.join(), /library link reference/);
    }
  });

  test("bounds: four decimal words each, lowest ≤ start ≤ highest", () => {
    assert.deepEqual(specBounds({ min: ["1", "0", "0", "0"], max: ["3", "0", "9", "1"], start: ["2", "0", "9", "0"] }), { min: [1n, 0n, 0n, 0n], max: [3n, 0n, 9n, 1n], start: [2n, 0n, 9n, 0n] });
    for (const b of [{ min: ["1"], max: ["1"], start: ["1"] }, { min: ["0", "0", "0", "-1"], max: ["0", "0", "0", "0"], start: ["0", "0", "0", "0"] }, { min: ["0", "0", "0", "0x1"], max: ["1", "1", "1", "1"], start: ["0", "0", "0", "0"] }, { min: ["0", "0", "0", "5"], max: ["1", "1", "1", "9"], start: ["0", "0", "0", "4"] }, { min: ["0", "0", "0", (2n ** 256n).toString()], max: ["0", "0", "0", "0"], start: ["0", "0", "0", "0"] }]) {
      assert.equal(typeof specBounds(b), "string", JSON.stringify(b));
    }
  });

  test("the limits the suite tests against are the hook's and FeeVault's own (caps unchanged)", () => {
    const suite = readFileSync(join(KIT, "test/modules/ModuleConformance.sol"), "utf8");
    const hook = readFileSync(join(KIT, "src/DNAHook.sol"), "utf8");
    const vault = readFileSync(join(KIT, "src/FeeVault.sol"), "utf8");
    const num = (src: string, name: string) => Number(src.match(new RegExp(`\\b${name}\\s*=\\s*([\\d_]+)`))?.[1].replace(/_/g, ""));
    assert.equal(num(suite, "GAS_CAP"), num(hook, "MODULE_GAS_CAP"));
    assert.equal(num(suite, "GAS_CAP"), num(vault, "SPLIT_GAS_CAP"));
    assert.equal(num(suite, "MAX_FEE"), num(hook, "MAX_PROJECT_FEE"));
    assert.equal(num(suite, "GAS_CAP"), MODULE_GAS_CAP);
  });
});

// ---------------------------------------------------------------- forge-backed

describe("module gates, forge-backed", { skip }, () => {
  let good: GateRun;
  before(async () => { good = await gates(tierfee()); });

  test("the fixture module passes every module gate, and the enclave's compile gives its code hash and address", () => {
    assert.deepEqual(good.results.map((g) => [g.gate, g.ok, g.issues.slice(0, 2)]), [
      ["G1", true, []], ["G2", true, []], ["G12", true, []], ["G3", true, []], ["G5", true, []], ["G4", true, []], ["G6", true, []], ["G8", true, []], ["G7", true, []],
    ]);
    const m = good.module!;
    assert.equal(m.kind, "fee");
    assert.equal(m.codehash, keccak256(m.runtime));
    assert.deepEqual(m.bounds.max, ["35000", "5000", "35000", "10000000000000000000"]);
    assert.equal(good.game, undefined);
  });

  test("the proposal's code hash is the extcodehash of what the CREATE2 deployer puts on chain; its calls are the registry's own ops", async () => {
    const m = good.module!;
    const registry = "0x00000000000000000000000000000000000000e1" as Hex;
    const p = moduleProposal(m, spec.specSha256, registry);
    assert.equal(p.codehash, m.codehash);
    await withAnvil(undefined, async (url) => {
      const acct = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
      const wallet = createWalletClient({ account: acct, chain: foundry, transport: http(url) });
      const pub = createPublicClient({ chain: foundry, transport: http(url) });
      const deploy = p.calls[0];
      assert.equal(deploy.to, CREATE2_DEPLOYER);
      await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: deploy.to, data: deploy.data }) });
      const code = await pub.getCode({ address: p.address });
      assert.ok(code && code !== "0x", "the module is at the proposed address");
      assert.equal(keccak256(code!), p.codehash, "extcodehash = the proposed code hash");
    });
    const op = (data: Hex) => decodeFunctionData({ abi: registryAbi, data });
    const approve = op(p.calls[1].data);
    assert.deepEqual([p.calls[1].to, approve.functionName, approve.args![0]], [registry, "queue", 9]);
    const [h, kind, lo, hi] = decodeAbiParameters(OP_TABLE[9][1].map((type) => ({ type })), approve.args![1] as Hex) as [Hex, number, Hex[], Hex[]];
    assert.deepEqual([h, kind, lo.map((x) => BigInt(x).toString()), hi.map((x) => BigInt(x).toString())], [m.codehash, 0, m.bounds.min, m.bounds.max]);
    const reg = op(p.calls[2].data);
    assert.equal(reg.args![0], 0, "Register");
    const [addr, k2, specHash, start] = decodeAbiParameters(OP_TABLE[0][1].map((type) => ({ type })), reg.args![1] as Hex) as [Hex, number, Hex, Hex[]];
    assert.deepEqual([addr.toLowerCase(), k2, specHash, start.map((x) => BigInt(x).toString())], [p.address.toLowerCase(), 0, `0x${spec.specSha256}`, m.bounds.start]);
    assert.equal(sha256(spec.spec), spec.specSha256);
  });

  const edit = (f: (files: Record<string, string>) => void) => { const files = tierfee(); f(files); return files; };
  const src = (from: string, to: string) => edit((x) => { x[SRC] = x[SRC].replace(from, to); });
  const planted: [string, Record<string, string>, string, RegExp][] = [
    ["over the gas cap", src("uint256 raw = base + step * tiers;", "uint256 raw = base + step * tiers;\n        for (uint256 i; i < 4000; ++i) raw = raw * 1 + (i & 0);"), "G8", /gas \(the cap is 40000\)/],
    ["a storage variable", src("uint256 private constant HARD_CAP = 50_000;", "uint256 private constant HARD_CAP = 50_000;\n    uint256 private seen;"), "G3", /a storage variable/],
    ["an external call", edit((x) => { x[SRC] = x[SRC].replace("external pure returns", "external view returns").replace("uint256 base = uint24(uint256(params[0]));", "uint256 base = IFeePolicy(address(0x1234)).projectFee(ctx, params);"); }), "G3", /external call/],
    ["not a fee policy", src("contract TierFee is IFeePolicy {", "contract TierFee {"), "G5", /exactly one of IFeePolicy and ISplitPolicy/],
    ["a second function", src("    function projectFee(", "    function bump() external pure returns (uint256) { return 1; }\n\n    function projectFee("), "G5", /bump\(\): a module's ABI is its one policy function/],
    ["a constructor input", src("    function projectFee(", "    constructor(uint256) {}\n\n    function projectFee("), "G5", /constructor with inputs/],
    ["a view function reading the block", edit((x) => { x[SRC] = x[SRC].replace("external pure returns", "external view returns").replace("uint256 base = uint24(uint256(params[0]));", "uint256 base = uint24(uint256(params[0])) + (block.timestamp % 2);"); }), "G5", /is view \(pure only/],
    ["the block's time, in the bytecode", edit((x) => { x[SRC] = x[SRC].replace("external pure returns", "external view returns").replace("uint256 base = uint24(uint256(params[0]));", "uint256 base = uint24(uint256(params[0])) + (block.timestamp % 2);"); }), "G4", /banned opcode 0x42/],
    ["a mocked answer in a test", edit((x) => { x[TEST] = x[TEST].replace(/\n\}\n$/, "\n    function test_mocked() public {\n        vm.mockCall(module, abi.encodeWithSelector(TierFee.projectFee.selector), abi.encode(uint24(1)));\n    }\n}\n"); }), "G3", /cheatcode vm\.mockCall in a module's test/],
    ["code rewritten under the suite", edit((x) => { x[TEST] = x[TEST].replace(/\n\}\n$/, "\n    function test_etched() public {\n        vm.etch(module, hex\"00\");\n    }\n}\n"); }), "G3", /cheatcode vm\.etch in a module's test/],
    ["storage written under the suite", edit((x) => { x[TEST] = x[TEST].replace(/\n\}\n$/, "\n    function test_stored() public {\n        vm.store(module, bytes32(0), bytes32(uint256(1)));\n    }\n}\n"); }), "G3", /cheatcode vm\.store in a module's test/],
    ["a test contract that inherits the module", edit((x) => { x[TEST] = x[TEST] + "\ncontract Sub is TierFee {}\n"; }), "G5", /Sub inherits the module/],
    ["a stand-in for the module in the conformance suite", edit((x) => { x[TEST] = x[TEST].replace("return type(TierFee).creationCode;", "return type(Stand).creationCode;") + "\ncontract Stand {\n    function projectFee(FeeContext calldata, bytes32[4] calldata) external pure returns (uint24) {\n        return 20_000;\n    }\n}\n"; }), "G6", /the conformance suite ran on code 0x[0-9a-f]{64}, not the module.s own/],
    ["bounds SPEC.json does not test", edit((x) => { x[SPEC] = x[SPEC].replace('"5000",', '"6000",'); }), "G6", /the tests ran with bounds .*SPEC\.json proposes/],
    ["a split SPEC.json for a fee module", edit((x) => { x[SPEC] = x[SPEC].replace('"module": "fee"', '"module": "split"'); }), "G5", /SPEC\.json says a split module/],
    ["tests that catch no planted bug", edit((x) => { x[TEST] = x[TEST].replace(/\n    function test_tiers[\s\S]*\n\}\n$/, "\n}\n"); }), "G7", /planted bugs caught/],
  ];
  for (const [what, files, g, want] of planted) {
    test(`planted: ${what} → ${g}`, async () => {
      const r = await gates(files);
      assert.ok(failed(r).includes(g as never), `${what}: failed ${failed(r).join(", ")}`);
      assert.match(r.results.find((x) => x.gate === g)!.issues.join("\n"), want);
    });
  }
});
