import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { connection } from "next/server";
import { type AbiFunction, toFunctionSelector } from "viem";
import "./globals.css";
import { roleOf } from "../security";
import { LIVE, SITE_URL } from "./_data/flags";
import { getCore, getToken } from "./_data/live";
import { LiveProvider } from "./_live/LiveProvider";
import { FACTORY, loadGame } from "./g/game";
import { guardScript } from "./_ui/guard";

// Self-hosted, OFL (licence beside the files): Karrik (Phantom Foundry / Velvetyne), the one typeface of the site
const karrik = localFont({
  src: [{ path: "./fonts/Karrik-Regular.woff2", style: "normal" }, { path: "./fonts/Karrik-Italic.woff2", style: "italic" }],
  variable: "--font-karrik", display: "swap",
});

export const metadata: Metadata = {
  title: "DNA · Watch a token evolve",
  description: "DNA is an Ethereum token whose Uniswap hook changes in public. An AI tests each change on real trades and keeps only what works, inside limits nobody can change.",
  metadataBase: new URL(SITE_URL),
  // link previews (X, Telegram, Discord): the token image, the same file the token's metadata points at
  openGraph: { type: "website", siteName: "DNA", images: [{ url: "/token.png", width: 512, height: 512, alt: "DNA" }] },
  twitter: { card: "summary", site: "@contractdna" },
};

export const viewport: Viewport = { themeColor: "#05080A" };

/** marks JS before first paint, so intro-hidden chrome never flashes and no-JS visitors still see everything */
const JS_CLASS = "document.documentElement.classList.add('js')";

export default async function RootLayout({ children }: LayoutProps<"/">) {
  if (roleOf(process.env) === "play") return <PlayRoot>{children}</PlayRoot>;
  // LIVE: server-render the chain-backed core (per request); mock: nothing dynamic, pages stay static
  if (LIVE) await connection(); // outside the catch below: Next must see the dynamic bail-out at build time
  const [initial, ca] = LIVE ? await Promise.all([getCore().catch(() => undefined), getToken().catch(() => undefined)]) : [];
  return (
    <html lang="en" className={karrik.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: JS_CLASS }} />
      </head>
      <body><LiveProvider initial={initial} ca={ca}>{children}</LiveProvider></body>
    </html>
  );
}

/** The play origin (security.ts): the wallet guard first, with this request's nonce, then the game; no live feed. */
async function PlayRoot({ children }: { children: React.ReactNode }) {
  await connection();
  const h = await headers();
  const nonce = h.get("x-nonce") ?? "";
  const slug = h.get("x-game-slug") ?? "";
  const g = loadGame(slug);
  const guard = guardScript({
    slug, address: g?.address ?? `0x${"0".repeat(40)}`, factory: FACTORY, chainId: "0x1", killUrl: `/api/kill/${encodeURIComponent(slug)}`,
    selectors: g ? selectorsOf(g.abi) : [],
  });
  return (
    <html lang="en" className={karrik.variable} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: guard }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: JS_CLASS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

/** The selectors of the game's state-changing, non-payable functions: the only calls the guard lets through. */
function selectorsOf(abi: unknown[]) {
  return (abi as AbiFunction[]).filter((f) => f.type === "function" && f.stateMutability === "nonpayable").map((f) => toFunctionSelector(f).toLowerCase());
}
