// Maintenance mode first (security.ts maintenanceOn): one static 503 page for every request but the paths that stay up.
// Then each origin's per-request CSP (security.ts mainCsp, playCsp): a fresh nonce on every page, which Next puts on its
// own scripts and the root layout on its inline ones. On the play origin, also tells the layouts which game a request
// is for.
import { type NextRequest, NextResponse } from "next/server.js";
import { dropsQuery, MAINTENANCE_PAGE, mainCsp, maintenanceHeaders, maintenanceOn, playRequest, roleOf, staysUp } from "./security.ts";

const newNonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");

export function proxy(request: NextRequest) {
  const dev = process.env.NODE_ENV === "development";
  // process.env is read per request (the Node proxy runtime): a variable change plus a restart applies it, no rebuild
  if (maintenanceOn(process.env) && request.nextUrl.pathname === "/api/health") {
    // the healthcheck still passes, and says nothing about the build or its data
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }
  if (maintenanceOn(process.env) && !staysUp(request.nextUrl.pathname)) {
    return new NextResponse(request.method === "HEAD" ? null : MAINTENANCE_PAGE, { status: 503, headers: maintenanceHeaders(roleOf(process.env), newNonce(), dev) });
  }
  // every request below gets its own nonce and CSP, router and browser prefetches too: a prefetch can be a whole page
  // (a CDN may keep it for every visitor), and passed on as it came it would carry the visitor's own nonce, CSP or slug
  // headers to Next
  if (roleOf(process.env) !== "play") {
    const nonce = newNonce();
    return withCsp(request, nonce, mainCsp(nonce, dev), null);
  }
  // one cached page per game: a query string on a game page is dropped with a redirect (not on RSC requests, see
  // security.ts dropsQuery)
  if (dropsQuery(request.nextUrl.pathname, request.nextUrl.search, request.headers.has("rsc"))) {
    const u = request.nextUrl.clone();
    u.search = "";
    return NextResponse.redirect(u, 307);
  }
  const nonce = newNonce();
  const { csp, slug } = playRequest(request.nextUrl.pathname, nonce, dev);
  return withCsp(request, nonce, csp, slug);
}

/** The request on to Next with its nonce and its CSP (Next reads the nonce from the request's CSP; both replace any the
 *  visitor sent), the CSP on the response; the game slug only when the path names a valid one (anything else, a
 *  visitor's header included, is dropped). */
function withCsp(request: NextRequest, nonce: string, csp: string, slug: string | null) {
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  if (slug) headers.set("x-game-slug", slug);
  else headers.delete("x-game-slug");
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon\\.png|apple-icon\\.png).*)"],
};
