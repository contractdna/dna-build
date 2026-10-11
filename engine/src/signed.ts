// Enclave signatures. The signer is the enclave LOG key (derived in the TEE at dna/log, bound with the agent and anchor
// addresses in every attestation's report data): it signs log records and state rows and never a transaction, so the
// agent EOA is never a personal-sign oracle. Every signature is EIP-191 over a domain-separated digest
// (sha256("dna/log/v1" ‖ …) for log records, sha256("dna/state/v1" ‖ …) for state rows, src/log.ts), so a record
// signature can never pass as a state signature or the other way round.
import { type Hex, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LOG_KEY } from "./config.ts";

let account: ReturnType<typeof privateKeyToAccount> | undefined;
const signer = () => {
  if (!LOG_KEY) throw new Error("enclave signing needs the log key");
  return (account ??= privateKeyToAccount(LOG_KEY));
};
export const signerAddress = () => signer().address;

const raw = (digest: string) => (digest.startsWith("0x") ? digest : `0x${digest}`) as Hex;
/** EIP-191 signature over a 32-byte (domain-separated) digest. */
export const signDigest = (digest: string) => signer().signMessage({ message: { raw: raw(digest) } });

/** Recovered signer of `sig` over `digest`, or null for anything malformed. */
export async function signerOf(digest: string, sig: string | null | undefined) {
  if (!sig || !/^0x[0-9a-f]{130}$/i.test(sig)) return null;
  try {
    return await recoverMessageAddress({ message: { raw: raw(digest) }, signature: sig as Hex });
  } catch {
    return null;
  }
}

/** Ours = signed by this enclave's log key. */
export const isOurs = async (digest: string, sig: string | null | undefined) => (await signerOf(digest, sig))?.toLowerCase() === signerAddress().toLowerCase();
