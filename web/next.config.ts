import type { NextConfig } from "next";
import { roleOf, roleRedirects, staticHeaders } from "./security";

const nextConfig: NextConfig = {
  // pin the workspace root: never infer it from lockfiles outside the repo
  turbopack: { root: __dirname },
  // wagmi's connectors reach Base's account SDK (never used here, only loaded on demand in the browser), whose Node
  // entry names optional packages that are not installed; left out of the server bundle so the build resolves nothing
  serverExternalPackages: ["@base-org/account"],
  // LIVE pages render per request (Postgres), and Next marks dynamic HTML `private, no-store`. Every page is public
  // (no cookies, no per-visitor data), so let a CDN (docs/CAPACITY.md) hold the HTML for 5 s: one render per page per
  // 5 s per edge instead of one per visit. Next keeps a Cache-Control that is already set on a dynamic page
  // (app-page-runtime: `!isSSG && !res.getHeader('Cache-Control')`), so this overrides only that default. Never on
  // RSC/prefetch requests (`rsc` header: the client router's payloads, which vary by router state) or /api, /_next.
  // Browsers still revalidate every time (max-age=0). No stale-while-revalidate: Cloudflare ignores it next to s-maxage
  // ("s-maxage disables stale-while-revalidate"), so HTML is at most 5 s old, also right after a deploy.
  async headers() {
    // Mock (pre-launch) pages are prerendered and Next would send `s-maxage=31536000`: Cloudflare would then hold HTML
    // for a year and serve it after a deploy, pointing at removed /_next chunks. Cap it at 60 s instead.
    const sMaxAge = process.env.NEXT_PUBLIC_LIVE === "1" ? 5 : 60;
    return [{
      source: "/:path((?!api/|api$|_next/).*)",
      missing: [{ type: "header", key: "rsc" }],
      headers: [{ key: "Cache-Control", value: `public, max-age=0, s-maxage=${sMaxAge}` }],
    }, {
      // the token image is the token's metadata image (launchpads, wallets, explorers): any origin may load or fetch it
      source: "/token.png",
      headers: [{ key: "Access-Control-Allow-Origin", value: "*" }, { key: "Cross-Origin-Resource-Policy", value: "cross-origin" }],
    }, {
      // the role's security headers on everything (security.ts); the play origin's CSP is per request (proxy.ts)
      source: "/:path*",
      headers: staticHeaders(roleOf(process.env), process.env.NODE_ENV === "development"),
    }];
  },
  async redirects() {
    return roleRedirects(roleOf(process.env));
  },
};

export default nextConfig;
