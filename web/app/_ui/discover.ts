// Finding the visitor's wallet, plain TypeScript (no React) so web/test runs it. Desktop: every extension that
// announces itself over EIP-6963 (Rabby, Coinbase, ...), else the legacy window.ethereum. Phones have no
// extensions: the page offers to reopen itself inside a wallet app's own browser, where the wallet is injected. No
// SDK, no relay, no third-party script: the wallet only ever talks to this page through its own provider.

export type Eip1193 = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, fn: (x: unknown) => void) => void;
  removeListener?: (event: string, fn: (x: unknown) => void) => void;
};
export type Found = { id: string; name: string; icon: string | null; provider: Eip1193 };

type Win = EventTarget & { ethereum?: unknown };
const isProvider = (p: unknown): p is Eip1193 => !!p && typeof p === "object" && typeof (p as Eip1193).request === "function";
// an announced icon is shown only as a data: image (never a remote URL the wallet names)
const iconOf = (s: unknown) => (typeof s === "string" && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(s) ? s : null);

/** The wallets in this browser: EIP-6963 announcements (one per wallet, by rdns), else window.ethereum. Wallets answer
 *  the request synchronously; `ms` waits for slow ones. */
export async function discover(w: Win, ms = 300): Promise<Found[]> {
  const found = new Map<string, Found>();
  const on = (e: Event) => {
    const d = (e as CustomEvent).detail as { info?: { uuid?: unknown; rdns?: unknown; name?: unknown; icon?: unknown }; provider?: unknown } | undefined;
    if (!d || !isProvider(d.provider)) return;
    const id = String(d.info?.rdns || d.info?.uuid || "");
    if (!id || found.has(id)) return;
    found.set(id, { id, name: String(d.info?.name || "Wallet").slice(0, 40), icon: iconOf(d.info?.icon), provider: d.provider });
  };
  w.addEventListener("eip6963:announceProvider", on);
  w.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, ms));
  w.removeEventListener("eip6963:announceProvider", on);
  if (!found.size && isProvider(w.ethereum)) return [{ id: "injected", name: "Browser wallet", icon: null, provider: w.ethereum }];
  return [...found.values()];
}

/** Links that reopen `url` inside a wallet app's browser (each wallet's documented universal link). */
export function openIn(url: string) {
  const u = new URL(url);
  const enc = encodeURIComponent(u.href);
  return [
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
    { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
  ];
}

/** The first account a wallet returned, if it is a 20-byte hex address. */
export const accountOf = (r: unknown): `0x${string}` | null => {
  const a = Array.isArray(r) ? r[0] : null;
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : null;
};
