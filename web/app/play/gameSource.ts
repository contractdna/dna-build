// Where the main site gets a Sequencer game's ABI: the game.json in the public build repository, at the commit its
// signed ship record names, accepted only if its bytes are the git blob that record lists and it names the same
// address and code hash. So the ABI the panel uses is the one the gates ran on, wherever the bytes came from.
import { createHash } from "node:crypto";
import { getAddress } from "viem";

export const BUILD_REPO = "contractdna/dna-build";
const SLUG = /^[a-z][a-z0-9-]{2,30}$/;
const MAX_BYTES = 512_000;

/** The fields of a game's ship record (engine/src/sequencer.ts) the site uses. */
export type Ship = { slug: string; title: string; predicted: string; codehash: string; gatedSha: string; pr?: number; treeHashes?: Record<string, string> };

/** git's object id of a file ("blob <size>\0" + its bytes, sha1). */
export const blobSha = (b: Uint8Array) => createHash("sha1").update(`blob ${b.byteLength}\0`).update(b).digest("hex");
/** The blob id the ship record lists for the game's game.json, if any. */
export const wantedBlob = (s: Ship) => s.treeHashes?.[`web/app/g/${s.slug}/game.json`]?.match(/^\d+:([0-9a-f]{40})$/)?.[1] ?? null;

/** game.json's bytes → its ABI; null unless they are the listed blob, for this game's slug, address and code hash. */
export function abiFrom(bytes: Uint8Array, s: Ship): unknown[] | null {
  const want = wantedBlob(s);
  if (!want || blobSha(bytes) !== want) return null;
  try {
    const g = JSON.parse(new TextDecoder().decode(bytes)) as { slug?: unknown; address?: string; codehash?: unknown; abi?: unknown };
    const same = g.slug === s.slug && getAddress(String(g.address)) === getAddress(s.predicted) && String(g.codehash).toLowerCase() === s.codehash.toLowerCase();
    return same && Array.isArray(g.abi) ? g.abi : null;
  } catch {
    return null;
  }
}

// by blob id: content-addressed, so a found ABI never goes stale; a miss is kept a minute (no fetch on every render)
const found = new Map<string, { abi: unknown[] | null; at: number }>();
const MISS_MS = 60_000;
/** The game's ABI, from the gated commit (or `release`, the same blob once merged); null when neither has it. */
export async function abiOf(s: Ship, get: typeof fetch = fetch): Promise<unknown[] | null> {
  const want = wantedBlob(s);
  if (!want || !SLUG.test(s.slug)) return null;
  const hit = found.get(want);
  if (hit && (hit.abi || Date.now() - hit.at < MISS_MS)) return hit.abi;
  const refs = [...(/^[0-9a-f]{40}$/.test(s.gatedSha) ? [s.gatedSha] : []), "release"];
  for (const ref of refs) {
    try {
      const r = await get(`https://raw.githubusercontent.com/${BUILD_REPO}/${ref}/web/app/g/${s.slug}/game.json`, { signal: AbortSignal.timeout(5_000), cache: "no-store", redirect: "error" });
      if (!r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const abi = bytes.byteLength <= MAX_BYTES ? abiFrom(bytes, s) : null;
      if (abi) {
        found.set(want, { abi, at: Date.now() });
        return abi;
      }
    } catch {
      /* the next ref */
    }
  }
  found.set(want, { abi: null, at: Date.now() });
  return null;
}
