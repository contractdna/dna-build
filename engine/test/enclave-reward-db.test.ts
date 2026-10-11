// The watchdog's idea-reward check (src/rewards.ts checkReward) on records the ENCLAVE wrote: the ship verdict and the
// reward record through the enclave log chain (log.ts append, own head, the log key signs), the payee's binding through
// bindings.ts bind, all served by the site's own record code (web/app/api/log/record.ts). The chain side (the anchor,
// the RewardQueued) is a fake client. Against a real Postgres (fresh database) and the dstack mock, or the simulator
// when DSTACK_SIMULATOR_ENDPOINT is set (the enclave-sim CI job). The process env stays a test env; enclave behavior is
// switched on here, as in enclave-db.test.ts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import type { Address, Hex, PublicClient } from "viem";
import { DstackClient } from "@phala/dstack-sdk";
import { startDstackMock } from "../scripts/dstack-mock.ts";
import { startFakes } from "../scripts/fakes.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
const dmock = process.env.DSTACK_SIMULATOR_ENDPOINT ? undefined : await startDstackMock();
const dbName = `dna_enclave_reward_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
const LOG_KEY = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"; // anvil #6 (public test key): stands in for the TEE-derived log key
if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc,${fakes.url}/rpc`, ENGINE_MODE: "live", LLM_MODE: "live", LOG_SIGNING_KEY: LOG_KEY, SECRET_SEAL_KEY: "11".repeat(32),
    X_API_BASE: fakes.url, TELEGRAM_ALLOWED_USER_IDS: "7",
  });
}
const { edb: sql, migrate } = await import("../src/db.ts");
const enclave = await import("../src/enclave.ts");
const { append } = await import("../src/log.ts");
const { bind } = await import("../src/bindings.ts");
const { signerAddress } = await import("../src/signed.ts");
const { checkReward } = await import("../src/rewards.ts");
type RewardRecord = import("../src/rewards.ts").RewardRecord;
type Dep = import("../src/ticket-source.ts").Dep;

before(async () => {
  if (!ADMIN) return;
  await migrate();
  enclave.ENCLAVE.on = true;
  enclave.setDstack(new DstackClient(process.env.DSTACK_SIMULATOR_ENDPOINT ?? dmock!.url) as unknown as Parameters<typeof enclave.setDstack>[0]);
});
after(async () => {
  enclave.ENCLAVE.on = false;
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await fakes.close();
  await dmock?.close();
});

const BASE = "https://log.test";
// the site's own record shape (web/app/api/log/record.ts: its enclave columns and `out`), imported at run time; the
// specifier is not a literal so tsc leaves the web package (CommonJS to tsc) out of this program
type Rec = { seq: string; at: Date; kind: string; ref: string | null; body: string; body_hash: string; prev_hash: string; hash: string; eprev: string | null; ehash: string | null; esig: string | null };
const RECORD_TS = new URL("../../web/app/api/log/record.ts", import.meta.url).href;
const { ENCLAVE: ENCLAVE_COLUMNS, out } = (await import(RECORD_TS)) as { ENCLAVE: string; out: (r: Rec) => Record<string, unknown> & { seq: string; ref: string | null; body: string; ehash: string | null } };
/** The public log, as web/app/api/log serves it: one record by seq, and every binding of an X user id. */
async function serve(url: string) {
  const cols = `seq::text, at, kind, ref, body, encode(body_hash, 'hex') as body_hash, encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash, ${ENCLAVE_COLUMNS}`;
  const by = url.match(/\/api\/log\/binding\/(\d+)$/)?.[1];
  if (by) return { xUserId: by, records: (await sql.unsafe<Rec[]>(`select ${cols} from log where kind = 'binding' and ref = $1 order by log.seq`, [`x:${by}`])).map(out) };
  const seq = url.match(/\/api\/log\/(\d+)$/)?.[1];
  const [r] = seq ? await sql.unsafe<Rec[]>(`select ${cols} from log where seq = $1`, [seq]) : [];
  if (!r) throw new Error(`${url}: HTTP 404`);
  return out(r);
}

test("the watchdog's reward check passes on enclave-written records: a ship verdict, the author's signed binding, the anchored reward record", { skip }, async () => {
  const payee = "0x52908400098527886E0F7030069857D2E4169EE7" as Address; // EIP-55 test vector, never a real wallet
  const amount = 10n ** 16n;
  // the basis: the Sequencer's ship record (src/sequencer.ts writes kind ship, verdict ship)
  const ship = await append("ship", "ship:e2e", { kind: "ship", verdict: "ship", title: "a weekly raffle game", build: "b1", idea: "im:1", effectiveAt: new Date().toISOString() });
  // the payee: the X author's binding, through the real intake path
  const b = await bind("89", "3002", payee);
  assert.equal(b.status, "first");
  // the reward record, as src/idea-queue.ts rewardOne writes it (after the brain's decision)
  const body: RewardRecord & { brain: string; reason: string } = { kind: "reward", idea: { source: "x", authorId: "89", postId: "3001" }, to: payee, amount: String(amount),
    basis: { kind: "ship", seq: ship.seq }, binding: (b as { seq: string }).seq, brain: "1", reason: "a shipped build idea: the minimum" };
  const reward = await append("reward", "idea:im:1", body);
  assert.ok(ship.ehash && reward.ehash, "enclave records carry their enclave hash");
  const ideaRef = `0x${reward.ehash}` as Hex; // idea-queue anchors 0x<ehash ?? hash>: the enclave hash here

  // the chain: the record anchored (its uri on the public log), then the agent's queue, a block after the binding
  const T0 = Math.floor(Date.now() / 1000) + 60;
  const queued = { id: 4n, to: payee, amount, ideaRef, eta: BigInt(T0 + 3600), blockNumber: 100n };
  const client = {
    getLogs: async (f: { event: { name: string }; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }) => {
      if (f.event.name === "Anchored" && String(f.args?.root).toLowerCase() === ideaRef.toLowerCase()) return [{ args: { root: ideaRef, uri: `${BASE}/api/log/${reward.seq}` }, blockNumber: 90n }];
      if (f.event.name === "RewardQueued") return [{ args: queued, blockNumber: queued.blockNumber }];
      return [];
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(T0) + blockNumber }),
    readContract: async () => false, // isExcluded
  } as unknown as PublicClient;
  const dep = { startBlock: 0, gamePot: "0x00000000000000000000000000000000000000d2", registry: "0x00000000000000000000000000000000000000d3" } as unknown as Dep;
  const check = (q = queued, logSigner: string | null = signerAddress()) => checkReward({ client, dep, q, head: 200n, lookback: 100n, fetch: serve, logSigner });

  assert.deepEqual(await check(), [], "checked: the signed record, its basis and the payee match the queue");
  // the same check bites on what the enclave did not sign or say
  assert.match((await check({ ...queued, to: "0x0000000000000000000000000000000000000bad" })).join("; "), /the record pays .*, the queue pays/);
  assert.match((await check({ ...queued, amount: amount + 1n })).join("; "), /wei, the queue/);
  assert.match((await check(queued, "0x0000000000000000000000000000000000000001")).join("; "), /not signed by the log signer/);
});
