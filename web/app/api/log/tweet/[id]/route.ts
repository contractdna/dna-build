// /api/log/tweet/<tweet id>: the signed text behind one of DNA's posts or replies. The engine writes the exact text as an
// x_post `attempt` record BEFORE it calls X, then a `posted` record naming the tweet id (same ref). Returns the attempt
// (what was signed before sending) and the posted record, in the same shape as /api/log/<seq>. Read-only role (dna_web).
import { LIVE } from "../../../../_data/flags";
import { db } from "../../../../_data/live";
import { ENCLAVE, out, type Rec } from "../../record";

const COLS = `seq::text, at, kind, ref, body, encode(body_hash, 'hex') as body_hash, encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash, ${ENCLAVE}`;

export async function GET(_req: Request, ctx: RouteContext<"/api/log/tweet/[id]">) {
  const { id } = await ctx.params;
  if (!LIVE) return Response.json({ error: "live data is off" }, { status: 404 });
  if (!/^\d{1,20}$/.test(id)) return Response.json({ error: "a tweet id (digits)" }, { status: 400 });
  // index log_x_post_tweet (engine migration 016)
  const [posted] = await db()<Rec[]>`select ${db().unsafe(COLS)} from log where kind = 'x_post' and doc->>'tweetId' = ${id} order by log.seq desc limit 1`;
  if (!posted) return Response.json({ error: "no post with this id" }, { status: 404 });
  const [attempt] = await db()<Rec[]>`select ${db().unsafe(COLS)} from log where kind = 'x_post' and ref = ${posted.ref} and doc->>'status' = 'attempt' and seq < ${posted.seq} order by log.seq desc limit 1`;
  return Response.json({ tweetId: id, attempt: attempt ? out(attempt) : null, posted: out(posted) },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
}
