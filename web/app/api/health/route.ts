// Indexer health: finalized cursor block/time and `stale` when the indexer has not completed a pass in 5 minutes.
import { LIVE } from "../../_data/flags";
import { getHealth } from "../../_data/live";

export async function GET() {
  const body = LIVE ? await getHealth().catch(() => ({ live: true, error: "database unavailable", stale: true })) : { live: false };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
