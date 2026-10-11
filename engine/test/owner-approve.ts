// Test helper (not a test file): approve a draft the only way the engine allows, a Safe owner's signature over the
// draft's pending record sent as `/approve <seq> <signature>` (src/approve.ts ownerCommand). Tests have no Safe, so the
// owner set is pinned to OWNER. src/ modules are imported lazily: the test files set their env first.
import { privateKeyToAccount } from "viem/accounts";

export const OWNER = privateKeyToAccount(`0x${"0".repeat(63)}1`);
export const STRANGER = privateKeyToAccount(`0x${"0".repeat(63)}9`);
const owners = async () => [OWNER.address.toLowerCase()];

/** The live owner read (Safe.getOwners() on-chain) answers OWNER: draftHandler and card.approved use it. */
export async function pinOwners() {
  (await import("../src/approve.ts")).live.owners = owners;
}

/** Sign draft `id`'s pending record as `signer` and send it as /approve; returns the engine's reply. */
export async function ownerApprove(id: string, signer = OWNER) {
  const approve = await import("../src/approve.ts");
  const row = (await approve.trustedRows("draft", id)).find((r) => JSON.parse(r.body).status === "pending");
  if (!row) throw new Error(`draft ${id}: no pending record`);
  const sig = await signer.signMessage({ message: { raw: `0x${approve.ownerDigest("approve", approve.targetOf(row))}` } });
  return approve.ownerCommand("approve", [row.seq, sig], owners);
}
