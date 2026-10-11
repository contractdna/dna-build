// Route A: Programmable's self-serve Custom Launch API V3, Ethereum profile 3.6.0. Builds every input
// `programmable-launch pack` (CLI 4.1.5, run from its public source: scripts/programmable-cli.sh) needs from our
// deterministic launch parameters, and validates locally against Programmable's published contracts, vendored verbatim:
//   - the pack config: route-a.pack-config-v3.6.schema.json (sha256 c4d461d1…9169 = PROGRAMMABLE@74458fb
//     packages/launch/schemas/programmable-launch-pack-config-v3.6.json);
//   - the packed request: programmable-openapi/custom-launch-v3.6.json (c8b79ebb…1a47 =
//     https://programmable.market/openapi/custom-launch-v3.6.json) with the v3 (8c7f9025…2b6a) and v2 (a4f2dad8…a70e)
//     documents it references, schema CustomLaunchCreateRequestV3.
//
//   node scripts/route-a.ts build              → programmable-launch.config.json (repo root) + contracts/route-a/
//                                                (both gitignored; source root = contracts/): standard-json/dna.json (one exact
//                                                Standard JSON for all four targets), artifacts/<target>.json (compiled
//                                                from THAT input by solc 0.8.26+commit.8a97fa7a, byte-compared with
//                                                forge's out/), evidence/dna-build.json
//   node scripts/route-a.ts gate               → GET /v3/capabilities: 3.6.0 admitted, the pinned 0.3% v2 policy
//                                                (recipient 0xD885…79da = PAYOUT), solc
//   node scripts/route-a.ts check <launch.json> → the packed request against the v3.6 OpenAPI + our fee/profile pins
//   node scripts/route-a.ts envelope <launch.json>
//                                              → engine/deployments/1.envelope.json for PostLaunchMainnet: the graph
//                                                addresses Programmable's packer derived, checked against our literals
//
// Why the request itself is not built here: its namespace, CREATE2 predictions, locators and hashes are a function of
// the exact source bundle and are derived only by Programmable's packer (pack-config schema: "Derived hashes, CREATE2
// predictions … are not applicant inputs"); the server re-derives them. We build the complete applicant input.
//
// Env (operator values; a missing one fails the build, exit 1, unless ROUTE_A_DRAFT=1 = CI: loud DRAFT placeholders):
// LAUNCH_WALLET (= the controller wallet the API key is bound to), PROGRAMMABLE_LAUNCH_NONCE (0x + 64 hex, `openssl rand
// -hex 32`), SOURCE_REVISION (public 40-hex commit containing these bytes), X_HANDLE_CONFIRMED (must equal
// DNAToken.X_HANDLE: the X link is read from the token source, so pack config and frozen tokenURI agree; the env is
// the operator's explicit confirmation that the literal is final, not a placeholder), SAFE, AGENT,
// ANCHOR_KEY, EXCLUDED_WALLETS (comma-separated Safe signer EOAs; read by forge: they fix the post-launch addresses
// baked into the hook). Optional: INITIAL_BUY_WEI (the launch value, default 0.5 ETH; nonzero; Launch.s.sol
// splits it into the launch buy (BUY_WEI) and the full-range position's ETH), PUBLIC_ORIGIN,
// PROJECT_IMAGE (contracts-relative), IMAGE_URI, WEBSITE_URL, SELECTED_FEE_HUNDREDTHS_OF_BIP (default 22000 = the 2.2%
// baseline), PERMIT_VALID_AFTER (unix s, default now − 60), PERMIT_WINDOW_S (deadline − validAfter, default 3600,
// 60..86400: the successor Router's MAX_PERMIT_LIFETIME is 24 h), CHECKED_AT (default: SOURCE_REVISION's
// commit time, so a rebuild with the same inputs is byte-identical), SOLC (path to solc 0.8.26), plus Launch.s.sol's
// OPEN_SQRT_PRICE_X96 etc.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { assertAnonymous, PERSONAL_SHA256 } from "../src/anonymity.ts";
import { canonical } from "../src/canonical.ts";
import { HOOK_FEES } from "../src/hook-fees.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACTS = `${REPO}contracts/`;
const OUT_DIR = "route-a"; // relative to contracts/, the pack source root
const CONFIG = "programmable-launch.config.json"; // repo root (gitignored): the source root must be a subdirectory of it
const SOLC_BUILD = "0.8.26+commit.8a97fa7a"; // /v3/capabilities compiler.admittedBuilds
const NATIVE = "0x0000000000000000000000000000000000000000";
// Programmable's current fee recipient: the v2 routed-fee policy's, and the payoutRecipient/claimAuthority the v3.6
// schemas bind to that policy (both still list the v1 recipient 0x4957…376c, which 4.1.5 no longer submits)
const PAYOUT = "0xD88539d3c4C460136a733A3Fd60cf6BF269079da";
export const PROFILE_VERSION = "3.6.0"; // the only fresh-submission profile as of 2026-10-08

export type Params = Record<"poolManager" | "positionManager" | "graphFactory" | "safe" | "agent" | "anchorKey" | "platformRecipient" | "registry" | "feeVault" | "buybackBurn" | "liquidityVault" | "postLaunchSalt" | "initialBuyWei" | "sqrtPriceX96" | "minDnaOut" | "buyWei", string> & { tickLower: number; tickUpper: number };
type Ref = { target: string };
type Imm = { immutableId: string; abiType: string; literal?: string; target?: string };

/** Targets: contract, constructor args (`{target}` = an address the packer fills in), and what every immutable is. */
export function targets(p: Params) {
  const t = (id: string): Ref => ({ target: id });
  return [
    { targetId: "bootstrap", file: "src/Bootstrap.sol", name: "Bootstrap", kind: "other", args: [p.safe, p.positionManager, p.graphFactory],
      init: { function: "initialize", arguments: [t("token"), t("hook"), [p.sqrtPriceX96, p.tickLower, p.tickUpper, p.minDnaOut, p.buyWei]] }, value: p.initialBuyWei,
      imm: { safe: p.safe, positionManager: p.positionManager, poolManager: p.poolManager, factory: p.graphFactory } },
    { targetId: "hook", file: "src/DNAHook.sol", name: "DNAHook", kind: "hook", args: [p.poolManager, t("token"), p.registry, p.feeVault, t("platform-revenue"), p.buybackBurn],
      init: null, value: "0",
      imm: { poolManager: p.poolManager, token: t("token"), registry: p.registry, feeVault: p.feeVault, platformRevenue: t("platform-revenue"), buybackBurn: p.buybackBurn } },
    { targetId: "platform-revenue", file: "src/PlatformRevenue.sol", name: "PlatformRevenue", kind: "other", args: [p.poolManager, p.platformRecipient],
      init: null, value: "0", imm: { poolManager: p.poolManager, recipient: p.platformRecipient } },
    { targetId: "token", file: "src/DNAToken.sol", name: "DNAToken", kind: "token", args: [t("bootstrap")], init: null, value: "0", imm: {} },
  ] as const;
}

export const HOOK_PERMISSIONS = ["beforeInitialize", "afterInitialize", "beforeAddLiquidity", "afterAddLiquidity", "beforeRemoveLiquidity", "afterRemoveLiquidity", "beforeSwap", "afterSwap", "beforeDonate", "afterDonate", "beforeSwapReturnDelta", "afterSwapReturnDelta", "afterAddLiquidityReturnDelta", "afterRemoveLiquidityReturnDelta"];

/** Every compiler immutable of a target → literal or `{target}`. Fails closed on an immutable we did not map
 *  (Programmable's example does the same: never guess runtime materialization). */
export function runtimeImmutables(refs: Record<string, unknown>, names: Map<string, string>, map: Record<string, string | Ref>, label: string): Imm[] {
  return Object.keys(refs).sort((a, b) => Number(a) - Number(b)).map((id) => {
    const name = names.get(id);
    const v = name === undefined ? undefined : map[name];
    if (v === undefined) throw new Error(`${label}: unmapped immutable ${id} (${name ?? "no AST declaration"})`);
    return typeof v === "string" ? { immutableId: id, abiType: "address", literal: v } : { immutableId: id, abiType: "address", target: v.target };
  });
}

/** Builds the pack config (programmable.launch-pack-config.v3). Pure: tested in test/route-a.test.ts. */
export function packConfig(p: Params, f: { launchWallet: string; nonce: string; revision: string; publicOrigin: string; xUrl: string; image: string; imageUri: string; website: string; description: string; fee: string; validAfter: number; permitWindowS: number; checkedAt: string },
  imms: Record<string, Imm[]>, ids?: Set<string>) {
  // the launch wallet's address is exempt from the identifier check (the pack is bound to it; the pack config is
  // gitignored, the envelope export-ignored), but only as a bare address. Every other field stays checked
  const { launchWallet, ...rest } = f;
  if (!/^0x[0-9a-fA-F]{40}$/.test(launchWallet)) throw new Error("LAUNCH_WALLET is not an address");
  assertAnonymous("the launch package", rest, ids);
  return {
    schemaVersion: "programmable.launch-pack-config.v3",
    // no profileVersion: CLI 4.1.5 then packs fresh against the live /v3/capabilities profile AND routed-fee policy
    // (v2, PAYOUT). An explicit "3.6.0" keeps the CLI's built-in v1 policy (recipient 0x4957…), which it refuses to
    // submit. `gate` pins the live profile to 3.6.0 and the policy to v2; `check` pins both in the packed request
    launchWallet: f.launchWallet,
    chainId: "1",
    nonce: f.nonce,
    source: {
      root: "contracts", // every path below is relative to it; foundry.lock pins the lib/ submodule commits
      paths: ["foundry.lock", "foundry.toml", "src"],
      sourceLineageNonce: "1",
      publicOrigin: { url: f.publicOrigin, revision: f.revision },
    },
    compilationUnits: [{ compilationUnitId: "dna-solc-0.8.26", standardJson: `${OUT_DIR}/standard-json/dna.json` }],
    targets: targets(p).map((t) => ({
      targetId: t.targetId,
      compilationUnitId: "dna-solc-0.8.26",
      artifact: `${OUT_DIR}/artifacts/${t.targetId}.json`,
      // the packer grinds the hook salt until the address's low 14 bits = the declared mask (0x3fff: ~16k tries)
      applicantSalt: t.kind === "hook" ? { mode: "deterministic-hook-permission-grind-v1", start: "0", maxAttempts: "1000000" } : `0x${"00".repeat(32)}`,
      constructorArguments: t.args,
      initializer: t.init,
      deploymentValueWei: "0",
      initializerValueWei: t.value,
      componentKind: t.kind,
      declaredHookPermissions: t.kind === "hook" ? HOOK_PERMISSIONS : null,
      runtimeImmutables: imms[t.targetId],
    })),
    pool: { tokenTargetId: "token", hookTargetId: "hook", fee: 8388608, tickSpacing: 1, quoteCurrency: NATIVE },
    projectMetadata: {
      schemaVersion: "programmable.project-metadata-input.v1",
      token: { name: "DNA", symbol: "DNA" },
      presentation: { description: f.description, image: { sourcePath: f.image, uri: f.imageUri }, links: [{ kind: "website", uri: f.website }, { kind: "x", uri: f.xUrl }] },
    },
    launchProfile: {
      schemaVersion: "programmable.direct-native-hook-graph-profile-selection.v3",
      profileId: "programmable.direct-native-hook-graph.v1",
      profileRevision: 3,
      targetRoles: { tokenTargetId: "token", hookTargetId: "hook", initializerTargetId: "bootstrap", platformFeeBindingTargetId: "hook" },
      liquidityModel: {
        schemaVersion: "programmable.direct-native-liquidity-model-intent.v1",
        model: "launch-seeded-concentrated-liquidity",
        declaredLaunchState: "assessment_required",
        liquidityTargetId: "bootstrap",
        assessment: {
          schemaVersion: "programmable.direct-native-liquidity-model-assessment.v1",
          status: "required",
          requestClaimsExecution: false,
          requiredVectorIds: ["liquidity.seeded.pool-active-liquidity", "liquidity.seeded.position-custody-and-withdrawal", "liquidity.seeded.buy-and-sell"],
        },
      },
      fundingMode: "wallet-transaction-value", // the launch value (INITIAL_BUY_WEI: the launch buy + the full-range position's ETH) is the Router tx msg.value → Bootstrap
      accountingMode: "additive-platform-share", // DNAHook: project pips + PLATFORM_FEE (3,000) on top
      assessmentBase: "executed-gross-declared-quote", // gross ETH leg; ETH is the quote currency
      feeCurrency: "declared-quote-currency",
      claimMode: "immutable-payout-recipient", // PlatformRevenue pays only 0xD885…, immutably
      payoutRecipient: PAYOUT,
      applicantSelectedBuyHundredthsOfBip: f.fee,
      applicantSelectedSellHundredthsOfBip: f.fee,
    },
    permitWindow: { validAfter: String(f.validAfter), deadline: String(f.validAfter + f.permitWindowS) },
    agentAttestation: {
      agentId: "dna-route-a-builder",
      checkedAt: f.checkedAt,
      checks: [{ checkId: "exact-standard-json-build-matches-forge-artifacts", evidence: `${OUT_DIR}/evidence/dna-build.json` }],
    },
  };
}

/** PERMIT_WINDOW_S → the permit lifetime in seconds: default 3600, else an integer 60..86,400 (ROUTER_24H's
 *  MAX_PERMIT_LIFETIME and CLI 4.1.5's validateDirectNativePermitWindow bound). Anything else is refused. */
export function permitWindowS(v: string | undefined) {
  if (v === undefined) return 3600;
  if (!/^\d+$/.test(v) || Number(v) < 60 || Number(v) > 86_400) throw new Error(`PERMIT_WINDOW_S=${JSON.stringify(v)}: must be an integer number of seconds, 60..86400`);
  return Number(v);
}

/** The evidence timestamp: an explicit override, else the commit time of `rev`. Never "now": evidence/dna-build.json
 *  is in the bundle, so a wall-clock value would change its sha and every address on each rebuild. */
export function checkedAt(rev: string, override?: string) {
  if (override) return override;
  const r = spawnSync("git", ["log", "-1", "--format=%cI", rev], { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git log ${rev} failed (fetch the commit or set CHECKED_AT): ${r.stderr}`);
  return new Date(r.stdout.trim()).toISOString();
}

/** Opcode lint of a runtime (PUSH data skipped, like Programmable's packer scan): CALLCODE / SELFDESTRUCT are
 *  static-baseline (3.3.0, kept by 3.6.0) hard blocks on any target; DELEGATECALL / CREATE / CREATE2 are needs-evidence findings. */
export function opcodeFindings(runtimeHex: string) {
  const b = Buffer.from(runtimeHex.replace(/^0x/, ""), "hex");
  const names: Record<number, string> = { 0xf0: "CREATE", 0xf2: "CALLCODE", 0xf4: "DELEGATECALL", 0xf5: "CREATE2", 0xff: "SELFDESTRUCT" };
  const found = new Set<string>();
  for (let pc = 0; pc < b.length; pc += b[pc] >= 0x60 && b[pc] <= 0x7f ? b[pc] - 0x5e : 1) if (names[b[pc]]) found.add(names[b[pc]]);
  return [...found].sort();
}

/** Local validation: the published JSON Schema plus the byte rules it says generic validators can't express. The
 *  config omits profileVersion (the CLI selects it from capabilities): validated as the 3.6.0 the gate admits. */
export function validateConfig(config: unknown): string[] {
  const schema = JSON.parse(readFileSync(new URL("route-a.pack-config-v3.6.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("uri", (s: string) => URL.canParse(s));
  ajv.addFormat("date-time", (s: string) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s);
  const ok = ajv.validate(schema, { profileVersion: PROFILE_VERSION, ...(config as object) });
  const errs = ok ? [] : (ajv.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
  const c = config as ReturnType<typeof packConfig>;
  const d = c.projectMetadata?.presentation?.description ?? "";
  if (Buffer.byteLength(d) < 20 || [...d.matchAll(/[\p{L}\p{N}]/gu)].length < 8) errs.push("/projectMetadata/presentation/description too short");
  return errs;
}

const OPENAPI = ["custom-launch-v1.json", "custom-launch-v2.json", "custom-launch-v3.json", "custom-launch-v3.6.json"];
const readOpenApi = (f: string) => JSON.parse(readFileSync(new URL(`programmable-openapi/${f}`, import.meta.url), "utf8"));
const POLICY_VERSION = "programmable.ethereum-routed-native-fee.v2";
/** Programmable's current routed-trade fee policy for 3.6.0 (v2, recipient PAYOUT), byte for byte (the OpenAPI oneOf
 *  const) and its published hash. */
export const TRADE_FEE_POLICY = readOpenApi("custom-launch-v3.6.json").components.schemas.ProgrammableTradeFeePolicyV36.oneOf
  .map((o: { const: { policyVersion: string } }) => o.const).find((c: { policyVersion: string }) => c.policyVersion === POLICY_VERSION);
if (TRADE_FEE_POLICY?.defaultCollection?.recipient !== PAYOUT) throw new Error(`the vendored v3.6 OpenAPI has no ${POLICY_VERSION} paying ${PAYOUT}`);
export const TRADE_FEE_POLICY_HASH = "sha256:e2025776ad3b12e6277575259cccf11444810365975209083fea534d8e70b4b5";

// Programmable's launch-stamp Routers (ProgrammableLaunchStampRouterV1), runtime keccak read on mainnet 2026-10-09.
// ROUTER_V1 is the v3.6 OpenAPI const; ROUTER_24H, its successor with a 24-hour signing window, is what CLI 4.1.4+
// packs fresh 3.6 launches for (packages/launch/src/constants.mjs ROUTER_24H; Programmable's wallet handoff accepts both)
const ROUTER_V1 = { router: "0x8622DD5bAb44185f2A458ac90384Ac99248f8d56", routerRuntimeCodeHash: "0x40e27ecf201761d5eb66bc4f2d5c6124831ef078d7baf458ca5f41b1a8108546" };
export const ROUTER_24H = { router: "0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3", routerRuntimeCodeHash: "0xf2d611fb92718c63cf5767300e79d7c9b49480b2e9001448b96c1385f4edb6f3" };

/** The packed request (Programmable's packer output) against the published v3.6 OpenAPI request schema, then our
 *  pins: profile 3.6.0, Programmable's 3000 share = DNAHook.PLATFORM_FEE, our 22000 project fee = DNAHook's
 *  baseline (2.5% effective), additive, the fixed recipient (PAYOUT), the exact 0.3% v2 routed-trade policy, and the
 *  24-hour successor Router. */
export function validateRequest(req: any): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("uri", (s: string) => URL.canParse(s));
  ajv.addFormat("date-time", (s: string) => !Number.isNaN(Date.parse(s)));
  for (const f of OPENAPI) ajv.addSchema(readOpenApi(f), `https://programmable.market/openapi/${f}`);
  const v = ajv.compile({ $ref: "https://programmable.market/openapi/custom-launch-v3.6.json#/components/schemas/CustomLaunchCreateRequestV3" });
  // the published v3.6 OpenAPI still consts the original Router; the CLI (4.1.4+) binds every fresh 3.6 pack to its
  // successor, pinned exactly: everything else is checked against the OpenAPI as published
  const lp = req?.launchProfile;
  const successor = lp?.router === ROUTER_24H.router && lp?.routerRuntimeCodeHash === ROUTER_24H.routerRuntimeCodeHash;
  const asPublished = successor ? { ...req, launchProfile: { ...lp, ...ROUTER_V1 } } : req;
  const errs = v(asPublished) ? [] : (v.errors ?? []).slice(0, 20).map((e) => `${e.instancePath || "/"} ${e.message}`);
  const pin = (ok: boolean, what: string) => { if (!ok) errs.push(what); };
  const fb = req?.launchProfileSelection?.platformFeeBinding;
  pin(successor, `the Router is not the 24-hour successor ${ROUTER_24H.router} CLI 4.1.5 binds`);
  pin(lp?.profileVersion === PROFILE_VERSION, `profileVersion is not ${PROFILE_VERSION}`);
  pin(fb?.programmableFeeHundredthsOfBip === String(HOOK_FEES.platform), `Programmable's share is not ${HOOK_FEES.platform} (DNAHook.PLATFORM_FEE)`);
  pin(req?.launchProfile?.platformFeePolicy?.programmableFeeHundredthsOfBip === String(HOOK_FEES.platform), "the profile's platform fee policy differs from the binding");
  pin(fb?.accountingMode === "additive-platform-share", "not additive (DNAHook charges the platform fee on top)");
  pin(fb?.claimBinding?.payoutRecipient === PAYOUT, "the platform fee recipient is not Programmable's fixed treasury");
  for (const side of ["buy", "sell"]) {
    const e = fb?.economics?.[side];
    pin(e?.projectHundredthsOfBip === String(HOOK_FEES.baseline), `${side}: project fee is not ${HOOK_FEES.baseline} (DNAHook baseline)`);
    pin(e?.effectiveTotalHundredthsOfBip === String(HOOK_FEES.baseline + HOOK_FEES.platform), `${side}: effective total is not ${HOOK_FEES.baseline + HOOK_FEES.platform} (2.5%)`);
  }
  pin(canonical(req?.launchProfile?.programmableTradeFeePolicy ?? null) === canonical(TRADE_FEE_POLICY), `the routed-trade fee policy is not ${POLICY_VERSION}`);
  // the OpenAPI only states the original Router's 3600 s in prose; the successor (pinned above) allows 86,400 s
  const w = req?.permitWindow, uint = (x: unknown) => typeof x === "string" && /^\d+$/.test(x);
  const life = uint(w?.validAfter) && uint(w?.deadline) ? BigInt(w.deadline) - BigInt(w.validAfter) : -1n;
  pin(life >= 60n && life <= 86_400n, `the permit window is ${life} s, not 60..86400 (PERMIT_WINDOW_S)`);
  return errs;
}

/** GET /v3/capabilities → problems; [] = route A as built is admitted right now. */
export function gateIssues(cap: any): string[] {
  const out: string[] = [];
  if (!cap?.requestProfiles?.freshSubmissionExactVersions?.includes(PROFILE_VERSION)) out.push(`${PROFILE_VERSION} is not a fresh-submission profile (${JSON.stringify(cap?.requestProfiles?.freshSubmissionExactVersions)})`);
  if (cap?.profile?.profileVersion !== PROFILE_VERSION || cap?.profile?.productionLaunchAuthorized !== true) out.push(`the selected production profile is ${cap?.profile?.profileVersion}, not ${PROFILE_VERSION}`);
  if (cap?.programmableTradeFeePolicy?.policyHash !== TRADE_FEE_POLICY_HASH) out.push(`the routed-trade policy hash changed: ${cap?.programmableTradeFeePolicy?.policyHash}`);
  if (canonical(cap?.programmableTradeFeePolicy?.policy ?? null) !== canonical(TRADE_FEE_POLICY)) out.push(`the routed-trade policy is not ${POLICY_VERSION} as vendored`);
  if (cap?.currentTradeFeePolicy?.recipient !== PAYOUT) out.push(`Programmable's fee recipient is ${cap?.currentTradeFeePolicy?.recipient}, PlatformRevenue pays ${PAYOUT}`);
  if (cap?.feePolicy?.programmableHundredthsOfBip !== String(HOOK_FEES.platform)) out.push(`Programmable's share is ${cap?.feePolicy?.programmableHundredthsOfBip}, DNAHook charges ${HOOK_FEES.platform}`);
  if (!cap?.compiler?.admittedBuilds?.includes(SOLC_BUILD)) out.push(`solc ${SOLC_BUILD} is not admitted`);
  if (!(cap?.graph?.maximumTargets >= 4) || cap?.hookPermissions?.allFourteenStructurallySupported !== true) out.push("our 4-target, 14-permission graph is not supported");
  if (cap?.profile36Release?.mandatoryCanonicalFeeVaultTarget !== false) out.push("a canonical fee-vault target became mandatory");
  return out;
}

/** From a packed launch.json: the graph addresses, cross-checked against the literals the hook must carry. */
export function envelopeFromLaunch(req: any, p: Params) {
  const sel = req.launchProfileSelection;
  const key = sel.poolKey;
  if (key.currency0 !== NATIVE) throw new Error("currency0 is not native ETH");
  const hookCtor: string = req.verificationBundle.components.find((c: { targetId: string }) => c.targetId === "hook").constructorArguments;
  const word = (i: number) => `0x${hookCtor.slice(2 + 64 * i + 24, 2 + 64 * (i + 1))}`.toLowerCase();
  const lc = (a: string) => a.toLowerCase();
  const want: [number, string][] = [[0, p.poolManager], [1, key.currency1], [2, p.registry], [3, p.feeVault], [5, p.buybackBurn]];
  for (const [i, a] of want) if (word(i) !== lc(a)) throw new Error(`hook constructor word ${i} = ${word(i)}, expected ${a}: env differs from the pack`);
  if ((BigInt(key.hooks) & 0x3fffn) !== 0x3fffn) throw new Error("hook address lacks the 14 permission bits");
  return {
    chainId: 1, route: "A", launchWallet: req.launchWallet, namespace: sel.routeNamespace, nonce: sel.routeNonce,
    validAfter: Number(req.permitWindow.validAfter), deadline: Number(req.permitWindow.deadline), poolId: sel.expectedPoolId,
    token: key.currency1, hook: key.hooks, platformRevenue: word(4), bootstrap: sel.predictedInitializer,
    safe: p.safe, agent: p.agent, anchorKey: p.anchorKey, postLaunchSalt: p.postLaunchSalt,
    registry: p.registry, feeVault: p.feeVault, buybackBurn: p.buybackBurn, liquidityVault: p.liquidityVault,
  };
}

// ---------------------------------------------------------------------------------------------------- side effects

const sh = (cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? CONTRACTS, input: opts.input, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout || String(r.error)).slice(0, 2000)}`);
  return r.stdout;
};
const sha256 = (b: string | Buffer) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

/** `rpc`: a mainnet RPC, so RouteAParams can check EXCLUDED_WALLETS against the Safe's owners (drafts pass none). */
function params(rpc?: string): Params {
  const out = sh("forge", ["script", "script/Launch.s.sol:RouteAParams", ...(rpc ? ["--rpc-url", rpc] : [])]);
  const line = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{\"agent\""));
  if (!line) throw new Error(`RouteAParams printed no JSON:\n${out.slice(-1000)}`);
  return JSON.parse(line);
}

function solcPath() {
  const svm = [".svm", ".local/share/svm", "Library/Application Support/svm"].map((d) => `${homedir()}/${d}/0.8.26/solc-0.8.26`); // forge's svm dirs
  const p = process.env.SOLC ?? svm.find(existsSync);
  if (!p) throw new Error("solc 0.8.26 not found: run `forge build` once (svm installs it) or set SOLC");
  const v = sh(p, ["--version"]);
  if (!v.includes(`Version: ${SOLC_BUILD}`)) throw new Error(`${p} is not ${SOLC_BUILD}:\n${v}`);
  return { path: p, version: v.trim().split("\n").at(-1)! };
}

/** One Standard JSON for the four targets: forge's verification input per contract, merged (same settings), with only
 *  the project-level remappings and the outputs the packer reads (+ AST to name the immutables). */
function standardJson(ts: ReturnType<typeof targets>) {
  const inputs = ts.map((t) => JSON.parse(sh("forge", ["verify-contract", "0x0000000000000000000000000000000000000001", `${t.file}:${t.name}`, "--show-standard-json-input", "--chain", "1"])));
  const strip = (s: Record<string, unknown>) => JSON.stringify({ ...s, remappings: null, outputSelection: null });
  for (const i of inputs) if (strip(i.settings) !== strip(inputs[0].settings)) throw new Error("forge emitted different settings per target");
  const sources: Record<string, { content: string }> = {};
  for (const i of inputs) Object.assign(sources, i.sources);
  const sorted = Object.fromEntries(Object.keys(sources).sort().map((k) => [k, { content: sources[k].content }]));
  return {
    language: "Solidity",
    sources: sorted,
    settings: {
      ...inputs[0].settings,
      remappings: (inputs[0].settings.remappings as string[]).filter((r) => !r.split("=")[0].includes(":")).sort(),
      outputSelection: { "*": { "*": ["abi", "metadata", "evm.bytecode.object", "evm.bytecode.linkReferences", "evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "evm.deployedBytecode.immutableReferences"], "": ["ast"] } },
    },
  };
}

function immutableNames(output: { sources: Record<string, { ast: unknown }> }) {
  const names = new Map<string, string>();
  const walk = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (n.nodeType === "VariableDeclaration" && n.mutability === "immutable") names.set(String(n.id), n.name);
    for (const v of Object.values(n)) Array.isArray(v) ? v.forEach(walk) : walk(v);
  };
  for (const s of Object.values(output.sources)) walk(s.ast);
  return names;
}

function build() {
  const missing: string[] = [];
  const env = (k: string, placeholder: string) => process.env[k] ?? (missing.push(k), placeholder);
  // forge falls back to rehearsal defaults for these; EXCLUDED_WALLETS (the Safe signers' EOAs) shapes ConvictionVault →
  // GamePot → FeeVault, an address the hook bakes in
  for (const k of ["SAFE", "AGENT", "ANCHOR_KEY", "EXCLUDED_WALLETS"]) if (!process.env[k]) missing.push(k);
  const tokenSrc = readFileSync(`${CONTRACTS}src/DNAToken.sol`, "utf8");
  const description = /\\"description\\":\\"(.*?)\\"/.exec(tokenSrc)?.[1]; // the frozen on-chain tokenURI text
  if (!description) throw new Error("DNAToken.tokenURI description not found");
  const xHandle = /X_HANDLE = "(.*?)";/.exec(tokenSrc)?.[1]; // the frozen tokenURI X link: one place to change
  if (!xHandle) throw new Error("DNAToken.X_HANDLE not found");
  // the stand-in handle is not final: building for real needs an explicit confirmation of the literal
  if (xHandle === "TODO_X_HANDLE") missing.push("DNAToken.X_HANDLE (still the stand-in TODO_X_HANDLE: set the real handle in contracts/src/DNAToken.sol)");
  else if (process.env.X_HANDLE_CONFIRMED !== xHandle) missing.push(`X_HANDLE_CONFIRMED (= DNAToken.X_HANDLE "${xHandle}")`);
  const at = checkedAt(process.env.SOURCE_REVISION ?? "HEAD", process.env.CHECKED_AT); // draft: HEAD's commit time
  const f = {
    launchWallet: env("LAUNCH_WALLET", "0x1111111111111111111111111111111111111111"),
    nonce: env("PROGRAMMABLE_LAUNCH_NONCE", `0x${"00".repeat(31)}01`),
    revision: env("SOURCE_REVISION", "0".repeat(40)),
    // required, no default: the public source of the launch package is the project's pseudonymous org (packConfig
    // refuses a listed identifier in any field but the launch wallet's address)
    publicOrigin: env("PUBLIC_ORIGIN", "https://example.invalid/project-org/dna"),
    xUrl: `https://x.com/${xHandle}`, // must equal the tokenURI's x link (DNAToken.X_HANDLE): no env override
    image: process.env.PROJECT_IMAGE ?? "assets/token.png", // relative to contracts/; same bytes as https://genomedna.xyz/token.png
    imageUri: process.env.IMAGE_URI ?? "https://genomedna.xyz/token.png",
    website: process.env.WEBSITE_URL ?? "https://genomedna.xyz/",
    description,
    fee: process.env.SELECTED_FEE_HUNDREDTHS_OF_BIP ?? String(HOOK_FEES.baseline),
    validAfter: Number(process.env.PERMIT_VALID_AFTER ?? Math.floor(Date.now() / 1000) - 60),
    permitWindowS: permitWindowS(process.env.PERMIT_WINDOW_S),
    checkedAt: at,
  };
  if (!existsSync(`${CONTRACTS}${f.image}`)) missing.push(`image file ${f.image}`);
  const draft = process.env.ROUTE_A_DRAFT === "1";
  if (!draft && !process.env.MAINNET_RPC_URL) missing.push("MAINNET_RPC_URL (EXCLUDED_WALLETS is checked against the Safe's owners on chain)");
  // fail closed: a placeholder shapes the bundle and every address, so only an explicit draft (CI) may proceed
  if (missing.length && !draft) {
    console.error(`route-a: missing ${missing.join(", ")}. Set them (ROUTE_A_DRAFT=1 builds a placeholder draft).`);
    process.exit(1);
  }
  const p = params(draft ? undefined : process.env.MAINNET_RPC_URL);
  const ts = targets(p);
  const solc = solcPath();

  const input = standardJson(ts);
  const inputText = `${JSON.stringify(input)}\n`;
  const output = JSON.parse(sh(solc.path, ["--standard-json"], { input: inputText }));
  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const names = immutableNames(output);
  // SOURCE_SELFDESTRUCT_SURFACE is a hard block on any target: no source in the closure may mention it
  const sd = Object.keys(input.sources).filter((k) => /selfdestruct|suicide\(/i.test(input.sources[k].content));
  if (sd.length) throw new Error(`self-destruct surface in ${sd.join(", ")}`);

  mkdirSync(`${CONTRACTS}${OUT_DIR}/standard-json`, { recursive: true });
  mkdirSync(`${CONTRACTS}${OUT_DIR}/artifacts`, { recursive: true });
  mkdirSync(`${CONTRACTS}${OUT_DIR}/evidence`, { recursive: true });
  writeFileSync(`${CONTRACTS}${OUT_DIR}/standard-json/dna.json`, inputText);

  const imms: Record<string, Imm[]> = {};
  const evidenceTargets: Record<string, unknown> = {};
  for (const t of ts) {
    const c = output.contracts[t.file][t.name];
    const meta = JSON.parse(c.metadata);
    if (meta.compiler.version !== SOLC_BUILD) throw new Error(`${t.name}: compiled by ${meta.compiler.version}`);
    // the same bytes forge builds (and the fork rehearsal + tests ran): run `forge build` first
    const forge = JSON.parse(readFileSync(`${CONTRACTS}out/${t.file.slice(4)}/${t.name}.json`, "utf8"));
    const same = forge.bytecode.object === `0x${c.evm.bytecode.object}` && forge.deployedBytecode.object === `0x${c.evm.deployedBytecode.object}`;
    if (!same) throw new Error(`${t.name}: Standard JSON build differs from forge's out/ (stale out/? run forge build)`);
    imms[t.targetId] = runtimeImmutables(c.evm.deployedBytecode.immutableReferences ?? {}, names, t.imm as Record<string, string | Ref>, t.targetId);
    const artifact = {
      abi: c.abi,
      bytecode: { object: c.evm.bytecode.object, linkReferences: c.evm.bytecode.linkReferences },
      deployedBytecode: { object: c.evm.deployedBytecode.object, linkReferences: c.evm.deployedBytecode.linkReferences, immutableReferences: c.evm.deployedBytecode.immutableReferences },
      metadata: c.metadata,
    };
    writeFileSync(`${CONTRACTS}${OUT_DIR}/artifacts/${t.targetId}.json`, `${JSON.stringify(artifact)}\n`);
    // simplification: scans the whole runtime incl. the CBOR tail; a hit there would be a false positive: inspect, don't bypass
    const ops = opcodeFindings(c.evm.deployedBytecode.object);
    if (ops.includes("CALLCODE") || ops.includes("SELFDESTRUCT")) throw new Error(`${t.name}: hard-block opcode ${ops.join(", ")}`);
    const runtimeBytes = c.evm.deployedBytecode.object.length / 2;
    if (runtimeBytes > 24_576 || c.evm.bytecode.object.length / 2 > 49_152) throw new Error(`${t.name} exceeds the size limits`);
    evidenceTargets[t.targetId] = { contract: `${t.file}:${t.name}`, creationSha256: sha256(Buffer.from(c.evm.bytecode.object, "hex")), runtimeBytes, forgeArtifactMatch: true, immutables: imms[t.targetId].length, runtimeOpcodeFindings: ops };
  }

  const evidence = {
    schemaVersion: "dna.route-a-build-evidence.v1",
    checkedAt: at,
    compiler: solc.version,
    standardJsonSha256: sha256(inputText),
    sources: Object.keys(input.sources).length,
    settings: { ...input.settings, outputSelection: undefined, remappings: input.settings.remappings },
    targets: evidenceTargets,
    params: p,
    tests: "contracts: forge test (incl. fork Launch/UniversalRouter/Rehearsal suites) green on this commit; see the PR CI",
  };
  writeFileSync(`${CONTRACTS}${OUT_DIR}/evidence/dna-build.json`, `${JSON.stringify(evidence, null, 2)}\n`);

  // a placeholder draft (CI: launch values missing) has nothing to check: without the secret list, an inert one. A
  // draft run with every real value still needs the list
  const config = packConfig(p, f, imms, draft && missing.length && !PERSONAL_SHA256.size ? new Set(["draft"]) : undefined);
  const errs = validateConfig(config);
  writeFileSync(`${REPO}${CONFIG}`, `${JSON.stringify(config, null, 2)}\n`);
  console.log(JSON.stringify({ config: CONFIG, standardJsonSha256: evidence.standardJsonSha256, sources: evidence.sources, targets: evidenceTargets, schema: errs.length ? errs : "valid (pack-config v3.6)" }, null, 2));
  if (missing.length) console.log(`\nDRAFT — placeholders for: ${missing.join(", ")}. Set them and rerun before pack.`);
  if (errs.length) process.exit(1);
}

function envelope(file: string) {
  if (!process.env.START_BLOCK) throw new Error("set START_BLOCK (a block just before the launch: the indexer backfills from it)");
  // RouteAParams checks EXCLUDED_WALLETS against the Safe's owners on chain: without an RPC it reverts
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc) throw new Error("set MAINNET_RPC_URL (RouteAParams reads the Safe's owners on chain, as in build)");
  const e = { ...envelopeFromLaunch(JSON.parse(readFileSync(file, "utf8")), params(rpc)), startBlock: Number(process.env.START_BLOCK) };
  const out = process.env.ENVELOPE ?? fileURLToPath(new URL("../deployments/1.envelope.json", import.meta.url));
  writeFileSync(out, `${JSON.stringify(e, null, 2)}\n`);
  console.log(JSON.stringify(e, null, 2), `\nwrote ${out}`);
}

async function gate() {
  const res = await fetch("https://api.programmable.market/v3/capabilities", { signal: AbortSignal.timeout(20_000) });
  const cap = await res.json();
  const issues = gateIssues(cap);
  console.log(JSON.stringify({ serverTime: cap.serverTime, current: cap.requestProfiles?.current, fresh: cap.requestProfiles?.freshSubmissionExactVersions, policyHash: cap.programmableTradeFeePolicy?.policyHash, policyVersion: cap.programmableTradeFeePolicy?.policy?.policyVersion, recipient: cap.currentTradeFeePolicy?.recipient, issues }, null, 2));
  if (issues.length) { console.error("STOP: route A as built is not admitted"); process.exit(1); }
}

function check(file: string) {
  const errs = validateRequest(JSON.parse(readFileSync(file, "utf8")));
  console.log(errs.length ? errs.join("\n") : `${file}: valid (OpenAPI v3.6 CustomLaunchCreateRequestV3; 3.6.0, 3000 + 22000 = 25000, v2 policy → ${PAYOUT}, Router ${ROUTER_24H.router})`);
  if (errs.length) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "build" || cmd === undefined) build();
  else if (cmd === "gate") await gate();
  else if (cmd === "check" && arg) check(arg);
  else if (cmd === "envelope" && arg) envelope(arg);
  else throw new Error("usage: node scripts/route-a.ts build | gate | check <launch.json> | envelope <launch.json>");
}
