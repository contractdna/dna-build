// The Sequencer's games on /play: what the generic panel offers from a game's ABI (gameAbi.ts), and that an ABI is
// taken only from the game.json blob its ship record names (gameSource.ts).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { panelOf, parseArg, showValue } from "../app/play/gameAbi.ts";
import { abiFrom, abiOf, blobSha } from "../app/play/gameSource.ts";

const checkin = JSON.parse(readFileSync(new URL("../app/g/_template-daily-checkin/game.json", import.meta.url), "utf8"));
const names = (fs) => fs.map((f) => f.name).sort();

test("panel: a player's calls only (no admin, no payable); a retired game only its claim", () => {
  const p = panelOf(checkin.abi, false);
  assert.deepEqual(names(p.actions), ["checkIn", "claim", "collect", "release", "settle"]);
  for (const admin of ["fund", "pause", "retire", "sweep"]) assert.ok(!p.actions.some((f) => f.name === admin), admin);
  assert.ok(p.state.some((f) => f.name === "freeBalance") && p.state.every((f) => f.inputs.length === 0));
  assert.deepEqual(names(p.reads), ["dayOf", "owed", "statusOf"]);
  assert.deepEqual(names(panelOf(checkin.abi, true).actions), ["claim"]);
  const odd = [{ type: "function", name: "many", inputs: [{ type: "uint256[]" }], outputs: [], stateMutability: "nonpayable" }, { type: "function", name: "pay", inputs: [], outputs: [], stateMutability: "payable" }];
  assert.deepEqual(panelOf(odd, false).actions, [], "arrays and payable functions are never offered");
});

test("parseArg: typed text to call arguments, or the reason it can't be", () => {
  assert.deepEqual(parseArg("uint256", " 42 "), { ok: true, value: 42n });
  assert.equal(parseArg("uint256", "-1").ok, false);
  assert.equal(parseArg("uint256", "1e18").ok, false);
  assert.deepEqual(parseArg("int8", "-3"), { ok: true, value: -3n });
  assert.deepEqual(parseArg("bool", "true"), { ok: true, value: true });
  assert.equal(parseArg("bool", "yes").ok, false);
  assert.equal(parseArg("address", "0x" + "ab".repeat(20)).ok, true);
  assert.equal(parseArg("address", "0x1234").ok, false);
  assert.equal(parseArg("bytes32", "0x" + "00".repeat(32)).ok, true);
  assert.equal(parseArg("bytes32", "0x00").ok, false);
  assert.equal(parseArg("tuple", "x").ok, false);
});

test("showValue: kit amounts in ETH, times with their date", () => {
  assert.equal(showValue("freeBalance", 10n ** 17n), "0.1 ETH");
  assert.match(showValue("endsAt", 1_760_000_000n), /^1760000000 \(.+GMT\)$/);
  assert.equal(showValue("COUNTDOWN", 3600n), "3600");
  assert.equal(showValue("dayOf", [1n, true]), "1, true");
});

const game = { slug: "check-in", title: "Check-in", chainId: 1, address: "0x" + "12".repeat(20), codehash: "0x" + "34".repeat(32), abi: checkin.abi };
const bytes = new TextEncoder().encode(JSON.stringify(game));
const ship = { slug: "check-in", title: "Check-in", predicted: game.address, codehash: game.codehash, gatedSha: "a".repeat(40), treeHashes: { "web/app/g/check-in/game.json": `100644:${blobSha(bytes)}` } };

test("blobSha is git's object id", () => {
  const b = new TextEncoder().encode("hello\n");
  assert.equal(blobSha(b), execFileSync("git", ["hash-object", "--stdin"], { input: b }).toString().trim());
});

test("abiFrom: only the blob the ship record lists, for its own address and code hash", () => {
  assert.deepEqual(abiFrom(bytes, ship), checkin.abi);
  assert.equal(abiFrom(new TextEncoder().encode(JSON.stringify({ ...game, abi: [] })), ship), null, "other bytes");
  assert.equal(abiFrom(bytes, { ...ship, treeHashes: {} }), null, "no listed blob");
  const other = new TextEncoder().encode(JSON.stringify({ ...game, address: "0x" + "56".repeat(20) }));
  assert.equal(abiFrom(other, { ...ship, treeHashes: { "web/app/g/check-in/game.json": `100644:${blobSha(other)}` } }), null, "another address");
});

test("abiOf: the gated commit first, then release; a wrong blob is never taken", async () => {
  const urls = [];
  const get = (body) => async (u) => { urls.push(u); return new Response(body); };
  const miss = { ...ship, treeHashes: { "web/app/g/check-in/game.json": `100644:${"0".repeat(40)}` } };
  assert.equal(await abiOf(miss, get(bytes)), null);
  assert.deepEqual(urls, [
    `https://raw.githubusercontent.com/contractdna/dna-build/${"a".repeat(40)}/web/app/g/check-in/game.json`,
    "https://raw.githubusercontent.com/contractdna/dna-build/release/web/app/g/check-in/game.json",
  ]);
  assert.equal(await abiOf(miss, get(bytes)), null);
  assert.equal(urls.length, 2, "a miss is kept a minute: no fetch on every render");
  assert.deepEqual(await abiOf(ship, get(bytes)), checkin.abi);
  assert.equal(await abiOf({ ...ship, slug: "../x" }, get(bytes)), null, "a bad slug is never fetched");
});
