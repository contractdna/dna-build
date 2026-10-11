// Proof of AI, the checks anyone can run. Pure and dependency-light: scripts/verify.ts (the CLI)
// and the engine's /attestation route share them; web/app/proof/verify.ts is the browser twin (same rules).
//  - report data: the quote binds sha256(nonce ‖ logHead ‖ agent ‖ anchor ‖ logSigner ‖ funder): a quote can't be replayed,
//    names the log head it attests and the four enclave-derived addresses (agent EOA, anchor EOA, log signing key, the
//    Sequencer's funder: the Roles member that may only queue game funds).
//  - RTMR3: replaying the event log's digests must give the quote's RTMR3; each dstack runtime event's digest is
//    sha384(le32(0x08000001) ‖ ":" ‖ event ‖ ":" ‖ payload) (dstack cc-eventlog v1); the compose-hash event names the code.
//  - compose binding: sha256(app_compose) = the compose hash; every image is a released image@digest, no build, DNA's
//    no-op pre-launch script (never Phala's default: SSH keys, root password), no init/bash script, keys from the KMS,
//    the released allowed envs.
//  - records: ehash = sha256(eprev ‖ sha256(body)), esig = EIP-191 over logDigestOf(ehash, kind, ref) recovers to the
//    attested log signer; an anchor intent's calldata is what the public mapper (encodeOp → registry.queue) gives.
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, encodeFunctionData, type Hex, keccak256, recoverMessageAddress, toHex, zeroAddress, zeroHash } from "viem";
import { registryAbi } from "./abi.ts";
import { encodeOp, type OpName } from "./lib.ts";

const hexBytes = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

export type Keys = { agent: string; anchor: string; logSigner: string; funder: string };
/** 32 bytes the quote's report_data starts with (the rest is zero); addresses as their 20 bytes. */
export const reportDataOf = (nonce: string, logHead: string, k: Keys) =>
  sha256(Buffer.concat([hexBytes(nonce), hexBytes(logHead), hexBytes(k.agent), hexBytes(k.anchor), hexBytes(k.logSigner), hexBytes(k.funder)])).toString("hex");
/** What the log key signs for a record (src/log.ts logDigest). */
export const logDigestOf = (ehash: string, kind: string, ref: string | null) =>
  sha256(Buffer.concat([Buffer.from("dna/log/v1"), hexBytes(ehash), sha256(Buffer.from(JSON.stringify([kind, ref])))])).toString("hex"); // = canonical([kind, ref])

export const RUNTIME_EVENT = 0x08000001;
export function eventDigest(event: string, payloadHex: string) {
  const type = Buffer.alloc(4);
  type.writeUInt32LE(RUNTIME_EVENT);
  return createHash("sha384").update(Buffer.concat([type, Buffer.from(":"), Buffer.from(event), Buffer.from(":"), hexBytes(payloadHex ?? "")])).digest("hex");
}
/** RTMR replay (dstack-sdk reply_rtmrs): mr = sha384(mr ‖ digest), from 48 zero bytes. */
export function replayRtmr(digests: string[]) {
  let mr = Buffer.alloc(48);
  for (const d of digests) {
    const b = hexBytes(d);
    mr = createHash("sha384").update(Buffer.concat([mr, b.length < 48 ? Buffer.concat([b, Buffer.alloc(48 - b.length)]) : b])).digest();
  }
  return mr.toString("hex");
}

export type Event = { imr: number; event_type?: number; digest: string; event: string; event_payload: string };
/** The RTMR3 event log against the quote: replay, per-event digests, and what it says about the app. */
export function checkEventLog(log: Event[], rtmr3: string) {
  const issues: string[] = [];
  // dstack's guest agent sends runtime events without their digest: compute it from the payload
  const mine = log.filter((e) => e.imr === 3).map((e) => (e.digest || !e.event ? e : { ...e, digest: eventDigest(e.event, e.event_payload) }));
  if (replayRtmr(mine.map((e) => e.digest)) !== rtmr3.replace(/^0x/, "").toLowerCase()) issues.push("event log does not replay to the quote's RTMR3");
  for (const e of mine) if (e.event && eventDigest(e.event, e.event_payload) !== e.digest.toLowerCase()) issues.push(`event ${e.event}: digest does not match its payload`);
  const payload = (name: string) => mine.find((e) => e.event === name)?.event_payload;
  return { issues, composeHash: payload("compose-hash") ?? null, appId: payload("app-id") ?? null, osImageHash: payload("os-image-hash") ?? null, keyProvider: payload("key-provider") ?? null };
}

/** Hex equality, case and 0x insensitive (null never matches). */
export const sameHex = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.replace(/^0x/, "").toLowerCase() === b.replace(/^0x/, "").toLowerCase();

/** The quote's app-id and OS image (event log) against the attestation's info and the release (null = not pinned yet). */
export function checkIdentity(ev: { appId: string | null; osImageHash: string | null }, info: { appId?: string | null; osImageHash?: string | null }, rel: { dstackApp: string | null; osImageHash: string | null }) {
  const issues: string[] = [];
  if (rel.dstackApp && !sameHex(ev.appId, rel.dstackApp)) issues.push(`the quote's app-id ${ev.appId ?? "(none)"} is not the released DstackApp ${rel.dstackApp}`);
  if (info.appId && !sameHex(ev.appId, info.appId)) issues.push("the quote's app-id is not the app's");
  if (rel.osImageHash && !(sameHex(ev.osImageHash, rel.osImageHash) && sameHex(info.osImageHash, rel.osImageHash))) issues.push(`the OS image (quote ${ev.osImageHash ?? "(none)"}, app ${info.osImageHash ?? "(none)"}) is not the pinned ${rel.osImageHash}`);
  return issues;
}

/** The measured pre-launch script (deploy/app-compose.template.json): a no-op. When it is absent or empty, Phala Cloud
 *  puts its own into the app-compose (a registry login, an image prune, a random root password, SSH keys from the
 *  unmeasured user_config); a non-empty one is kept as sent. dstack sources it before compose up, so it never exits.
 *  From here to checkCompose, engine/src/proof.ts and web/app/proof/verify.ts are byte-identical (a test compares them). */
export const PRE_LAUNCH_SCRIPT = "#!/bin/bash\n# DNA: a no-op on purpose. A non-empty script keeps the provider's default one out of the measured app-compose.\n# Nothing to log in to (the images are public, pinned by digest; compose up pulls them), no root password, no remote shell.\ntrue\n";
/** The fields Phala Cloud adds when it provisions the app, measured like the rest. */
export const PROVIDER_FIELDS = "features [kms, tproxy-net], tproxy_enabled, local_key_provider_enabled false: keys from the KMS, traffic through Phala's gateway (no key_provider_id: the 0.5.x guest refuses the MRCONFIGID v3 it brings)";
/** What checkCompose establishes, as the verifiers print it. */
export const COMPOSE_CLAIM = "sha256(app_compose) = compose hash; the services are exactly engine, pagecheck and forge, each on its released image digest, no build or extends; DNA's pre-launch script, no init/bash script; keys from the KMS; allowed_envs = the released ones";

/** The quote's key-provider event (hex of {"name":"kms","id":<the KMS's CA public key, DER hex>}) against the released
 *  KMS (null = not pinned). The compose names no KMS (no key_provider_id), so this event is what does. */
export function checkKeyProvider(payloadHex: string | null, kmsKeyProvider: string | null | undefined) {
  if (!kmsKeyProvider) return [];
  let kp: { name?: unknown; id?: unknown } = {};
  try { kp = Object(JSON.parse(decodeURIComponent((payloadHex ?? "").replace(/../g, "%$&")))); } catch { /* reported below */ }
  if (kp.name === "kms" && String(kp.id).toLowerCase() === kmsKeyProvider.toLowerCase()) return [];
  return [`the quote's key provider (${payloadHex ? `${String(kp.name)} …${String(kp.id).slice(-16)}` : "no key-provider event"}) is not the released KMS (…${kmsKeyProvider.slice(-16)})`];
}

/** The release record's fields checkCompose pins (deploy/release.json). */
export type ComposeRelease = { image: string; imageDigest: string | null; pagecheckImage: string; pagecheckDigest: string | null; allowedEnvs?: string[] | null };

/** The compose file's services (deploy/docker-compose.template.yml) and which released image each runs; its top-level keys. */
const SERVICES: Record<string, "engine" | "pagecheck"> = { engine: "engine", pagecheck: "pagecheck", forge: "engine" };
const TOP_LEVEL = ["services", "volumes", "networks"];
const isMap = (o: unknown): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o);

/** The compose file, parsed as YAML the way Compose reads it (merge keys resolved, duplicate keys an error): exactly the
 *  engine, pagecheck and forge services, each on its released image@digest; no build or extends anywhere; no top-level
 *  key the template does not use. */
function composeFileIssues(yaml: string, rel: ComposeRelease) {
  let doc: unknown;
  try { doc = parseYaml(yaml, { merge: true, uniqueKeys: true }); } catch (e) { return [`the compose file is not valid YAML (${String((e as Error).message).split("\n")[0]})`]; }
  if (!isMap(doc) || !isMap(doc.services)) return ["the compose file has no services mapping"];
  const issues: string[] = [];
  for (const k of Object.keys(doc)) if (!TOP_LEVEL.includes(k)) issues.push(`top-level key ${k}: not in the template`);
  const names = Object.keys(doc.services);
  if ([...names].sort().join() !== Object.keys(SERVICES).sort().join()) issues.push(`services ${names.join(", ")}: exactly ${Object.keys(SERVICES).join(", ")}`);
  const released = { engine: rel.imageDigest ? `${rel.image}@${rel.imageDigest}` : null, pagecheck: rel.pagecheckDigest ? `${rel.pagecheckImage}@${rel.pagecheckDigest}` : null };
  for (const [name, svc] of Object.entries(doc.services)) {
    if (!isMap(svc)) { issues.push(`service ${name}: not a mapping`); continue; }
    const want = Object.hasOwn(SERVICES, name) ? released[SERVICES[name]] : null;
    if (Object.hasOwn(SERVICES, name) && (!want || svc.image !== want)) issues.push(`service ${name}: image ${String(svc.image)} is not the released digest ${want ?? "(none released)"}`);
    for (const k of ["build", "extends", "<<"]) if (k in svc) issues.push(`service ${name}: ${k} (only released images run)`);
  }
  return issues;
}

/** What the app-compose runs and where its keys come from: composeFileIssues; the pre-launch script is DNA's no-op, byte
 *  for byte (Phala's default, none or any other fails); no init or bash script; keys from the KMS; the released allowed
 *  envs. The SSH words are a tripwire on the parsed app-compose (JSON escapes undone), not the claim. */
function appIssues(app: Record<string, unknown>, rel: ComposeRelease) {
  const issues: string[] = [];
  issues.push(...composeFileIssues(String(app.docker_compose_file ?? ""), rel));
  const pre = app.pre_launch_script;
  if (pre !== PRE_LAUNCH_SCRIPT) issues.push(!pre ? "no pre-launch script: Phala Cloud then puts in its own (registry login, root password, SSH keys)" : /pre-launch script|authorized_keys|docker login/i.test(String(pre)) ? "the pre-launch script is Phala's default (registry login, root password, SSH keys from the unmeasured user_config), not DNA's no-op" : "the pre-launch script is not DNA's no-op");
  for (const k of ["init_script", "bash_script"]) if (k in app) issues.push(`${k}: code outside the pinned images`);
  if (/authorized_keys|sshd|dropbear|ssh-(rsa|ed25519|dss)|ecdsa-sha2/i.test(JSON.stringify(app))) issues.push("the app_compose mentions SSH (authorized_keys, sshd, dropbear or a key)");
  if (app.kms_enabled !== true || app.local_key_provider_enabled === true || (app.key_provider !== undefined && app.key_provider !== "kms")) issues.push("the app's keys do not come from the KMS (kms_enabled, no local key provider, no key_provider but kms)");
  const envs = Array.isArray(app.allowed_envs) ? JSON.stringify([...app.allowed_envs].sort()) : null;
  if (rel.allowedEnvs && envs !== JSON.stringify([...rel.allowedEnvs].sort())) issues.push("allowed_envs are not the released ones");
  return issues;
}

/** The compose file the quote names: hash binding and appIssues against the release. A missing app_compose fails. */
export function checkCompose(appCompose: string | null, composeHash: string, rel: ComposeRelease) {
  if (!appCompose) return ["the app does not publish its app_compose (public_tcbinfo)"];
  const issues: string[] = [];
  if (sha256(Buffer.from(appCompose)).toString("hex") !== composeHash.replace(/^0x/, "").toLowerCase()) issues.push("sha256(app_compose) is not the compose hash");
  let app: Record<string, unknown>;
  try { app = Object(JSON.parse(appCompose)); } catch { return [...issues, "app_compose is not JSON"]; }
  return [...issues, ...appIssues(app, rel)];
}

// ---------------------------------------------------------------- the DstackApp's owner (on-chain, with an RPC)

/** A failed on-chain read. `reverted`: the call reverted or hit no code (the contract lacks that function); otherwise the
 *  RPC itself failed, and `message` says how. */
export type ReadFail = { fail: true; reverted: boolean; message: string };
export function readFail(e: unknown): ReadFail {
  const reverted = e instanceof BaseError && !!e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError);
  // an RPC failure: viem's short message plus its details (status, "fetch failed", the node's error text)
  const msg = e instanceof BaseError ? (reverted || !e.details ? e.shortMessage : `${e.shortMessage} ${e.details}`) : e instanceof Error ? e.message : String(e);
  return { fail: true, reverted, message: msg.replace(/\s+/g, " ") };
}
export const isFail = (v: unknown): v is ReadFail => typeof v === "object" && v !== null && (v as ReadFail).fail === true;

/** Code changes wait in public: the DstackApp's owner is an OZ TimelockController with at least this minDelay (1 h). */
export const CODE_DELAY_S = 3600;
/** Why the owner's getMinDelay() fails the 1 h floor ([] = ok). */
export const checkCodeDelay = (minDelay: bigint | ReadFail) =>
  isFail(minDelay) ? [minDelay.reverted ? `the DstackApp's owner is not a timelock (getMinDelay: ${minDelay.message})` : `getMinDelay could not be read (RPC error: ${minDelay.message})`]
  : minDelay < BigInt(CODE_DELAY_S) ? [`the timelock's minDelay is ${minDelay} s, shorter than ${CODE_DELAY_S} s`] : [];

/** DstackApp._authorizeUpgrade's revert once disableUpgrades() ran (or disableUpgrades = true at creation). */
export const UPGRADES_DISABLED = "Upgrades are permanently disabled";
/** An upgradeToAndCall simulated from the owner: null = it would go through. Only that exact revert passes. */
export const checkUpgradesDisabled = (r: ReadFail | null) =>
  r === null ? ["an upgrade from the owner would go through: upgrades are not disabled"]
  : r.reverted && r.message.includes(UPGRADES_DISABLED) ? []
  : [r.reverted ? `the upgrade reverted for another reason: ${r.message}` : `could not simulate an upgrade (RPC error: ${r.message})`];

/** OZ TimelockController role ids. */
export const ROLES = { admin: zeroHash, proposer: keccak256(toHex("PROPOSER_ROLE")), canceller: keccak256(toHex("CANCELLER_ROLE")), executor: keccak256(toHex("EXECUTOR_ROLE")) } as const;
export type RoleLog = { eventName: "RoleGranted" | "RoleRevoked"; role: string; account: string; blockNumber: bigint; logIndex: number };
/** Current holders of `role`, replaying its RoleGranted / RoleRevoked logs in chain order (lowercase addresses). */
export function roleHolders(logs: RoleLog[], role: string): string[] {
  const held = new Set<string>();
  const mine = logs.filter((l) => sameHex(l.role, role)).sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  for (const l of mine) if (l.eventName === "RoleGranted") held.add(l.account.toLowerCase()); else held.delete(l.account.toLowerCase());
  return [...held];
}
/** The timelock's roles from its full role history: only the Safe proposes and cancels, anyone executes, and no account
 *  but the timelock itself holds the admin role (renounced, as deployed). */
export function checkTimelockRoles(logs: RoleLog[], timelock: string, safe: string) {
  const out: string[] = [];
  const only = (role: string, name: string) => {
    const h = roleHolders(logs, role);
    if (!(h.length === 1 && sameHex(h[0], safe))) out.push(`${name} must be held by the Safe alone (held by: ${h.join(", ") || "nobody"})`);
  };
  only(ROLES.proposer, "PROPOSER_ROLE");
  only(ROLES.canceller, "CANCELLER_ROLE");
  if (!roleHolders(logs, ROLES.executor).includes(zeroAddress)) out.push("execution is not open to anyone (address(0) lacks EXECUTOR_ROLE)");
  const admins = roleHolders(logs, ROLES.admin).filter((a) => !sameHex(a, timelock));
  if (admins.length) out.push(`DEFAULT_ADMIN_ROLE is held by ${admins.join(", ")} (only the timelock itself may hold it)`);
  return out;
}

export type SignedRecord = { kind: string; ref: string | null; body: string; eprev: string | null; ehash: string | null; esig: string | null };
/** An enclave record: hash recomputes; the signer (null if none) — the caller compares it to the attested log signer. */
export async function checkRecord(r: SignedRecord) {
  if (!r.eprev || !r.ehash || !r.esig) return { ehashOk: false, signer: null };
  const ehash = sha256(Buffer.concat([hexBytes(r.eprev), sha256(Buffer.from(r.body, "utf8"))])).toString("hex");
  const ehashOk = ehash === r.ehash.replace(/^0x/, "").toLowerCase();
  const signer = await recoverMessageAddress({ message: { raw: `0x${logDigestOf(ehash, r.kind, r.ref)}` }, signature: r.esig as Hex }).catch(() => null);
  return { ehashOk, signer };
}

/** Mapper re-run: an anchor intent's calldata must be exactly registry.queue(encodeOp(op, args)). */
export function mapperOk(intent: { op: OpName; args: unknown[]; calldata: string }) {
  try {
    const q = encodeOp(intent.op, intent.args.map((a) => (typeof a === "string" && /^\d+$/.test(a) ? BigInt(a) : a)));
    return encodeFunctionData({ abi: registryAbi, functionName: "queue", args: [q.op, q.data] }) === intent.calldata;
  } catch {
    return false;
  }
}
