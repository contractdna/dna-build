"use client";
// The visitor's wallet, shared by every page that sends a transaction (/trade, /play, /proposals): the wallet modal
// people know (RainbowKit over wagmi): the wallets installed in this browser first, then the known ones, and for phone
// wallets a WalletConnect QR code or app link when the build has a project id (NEXT_PUBLIC_WC_PROJECT_ID). Without
// one the modal lists only what the browser has (EIP-6963) and nothing leaves the page. wagmi keeps the connection
// across in-site navigation and reloads; the pages that use it mount WalletProvider. Reads (balances, receipts) go
// over the public RPC; the wallet only signs, through one send path (sendTx). No analytics: WalletConnect's telemetry
// is off here, RainbowKit turns off Coinbase's and the first wallet's SDK analytics itself.
import "@rainbow-me/rainbowkit/styles.css";
import { connectorsForWallets, darkTheme, RainbowKitProvider, useConnectModal, type WalletList } from "@rainbow-me/rainbowkit";
import { coinbaseWallet, rabbyWallet, rainbowWallet, trustWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { type Address, createPublicClient, erc20Abi, formatEther, type Hex, http, toHex } from "viem";
import { createConfig, useAccount, useConnectors, WagmiProvider } from "wagmi";
import { disconnect as wagmiDisconnect, getAccount, switchChain } from "wagmi/actions";
import { mainnet } from "wagmi/chains";
import { SITE_HOST, SITE_URL } from "../_data/flags";
import { ui } from "./ui";
import w from "./wallet.module.css";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
export const pub = () => createPublicClient({ transport: http(RPC) });
export const fmtUnits = (wei: bigint) => Number(formatEther(wei)).toLocaleString("en-US", { maximumSignificantDigits: 6 });
export const why = (e: unknown) => String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e).split("\n")[0].slice(0, 200);
export const etherscanTx = (hash: string) => `https://etherscan.io/tx/${hash}`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "";
const touch = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
// Every wallet listed works under the site's CSP (security.ts): extensions through their injected provider (any
// extension also shows under "Installed" from its EIP-6963 announcement), phone wallets over WalletConnect's relay.
// Coinbase only as its passkey wallet in a popup: its app path would need WalletLink's own socket. Not the first
// wallet's SDK (its own socket server): its extension is found by EIP-6963, its app by the WalletConnect QR code.
coinbaseWallet.preference = "smartWalletOnly";
// The generic WalletConnect QR code (any wallet app scans it), under its own id: under RainbowKit's own id it
// would add Reown's AppKit modal, which fetches its config and posts analytics on page load. Desktop only: a phone
// opens each wallet's app link instead.
const walletConnectQr: WalletList[number]["wallets"][number] = (p) => ({ ...walletConnectWallet(p), id: "walletConnectQr", hidden: touch });
// RainbowKit builds its wallet list only with a project id; without one the list is what wagmi finds in the browser
// (EIP-6963 announcements, shown under "Installed"): no WalletConnect entry, no relay, no QR code.
const connectors = WC_PROJECT_ID
  ? connectorsForWallets([{ groupName: "Wallets", wallets: [rabbyWallet, rainbowWallet, trustWallet, coinbaseWallet, walletConnectQr] }], {
      appName: "DNA", appIcon: `${SITE_URL}/icon.png`, projectId: WC_PROJECT_ID,
      walletConnectParameters: { telemetryEnabled: false },
    })
  : [];
// mainnet only: the swap, the idea market and the games are there; another network shows the "switch" row below
const config = createConfig({ chains: [mainnet], connectors, transports: { [mainnet.id]: http(RPC) }, ssr: true });

// the site's own tokens (globals.css): ink, bone, ash text, the rule hairline, Karrik; amber as the accent
const base = darkTheme({ accentColor: "#ffc06b", accentColorForeground: "#05080a", borderRadius: "small", overlayBlur: "small" });
const theme = {
  ...base,
  fonts: { body: "var(--karrik)" },
  colors: {
    ...base.colors,
    modalBackground: "#05080a", modalBackdrop: "rgba(5, 8, 10, 0.72)", modalBorder: "rgba(255, 255, 255, 0.12)",
    modalText: "#eef3f2", modalTextDim: "#7f8d8c", modalTextSecondary: "#7f8d8c",
    generalBorder: "rgba(255, 255, 255, 0.12)", generalBorderDim: "rgba(255, 255, 255, 0.06)",
    closeButton: "#b8c4c3", closeButtonBackground: "rgba(255, 255, 255, 0.08)",
    actionButtonSecondaryBackground: "rgba(255, 255, 255, 0.08)", profileForeground: "#05080a",
  },
};

// `connect()` is a plain function (the swap box, the idea forms and the game panels call it from event handlers):
// the mounted modal registers its opener here
let openModal: (() => void) | undefined;
function ModalBridge() {
  const { openConnectModal } = useConnectModal();
  useEffect(() => { openModal = openConnectModal; return () => { openModal = undefined; }; }, [openConnectModal]);
  return null;
}

/** Wraps a page that uses the wallet: wagmi, its query cache and the wallet modal. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [queries] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queries}>
        <RainbowKitProvider theme={theme} modalSize="compact" initialChain={mainnet} appInfo={{ appName: "DNA" }}>
          <ModalBridge />
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/** Opens the wallet modal (does nothing until the page's WalletProvider is mounted, or while connected). */
export function connect() { openModal?.(); }
export function disconnect() { void wagmiDisconnect(config); }

// balances changed (a swap, an approval, a stake): every WalletBar reads them again
const subs = new Set<() => void>();
let tick = 0;
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const refreshBalances = () => { tick += 1; subs.forEach((f) => f()); };

/** The connected wallet: `ready` = an account on Ethereum mainnet. */
export function useWallet() {
  const { address, chainId, connector } = useAccount();
  const t = useSyncExternalStore(subscribe, () => tick, () => 0);
  return { account: address ?? null, chain: chainId ?? null, name: connector?.name ?? null, ready: !!address && chainId === 1, tick: t };
}

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

/** Links that reopen `url` inside a wallet app's browser (each wallet's documented universal link): a phone without
 *  WalletConnect (no project id) and without a wallet in this browser is never a dead end. */
export function openIn(url: string) {
  const u = new URL(url);
  const enc = encodeURIComponent(u.href);
  return [
    { name: "MetaMask", href: `https://link.metamask.io/dapp/${u.host}${u.pathname}${u.search}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
    { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
  ];
}

/** One transaction from `from` (the account the caller's checks ran for), on mainnet, waited for over the public RPC.
 *  `onStatus` gets each step. Refused if the wallet has switched to another account since. */
export async function sendTx(from: Address, tx: { to: Address; data: Hex; value?: bigint }, label: string, onStatus: (s: string, hash?: Hex) => void): Promise<Hex> {
  const { address, connector } = getAccount(config);
  if (!address || !connector) throw new Error("connect a wallet first");
  if (address.toLowerCase() !== from.toLowerCase()) throw new Error("the wallet's account changed; start again");
  // the wallet's own provider (extension, WalletConnect session or Coinbase), asked directly: the request below is
  // exactly what the wallet signs
  const eth = (await connector.getProvider()) as Eip1193;
  if (Number(await eth.request({ method: "eth_chainId" })) !== 1) throw new Error("switch your wallet to Ethereum mainnet");
  onStatus(`${label}: confirm in your wallet...`);
  const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, data: tx.data, value: toHex(tx.value ?? BigInt(0)), chainId: "0x1" }] });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`${label}: the wallet returned no transaction hash; check your wallet before trying again`);
  onStatus(`${label}: waiting for the transaction...`, hash as Hex);
  // sent is sent: if the RPC can't confirm it (rate limit, outage), say so instead of reporting a failure
  const r = await pub().waitForTransactionReceipt({ hash: hash as Hex }).catch(() => {
    throw new Error(`${label} sent (${hash}), but this page could not read its receipt. Check it in your wallet or on Etherscan before trying again.`);
  });
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  return hash as Hex;
}

/** The connect button (opens the modal), then the account, the network check and its ETH and DNA balances. */
export function WalletBar({ token }: { token: Address | null }) {
  const { account, chain, name, tick } = useWallet();
  const [bal, setBal] = useState<{ eth: bigint; dna: bigint | null } | "unavailable" | null>(null);
  const [error, setError] = useState("");
  // no project id, a phone, nothing injected: the modal would be empty, so offer the wallet apps' own browsers
  const found = useConnectors().length;
  const [here, setHere] = useState<string | null>(null);
  useEffect(() => { setHere(touch() ? window.location.href.split("#")[0] : null); }, []);
  const noWay = !WC_PROJECT_ID && !found ? here : null;
  useEffect(() => {
    setBal(null);
    if (!account) return;
    let live = true;
    const c = pub();
    Promise.all([
      c.getBalance({ address: account }),
      token ? c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }) : Promise.resolve(null),
    ]).then(([eth, dna]) => { if (live) setBal({ eth, dna }); }).catch(() => { if (live) setBal("unavailable"); });
    return () => { live = false; };
  }, [account, token, tick]);
  const toMainnet = () => switchChain(config, { chainId: mainnet.id }).then(() => setError(""), (e: unknown) => setError(why(e)));

  return (
    <div className={w.wallet} role="group" aria-label="Wallet">
      {account ? (
        <>
          <p className={w.who}>
            <span>{name}: <strong title={account}>{shortAddr(account)}</strong></span>
            <button type="button" className={w.link} onClick={disconnect}>Disconnect</button>
          </p>
          {chain !== 1 ? (
            <p className={w.warn}>Your wallet is on another network. DNA is on Ethereum mainnet.{" "}
              <button type="button" className={ui.button} onClick={() => void toMainnet()}>Switch to Ethereum</button></p>
          ) : (
            <p className={w.bal}>{bal === "unavailable" ? "Balances can't be read right now." : bal ? <>{fmtUnits(bal.eth)} ETH{bal.dna !== null && <> · {fmtUnits(bal.dna)} DNA</>}</> : "Reading balances..."}</p>
          )}
        </>
      ) : (
        <button type="button" className={`${ui.button} ${w.connect}`} onClick={connect}>Connect wallet</button>
      )}
      {!account && noWay && (
        <div className={w.pick}>
          <p className={w.label}>No wallet in this browser. Open this page inside your wallet app:</p>
          {openIn(noWay).map((l) => <a key={l.name} className={ui.button} href={l.href} rel="noopener noreferrer">{l.name}</a>)}
        </div>
      )}
      {error && <p className={w.label} role="status">{error}</p>}
    </div>
  );
}

/** Address poisoning: look-alike addresses and fake tokens. Shown wherever the page asks for a signature. */
export const PoisonNote = () => (
  <p className={w.note}>
    Copy DNA&apos;s addresses only from this site ({SITE_HOST}). Scammers send fake DNA tokens and look-alike addresses that match
    the first and last characters of real ones. Check the whole address. This site never asks for your seed phrase or private key.
  </p>
);
