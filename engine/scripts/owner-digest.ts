// What a Safe owner signs to approve or veto a delayed record (an IdeaMarket outcome report, a model swap, ...), or to
// approve a draft (a post's exact text: one owner's signature approves it), and how.
//   CHAIN_ID=1 node scripts/owner-digest.ts <approve|veto> <record seq> [log base url]
// Reads the record from the public log (/api/log/<seq>), checks it is one the enclave signed and a delayed action (or,
// to approve, a draft's pending record: its seq is in the draft message), and prints the 32-byte digest of
// src/approve.ts. Sign it as an EIP-191 message over those raw 32 bytes, e.g.
//   cast wallet sign --ledger 0x<digest>        (or --trezor, or --interactive for a raw key)
// and send `/approve <seq> <signature>` or `/veto <seq> <signature>` in the signers' Telegram group. The signature is the
// gate (recovered and checked against Safe.getOwners() on-chain); Telegram only carries it. Future UX: EIP-712 typed
// data, so a wallet shows the record's kind, ref and effectiveAt instead of 32 opaque bytes.
import { type Chain, type OwnerKind, ownerDigest, targetOf } from "../src/approve.ts";
import { CHAIN_ID, d, LOG_BASE_URL } from "../src/config.ts";
import { checkRecord, type SignedRecord } from "../src/proof.ts";

/** The digest for one record as /api/log/<seq> serves it. The enclave in the digest is the record's own signer. */
export async function ownerDigestFor(kind: OwnerKind, rec: SignedRecord, chain: Omit<Chain, "enclave">) {
  const { ehashOk, signer } = await checkRecord(rec);
  if (!ehashOk || !signer) throw new Error("not a record the enclave signed: do not sign it");
  let doc: { effectiveAt?: unknown; status?: unknown; kind?: unknown; payload?: { text?: unknown; sha256?: unknown } };
  try { doc = JSON.parse(rec.body); } catch { throw new Error("the record body is not JSON"); }
  const draft = kind === "approve" && rec.kind === "draft" && doc.status === "pending" && !!rec.ref;
  if (!draft && (typeof doc.effectiveAt !== "string" || !rec.ref)) throw new Error(`a ${rec.kind} record is not a delayed action${kind === "approve" ? " or a pending draft" : ""}`);
  const target = targetOf({ kind: rec.kind, ref: rec.ref!, body: rec.body });
  const what = draft ? `draft #${rec.ref} (${String(doc.kind)}): ${String(doc.payload?.text ?? "")}${doc.payload?.sha256 ? ` [image sha256 ${String(doc.payload.sha256)}]` : ""}`
    : `${rec.kind} ${rec.ref}, in effect from ${String(doc.effectiveAt)}`;
  return { target, what, effectiveAt: typeof doc.effectiveAt === "string" ? doc.effectiveAt : null, enclave: signer, digest: ownerDigest(kind, target, { ...chain, enclave: signer }) };
}

if (import.meta.main) {
  const [kind, seq, base = LOG_BASE_URL] = process.argv.slice(2);
  if ((kind !== "approve" && kind !== "veto") || !/^\d+$/.test(seq ?? "")) {
    console.error("usage: CHAIN_ID=<chain> node scripts/owner-digest.ts <approve|veto> <record seq> [log base url]");
    process.exit(2);
  }
  const res = await fetch(`${base}/api/log/${seq}`);
  if (!res.ok) throw new Error(`${base}/api/log/${seq}: HTTP ${res.status}`);
  const rec = (await res.json()) as SignedRecord;
  const o = await ownerDigestFor(kind, rec, { chainId: CHAIN_ID, safe: d.safe });
  console.log([
    `${kind} record ${seq}: ${o.what}`,
    `chain ${CHAIN_ID}, Safe ${d.safe}, enclave log signer ${o.enclave} (check it is the log signer /proof attests)`,
    `body sha256 ${o.target.bodyHash}`,
    `digest 0x${o.digest}`,
    "",
    `sign:  cast wallet sign --ledger 0x${o.digest}`,
    `send:  /${kind} ${seq} <signature>   (in the signers' group)`,
  ].join("\n"));
}
