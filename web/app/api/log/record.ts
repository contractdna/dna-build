// The shape every /api/log route returns a record in (the stored row; hex fields 0x-prefixed). Enclave records also
// carry their enclave-chain fields (eprev, ehash, esig); null on records the enclave did not write.
export type Rec = { seq: string; at: Date; kind: string; ref: string | null; body: string; body_hash: string; prev_hash: string; hash: string; eprev: string | null; ehash: string | null; esig: string | null };
/** The select list of a record (with `${db().unsafe(ENCLAVE)}` for the enclave fields). */
export const ENCLAVE = "encode(eprev, 'hex') as eprev, encode(ehash, 'hex') as ehash, esig";
export const out = (r: Rec) => ({ ...r, at: r.at.toISOString(), body_hash: `0x${r.body_hash}`, prev_hash: `0x${r.prev_hash}`, hash: `0x${r.hash}`, eprev: r.eprev && `0x${r.eprev}`, ehash: r.ehash && `0x${r.ehash}` });
