// The vaults funding file (src/vault-fund.ts), pure: the window is (fundedThrough, head] with both boundaries tested,
// a delayed execution loses nothing and an overlapping batch is the contract's to refuse, the vaults get half, and the
// batch file carries the checksum the Safe Transaction Builder verifies (the same vector
// contracts/test/GenomeVaults.t.sol pins for the forge writer).
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData } from "viem";
import { batchJson, fundBatch, fundData, halfOf, treasuryIn, VAULTS_ABI, windowOf } from "../src/vault-fund.ts";

const SAFE = "0xDA1Af681CF1F924eE24447DB0352dbD59b6C0F73";
const VAULTS = "0x1111111111111111111111111111111111111111";
const d = (block: number, treasury: bigint) => ({ block: BigInt(block), treasury });

test("window: blocks fundedThrough + 1 .. head, both included; none while nothing is mined past fundedThrough", () => {
  assert.deepEqual(windowOf(100n, 120n), { first: 101n, last: 120n });
  assert.deepEqual(windowOf(100n, 101n), { first: 101n, last: 101n });
  assert.equal(windowOf(100n, 100n), null);
  assert.equal(windowOf(100n, 99n), null);
});

test("treasury in the window: a distribution at fundedThrough is out, at fundedThrough + 1 and at head in, past head out", () => {
  const dists = [d(100, 1n), d(101, 2n), d(110, 4n), d(120, 8n), d(121, 16n)];
  assert.deepEqual(treasuryIn(dists, 101n, 120n), { total: 14n, count: 3 });
  assert.deepEqual(treasuryIn([], 101n, 120n), { total: 0n, count: 0 });
});

test("delayed execution: the inflow after a batch was prepared lands in the next window, never lost or doubled", () => {
  const dists = [d(90, 1n), d(110, 2n), d(125, 4n)];
  // prepared at head 100 with fundedThrough 80: covers 81..100; executed at block 120, the contract sets fundedThrough = 100
  const w1 = windowOf(80n, 100n)!;
  assert.deepEqual(treasuryIn(dists, w1.first, w1.last), { total: 1n, count: 1 });
  // the next run reads fundedThrough = 100 at head 130: 101..130 includes the inflow at 110 (and 125)
  const w2 = windowOf(100n, 130n)!;
  assert.deepEqual(treasuryIn(dists, w2.first, w2.last), { total: 6n, count: 2 });
  // two batches prepared from the same fundedThrough carry the same fromBlock: the contract runs one and rejects the
  // other as stale (fromBlock != fundedThrough), so the same window is never paid twice
  assert.equal(fundData(80n, 100n), fundData(80n, 100n));
  const { args } = decodeFunctionData({ abi: VAULTS_ABI, data: fundData(80n, 100n) });
  assert.deepEqual(args, [80n, 100n]);
});

test("half, rounded down", () => {
  assert.equal(halfOf(7n), 3n);
  assert.equal(halfOf(10n ** 18n), 5n * 10n ** 17n);
});

test("batch file: the checksum the forge writer pins for the same batch", () => {
  const json = batchJson({
    safe: SAFE, txs: [{ to: VAULTS, value: 10n ** 18n, data: "0xb60d4288" }], createdAtMs: 1_700_000_000_000,
    name: "DNA Genome Vaults: deploy", description: "CREATE2 deploy of GenomeVaults (safe, DNA, art base) through the deterministic deployer",
  });
  const parsed = JSON.parse(json);
  assert.equal(parsed.meta.checksum, "0x449db9f6690581b050e003f0d8b5757654ed9cfa2b9a9158f2cca486afce3117");
  assert.equal(parsed.meta.createdFromSafeAddress, SAFE.toLowerCase());
  assert.deepEqual(parsed.transactions, [{ to: VAULTS, value: "1000000000000000000", data: "0xb60d4288" }]);
  assert.equal(parsed.chainId, "1");
});

test("fund batch: one fund(fundedThrough, head) with the value, from the Safe", () => {
  const parsed = JSON.parse(fundBatch(SAFE, VAULTS, 123n, 100n, 130n, 1_700_000_000_000, "2 distributions"));
  assert.equal(parsed.transactions.length, 1);
  assert.equal(parsed.transactions[0].to, VAULTS);
  assert.equal(parsed.transactions[0].value, "123");
  assert.equal(parsed.transactions[0].data, fundData(100n, 130n));
  assert.match(parsed.meta.description, /blocks 101-130: 2 distributions/);
  assert.match(parsed.meta.checksum, /^0x[0-9a-f]{64}$/);
});
