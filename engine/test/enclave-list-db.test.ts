// The watchdog's jackpot list check (src/draw-verify.ts verifyPosted) on records the ENCLAVE wrote: the window's params
// and its list through the enclave log chain (records.ts record → log.ts append: own head, the log key signs), served
// by the site's own record code (web/app/api/log/record.ts), checked with the log signer against a fake chain (Transfers, the params' anchor, the
// window). Against a real Postgres (fresh database) and the dstack mock, or the simulator when
// DSTACK_SIMULATOR_ENDPOINT is set (the enclave-sim CI job). Enclave behavior is switched on here, as in enclave-db.test.ts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { type Address, type Hex, keccak256, stringToHex } from "viem";
import { DstackClient } from "@phala/dstack-sdk";
import { startDstackMock } from "../scripts/dstack-mock.ts";
import { startFakes } from "../scripts/fakes.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
const dmock = process.env.DSTACK_SIMULATOR_ENDPOINT ? undefined : await startDstackMock();
const dbName = `dna_enclave_list_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
const LOG_KEY = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"; // anvil #6 (public test key): stands in for the TEE-derived log key
if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, { DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc,${fakes.url}/rpc`, ENGINE_MODE: "live", LLM_MODE: "live", LOG_SIGNING_KEY: LOG_KEY, SECRET_SEAL_KEY: "11".repeat(32) });
}
const { edb: sql, migrate } = await import("../src/db.ts");
const enclave = await import("../src/enclave.ts");
const { record } = await import("../src/records.ts");
const { canonical } = await import("../src/canonical.ts");
const { signerAddress } = await import("../src/signed.ts");
const { verifyPosted } = await import("../src/draw-verify.ts");
const { accumulate, buildList, excludedHash, ZERO } = await import("../src/tickets.ts");
type Posted = import("../src/draw-verify.ts").Posted;
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

// the site's own record shape (web/app/api/log/record.ts: its enclave columns and `out`), imported at run time; the
// specifier is not a literal so tsc leaves the web package (CommonJS to tsc) out of this program
type Rec = { seq: string; at: Date; kind: string; ref: string | null; body: string; body_hash: string; prev_hash: string; hash: string; eprev: string | null; ehash: string | null; esig: string | null };
const RECORD_TS = new URL("../../web/app/api/log/record.ts", import.meta.url).href;
const { ENCLAVE: ENCLAVE_COLUMNS, out } = (await import(RECORD_TS)) as { ENCLAVE: string; out: (r: Rec) => Record<string, unknown> & { seq: string; ref: string | null; body: string; ehash: string | null } };
const BASE = "https://log.test";
async function serve(url: string) {
  const seq = url.match(/\/api\/log\/(\d+)$/)?.[1];
  const [r] = seq ? await sql.unsafe<Rec[]>(`select seq::text, at, kind, ref, body, encode(body_hash, 'hex') as body_hash, encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash,
    ${ENCLAVE_COLUMNS} from log where seq = $1`, [seq]) : [];
  if (!r) throw new Error(`${url}: HTTP 404`);
  return out(r);
}

// ---------------------------------------------------------------- a fake chain (as test/draw-verify.test.ts)
const E = 10n ** 18n, T = 1_800_000_000;
const ts = (n: number) => T + n * 12;
const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const dep = { startBlock: 0, token: a(0xd0), convictionVault: a(0xd1), gamePot: a(0xd2), registry: a(0xd3), safe: a(0xd4), poolManager: a(0xd5), hook: a(0xd6), feeVault: a(0xd7),
  buybackBurn: a(0xd8), liquidityVault: a(0xd9), platformRevenue: a(0xda), bootstrap: a(0xdb) } as unknown as Dep;
const W = { window: 6, start: ts(100), end: ts(200) }; // blocks 100..199
const transfers = Array.from({ length: 120 }, (_, i) => ({ block: 10, from: ZERO, to: a(0x1000 + i), value: 1_000n * E }));
const EXCLUDED = [ZERO, "0x000000000000000000000000000000000000dead", dep.safe, a(0xe1), a(0xe2), dep.poolManager, dep.hook, dep.feeVault, dep.buybackBurn, dep.liquidityVault, dep.convictionVault, dep.gamePot,
  dep.platformRevenue, (dep as { bootstrap: Address }).bootstrap].map((x) => x.toLowerCase());
function client(anchor: { root: Hex; block: number }) {
  return {
    transport: { url: "https://rpc.example" },
    getBlock: async (q: { blockNumber?: bigint; blockTag?: string }) => {
      const n = q.blockTag === "finalized" ? 300 : Number(q.blockNumber);
      return { number: BigInt(n), hash: hashOf(n), timestamp: BigInt(ts(n)) };
    },
    getLogs: async (q: { event?: { name: string }; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }) => {
      const inRange = (b: number) => b >= Number(q.fromBlock) && b <= Number(q.toBlock);
      switch (q.event?.name) {
        case "Transfer": return transfers.filter((t) => inRange(t.block)).map((t) => ({ blockNumber: BigInt(t.block), args: { from: t.from, to: t.to, value: t.value } }));
        case "Anchored": return inRange(anchor.block) && String(q.args?.root).toLowerCase() === anchor.root.toLowerCase() ? [{ blockNumber: BigInt(anchor.block), args: { root: anchor.root } }] : [];
        case "WindowRolled": return q.args?.window === 6n ? [{ blockNumber: 99n, args: { window: 6n, start: BigInt(W.start), end: BigInt(W.end) } }] : [];
      }
      return [];
    },
    readContract: async (q: { functionName: string }) => (q.functionName === "agent" ? a(0xe1) : a(0xe2)),
    multicall: async (q: { contracts: unknown[] }) => q.contracts.map(() => false),
  } as never;
}

test("the watchdog's list check passes on enclave-written params and list records; a foreign signer, a changed enclave hash and a forged signature are caught", { skip }, async () => {
  // the params, recorded and (on the fake chain) anchored before the window starts, as src/jackpot.ts paramsTask does
  const params = await record("game", "jackpot:params:6", { kind: "jackpot-params", window: 6, start: W.start, capBps: 200, minBalance: String(1_000n * E), cex: [], cexHash: excludedHash([]),
    capInput: { asOfBlock: 80, lastList: null }, reasoning: "r", at: new Date().toISOString() });
  assert.ok(params.ehash, "an enclave record");
  // the list, built and recorded as src/jackpot.ts listTask does (the record body IS the canonical list)
  const tr = transfers.map((t) => ({ at: ts(t.block), from: t.from, to: t.to, value: t.value }));
  const built = buildList({ ...W, capBps: 200, minBalance: 1_000n * E, startBlock: 100, endBlock: 199, endBlockHash: hashOf(199), paramsSeq: params.seq }, accumulate(tr, [], dep.convictionVault, W), EXCLUDED);
  if ("skip" in built) throw new Error(built.skip);
  const list = await record("game", "jackpot:list:6", built.list);
  const posted: Posted = { window: 6n, capBps: 200n, minBalance: 1_000n * E, root: built.list.root, totalTickets: BigInt(built.list.totalTickets), holders: BigInt(built.list.holders),
    uri: `${BASE}/api/log/${list.seq}`, dataHash: keccak256(stringToHex(canonical(built.list))), eta: BigInt(ts(260)), blockNumber: 250n };
  const anchor = { root: `0x${params.ehash}` as Hex, block: 90 };
  const check = (logSigner: string, fetch = serve) => verifyPosted({ clients: [client(anchor), client(anchor)], dep, posted, fetch, logSigner });

  const ok = await check(signerAddress());
  assert.deepEqual(ok.problems, [], "verified: the enclave's records, rebuilt through every provider");
  assert.equal(ok.holders, 120);
  assert.match((await check(a(0x1))).problems.join("; "), /signed by .*, not the log signer/);
  // the enclave check itself: the body and dataHash stay intact, only the enclave fields of the list record change
  const flip = (h: string) => `${h.slice(0, -1)}${h.endsWith("0") ? "1" : "0"}`;
  const served = (edit: (r: Awaited<ReturnType<typeof serve>>) => Awaited<ReturnType<typeof serve>>) => async (url: string) => { const r = await serve(url); return url === posted.uri ? edit(r) : r; };
  assert.deepEqual((await check(signerAddress(), served((r) => ({ ...r, ehash: flip(r.ehash!) })))).problems, ["the list record's enclave hash does not recompute"]);
  const badSig = (await check(signerAddress(), served((r) => ({ ...r, esig: `${String(r.esig).slice(0, 10)}${String(r.esig)[10] === "0" ? "1" : "0"}${String(r.esig).slice(11)}` })))).problems;
  assert.equal(badSig.length, 1);
  assert.match(badSig[0], /^the list record is signed by .*, not the log signer/);
});
