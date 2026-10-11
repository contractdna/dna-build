// Is a game's page pulled? The wallet guard (app/_ui/guard.ts) asks every 60 s and before every transaction; anything
// but {killed: false} makes it refuse and unmount the game. Same origin as the page, never cached.
import { killState } from "../../../g/state";
import { SLUG } from "../../../../security";

export async function GET(_req: Request, ctx: RouteContext<"/api/kill/[slug]">) {
  const { slug } = await ctx.params;
  const body = SLUG.test(slug) ? await killState(slug) : { killed: true, why: "no such game" };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
