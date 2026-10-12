"use client";
// Stake DNA from /play: an amount and a term, then the exact approval (only when the allowance is short) and the lock;
// below it the connected wallet's positions, read over the public RPC, with withdraw and recommit for the ones whose
// term is over. Every send is value 0, to the vault or the exact approval to it, after checking the code at the
// pinned address is the code this page was built for, that the vault's token is DNA, and simulating the call, so a
// refusal (a team or operator wallet, a term not over) shows here, with the vault's own reason, instead of in the wallet.
import { useCallback, useEffect, useState } from "react";
import { type Address, formatEther, keccak256 } from "viem";
import { LIVE } from "../_data/flags";
import { connect, etherscanTx, fmtUnits, pub, refreshBalances, sendTx, useWallet, why } from "../_ui/Wallet";
import { fmtDate, fmtTime, ui } from "../_ui/ui";
import { amountProblem, approveCall, checkTx, DNA, erc20Abi, fmtDna, lockCall, MAX_BATCH, parseAmount, type Position, recommitCall, refusal, registryAbi, STAKE_VAULT, STAKE_VAULT_CODEHASH, stakeAbi, stateOf, TIERS, type Tx, withdrawCall } from "./stake";
import s from "./play.module.css";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const CHUNK = 500;
const LATER = BigInt(2) ** BigInt(40); // termAt(id, LATER): the term in force now (no recommit starts in the future)

/** The wallet's positions, newest first. simplification: reads positions(1..count) in multicall chunks and keeps this
 *  wallet's (the public RPC serves no old logs); fine for thousands of positions, an indexer endpoint past that. */
async function readPositions(account: Address): Promise<Position[]> {
  const c = pub();
  const count = Number(await c.readContract({ address: STAKE_VAULT, abi: stakeAbi, functionName: "count" }));
  const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1));
  const all = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const r = await c.multicall({ multicallAddress: MULTICALL3, allowFailure: false, contracts: part.map((id) => ({ address: STAKE_VAULT, abi: stakeAbi, functionName: "positions" as const, args: [id] as const })) });
    all.push(...r.map((p, k) => ({ id: part[k], p })));
  }
  const mine = all.filter(({ p }) => p.owner.toLowerCase() === account.toLowerCase());
  const terms = await c.multicall({ multicallAddress: MULTICALL3, allowFailure: false, contracts: mine.map(({ id }) => ({ address: STAKE_VAULT, abi: stakeAbi, functionName: "termAt" as const, args: [id, LATER] as const })) });
  return mine.map(({ id, p }, k) => ({ id, amount: p.amount, tier: p.tier, start: p.start, withdrawn: p.withdrawn, termStart: Number(terms[k][0]), termTier: terms[k][1] })).reverse();
}

const when = (unix: number) => { const iso = new Date(unix * 1000).toISOString(); return `${fmtDate(iso)}, ${fmtTime(iso)}`; };

export function StakePanel() {
  const { account, ready } = useWallet();
  const [text, setText] = useState("");
  const [tier, setTier] = useState(2);
  const [mine, setMine] = useState<{ dna: bigint; allowance: bigint } | null>(null);
  const [positions, setPositions] = useState<Position[] | "unavailable" | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setNow(Math.floor(Date.now() / 1000));
    if (!account) { setMine(null); setPositions(null); return; }
    const c = pub();
    const [bal, list] = await Promise.all([
      Promise.all([
        c.readContract({ address: DNA, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        c.readContract({ address: DNA, abi: erc20Abi, functionName: "allowance", args: [account, STAKE_VAULT] }),
      ]).catch(() => null),
      readPositions(account).catch(() => "unavailable" as const),
    ]);
    setMine(bal ? { dna: bal[0], allowance: bal[1] } : null);
    setPositions(list);
  }, [account]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load, tick]);

  const amount = parseAmount(text);
  const problem = text ? amountProblem(amount, mine?.dna ?? null) : null;

  /** The checks before any send: pinned code, DNA bound, the exact call shape; then the simulation. */
  async function send(from: Address, label: string, t: Tx, forAmount: bigint | null) {
    if (!LIVE) throw new Error("staking opens at launch");
    if (!checkTx(t, DNA, forAmount)) throw new Error("this page only sends the exact approval, lock, withdraw or recommit");
    const c = pub();
    const code = await c.getCode({ address: STAKE_VAULT });
    if (!code || keccak256(code) !== STAKE_VAULT_CODEHASH) throw new Error("the code at the vault's address is not the code this page was built for; nothing was sent");
    const bound = await c.readContract({ address: STAKE_VAULT, abi: stakeAbi, functionName: "token" });
    if (bound.toLowerCase() !== DNA.toLowerCase()) throw new Error("the vault's token is not DNA; nothing was sent");
    await c.call({ account: from, to: t.to, data: t.data }).catch((e: unknown) => { throw new Error(refusal(e) ?? why(e)); });
    await sendTx(from, t, label, (m, h) => { setStatus(m); if (h) setSent(h); });
  }

  async function run(work: (from: Address) => Promise<string>) {
    if (!account) return void connect();
    setBusy(true);
    setSent(null);
    try {
      setStatus(await work(account));
      refreshBalances();
      setTick((t) => t + 1);
    } catch (e) {
      setStatus(refusal(e) ?? why(e));
    } finally {
      setBusy(false);
    }
  }

  const stake = () => run(async (from) => {
    if (amount === null || amountProblem(amount, mine?.dna ?? null)) throw new Error(problem ?? "enter an amount of DNA");
    const c = pub();
    // the vault refuses these wallets at lock (Excluded); asked first so they never approve for nothing
    const [excluded, safe, registry] = await Promise.all([
      c.readContract({ address: STAKE_VAULT, abi: stakeAbi, functionName: "excluded", args: [from] }),
      c.readContract({ address: STAKE_VAULT, abi: stakeAbi, functionName: "safe" }),
      c.readContract({ address: STAKE_VAULT, abi: stakeAbi, functionName: "registry" }),
    ]);
    const [operator, anchor] = await Promise.all([
      c.readContract({ address: registry, abi: registryAbi, functionName: "agent" }),
      c.readContract({ address: registry, abi: registryAbi, functionName: "anchorKey" }),
    ]);
    if (excluded || [safe, operator, anchor].some((a) => a.toLowerCase() === from.toLowerCase())) throw new Error("This wallet can't stake: the vault refuses team and operator wallets. (Excluded)");
    const allowance = () => c.readContract({ address: DNA, abi: erc20Abi, functionName: "allowance", args: [from, STAKE_VAULT] });
    const n = fmtDna(amount);
    if (await allowance() < amount) {
      await send(from, `approve ${n} DNA`, approveCall(DNA, amount), amount);
      // a load-balanced public RPC can answer from a node a block behind: wait until it sees the approval, or the
      // lock's simulation would refuse for want of it
      for (let i = 0; i < 10 && (await allowance()) < amount; i++) await new Promise((r) => setTimeout(r, 3000));
      if ((await allowance()) < amount) throw new Error("Your approval is confirmed, but the network hasn't caught up yet. Press Stake again in a minute.");
    }
    await send(from, `stake ${n} DNA for ${TIERS[tier].label}`, lockCall(amount, tier), amount);
    setText("");
    return `Staked ${n} DNA for ${TIERS[tier].label}. It counts ${TIERS[tier].mult} until the term ends, then at least ×2 until you withdraw.`;
  });

  const list = Array.isArray(positions) ? positions : [];
  const active = list.filter((p) => !p.withdrawn);
  const open = active.filter((p) => stateOf(p, now).open).slice(0, MAX_BATCH);
  const openIds = open.map((p) => p.id);
  const openSum = open.reduce((a, p) => a + p.amount, BigInt(0));
  const gone = list.length - active.length;

  return (
    <div className={s.stake}>
      <form aria-label="Stake DNA" onSubmit={(e) => { e.preventDefault(); void stake(); }}>
        <fieldset className={s.stakeForm} disabled={busy || !LIVE}>
          <label className={s.stakeLabel} htmlFor="stake-amount">Amount (DNA, at least 10,000)</label>
          <div className={s.stakeAmount}>
            <input id="stake-amount" className={ui.input} inputMode="decimal" autoComplete="off" placeholder="10,000" value={text}
              onChange={(e) => { setStatus(""); setText(e.target.value.replace(/[^0-9.,]/g, "")); }} aria-describedby="stake-check" aria-invalid={!!problem || undefined} />
            {ready && mine && <button type="button" className={ui.button} onClick={() => setText(formatEther(mine.dna))}>Max</button>}
          </div>
          <p id="stake-check" className={s.stakeNote} aria-live="polite">
            {problem ?? (ready && mine ? `This wallet holds ${fmtUnits(mine.dna)} DNA.` : " ")}
          </p>
          <span className={s.stakeLabel} id="stake-term">Term</span>
          <div className={s.tiers} role="group" aria-labelledby="stake-term">
            {TIERS.map((t) => (
              <button key={t.tier} type="button" className={ui.button} aria-pressed={tier === t.tier} onClick={() => setTier(t.tier)}>
                {t.label} <span>{t.mult}</span>
              </button>
            ))}
          </div>
          <p className={s.stakeNote}>Counts {TIERS[tier].mult} for {TIERS[tier].label}, then at least ×2 until you withdraw. Withdraw any time after the term. It can vote once it&apos;s 12 hours old.</p>
          {!LIVE ? <button className={ui.button} type="button" disabled>Staking opens at launch</button>
            : account ? (
              <button className={ui.button} type="submit" disabled={!ready || !mine || amount === null || !!problem}>
                {mine && amount !== null && mine.allowance >= amount ? "Stake" : "Approve and stake"}
              </button>
            ) : <button className={ui.button} type="button" onClick={() => void connect()}>Connect a wallet to stake</button>}
        </fieldset>
      </form>
      {status && <p className={s.stakeNote} role="status">{status}{sent && <> · <a className={ui.link} href={etherscanTx(sent)} target="_blank" rel="noopener noreferrer">Etherscan</a></>}</p>}

      {account && (
        <div className={s.mine}>
          <h3 className={ui.cardTitle}>Your stakes</h3>
          {positions === "unavailable" ? <p className={s.stakeNote}>Your stakes can&apos;t be read right now. Try again in a minute.</p>
            : positions === null ? <p className={s.stakeNote}>Reading your stakes...</p>
            : active.length === 0 ? <p className={s.stakeNote}>No stakes from this wallet{gone > 0 && ` (${gone} withdrawn)`}.</p>
            : (
              <>
                <ul className={s.positions}>
                  {active.map((p) => {
                    const st = stateOf(p, now);
                    return (
                      <li key={p.id.toString()} data-open={st.open || undefined}>
                        <span className={s.posAmount}>{fmtDna(p.amount)} DNA</span>
                        <span>#{p.id.toString()} · {st.term.label} {st.term.mult}{p.termStart !== p.start && " (recommitted)"}</span>
                        <span className={ui.dim}>Started {when(p.start)} · term ends {when(st.unlock)}</span>
                        <span className={st.open ? s.posOpen : ui.dim}>{st.label}</span>
                      </li>
                    );
                  })}
                </ul>
                {gone > 0 && <p className={s.stakeNote}>{gone} withdrawn earlier.</p>}
                {open.length > 0 && (
                  <div className={s.stakeActions}>
                    <button type="button" className={ui.button} disabled={busy || !ready || !LIVE}
                      onClick={() => void run(async (from) => { await send(from, `withdraw ${fmtDna(openSum)} DNA`, withdrawCall(openIds), null); return `Withdrew ${fmtDna(openSum)} DNA.`; })}>
                      Withdraw {fmtDna(openSum)} DNA ({open.length} {open.length === 1 ? "stake" : "stakes"})
                    </button>
                    <button type="button" className={ui.button} disabled={busy || !ready || !LIVE}
                      onClick={() => void run(async (from) => { await send(from, `recommit for ${TIERS[tier].label}`, recommitCall(openIds, tier), null); return `Recommitted for ${TIERS[tier].label}: ${TIERS[tier].mult} until the new term ends.`; })}>
                      Or recommit for {TIERS[tier].label} ({TIERS[tier].mult})
                    </button>
                    <span className={s.stakeNote}>Recommitting starts a new term with the term picked above and keeps your streak. You can&apos;t withdraw until it ends.</span>
                  </div>
                )}
              </>
            )}
        </div>
      )}
    </div>
  );
}
