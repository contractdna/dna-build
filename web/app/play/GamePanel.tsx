"use client";
// One Sequencer game, played from the main site with code written here, never the game's own page: its state (its
// zero-argument views), a read form for each view that takes arguments, and a button (with its arguments) for each
// function a player sends. Every send is value 0, to this game only, after checking the code at its address is the
// code its ship record names and simulating the call, so a revert shows its reason here instead of in the wallet.
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Abi, encodeFunctionData, keccak256 } from "viem";
import { connect, etherscanTx, pub, sendTx, useWallet, why } from "../_ui/Wallet";
import { ui } from "../_ui/ui";
import { type AbiFn, panelOf, parseArg, showValue } from "./gameAbi";
import s from "./play.module.css";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

type Props = { address: `0x${string}`; codehash: `0x${string}`; title: string; retired: boolean; abi: unknown[] };

function Call({ f, busy, label, onRun }: { f: AbiFn; busy: boolean; label: string; onRun: (args: unknown[]) => void }) {
  const [vals, setVals] = useState<string[]>(() => f.inputs.map(() => ""));
  const [bad, setBad] = useState("");
  const go = () => {
    const out: unknown[] = [];
    for (const [i, p] of f.inputs.entries()) {
      const r = parseArg(p.type, vals.at(i) ?? "");
      if (!r.ok) return setBad(`${p.name || `argument ${i + 1}`}: ${r.why}`);
      out.push(r.value);
    }
    setBad("");
    onRun(out);
  };
  return (
    <div className={s.gameCall}>
      {f.inputs.map((p, i) => (
        <input key={i} className={ui.input} value={vals.at(i) ?? ""} placeholder={`${p.name || "arg"} (${p.type})`} aria-label={`${f.name} ${p.name || i + 1}`}
          onChange={(e) => setVals((v) => v.map((x, j) => (j === i ? e.target.value : x)))} />
      ))}
      <button type="button" className={ui.button} disabled={busy} onClick={go}>{label}</button>
      {bad && <span className={ui.dim}>{bad}</span>}
    </div>
  );
}

export function GamePanel({ address, codehash, title, retired, abi }: Props) {
  const { account, ready } = useWallet();
  const { state, reads, actions } = useMemo(() => panelOf(abi, retired), [abi, retired]);
  const [views, setViews] = useState<Record<string, string> | "unavailable" | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    const c = pub();
    // one eth_call for the whole state (Multicall3), each view allowed to fail on its own
    const res = state.length
      ? await c.multicall({ multicallAddress: MULTICALL3, allowFailure: true, contracts: state.map((f) => ({ address, abi: abi as Abi, functionName: f.name })) }).catch(() => null)
      : [];
    const got = (res ?? []).flatMap((r, i) => (r.status === "success" ? [[state.at(i)!.name, showValue(state.at(i)!.name, r.result)] as const] : []));
    setViews(got.length || !state.length ? Object.fromEntries(got) : "unavailable");
    // the kit's owed(address): what this wallet can claim
    if (account && (abi as AbiFn[]).some((f) => f?.type === "function" && f.name === "owed")) {
      const o = await c.readContract({ address, abi: abi as Abi, functionName: "owed", args: [account] }).catch(() => null);
      setAnswers((a) => ({ ...a, "owed (you)": o === null ? "can't be read right now" : showValue("owed", o) }));
    }
  }, [address, abi, account, state]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load, tick]);

  async function readFn(f: AbiFn, args: unknown[]) {
    try {
      const v = await pub().readContract({ address, abi: abi as Abi, functionName: f.name, args });
      setAnswers((a) => ({ ...a, [f.name]: showValue(f.name, v) }));
    } catch (e) {
      setAnswers((a) => ({ ...a, [f.name]: why(e) }));
    }
  }

  async function send(f: AbiFn, args: unknown[]) {
    if (!account) return void connect();
    setBusy(true);
    setSent(null);
    try {
      const c = pub();
      const code = await c.getCode({ address });
      if (!code || keccak256(code) !== codehash.toLowerCase()) throw new Error("the code at this game's address is not the code its ship record names; nothing was sent");
      const data = encodeFunctionData({ abi: abi as Abi, functionName: f.name, args });
      // the game's own refusal (wrong time, nothing owed, paused) stops here, before the wallet
      await c.call({ account, to: address, data });
      await sendTx(account, { to: address, data }, f.name, (m, h) => { setStatus(m); if (h) setSent(h); });
      setStatus(`${f.name}: done.`);
      setTick((t) => t + 1);
    } catch (e) {
      setStatus(why(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={s.game} id={`game-${address.toLowerCase()}`}>
      <h3 className={ui.cardTitle}>{title}</h3>
      <p className={`${ui.prose} ${ui.dim}`}>
        <a className={ui.link} href={`https://etherscan.io/address/${address}`} target="_blank" rel="noopener noreferrer">{address.slice(0, 6)}…{address.slice(-4)} on Etherscan</a>
        {retired && " · retired: anything you won stays claimable"}
      </p>
      {views === "unavailable" ? <p className={ui.prose}>The game can&apos;t be read right now. Try again in a minute.</p>
        : views && Object.keys(views).length > 0 && (
          <dl className={s.gameState}>
            {Object.entries(views).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        )}
      {actions.length > 0 && (
        <>
          <p className={ui.label}>{retired ? "Claim" : "Play"}</p>
          {!ready && <p className={`${ui.prose} ${ui.dim}`}>Connect a wallet on Ethereum mainnet above to play.</p>}
          {actions.map((f) => <Call key={f.name} f={f} busy={busy || !ready} label={f.name} onRun={(a) => void send(f, a)} />)}
        </>
      )}
      {reads.length > 0 && (
        <details className={ui.more}>
          <summary>Look something up</summary>
          {reads.map((f) => <Call key={f.name} f={f} busy={false} label={`read ${f.name}`} onRun={(a) => void readFn(f, a)} />)}
        </details>
      )}
      {Object.keys(answers).length > 0 && (
        <dl className={s.gameState}>
          {Object.entries(answers).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      )}
      <p className={ui.prose} role="status">{status}</p>
      {sent && <p className={ui.prose}><a className={ui.link} href={etherscanTx(sent)} target="_blank" rel="noopener noreferrer">{sent.slice(0, 10)}… on Etherscan</a></p>}
    </article>
  );
}
