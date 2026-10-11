// Enclave build, pure parts + the dstack guest agent: env lockdown, commit-reveal thresholds, RPC literals, key
// derivation, the sealed-key provider, tcb_info, the boot-check walk and the chain-snapshot hash. dstack: the real
// simulator when DSTACK_SIMULATOR_ENDPOINT is set (CI job enclave-sim), else scripts/dstack-mock.ts (same API).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DstackClient } from "@phala/dstack-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { startDstackMock } from "../scripts/dstack-mock.ts";
import { agreedHead, eventsSha256 } from "../src/chainref.ts";
import { dstackKeyProvider, type Dstack, enclaveKeys, envIssues, hostsOf, KEY_PATHS, PROMPT_IDS, rpcUrls, tcbInfo, thresholds } from "../src/enclave.ts";
import { unreached } from "../src/head.ts";
import { THRESHOLD_KEYS } from "../src/policy.ts";
import { seal, setKeyProvider, unseal, localKeyProvider } from "../src/sealed.ts";

const SIM = process.env.DSTACK_SIMULATOR_ENDPOINT;
const mock = SIM ? undefined : await startDstackMock();
const client = new DstackClient(SIM ?? mock!.url) as unknown as Dstack;
after(() => mock?.close());

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const good = {
  ENCLAVE: "1", CHAIN_ID: "1", DATABASE_URL: "postgres://x", ALCHEMY_KEY: "a", DRPC_KEY: "d", XAI_API_KEY: "k", OPENROUTER_API_KEY_ENGINE: "k",
  TELEGRAM_BOT_TOKEN: "t", TELEGRAM_GROUP_ID: "-1", TELEGRAM_ALLOWED_USER_IDS: "1,2", X_CLIENT_ID: "c", X_USER_ID: "u", PATH: "/usr/bin", HOME: "/root",
  ENGINE_MODE: "dry_run", KEEPER_PRIVATE_KEY: "0x1", DNA_PERSONA: Buffer.from(`# Charter\nc\n# Voice\nv\n${PROMPT_IDS.map((id) => `# Prompt ${id}\np\n`).join("")}`).toString("base64"),
};

test("env lockdown: allowed_envs + compose literals only; LLM_MODE live; no *_API_BASE; chain 1; RPC keys required", () => {
  assert.deepEqual(envIssues(good), []);
  assert.deepEqual(envIssues({ ...good, LLM_MODE: "live" }), []);
  const one = (extra: Record<string, string | undefined>, re: RegExp) => assert.ok(envIssues({ ...good, ...extra }).some((i) => re.test(i)), JSON.stringify(extra));
  one({ LLM_MODE: "replay" }, /LLM_MODE=replay/);
  one({ LLM_MODE: "record" }, /LLM_MODE=record/);
  one({ XAI_API_BASE: "http://evil" }, /XAI_API_BASE is set/);
  one({ X_API_BASE: "http://evil" }, /X_API_BASE is set/);
  one({ TELEGRAM_API_BASE: "http://evil" }, /TELEGRAM_API_BASE is set/);
  one({ AGENT_PRIVATE_KEY: "0x2" }, /AGENT_PRIVATE_KEY is neither/); // the agent key is derived in the TEE, never env
  one({ LOG_SIGNING_KEY: "0x2" }, /LOG_SIGNING_KEY is neither/); // so is the log key
  one({ RPC_URL: "http://evil" }, /RPC_URL is neither/); // RPC hosts are code literals
  one({ GATE_MIN_RETENTION: "0" }, /GATE_MIN_RETENTION is neither/); // a threshold only via the committed blob
  one({ DSTACK_SIMULATOR_ENDPOINT: "http://evil" }, /DSTACK_SIMULATOR_ENDPOINT is neither/);
  one({ CHAIN_ID: "31337" }, /CHAIN_ID must be the literal 1/);
  one({ DRPC_KEY: undefined }, /DRPC_KEY is required/);
  // the kill switch: no enclave boots without its Telegram bot, group and signers
  for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_GROUP_ID", "TELEGRAM_ALLOWED_USER_IDS"]) one({ [k]: undefined }, new RegExp(`${k} is required`));
  one({ TELEGRAM_GROUP_ID: "my-group" }, /TELEGRAM_GROUP_ID must be a numeric chat id/);
  one({ TELEGRAM_ALLOWED_USER_IDS: "1, 2" }, /TELEGRAM_ALLOWED_USER_IDS must be comma-separated/);
  // the persona: sealed, required, and a real persona file (the brain never runs on the neutral default here)
  one({ DNA_PERSONA: undefined }, /DNA_PERSONA is required/);
  one({ DNA_PERSONA: Buffer.from("just text").toString("base64") }, /DNA_PERSONA must be the base64 of a persona bundle/);
  // every prompt section is required: the enclave never runs a model task on a neutral default
  one({ DNA_PERSONA: Buffer.from("# Charter\nc\n# Voice\nv\n# Prompt research\np\n").toString("base64") }, /DNA_PERSONA lacks the prompt sections hypothesize, redteam/);
  one({ PERSONA_FILE: "/tmp/persona.md" }, /PERSONA_FILE is neither/);
});

test("env lockdown before any module reads the env: the engine refuses a bad enclave env with every issue listed", () => {
  // what the image's smoke test runs (.github/workflows/image.yml), without Docker: no persona loader or other import
  // may fail first with a narrower error
  const r = spawnSync(process.execPath, ["src/engine.ts"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: "/tmp", ENCLAVE: "1", CHAIN_ID: "1", XAI_API_BASE: "http://x" } });
  assert.notEqual(r.status, 0);
  const msg = r.stderr.match(/^Error: enclave env lockdown: (.*)$/m)?.[1] ?? "";
  for (const want of ["XAI_API_BASE is set", "DATABASE_URL is required", "TELEGRAM_BOT_TOKEN is required", "DNA_PERSONA is required"]) assert.ok(msg.includes(want), `${want} in: ${r.stderr.slice(0, 400)}`);
});

test("env lockdown, the Sequencer: its GitHub token is an allowed env; the repository and the bot are literals; the image names its solc", () => {
  assert.deepEqual(envIssues({ ...good, GITHUB_TOKEN: "github_pat_x", GITHUB_REPO: "project-org/game-lab", SEQ_BOT: "dna-sequencer[bot]", SEQ_SOLC: "/usr/local/bin/solc" }), []);
  assert.ok(envIssues({ ...good, GITHUB_API_BASE: "http://evil" }).some((i) => /GITHUB_API_BASE is set/.test(i)));
  assert.ok(envIssues({ ...good, SEQ_KIT_DIR: "/tmp/kit" }).some((i) => /SEQ_KIT_DIR is neither/.test(i)), "the kit is the image's");
  assert.ok(envIssues({ ...good, SEQ_SOLC: "/tmp/solc" }).some((i) => /SEQ_SOLC must be the image's/.test(i)), "only the image's own solc");
});

test("thresholds: commit-reveal (blob hashes to the compose literal) and only policy knobs", () => {
  const blob = JSON.stringify({ KILL_MIN_RETENTION: 0.75, GATE_MIN_SWAPS: 30 });
  assert.deepEqual(envIssues({ ...good, POLICY_THRESHOLDS: blob, POLICY_THRESHOLDS_SHA256: sha(blob) }), []);
  assert.ok(envIssues({ ...good, POLICY_THRESHOLDS: blob, POLICY_THRESHOLDS_SHA256: sha("other") }).some((i) => /does not hash/.test(i)));
  assert.ok(envIssues({ ...good, POLICY_THRESHOLDS_SHA256: sha(blob) }).some((i) => /does not hash/.test(i)), "a committed hash needs its blob");
  assert.deepEqual(thresholds(blob, THRESHOLD_KEYS), { KILL_MIN_RETENTION: "0.75", GATE_MIN_SWAPS: "30" });
  assert.throws(() => thresholds(JSON.stringify({ GROK_MODEL: "x" }), THRESHOLD_KEYS), /not a policy knob/);
});

test("RPC: two literal hosts; records list hosts, never the key suffix", () => {
  const urls = rpcUrls({ ALCHEMY_KEY: "SECRET1", DRPC_KEY: "SECRET2" });
  assert.equal(urls.length, 2);
  assert.ok(urls[0].startsWith("https://eth-mainnet.g.alchemy.com/v2/") && urls[1].startsWith("https://lb.drpc.org/"));
  assert.deepEqual(hostsOf(urls), ["eth-mainnet.g.alchemy.com", "lb.drpc.org"]);
  assert.ok(!JSON.stringify(hostsOf(urls)).includes("SECRET"));
});

test(`dstack (${SIM ? "simulator" : "mock"}): agent, anchor, log and funder keys derived with the legacy getKey(path, purpose), distinct and stable`, async () => {
  const a = await enclaveKeys(client);
  const b = await enclaveKeys(client);
  assert.deepEqual(a, b, "same app + path + purpose → same key across calls (and restarts)");
  assert.equal(new Set([a.agent, a.anchor, a.log, a.funder]).size, 4, "separate keys: nonce lanes, the agent EOA never signs log records, the funder only queues funds");
  assert.match(privateKeyToAccount(a.log).address, /^0x[0-9a-fA-F]{40}$/);
  if (mock) {
    const keys = mock.calls.filter((c) => c.path === "/GetKey").map((c) => c.body);
    assert.deepEqual(keys.slice(0, 4).map((k) => [k.path, k.purpose, k.algorithm]), [[...KEY_PATHS.agent, "secp256k1"], [...KEY_PATHS.anchor, "secp256k1"], [...KEY_PATHS.log, "secp256k1"], [...KEY_PATHS.funder, "secp256k1"]]);
  }
});

test(`dstack (${SIM ? "simulator" : "mock"}): the X-token seal key comes from the TEE; tcb_info is read once`, async () => {
  try {
    setKeyProvider(dstackKeyProvider(client));
    const v = await seal("x-token", "refresh-1");
    assert.equal(await unseal("x-token", v), "refresh-1");
    process.env.SECRET_SEAL_KEY = "44".repeat(32);
    setKeyProvider(localKeyProvider);
    assert.equal(await unseal("x-token", v), null, "an env key never opens what the TEE sealed");
  } finally {
    setKeyProvider(localKeyProvider);
  }
  const t = await tcbInfo(client);
  for (const k of ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3", "composeHash", "appId"]) assert.ok(typeof t[k] === "string" && t[k].length, k);
  assert.equal(await tcbInfo(client), t);
});

test("boot check walk: the DB head must reach the anchored root and the disk head", () => {
  const prev = new Map([["c", "b"], ["b", "a"], ["a", "0"]]);
  assert.deepEqual(unreached("c", prev, ["a", "b"]), []);
  assert.deepEqual(unreached("b", prev, ["c"]), ["c"], "a head older than the disk head = rollback");
  assert.deepEqual(unreached("c", prev, ["x"]), ["x"], "an anchored root not in the chain");
  assert.deepEqual(unreached(undefined, prev, []), []);
  assert.deepEqual(unreached("c", new Map([["c", "b"], ["b", "c"]]), ["a"]), ["a"], "a loop terminates");
});

test("eventsSha256: canonical over [block, logIndex, tx, event, args], order-independent input, any change detected", () => {
  const r = (block: number, li: number, args: unknown) => ({ block, log_index: li, tx: `0x${block}`, event: "Swap", args });
  const a = eventsSha256([r(2, 0, { x: "1" }), r(1, 3, { y: "2" })]);
  assert.equal(a, eventsSha256([r(1, 3, { y: "2" }), r(2, 0, { x: "1" })]));
  assert.notEqual(a, eventsSha256([r(1, 3, { y: "2" }), r(2, 0, { x: "9" })]), "a fabricated arg");
  assert.notEqual(a, eventsSha256([r(2, 0, { x: "1" })]), "a dropped event");
});

test("agreedHead: the lowest provider head, so a log read bounded to it means the same on every provider", async () => {
  const at = (n: bigint) => ({ getBlockNumber: async () => n });
  assert.equal(await agreedHead([at(105n), at(103n), at(104n)]), 103n);
  assert.equal(await agreedHead([at(7n)]), 7n);
});
