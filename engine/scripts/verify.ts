// Verify DNA's proof of AI offline, the same checks as the /proof page, against Intel's PCS:
//   node scripts/verify.ts --attestation <https://…/attestation | saved.json> [--rpc <url>] [--log <https://genomedna.xyz>]
//                         [--release ../deploy/release.json] [--records <n>]
//  1. a fresh nonce → the enclave's quote (or a saved one: then the nonce is the saved one, replayable by design)
//  2. the quote verifies against Intel PCS collateral (@phala/dcap-qvl; TCB status printed); report_data =
//     sha256(nonce ‖ logHead ‖ agent ‖ anchor ‖ logSigner ‖ funder); the log signer = the released one
//  3. MRTD / RTMR0–2 = the pinned launch measurements (deploy/release.json); the event log replays to RTMR3, every runtime
//     event's digest matches its payload (computed from it when the guest agent leaves it out), its key-provider event
//     names the released KMS, and its compose-hash = sha256(app_compose) = the released compose hash; the
//     compose's every image is a released image@digest, nothing is built, its pre-launch script is DNA's no-op (Phala's
//     default, with its SSH keys and root password, fails), no init/bash script, keys from the KMS, the released allowed envs
//  4. on-chain (with --rpc): the DstackApp allows that compose hash; its owner is a timelock with minDelay >= 1 h
//     (shorter fails) whose role history leaves only the Safe as proposer and canceller, execution open and no admin
//     but itself; an upgrade from the owner reverts (upgrades disabled); registry.agent() / anchorKey() = the attested keys
//  5. records (with --log and --rpc): the last N Anchored roots are enclave-chain records signed by the log key, each
//     anchor intent's calldata = the public mapper re-run
// Not checked here: OS-image reproduction (build Phala's dstack OS image yourself and compare os_image_hash), and that
// a provider's model wrote any text (no provider signs responses). Exit 1 on any failure.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getCollateralFromPcs, Quote, verify as dcapVerify } from "@phala/dcap-qvl";
import { createPublicClient, http, parseAbi, parseAbiItem, zeroAddress } from "viem";
import { CODE_DELAY_S, checkCodeDelay, checkCompose, COMPOSE_CLAIM, checkKeyProvider, checkTimelockRoles, checkUpgradesDisabled, isFail, PROVIDER_FIELDS, readFail, type RoleLog, checkEventLog, checkIdentity, checkRecord, type Event, mapperOk, reportDataOf, sameHex } from "../src/proof.ts";

const { values: a } = parseArgs({ options: { attestation: { type: "string" }, rpc: { type: "string" }, log: { type: "string" }, release: { type: "string" }, records: { type: "string" } } });
if (!a.attestation) throw new Error("--attestation <url | file> is required");
const release = JSON.parse(readFileSync(a.release ?? new URL("../../deploy/release.json", import.meta.url), "utf8")) as {
  composeHash: string | null; kmsKeyProvider?: string | null; image: string; imageDigest: string | null; pagecheckImage: string; pagecheckDigest: string | null; allowedEnvs: string[] | null; dstackApp: string | null; measurements: Record<string, string> | null; logSigner: string | null; funder?: string | null; kmsAuth: string;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
let failed = 0;
const check = (ok: boolean, what: string, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const note = (what: string) => console.log(`  ·   ${what}`);

// 1. attestation
type Att = { nonce: string; logHead: string; logSeq: string | null; reportData: string; quote: string; eventLog: Event[]; agent: string; anchor: string; logSigner: string; funder: string; info: { composeHash: string; appCompose: string | null; appId: string; osImageHash: string | null } };
let att: Att;
if (/^https?:/.test(a.attestation)) {
  const nonce = randomBytes(32).toString("hex");
  const u = new URL(a.attestation);
  u.searchParams.set("nonce", nonce);
  att = await (await fetch(u)).json() as Att;
  check(att.nonce === nonce, "the quote is fresh (our nonce)");
} else {
  att = JSON.parse(readFileSync(a.attestation, "utf8"));
  note("saved attestation: its nonce is not ours (freshness unchecked)");
}

// 2. quote
const quote = Buffer.from(att.quote.replace(/^0x/, ""), "hex");
try {
  const r = dcapVerify(quote, await getCollateralFromPcs(quote), Date.now() / 1000);
  check(["UpToDate", "SWHardeningNeeded"].includes(r.status), "TDX quote verifies against Intel PCS collateral", `TCB ${r.status}${r.advisory_ids.length ? `, advisories ${r.advisory_ids.join(" ")}` : ""}`);
} catch (e) {
  check(false, "TDX quote verifies against Intel PCS collateral", (e as Error).message);
}
const td = Quote.parse(quote).report;
const body = td.asTd10() ?? td.asTd15()?.base;
if (!body) throw new Error("not a TDX quote");
if (!att.logSigner || !att.agent || !att.anchor || !att.funder) throw new Error("the attestation does not name its agent, anchor, log signer and funder addresses");
check(hex(body.reportData).slice(0, 64) === reportDataOf(att.nonce, att.logHead, att), "report_data = sha256(nonce ‖ logHead ‖ agent ‖ anchor ‖ logSigner ‖ funder)", `log head ${att.logHead.slice(0, 16)}… (seq ${att.logSeq}), log signer ${att.logSigner}`);
if (release.logSigner) check(sameHex(att.logSigner, release.logSigner), "the attested log signer = the released one", release.logSigner);
else note("no log signer in the release file yet (pre-launch)");
if (release.funder) check(sameHex(att.funder, release.funder), "the attested funder = the released one (the Roles member that queues game funds)", release.funder);
else note("no funder in the release file yet (pre-launch)");

// 3. measurements, event log, compose
const m = release.measurements;
if (m) for (const [k, v] of [["mrtd", body.mrTd], ["rtmr0", body.rtMr0], ["rtmr1", body.rtMr1], ["rtmr2", body.rtMr2]] as const) check(hex(v) === m[k].replace(/^0x/, "").toLowerCase(), `${k.toUpperCase()} = the pinned launch value`);
else note("no pinned measurements in the release file yet (pre-launch)");
const ev = checkEventLog(att.eventLog, hex(body.rtMr3));
check(!ev.issues.length, "event log replays to RTMR3, every event digest matches its payload", ev.issues.join("; "));
check(sameHex(ev.composeHash, att.info.composeHash), "the quote's compose-hash event = the app's compose hash", ev.composeHash ?? "none");
const idIssues = checkIdentity(ev, att.info, { dstackApp: release.dstackApp, osImageHash: m?.osImageHash ?? null });
check(!idIssues.length, "the quote's app-id = the released DstackApp; its OS image = the pinned one", idIssues.join("; ") || (release.dstackApp ? "" : "not pinned yet (pre-launch)"));
const kpIssues = checkKeyProvider(ev.keyProvider, release.kmsKeyProvider);
check(!kpIssues.length, "the quote's key-provider event names the released KMS (its CA public key)", kpIssues.join("; ") || (release.kmsKeyProvider ? "" : "not pinned"));
const composeIssues = checkCompose(att.info.appCompose, att.info.composeHash, release);
check(!composeIssues.length, COMPOSE_CLAIM, composeIssues.join("; "));
note(`fields Phala Cloud adds, inside the hash: ${PROVIDER_FIELDS}`);
if (release.composeHash) check(sameHex(att.info.composeHash, release.composeHash), "compose hash = the released one", release.composeHash);

// 4. on-chain
if (a.rpc) {
  const pub = createPublicClient({ transport: http(a.rpc) });
  const d = JSON.parse(readFileSync(new URL("../deployments/1.json", import.meta.url), "utf8")) as { registry: `0x${string}`; safe: `0x${string}`; startBlock: number };
  // a registry with no code (placeholder deployment) or an RPC error is a FAIL line, never a stack trace
  const agent = await pub.readContract({ address: d.registry, abi: parseAbi(["function agent() view returns (address)"]), functionName: "agent" }).catch(readFail);
  check(!isFail(agent) && agent.toLowerCase() === att.agent.toLowerCase(), "registry.agent() = the attested agent key", isFail(agent) ? `${d.registry}: ${agent.message}` : agent);
  const anchorKey = await pub.readContract({ address: d.registry, abi: parseAbi(["function anchorKey() view returns (address)"]), functionName: "anchorKey" }).catch(readFail);
  check(!isFail(anchorKey) && anchorKey.toLowerCase() === att.anchor.toLowerCase(), "registry.anchorKey() = the attested anchor key", isFail(anchorKey) ? `${d.registry}: ${anchorKey.message}` : anchorKey);
  if (release.dstackApp) {
    // every read below fails as a FAIL line naming the revert or the RPC error, never a stack trace
    const app = release.dstackApp as `0x${string}`;
    const ok = await pub.readContract({ address: app, abi: parseAbi(["function allowedComposeHashes(bytes32) view returns (bool)"]), functionName: "allowedComposeHashes", args: [`0x${att.info.composeHash.replace(/^0x/, "")}`] }).catch(readFail);
    check(ok === true, "the DstackApp allows this compose hash (on-chain allow-list)", isFail(ok) ? ok.message : "");
    const owner = await pub.readContract({ address: app, abi: parseAbi(["function owner() view returns (address)"]), functionName: "owner" }).catch(readFail);
    if (isFail(owner)) check(false, "the DstackApp names its owner (owner())", owner.message);
    else {
      const delay = await pub.readContract({ address: owner, abi: parseAbi(["function getMinDelay() view returns (uint256)"]), functionName: "getMinDelay" }).catch(readFail);
      const delayIssues = checkCodeDelay(delay);
      check(!delayIssues.length, `code changes wait in public: the DstackApp's owner is a timelock with minDelay >= ${CODE_DELAY_S} s`, delayIssues.join("; ") || `owner ${owner}, minDelay ${delay} s`);
      // upgrades disabled: an upgrade simulated from the owner must hit DstackApp's "permanently disabled" revert
      const up = await pub.simulateContract({ address: app, abi: parseAbi(["function upgradeToAndCall(address newImplementation, bytes data) payable"]), functionName: "upgradeToAndCall", args: [zeroAddress, "0x"], account: owner }).then(() => null, readFail);
      const upIssues = checkUpgradesDisabled(up);
      check(!upIssues.length, "the DstackApp cannot be upgraded (an upgrade from its owner reverts: upgrades permanently disabled)", upIssues.join("; "));
      if (!isFail(delay)) {
        if (/^0x0+$/.test(d.safe)) note("no Safe in the deployment file yet (pre-launch): timelock roles unchecked");
        else {
          // the full role history (the RPC must serve an address-filtered eth_getLogs from block 0)
          const roleLogs = await pub.getLogs({ address: owner, fromBlock: 0n, events: parseAbi([
            "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
            "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
          ]) }).then((ls) => ls.map((l): RoleLog => ({ eventName: l.eventName, role: l.args.role!, account: l.args.account!, blockNumber: l.blockNumber, logIndex: l.logIndex })), readFail);
          const roleIssues = isFail(roleLogs) ? [`role history could not be read (RPC error: ${roleLogs.message})`] : checkTimelockRoles(roleLogs, owner, d.safe);
          check(!roleIssues.length, "timelock roles: only the Safe proposes and cancels, anyone executes, no admin but the timelock itself", roleIssues.join("; ") || `Safe ${d.safe}`);
        }
      }
    }
  } else note("no DstackApp address in the release file yet (pre-launch)");
  if (att.info.osImageHash) {
    const ok = await pub.readContract({ address: release.kmsAuth as `0x${string}`, abi: parseAbi(["function allowedOsImages(bytes32) view returns (bool)"]), functionName: "allowedOsImages", args: [`0x${att.info.osImageHash.replace(/^0x/, "")}`] }).catch(readFail);
    check(ok === true, "Phala's KmsAuth allows this OS image", isFail(ok) ? `${att.info.osImageHash}: ${ok.message}` : att.info.osImageHash);
  } else check(false, "the app names its OS image hash");

  // 5. records behind the anchored roots
  if (a.log) {
    const logs = await pub.getLogs({ address: d.registry, event: parseAbiItem("event Anchored(bytes32 indexed root, string uri)"), fromBlock: BigInt(d.startBlock) }).catch(readFail);
    if (isFail(logs)) check(false, "the registry's Anchored events can be read", logs.message);
    for (const l of isFail(logs) ? [] : logs.slice(-Number(a.records ?? 5))) {
      const uri = l.args.uri!;
      const seq = uri.match(/\/api\/log\/(\d+)$/)?.[1];
      if (!seq) { note(`anchor ${l.args.root} → ${uri} (a daily head; check /api/log/<day> with scripts/verify-log.ts)`); continue; }
      // a log server that is down or answers garbage is a FAIL line for that record, never a stack trace
      const r = await fetch(`${a.log}/api/log/${seq}`).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { body: string; eprev: string; ehash: string; esig: string; kind: string; ref: string | null };
      }).catch(readFail);
      if (isFail(r)) { check(false, `anchored record #${seq} can be fetched from ${a.log}`, r.message); continue; }
      const c = await checkRecord(r).catch(() => ({ ehashOk: false, signer: null })); // a malformed record fails, never throws
      check(c.ehashOk && r.ehash === l.args.root && c.signer?.toLowerCase() === att.logSigner.toLowerCase(), `anchored record #${seq}: hash = root, signed by the attested log key`);
      let doc: Parameters<typeof mapperOk>[0] & { kind?: unknown; fn?: unknown };
      try { doc = JSON.parse(r.body); } catch { check(false, `record #${seq}: its body is JSON`); continue; }
      if (r.kind === "anchor" && doc.kind === "intent" && doc.op) check((() => { try { return mapperOk(doc); } catch { return false; } })(), `record #${seq}: calldata = mapper(${doc.op}, args)`);
      else if (r.kind === "anchor" && doc.kind === "intent") note(`record #${seq}: a ${doc.fn} call (game board / pot), calldata ${String(doc.calldata).slice(0, 10)}…`);
    }
  }
} else note("no --rpc: on-chain checks skipped");

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
