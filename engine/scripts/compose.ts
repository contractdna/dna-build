// Render the CVM's app-compose from deploy/app-compose.template.json + deploy/docker-compose.template.yml and the
// launch values (a params JSON, see deploy/compose.params.example.json):
//   node scripts/compose.ts <params.json>
// Writes deploy/app-compose.json — exactly the bytes whose sha256 is the compose hash (dstack's deterministic JSON:
// sorted keys, no whitespace; = getComposeHash) — and the release record the verifiers pin: deploy/release.json and its
// copy web/app/proof/release.json. Refuses unless every {{literal}} is filled, the image is pinned by digest, the
// allowed_envs are exactly src/enclave.ts ALLOWED_ENVS, every literal env is a compose literal the engine knows, and the
// verifiers' compose checks pass. The template carries the fields Phala Cloud adds when it provisions (features,
// tproxy_enabled, local_key_provider_enabled) and DNA's no-op pre-launch script, so this hash is the one Phala computes
// and the one the CVM measures (the same on every KMS: no key_provider_id).
// It deploys nothing: the compose hash still has to reach the DstackApp allow-list (the first one when the DstackApp is
// created, later ones through its 1 h timelock).
// `notes` (optional): 3-6 plain one-liners of what this version changes, for the public, no internals. They go in the
// release record and in deploy/releases/<compose hash>.json; the engine reads that file from the public repository when
// the Safe schedules the hash and says them (src/upgrades.ts), so publish it before the Safe schedules.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getComposeHash } from "@phala/dstack-sdk/get-compose-hash";
import { assertAnonymous } from "../src/anonymity.ts";
import { ALLOWED_ENVS, isoWithZone, LITERAL_ENVS } from "../src/enclave.ts";
import { checkCompose, PRE_LAUNCH_SCRIPT } from "../src/proof.ts";
import { canonical } from "../src/log.ts";
import { instructionLike, screenLine } from "../src/voice.ts";

export type Params = {
  commit: string; image: string; imageDigest: string; xClientId: string; xUserId: string;
  githubRepo: string; seqBot: string; pagecheckImage: string; pagecheckDigest: string;
  policyThresholdsSha256?: string; studioUrl: string; xAiRepliesApproved?: boolean; ideaMode?: "rounds" | "live"; telegramPublicChat?: string; llmLaunchAt?: string; dstackApp?: string | null; attestationUrl?: string | null; logSigner?: string | null; funder?: string | null;
  measurements?: { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; osImageHash: string } | null;
  notes?: string[];
};
const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

/** Pure: the rendered app-compose (deterministic JSON string) and its hash, or throws naming what is wrong. */
export function render(p: Params, template = read("deploy/app-compose.template.json"), yamlTemplate = read("deploy/docker-compose.template.yml")) {
  if (!/^[0-9a-f]{40}$/.test(p.commit)) throw new Error("commit: 40 hex chars (the tagged commit the image was built from)");
  if (!/^sha256:[0-9a-f]{64}$/.test(p.imageDigest)) throw new Error("imageDigest: sha256:<64 hex> (image workflow, engine-image-digest.json)");
  assertAnonymous("the compose params", p); // the compose and release.json are public
  if (/<project-org>/.test(p.image)) throw new Error("image: still the <project-org> placeholder (the pseudonymous org's registry)");
  if (p.policyThresholdsSha256 && !/^[0-9a-f]{64}$/.test(p.policyThresholdsSha256)) throw new Error("policyThresholdsSha256: 64 hex or empty");
  if (!/^sha256:[0-9a-f]{64}$/.test(p.pagecheckDigest ?? "")) throw new Error("pagecheckDigest: sha256:<64 hex> (image workflow, pagecheck-image-digest.json)");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(p.githubRepo ?? "")) throw new Error("githubRepo: <owner>/<name> of the Sequencer's repository");
  if (!/^[a-z0-9-]+\[bot\]$/.test(p.seqBot ?? "")) throw new Error("seqBot: the Sequencer App's bot login (<name>[bot])");
  const vals: Record<string, string> = {
    IMAGE: p.image, IMAGE_DIGEST: p.imageDigest, X_CLIENT_ID: p.xClientId, X_USER_ID: p.xUserId, POLICY_THRESHOLDS_SHA256: p.policyThresholdsSha256 ?? "",
    STUDIO_URL: p.studioUrl, LLM_LAUNCH_AT: p.llmLaunchAt ?? "",
    GITHUB_REPO: p.githubRepo, SEQ_BOT: p.seqBot, PAGECHECK_IMAGE: p.pagecheckImage, PAGECHECK_DIGEST: p.pagecheckDigest,
    X_AI_REPLIES_APPROVED: p.xAiRepliesApproved ? "1" : "", // "" = unset: AI replies stay off until X approves them
    IDEA_MODE: p.ideaMode ?? "rounds", // src/config.ts IDEA_MODE: live = each idea judged as it comes in
    TELEGRAM_PUBLIC_CHAT: p.telegramPublicChat ?? "", // src/config.ts TG.publicChat: "" = no public chat
  };
  if (vals.IDEA_MODE !== "rounds" && vals.IDEA_MODE !== "live") throw new Error("ideaMode: rounds or live");
  if (!/^(@[A-Za-z0-9_]{5,32}|-?\d+)?$/.test(vals.TELEGRAM_PUBLIC_CHAT)) throw new Error("telegramPublicChat: a channel's @name or a numeric chat id");
  if (p.studioUrl !== "" && !/^https:\/\/[^\s"]+$/.test(p.studioUrl)) throw new Error("studioUrl: the studio service's https URL, or \"\" (no studio: fallback plates at once)");
  if (p.llmLaunchAt && !isoWithZone(p.llmLaunchAt)) throw new Error("llmLaunchAt: an ISO date-time with Z or an explicit offset (the LLM spend schedule starts there), or empty");
  for (const [k, v] of Object.entries(vals)) if (/TODO|["\n\\]/.test(v)) throw new Error(`${k}: not filled in (or contains a quote / newline)`);
  const yaml = yamlTemplate.replace(/^#.*\n/gm, "").replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vals)) throw new Error(`docker-compose template: unknown literal {{${k}}}`);
    return vals[k];
  });
  const literalEnv = [...yaml.matchAll(/^ {6}(\w+): "/gm)].map((m) => m[1]);
  const runtimeEnv = [...yaml.matchAll(/^ {6}(\w+): \$\{(\w+)\}$/gm)].map((m) => { if (m[1] !== m[2]) throw new Error(`${m[1]} maps to \${${m[2]}}`); return m[1]; });
  for (const k of literalEnv) if (!(LITERAL_ENVS as readonly string[]).includes(k)) throw new Error(`literal env ${k} is not a compose literal in src/enclave.ts`);
  if (canonical([...runtimeEnv].sort()) !== canonical([...ALLOWED_ENVS].sort())) throw new Error(`runtime envs ${runtimeEnv.join(",")} ≠ ALLOWED_ENVS`);
  const app = JSON.parse(template) as Record<string, unknown>;
  if (canonical([...(app.allowed_envs as string[])].sort()) !== canonical([...ALLOWED_ENVS].sort())) throw new Error("app-compose allowed_envs ≠ src/enclave.ts ALLOWED_ENVS");
  // Phala Cloud's own pre-launch script (SSH keys, root password) goes in when ours is missing: only ours, byte-equal
  if (app.pre_launch_script !== PRE_LAUNCH_SCRIPT) throw new Error("pre_launch_script: exactly src/proof.ts PRE_LAUNCH_SCRIPT (the measured no-op), nothing else");
  // no key_provider / key_provider_id: with them Phala's VMM 0.6.0 writes an MRCONFIGID v3, which the dstack-0.5.8 guest (the
  // only OS image the Ethereum KMS allows) refuses at boot ("Invalid mr_config_id version"); without them Phala adds none
  for (const k of ["key_provider", "key_provider_id"]) if (k in app) throw new Error(`${k}: leave it out (a 0.5.x guest refuses the MRCONFIGID v3 it brings)`);
  app.docker_compose_file = yaml;
  const appCompose = canonical(app);
  const composeHash = getComposeHash(app as never);
  const issues = checkCompose(appCompose, composeHash, release(p, composeHash, null)); // what the verifiers will check, refused here first
  if (issues.length) throw new Error(issues.join("; "));
  return { appCompose, composeHash, yaml };
}

/** The registry the verifiers read (registry.agent(), Anchored): from the committed deployment, null while a placeholder. */
export function registryOf(dep: { registry: string; startBlock: number } = JSON.parse(read("engine/deployments/1.json"))) {
  return /^0x0+$/.test(dep.registry) ? null : { address: dep.registry, startBlock: dep.startBlock };
}

/** Why release notes can't be published (null = ok): 3-6 lines, each 1-80 printable ASCII characters, no link, handle,
 *  hashtag, cashtag or TODO (the engine screens them again when it reads them). */
export function notesIssue(notes: unknown): string | null {
  if (!Array.isArray(notes) || notes.length < 3 || notes.length > 6) return "3 to 6 lines";
  // the engine's own screen too (src/upgrades.ts notesOf): a line it would drop must never be published
  const bad = notes.find((n) => typeof n !== "string" || !/^[\x20-\x7e]{1,80}$/.test(n) || /https?:|www\.|[@#$]|TODO/i.test(n) || instructionLike(n) || !screenLine(n.replace(/\d+(?:\.\d+)?/g, "N"), 80));
  return bad === undefined ? null : `not a plain public line (≤ 80 chars, no link, handle, number word, banned term, order to the reader or TODO): ${JSON.stringify(bad)}`;
}

export function release(p: Params, composeHash: string, registry = registryOf()) {
  const why = p.notes === undefined ? null : notesIssue(p.notes);
  if (why) throw new Error(`notes: ${why}`);
  return {
    registry,
    commit: p.commit, ...(p.notes ? { notes: p.notes } : {}), image: p.image, imageDigest: p.imageDigest, pagecheckImage: p.pagecheckImage, pagecheckDigest: p.pagecheckDigest, composeHash, allowedEnvs: [...ALLOWED_ENVS],
    dstackApp: p.dstackApp ?? null, attestationUrl: p.attestationUrl ?? null, measurements: p.measurements ?? null,
    logSigner: p.logSigner ?? null, // the enclave log key's address (getKey dna/log: stable per app id), read from /attestation at launch
    funder: p.funder ?? null, // the Sequencer's funder (getKey dna/funder): the Roles member FundingSetup names; read from /attestation
    kmsAuth: "0xd343a3f5593b93D8056aB5D60c433622d7D65a80", // Phala's KmsAuth on Ethereum
    kmsKeyProvider: "3059301306072a8648ce3d020106082a8648ce3d03010703420004daad2c8833eae6d5912fdc9b1d088caa771120fab387a019acced35f40951561a97621078a66008aaa15c51420086960be14b24dc326b5c012038fdd68812710", // the Ethereum KMS's (kms-eth-prod7) CA public key, DER hex: the quote's key-provider event names it
  };
}

if (import.meta.filename === process.argv[1]) {
  const p = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as Params;
  const { appCompose, composeHash } = render(p);
  writeFileSync(new URL("deploy/app-compose.json", root), appCompose);
  const rel = `${JSON.stringify(release(p, composeHash), null, 2)}\n`;
  mkdirSync(new URL("deploy/releases/", root), { recursive: true });
  for (const f of ["deploy/release.json", "web/app/proof/release.json", `deploy/releases/${composeHash}.json`]) writeFileSync(new URL(f, root), rel);
  console.log(`compose hash ${composeHash}\nwrote deploy/app-compose.json, deploy/release.json, web/app/proof/release.json, deploy/releases/${composeHash}.json`);
}
