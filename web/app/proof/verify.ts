// The /proof checks, in the browser (WebCrypto + viem). Same rules as engine/src/proof.ts (the CLI's); web/test/proof
// pins both to the same vectors.
//  - report data: sha256(nonce ‖ logHead ‖ agent ‖ anchor ‖ logSigner ‖ funder) is what the quote binds (fresh, names the log
//    head it attests and the enclave's four addresses)
//  - RTMR3: replay of the event log's digests; each dstack runtime event's digest = sha384(le32(0x08000001) ‖ ":" ‖
//    event ‖ ":" ‖ payload); the compose-hash event names the code
//  - compose: sha256(app_compose) = compose hash; every image is a released image@digest, no build, DNA's no-op pre-launch
//    script (never Phala's default: SSH keys, root password), no init/bash script, keys from the KMS, the released envs
//  - records: ehash = sha256(eprev ‖ sha256(body)); esig over sha256("dna/log/v1" ‖ ehash) recovers to the signer
//    (compared with the attested / released log signer)
//  - mapper: an anchor intent's calldata = registry.queue(op, abi.encode(args)) (engine/src/lib.ts OP_TABLE)
import { encodeAbiParameters, encodeFunctionData, type Hex, recoverMessageAddress } from "viem";
import { parse as parseYaml } from "yaml";

export const hexToBytes = (h: string) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((b) => parseInt(b, 16)));
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const utf8 = (s: string) => new TextEncoder().encode(s);
const digest = async (alg: "SHA-256" | "SHA-384", b: Uint8Array) => new Uint8Array(await crypto.subtle.digest(alg, b as BufferSource));

export type Keys = { agent: string; anchor: string; logSigner: string; funder: string };
export const reportDataOf = async (nonce: string, logHead: string, k: Keys) =>
  toHex(await digest("SHA-256", cat(hexToBytes(nonce), hexToBytes(logHead), hexToBytes(k.agent), hexToBytes(k.anchor), hexToBytes(k.logSigner), hexToBytes(k.funder))));
/** sha256("dna/log/v1" ‖ ehash ‖ sha256(JSON [kind, ref])): the record's kind and ref are signed too. */
export const logDigestOf = async (ehash: string, kind: string, ref: string | null) =>
  toHex(await digest("SHA-256", cat(utf8("dna/log/v1"), hexToBytes(ehash), await digest("SHA-256", utf8(JSON.stringify([kind, ref]))))));

export async function eventDigest(event: string, payloadHex: string) {
  return toHex(await digest("SHA-384", cat(new Uint8Array([0x01, 0x00, 0x00, 0x08]), utf8(":"), utf8(event), utf8(":"), hexToBytes(payloadHex ?? ""))));
}
export async function replayRtmr(digests: string[]) {
  let mr = new Uint8Array(48);
  for (const d of digests) {
    const b = hexToBytes(d);
    mr = await digest("SHA-384", cat(mr, b.length < 48 ? cat(b, new Uint8Array(48 - b.length)) : b));
  }
  return toHex(mr);
}

export type Event = { imr: number; digest: string; event: string; event_payload: string };
export async function checkEventLog(log: Event[], rtmr3: string) {
  const issues: string[] = [];
  // dstack's guest agent sends runtime events without their digest: compute it from the payload
  const mine: Event[] = [];
  for (const e of log) if (e.imr === 3) mine.push(e.digest || !e.event ? e : { ...e, digest: await eventDigest(e.event, e.event_payload) });
  if ((await replayRtmr(mine.map((e) => e.digest))) !== rtmr3.replace(/^0x/, "").toLowerCase()) issues.push("the event log does not replay to the quote's RTMR3");
  for (const e of mine) if (e.event && (await eventDigest(e.event, e.event_payload)) !== e.digest.toLowerCase()) issues.push(`event ${e.event}: digest does not match its payload`);
  const payload = (name: string) => mine.find((e) => e.event === name)?.event_payload ?? null;
  return { issues, composeHash: payload("compose-hash"), appId: payload("app-id"), osImageHash: payload("os-image-hash"), keyProvider: payload("key-provider") };
}

export const sameHex = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.replace(/^0x/, "").toLowerCase() === b.replace(/^0x/, "").toLowerCase();
/** The quote's app-id and OS image against the attestation's info and the release (null = not pinned yet). */
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
export async function checkCompose(appCompose: string | null, composeHash: string, rel: ComposeRelease) {
  if (!appCompose) return ["the app does not publish its app_compose (public_tcbinfo)"];
  const issues: string[] = [];
  if (toHex(await digest("SHA-256", utf8(appCompose))) !== composeHash.replace(/^0x/, "").toLowerCase()) issues.push("sha256(app_compose) is not the compose hash");
  let app: Record<string, unknown>;
  try { app = Object(JSON.parse(appCompose)); } catch { return [...issues, "app_compose is not JSON"]; }
  return [...issues, ...appIssues(app, rel)];
}

/** A post link (x.com or twitter.com …/status/<id>) or a bare tweet id (15+ digits; record numbers are shorter) → the
 *  tweet id; anything else → null (a record number). */
export const tweetIdOf = (s: string) => s.trim().match(/(?:^|\/status\/)(\d{15,20})(?:[/?#]|$)/)?.[1] ?? null;

export type SignedRecord = { kind: string; ref: string | null; body: string; eprev: string | null; ehash: string | null; esig: string | null };
export async function checkRecord(r: SignedRecord) {
  if (!r.eprev || !r.ehash || !r.esig) return { ehashOk: false, signer: null as string | null };
  const ehash = toHex(await digest("SHA-256", cat(hexToBytes(r.eprev), await digest("SHA-256", utf8(r.body)))));
  const signer = await recoverMessageAddress({ message: { raw: `0x${await logDigestOf(ehash, r.kind, r.ref)}` }, signature: r.esig as Hex }).catch(() => null);
  return { ehashOk: ehash === r.ehash.replace(/^0x/, "").toLowerCase(), signer };
}

/** engine/src/lib.ts OP_TABLE (ModuleRegistry.Op order → abi types of `data`). */
const OP_TYPES: Record<string, string[]> = {
  Register: ["address", "uint8", "bytes32", "bytes32[4]", "bytes32[4]", "bytes32[4]"], SetShadow: ["address"], SetCanary: ["address", "uint64", "uint32", "uint32"],
  PromoteActive: ["address"], SetParams: ["address", "bytes32[4]"], SetAgent: ["address"], SetAnchorKey: ["address"], SetLevel: ["uint8"], UnpauseAgent: [],
  ApproveCodehash: ["bytes32", "uint8", "bytes32[4]", "bytes32[4]"], RevokeCodehash: ["bytes32"],
};
const queueAbi = [{ type: "function", name: "queue", stateMutability: "nonpayable", inputs: [{ name: "op", type: "uint8" }, { name: "data", type: "bytes" }], outputs: [{ name: "id", type: "uint256" }] }] as const;
export function mapperOk(intent: { op: string; args: unknown[]; calldata: string }) {
  const types = OP_TYPES[intent.op];
  if (!types || types.length !== intent.args.length) return false;
  try {
    const args = intent.args.map((a) => (typeof a === "string" && /^\d+$/.test(a) ? BigInt(a) : a));
    const data = encodeAbiParameters(types.map((type) => ({ type })), args as never);
    return encodeFunctionData({ abi: queueAbi, functionName: "queue", args: [Object.keys(OP_TYPES).indexOf(intent.op), data] }) === intent.calldata;
  } catch {
    return false;
  }
}
