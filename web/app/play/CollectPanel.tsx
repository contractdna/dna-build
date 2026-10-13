"use client";
// Collect a jackpot share or idea reward GamePot could not send (the wallet refused the ETH). Reads GamePot.prizes over
// the public RPC; the winner sends one value-0 claim to the pinned pot, after the code-hash check and a simulation, to
// the address typed here (default: the same wallet; a wallet that refused the push may refuse this too).
import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, getAddress, keccak256 } from "viem";
import { LIVE } from "../_data/flags";
import { etherscanTx, fmtUnits, pub, refreshBalances, sendTx, useWallet, why } from "../_ui/Wallet";
import { fmtDate, ui } from "../_ui/ui";
import { CLAIM_WINDOW, collectable, collectCall, destProblem, GAME_POT, GAME_POT_CODEHASH, MAX_COLLECT, type Owed, potAbi, potRefusal } from "./collect";
import s from "./play.module.css";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** simplification: reads prizes(1..drawCount); a record exists only for a failed push, so the list stays short. */
async function readOwed(account: Address): Promise<Owed[]> {
  const c = pub();
  const n = Number(await c.readContract({ address: GAME_POT, abi: potAbi, functionName: "drawCount" }));
  if (n === 0) return [];
  const ids = Array.from({ length: n }, (_, i) => BigInt(i + 1));
  const r = await c.multicall({ multicallAddress: MULTICALL3, allowFailure: false, contracts: ids.map((id) => ({ address: GAME_POT, abi: potAbi, functionName: "prizes" as const, args: [id] as const })) });
  return collectable(r.map(([winner, amount, wonAt], k) => ({ id: ids[k], winner, amount, wonAt })), account);
}

export function CollectPanel() {
  const { account, ready } = useWallet();
  const [owed, setOwed] = useState<Owed[] | "unavailable" | null>(null);
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // every answer (a read, or the reload after a send) lands only if its wallet is still the connected one
  const current = useRef(account);
  current.current = account;
  const gen = useRef(0); // only the newest read lands (A → B → A: an old read for A is dropped too)
  const load = useCallback(async () => {
    const mine = ++gen.current;
    setOwed(null);
    if (!account) return;
    const r = await readOwed(account).catch(() => "unavailable" as const);
    if (mine === gen.current && current.current === account) setOwed(r);
  }, [account]);
  useEffect(() => { void load(); setTo(account ?? ""); }, [load, account]);

  if (!LIVE) return null;
  if (!account) return <p className={s.stakeNote}>Connect a wallet above to check it for a prize to collect.</p>;
  const list = Array.isArray(owed) ? owed.slice(0, MAX_COLLECT) : [];
  const total = list.reduce((a, o) => a + o.amount, BigInt(0));
  const t = to.trim();
  const toProblem = destProblem(t);
  const badTo = toProblem !== null;

  async function collect(from: Address) {
    setBusy(true);
    setSent(null);
    try {
      if (toProblem) throw new Error(toProblem);
      const dest = getAddress(t);
      const c = pub();
      const code = await c.getCode({ address: GAME_POT });
      if (!code || keccak256(code) !== GAME_POT_CODEHASH) throw new Error("the code at the pot's address is not the code this page was built for; nothing was sent");
      const tx = collectCall(list.map((o) => o.id), dest);
      await c.call({ account: from, to: tx.to, data: tx.data }).catch((e: unknown) => { throw new Error(potRefusal(e) ?? why(e)); });
      await sendTx(from, tx, `collect ${fmtUnits(total)} ETH`, (m, h) => { setStatus(m); if (h) setSent(h); });
      if (current.current !== from) return; // the wallet changed while it confirmed: the new one keeps its own view
      setStatus(`Collected ${fmtUnits(total)} ETH to ${dest}.`);
      refreshBalances();
      await load();
    } catch (e) {
      setStatus(potRefusal(e) ?? why(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={s.mine}>
      {owed === "unavailable" ? <p className={s.stakeNote}>The pot can&apos;t be read right now. Try again in a minute.</p>
        : owed === null ? <p className={s.stakeNote}>Checking the pot for this wallet...</p>
        : list.length === 0 ? <p className={s.stakeNote}>Nothing to collect for this wallet. Prizes are sent straight to winners; one shows here only if the wallet refused the ETH.</p>
        : (
          <form aria-label="Collect a prize" onSubmit={(e) => { e.preventDefault(); void collect(account); }}>
            <fieldset className={s.stakeForm} disabled={busy}>
              <ul className={s.positions}>
                {list.map((o) => (
                  <li key={o.id.toString()} data-open>
                    <span className={s.posAmount}>{fmtUnits(o.amount)} ETH</span>
                    <span className={ui.dim}>#{o.id.toString()} · {Date.now() / 1000 < o.wonAt + CLAIM_WINDOW ? `collect by ${fmtDate(new Date((o.wonAt + CLAIM_WINDOW) * 1000).toISOString())}` : "past 7 days: collect now, anyone can send it back to the pot"}</span>
                  </li>
                ))}
              </ul>
              <label className={s.stakeLabel} htmlFor="collect-to">Send it to</label>
              <input id="collect-to" className={ui.input} autoComplete="off" spellCheck={false} value={to}
                onChange={(e) => { setStatus(""); setTo(e.target.value); }} aria-invalid={badTo || undefined} aria-describedby="collect-check" />
              {toProblem && t && <p id="collect-check" className={s.stakeNote} aria-live="polite">{toProblem}</p>}
              <p className={s.stakeNote}>This wallet refused the ETH once, so it may again: send it to another address you own if so. After 7 days an uncollected share goes back to the pot.</p>
              {ready ? <button className={ui.button} type="submit" disabled={badTo}>Collect {fmtUnits(total)} ETH</button>
                : <button className={ui.button} type="button" disabled>Switch your wallet to Ethereum to collect</button>}
            </fieldset>
          </form>
        )}
      {status && <p className={s.stakeNote} role="status">{status}{sent && <> · <a className={ui.link} href={etherscanTx(sent)} target="_blank" rel="noopener noreferrer">Etherscan</a></>}</p>}
    </div>
  );
}
