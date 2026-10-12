// The site's two origins and their security headers (next.config.ts, proxy.ts). One build, two Railway services:
//  - main (SITE_ROLE unset): the site. Never serves game code: /g/* redirects to the play origin.
//  - play (SITE_ROLE=play, play.<site>): only the Sequencer's game pages (/g/*), their assets and the kill check.
// Game pages are code an AI wrote, so they run on their own origin: they can't read the main site's storage or script
// its pages, and the main site sets only host-only (__Host-) cookies, never sent to play.<site>. The play origin's CSP
// carries a per-request nonce (proxy.ts): no inline script without it, no eval, no remote script, no network but its
// own origin, no frames, no workers.
export type Role = "main" | "play";
export const roleOf = (env: Record<string, string | undefined>): Role => (env.SITE_ROLE === "play" ? "play" : "main");
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://genomedna.xyz";
export const PLAY_URL = process.env.NEXT_PUBLIC_PLAY_URL ?? `https://play.${new URL(SITE_URL).host}`;
/** A game folder name (the Sequencer's slug rule). */
export const SLUG = /^[a-z][a-z0-9-]{2,30}$/;

const join = (d: Record<string, string>) => Object.entries(d).map(([k, v]) => `${k} ${v}`).join("; ");

/** The play origin's policy for one response. */
export function playCsp(nonce: string, dev = false) {
  return join({
    "default-src": "'none'",
    "script-src": `'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src": "'self' 'unsafe-inline'",
    "img-src": "'self' data:",
    "font-src": "'self'",
    "connect-src": "'self'",
    "frame-src": "'none'",
    "child-src": "'none'",
    "worker-src": "'none'",
    "manifest-src": "'self'",
    "frame-ancestors": "'none'",
    "form-action": "'none'",
    "base-uri": "'none'",
    "object-src": "'none'",
    // no peer connections (WebRTC reaches the network around connect-src)
    "webrtc": "'block'",
    "report-uri": "/api/csp",
  });
}

/** The wallet modal offers WalletConnect only in a build with a project id (app/_ui/Wallet.tsx); the main site's
 *  policy opens to its relay and verify origins only then. */
export const WALLET_CONNECT = !!process.env.NEXT_PUBLIC_WC_PROJECT_ID;

/** The main site's policy: its own scripts (Next's inline bootstrap needs 'unsafe-inline' on statically rendered
 *  pages), its own fonts and images; reads over https (the proof page checks the attestation and RPC providers). */
export function mainCsp(dev = false, walletConnect = WALLET_CONNECT) {
  return join({
    "default-src": "'self'",
    "script-src": `'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src": "'self' 'unsafe-inline'",
    "img-src": "'self' data: blob:",
    "font-src": "'self'",
    // WalletConnect: the relay carries the encrypted session between this page and a phone wallet over a websocket,
    // which `https:` does not cover. Its verify and rpc APIs are plain https (already allowed); telemetry is off.
    "connect-src": `'self' https:${walletConnect ? " wss://relay.walletconnect.org" : ""}`,
    // WalletConnect's verify step loads a hidden frame from this origin to attest the page's origin to the wallet
    // (the wallet then shows where the request comes from); blocked, the session waits for its timeout instead.
    "frame-src": walletConnect ? "https://verify.walletconnect.org" : "'none'",
    "frame-ancestors": "'none'",
    "form-action": "'self'",
    "base-uri": "'self'",
    "object-src": "'none'",
  });
}

export const HSTS = "max-age=63072000; includeSubDomains";

/** Headers on every response of a role (the play CSP itself is per request, from proxy.ts). */
export function staticHeaders(role: Role, dev = false): { key: string; value: string }[] {
  const common = [
    { key: "Strict-Transport-Security", value: HSTS },
    { key: "X-Content-Type-Options", value: "nosniff" },
  ];
  if (role === "main") return [...common, { key: "Content-Security-Policy", value: mainCsp(dev) }, { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }];
  return [
    ...common,
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()" },
  ];
}

/** Each role's redirects: main sends game pages to the play origin; play sends everything else to the main site. */
export function roleRedirects(role: Role) {
  if (role === "main") return [{ source: "/g/:path*", destination: `${PLAY_URL}/g/:path*`, permanent: false }];
  return [{ source: "/:path((?!g/|g$|_next/|api/kill/|api/csp$|icon\\.png$|apple-icon\\.png$|cursor\\.svg$|cursor-link\\.svg$).*)", destination: `${SITE_URL}/:path`, permanent: false }];
}

/** What proxy.ts does for one play-origin request: the CSP with a fresh nonce, and the game the path names (only a
 *  valid slug; anything else, including a header the visitor sent, is dropped). */
export function playRequest(pathname: string, nonce: string, dev = false) {
  const slug = pathname.match(/^\/g\/([^/]+)/)?.[1] ?? "";
  return { csp: playCsp(nonce, dev), slug: SLUG.test(slug) ? slug : null };
}

/** Does the play origin redirect this request to its query-free URL? Game pages only, and never an RSC request: Next
 *  keys those on their `_rsc` query, and stripping it would let a CDN that ignores `Vary: rsc` store an RSC payload
 *  under the page's own URL. */
export const dropsQuery = (pathname: string, search: string, rsc: boolean) => pathname.startsWith("/g/") && !!search && !rsc;

/** A game's kill state without live data: the play origin, which serves games, says "paused" (fail closed); the main
 *  site's pre-launch pages have no games to pull. The enclave's page check builds the play origin offline (no live
 *  data, PAGECHECK=1) to run a game before it ships: nothing is pulled there. A live build never gets here. */
export const noLiveData = (role: Role, env: Record<string, string | undefined> = {}): { killed: boolean; why?: string } =>
  role === "play" && env.PAGECHECK !== "1" ? { killed: true, why: "the game's status is unavailable (no live data)" } : { killed: false };

/** A `page-kill` record's public reason (the engine writes fixed texts; anything else reads as a plain one). */
export const killWhy = (w: unknown) => (typeof w === "string" && /^[a-z0-9 ,.:;()'-]{3,160}$/i.test(w) ? w : "this game's page was pulled");

/** Maintenance mode (proxy.ts): SITE_MAINTENANCE=1, read per request, so setting it and restarting the service applies
 *  it without a rebuild. Every request gets one static page, except the token image (the token's metadata points at
 *  it, byte for byte), the health check (a fixed body then, from proxy.ts) and the signed log (/api/log/*: the engine
 *  and the watchdog read records from it). Nothing that falls to the not-found page stays up: the root layout renders
 *  there. /_next/static, /_next/image, /icon.png and /apple-icon.png never reach the proxy (its matcher). */
export const maintenanceOn = (env: Record<string, string | undefined>) => env.SITE_MAINTENANCE === "1";
export const staysUp = (pathname: string) => /^\/(token\.png|api\/health|api\/log\/.+)$/.test(pathname);

/** The maintenance response's headers: the role's security headers and CSP (the play origin's CSP with a fresh nonce,
 *  though the page runs no script), never cached, retry in 10 minutes. */
export function maintenanceHeaders(role: Role, nonce: string, dev = false) {
  const h = new Headers(staticHeaders(role, dev).map(({ key, value }): [string, string] => [key, value]));
  if (role === "play") h.set("Content-Security-Policy", playCsp(nonce, dev));
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("Retry-After", "600");
  return h;
}

/** The maintenance page: no script, no external file, only the helix, the wordmark, one line and the X link. */
export const MAINTENANCE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>DNA</title>
<style>
html,body{margin:0;height:100%;background:#05080a;color:#eef3f2;color-scheme:dark;font:16px/1.5 ui-sans-serif,system-ui,sans-serif}
main{box-sizing:border-box;min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:0 16px;text-align:center}
.mark{letter-spacing:.3em;margin-right:-.3em;font-size:14px}
p{margin:0;font-size:20px}
a{color:#7f8d8c;font-size:14px;text-decoration:none}
a:hover,a:focus-visible{color:#eef3f2}
</style></head>
<body><main>
<svg width="24" height="64" viewBox="0 0 24 64" fill="none" stroke-width="1.5" aria-hidden="true"><path d="M4 0C4 16 20 16 20 32S4 48 4 64" stroke="#4fd6c8"/><path d="M20 0C20 16 4 16 4 32S20 48 20 64" stroke="#eef3f2"/></svg>
<div class="mark">DNA</div>
<p>We'll be right back.</p>
<a href="https://x.com/contractdna">@contractdna on X</a>
</main></body></html>
`;
