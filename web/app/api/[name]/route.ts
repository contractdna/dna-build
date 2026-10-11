// Public read-only JSON of the same getters the pages use (GET /api/modules, /api/treasury, ...). CDN-cacheable;
// the getters themselves are memoized 5 s per instance.
import { LIVE } from "../../_data/flags";
import { getCore } from "../../_data/live";
import * as source from "../../_data/source";

// Field semantics a consumer can't infer from the numbers alone.
const CORE_NOTES = {
  activeModules: "max(1, active fee module + active split module): 1 can mean baseline-only (no module Active)",
  epoch: "count of PromoteActive executions, fee and split modules alike (the /api/epochs records are the engine's)",
  engine: "true when goal, task, hypothesis, confidence, next and simulations come from the engine's newest core record",
  block: "head block (head tier); every other field is read at the finalized block",
};

const GETTERS: Record<string, () => Promise<unknown>> = {
  core: async () => (LIVE ? { ...(await getCore()), notes: CORE_NOTES } : {}),
  modules: source.getModules,
  epochs: source.getEpochs,
  autonomy: source.getAutonomy,
  treasury: source.getTreasury,
  security: source.getSecurity,
  queue: source.getQueue,
  rules: source.getRules,
  thread: source.getThread,
  lab: source.getLab,
  memory: source.getMemory,
  journal: source.getJournal,
  ideas: source.getIdeas,
  xp: source.getXp,
  clones: source.getClones,
};

export async function GET(_req: Request, ctx: RouteContext<"/api/[name]">) {
  const get = GETTERS[(await ctx.params).name];
  if (!get) return Response.json({ error: "not found", routes: Object.keys(GETTERS) }, { status: 404 });
  return Response.json(await get(), {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" },
  });
}
