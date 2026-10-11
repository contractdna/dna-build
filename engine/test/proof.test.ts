// Proof of AI: the compose render (deploy/) agrees with the enclave's env lockdown and dstack's compose hash; the
// verifier's pure checks (report data, RTMR3 replay + event digests, compose binding, signed records, mapper re-run).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getComposeHash } from "@phala/dstack-sdk/get-compose-hash";
import { ContractFunctionExecutionError, ContractFunctionZeroDataError, encodeFunctionData, HttpRequestError, parseAbi, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type Params, registryOf, release, render } from "../scripts/compose.ts";
import { registryAbi } from "../src/abi.ts";
import { ALLOWED_ENVS, envIssues, PROMPT_IDS } from "../src/enclave.ts";
import { encodeOp } from "../src/lib.ts";
import { canonical, chainHash, GENESIS, logDigest } from "../src/log.ts";
import { CODE_DELAY_S, checkCodeDelay, checkCompose, checkTimelockRoles, checkUpgradesDisabled, PRE_LAUNCH_SCRIPT, readFail, ROLES, type RoleLog, roleHolders, UPGRADES_DISABLED, checkEventLog, checkIdentity, checkKeyProvider, checkRecord, eventDigest, logDigestOf, mapperOk, replayRtmr, reportDataOf, sameHex } from "../src/proof.ts";
import { PERSONAL_SHA256 } from "../src/anonymity.ts";
// the guard refuses to run without an identifier list (PERSONAL_IDS, a secret): a synthetic one here
PERSONAL_SHA256.add(createHash("sha256").update("fixtureonlytoken").digest("hex"));

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const K = { agent: `0x${"11".repeat(20)}`, anchor: `0x${"22".repeat(20)}`, logSigner: `0x${"33".repeat(20)}`, funder: `0x${"55".repeat(20)}` };
const P: Params = {
  commit: "a".repeat(40), image: "ghcr.io/project-org/dna-engine", imageDigest: `sha256:${"b".repeat(64)}`, xClientId: "cid", xUserId: "42", policyThresholdsSha256: sha("{}"), studioUrl: "https://studio.example",
  githubRepo: "project-org/game-lab", seqBot: "dna-sequencer[bot]", pagecheckImage: "ghcr.io/project-org/dna-pagecheck", pagecheckDigest: `sha256:${"d".repeat(64)}`,
};
/** The production compose values Phala Cloud was sent for a $0 provision (nothing committed) and the compose hash it
 *  returned: confirmed by Phala Cloud provisions of this template on 2026-10-10, the same on the Ethereum KMS
 *  (kms-eth-prod7, dstack-0.5.8) and Phala's own KMS; our pre-launch script kept as sent and nothing added. */
const PHALA_P: Params = {
  commit: "48021c53a92281b4d6daaf51fa650b1f728bdafe", image: "ghcr.io/contractdna/dna-engine", imageDigest: "sha256:69720bc195ea088fd4a514ac2141425a818f5f991c30112abbf2c3a96c3ecbbb",
  pagecheckImage: "ghcr.io/contractdna/dna-pagecheck", pagecheckDigest: "sha256:13b64b9c2113e9153ff59335b08175668c840f784c90ecd9d6488e4bce3eb814",
  githubRepo: "contractdna/dna", seqBot: "dna-sequencer[bot]", xClientId: "TEST_X_CLIENT_ID", xUserId: "2107869899318018048", studioUrl: "", policyThresholdsSha256: "", xAiRepliesApproved: false, llmLaunchAt: "",
};
const PHALA_HASH = "0d00862f9cb927d39268b9dcc55bfb3ba09bd069bbc629030aeb336c7e246360";
/** The release record P renders to (what the verifiers pin). */
const REL = release(P, render(P).composeHash, null);
/** Compose files that are valid YAML yet run something else (a review's probes and more): each must fail. */
const probes = (yaml: string, img: string): [string, string, RegExp][] => {
  const evil = `evil/x@sha256:${"e".repeat(64)}`;
  const into = (svc: string, line: string) => yaml.replace(`  ${svc}:\n`, `  ${svc}:\n${line}`);
  return [
    ["a flow-mapping extra service", yaml.replace("services:\n", `services:\n  extra: {image: ${evil}}\n`), /services .*: exactly engine, pagecheck, forge/],
    ["image : (a space before the colon)", yaml.replace(`    image: ${img}\n`, `    image : ${evil}\n`), /service engine: image evil/],
    ['a quoted "image" key', yaml.replace(`    image: ${img}\n`, `    "image": ${evil}\n`), /service engine: image evil/],
    ["{build: .}", yaml.replace("services:\n", "services:\n  extra: {build: .}\n"), /service extra: build/],
    ["build : (a space before the colon)", into("forge", "    build : .\n"), /service forge: build/],
    ["extends: engine", into("forge", "    extends: engine\n"), /service forge: extends/],
    ["a merge key from a top-level anchor", `x-b: &b\n  build: .\n${into("forge", "    <<: *b\n")}`, /service forge: build/],
    ["a top-level key the template does not use", `${yaml}include:\n  - other.yml\n`, /top-level key include/],
    ["a duplicate image key", into("engine", `    image: ${evil}\n`), /not valid YAML/],
    ["not YAML", "services: [", /not valid YAML/],
    ["the engine image swapped while its digest runs elsewhere", yaml.replace(`    image: ${img}\n`, `    image: ghcr.io/other/engine@${img.split("@")[1]}\n`), /service engine: image ghcr\.io\/other\/engine@/],
    ["an extra service on the released image", yaml.replace("services:\n", `services:\n  extra:\n    image: ${img}\n`), /exactly engine, pagecheck, forge/],
  ];
};
/** Phala's own KMS's CA public key (DER hex), the key provider of the 2026-10-10 test boot. */
const PHALA_KMS_CA = "3059301306072a8648ce3d020106082a8648ce3d030107034200048844eb42ccdf8c52fd4f174f362fcb9bbd19c45fd48f1edec2d8f1ca23536ec1a74021b4cee610c074f8294d431b2b7fee2c39e5333fdaf0a4522d43fb159d9f";
/** The shape of Phala Cloud's default pre-launch script (what it puts in when ours is missing). */
const PHALA_DEFAULT = "#!/bin/bash\necho \"Phala Cloud Pre-Launch Script v0.0.21\"\ndocker login\necho \"$KEY\" >> /root/.ssh/authorized_keys\n";
/** One service's block of the rendered compose (its lines up to the next service or top-level key). */
const service = (yaml: string, name: string) => yaml.match(new RegExp(`^  ${name}:\\n((?: {4}.*\\n|\\n)*)`, "m"))?.[1] ?? "";

test("compose: deterministic JSON whose sha256 is dstack's compose hash; image pinned by digest; allowed_envs = the lockdown's", () => {
  const { appCompose, composeHash, yaml } = render(P);
  assert.equal(sha(appCompose), composeHash, "the file's bytes are what is hashed");
  assert.equal(getComposeHash(JSON.parse(appCompose)), composeHash);
  assert.equal(render(P).composeHash, composeHash, "stable");
  assert.ok(yaml.includes(`image: ${P.image}@${P.imageDigest}`));
  assert.deepEqual(JSON.parse(appCompose).allowed_envs, [...ALLOWED_ENVS]);
  assert.equal(JSON.parse(appCompose).pre_launch_script, PRE_LAUNCH_SCRIPT, "DNA's measured no-op, so Phala Cloud puts in none of its own");
  assert.notEqual(render({ ...P, xUserId: "43" }).composeHash, composeHash, "a literal is part of the hash");
  assert.deepEqual(checkCompose(appCompose, composeHash, REL), []);
  assert.ok(checkCompose(appCompose, composeHash, { ...REL, imageDigest: `sha256:${"c".repeat(64)}` }).some((i) => /service engine: image .* is not the released digest/.test(i)));
  assert.ok(checkCompose(appCompose.replace("dna-engine", "dna-engin3"), composeHash, REL).some((i) => /not the compose hash/.test(i)));
});

test("compose: Phala Cloud's provision fields are in the template, so our hash is the one Phala computes for it", () => {
  const t = JSON.parse(readFileSync(new URL("../../deploy/app-compose.template.json", import.meta.url), "utf8"));
  assert.deepEqual(t.features, ["kms", "tproxy-net"]);
  assert.equal(t.tproxy_enabled, true);
  assert.equal(t.local_key_provider_enabled, false);
  assert.ok(!("key_provider" in t) && !("key_provider_id" in t), "with them Phala's VMM writes an MRCONFIGID v3 the 0.5.8 guest refuses at boot");
  assert.equal(t.pre_launch_script, PRE_LAUNCH_SCRIPT, "the measured no-op, as a literal in the template");
  assert.doesNotMatch(PRE_LAUNCH_SCRIPT, /\bexit\b|login|passwd|ssh|curl|wget|user.config/i, "dstack sources it before compose up: it must not exit, fetch or open a shell");
  // the production compose (the values Phala Cloud was sent), provisioned at $0, nothing committed
  assert.equal(render(PHALA_P).composeHash, PHALA_HASH, "the template changed: re-provision on Phala Cloud and paste the hash it returns (the launch hash check)");
});

test("compose: every image a released digest, no build, only DNA's pre-launch script; SSH, other scripts, a local key provider or other envs fail", () => {
  const { appCompose, composeHash } = render(P);
  const app = JSON.parse(appCompose);
  const recheck = (o: Record<string, unknown>) => { const s = canonical(o); return checkCompose(s, sha(s), REL); };
  const yaml = String(app.docker_compose_file);
  assert.deepEqual(recheck(app), []);
  // what runs, from the parsed compose: exactly engine, pagecheck and forge, each on its released image@digest, no build
  for (const [what, y, re] of probes(yaml, `${P.image}@${P.imageDigest}`)) {
    assert.notEqual(y, yaml, what);
    const issues = recheck({ ...app, docker_compose_file: y });
    assert.ok(issues.some((i) => re.test(i)), `${what}: ${issues.join("; ")}`);
  }
  assert.ok(recheck({ ...app, allowed_envs: [...ALLOWED_ENVS, "EXTRA"] }).some((i) => /allowed_envs/.test(i)));
  // twins: the browser's rules are the CLI's, byte for byte
  const block = (f: string) => { const t = readFileSync(new URL(f, import.meta.url), "utf8"); return t.slice(t.indexOf("/** The measured pre-launch script"), t.indexOf("/** The compose file the quote names")); };
  assert.ok(block("../src/proof.ts").length > 1000);
  assert.equal(block("../../web/app/proof/verify.ts"), block("../src/proof.ts"));
  assert.ok(recheck({ ...app, pre_launch_script: PHALA_DEFAULT }).some((i) => /Phala's default/.test(i)), "Phala Cloud's own script");
  assert.ok(recheck({ ...app, pre_launch_script: PHALA_DEFAULT }).some((i) => /SSH/.test(i)));
  assert.ok(recheck({ ...app, pre_launch_script: `${PRE_LAUNCH_SCRIPT} ` }).some((i) => /not DNA's no-op/.test(i)), "byte-equal only");
  assert.ok(recheck({ ...app, pre_launch_script: undefined }).some((i) => /no pre-launch script/.test(i)), "none: Phala Cloud's own goes in");
  assert.ok(recheck({ ...app, pre_launch_script: "" }).some((i) => /no pre-launch script/.test(i)));
  assert.ok(recheck({ ...app, docker_compose_file: `${yaml}  shell:\n    image: ${P.image}@${P.imageDigest}\n    command: sshd -D\n` }).some((i) => /SSH/.test(i)), "the SSH tripwire");
  const escaped = canonical(app).replace(/}$/, ',"zz":"s\\u0073hd -D"}'); // JSON-escaped: only the parsed compose shows it
  assert.ok(!/sshd/.test(escaped));
  assert.ok(checkCompose(escaped, sha(escaped), REL).some((i) => /SSH/.test(i)), "a JSON-escaped sshd");
  assert.ok(recheck({ ...app, init_script: "echo" }).some((i) => /init_script/.test(i)));
  assert.ok(recheck({ ...app, bash_script: "echo" }).some((i) => /bash_script/.test(i)));
  assert.ok(recheck({ ...app, local_key_provider_enabled: true }).some((i) => /KMS/.test(i)));
  assert.ok(recheck({ ...app, key_provider: "local" }).some((i) => /KMS/.test(i)));
  assert.deepEqual(recheck({ ...app, key_provider: "kms" }), [], "the verifiers accept a kms key_provider (compose.ts leaves it out)");
  assert.ok(recheck({ ...app, kms_enabled: false }).some((i) => /KMS/.test(i)));
  // compose.ts refuses a template without ours or with any other script, and one without the KMS's key
  const tpl = readFileSync(new URL("../../deploy/app-compose.template.json", import.meta.url), "utf8");
  const set = (k: string, v?: unknown) => { const o = JSON.parse(tpl); if (v === undefined) delete o[k]; else o[k] = v; return JSON.stringify(o); };
  assert.throws(() => render(P, set("pre_launch_script")), /pre_launch_script/);
  assert.throws(() => render(P, set("pre_launch_script", "")), /pre_launch_script/);
  assert.throws(() => render(P, set("pre_launch_script", PHALA_DEFAULT)), /pre_launch_script/);
  assert.throws(() => render(P, set("key_provider_id", "3059")), /key_provider_id: leave it out/);
  assert.throws(() => render(P, set("key_provider", "kms")), /key_provider: leave it out/);
  assert.throws(() => render(P, set("init_script", "echo")), /init_script/);
  assert.equal(render(P).composeHash, composeHash);
});

test("compose ↔ lockdown: the rendered container env (literals + every allowed env set) passes envIssues", () => {
  const { yaml } = render(P);
  const env: Record<string, string> = { PATH: "/usr/bin", HOME: "/root", HOSTNAME: "h", NODE_VERSION: "24" };
  for (const [, k, v] of yaml.matchAll(/^ {6}(\w+): "(.*)"$/gm)) env[k] = v;
  for (const [, k] of yaml.matchAll(/^ {6}(\w+): \$\{\w+\}$/gm)) env[k] = ({ ENGINE_MODE: "dry_run", POLICY_THRESHOLDS: "{}", TELEGRAM_GROUP_ID: "-1", TELEGRAM_ALLOWED_USER_IDS: "1,2", DNA_PERSONA: Buffer.from(`# Charter\nc\n# Voice\nv\n${PROMPT_IDS.map((id) => `# Prompt ${id}\np\n`).join("")}`).toString("base64") } as Record<string, string>)[k] ?? "x";
  env.SEQ_SOLC = "/usr/local/bin/solc"; // set by the image (engine/Dockerfile)
  assert.deepEqual(envIssues(env), []);
  assert.ok(envIssues({ ...env, POLICY_THRESHOLDS: '{"KILL_MIN_RETENTION":0}' }).some((i) => /does not hash/.test(i)), "thresholds swapped at runtime");
});

test("compose: refuses unfilled launch values, a tag instead of a digest, a bad commit", () => {
  assert.throws(() => render({ ...P, xClientId: "TODO" }), /X_CLIENT_ID: not filled/);
  // the signers' Telegram group and user ids and the persona are private: sealed allowed envs, never literals in the public compose
  for (const k of ["TELEGRAM_GROUP_ID", "TELEGRAM_ALLOWED_USER_IDS", "DNA_PERSONA"]) assert.match(render(P).yaml, new RegExp(`^ {6}${k}: \\$\\{${k}\\}$`, "m"), k);
  // post media: the studio URL and the end of the image-approval period are measured literals
  assert.throws(() => render({ ...P, studioUrl: "http://studio.example" }), /studioUrl/);
  assert.match(render({ ...P, studioUrl: "" }).yaml, /STUDIO_URL: ""/, "no studio: plates at once");
  assert.match(render(P).yaml, /STUDIO_TOKEN: \$\{STUDIO_TOKEN\}/, "the studio token is a sealed allowed env");
  // the LLM spend schedule's launch time: a measured literal, empty = no week-1 allowance
  assert.match(render(P).yaml, /LLM_LAUNCH_AT: ""/);
  // X's approval of AI replies is a measured literal: off ("") unless the launch values say X approved
  assert.match(render(P).yaml, /X_AI_REPLIES_APPROVED: ""/);
  assert.match(render({ ...P, xAiRepliesApproved: true }).yaml, /X_AI_REPLIES_APPROVED: "1"/);
  assert.match(render({ ...P, llmLaunchAt: "2026-10-10T12:00:00Z" }).yaml, /LLM_LAUNCH_AT: "2026-10-10T12:00:00Z"/);
  assert.throws(() => render({ ...P, llmLaunchAt: "soon" }), /llmLaunchAt/);
  assert.throws(() => render({ ...P, llmLaunchAt: "2026-10-10T12:00:00" }), /Z or an explicit offset/, "no zone: local time");
  assert.throws(() => render({ ...P, llmLaunchAt: "2026-10-10" }), /llmLaunchAt/);
  assert.match(render({ ...P, llmLaunchAt: "2026-10-10T14:00:00+02:00" }).yaml, /LLM_LAUNCH_AT: "2026-10-10T14:00:00\+02:00"/);
  const y = render(P).yaml;
  assert.match(y, /STUDIO_URL: "https:\/\/studio\.example"/);
  assert.doesNotMatch(y, /MEDIA_APPROVAL/, "images post on their own once every check passes: no approval window");
  assert.throws(() => render({ ...P, imageDigest: "latest" }), /imageDigest/);
  assert.throws(() => render({ ...P, commit: "main" }), /commit/);
  assert.throws(() => render({ ...P, xClientId: 'a"b' }), /X_CLIENT_ID/);
  assert.throws(() => render(P, undefined, "services:\n  e:\n    environment:\n      ROGUE: \"1\"\n"), /ROGUE is not a compose literal/);
});

test("compose: the Sequencer's repository and bot are measured literals; its GitHub token is a sealed allowed env", () => {
  const y = render(P).yaml;
  assert.match(y, /^ {6}GITHUB_REPO: "project-org\/game-lab"$/m);
  assert.match(y, /^ {6}SEQ_BOT: "dna-sequencer\[bot\]"$/m);
  assert.match(y, /^ {6}GITHUB_TOKEN: \$\{GITHUB_TOKEN\}$/m);
  assert.notEqual(render({ ...P, githubRepo: "project-org/other" }).composeHash, render(P).composeHash, "another repository is another compose hash");
  assert.throws(() => render({ ...P, githubRepo: "TODO" }), /githubRepo/);
  assert.throws(() => render({ ...P, githubRepo: "https://github.com/x/y" }), /githubRepo/);
  assert.throws(() => render({ ...P, seqBot: "someone" }), /seqBot/);
});

test("compose: untrusted code runs beside the engine, never with it: the page check and forge get no secret, no dstack socket and no egress", () => {
  const y = render(P).yaml;
  const engine = service(y, "engine");
  const pc = service(y, "pagecheck");
  const forge = service(y, "forge");
  assert.ok(engine && pc && forge, "three services");
  // the page check: its own image, pinned; only the internal network shared with the engine
  assert.match(pc, new RegExp(`^ {4}image: ${P.pagecheckImage}@${P.pagecheckDigest}$`, "m"));
  assert.match(pc, /^ {4}networks:\n {6}- checks\n/m);
  assert.match(y, /^networks:\n {2}checks:\n {4}internal: true$/m, "no route out of the checks network");
  // forge and anvil (the gates' untrusted tests): the engine's own image, a network namespace with nothing but loopback
  assert.match(forge, new RegExp(`^ {4}image: ${P.image}@${P.imageDigest}$`, "m"));
  assert.match(forge, /^ {4}network_mode: none$/m);
  assert.match(forge, /^ {4}command: \["node", "src\/sandbox\.ts"\]$/m);
  for (const [name, svc] of [["pagecheck", pc], ["forge", forge]] as const) {
    assert.doesNotMatch(svc, /environment:/, `${name}: no environment (no secret can reach it)`);
    assert.doesNotMatch(svc, /dstack\.sock/, `${name}: no dstack socket (no key)`);
    assert.doesNotMatch(svc, /ports:/, `${name}: nothing published`);
    assert.match(svc, /^ {4}read_only: true$/m, name);
    assert.match(svc, /^ {4}cap_drop:\n {6}- ALL$/m, name);
    assert.match(svc, /^ {6}- no-new-privileges:true$/m, name);
    assert.match(svc, /^ {4}mem_limit: \d+g$/m, name);
    assert.match(svc, /^ {4}pids_limit: \d+$/m, name);
  }
  // the engine reaches both: the checks network, and the work volume forge reads and writes
  assert.match(engine, /^ {6}- checks$/m);
  assert.match(engine, /^ {6}- default$/m);
  assert.match(engine, /^ {6}- seq-work:\/work$/m);
  assert.match(forge, /^ {6}- seq-work:\/work$/m);
  assert.doesNotMatch(pc, /seq-work|dna-data/, "the page check shares no volume");
  assert.throws(() => render({ ...P, pagecheckDigest: "latest" }), /pagecheckDigest/);
  assert.notEqual(render({ ...P, pagecheckDigest: `sha256:${"e".repeat(64)}` }).composeHash, render(P).composeHash, "the page check's image is measured too");
});

test("verifier: app-id = the released DstackApp, OS image = the pinned one (quote and app info), a missing app_compose fails", () => {
  const app = `0x${"ab".repeat(20)}`;
  const os = "0f".repeat(32);
  const ev = { appId: "ab".repeat(20), osImageHash: os };
  assert.deepEqual(checkIdentity(ev, { appId: "ab".repeat(20), osImageHash: os }, { dstackApp: app, osImageHash: `0x${os}` }), []);
  assert.deepEqual(checkIdentity(ev, {}, { dstackApp: null, osImageHash: null }), [], "pre-launch: nothing pinned");
  assert.ok(checkIdentity({ ...ev, appId: "cd".repeat(20) }, {}, { dstackApp: app, osImageHash: null }).some((i) => /not the released DstackApp/.test(i)));
  assert.ok(checkIdentity({ ...ev, osImageHash: "11".repeat(32) }, { osImageHash: os }, { dstackApp: null, osImageHash: os }).some((i) => /OS image/.test(i)), "the quote's OS image event");
  assert.ok(checkIdentity(ev, { osImageHash: "11".repeat(32) }, { dstackApp: null, osImageHash: os }).some((i) => /OS image/.test(i)), "the app's reported OS image");
  assert.ok(checkIdentity({ appId: null, osImageHash: null }, {}, { dstackApp: app, osImageHash: os }).length === 2, "missing events fail once pinned");
  assert.deepEqual(checkCompose(null, "00".repeat(32), REL), ["the app does not publish its app_compose (public_tcbinfo)"]);
  assert.ok(sameHex("0xAB", "ab") && !sameHex(null, null) && !sameHex("ab", "0xac"));
});

test("verifier: the DstackApp's owner is a timelock of at least 1 h; shorter or no timelock fails", () => {
  assert.equal(CODE_DELAY_S, 3600);
  assert.deepEqual(checkCodeDelay(3600n), []);
  assert.deepEqual(checkCodeDelay(86_400n), [], "longer is fine");
  assert.match(checkCodeDelay(3599n).join(), /shorter than 3600 s/);
  assert.match(checkCodeDelay(0n).join(), /shorter/);
  // no getMinDelay at the owner (an EOA, or a contract without it) vs the RPC failing: the line says which
  const noCode = readFail(new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: "getMinDelay" }), { abi: parseAbi(["function getMinDelay() view returns (uint256)"]), functionName: "getMinDelay" }));
  assert.ok(noCode.reverted);
  assert.match(checkCodeDelay(noCode).join(), /not a timelock/);
  const rpc = readFail(new HttpRequestError({ url: "https://rpc.example", status: 503, details: "Service Unavailable" }));
  assert.ok(!rpc.reverted);
  assert.match(checkCodeDelay(rpc).join(), /could not be read \(RPC error: HTTP request failed/);
  assert.doesNotMatch(checkCodeDelay(rpc).join(), /not a timelock/);
  assert.equal(readFail("boom").message, "boom");
});

test("verifier: upgrades disabled = only DstackApp's own revert passes", () => {
  assert.deepEqual(checkUpgradesDisabled({ fail: true, reverted: true, message: `The contract function "upgradeToAndCall" reverted with the following reason: ${UPGRADES_DISABLED}` }), []);
  assert.match(checkUpgradesDisabled(null).join(), /would go through/);
  assert.match(checkUpgradesDisabled({ fail: true, reverted: true, message: "OwnableUnauthorizedAccount" }).join(), /another reason/);
  assert.match(checkUpgradesDisabled({ fail: true, reverted: false, message: "timeout" }).join(), /RPC error: timeout/);
});

test("verifier: timelock roles from the role history (Safe alone proposes and cancels, open execution, admin renounced)", () => {
  const TL = `0x${"71".repeat(20)}`, SAFE = `0x${"5a".repeat(20)}`, EOA = `0x${"ee".repeat(20)}`;
  let i = 0;
  const g = (role: string, account: string, eventName: RoleLog["eventName"] = "RoleGranted"): RoleLog => ({ eventName, role, account, blockNumber: 10n, logIndex: i++ });
  // OZ TimelockController(minDelay, [Safe], [address(0)], admin = EOA) then the EOA renounces: what the deploy does
  const deployed = [g(ROLES.admin, TL), g(ROLES.admin, EOA), g(ROLES.proposer, SAFE), g(ROLES.canceller, SAFE), g(ROLES.executor, zeroAddress)];
  assert.match(checkTimelockRoles(deployed, TL, SAFE).join(), /DEFAULT_ADMIN_ROLE is held by 0xeeee/, "the EOA admin not yet renounced");
  const good = [...deployed, g(ROLES.admin, EOA, "RoleRevoked")];
  assert.deepEqual(checkTimelockRoles(good, TL, SAFE.toUpperCase().replace("0X", "0x")), []);
  assert.deepEqual(checkTimelockRoles([...good].reverse(), TL, SAFE), [], "replayed in chain order, whatever the input order");
  assert.deepEqual(roleHolders(good, ROLES.admin), [TL]);
  assert.match(checkTimelockRoles([...good, g(ROLES.proposer, EOA)], TL, SAFE).join(), /PROPOSER_ROLE must be held by the Safe alone/);
  assert.match(checkTimelockRoles([...good, g(ROLES.canceller, SAFE, "RoleRevoked")], TL, SAFE).join(), /CANCELLER_ROLE .*nobody/);
  assert.match(checkTimelockRoles(good.filter((l) => l.role !== ROLES.executor), TL, SAFE).join(), /execution is not open/);
  assert.match(checkTimelockRoles([...good, g(ROLES.admin, SAFE)], TL, SAFE).join(), /DEFAULT_ADMIN_ROLE is held by 0x5a5a/, "not even the Safe");
});

test("release record: the registry comes from the committed deployment (null while a placeholder)", () => {
  assert.equal(registryOf({ registry: `0x${"00".repeat(20)}`, startBlock: 0 }), null);
  assert.deepEqual(registryOf({ registry: "0x1234567890123456789012345678901234567890", startBlock: 7 }), { address: "0x1234567890123456789012345678901234567890", startBlock: 7 });
  assert.equal(release(P, "h", null).registry, null);
});

test("release record: the web copy is the deploy copy", () => {
  const root = new URL("../../", import.meta.url);
  assert.equal(readFileSync(new URL("web/app/proof/release.json", root), "utf8"), readFileSync(new URL("deploy/release.json", root), "utf8"));
  assert.deepEqual(Object.keys(release(P, "h")).sort(), Object.keys(JSON.parse(readFileSync(new URL("deploy/release.json", root), "utf8"))).sort());
});

test("verifier vectors (web/test/proof.test.mjs pins the browser checks to the same values)", () => {
  assert.equal(reportDataOf("0xab", "cd", K), "d787c7dbf04a147cb29f8c929b8015e2c49a8ba3f4acc6a8d6db4ba221b9d1e0");
  assert.equal(logDigestOf("ab".repeat(32), "anchor", "op:SetCanary"), "568fe8a08a11aa47a97d44c5118ffec96997f201718d74d9413157754279343b");
  assert.equal(logDigestOf("ab".repeat(32), "anchor", "op:SetCanary"), logDigest("ab".repeat(32), "anchor", "op:SetCanary"), "the verifier's digest is what the engine signs");
  assert.equal(logDigestOf("ab".repeat(32), "alert", null), logDigest("ab".repeat(32), "alert", null));
  const ed = eventDigest("compose-hash", "cd".repeat(32));
  assert.equal(ed, "bb4ea86a437a0a3caf984ed4ef2b8220cde9d6504efe3fbc1e1e5d0cb805aa98bcd45567b84bf0a550420198d0828968");
  assert.equal(replayRtmr([eventDigest("app-id", "ab".repeat(20)), ed]), "7977ac1dfe253cf1bf4582615c01a87a28d8e36933f09f2dab4e47e99bcadf2396eb3fca00766359aee75ee60ef766e4");
  const q = encodeOp("SetCanary", ["0x00000000000000000000000000000000000000a1", 1234n, 600, 100]);
  assert.equal(encodeFunctionData({ abi: registryAbi, functionName: "queue", args: [q.op, q.data] }).slice(0, 10), "0xac7d0ce5");
});

test("verifier: a real Phala quote's event log (2026-10-10, dstack-0.5.8): digests left out are computed, it replays to RTMR3", () => {
  const f = JSON.parse(readFileSync(new URL("./fixtures/phala-eventlog-2026-10-10.json", import.meta.url), "utf8"));
  assert.ok(f.eventLog.length === 10 && f.eventLog.every((e: { digest: string }) => e.digest === ""), "the guest agent sends no digests");
  const ev = checkEventLog(f.eventLog, f.rtmr3);
  assert.deepEqual(ev.issues, []);
  assert.equal(ev.composeHash, f.composeHash);
  assert.equal(ev.osImageHash, f.osImageHash);
  assert.ok(f.osImageHash.startsWith("6427f4f5"), "dstack-0.5.8, allowed by the KmsAuth");
  assert.ok(checkEventLog(f.eventLog, "00".repeat(48)).issues.some((i) => /does not replay/.test(i)));
  const forged = f.eventLog.map((e: { event: string }) => (e.event === "compose-hash" ? { ...e, event_payload: "ee".repeat(32) } : e));
  assert.ok(checkEventLog(forged, f.rtmr3).issues.some((i) => /does not replay/.test(i)), "a swapped payload no longer replays");
  // that test CVM ran on Phala's own KMS: the released (Ethereum) KMS fails it, Phala's KMS CA passes
  assert.ok(checkKeyProvider(ev.keyProvider, REL.kmsKeyProvider).some((i) => /is not the released KMS/.test(i)));
  assert.deepEqual(checkKeyProvider(ev.keyProvider, PHALA_KMS_CA), []);
  assert.deepEqual(checkKeyProvider(ev.keyProvider, null), [], "not pinned");
  assert.ok(checkKeyProvider(null, REL.kmsKeyProvider).some((i) => /no key-provider event/.test(i)));
  assert.ok(checkKeyProvider("zz", REL.kmsKeyProvider).length === 1, "garbage fails, never throws");
});

test("verifier: report data, RTMR3 replay, per-event digests, compose-hash event", () => {
  assert.equal(reportDataOf("0xab", "cd", K), sha(Buffer.from(`abcd${"11".repeat(20)}${"22".repeat(20)}${"33".repeat(20)}${"55".repeat(20)}`, "hex")));
  assert.notEqual(reportDataOf("0xab", "cd", { ...K, funder: `0x${"66".repeat(20)}` }), reportDataOf("0xab", "cd", K), "the quote binds the funder");
  assert.notEqual(reportDataOf("0xab", "cd", { ...K, logSigner: `0x${"44".repeat(20)}` }), reportDataOf("0xab", "cd", K), "the quote binds the log signer");
  const ev = (event: string, payload: string) => ({ imr: 3, event_type: 0x08000001, event, event_payload: payload, digest: eventDigest(event, payload) });
  const log = [ev("app-id", "ab".repeat(20)), ev("compose-hash", "cd".repeat(32)), ev("instance-id", "ef".repeat(20)), { imr: 0, digest: "11".repeat(48), event: "", event_payload: "" }];
  const rtmr3 = replayRtmr(log.filter((e) => e.imr === 3).map((e) => e.digest));
  assert.deepEqual(checkEventLog(log, rtmr3), { issues: [], composeHash: "cd".repeat(32), appId: "ab".repeat(20), osImageHash: null, keyProvider: null });
  const forged = log.map((e) => (e.event === "compose-hash" ? { ...e, event_payload: "ee".repeat(32) } : e)); // payload swapped, digest kept
  assert.ok(checkEventLog(forged, rtmr3).issues.some((i) => /compose-hash: digest does not match/.test(i)));
  assert.ok(checkEventLog(log, "00".repeat(48)).issues.some((i) => /does not replay/.test(i)));
  assert.equal(replayRtmr([]), "00".repeat(48));
});

test("verifier: an enclave record (hash + log-key signature over the domain-separated digest) and the mapper re-run", async () => {
  const logKey = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
  const body = '{"kind":"intent"}';
  const ehash = chainHash(GENESIS, body).toString("hex");
  const K = { kind: "anchor", ref: "op:SetCanary" };
  const esig = await logKey.signMessage({ message: { raw: `0x${logDigest(ehash, K.kind, K.ref)}` } });
  assert.deepEqual(await checkRecord({ ...K, body, eprev: GENESIS.toString("hex"), ehash, esig }), { ehashOk: true, signer: logKey.address });
  const bare = await logKey.signMessage({ message: { raw: `0x${ehash}` } }); // a signature over the bare hash is not a record signature
  assert.notEqual((await checkRecord({ ...K, body, eprev: GENESIS.toString("hex"), ehash, esig: bare })).signer, logKey.address);
  assert.notEqual((await checkRecord({ kind: "mode", ref: "override", body, eprev: GENESIS.toString("hex"), ehash, esig })).signer, logKey.address, "a relabelled record does not verify");
  assert.equal((await checkRecord({ ...K, body: '{"kind":"intent!"}', eprev: GENESIS.toString("hex"), ehash, esig })).ehashOk, false);
  assert.deepEqual(await checkRecord({ ...K, body, eprev: null, ehash: null, esig: null }), { ehashOk: false, signer: null });
  const plate = "0x00000000000000000000000000000000000000a1";
  const args = [plate, "1234", 600, 100]; // as the record stores them (bigints → decimal strings)
  const q = encodeOp("SetCanary", [plate, 1234n, 600, 100]);
  const calldata = encodeFunctionData({ abi: registryAbi, functionName: "queue", args: [q.op, q.data] });
  assert.ok(mapperOk({ op: "SetCanary", args, calldata }));
  assert.ok(!mapperOk({ op: "SetCanary", args: [plate, "1234", 600, 101], calldata }), "different args, different calldata");
  assert.ok(!mapperOk({ op: "SetShadow", args: [plate], calldata }));
});
