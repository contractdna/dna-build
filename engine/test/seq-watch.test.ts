// The watchdog's Sequencer checks (src/seq-watch.ts): a game deploy, a queued game fund and a move of `release` each
// need a record signed by the enclave's log key; anything else pages the Safe signers with the way to stop it. One
// game taking ≥ 40% of the weekly budget pages too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainHash, GENESIS, logDigest } from "../src/log.ts";
import { heavyGames, seqWatch } from "../src/seq-watch.ts";

const key = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const dep = { gameFactory: a(0xfa), gameFunder: a(0xf0), delay: a(0xde), safe: a(0x5a) };
const E = 10n ** 18n;

async function signed(kind: string, ref: string, body: unknown, by = key, seq = "7") {
  const text = JSON.stringify(body);
  const ehash = chainHash(GENESIS, text).toString("hex");
  return { seq, kind, ref, body: text, eprev: `0x${GENESIS.toString("hex")}`, ehash: `0x${ehash}`, esig: await by.signMessage({ message: { raw: `0x${logDigest(ehash, kind, ref)}` } }) };
}

const owners = [privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"), privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba")];

function setup(o: { ships?: unknown[]; funds?: unknown[]; releases?: unknown[]; vetoes?: unknown[]; approves?: unknown[]; kills?: unknown[]; bySeq?: Record<string, unknown>; release?: string } = {}) {
  const logs = { deployed: [] as unknown[], added: [] as unknown[], funded: [] as unknown[] };
  const client = {
    getLogs: async (q: { address: string; event: { name: string } }) => (q.event.name === "GameDeployed" ? logs.deployed : q.event.name === "TransactionAdded" ? logs.added : logs.funded),
    readContract: async (q: { functionName: string }) => (q.functionName === "getOwners" ? owners.map((x) => x.address) : E / 5n),
    getChainId: async () => 1,
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  } as unknown as PublicClient;
  const pages: string[] = [];
  let head = o.release ?? "aaa";
  let clock = Date.now();
  const w = seqWatch({
    client, dep, page: async (t) => { pages.push(t); }, logSigner: key.address, base: "https://site", now: () => (clock += 600_000),
    fetch: async (url) => {
      const seq = url.match(/\/api\/log\/(\d+)$/)?.[1];
      if (seq) return o.bySeq?.[seq];
      return { records: url.endsWith("/ship") ? o.ships ?? [] : url.endsWith("/fund") ? o.funds ?? [] : url.endsWith("/veto") ? o.vetoes ?? [] : url.endsWith("/approve") ? o.approves ?? [] : url.endsWith("/page-kill") ? o.kills ?? [] : o.releases ?? [] };
    },
    releaseHead: async () => head,
  });
  return { w, logs, pages, setHead: (s: string) => { head = s; } };
}

test("a game deploy needs a signed ship record with its address and code hash", async () => {
  const ship = await signed("ship", "ship:b1", { predicted: a(0x61), codehash: h(1) });
  const forged = await signed("ship", "ship:b2", { predicted: a(0x62), codehash: h(2) }, other);
  const s = setup({ ships: [ship, forged] });
  s.logs.deployed = [{ args: { game: a(0x61), codehash: h(1) } }, { args: { game: a(0x62), codehash: h(2) } }, { args: { game: a(0x63), codehash: h(3) } }];
  await s.w.tick(1n, 10n);
  assert.equal(s.pages.length, 2, "a matching deploy stays quiet (a restart reads it again)");
  assert.match(s.pages[0], /WITHOUT A SIGNED SHIP RECORD.*0x0+62/, "signed by another key");
  assert.match(s.pages[1], /factory\.retire\(0x0+63\)/);
});

test("a queued game fund needs a signed fund record with its tx and Delay nonce", async () => {
  const fund = await signed("fund", "fund:x", { tx: h(0xaa), delayNonce: "4" });
  const s = setup({ funds: [fund] });
  s.logs.added = [
    { args: { queueNonce: 4n, to: dep.gameFunder }, transactionHash: h(0xaa) },
    { args: { queueNonce: 5n, to: dep.gameFunder }, transactionHash: h(0xbb) },
    { args: { queueNonce: 6n, to: a(0x99) }, transactionHash: h(0xcc) }, // not a game fund
  ];
  await s.w.tick(1n, 10n);
  assert.equal(s.pages.length, 1);
  assert.match(s.pages[0], /Delay nonce 5.*setTxNonce\(6\)/);
});

test("release may only move to a commit with a signed release record whose hour is over", async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 3600_000 * 5).toISOString();
  const s = setup({ releases: [await signed("release", "release:bbb", { sha: "bbb", effectiveAt: past }), await signed("release", "release:ccc", { sha: "ccc", effectiveAt: future })] });
  await s.w.tick(1n, 1n); // first read: the starting point
  assert.equal(s.pages.length, 0);
  s.setHead("bbb");
  await s.w.tick(2n, 2n);
  assert.match(s.pages[0], /release record/);
  s.setHead("ccc");
  await s.w.tick(3n, 3n);
  assert.match(s.pages[1], /WITHOUT A SIGNED RELEASE RECORD IN EFFECT.*Revert the release branch to bbb/);
});

test("release moved to a ship's merge that 2 Safe owners vetoed pages; one veto does not", async () => {
  const { ownerDigestOn, targetKey, targetOf } = await import("../src/owner-sig.ts");
  const past = new Date(Date.now() - 1000).toISOString();
  const ship = await signed("ship", "ship:b9", { kind: "ship", predicted: a(0x61) }, key, "41");
  const t = targetOf({ kind: ship.kind, ref: ship.ref, body: ship.body });
  const veto = async (by: (typeof owners)[number]) => signed("veto", targetKey(t), { target: t, signature: await by.signMessage({ message: { raw: `0x${ownerDigestOn("veto", t, { chainId: 1, safe: dep.safe, enclave: key.address })}` } }) });
  const release = await signed("release", "release:ddd", { sha: "ddd", ship: "41", build: "b9", effectiveAt: past });
  for (const [vetoes, want] of [[[await veto(owners[0])], /release record/], [[await veto(owners[0]), await veto(owners[1])], /VETOED SHIP/]] as const) {
    const s = setup({ releases: [release], vetoes: [...vetoes], bySeq: { 41: ship } });
    await s.w.tick(1n, 1n);
    s.setHead("ddd");
    await s.w.tick(2n, 2n);
    assert.match(s.pages[0], want);
  }
});

test("release moved to a held record (needApprovals) pages unless a current owner approved it", async () => {
  const { ownerDigestOn, targetKey, targetOf } = await import("../src/owner-sig.ts");
  const past = new Date(Date.now() - 1000).toISOString();
  const held = await signed("release", "release:eee", { sha: "eee", needApprovals: 1, bad: ["bad1"], effectiveAt: past }, key, "50");
  const t = targetOf({ kind: held.kind, ref: held.ref, body: held.body });
  const approve = async (by: ReturnType<typeof privateKeyToAccount>) => signed("approve", targetKey(t), { target: t, signature: await by.signMessage({ message: { raw: `0x${ownerDigestOn("approve", t, { chainId: 1, safe: dep.safe, enclave: key.address })}` } }) });
  for (const [approves, want] of [[[], /HELD RECORD WITHOUT AN OWNER APPROVAL/], [[await approve(key)], /HELD RECORD WITHOUT AN OWNER APPROVAL/], [[await approve(owners[2])], /release record 50/]] as const) {
    const s = setup({ releases: [held], approves: [...approves] });
    await s.w.tick(1n, 1n);
    s.setHead("eee");
    await s.w.tick(2n, 2n);
    assert.match(s.pages[0], want);
  }
});

test("a release made by a page kill needs the signed page-kill record it names, for the same page", async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const rel = await signed("release", "release:fff", { kind: "release", sha: "fff", pageKill: "60", slug: "dice-9", effectiveAt: past }, key, "61");
  const kill = await signed("page-kill", "dice-9", { kind: "page-kill", slug: "dice-9", why: "x" }, key, "60");
  const elsewhere = await signed("page-kill", "other-1", { kind: "page-kill", slug: "other-1", why: "x" }, key, "60");
  const forged = await signed("page-kill", "dice-9", { kind: "page-kill", slug: "dice-9", why: "x" }, other, "60");
  for (const [kills, want] of [[[kill], /release record 61/], [[], /PAGE KILL WITHOUT ITS SIGNED page-kill RECORD/], [[elsewhere], /PAGE KILL WITHOUT/], [[forged], /PAGE KILL WITHOUT/]] as const) {
    const s = setup({ releases: [rel], kills: [...kills] });
    await s.w.tick(1n, 1n);
    s.setHead("fff");
    await s.w.tick(2n, 2n);
    assert.match(s.pages[0], want);
  }
});

test("one game with ≥ 40% of the weekly budget in the rolling week pages", () => {
  const now = Date.now();
  const rows = [{ game: a(1), amount: E / 20n, at: now - 1000 }, { game: a(1), amount: E / 20n, at: now - 2000 }, { game: a(2), amount: E / 20n, at: now }, { game: a(2), amount: E / 10n, at: now - 8 * 86_400_000 }];
  assert.deepEqual(heavyGames(rows, E / 5n, now).map((x) => x.game), [a(1).toLowerCase()]);
});
