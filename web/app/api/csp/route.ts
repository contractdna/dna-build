// Both origins' CSP violation reports (report-uri): one short log line per report, nothing stored, nothing echoed.
// A blocked request from a game page is a reason to look at that game (the kill switch is in the engine); a blocked
// script on the main site, at the page that rendered it.
export async function POST(req: Request) {
  const text = (await req.text().catch(() => "")).slice(0, 4_000);
  let r: Record<string, unknown> = {};
  try { r = (JSON.parse(text)["csp-report"] ?? {}) as Record<string, unknown>; } catch { /* not JSON */ }
  const pick = (k: string) => String(r[k] ?? "").slice(0, 200).replace(/[^\x20-\x7e]/g, "?");
  console.warn(`csp: ${pick("violated-directive")} blocked ${pick("blocked-uri")} on ${pick("document-uri")}`);
  return new Response(null, { status: 204 });
}
