// /api/log/binding/<X user id>: every `binding` record of one X account (log ref x:<id>), oldest first, in the same
// shape as /api/log/<seq>. The watchdog reads it to check an idea reward against the binding in force at the queue (a
// rebinding since the reward was decided must page the Safe signers). Read-only role (dna_web).
import { LIVE } from "../../../../_data/flags";
import { db } from "../../../../_data/live";
import { ENCLAVE, out, type Rec } from "../../record";


export async function GET(_req: Request, ctx: RouteContext<"/api/log/binding/[id]">) {
  const { id } = await ctx.params;
  if (!LIVE) return Response.json({ error: "live data is off" }, { status: 404 });
  if (!/^\d{1,20}$/.test(id)) return Response.json({ error: "an X user id (digits)" }, { status: 400 });
  // bounded: the engine refuses more than 100 binding records per account (src/bindings.ts BINDING_LIMITS)
  const rows = await db()<Rec[]>`select seq::text, at, kind, ref, body, encode(body_hash, 'hex') as body_hash, encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash,
    ${db().unsafe(ENCLAVE)} from log where kind = 'binding' and ref = ${`x:${id}`} order by log.seq limit 120`;
  return Response.json({ xUserId: id, records: rows.map(out) }, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
}
