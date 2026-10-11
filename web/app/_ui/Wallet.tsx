"use client";
// The visitor's wallet, shared by every page that sends a transaction (/trade, /proposals): one connection per page
// load, kept across in-site navigation (a small store, so the swap box, the idea forms and each stake form see the same
// account; a reload asks again), the connect bar, the
// anti-poisoning note and one send path. Reads (balances, receipts) go over the public RPC; the wallet only signs.
import { useEffect, useState, useSyncExternalStore } from "react";
import { type Address, createPublicClient, erc20Abi, formatEther, type Hex, http, toHex } from "viem";
import { SITE_HOST } from "../_data/flags";
import { ui } from "./ui";
import { accountOf, discover, type Found, openIn } from "./discover";
import w from "./wallet.module.css";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
export const pub = () => createPublicClient({ transport: http(RPC) });
export const fmtUnits = (wei: bigint) => Number(formatEther(wei)).toLocaleString("en-US", { maximumSignificantDigits: 6 });
export const why = (e: unknown) => String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e).split("\n")[0].slice(0, 200);
export const etherscanTx = (hash: string) => `https://etherscan.io/tx/${hash}`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type State = { wallet: Found | null; account: Address | null; chain: number | null; picking: Found[] | null; missing: "phone" | "desktop" | null; error: string; tick: number };
let state: State = { wallet: null, account: null, chain: null, picking: null, missing: null, error: "", tick: 0 };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
let unfollow: (() => void) | null = null;

async function choose(f: Found) {
  set({ picking: null, error: "" });
  try {
    const a = accountOf(await f.provider.request({ method: "eth_requestAccounts" }));
    if (!a) throw new Error("the wallet returned no account");
    const chain = Number(await f.provider.request({ method: "eth_chainId" }));
    unfollow?.();
    // follow the wallet: another account, another network, or locked
    const acc = (x: unknown) => { const n = accountOf(x); if (n) set({ account: n }); else disconnect(); };
    const net = (x: unknown) => set({ chain: Number(x) });
    f.provider.on?.("accountsChanged", acc);
    f.provider.on?.("chainChanged", net);
    unfollow = () => { f.provider.removeListener?.("accountsChanged", acc); f.provider.removeListener?.("chainChanged", net); };
    set({ wallet: f, account: a, chain });
  } catch (e) {
    set({ error: why(e) });
  }
}
export async function connect() {
  set({ error: "", missing: null });
  const found = await discover(window as unknown as EventTarget);
  if (!found.length) return set({ missing: window.matchMedia("(pointer: coarse)").matches ? "phone" : "desktop" });
  if (found.length === 1) return choose(found[0]);
  set({ picking: found });
}
export function disconnect() {
  unfollow?.();
  unfollow = null;
  set({ wallet: null, account: null, chain: null });
}
async function toMainnet() {
  const p = state.wallet?.provider;
  try {
    await p?.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
    set({ chain: Number(await p?.request({ method: "eth_chainId" })) });
  } catch (e) {
    set({ error: why(e) });
  }
}
/** Balances changed (a swap, an approval, a stake): read them again. */
export const refreshBalances = () => set({ tick: state.tick + 1 });

/** The connected wallet: `ready` = an account on Ethereum mainnet. */
export function useWallet() {
  const s = useSyncExternalStore(subscribe, () => state, () => state);
  return { ...s, ready: !!s.account && s.chain === 1 };
}

/** One transaction from `from` (the account the caller's checks ran for), on mainnet, waited for over the public RPC.
 *  `onStatus` gets each step. Refused if the wallet has switched to another account since. */
export async function sendTx(from: Address, tx: { to: Address; data: Hex; value?: bigint }, label: string, onStatus: (s: string, hash?: Hex) => void): Promise<Hex> {
  const eth = state.wallet?.provider;
  if (!eth || !state.account) throw new Error("connect a wallet first");
  if (state.account.toLowerCase() !== from.toLowerCase()) throw new Error("the wallet's account changed; start again");
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

/** Connect / pick / open-in-wallet-app, then the account, the network check and its ETH and DNA balances. */
export function WalletBar({ token }: { token: Address | null }) {
  const { wallet, account, chain, picking, missing, error, tick } = useWallet();
  const [bal, setBal] = useState<{ eth: bigint; dna: bigint | null } | "unavailable" | null>(null);
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

  return (
    <div className={w.wallet} role="group" aria-label="Wallet">
      {account ? (
        <>
          <p className={w.who}>
            <span>{wallet?.name}: <strong title={account}>{shortAddr(account)}</strong></span>
            <button type="button" className={w.link} onClick={disconnect}>Disconnect</button>
          </p>
          {chain !== 1 ? (
            <p className={w.warn}>Your wallet is on another network. DNA is on Ethereum mainnet.{" "}
              <button type="button" className={ui.button} onClick={() => void toMainnet()}>Switch to Ethereum</button></p>
          ) : (
            <p className={w.bal}>{bal === "unavailable" ? "Balances can't be read right now." : bal ? <>{fmtUnits(bal.eth)} ETH{bal.dna !== null && <> · {fmtUnits(bal.dna)} DNA</>}</> : "Reading balances..."}</p>
          )}
        </>
      ) : picking ? (
        <div className={w.pick}>
          <p className={w.label}>Pick a wallet</p>
          {picking.map((f) => (
            <button key={f.id} type="button" className={ui.button} onClick={() => void choose(f)}>
              {f.icon && <img src={f.icon} alt="" width={20} height={20} />}{f.name}
            </button>
          ))}
        </div>
      ) : (
        <button type="button" className={`${ui.button} ${w.connect}`} onClick={() => void connect()}>Connect wallet</button>
      )}
      {!account && missing === "phone" && (
        <div className={w.pick}>
          <p className={w.label}>No wallet in this browser. Open this page inside your wallet app:</p>
          {openIn(window.location.href.split("#")[0]).map((l) => <a key={l.name} className={ui.button} href={l.href} rel="noopener noreferrer">{l.name}</a>)}
        </div>
      )}
      {!account && missing === "desktop" && (
        <p className={w.label}>No wallet found in this browser. Add a wallet extension (Rabby, Coinbase Wallet or another) and reload this page, or open it in your phone&apos;s wallet app.</p>
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
