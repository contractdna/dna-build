// GET /api/changes: the site's public changelog (app/_data/changes.json), newest first:
// [{ id, at (ISO), title (≤ 60 chars), summary (≤ 200 chars), url (the page most affected) }]. The engine posts about
// each new entry. Every site change adds one; test/changes.test.mjs checks the shape.
import changes from "../../_data/changes.json";

export const dynamic = "force-static";

export function GET() {
  return Response.json(changes, {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60, s-maxage=60" },
  });
}
