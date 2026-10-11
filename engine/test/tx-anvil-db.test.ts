// The fee bump against a real node (anvil without automine, every block mined here): a tx priced for a quiet chain is
// left unpayable by a base-fee spike; after TX_BUMP_BLOCKS the replacement is re-quoted from eth_feeHistory, outbids
// the first on both fields and is the one mined. Needs TEST_DATABASE_URL (CI: the postgres service) and anvil on PATH.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { createPublicClient, http, parseAbi, parseGwei, toHex } from "viem";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = !ADMIN ? "TEST_DATABASE_URL unset" : spawnSync("anvil", ["--version"]).status !== 0 ? "anvil not on PATH" : false;
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const RPC = `http://127.0.0.1:${port}`;
const dbName = `dna_test_anvil_${process.pid}`;
const admin = skip ? undefined : postgres(ADMIN!, { max: 1, onnotice: () => {} });
const node = skip ? undefined : spawn("anvil", ["--port", String(port), "--no-mining", "--silent"], { stdio: "ignore" });

if (!skip) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN!);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: RPC, ENGINE_MODE: "live", TX_POLL_MS: "5", TX_TIMEOUT_MS: "60000",
    KEEPER_PRIVATE_KEY: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // anvil #5 (public test key)
  });
}
// imported only after the env is set (config is read at import)
const { edb: sql, migrate } = await import("../src/db.ts");
const { initMode } = await import("../src/mode.ts");
const tx = await import("../src/tx.ts");

const c = createPublicClient({ transport: http(RPC) });
const rpc = (method: string, params: unknown[] = []) => c.request({ method: method as never, params: params as never });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastTx = async (status: string) =>
  (await sql<{ doc: Record<string, any> }[]>`select doc from log where kind = 'tx' and doc->>'status' = ${status} order by seq desc limit 1`)[0]?.doc; // eslint-disable-line @typescript-eslint/no-explicit-any

before(async () => {
  if (skip) return;
  for (let i = 0; ; i++) { try { await c.getBlockNumber(); break; } catch { if (i > 100) throw new Error("anvil did not start"); await sleep(100); } }
  await migrate();
  await initMode();
  await rpc("anvil_mine", ["0xa"]); // ten empty blocks: base fee ≈ 0.26 gwei, no tips (the quote's floor applies)
});
after(async () => {
  node?.kill();
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
});

test("fee bump on a node: a base-fee spike strands the first tx; the re-quoted replacement is mined, not the first", { skip }, async () => {
  const sending = tx.send({ key: "keeper", to: "0x000000000000000000000000000000000000dEaD", abi: parseAbi(["function ping()"]), fn: "ping", purpose: "keeper:ping" });
  let first: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; !(first = await lastTx("pending")); i++) { if (i > 400) throw new Error("never broadcast"); await sleep(25); }
  assert.ok(BigInt(first.maxFee) < parseGwei("1") && BigInt(first.tip) >= parseGwei("0.1"), `priced for the quiet chain: ${first.maxFee} / ${first.tip}`);
  let done = false;
  const spike = (async () => { // every block at 5 gwei until the send settles
    while (!done) {
      await rpc("anvil_setNextBlockBaseFeePerGas", [toHex(parseGwei("5"))]);
      await rpc("anvil_mine", ["0x1"]);
      await sleep(30);
    }
  })();
  try {
    const r = await sending;
    assert.equal(r.status, "mined");
    assert.notEqual(r.hash, first.hashes[0], "the replacement landed, not the stranded first");
    const t = await c.getTransaction({ hash: r.hash! });
    assert.ok(t.maxFeePerGas! >= parseGwei("10"), `re-quoted at 2 × the 5 gwei base, not ×1.25 of the first: ${t.maxFeePerGas}`);
    assert.ok(t.maxFeePerGas! * 10n >= BigInt(first.maxFee) * 11n && t.maxPriorityFeePerGas! * 10n >= BigInt(first.tip) * 11n, "≥ +10% on both fields");
    assert.ok((await lastTx("mined"))!.bumps >= 1);
  } finally {
    done = true;
    await spike;
  }
});
