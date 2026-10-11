// Is a game's page pulled? (The play layout and /api/kill/<slug>, which the wallet guard polls.)
import "server-only";
import { LIVE } from "../_data/flags";
import { db } from "../_data/live";
import { killWhy, noLiveData, roleOf } from "../../security";

/** A `page-kill` record for the game (the enclave's, ref = the slug) means yes, with its reason; an unreadable
 *  database also means "paused" (fail closed). Without live data the main site's pre-launch pages have no games to
 *  pull; the play origin, which serves games, treats missing data as "paused" (security.ts noLiveData). */
export async function killState(slug: string, env: Record<string, string | undefined> = process.env): Promise<{ killed: boolean; why?: string }> {
  if (!LIVE) return noLiveData(roleOf(env), env);
  try {
    const rows = await db()<{ why: string | null }[]>`select doc->>'why' as why from log where kind = 'page-kill' and ref = ${slug} order by seq desc limit 1`;
    return rows.length ? { killed: true, why: killWhy(rows[0].why) } : { killed: false };
  } catch {
    return { killed: true, why: "the game's status is unavailable" };
  }
}
