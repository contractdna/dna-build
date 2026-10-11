// /api/log/<seq>: one record. /api/log/<day>: one UTC day of the engine's hash-chained log: the target of the daily on-chain anchor
// registry.anchor(head, "https://genomedna.xyz/api/log/<day>"). Verify with: hash = sha256(prevHash || sha256(utf8 body)),
// starting from `prevHash` (the last hash of the previous day) and ending at `head`. Read-only role (dna_web).
// Enclave build: a record also carries its enclave-chain fields (eprev, ehash = sha256(eprev || sha256(body)), esig =
// the enclave log key's EIP-191 signature over sha256("dna/log/v1" || ehash)); null on records the enclave did not
// write. Checked on /proof against the attested log signer.
import { LIVE } from "../../../_data/flags";
import { db } from "../../../_data/live";
import { ENCLAVE, out, type Rec } from "../record";


export async function GET(_req: Request, ctx: RouteContext<"/api/log/[day]">) {
  const { day } = await ctx.params;
  if (!LIVE) return Response.json({ error: "live data is off" }, { status: 404 });
  // /api/log/<seq>: one record (an IdeaMarket report's uri; its reportHash = keccak256 of exactly `body`)
  if (/^\d{1,18}$/.test(day)) {
    const [r] = await db()<Rec[]>`select seq::text, at, kind, ref, body, encode(body_hash, 'hex') as body_hash, encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash, ${db().unsafe(ENCLAVE)} from log where seq = ${day}`;
    if (!r) return Response.json({ error: "no such record" }, { status: 404 });
    return Response.json(out(r),
      { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400, immutable" } });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return Response.json({ error: "day must be YYYY-MM-DD" }, { status: 400 });
  // simplification: one response per day, unpaginated (engine volume is ~hundreds of records/day); add ?after=<seq> if it grows
  const rows = await db()<Rec[]>`select seq::text, at, kind, ref, body, encode(body_hash, 'hex') as body_hash,
      encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash, ${db().unsafe(ENCLAVE)} from log
    where at >= ${day}::date::timestamp at time zone 'UTC' and at < (${day}::date + 1)::timestamp at time zone 'UTC'
    order by log.seq`;
  // closed = past day end + 10 min (an append in flight at midnight lands with at < day end, committed moments later)
  const closed = Date.parse(`${day}T00:00:00Z`) + 86_400_000 + 10 * 60_000 <= Date.now();
  return Response.json(
    {
      day, count: rows.length, prevHash: rows[0] ? `0x${rows[0].prev_hash}` : null, head: rows.length ? `0x${rows.at(-1)!.hash}` : null,
      hashing: "hash = sha256(prev_hash || sha256(utf8(body))); first prev_hash of the log = 32 zero bytes",
      records: rows.map(out),
    },
    // a closed day never changes (append-only); today's is still growing
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": closed ? "public, max-age=86400, immutable" : "no-store" } },
  );
}
