// /api/log/seq/<kind>: the newest Sequencer records of one kind (ship, fund, release, retire, page-kill) and the Safe owners' vetoes and approvals, newest first, in the
// same shape as /api/log/<seq>. The watchdog reads them to check every game deploy, queued game fund and move of the
// release branch against a record the enclave signed. Read-only role (dna_web).
import { LIVE } from "../../../../_data/flags";
import { db } from "../../../../_data/live";
import { ENCLAVE, out, type Rec } from "../../record";

const KINDS = ["ship", "fund", "release", "retire", "page-kill", "veto", "approve"];

export async function GET(_req: Request, ctx: RouteContext<"/api/log/seq/[kind]">) {
  const { kind } = await ctx.params;
  if (!LIVE) return Response.json({ error: "live data is off" }, { status: 404 });
  if (!KINDS.includes(kind)) return Response.json({ error: `one of ${KINDS.join(", ")}` }, { status: 400 });
  // bounded: a few records a day (at most one ship a day, a few funds, a release per merge)
  const rows = await db()<Rec[]>`select seq::text, at, kind, ref, body, encode(body_hash, 'hex') as body_hash, encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash,
    ${db().unsafe(ENCLAVE)} from log where kind = ${kind} order by log.seq desc limit 500`;
  return Response.json({ kind, records: rows.map(out) }, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
}
