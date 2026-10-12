import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseEventLogs, toEventSelector, zeroAddress, type AbiEvent, type AbiParameter, type Address, type Log } from "viem";
import * as abis from "../src/abi.ts";
import { gameFactoryAbi, gameKitAbi } from "../src/abi.ts";
import { BALANCES, GAS } from "../src/config.ts";
import { decodeQueued, feedPayload, gameLogs, isRangeError, jsonSafe, logRow, nextRange, notifiable, OPS, type Row } from "../src/lib.ts";

test("balance alerts: below the launch funding (a freshly funded key never alerts); agent and keeper keep one emergency rollback, the keeper also one worst settle", () => {
  const funded = { agent: 0.06, anchor: 0.01, keeper: 0.3 };
  for (const [k, f] of Object.entries(funded) as [keyof typeof funded, number][]) {
    assert.ok(BALANCES[k].min < BALANCES[k].alert && BALANCES[k].alert < f, k);
  }
  const rollback = (214_355 * GAS.emergencyMaxGwei) / 1e9; // breaker rollback(Fee) at the emergency gas cap, ETH
  for (const k of ["agent", "keeper"] as const) assert.ok(BALANCES[k].min >= rollback, `${k}: min ${BALANCES[k].min} ≥ ${rollback}`);
  const settle = (1_800_000 * GAS.maxGwei) / 1e9; // a settle at its gas floor (games.ts SETTLE_GAS_MIN) at MAX_GWEI
  assert.ok(BALANCES.keeper.min >= rollback + settle, `keeper: min ${BALANCES.keeper.min} ≥ ${rollback + settle}`);
  assert.equal(GAS.dailyCapEth.keeper, 0.3, "the keeper's daily budget");
});

test("jsonSafe turns bigints into decimal strings, deeply", () => {
  assert.deepEqual(jsonSafe({ a: 1n, b: [2n, { c: 3n }], d: "x", e: true }), { a: "1", b: ["2", { c: "3" }], d: "x", e: true });
});

test("nextRange clamps to the last block and walks the cursor with halving", () => {
  assert.deepEqual(nextRange(0n, 100n, 10_000n), { from: 0n, to: 100n });
  assert.deepEqual(nextRange(5n, 100n, 10n), { from: 5n, to: 14n });
  // simulate the indexer loop: ranges > 3 blocks fail with a range error until the window halves to 2
  let from = 0n, window = 16n;
  const seen: [bigint, bigint][] = [];
  while (from <= 9n) {
    const r = nextRange(from, 9n, window);
    if (r.to - r.from + 1n > 3n) { window /= 2n; continue; }
    seen.push([r.from, r.to]);
    from = r.to + 1n;
  }
  assert.deepEqual(seen, [[0n, 1n], [2n, 3n], [4n, 5n], [6n, 7n], [8n, 9n]]); // contiguous, no gaps, no overlap
});

test("isRangeError matches provider limits, not transient failures", () => {
  for (const m of [
    "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range",
    "ranges over 10000 blocks are not supported on freemium",
    "query returned more than 10000 results",
    "eth_getLogs is limited to a 10,000 range",
    "block range is too large",
    "HTTP response body exceeded the size limit.", // viem's 10 MB cap on one getLogs response
  ]) assert.ok(isRangeError(new Error(m)), m);
  for (const m of [
    "fetch failed", "HTTP request failed. Status: 502", "socket hang up",
    // Alchemy rate limits: retry later, never shrink the window
    "Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message.",
    "Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy",
  ]) assert.ok(!isRangeError(new Error(m)), m);
  assert.ok(isRangeError(new Error("query exceeds max block range 100000")));
  assert.ok(isRangeError({ details: "block range too wide" }));
});

test("decodeQueued reads the target of each op", () => {
  const m = "0x0D34aB0a4FF78c036A52E2E55183C340bC38d3Dc";
  const reg = encodeAbiParameters(
    [{ type: "address" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32[4]" }, { type: "bytes32[4]" }, { type: "bytes32[4]" }],
    [m, 0, `0x${"11".repeat(32)}`, Array(4).fill(`0x${"00".repeat(32)}`) as never, Array(4).fill(`0x${"00".repeat(32)}`) as never, Array(4).fill(`0x${"00".repeat(32)}`) as never],
  );
  assert.deepEqual(decodeQueued(0, reg), { target: m });
  assert.deepEqual(decodeQueued(2, encodeAbiParameters([{ type: "address" }, { type: "uint64" }, { type: "uint32" }, { type: "uint32" }], [m, 7n, 1000, 500])), { target: m });
  assert.deepEqual(decodeQueued(7, encodeAbiParameters([{ type: "uint8" }], [6])), { level: 6 });
  assert.deepEqual(decodeQueued(8, "0x"), {});
  const h = `0x${"ab".repeat(32)}` as const;
  const zero = Array(4).fill(`0x${"00".repeat(32)}`) as never;
  assert.deepEqual(decodeQueued(9, encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32[4]" }, { type: "bytes32[4]" }], [h, 0, zero, zero])), { target: h });
  assert.deepEqual(decodeQueued(10, encodeAbiParameters([{ type: "bytes32" }], [h])), { target: h });
  assert.deepEqual(decodeQueued(10, "0x12"), {}); // malformed: no throw
  assert.equal(OPS[9], "ApproveCodehash");
  assert.equal(OPS[10], "RevokeCodehash");
  assert.deepEqual(decodeQueued(1, "0x1234"), {}); // malformed: no throw
});

const row = (over: Partial<Row>): Row => ({
  block: 1, log_index: 0, tx: "0x", block_hash: "0x", at: new Date(), address: "0x", event: "RolledBack", args: {}, ...over,
});

test("notifiable: feed events only, fresh relative to the finalized tip (no backfill replay)", () => {
  const tip = Date.now() - 13 * 60_000; // mainnet: the finalized tip itself is ~13 min behind the wall clock
  assert.ok(notifiable(row({ at: new Date(tip) }), tip)); // at the tip: notified despite the finality lag
  assert.ok(!notifiable(row({ at: new Date(tip - 13 * 60_000) }), tip)); // 13 min behind the tip: backfill
  assert.ok(!notifiable(row({ at: new Date(tip - 6 * 60_000) }), tip));
  assert.ok(!notifiable(row({ event: "Swap", at: new Date(tip) }), tip)); // swaps come from the head tier
  assert.ok(!notifiable(row({ event: "FeeTaken", at: new Date(tip) }), tip));
});

test("feedPayload stays under the NOTIFY 8000-byte cap", () => {
  const small = JSON.parse(feedPayload(row({ args: { id: "1" } })));
  assert.equal(small.args.id, "1");
  const big = feedPayload(row({ event: "Queued", args: { data: "0x" + "ab".repeat(5000) } }));
  assert.ok(big.length < 8000);
  assert.deepEqual(JSON.parse(big).args, {});
});

test("games: the factory's events, then the kit events of known games and of games deployed in the same range", async () => {
  const factory = "0x00000000000000000000000000000000000000fa" as Address;
  const old = "0x00000000000000000000000000000000000000A1" as Address, fresh = "0x00000000000000000000000000000000000000b2" as Address;
  const player = "0x00000000000000000000000000000000000000cc" as Address;
  const h32 = `0x${"11".repeat(32)}` as const;
  let i = 0;
  const log = (address: Address, topics: readonly unknown[], data: `0x${string}`) =>
    ({ address, topics, data, blockNumber: 7n, logIndex: i++, transactionHash: h32, blockHash: h32, transactionIndex: 0, removed: false }) as unknown as Log;
  const deployed = log(factory, encodeEventTopics({ abi: gameFactoryAbi, eventName: "GameDeployed", args: { game: fresh } }),
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [h32, h32]));
  const played = (g: Address) => log(g, encodeEventTopics({ abi: gameKitAbi, eventName: "Played", args: { player } }), encodeAbiParameters([{ type: "uint256" }], [5n]));
  const stray = log(old, [`0x${"22".repeat(32)}`], "0x"); // a game's own event: not decoded
  const asked: (Address | Address[])[] = [];
  const getLogs = async (a: { address: Address | Address[] }) => {
    asked.push(a.address);
    return a.address === factory ? [deployed] : [played(old), played(fresh), stray];
  };
  const out = await gameLogs(factory, 1n, 9n, getLogs, async () => [old]);
  assert.deepEqual(out.map((l) => l.eventName), ["GameDeployed", "Played", "Played"]);
  assert.deepEqual(asked, [factory, [old.toLowerCase(), fresh.toLowerCase()]], "the factory first, then every game (lowercased, no duplicates)");
  asked.length = 0;
  assert.deepEqual(await gameLogs(factory, 1n, 9n, async (a) => (asked.push(a.address), []), async () => []), []);
  assert.deepEqual(asked, [factory], "no games yet: one call");
});

// A log of `ev` with every argument at its zero value (an indexed argument is a zero topic).
const zero = (p: AbiParameter): unknown => {
  const arr = p.type.match(/^(.*)\[(\d*)\]$/);
  if (arr) return arr[2] ? Array.from({ length: Number(arr[2]) }, () => zero({ ...p, type: arr[1]! })) : [];
  if (p.type === "tuple") return (p as { components: readonly AbiParameter[] }).components.map(zero);
  if (p.type === "address") return zeroAddress;
  if (p.type === "bool") return false;
  if (p.type === "string") return "";
  if (p.type === "bytes") return "0x";
  if (p.type.startsWith("bytes")) return `0x${"00".repeat(Number(p.type.slice(5)))}`;
  return 0n; // (u)intN
};
const H32 = `0x${"11".repeat(32)}` as const;
const zeroLog = (address: Address, ev: AbiEvent) => {
  const inputs = ev.inputs as readonly (AbiParameter & { indexed?: boolean })[];
  const body = inputs.filter((p) => !p.indexed);
  const topics = [toEventSelector(ev), ...inputs.filter((p) => p.indexed).map(() => `0x${"00".repeat(32)}`)];
  const data = encodeAbiParameters(body, body.map(zero) as never);
  return { address, topics, data, blockNumber: 7n, logIndex: 0, transactionHash: H32, blockHash: H32, transactionIndex: 0, removed: false } as unknown as Log;
};
const AT = new Date(1_700_000_000_000);

test("chain_log rows: a game's Retired() (no arguments) indexes end to end with args {}", async () => {
  const factory = "0x00000000000000000000000000000000000000fa" as Address, game = "0x00000000000000000000000000000000000000a1" as Address;
  const retired = gameKitAbi.find((x) => x.type === "event" && x.name === "Retired") as AbiEvent;
  assert.equal(retired.inputs.length, 0, "Retired() has no arguments");
  const logs = await gameLogs(factory, 1n, 9n, async (a) => (a.address === factory ? [] : [zeroLog(game, retired)]), async () => [game]);
  assert.deepEqual(logs.map((l) => l.eventName), ["Retired"]);
  const r = logRow(logs[0]!, AT);
  assert.deepEqual(r, { block: 7, log_index: 0, tx: H32, block_hash: H32, at: AT, address: game, event: "Retired", args: {} }, "args never undefined: chain_log.args is jsonb not null");
  assert.equal(JSON.parse(feedPayload(r)).event, "Retired");
});

test("chain_log rows: every event of every ABI (zero-argument and unnamed-argument ones included) makes a JSON-safe row", () => {
  const address = "0x00000000000000000000000000000000000000AB" as Address;
  const events = Object.entries(abis).filter(([, a]) => Array.isArray(a)).flatMap(([name, a]) => (a as readonly { type: string }[]).filter((x): x is AbiEvent => x.type === "event").map((ev) => [name, ev] as const));
  const bare = events.filter(([, ev]) => ev.inputs.length === 0 || ev.inputs.some((p) => !p.name));
  assert.ok(bare.some(([, ev]) => ev.name === "Retired"), "the zero-argument events are in the set");
  for (const [name, ev] of events) {
    const [l] = parseEventLogs({ abi: [ev], logs: [zeroLog(address, ev)] });
    assert.ok(l, `${name}.${ev.name} decodes`);
    const r = logRow(l, AT);
    assert.equal(r.event, ev.name);
    assert.equal(r.address, address.toLowerCase());
    assert.ok(r.args !== null && typeof r.args === "object", `${name}.${ev.name}: args is an object`);
    assert.deepEqual(JSON.parse(JSON.stringify(r.args)), r.args, `${name}.${ev.name}: args survive JSON (no bigint, no undefined)`);
  }
});
