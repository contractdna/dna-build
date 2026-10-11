"use client";
// The swap box: exact-input buys and sells of DNA in its hook pool, from the visitor's own wallet. Quotes are read over
// the public RPC (no wallet needed); the wallet is the one the visitor connects (../_ui/Wallet.tsx). Every transaction is built here (swap.ts) and passes checkTx before it reaches the
// wallet: the router swap in this one pool, or the two bounded approvals a sell needs. The router's code is checked
// against the pinned hash and the wallet must be on Ethereum mainnet. This page loads no third-party script.
import { useEffect, useMemo, useState } from "react";
import { type Address, keccak256, parseEther } from "viem";
import { LIVE } from "../_data/flags";
import { ui } from "../_ui/ui";
import { connect, etherscanTx, fmtUnits as fmt, PoisonNote, pub, refreshBalances, sendTx, useWallet, WalletBar, why } from "../_ui/Wallet";
import { approveCall, checkTx, erc20Abi, floorFor, minOut, PERMIT2, permit2Abi, permit2Call, poolKey, quoteCall, readQuote, swapCall, type Tx, UNREAD, UR, UR_CODEHASH } from "./swap";
import t from "./trade.module.css";

const SLIPPAGE_BPS = 100; // simplification: fixed 1%; a setting if traders ask for one
const DEADLINE_S = 600;

function amountOf(v: string): bigint | null {
  try {
    const a = parseEther(v.trim());
    return a > BigInt(0) ? a : null;
  } catch {
    return null;
  }
}

export function SwapBox({ token, hook }: { token: Address | null; hook: Address | null }) {
  const key = useMemo(() => (token && hook ? poolKey(token, hook) : null), [token, hook]);
  const [buy, setBuy] = useState(true);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<bigint | null>(null);
  const [noQuote, setNoQuote] = useState(false); // the RPC refused or failed (a busy public endpoint rate-limits)
  const [status, setStatus] = useState("");
  const [hash, setHash] = useState<string | null>(null); // the newest transaction this box sent (its Etherscan link)
  const { account, ready } = useWallet();
  const [busy, setBusy] = useState(false);
  const amountIn = amountOf(amount);

  // quote 400 ms after the last keystroke; a stale answer never overwrites a newer one
  useEffect(() => {
    setQuote(null);
    setNoQuote(false);
    if (!key || !amountIn) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const r = await pub().call(quoteCall(key, buy, amountIn));
        if (live && r.data) { setQuote(readQuote(r.data)); setStatus(""); }
      } catch (e) {
        if (live) { setNoQuote(true); setStatus(`No quote: ${why(e)}`); }
      }
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [key, buy, amountIn]);

  async function swap() {
    const shown = quote; // the quote on screen when the visitor pressed the button: the signed minimum comes from it
    if (!key || !amountIn || shown === null) return;
    const from = account;
    if (!from) return void connect();
    setBusy(true);
    setHash(null);
    try {
      const c = pub();
      const code = await c.getCode({ address: UR });
      if (!code || keccak256(code) !== UR_CODEHASH) throw new Error("the router's code is not the one this page was built for");
      const send = async (tx: Tx, label: string) => {
        const bad = checkTx(tx, key);
        if (bad) throw new Error(`refused: ${bad}`);
        return sendTx(from, tx, label, (s, h) => { setStatus(s); if (h) setHash(h); });
      };
      if (!buy) {
        // bounded to this sale, like the router path the contracts suite proves
        const now = BigInt(Math.floor(Date.now() / 1000));
        const allowance = await c.readContract({ address: key.currency1, abi: erc20Abi, functionName: "allowance", args: [from, PERMIT2] });
        if (allowance < amountIn) await send(approveCall(key.currency1, amountIn), "Approve DNA for Permit2");
        const [p2, exp] = await c.readContract({ address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [from, key.currency1, UR] });
        if (p2 < amountIn || BigInt(exp) < now + BigInt(DEADLINE_S)) await send(permit2Call(key.currency1, amountIn, Number(now) + DEADLINE_S + 3600), "Allow the router in Permit2");
      }
      const fresh = readQuote((await c.call(quoteCall(key, buy, amountIn))).data!);
      const floor = floorFor(shown, fresh, SLIPPAGE_BPS);
      if (floor === null) {
        setQuote(fresh);
        throw new Error("The quote moved; check the new amount and try again.");
      }
      const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_S);
      await send(swapCall(key, buy, amountIn, floor, deadline), buy ? "Buy" : "Sell");
      setStatus("Done.");
      setAmount("");
      refreshBalances();
    } catch (e) {
      setStatus(why(e));
    } finally {
      setBusy(false);
    }
  }

  const unitIn = buy ? "ETH" : "DNA", unitOut = buy ? "DNA" : "ETH";
  return (
    <div className={t.box}>
    <WalletBar token={token} />
    <form aria-label="Swap" onSubmit={(e) => { e.preventDefault(); void swap(); }}>
      <fieldset className={t.fieldset} disabled={!key || busy}>
        <div className={t.sides} role="group" aria-label="Direction">
          <button type="button" className={ui.button} aria-pressed={buy} onClick={() => setBuy(true)}>Buy DNA</button>
          <button type="button" className={ui.button} aria-pressed={!buy} onClick={() => setBuy(false)}>Sell DNA</button>
        </div>
        <label className={t.label} htmlFor="swap-in">You pay ({unitIn})</label>
        <input id="swap-in" className={ui.input} inputMode="decimal" autoComplete="off" placeholder="0.0" value={amount}
          onChange={(e) => { setStatus(""); setAmount(e.target.value.replace(/[^0-9.]/g, "")); }} aria-describedby="swap-out" />
        <p id="swap-out" className={t.out} aria-live="polite">
          {!key ? (LIVE ? UNREAD : "Pre-launch: the swap opens when DNA's pool exists.")
            : quote === null ? (amountIn ? (noQuote ? "No quote right now. Change the amount to try again." : "Quoting...") : `You get (${unitOut})`)
            : <>You get about <strong>{fmt(quote)} {unitOut}</strong>, at least {fmt(minOut(quote, SLIPPAGE_BPS))} (1% slippage). DNA&apos;s fee is included.</>}
        </p>
        {account ? (
          <button className={ui.button} data-primary type="submit" disabled={!key || !amountIn || quote === null || busy || !ready}>{buy ? "Buy" : "Sell"}</button>
        ) : (
          <button className={ui.button} type="button" onClick={() => void connect()}>Connect wallet to {buy ? "buy" : "sell"}</button>
        )}
      </fieldset>
      <p className={t.status} role="status">{status}{hash && <> <a className={ui.link} href={etherscanTx(hash)} target="_blank" rel="noopener noreferrer">View on Etherscan</a></>}</p>
    </form>
    <PoisonNote />
    </div>
  );
}
