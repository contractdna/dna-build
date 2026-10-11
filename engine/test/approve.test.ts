// Owner-signature approvals and vetoes on delayed actions: who counts, what a signature binds to, when an action is in
// effect.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { approvalsNeeded, type Chain, type Deps, draftApproverOf, effective, firstPerSigner, ownerDigest, ownerSigners, rowOf, safeOwners, type Target, targetKey, targetOf, vetoed } from "../src/approve.ts";
import { signerOf } from "../src/signed.ts";
import { canonical } from "../src/log.ts";

const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const [o1, o2, o3, stranger] = [1, 2, 3, 4].map((n) => privateKeyToAccount(key(n)));
const owners = [o1, o2, o3].map((a) => a.address);
const sign = (a: typeof o1, kind: "approve" | "veto", t: Target, chain?: Chain) => a.signMessage({ message: { raw: `0x${ownerDigest(kind, t, chain)}` } });

const T = Date.parse("2026-10-08T12:00:00Z");
const swapDoc = { kind: "model-change", id: "brain-1", role: "brain", from: "claude-fable-5-1", to: "claude-opus-5-5", effectiveAt: new Date(T).toISOString(), needApprovals: 2 };
const swap = rowOf("model-change", "brain", swapDoc);
const other = rowOf("model-change", "brain", { ...swapDoc, id: "brain-2" });
const t = targetOf(swap);
const at = (chainId: number, safe: string, enclave: string): Chain => ({ chainId, safe: `0x${safe.repeat(20)}`, enclave: `0x${enclave.repeat(20)}` });

function deps(sigs: { approve?: string[]; veto?: string[] }, o: { now?: number; paused?: boolean } = {}): Deps {
  return { now: () => o.now ?? T + 1, owners: async () => owners, paused: async () => o.paused ?? false, signatures: async (kind) => sigs[kind] ?? [] };
}

test("digest: binds kind, ref, the stored body bytes, the chain, the Safe and the enclave; approve and veto domains differ", () => {
  assert.equal(t.bodyHash, createHash("sha256").update(canonical(swapDoc)).digest("hex"), "sha256 of the body text the log stores");
  assert.equal(swap.body, canonical({ ...swapDoc }), "canonical: key order does not matter");
  const d = ownerDigest("approve", t);
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.notEqual(ownerDigest("veto", t), d);
  assert.notEqual(ownerDigest("approve", targetOf(other)), d, "another body");
  assert.notEqual(ownerDigest("approve", { ...t, ref: "intake" }), d, "another ref");
  assert.notEqual(ownerDigest("approve", { ...t, kind: "brain" }), d, "another kind");
  assert.notEqual(ownerDigest("approve", t, at(8453, "5a", "e1")), ownerDigest("approve", t, at(1, "5a", "e1")), "another chain");
  assert.notEqual(ownerDigest("approve", t, at(1, "5a", "e1")), ownerDigest("approve", t, at(1, "5b", "e1")), "another Safe");
  assert.notEqual(ownerDigest("approve", t, at(1, "5a", "e1")), ownerDigest("approve", t, at(1, "5a", "e2")), "another enclave (a fork run with the same Safe)");
  assert.throws(() => ownerDigest("approve", t, { ...at(1, "5a", "e1"), enclave: "0x12" }), /not an address/);
  assert.match(targetKey(t), /^[0-9a-f]{64}$/);
  assert.notEqual(targetKey(t), targetKey(targetOf(other)));
});

test("owner signers: valid owners counted once; non-owners, garbage and other records' or chains' signatures are not", async () => {
  const s1 = await sign(o1, "approve", t);
  assert.deepEqual(await ownerSigners("approve", t, [s1], owners), [o1.address.toLowerCase()]);
  assert.deepEqual(await ownerSigners("approve", t, [s1, s1], owners), [o1.address.toLowerCase()], "a duplicate signer counts once");
  assert.deepEqual(await ownerSigners("approve", t, [await sign(stranger, "approve", t)], owners), [], "not a Safe owner");
  assert.deepEqual(await ownerSigners("approve", t, ["0x1234", `0x${"00".repeat(65)}`], owners), [], "malformed");
  assert.deepEqual(await ownerSigners("approve", t, [await sign(o2, "approve", targetOf(other))], owners), [], "replayed from another record");
  assert.deepEqual(await ownerSigners("approve", t, [await sign(o2, "approve", t, at(8453, "5a", "00"))], owners), [], "signed for another chain and Safe");
  assert.deepEqual(await ownerSigners("approve", t, [await sign(o2, "approve", t, { ...at(1, "00", "e2"), chainId: 31337, safe: (await import("../src/config.ts")).d.safe })], owners), [], "signed for another enclave on the same chain and Safe");
  assert.deepEqual(await ownerSigners("veto", t, [s1], owners), [], "an approval is not a veto");
});

test("stored signatures: one per RECOVERED signer, never by a row's own label; unrecoverable ones dropped", async () => {
  const a2 = await sign(o2, "approve", t);
  const forged = await sign(stranger, "approve", t); // a row that would claim to be o2's
  const got = await firstPerSigner("approve", t, [forged, "0xdead", a2, a2, await sign(o1, "approve", t)]);
  assert.deepEqual(got.map((g) => g.signer), [stranger.address, o2.address, o1.address].map((a) => a.toLowerCase()), "o2's genuine signature is kept behind a forged earlier row");
  assert.equal(got[1].signature, a2);
});

test("effective: after effectiveAt, with the approvals it needs, without 2 owner vetoes, agent not paused", async () => {
  const a1 = await sign(o1, "approve", t), a2 = await sign(o2, "approve", t);
  assert.equal(await effective(swap, deps({ approve: [a1, a2] })), true);
  assert.equal(await effective(swap, deps({ approve: [a1, a2] }, { now: T - 1 })), false, "before effectiveAt");
  assert.equal(await effective(swap, deps({ approve: [a1] })), false, "brain swap: 2 distinct owner approvals");
  assert.equal(await effective(swap, deps({ approve: [a1, a1] })), false, "the same owner twice is one approval");
  assert.equal(await effective(swap, deps({ approve: [a1, await sign(stranger, "approve", t)] })), false, "a non-owner's approval");
  assert.equal(await effective(swap, deps({ approve: [a1, await sign(o2, "approve", targetOf(other))] })), false, "an approval of another record");
  assert.equal(await effective(swap, deps({ approve: [a1, a2] }, { paused: true })), false, "registry.agentPaused()");
  // vetoes: 2 distinct owners, also when they arrive after effectiveAt (checked at every use)
  const v1 = await sign(o1, "veto", t), v3 = await sign(o3, "veto", t);
  const later = { now: T + 3600_000 };
  assert.equal(await effective(swap, deps({ approve: [a1, a2], veto: [v1] }, later)), true, "one owner can't veto alone");
  assert.equal(await effective(swap, deps({ approve: [a1, a2], veto: Array(60).fill(v1) }, later)), true, "nor by repeating it");
  assert.equal(await effective(swap, deps({ approve: [a1, a2], veto: [...Array(60).fill(v1), v3] }, later)), false, "60 copies of one veto + another owner's = 2 vetoers");
  assert.equal(await effective(swap, deps({ approve: [a1, a2], veto: [a1, a2] })), true, "approvals are not vetoes");
  // a brain swap needs 2 approvals even if its record says fewer
  const lax = rowOf("model-change", "brain", { ...swapDoc, needApprovals: 0 });
  assert.equal(approvalsNeeded(JSON.parse(lax.body)), 2);
  assert.equal(await effective(lax, deps({})), false);
  // a delayed action that needs no approvals
  const plain = rowOf("model-change", "intake", { ...swapDoc, role: "intake", needApprovals: 0 });
  assert.equal(await effective(plain, deps({})), true);
  assert.equal(await effective(rowOf("model-change", "intake", { ...swapDoc, role: "intake", needApprovals: 0, effectiveAt: "soon" }), deps({})), false, "an unreadable effectiveAt is never in effect");
  assert.equal(await effective({ ...plain, body: "{" }, deps({})), false, "an unreadable body");
});

test("vetoed: 2 distinct owners' vetoes, whatever the time, the pause flag or the approvals", async () => {
  const v1 = await sign(o1, "veto", t), v2 = await sign(o2, "veto", t);
  assert.equal(await vetoed(swap, deps({ veto: [v1] })), false);
  assert.equal(await vetoed(swap, deps({ veto: [v1, v1] })), false);
  assert.equal(await vetoed(swap, deps({ veto: [v1, v2] }, { now: T - 3600_000, paused: true })), true, "before effectiveAt too");
  assert.equal(await vetoed(swap, deps({ approve: [v1, v2] })), false);
});

test("owner-digest script: the digest of a record the enclave signed, for its own log signer; never for an unsigned or non-delayed one", async () => {
  const { ownerDigestFor } = await import("../scripts/owner-digest.ts");
  const { logDigestOf } = await import("../src/proof.ts");
  const logKey = privateKeyToAccount(key(9));
  const served = async (kind: string, ref: string, doc: unknown, k = logKey) => {
    const body = canonical(doc);
    const eprev = Buffer.alloc(32, 7);
    const ehash = createHash("sha256").update(Buffer.concat([eprev, createHash("sha256").update(body).digest()])).digest("hex");
    return { kind, ref, body, eprev: `0x${eprev.toString("hex")}`, ehash: `0x${ehash}`, esig: await k.signMessage({ message: { raw: `0x${logDigestOf(ehash, kind, ref)}` } }) };
  };
  const chain = { chainId: 1, safe: `0x${"5a".repeat(20)}` };
  const rec = await served("report", "round:9", { round: 9, ideas: [], effectiveAt: "2026-10-08T13:00:00.000Z" });
  const o = await ownerDigestFor("veto", rec, chain);
  assert.deepEqual([o.enclave, o.effectiveAt, o.target], [logKey.address, "2026-10-08T13:00:00.000Z", targetOf(rowOf("report", "round:9", { round: 9, ideas: [], effectiveAt: "2026-10-08T13:00:00.000Z" }))]);
  assert.equal(o.digest, ownerDigest("veto", o.target, { ...chain, enclave: logKey.address }));
  // what an owner signs over the printed digest is what the engine counts (for that enclave, chain and Safe)
  const sig = await o1.signMessage({ message: { raw: `0x${o.digest}` } });
  assert.deepEqual(await ownerSigners("veto", o.target, [sig], owners, { ...chain, enclave: logKey.address }), [o1.address.toLowerCase()]);
  assert.deepEqual(await ownerSigners("veto", o.target, [sig], owners, { ...chain, enclave: o2.address }), [], "another enclave's records");
  await assert.rejects(ownerDigestFor("veto", { ...rec, body: rec.body.replace("9", "8") }, chain), /not a record the enclave signed/);
  await assert.rejects(ownerDigestFor("veto", { ...rec, esig: null }, chain), /not a record the enclave signed/);
  await assert.rejects(ownerDigestFor("veto", await served("alert", "x", { text: "hi" }), chain), /not a delayed action/);
  // a draft's pending record: approvable (the image hash shown), never vetoable, and never once decided
  const pending = { id: "12", kind: "x_media", payload: { text: "Image for Epoch:3", sha256: "c4".repeat(32) }, status: "pending" };
  const dr = await ownerDigestFor("approve", await served("draft", "12", pending), chain);
  assert.equal(dr.digest, ownerDigest("approve", targetOf(rowOf("draft", "12", pending)), { ...chain, enclave: logKey.address }));
  assert.match(dr.what, new RegExp(`draft #12 \\(x_media\\).*image sha256 ${"c4".repeat(32)}`));
  assert.equal(await draftApproverOf(rowOf("draft", "12", pending), [await o1.signMessage({ message: { raw: `0x${dr.digest}` } })], owners, { ...chain, enclave: logKey.address }), o1.address.toLowerCase(), "the printed digest approves it");
  await assert.rejects(ownerDigestFor("veto", await served("draft", "12", pending), chain), /not a delayed action/);
  await assert.rejects(ownerDigestFor("approve", await served("draft", "12", { ...pending, status: "approved" }), chain), /not a delayed action or a pending draft/);
  // the Telegram command refuses malformed input before reading anything
  const { ownerCommand } = await import("../src/approve.ts");
  for (const args of [[], ["12"], ["12", "0x1234"], ["x", `0x${"ab".repeat(65)}`]]) assert.match(await ownerCommand("veto", args), /^usage: \/veto <record seq> <signature>/, JSON.stringify(args));
});

test("draft approval: one current Safe owner's signature over exactly that pending draft (its ref and image hash); nothing else counts", async () => {
  const sha = "c4".repeat(32);
  const draft = (id: string, image = sha, status = "pending") =>
    rowOf("draft", id, { id, kind: "x_media", payload: { text: `Image for Epoch:3. sha256 ${image}`, sha256: image, eventKey: "Epoch:3" }, status });
  const d12 = draft("12");
  const ok = await sign(o2, "approve", targetOf(d12));
  assert.equal(await draftApproverOf(d12, [ok], owners), o2.address.toLowerCase(), "one owner is enough");
  assert.equal(await draftApproverOf(d12, ["0x12", ok], owners), o2.address.toLowerCase(), "garbage beside it is ignored");
  assert.equal(await draftApproverOf(d12, [await sign(stranger, "approve", targetOf(d12))], owners), null, "not a Safe owner");
  assert.equal(await draftApproverOf(draft("13"), [ok], owners), null, "replayed on another draft (wrong ref), same image");
  assert.equal(await draftApproverOf(draft("12", "d5".repeat(32)), [ok], owners), null, "the same draft id with another image hash");
  assert.equal(await draftApproverOf(d12, [await sign(o2, "veto", targetOf(d12))], owners), null, "a veto is not an approval");
  assert.equal(await draftApproverOf(d12, [await sign(o2, "approve", t)], owners), null, "replayed from a delayed record's approval");
  assert.equal(await draftApproverOf(d12, [await sign(o2, "approve", targetOf(d12), at(1, "5a", "e9"))], owners), null, "replayed from another enclave / Safe");
  assert.equal(await draftApproverOf(draft("12", sha, "approved"), [ok], owners), null, "only the pending record is signable");
  assert.equal(await draftApproverOf(rowOf("x_post", "12", JSON.parse(d12.body)), [ok], owners), null, "not a draft record");
  // an allowlisted Telegram user has no signature: no signature, no approval
  assert.equal(await draftApproverOf(d12, [], owners), null);
});

test("the owners' recipe: `cast wallet sign 0x<digest>` (EIP-191 over the 32 bytes) is exactly what the engine recovers", async () => {
  // produced by: cast wallet sign --private-key 0x00…01 0xabab…ab (Foundry 1.8.3)
  const digest = "ab".repeat(32);
  const cast = "0xbc8c86d565a76098dbd45c51f4c84195fc1b2a10f340792855b26da1c93774de3829f56949cc5b39f13d16e65bf0baa3a4cae5df6b3cb10a42b10eae535449dc1b";
  assert.equal(await signerOf(digest, cast), o1.address);
  assert.equal(await o1.signMessage({ message: { raw: `0x${digest}` } }), cast);
});

test("Safe owners: read on-chain once per block, lower-cased", async () => {
  let reads = 0;
  let block = 100n;
  const client = {
    getBlock: async () => ({ number: block }),
    readContract: async (a: { functionName: string; blockNumber: bigint }) => { reads++; assert.equal(a.functionName, "getOwners"); assert.equal(a.blockNumber, block); return owners; },
  };
  const cs = [client] as never;
  assert.deepEqual(await safeOwners(cs), owners.map((a) => a.toLowerCase()));
  await safeOwners(cs);
  assert.equal(reads, 1, "cached for the same block");
  block = 101n;
  await safeOwners(cs);
  assert.equal(reads, 2, "re-read on a new block");
});
