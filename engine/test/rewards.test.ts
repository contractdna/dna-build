// The watchdog's idea-reward check (src/rewards.ts) on fixture records: a RewardQueued must rest on an anchored, signed
// reward record with the same payee and amount, a shipped build or a kept fee experiment written before it, the
// IdeaMarket submitter or a signed X binding in force at the queue, and a payee that is not excluded. Any mismatch (and
// a record reused for a second reward) pages the signers with cancelReward(id).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Address, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { logDigestOf } from "../src/proof.ts";
import { type BindingRecord, checkReward, type Queued, type RewardRecord, rewardWatch } from "../src/rewards.ts";
import type { Dep } from "../src/ticket-source.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const dep = { startBlock: 0, gamePot: a(0xd2), registry: a(0xd3), ideaMarket: a(0xd4) } as Dep;
const T0 = 1_800_000_000;
const BASE = "https://log.test";
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const sha = (b: Buffer) => createHash("sha256").update(b).digest();
const author = a(0xa1), stranger = a(0xa2);

/** An enclave record as /api/log/<seq> serves it: ehash = sha256(eprev ‖ sha256(body)), esig over its log digest. */
async function rec(seq: number, kind: string, ref: string, body: unknown, key = signer) {
  const b = JSON.stringify(body);
  const eprev = Buffer.alloc(32, seq);
  const ehash = sha(Buffer.concat([eprev, sha(Buffer.from(b))])).toString("hex");
  const esig = await key.signMessage({ message: { raw: `0x${logDigestOf(ehash, kind, ref)}` } });
  return { seq: String(seq), kind, ref, body: b, eprev: `0x${eprev.toString("hex")}`, ehash: `0x${ehash}`, esig };
}

/** A fixture world: records by seq, anchors by root, IdeaMarket submissions, excluded addresses. */
async function world(o: { reward?: Partial<RewardRecord>; basis?: { kind: string; body: unknown; seq?: number }; binding?: Partial<BindingRecord> | null; rewardKey?: typeof signer; tamper?: boolean } = {}) {
  const records = new Map<string, Awaited<ReturnType<typeof rec>>>();
  const basis = o.basis ?? { kind: "game", body: { verdict: "ship", build: "floor-defense" } };
  records.set(String(basis.seq ?? 10), await rec(basis.seq ?? 10, basis.kind, "build:floor-defense", basis.body));
  if (o.binding !== null) records.set("11", await rec(11, "binding", "x:777", { kind: "binding", xUserId: "777", address: author, postId: "8", at: new Date((T0 - 3600) * 1000).toISOString(), effectiveAt: new Date((T0 - 3600) * 1000).toISOString(), ...o.binding }));
  const reward: RewardRecord = { kind: "reward", idea: { source: "ideamarket", id: "5" }, to: author, amount: "200000000000000000", basis: { kind: "ship", seq: "10" }, ...o.reward };
  const r = await rec(12, "game", "reward:1", reward, o.rewardKey);
  if (o.tamper) r.body = r.body.replace("200000000000000000", "300000000000000000");
  records.set("12", r);
  const q: Queued = { id: 1n, to: author, amount: 2n * 10n ** 17n, ideaRef: r.ehash as Hex, eta: BigInt(T0 + 3600), blockNumber: 100n };
  const w = {
    anchors: new Map([[r.ehash.toLowerCase(), { uri: `${BASE}/api/log/12`, block: 90n }]]), submitted: new Map([[5n, author]]), excluded: new Set<string>(),
    queued: [q] as Queued[], paid: new Set<bigint>(), cancelled: new Set<bigint>(),
  };
  const inRange = (b: bigint, f: { fromBlock: bigint; toBlock: bigint }) => b >= f.fromBlock && b <= f.toBlock;
  const client = {
    getLogs: async (f: { event: { name: string }; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }) => {
      const args = f.args ?? {};
      if (f.event.name === "Anchored") { const x = w.anchors.get(String(args.root).toLowerCase()); return x && inRange(x.block, f) ? [{ args: { root: args.root, uri: x.uri }, blockNumber: x.block }] : []; }
      if (f.event.name === "IdeaSubmitted") { const who = w.submitted.get(args.id as bigint); return who ? [{ args: { id: args.id, author: who } }] : []; }
      if (f.event.name === "RewardQueued") return w.queued.filter((x) => inRange(x.blockNumber, f)).map((x) => ({ args: x, blockNumber: x.blockNumber }));
      if (f.event.name === "RewardPaid") return w.paid.has(args.id as bigint) ? [{ args: { id: args.id }, blockNumber: f.toBlock }] : [];
      if (f.event.name === "RewardCancelled") return w.cancelled.has(args.id as bigint) ? [{ args: { id: args.id }, blockNumber: f.toBlock }] : [];
      return [];
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(T0) + blockNumber }),
    readContract: async (c: { functionName: string; args: [Address] }) => c.functionName === "isExcluded" && w.excluded.has(c.args[0].toLowerCase()),
  } as unknown as PublicClient;
  const fetch = async (url: string) => {
    // every binding record of one X user id (the public log by ref x:<id>), oldest first
    const by = url.match(/\/api\/log\/binding\/(\d+)$/)?.[1];
    if (by) return { records: [...records.values()].filter((r) => r.ref === `x:${by}`).sort((x, y) => Number(x.seq) - Number(y.seq)) };
    const r = records.get(url.replace(`${BASE}/api/log/`, ""));
    if (!r) throw new Error(`${url}: HTTP 404`);
    return r;
  };
  const check = (over: Partial<Queued> = {}) => checkReward({ client, dep, q: { ...q, ...over }, head: 200n, lookback: 50n, fetch, logSigner: signer.address });
  return { q, w, client, fetch, check, records };
}

test("an IdeaMarket idea that shipped, paid to its submitter: backed", async () => {
  assert.deepEqual(await (await world()).check(), []);
});

test("a kept fee idea is backed; a rolled-back or rejected one never is", async () => {
  const kept = await world({ basis: { kind: "memory", body: { id: 3, decision: "accepted" } }, reward: { basis: { kind: "kept", seq: "10" } } });
  assert.deepEqual(await kept.check(), []);
  const back = await world({ basis: { kind: "memory", body: { id: 3, decision: "rolled_back" } }, reward: { basis: { kind: "kept", seq: "10" } } });
  assert.deepEqual(await back.check(), ["the experiment was not kept (memory rolled_back)"]);
  const notMemory = await world({ basis: { kind: "game", body: { decision: "accepted" } }, reward: { basis: { kind: "kept", seq: "10" } } });
  assert.equal((await notMemory.check()).length, 1, "only a memory entry counts as a kept experiment");
});

test("reward only after a ship: a rework verdict, a missing basis, or a basis written after the decision fail", async () => {
  assert.deepEqual(await (await world({ basis: { kind: "game", body: { verdict: "rework" } } })).check(), ["the build verdict is rework, not ship"]);
  assert.deepEqual(await (await world({ reward: { basis: undefined as never } })).check(), ["the reward names no shipped build or kept experiment"]);
  const late = await world({ basis: { kind: "game", body: { verdict: "ship" }, seq: 13 }, reward: { basis: { kind: "ship", seq: "13" } } });
  assert.deepEqual(await late.check(), ["the ship record comes after the reward decision"]);
});

test("the record must be the anchored, signed one, with the queue's payee and amount", async () => {
  assert.deepEqual(await (await world({ rewardKey: other })).check(), ["the reward record is not signed by the log signer"], "bad signature");
  assert.deepEqual(await (await world({ tamper: true })).check(), ["the reward record's enclave hash does not recompute", "the record says 300000000000000000 wei, the queue 200000000000000000 wei"]);
  const unanchored = await world();
  unanchored.w.anchors.clear();
  assert.match((await unanchored.check())[0], /no reward record anchored/);
  assert.deepEqual(await (await world({ reward: { to: stranger } })).check(), [`the record pays ${stranger}, the queue pays ${author}`]);
  assert.deepEqual(await (await world({ reward: { amount: "1" } })).check(), ["the record says 1 wei, the queue 200000000000000000 wei"]);
});

test("IdeaMarket ideas pay the on-chain submitter only", async () => {
  const w = await world();
  w.w.submitted.set(5n, stranger);
  assert.deepEqual(await w.check(), [`IdeaMarket idea 5 was submitted by ${stranger}, not ${author}`]);
  w.w.submitted.clear();
  assert.deepEqual(await w.check(), ["IdeaMarket idea 5 was never submitted"]);
});

test("X ideas pay the author's signed binding, by X user id, the one in force at the queue (not only the cited one)", async () => {
  const x = { idea: { source: "x" as const, authorId: "777", postId: "9" }, binding: "11" };
  const bind = (seq: number, address: Address, atS: number, effS = atS, key = signer) =>
    rec(seq, "binding", "x:777", { kind: "binding", xUserId: "777", address, postId: "8", at: new Date(atS * 1000).toISOString(), effectiveAt: new Date(effS * 1000).toISOString() }, key);
  assert.deepEqual(await (await world({ reward: x })).check(), []);
  assert.deepEqual(await (await world({ reward: x, binding: { xUserId: "778" } })).check(), ["the cited binding 11 is not a signed binding of X user 777", "no binding of the author was in force at the queue"], "another account's binding (by user id, never the handle)");
  assert.deepEqual(await (await world({ reward: x, binding: { address: stranger } })).check(), [`the binding in force at the queue pays ${stranger}, the queue pays ${author}`]);
  assert.deepEqual(await (await world({ reward: { idea: x.idea } })).check(), ["an X idea with no binding record"]);
  // the author rebound since the reward was decided: the rebinding is in force at the queue → page, though the cited one matches
  const rebound = await world({ reward: x });
  rebound.records.set("13", await bind(13, stranger, T0 - 3000, T0 + 50)); // the queue's block is at T0 + 100
  assert.deepEqual(await rebound.check(), [`the binding in force at the queue pays ${stranger}, the queue pays ${author}`, "the reward cites binding 11, the one in force at the queue is 13"]);
  // a rebinding still inside its 48 h is not in force: the earlier binding still is
  const waiting = await world({ reward: x });
  waiting.records.set("13", await bind(13, stranger, T0 - 3000, T0 + 48 * 3600));
  assert.deepEqual(await waiting.check(), [], "the queue pays the binding in force; the pending one is not yet");
  const forged = await world({ reward: x });
  forged.records.set("11", await bind(11, author, T0 - 3600, T0 - 3600, other));
  assert.deepEqual(await forged.check(), ["the binding record is not signed by the log signer", "the cited binding 11 is not a signed binding of X user 777", "no binding of the author was in force at the queue"]);
});

test("an excluded payee is a mismatch", async () => {
  const w = await world();
  w.w.excluded.add(author.toLowerCase());
  assert.deepEqual(await w.check(), [`${author} is excluded`]);
});

test("a record backs one live reward: reused while the first is open or paid is a mismatch; after a Safe cancel it is free", async () => {
  const w = await world();
  w.w.queued.push({ ...w.q, id: 2n, blockNumber: 110n }); // the same record queued again
  assert.deepEqual(await w.check({ id: 2n, blockNumber: 110n }), ["its reward record already backs reward #1 (still open)"]);
  w.w.paid.add(1n);
  assert.deepEqual(await w.check({ id: 2n, blockNumber: 110n }), ["its reward record already backs reward #1 (paid)"]);
  w.w.paid.clear();
  w.w.cancelled.add(1n);
  assert.deepEqual(await w.check({ id: 2n, blockNumber: 110n }), [], "vetoed by the Safe: the record is free again");
  assert.deepEqual(await w.check(), [], "the first reward itself is not a reuse");
});

test("every log read before the queue is bounded by the lookback", async () => {
  const w = await world();
  w.w.queued.unshift({ ...w.q, id: 0n, blockNumber: 40n }); // an older reward on the same record, beyond the lookback (100 − 50)
  assert.deepEqual(await w.check(), [], "not seen");
  w.w.anchors.get(w.q.ideaRef.toLowerCase())!.block = 40n;
  assert.match((await w.check())[0], /no reward record anchored/, "an anchor older than the lookback is not found");
});

test("the loop: checks run in the background, once each; a mismatch pages cancelReward; trouble retries with backoff, then pages 'not verified'", async () => {
  const w = await world();
  const pages: string[] = [];
  let t = T0 * 1000;
  w.w.queued = [w.q, { ...w.q, id: 2n, blockNumber: 101n }]; // the second reuses the first one's record
  const cfg = { pollMs: 60_000, repeatMs: 5 * 60_000, verifyDeadlineS: 30 * 60, lookbackBlocks: 50n };
  const rw = rewardWatch({ clients: [w.client], dep, page: async (x) => { pages.push(x); }, logSigner: signer.address, fetch: w.fetch, now: () => t, cfg });
  await rw.tick(0n, 101n);
  await rw.settled();
  assert.deepEqual(pages.slice().sort(), [
    "Idea reward #1 checked: the signed record, its basis and the payee match the queue.",
    `🚨 IDEA REWARD #2 MISMATCH — its reward record already backs reward #1 (still open). Safe: cancelReward(2) on GamePot ${dep.gamePot} before ${new Date((T0 + 3600) * 1000).toISOString()}.`,
  ]);
  assert.deepEqual(rw.open(), []);
  w.w.queued = [];
  await rw.tick(102n, 110n);
  await rw.settled();
  assert.equal(pages.length, 2, "checked once");
  // a check that never answers never blocks the tick; at the deadline: one page
  const hung = rewardWatch({ clients: [w.client], dep, page: async (x) => { pages.push(x); }, now: () => t, cfg, check: () => new Promise(() => {}) });
  w.w.queued = [{ ...w.q, id: 3n }];
  await Promise.race([hung.tick(0n, 100n), new Promise((_, rej) => setTimeout(() => rej(new Error("tick blocked on a check")), 2_000))]);
  assert.deepEqual(hung.open(), [3]);
  t += 30 * 60_000;
  await hung.tick(101n, 110n);
  assert.match(pages[2], /^🚨 IDEA REWARD #3 NOT VERIFIED IN 30 MIN — the check is still running\. Safe: cancelReward\(3\)/);
  await hung.tick(111n, 120n);
  assert.equal(pages.length, 3, "paged once");
  // the log API is down: retried with backoff (2, 4, then at most every 5 minutes), dropped once payable
  t = T0 * 1000;
  let calls = 0;
  const down = rewardWatch({ clients: [w.client], dep, page: async (x) => { pages.push(x); }, now: () => t, cfg, check: async () => { calls++; throw new Error("HTTP 503"); } });
  w.w.queued = [{ ...w.q, id: 4n }];
  const at: number[] = [];
  for (let k = 0; k < 12; k++) {
    const before = calls;
    await down.tick(0n, 100n);
    await down.settled();
    if (calls > before) at.push(k);
    t += 60_000;
  }
  assert.deepEqual(at, [0, 2, 6, 11]);
  t = (T0 + 3601) * 1000;
  await down.tick(121n, 130n);
  await down.settled();
  await down.tick(131n, 140n);
  assert.deepEqual(down.open(), [], "payable: nothing left to veto");
});
