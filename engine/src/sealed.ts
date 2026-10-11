// Secrets at rest in Postgres (the `secret` table): AES-256-GCM under a key from a pluggable provider, the purpose as
// associated data (a value sealed for one purpose never opens as another). The DB is storage only: a row that does not
// open is ignored, never trusted.
//  - local provider (dev, tests, the plain build): HKDF-SHA256(SECRET_SEAL_KEY, info = purpose).
//  - enclave provider: the dstack-derived key for the purpose (src/enclave.ts); set with setKeyProvider.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export type KeyProvider = { name: string; key: (purpose: string) => Promise<Buffer> };

export const localKeyProvider: KeyProvider = {
  name: "local",
  key: async (purpose) => {
    const ikm = process.env.SECRET_SEAL_KEY;
    if (!ikm || !/^(0x)?[0-9a-f]{64}$/i.test(ikm)) throw new Error("SECRET_SEAL_KEY (32 bytes hex) is required to seal secrets");
    return Buffer.from(hkdfSync("sha256", Buffer.from(ikm.replace(/^0x/, ""), "hex"), Buffer.alloc(0), `dna-seal:${purpose}`, 32));
  },
};

let provider = localKeyProvider;
export const setKeyProvider = (p: KeyProvider) => { provider = p; };
export const keyProviderName = () => provider.name;

/** "v1:" + base64(iv(12) ‖ tag(16) ‖ ciphertext). */
export async function seal(purpose: string, plaintext: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", await provider.key(purpose), iv).setAAD(Buffer.from(purpose));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}

/** The plaintext, or null when the value is not ours (plaintext legacy row, other key, other purpose, tampered). */
export async function unseal(purpose: string, value: string): Promise<string | null> {
  if (!value.startsWith("v1:")) return null;
  const b = Buffer.from(value.slice(3), "base64");
  try {
    const d = createDecipheriv("aes-256-gcm", await provider.key(purpose), b.subarray(0, 12)).setAAD(Buffer.from(purpose));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
