// Safe-owner approvals and vetoes for delayed off-chain actions (model swaps now; merges, IdeaMarket outcomes and
// retirements later). A delayed action is a signed log record whose body carries `effectiveAt` (ISO) and, when it
// needs them, `needApprovals`. An owner approves or vetoes it by signing (EIP-191) the 32-byte digest
//   sha256(domain ‖ uint256 chainId ‖ Safe address ‖ enclave log-key address ‖ sha256(canonical [kind, ref]) ‖ sha256(body))
// with domain "dna/approve/v1" or "dna/veto/v1", and `body` the exact text the log row stores (the bytes its hash
// chain covers). A signature binds to one record of one enclave on one chain for one Safe and to one meaning: it can't
// be replayed on another record, chain, Safe or enclave (e.g. a fork run with the same Safe), or turned from an
// approval into a veto. The enclave recovers each signer and counts
// only the Safe's current owners (read on-chain), each once. An action is in effect when effectiveAt has passed, it has
// its approvals (a brain swap: always at least 2), fewer than 2 owners vetoed it (2 = the Safe's own 2-of-3 threshold;
// no single owner can block alone), and the registry's agent is not paused. Vetoes are checked at every use: one that
// lands after effectiveAt still stops an action.
// Drafts (a post's exact text) use the same approve signature over the draft's signed `pending` record: ONE current
// Safe owner approves a draft (it gates a post, not a fund move). The Telegram allowlist never approves anything; it
// keeps only the brakes (/halt, /dryrun, /mute, /unmute, /delete) and the Reject button.
import { createHash } from "node:crypto";
import { type Address, parseAbi, type PublicClient } from "viem";
import * as abi from "./abi.ts";
import { clients, readAgreed } from "./chainref.ts";
import { edb } from "./db.ts";
import { append, canonical, type EnclaveRow, newestOf, RolledBack, rolledBack, trustedRecord } from "./log.ts";
import { CHAIN_ID, d, LOG_KEY } from "./config.ts";
import { type Chain, ownerDigestOn, type OwnerKind, type Row, type Target, targetKey, targetOf } from "./owner-sig.ts";
import { signerAddress, signerOf } from "./signed.ts";

export { type Chain, type OwnerKind, type Row, type Target, targetKey, targetOf };
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
/** The row a body becomes when appended (append() stores canonical(body)). */
export const rowOf = (kind: string, ref: string, body: unknown): Row => ({ kind, ref, body: canonical(body) });

/** This engine's: without a log key (a plain build in tests) the enclave is the zero address. */
const here = (): Chain => ({ chainId: CHAIN_ID, safe: d.safe, enclave: LOG_KEY ? signerAddress() : `0x${"00".repeat(20)}` });
/** The 32 bytes an owner signs (EIP-191) to approve or veto a target (src/owner-sig.ts), on this engine's chain by default. */
export const ownerDigest = (kind: OwnerKind, t: Target, chain: Chain = here()) => ownerDigestOn(kind, t, chain);

/** Distinct Safe owners (lower-case) among the recovered signers of `sigs` over (kind, target). */
export async function ownerSigners(kind: OwnerKind, t: Target, sigs: string[], owners: string[], chain: Chain = here()) {
  const set = new Set(owners.map((o) => o.toLowerCase()));
  const out = new Set<string>();
  for (const s of sigs) {
    const a = (await signerOf(ownerDigest(kind, t, chain), s))?.toLowerCase();
    if (a && set.has(a)) out.add(a);
  }
  return [...out];
}

const SAFE_ABI = parseAbi(["function getOwners() view returns (address[])"]);
let ownersAt: { block: bigint; owners: string[] } | undefined;
/** Safe.getOwners() at the finalized block (every provider must agree in the enclave), cached per block. */
export async function safeOwners(cs: PublicClient[] = clients) {
  const block = (await cs[0].getBlock({ blockTag: "finalized" })).number!;
  if (ownersAt?.block === block) return ownersAt.owners;
  const owners = (await readAgreed((c) => c.readContract({ address: d.safe, abi: SAFE_ABI, functionName: "getOwners", blockNumber: block }), cs) as Address[]).map((o) => o.toLowerCase());
  ownersAt = { block, owners };
  return owners;
}

/** One signature per RECOVERED signer (the earliest that recovers), in order; signatures that recover to nothing are
 *  dropped. A row's own `signer` label is never trusted: a forged row naming an owner can't stand in for, or hide,
 *  that owner's real signature, and repeated rows from one signer can't crowd out the others'. */
export async function firstPerSigner(kind: OwnerKind, t: Target, sigs: string[], chain: Chain = here()) {
  const out = new Map<string, string>();
  for (const s of sigs) {
    const a = (await signerOf(ownerDigest(kind, t, chain), s))?.toLowerCase();
    if (a && !out.has(a)) out.set(a, s);
  }
  return [...out].map(([signer, signature]) => ({ signer, signature }));
}

/** Stored signatures for a target: every record for it, oldest first, the verified ones, one per recovered signer. */
export async function signaturesOf(kind: OwnerKind, t: Target) {
  const rows = await edb<(EnclaveRow & { doc: { signature?: unknown } })[]>`select doc, kind, ref, body, eprev, ehash, esig
    from log where kind = ${kind} and ref = ${targetKey(t)} order by log.seq`;
  const sigs: string[] = [];
  for (const r of rows) if (typeof r.doc.signature === "string" && (await trustedRecord(r, `${kind} record`))) sigs.push(r.doc.signature);
  return firstPerSigner(kind, t, sigs);
}

export type Deps = { now: () => number; owners: () => Promise<string[]>; paused: () => Promise<boolean>; signatures: (kind: OwnerKind, t: Target) => Promise<string[]> };
export const live: Deps = {
  now: Date.now,
  owners: () => safeOwners(),
  // an unreadable or disputed pause flag reads as paused
  paused: () => readAgreed((c) => c.readContract({ address: d.registry, abi: abi.registryAbi, functionName: "agentPaused" })).then(Boolean, () => true),
  signatures: async (kind, t) => (await signaturesOf(kind, t)).map((r) => r.signature),
};

/** Approvals a delayed record needs: its own number, and never fewer than 2 for a brain model swap. */
export const approvalsNeeded = (doc: { kind?: unknown; role?: unknown; needApprovals?: unknown }) =>
  Math.max(Number.isInteger(doc.needApprovals) ? (doc.needApprovals as number) : 0, doc.kind === "model-change" && doc.role === "brain" ? 2 : 0);

/** Is this delayed record (a stored log row) in effect now? (See the header for the rule.) */
export async function effective(row: Row, deps: Deps = live) {
  let doc: { effectiveAt?: unknown; kind?: unknown; role?: unknown; needApprovals?: unknown };
  try {
    doc = JSON.parse(row.body);
  } catch {
    return false;
  }
  const at = typeof doc.effectiveAt === "string" ? Date.parse(doc.effectiveAt) : NaN;
  if (!Number.isFinite(at) || at > deps.now()) return false;
  if (await deps.paused()) return false;
  if (await vetoed(row, deps)) return false;
  const need = approvalsNeeded(doc);
  if (need === 0) return true;
  const t = targetOf(row);
  return (await ownerSigners("approve", t, await deps.signatures("approve", t), await deps.owners())).length >= need;
}

/** Have 2 distinct current Safe owners vetoed this record? (At any time: a veto needs no effectiveAt.) */
export async function vetoed(row: Row, deps: Deps = live) {
  const t = targetOf(row);
  const sigs = await deps.signatures("veto", t);
  if (sigs.length < 2) return false; // the owners are read only when it could matter
  return (await ownerSigners("veto", t, sigs, await deps.owners())).length >= 2;
}

/** Newest rows of `kind` for `ref` that the enclave signed (the plain build trusts every row); throws when the DB hides
 *  the enclave's newest one. */
export async function trustedRows(kind: string, ref: string, limit = 20): Promise<(Row & { seq: string })[]> {
  const want = newestOf(kind, ref);
  const rows = await edb<(EnclaveRow & { seq: string; ref: string })[]>`select seq::text, kind, ref, body, eprev, ehash, esig from log where kind = ${kind} and ref = ${ref} order by log.seq desc limit ${limit + 20}`;
  const out: (Row & { seq: string })[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (await trustedRecord(r, `${kind} record`)) out.push({ kind: r.kind, ref: r.ref, body: r.body, seq: r.seq });
  }
  if (await rolledBack(kind, ref, out[0]?.seq, want)) throw RolledBack(`${kind} ${ref}`);
  return out;
}

/** A draft's `pending` record body (what the signers were shown: kind, exact payload), or null. */
const pendingDoc = (r: Row): { id?: unknown } | null => {
  try {
    const doc = JSON.parse(r.body);
    return r.kind === "draft" && doc?.status === "pending" ? doc : null;
  } catch {
    return null;
  }
};
/** Pure: the current Safe owner whose approve signature is over exactly this pending draft row, or null. One owner is
 *  enough. A signature over another draft (another ref), another payload (another body), another record kind, a veto, or
 *  another chain, Safe or enclave recovers to someone else and counts for nothing. */
export async function draftApproverOf(row: Row, sigs: string[], owners: string[], chain: Chain = here()) {
  if (!pendingDoc(row)) return null;
  return (await ownerSigners("approve", targetOf(row), sigs, owners, chain))[0] ?? null;
}
/** The Safe owner who approved draft `id` by signature (its enclave-signed pending record's target), or null. */
export async function draftApprover(id: string, deps: Pick<Deps, "owners" | "signatures"> = live) {
  const row = (await trustedRows("draft", id)).find(pendingDoc);
  if (!row) return null;
  const sigs = await deps.signatures("approve", targetOf(row));
  return sigs.length ? draftApproverOf(row, sigs, await deps.owners()) : null; // the owners are read only when it could matter
}

/** Telegram transport (the signers' group, allow-listed ids): `/approve <seq> <signature>`, `/veto <seq> <signature>`
 *  for the delayed record at log seq <seq>, or `/approve <seq> <signature>` for a draft's pending record (a post),
 *  which then approves the draft. Telegram only carries it: submitSignature's owner check is the gate.
 *  Returns the reply text. */
export async function ownerCommand(kind: OwnerKind, args: string[], owners = safeOwners) {
  const [seq, sig] = args;
  if (!/^\d{1,18}$/.test(seq ?? "") || !/^0x[0-9a-fA-F]{130}$/.test(sig ?? "")) return `usage: /${kind} <record seq> <signature> (the digest to sign: engine/scripts/owner-digest.ts ${kind} <seq>)`;
  const [r] = await edb<EnclaveRow[]>`select kind, ref, body, eprev, ehash, esig from log where seq = ${seq}`;
  if (!r || !(await trustedRecord(r, "delayed record"))) return `no signed record ${seq}`;
  let doc: { effectiveAt?: unknown } = {};
  try { doc = JSON.parse(r.body); } catch { /* not a delayed record */ }
  const draft = kind === "approve" && r.ref ? pendingDoc({ kind: r.kind, ref: r.ref, body: r.body }) : null;
  if (!draft && (typeof doc.effectiveAt !== "string" || !r.ref)) return `record ${seq} (${r.kind}) is not a delayed action${kind === "approve" ? " or a pending draft" : ""}`;
  try {
    const t = targetOf({ kind: r.kind, ref: r.ref!, body: r.body });
    const { rec, signer: owner } = await submitSignature(kind, t, sig, owners);
    if (draft) {
      const ok = await (await import("./telegram.ts")).decide(r.ref!, true, owner);
      return ok ? `draft #${r.ref} approved by Safe owner ${owner} (record ${seq})` : `draft #${r.ref} was already decided`;
    }
    return rec ? `${kind} of ${r.kind} ${r.ref} (record ${seq}) stored as record ${rec.seq}` : `already stored: this owner's ${kind} of record ${seq}`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Store an owner's signature as a signed `approve` / `veto` record (ref = targetKey). Refused (throws) unless it recovers
 *  to a current Safe owner; returns that owner and the new record (null when that owner already signed this target). */
export async function submitSignature(kind: OwnerKind, t: Target, signature: string, owners = safeOwners) {
  if (!/^[0-9a-f]{64}$/.test(t.bodyHash)) throw Object.assign(new Error("bodyHash: 64 lower-case hex"), { final: true });
  const [signer] = await ownerSigners(kind, t, [signature], await owners());
  if (!signer) throw Object.assign(new Error(`not a Safe owner's ${kind} signature for ${t.kind} ${t.ref}`), { final: true });
  if ((await signaturesOf(kind, t)).some((r) => r.signer === signer)) return { signer, rec: null };
  return { signer, rec: await append(kind, targetKey(t), { target: t, signature, signer, at: new Date().toISOString() }) };
}
