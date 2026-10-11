// Maintenance mode first (security.ts maintenanceOn): one static 503 page for every request but the paths that stay up.
// Then the play origin's per-request CSP (security.ts playCsp): a fresh nonce on every page, which Next puts on its own
// scripts and the root layout puts on the wallet guard. Also tells the layouts which game a request is for. The main
// site passes through untouched.
import { type NextRequest, NextResponse } from "next/server.js";
import { dropsQuery, MAINTENANCE_PAGE, maintenanceHeaders, maintenanceOn, playRequest, roleOf, staysUp } from "./security.ts";

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
  if (roleOf(process.env) !== "play") return NextResponse.next();
  // router prefetches carry no page of their own: no nonce for them (the matcher lets them in for maintenance mode)
  if (request.headers.has("next-router-prefetch") || request.headers.get("purpose") === "prefetch") return NextResponse.next();
  // one cached page per game: a query string on a game page is dropped with a redirect (not on RSC requests, see
  // security.ts dropsQuery)
  if (dropsQuery(request.nextUrl.pathname, request.nextUrl.search, request.headers.has("rsc"))) {
    const u = request.nextUrl.clone();
    u.search = "";
    return NextResponse.redirect(u, 307);
  }
  const nonce = newNonce();
  const { csp, slug } = playRequest(request.nextUrl.pathname, nonce, dev);
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
