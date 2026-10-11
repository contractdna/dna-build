"use client";

// The idea forms. LIVE with the market's address: each sends from the connected wallet (../_ui/Wallet.tsx) in two
// steps, a DNA approval bounded to what the call pulls, then the call (ideaTx.ts). Before anything is signed the page
// checks the market's token is DNA and the balance covers it; after the approval it simulates the call so a revert
// shows its reason here instead of as a failed transaction.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type Address, erc20Abi, formatEther } from "viem";
import { connect, etherscanTx, PoisonNote, pub, refreshBalances, sendTx, useWallet, WalletBar, why } from "../_ui/Wallet";
import { fmtDate, fmtTime, ui } from "../_ui/ui";
import { clampUtf8, utf8Bytes } from "./bytes";
import { approveCall, BODY_MAX, type Call, dnaOf, ideaMarketAbi, MIN_STAKE, MIN_SUBMIT, plainError, stakeCall, SUBMIT_FEE, submitCall, submitNeeds, TITLE_MAX } from "./ideaTx";
import p from "./proposals.module.css";

const dna = (wei: bigint) => Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 2 });
type Sent = { label: string; hash: string };

/** Approve exactly `need` DNA to the market (skipped when the allowance already covers it), then send `call`. */
function useIdeaTx(market: Address | null, token: Address | null) {
  const { account, ready } = useWallet();
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState<Sent[]>([]);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function run(need: bigint, call: Call, label: string, done: string) {
    if (!account) return void connect();
    if (!market || !token) return;
    setBusy(true);
    setSent([]);
    const track = (l: string) => (s: string, h?: string) => { setStatus(s); if (h) setSent((x) => [...x.filter((y) => y.hash !== h), { label: l, hash: h }]); };
    try {
      const c = pub();
      const t = await c.readContract({ address: market, abi: ideaMarketAbi, functionName: "token" });
      if (t.toLowerCase() !== token.toLowerCase()) throw new Error("the IdeaMarket at this address doesn't use DNA; nothing was sent");
      const [bal, allowance] = await Promise.all([
        c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, market] }),
      ]);
      if (bal < need) throw new Error(`this needs ${dna(need)} DNA and the wallet holds ${dna(bal)} DNA`);
      if (allowance < need) await sendTx(account, approveCall(token, market, need), `Step 1 of 2 · approve ${dna(need)} DNA`, track("Approval"));
      try {
        await c.call({ account, to: call.to, data: call.data });
      } catch (e) {
        // the market's own refusal stops here; anything else (a node a block behind the approval) goes to the wallet
        const plain = plainError(e);
        if (plain) throw new Error(plain);
      }
      await sendTx(account, call, `Step 2 of 2 · ${label}`, track(label));
      setStatus(done);
      refreshBalances();
      router.refresh();
      return true;
    } catch (e) {
      setStatus(plainError(e) ?? why(e));
    } finally {
      setBusy(false);
    }
  }
  const log = (
    <>
      <p className={p.gate} role="status">{status}</p>
      {sent.length > 0 && (
        <ul className={p.sent}>
          {sent.map((s) => <li key={s.hash}>{s.label}: <a className={ui.link} href={etherscanTx(s.hash)} target="_blank" rel="noopener noreferrer">{s.hash.slice(0, 10)}… on Etherscan</a></li>)}
        </ul>
      )}
    </>
  );
  return { run, busy, ready, account, log, live: !!market && !!token };
}

/** Countdown to round close. Server/first paint shows the fixed close time; the client switches to time left. */
export function RoundClock({ end }: { end: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);
  const left = now === null ? null : Date.parse(end) - now;
  if (left === null) return <time dateTime={end}>closes {fmtDate(end)} {fmtTime(end)}</time>;
  if (left <= 0) return <time dateTime={end}>closed {fmtDate(end)} {fmtTime(end)}</time>;
  const m = Math.floor(left / 60_000);
  return <time dateTime={end}>closes in {Math.floor(m / 1440)}d {Math.floor((m % 1440) / 60)}h {m % 60}m</time>;
}

/** Submit form: title/body capped in UTF-8 bytes (what the contract checks), approval = stake + burned fee. */
export function SubmitIdea({ gate, market, token }: { gate: string; market: Address | null; token: Address | null }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [stake, setStake] = useState("");
  const tx = useIdeaTx(market, token);
  const amount = dnaOf(stake);
  const ok = !!amount && amount >= MIN_SUBMIT && utf8Bytes(title.trim()) > 0;
  const approve = amount && amount >= MIN_SUBMIT ? `${dna(submitNeeds(amount))} DNA` : `opening stake (≥ ${dna(MIN_SUBMIT)}) + ${dna(SUBMIT_FEE)} DNA`;
  async function submit() {
    if (!ok || !market) return;
    const done = await tx.run(submitNeeds(amount), submitCall(market, title.trim(), body, amount), "Submit the idea",
      "Submitted. It shows up in this round within a minute or two, once the indexer reads the block.");
    if (done) { setTitle(""); setBody(""); setStake(""); }
  }
  return (
    <form id="submit" className={p.submit} aria-label="Submit an idea" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {tx.live && <WalletBar token={token} />}
      <fieldset className={p.fieldset} disabled={!tx.live || tx.busy} aria-describedby="submit-gate">
        <div className={p.labelRow}>
          <label className={p.fieldLabel} htmlFor="idea-title">Title</label>
          <span className={p.gate} id="idea-title-left">1–{TITLE_MAX} bytes · {TITLE_MAX - utf8Bytes(title)} left</span>
        </div>
        <input id="idea-title" className={`${ui.input} ${p.input}`} required placeholder="One line, specific" aria-describedby="idea-title-left"
          value={title} onChange={(e) => setTitle(clampUtf8(e.target.value, TITLE_MAX))} />
        <div className={p.labelRow}>
          <label className={p.fieldLabel} htmlFor="idea-summary">What should change, and why</label>
          <span className={p.gate} id="idea-summary-left">{BODY_MAX - utf8Bytes(body)} bytes left</span>
        </div>
        <textarea id="idea-summary" className={`${ui.input} ${p.input} ${p.textarea}`} rows={4} aria-describedby="idea-summary-left"
          value={body} onChange={(e) => setBody(clampUtf8(e.target.value, BODY_MAX))} />
        <label className={p.fieldLabel} htmlFor="idea-stake">Opening stake (DNA)</label>
        <input id="idea-stake" className={`${ui.input} ${p.input}`} type="number" min={Number(formatEther(MIN_SUBMIT))} max={1_000_000} step="any" inputMode="decimal" placeholder={`min ${dna(MIN_SUBMIT)}`}
          aria-describedby="idea-approve" value={stake} onChange={(e) => setStake(e.target.value)} />
        <p id="idea-approve" className={p.gate}>
          Approve {approve}: the opening stake (refundable per outcome) plus a {dna(SUBMIT_FEE)} DNA submission fee that is burned and never refunded.
          Two transactions: the approval, then the submission.
        </p>
        <div className={p.submitRow}>
          {tx.live && !tx.account
            ? <button className={ui.button} type="button" onClick={() => void connect()}>Connect wallet to submit</button>
            : <button className={ui.button} data-primary type="submit" disabled={!tx.live || !ok || !tx.ready}>Submit idea</button>}
          <p id="submit-gate" className={p.gate}>{gate}</p>
        </div>
        {tx.log}
      </fieldset>
      {tx.live && <PoisonNote />}
    </form>
  );
}

/** Stake on one open idea: approve the amount, then stake(id, amount). */
export function StakeIdea({ id, round, gate, market, token }: { id: number; round: number; gate: string; market: Address | null; token: Address | null }) {
  const [v, setV] = useState("");
  const tx = useIdeaTx(market, token);
  const amount = dnaOf(v);
  const ok = !!amount && amount >= MIN_STAKE;
  async function stake() {
    if (!ok || !market) return;
    if (await tx.run(amount, stakeCall(market, BigInt(id), amount), `Stake on #${id}`, `Staked on #${id}. Locked until round ${round} resolves.`)) setV("");
  }
  return (
    <form className={p.stake} aria-label={`Stake on idea #${id}`} onSubmit={(e) => { e.preventDefault(); void stake(); }}>
      <fieldset className={p.fieldset} disabled={!tx.live || tx.busy}>
        <label className={p.fieldLabel} htmlFor={`stake-${id}`}>Stake (DNA)</label>
        <div className={p.row}>
          <input id={`stake-${id}`} className={`${ui.input} ${p.input}`} type="number" min="1000" max="1000000" step="any" inputMode="decimal" placeholder="min 1,000"
            aria-describedby={`gate-${id}`} value={v} onChange={(e) => setV(e.target.value)} />
          {tx.live && !tx.account
            ? <button className={ui.button} type="button" onClick={() => void connect()}>Connect</button>
            : <button className={ui.button} type="submit" disabled={!tx.live || !ok || !tx.ready}>Stake</button>}
        </div>
        <p id={`gate-${id}`} className={p.gate}>{gate} · locked until round {round} resolves</p>
        {tx.log}
      </fieldset>
    </form>
  );
}
