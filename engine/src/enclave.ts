// Enclave build. ENCLAVE=1 is a literal in the hashed compose file (deploy/app-compose.json):
//  - env lockdown: the process refuses to start unless its env is exactly allowed_envs (secrets the operator sets,
//    encrypted to the CVM) + the compose literals + the image's system vars; LLM_MODE must be live and no *_API_BASE may
//    be set (a fixture or a fake endpoint would be a command channel). Every other knob is a code default.
//  - RPC hosts are code literals (two providers); only their key suffixes come from env. Every cycle record lists the
//    host set; gate and kill reads require both providers to agree on the block hash (src/chainref.ts).
//  - thresholds: commit-reveal. POLICY_THRESHOLDS (JSON of policy env knobs) is an allowed env; its sha256 is the
//    compose literal POLICY_THRESHOLDS_SHA256, so changing them is a new compose hash through the 1 h timelock.
//  - keys: @phala/dstack-sdk pinned to 0.5.8 (an SDK bump can change derivation), legacy getKey(path, purpose) only:
//    agent and anchor are separate derived keys (separate nonce lanes); the X-token seal key is derived too. The keeper
//    stays a plain hot key (allowed env).
// No imports from the engine: config.ts, policy.ts and db.ts read this before anything else.
import { createHash } from "node:crypto";

/** Mutable only for tests (they switch enclave behavior on inside one process); production reads the env once. */
export const ENCLAVE = { on: process.env.ENCLAVE === "1" };

/** allowed_envs in the compose file: what the operator may set (encrypted to the CVM's key). */
export const ALLOWED_ENVS = [
  "DATABASE_URL", "ALCHEMY_KEY", "DRPC_KEY",
  "XAI_API_KEY", // server-side search only (web/X search: xAI's own tools)
  "OPENROUTER_API_KEY_ENGINE", // every other model call
  "KEEPER_PRIVATE_KEY",
  "TELEGRAM_BOT_TOKEN",
  // private, so never in the public compose. Telegram is transport: every approval (drafts, delayed records) and veto
  // counts only with a Safe owner's signature; the user allowlist gates only the brakes (/halt, /dryrun, /mute, Reject)
  "TELEGRAM_GROUP_ID", "TELEGRAM_ALLOWED_USER_IDS",
  "X_CLIENT_SECRET", "X_REFRESH_TOKEN",
  "ENGINE_MODE", // dry_run | live | halted: the operator's switch (the Telegram override still only restricts)
  "POLICY_THRESHOLDS", // commit-reveal: must hash to the POLICY_THRESHOLDS_SHA256 literal
  "STUDIO_TOKEN", // post media: the enclave's bearer token at the studio
  "GITHUB_TOKEN", // the Sequencer: a fine-grained token for one repository (GITHUB_REPO, a literal); it expires, so it is set, not measured
  // private, so never in the public compose: base64 of the persona file (src/persona.ts). Only its sha256 is public, in
  // every brain and self record and on /proof
  "DNA_PERSONA",
] as const;
/** An ISO date-time that names its zone (Z or ±hh:mm): a bare one, or a date alone, would be read in a guessed zone. */
export const isoWithZone = (v: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
/** Literals in the hashed compose file (changing one = a new compose hash). */
// GITHUB_REPO and SEQ_BOT: the Sequencer's repository and its bot's login (the operator can't point it elsewhere)
// X_AI_REPLIES_APPROVED: "1" once X has approved AI replies (src/tiers.ts); until then only held replies a signer sends
export const LITERAL_ENVS = ["ENCLAVE", "CHAIN_ID", "X_CLIENT_ID", "X_USER_ID", "POLICY_THRESHOLDS_SHA256", "STUDIO_URL", "LLM_LAUNCH_AT", "GITHUB_REPO", "SEQ_BOT", "X_AI_REPLIES_APPROVED", "IDEA_MODE", "TELEGRAM_PUBLIC_CHAT"] as const;
/** The Sequencer's compiler, pinned by sha256 in the image (engine/Dockerfile sets SEQ_SOLC to it). */
export const IMAGE_SOLC = "/usr/local/bin/solc";
/** Set by the image (part of its digest) or the container runtime. */
const SYSTEM_ENVS = ["PATH", "HOME", "HOSTNAME", "NODE_VERSION", "YARN_VERSION", "TERM", "PWD", "SHLVL", "_", "SEQ_SOLC"];

export const RPC_HOSTS = [
  { name: "alchemy", url: "https://eth-mainnet.g.alchemy.com/v2/", key: "ALCHEMY_KEY" },
  { name: "drpc", url: "https://lb.drpc.org/ogrpc?network=ethereum&dkey=", key: "DRPC_KEY" },
] as const;
export const rpcUrls = (env: Record<string, string | undefined>) => RPC_HOSTS.map((h) => `${h.url}${env[h.key] ?? ""}`);
/** The host set a record lists (never the key suffix). */
export const hostsOf = (urls: string[]) => urls.map((u) => { try { return new URL(u).host; } catch { return "?"; } });

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The prompt sections the enclave requires in DNA_PERSONA (src/persona.ts holds a neutral default for each). */
export const PROMPT_IDS = ["research", "hypothesize", "redteam", "decide", "narrate", "lesson", "journal", "genesis", "brain",
  "x-writer", "x-scout", "x-scout-handles", "x-shapes", "x-bits", "x-foils", "x-judge", "x-reader", "x-audit", "game-namer",
  "x-ct", "x-ct-scout", "x-ct-watch"] as const;
export type PromptId = (typeof PROMPT_IDS)[number];
const PROMPT_ID = /^[a-z][a-z0-9.-]{0,63}$/;

/** A bundle's `# <heading>` sections in order, each body trimmed (anything before the first heading is kept in the hash
 *  only). null: a repeated heading or an empty body. */
function sectionsOf(text: string): [string, string][] | null {
  const parts = text.split(/^# (.+?)[ \t]*\r?$/m);
  const out: [string, string][] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const body = (parts[i + 1] ?? "").trim();
    if (!body || out.some(([h]) => h === parts[i])) return null;
    out.push([parts[i], body]);
  }
  return out;
}
/** `# Prompt <id>` sections → {id: text}; null when any section is something else. */
export function promptSections(text: string, sections = sectionsOf(text)): Record<string, string> | null {
  if (!sections) return null;
  const out: Record<string, string> = {};
  for (const [h, body] of sections) {
    const id = h.match(/^Prompt (\S+)$/)?.[1];
    if (!id || !PROMPT_ID.test(id)) return null;
    out[id] = body;
  }
  return out;
}
/** A persona bundle's sections: `# Charter` (the brain), then `# Voice` (the writer), then `# Prompt <id>` sections.
 *  null: not a persona bundle. Shared with src/persona.ts (this file imports nothing from the engine). */
export function personaSections(text: string): { charter: string; voice: string; prompts: Record<string, string> } | null {
  const s = sectionsOf(text);
  if (!s || s[0]?.[0] !== "Charter" || s[1]?.[0] !== "Voice") return null;
  const prompts = promptSections(text, s.slice(2));
  return prompts && { charter: s[0][1], voice: s[1][1], prompts };
}
/** Required prompt ids a bundle lacks. */
export const missingPrompts = (prompts: Record<string, string>) => PROMPT_IDS.filter((id) => !prompts[id]);
/** Strict base64 (whitespace allowed) of a persona bundle. */
export const personaOk = (b64: string) => /^[A-Za-z0-9+/=\s]+$/.test(b64) && personaSections(Buffer.from(b64, "base64").toString("utf8")) !== null;

/** Pure: why this env may not run the enclave build ([] = ok). */
export function envIssues(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const ok = new Set<string>([...ALLOWED_ENVS, ...LITERAL_ENVS, ...SYSTEM_ENVS]);
  if (env.LLM_MODE !== undefined && env.LLM_MODE !== "live") out.push(`LLM_MODE=${env.LLM_MODE}: the enclave only calls the live providers`);
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) continue;
    if (/_API_BASE$/.test(k)) out.push(`${k} is set: provider endpoints are code literals in the enclave`);
    else if (!ok.has(k) && k !== "LLM_MODE") out.push(`${k} is neither in allowed_envs nor a compose literal`);
  }
  if (env.CHAIN_ID !== "1") out.push(`CHAIN_ID must be the literal 1 (got ${env.CHAIN_ID})`);
  if (env.SEQ_SOLC !== undefined && env.SEQ_SOLC !== IMAGE_SOLC) out.push(`SEQ_SOLC must be the image's ${IMAGE_SOLC}`);
  // the Telegram trio is the kill switch (/halt, /mute): an enclave must not boot without it
  for (const k of ["DATABASE_URL", ...RPC_HOSTS.map((h) => h.key), "TELEGRAM_BOT_TOKEN", "TELEGRAM_GROUP_ID", "TELEGRAM_ALLOWED_USER_IDS"]) if (!env[k]) out.push(`${k} is required`);
  if (env.TELEGRAM_GROUP_ID && !/^-?\d+$/.test(env.TELEGRAM_GROUP_ID)) out.push("TELEGRAM_GROUP_ID must be a numeric chat id");
  if (env.TELEGRAM_PUBLIC_CHAT && !/^(@[A-Za-z0-9_]{5,32}|-?\d+)$/.test(env.TELEGRAM_PUBLIC_CHAT)) out.push("TELEGRAM_PUBLIC_CHAT must be a channel's @name or a numeric chat id");
  if (env.TELEGRAM_ALLOWED_USER_IDS && !/^\d+(,\d+)*$/.test(env.TELEGRAM_ALLOWED_USER_IDS)) out.push("TELEGRAM_ALLOWED_USER_IDS must be comma-separated numeric user ids");
  // the persona: the brain must not run on the neutral default in the enclave
  if (!env.DNA_PERSONA) out.push("DNA_PERSONA is required");
  else if (!personaOk(env.DNA_PERSONA)) out.push("DNA_PERSONA must be the base64 of a persona bundle (a `# Charter` section, then `# Voice`, then `# Prompt <id>` sections)");
  else {
    const missing = missingPrompts(personaSections(Buffer.from(env.DNA_PERSONA, "base64").toString("utf8"))!.prompts);
    if (missing.length) out.push(`DNA_PERSONA lacks the prompt sections ${missing.join(", ")}`);
  }
  if (env.POLICY_THRESHOLDS !== undefined || env.POLICY_THRESHOLDS_SHA256 !== undefined) {
    if (!env.POLICY_THRESHOLDS || sha256(env.POLICY_THRESHOLDS) !== env.POLICY_THRESHOLDS_SHA256) out.push("POLICY_THRESHOLDS does not hash to the POLICY_THRESHOLDS_SHA256 literal");
  }
  return out;
}

/** Fail closed before anything reads a knob. */
export function lockdown(env = process.env) {
  // docker compose turns an allowed env the operator left unset (`${POLICY_THRESHOLDS}`) into "": that is unset
  for (const k of Object.keys(env)) if (env[k] === "") delete env[k];
  const bad = envIssues(env);
  if (bad.length) throw new Error(`enclave env lockdown: ${bad.join("; ")}`);
}

/** POLICY_THRESHOLDS → the policy knobs it may set (anything else in the blob is refused). */
export function thresholds(blob: string | undefined, allowed: readonly string[]): Record<string, string> {
  if (!blob) return {};
  const o = JSON.parse(blob) as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`POLICY_THRESHOLDS: ${k} is not a policy knob`);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
}

// ---------------------------------------------------------------- dstack (getKey, quote, info)

/** The subset of DstackClient (@phala/dstack-sdk 0.5.8) the engine uses: tests pass a mock with the same shape. */
export type Dstack = {
  getKey: (path: string, purpose: string) => Promise<{ key: Uint8Array }>;
  getQuote: (reportData: string | Buffer | Uint8Array) => Promise<{ quote: string; event_log: string }>;
  info: () => Promise<{ app_id: string; instance_id: string; compose_hash: string; tcb_info: { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string; os_image_hash?: string; app_compose?: string } }>;
};
let client: Dstack | undefined;
/** Tests: the dstack simulator's client or a mock with the same shape. */
export const setDstack = (c: Dstack) => { client = c; tcb = undefined; };
export async function dstack(): Promise<Dstack> {
  if (!client) {
    const { DstackClient } = await import("@phala/dstack-sdk");
    client = new DstackClient() as unknown as Dstack; // /var/run/dstack.sock, or DSTACK_SIMULATOR_ENDPOINT in tests
  }
  return client;
}

/** Key paths: never change them (a new path is a new key = a setAgent rotation). agent: registry.agent(); anchor:
 *  registry.anchorKey; log: signs log records and state rows only, never a transaction; funder: the Roles member that
 *  may only queue GameFunder.fund through Roles → Delay (its own nonce lane and gas cap). The agent, anchor and log
 *  addresses are bound in the attestation. */
export const KEY_PATHS = { agent: ["dna/agent", "ethereum"], anchor: ["dna/anchor", "ethereum"], log: ["dna/log", "signing"], funder: ["dna/funder", "ethereum"] } as const;
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as `0x${string}`;

/** Agent, anchor, log and funder private keys, derived in the TEE by the KMS for this app's allowed compose hashes. */
export async function enclaveKeys(c?: Dstack) {
  const d = c ?? (await dstack());
  const [agent, anchor, log, funder] = await Promise.all([d.getKey(...KEY_PATHS.agent), d.getKey(...KEY_PATHS.anchor), d.getKey(...KEY_PATHS.log), d.getKey(...KEY_PATHS.funder)]);
  if ([agent, anchor, log, funder].some((k) => k.key.length !== 32)) throw new Error("dstack getKey: expected 32-byte secp256k1 keys");
  return { agent: hex(agent.key), anchor: hex(anchor.key), log: hex(log.key), funder: hex(funder.key) };
}

/** src/sealed.ts provider: AES key = sha256(derived key for dna/seal/<purpose>). */
export const dstackKeyProvider = (c?: Dstack) => ({
  name: "dstack",
  key: async (purpose: string) => createHash("sha256").update((await (c ?? (await dstack())).getKey(`dna/seal/${purpose}`, "aes-256-gcm")).key).digest(),
});

/** tcb_info carried by signed cycle and anchor records, read once. */
let tcb: Promise<Record<string, string>> | undefined;
export const tcbInfo = (c?: Dstack): Promise<Record<string, string>> => (tcb ??= (async () => {
  const i = await (c ?? (await dstack())).info();
  const t = i.tcb_info;
  return { appId: i.app_id, composeHash: i.compose_hash, mrtd: t.mrtd, rtmr0: t.rtmr0, rtmr1: t.rtmr1, rtmr2: t.rtmr2, rtmr3: t.rtmr3, osImageHash: t.os_image_hash ?? "" };
})());
