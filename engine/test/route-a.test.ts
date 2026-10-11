// Route A builder (scripts/route-a.ts): the pure parts. The full build (forge + solc 0.8.26) runs in CI (`node engine/scripts/route-a.ts build`).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { checkedAt, envelopeFromLaunch, gateIssues, opcodeFindings, packConfig, type Params, permitWindowS, PROFILE_VERSION, ROUTER_24H, runtimeImmutables, TRADE_FEE_POLICY, TRADE_FEE_POLICY_HASH, validateConfig, validateRequest } from "../scripts/route-a.ts";
import { assertAnonymous, PERSONAL_SHA256 } from "../src/anonymity.ts";
import { HOOK_FEES } from "../src/hook-fees.ts";
// the guard refuses to run without an identifier list (PERSONAL_IDS, a secret): a synthetic one here
PERSONAL_SHA256.add(createHash("sha256").update("fixtureonlytoken").digest("hex"));

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const p: Params = {
  poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90", positionManager: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e",
  graphFactory: "0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887",
  safe: a(0x5afe), agent: a(0xa6), anchorKey: a(0xa7), platformRecipient: "0xD88539d3c4C460136a733A3Fd60cf6BF269079da",
  registry: a(0x100), feeVault: a(0x101), buybackBurn: a(0x102), liquidityVault: a(0x103), postLaunchSalt: `0x${"11".repeat(32)}`,
  initialBuyWei: "500000000000000000", sqrtPriceX96: "1843504778864234216533230113107236", minDnaOut: "100000000000000000000000000",
  buyWei: "239400000000000000", tickLower: 1107, tickUpper: 201107,
};
const f = {
  launchWallet: a(0x1a0c4), nonce: `0x${"ab".repeat(32)}`, revision: "c".repeat(40), publicOrigin: "https://example.org/project-org/dna",
  xUrl: "https://x.com/contractdna", image: "assets/token.png", imageUri: "https://genomedna.xyz/token.png", website: "https://genomedna.xyz/",
  description: "A token whose Uniswap v4 hook learns its own fees in public.", fee: "22000", validAfter: 1_800_000_000, permitWindowS: 3600, checkedAt: "2026-10-07T00:00:00.000Z",
};

test("route A: pack config validates against Programmable's published pack-config v3.6 schema (profile 3.6.0, 2.2% project fee)", () => {
  const imms = { bootstrap: [], hook: [{ immutableId: "1", abiType: "address", target: "token" }], "platform-revenue": [], token: [] };
  const c = packConfig(p, f, imms);
  assert.deepEqual(validateConfig(c), []);
  assert.ok(!("profileVersion" in c), "fresh pack: CLI 4.1.5 takes the profile and the v2 fee policy from live capabilities");
  assert.equal(c.launchProfile.applicantSelectedBuyHundredthsOfBip, String(HOOK_FEES.baseline), "the declared project fee is DNAHook's baseline");
  assert.ok(validateConfig({ ...c, profileVersion: "3.3.0" }).length > 0, "the v3.6 schema refuses another profile");
  assert.equal(c.launchProfile.payoutRecipient, p.platformRecipient); // our PlatformRevenue recipient = Programmable's v2 one
  assert.equal(c.launchProfile.payoutRecipient, "0xD88539d3c4C460136a733A3Fd60cf6BF269079da");
  assert.ok(validateConfig({ ...c, launchProfile: { ...c.launchProfile, payoutRecipient: a(0xbad) } }).length > 0, "recipient outside the schema enum");
  assert.equal(c.targets.find((t) => t.targetId === "bootstrap")!.initializerValueWei, "500000000000000000");
  const bootInit = c.targets.find((t) => t.targetId === "bootstrap")!.initializer as unknown as { arguments: unknown[] };
  assert.deepEqual(bootInit.arguments[2], [p.sqrtPriceX96, p.tickLower, p.tickUpper, p.minDnaOut, p.buyWei], "LaunchParams order; buyEth is the buy, not msg.value");
  assert.notEqual(p.buyWei, p.initialBuyWei);
  assert.ok(validateConfig({ ...c, nonce: `0x${"00".repeat(32)}` }).length > 0, "zero nonce rejected");
  assert.ok(validateConfig({ ...c, launchProfile: { ...c.launchProfile, applicantSelectedBuyHundredthsOfBip: "100001" } }).length > 0, "> 10% rejected");
  assert.ok(validateConfig({ ...c, projectMetadata: { ...c.projectMetadata, presentation: { ...c.projectMetadata.presentation, links: [c.projectMetadata.presentation.links[0]] } } }).length > 0, "X link required");
});

test("route A: every immutable is mapped or the build fails closed; opcode lint skips PUSH data", () => {
  const names = new Map([["7", "token"], ["9", "mystery"]]);
  assert.deepEqual(runtimeImmutables({ "7": [] }, names, { token: { target: "token" } }, "hook"), [{ immutableId: "7", abiType: "address", target: "token" }]);
  assert.throws(() => runtimeImmutables({ "9": [] }, names, { token: { target: "token" } }, "hook"), /unmapped immutable 9 \(mystery\)/);
  assert.deepEqual(opcodeFindings("0x60ff00"), []); // PUSH1 0xff: data, not SELFDESTRUCT
  assert.deepEqual(opcodeFindings("0x5bfff4"), ["DELEGATECALL", "SELFDESTRUCT"]);
});

test("route A: envelope from a packed request, cross-checked against the hook's literal addresses", () => {
  const token = a(0x7070), hook = `0x${"12".repeat(18)}3fff`, platformRevenue = a(0x9090);
  const word = (x: string) => x.slice(2).toLowerCase().padStart(64, "0");
  const ctor = `0x${[p.poolManager, token, p.registry, p.feeVault, platformRevenue, p.buybackBurn].map(word).join("")}`;
  const req = {
    launchWallet: f.launchWallet, permitWindow: { validAfter: "1", deadline: "3601" },
    launchProfileSelection: { routeNamespace: "0xns", routeNonce: f.nonce, expectedPoolId: "0xpool", predictedInitializer: a(0xb007), poolKey: { currency0: "0x0000000000000000000000000000000000000000", currency1: token, hooks: hook } },
    verificationBundle: { components: [{ targetId: "hook", constructorArguments: ctor }] },
  };
  const e = envelopeFromLaunch(req, p);
  assert.deepEqual([e.token, e.hook, e.platformRevenue, e.bootstrap], [token, hook, platformRevenue, a(0xb007)]);
  assert.throws(() => envelopeFromLaunch(req, { ...p, registry: a(0x999) }), /word 2/);
  assert.throws(() => envelopeFromLaunch({ ...req, launchProfileSelection: { ...req.launchProfileSelection, poolKey: { ...req.launchProfileSelection.poolKey, hooks: a(1) } } }, p), /14 permission bits/);
});

test("route A: checkedAt is the source commit's time (a rebuild reproduces the bundle), never the wall clock", () => {
  const t = checkedAt("HEAD");
  assert.equal(new Date(t).toISOString(), t); // the schema's date-time form
  assert.equal(checkedAt("HEAD"), t);
  assert.equal(checkedAt("HEAD", f.checkedAt), f.checkedAt);
  assert.throws(() => checkedAt("0".repeat(40)), /set CHECKED_AT/);
});

test("the token image: contracts/assets/token.png (the source bundle, route A's PROJECT_IMAGE) = web/public/token.png (https://genomedna.xyz/token.png), the final helix logo", () => {
  const root = new URL("../../", import.meta.url);
  const sha = (p: string) => createHash("sha256").update(readFileSync(new URL(p, root))).digest("hex");
  assert.equal(sha("contracts/assets/token.png"), sha("web/public/token.png"), "the bundled image differs from the one the site serves");
  assert.equal(sha("contracts/assets/token.png"), "961554c402b2f1294b68c5bb6e328684c8e653241b2ece932d3e3c2b04769b33", "the final token logo");
  assert.match(readFileSync(new URL("engine/scripts/route-a.ts", root), "utf8"), /image: process\.env\.PROJECT_IMAGE \?\? "assets\/token\.png"/, "route A's default image is that file");
});

test("launch.env.example: names only, no real launch value (the real ones live in the gitignored contracts/.env.launch)", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const text = readFileSync(`${root}contracts/launch.env.example`, "utf8");
  const ex = Object.fromEntries(text.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=", 2)));
  for (const k of ["SAFE", "EXCLUDED_WALLETS", "AGENT", "ANCHOR_KEY", "KEEPER", "LAUNCH_WALLET", "X_HANDLE_CONFIRMED"]) assert.equal(ex[k], "", `${k} is a placeholder`);
  assert.doesNotMatch(text, /0x[0-9a-fA-F]{40}/, "no address anywhere in the example");
  assert.equal(ex.INITIAL_BUY_WEI, "500000000000000000", "0.5 ETH, the script default");
  assert.match(readFileSync(`${root}.gitignore`, "utf8"), /^\.env\.\*$/m, "contracts/.env.launch is ignored");
});

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/route-a/${name}`, import.meta.url), "utf8"));

test("route A: the packed request (Programmable's CLI 4.1.5 packer on our draft config) is a valid 3.6.0 request at 2.5%, v2 policy, recipient 0xD885", () => {
  const req = fixture("draft-launch-3.6.json"); // engine/scripts/programmable-cli.sh pack of `ROUTE_A_DRAFT=1 route-a.ts build`
  assert.deepEqual(validateRequest(req), [], "OpenAPI v3.6 CustomLaunchCreateRequestV3 + our pins");
  const fb = req.launchProfileSelection.platformFeeBinding;
  assert.deepEqual([fb.programmableFeeHundredthsOfBip, fb.economics.buy.effectiveTotalHundredthsOfBip], ["3000", "25000"]);
  const bad = (f: (r: any) => void) => { const r = structuredClone(req); f(r); return validateRequest(r); };
  assert.ok(bad((r) => { r.launchProfileSelection.platformFeeBinding.programmableFeeHundredthsOfBip = "1000"; }).length > 0, "3.6.0 binds 3000 (the schema const)");
  assert.ok(bad((r) => { r.launchProfile.profileVersion = "3.3.0"; }).some((e) => /profileVersion/.test(e)), "profile pinned");
  assert.ok(bad((r) => { r.launchProfileSelection.platformFeeBinding.economics.sell.projectHundredthsOfBip = "20000"; }).some((e) => /sell: project fee/.test(e)), "project fee = DNAHook baseline");
  assert.ok(bad((r) => { r.launchProfile.programmableTradeFeePolicy.defaultCollection.routedRateBps = 0; }).length > 0, "the routed policy is exactly v2");
  assert.equal(req.launchProfile.programmableTradeFeePolicy.policyVersion, "programmable.ethereum-routed-native-fee.v2");
  assert.equal(fb.claimBinding.payoutRecipient, "0xD88539d3c4C460136a733A3Fd60cf6BF269079da");
  assert.equal(req.launchProfile.router, ROUTER_24H.router, "CLI 4.1.5 binds the 24-hour successor Router");
  const v1 = "0x4957f49620AFf3Adbbe8195a4f633E49cc93376c";
  assert.ok(bad((r) => { const b = r.launchProfileSelection.platformFeeBinding; b.claimAuthority = b.claimBinding.claimAuthority = b.claimBinding.payoutRecipient = v1; }).some((e) => /fixed treasury/.test(e)), "the v1 recipient is refused");
  assert.ok(bad((r) => { r.launchProfile.router = "0x8622DD5bAb44185f2A458ac90384Ac99248f8d56"; }).some((e) => /successor/.test(e)), "a pre-4.1.4 Router binding is refused");
  assert.ok(bad((r) => { r.launchProfile.routerRuntimeCodeHash = `0x${"0".repeat(64)}`; }).length > 0, "the successor's runtime hash is pinned");
  assert.equal(TRADE_FEE_POLICY.ratePpm, String(HOOK_FEES.platform), "Programmable's routed rate and its on-hook share are both 0.30%");
});

test("the mainnet Router everywhere is the successor route A's check pins (Launch.s.sol, rehearsal.sh)", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const routers = (f: string) => [...readFileSync(`${root}${f}`, "utf8").matchAll(/ROUTER=(0x[0-9a-fA-F]{40})|c\.router = IRouter\((0x[0-9a-fA-F]{40})\)/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(routers("contracts/script/Launch.s.sol"), [ROUTER_24H.router]);
  assert.deepEqual(routers("engine/scripts/rehearsal.sh"), [ROUTER_24H.router]);
});

test("route A: the profile gate passes on the captured v3.6 capabilities and fails closed on any drift", () => {
  const cap = fixture("capabilities-v3.6.json");
  assert.deepEqual(gateIssues(cap), []);
  assert.equal(PROFILE_VERSION, cap.requestProfiles.current);
  const drift = (f: (c: any) => void) => { const c = structuredClone(cap); f(c); return gateIssues(c); };
  assert.equal(drift((c) => { c.requestProfiles.freshSubmissionExactVersions = ["3.7.0"]; }).length, 1, "a newer fresh-submission profile");
  assert.equal(cap.programmableTradeFeePolicy.policyHash, TRADE_FEE_POLICY_HASH);
  assert.equal(drift((c) => { c.programmableTradeFeePolicy.policyHash = `sha256:${"0".repeat(64)}`; }).length, 1, "a changed routed-fee policy hash");
  assert.equal(drift((c) => { c.programmableTradeFeePolicy.policy.native30Waiver.hook = "X"; }).length, 1, "a changed routed-fee policy body");
  assert.equal(drift((c) => { c.currentTradeFeePolicy.recipient = "0x4957f49620AFf3Adbbe8195a4f633E49cc93376c"; }).length, 1, "a recipient PlatformRevenue does not pay");
  assert.equal(drift((c) => { c.feePolicy.programmableHundredthsOfBip = "5000"; }).length, 1, "a share DNAHook does not charge");
  assert.equal(drift((c) => { c.compiler.admittedBuilds = ["0.8.30+commit.x"]; }).length, 1, "our compiler no longer admitted");
  assert.equal(drift((c) => { c.profile36Release.mandatoryCanonicalFeeVaultTarget = true; }).length, 1, "a fee-vault target became mandatory");
});

test("route A: the public origin is the pseudonymous org's repo (env-driven; passes the anonymity guard)", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const ex = Object.fromEntries(readFileSync(`${root}contracts/launch.env.example`, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=", 2)));
  assert.equal(ex.PUBLIC_ORIGIN, "https://github.com/contractdna/dna-contracts");
  assertAnonymous("PUBLIC_ORIGIN", ex.PUBLIC_ORIGIN);
  const imms = { bootstrap: [], hook: [{ immutableId: "1", abiType: "address", target: "token" }], "platform-revenue": [], token: [] };
  assert.equal(packConfig(p, { ...f, publicOrigin: ex.PUBLIC_ORIGIN }, imms).source.publicOrigin.url, ex.PUBLIC_ORIGIN);
  assert.doesNotMatch(readFileSync(`${root}engine/scripts/route-a.ts`, "utf8"), /contractdna\/dna/, "not a code default");
});

test("route A: packConfig carries a pinned launch wallet (the one exempt field) and still refuses a pinned publicOrigin", () => {
  const imms = { bootstrap: [], hook: [{ immutableId: "1", abiType: "address", target: "token" }], "platform-revenue": [], token: [] };
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const wallet = a(0xbeef1);
  const ids = new Set([sha(wallet.toLowerCase()), sha(wallet.slice(2).toLowerCase()), sha("someperson")]); // throwaway
  assert.throws(() => assertAnonymous("x", wallet, ids), /private identifier/, "the hash set does pin the wallet");
  assert.equal(packConfig(p, { ...f, launchWallet: wallet }, imms, ids).launchWallet, wallet);
  assert.throws(() => packConfig(p, { ...f, launchWallet: wallet, publicOrigin: "https://example.org/someperson/dna" }, imms, ids), /private identifier/);
  assert.throws(() => packConfig(p, { ...f, launchWallet: "someperson" }, imms, ids), /LAUNCH_WALLET is not an address/);
});

test("route A: PERMIT_WINDOW_S sets the permit lifetime: default 3600, 60..86400, anything else refused", () => {
  assert.equal(permitWindowS(undefined), 3600);
  assert.equal(permitWindowS("60"), 60);
  assert.equal(permitWindowS("86400"), 86_400);
  for (const v of ["59", "86401", "0", "", " 3600", "3600.5", "1e4", "-60", "24h"]) assert.throws(() => permitWindowS(v), /PERMIT_WINDOW_S/, v);
  const imms = { bootstrap: [], hook: [{ immutableId: "1", abiType: "address", target: "token" }], "platform-revenue": [], token: [] };
  const c = packConfig(p, { ...f, permitWindowS: 86_400 }, imms);
  assert.deepEqual(c.permitWindow, { validAfter: "1800000000", deadline: "1800086400" });
  assert.deepEqual(validateConfig(c), [], "the pack-config schema bounds neither field");
  assert.deepEqual(packConfig(p, f, imms).permitWindow.deadline, "1800003600", "default unchanged");
});

test("route A: check and envelope take a 24-hour window and refuse a longer one", () => {
  const req = fixture("draft-launch-3.6.json");
  const at = (life: number) => { const r = structuredClone(req); r.permitWindow.deadline = String(Number(r.permitWindow.validAfter) + life); return r; };
  assert.deepEqual(validateRequest(at(86_400)), []);
  assert.ok(validateRequest(at(86_401)).some((e) => /permit window is 86401 s/.test(e)));
  assert.ok(validateRequest(at(0)).some((e) => /permit window/.test(e)));
  const token = a(0x7070), hook = `0x${"12".repeat(18)}3fff`;
  const word = (x: string) => x.slice(2).toLowerCase().padStart(64, "0");
  const e = envelopeFromLaunch({
    launchWallet: f.launchWallet, permitWindow: { validAfter: "1800000000", deadline: "1800086400" },
    launchProfileSelection: { routeNamespace: "0xns", routeNonce: f.nonce, expectedPoolId: "0xpool", predictedInitializer: a(0xb007), poolKey: { currency0: "0x0000000000000000000000000000000000000000", currency1: token, hooks: hook } },
    verificationBundle: { components: [{ targetId: "hook", constructorArguments: `0x${[p.poolManager, token, p.registry, p.feeVault, a(0x9090), p.buybackBurn].map(word).join("")}` }] },
  }, p);
  assert.equal(e.deadline - e.validAfter, 86_400);
});

test("route A: envelope runs RouteAParams with --rpc-url MAINNET_RPC_URL (else forge reverts), and refuses without it", () => {
  const dir = mkdtempSync(`${tmpdir()}/route-a-forge-`);
  try {
    // a stand-in forge: records its argv, then fails (envelope stops there; nothing is written)
    writeFileSync(`${dir}/forge`, `#!/bin/sh\nprintf '%s ' "$@" > "${dir}/argv"\nexit 1\n`);
    chmodSync(`${dir}/forge`, 0o755);
    const script = new URL("../scripts/route-a.ts", import.meta.url).pathname;
    const launch = new URL("fixtures/route-a/draft-launch-3.6.json", import.meta.url).pathname;
    const run = (rpc?: string) => spawnSync(process.execPath, [script, "envelope", launch], {
      encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, START_BLOCK: "1", ENVELOPE: `${dir}/out.json`, ...(rpc ? { MAINNET_RPC_URL: rpc } : {}) },
    });
    const none = run();
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /MAINNET_RPC_URL/);
    assert.throws(() => readFileSync(`${dir}/argv`), "forge is not run without the RPC");
    const r = run("http://rpc.invalid");
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(`${dir}/argv`, "utf8").trim(), "script script/Launch.s.sol:RouteAParams --rpc-url http://rpc.invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
