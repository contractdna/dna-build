// Indexer health: finalized cursor block/time and `stale` when the indexer has not completed a pass in 5 minutes. Also
// the commit this deploy was built from (Railway sets RAILWAY_GIT_COMMIT_SHA; null elsewhere): the engine announces a
// site change only once this names its merge or a later commit.
import { LIVE } from "../../_data/flags";
import { getHealth } from "../../_data/live";

export async function GET() {
  const body = LIVE ? await getHealth().catch(() => ({ live: true, error: "database unavailable", stale: true })) : { live: false };
  return Response.json({ ...body, commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null }, { headers: { "Cache-Control": "no-store" } });
}
