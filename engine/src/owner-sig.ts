// What a Safe owner signs (src/approve.ts has the rules), dependency-free: no engine config, no database. The engine
// wraps it with its own chain; drivers that run without an engine config (the e2e run) call it directly.
import { createHash } from "node:crypto";
import { canonical } from "./canonical.ts";

export type OwnerKind = "approve" | "veto";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const DOMAIN: Record<OwnerKind, Buffer> = { approve: Buffer.from("dna/approve/v1"), veto: Buffer.from("dna/veto/v1") };

/** A log row as stored: its kind, ref and body text. */
export type Row = { kind: string; ref: string; body: string };
/** What an owner signs for: the row's kind and ref and the sha256 of its stored body text. */
export type Target = { kind: string; ref: string; bodyHash: string };
export const targetOf = (r: Row): Target => ({ kind: r.kind, ref: r.ref, bodyHash: sha256(r.body).toString("hex") });
/** The ref of the `approve` / `veto` records for a target. */
export const targetKey = (t: Target) => sha256(Buffer.concat([sha256(canonical([t.kind, t.ref])), Buffer.from(t.bodyHash, "hex")])).toString("hex");

/** Where a signature counts: the chain, the Safe, and the enclave (its log-key address) that keeps the records. */
export type Chain = { chainId: number; safe: string; enclave: string };
const addr = (a: string) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`not an address: ${a}`);
  return Buffer.from(a.slice(2), "hex");
};
/** The 32 bytes (hex) an owner signs (EIP-191) to approve or veto a target on `chain`. */
export function ownerDigestOn(kind: OwnerKind, t: Target, chain: Chain) {
  const id = Buffer.alloc(32);
  id.writeBigUInt64BE(BigInt(chain.chainId), 24);
  return sha256(Buffer.concat([DOMAIN[kind], id, addr(chain.safe), addr(chain.enclave), sha256(canonical([t.kind, t.ref])), Buffer.from(t.bodyHash, "hex")])).toString("hex");
}
