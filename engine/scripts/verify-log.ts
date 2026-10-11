// Recompute the engine log's hash chain (sha256(prev || sha256(body)), see migrations/003) and check that every
// on-chain Anchored root the indexer saw is a hash in the chain (or, enclave build, an enclave-chain head: eprev links,
// ehash recomputes, one signer for every esig). Exit 1 on any mismatch.  Usage: node scripts/verify-log.ts
import postgres from "postgres";
import { verify } from "../src/log.ts";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://localhost/dna", { max: 1, onnotice: () => {} });
const v = await verify(sql);
if (!v.ok) {
  console.error(`log BROKEN at seq ${v.seq}: ${v.error}`);
  process.exit(1);
}
const anchors = await sql<{ root: string; uri: string; block: string }[]>`select args->>'root' as root, args->>'uri' as uri, block::text from chain_log where event = 'Anchored' order by block`;
const bad = anchors.filter((a) => !v.hashes.has(a.root.toLowerCase()) && !v.ehashes.has(a.root.toLowerCase()));
for (const a of bad) console.error(`anchor at block ${a.block} (${a.uri}): root ${a.root} is not in the log`);
console.log(`log OK: ${v.n} records, head ${v.head}; ${anchors.length - bad.length}/${anchors.length} anchors match${v.enclaveHead ? `; enclave chain ${v.ehashes.size} records, head ${v.enclaveHead}, signer ${v.signer}` : ""}`);
await sql.end();
process.exit(bad.length ? 1 : 0);
