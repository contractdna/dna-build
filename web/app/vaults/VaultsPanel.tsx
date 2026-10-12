"use client";
// The 50 slots as the chain has them (read over the public RPC, no wallet needed; the art is the slot's own image, the
// same file the contract's tokenURI names), and the four things a wallet can
// do: approve exactly 200,000 DNA then mint, claim a vault's ETH, burn a vault. Every send is value 0, to the vaults
// or the exact approval to them, after checking the code at the pinned address is the code this page was built for
// and simulating the call, so a refusal shows here instead of in the wallet.
import { useCallback, useEffect, useState } from "react";
import { type Address, keccak256 } from "viem";
import { connect, etherscanTx, pub, refreshBalances, sendTx, useWallet, why } from "../_ui/Wallet";
import { ui } from "../_ui/ui";
import { approveCall, artOf, burnCall, checkTx, claimCall, DEPOSIT, erc20Abi, fmtEth, MAX_LIVE, mintCall, slotsOf, type Token, type Tx, VAULTS, VAULTS_CODEHASH, vaultsAbi, withdrawCall } from "./vaults";
import s from "./vaults.module.css";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
type State = { live: number; paused: boolean; tokens: Token[] };

async function readState(): Promise<State> {
  const c = pub();
  const [live, paused, ids] = await Promise.all([
    c.readContract({ address: VAULTS, abi: vaultsAbi, functionName: "liveCount" }),
    c.readContract({ address: VAULTS, abi: vaultsAbi, functionName: "mintPaused" }),
    c.multicall({
      multicallAddress: MULTICALL3, allowFailure: false,
      contracts: Array.from({ length: MAX_LIVE }, (_, i) => ({ address: VAULTS, abi: vaultsAbi, functionName: "tokenOfSlot" as const, args: [i + 1] as const })),
    }),
  ]);
  const taken = ids.map((id, i) => ({ id, slot: i + 1 })).filter((x) => x.id !== BigInt(0));
  const reads = await c.multicall({
    multicallAddress: MULTICALL3, allowFailure: true,
    contracts: taken.flatMap(({ id }) => [
      { address: VAULTS, abi: vaultsAbi, functionName: "ownerOf" as const, args: [id] as const },
      { address: VAULTS, abi: vaultsAbi, functionName: "earned" as const, args: [id] as const },
      { address: VAULTS, abi: vaultsAbi, functionName: "pending" as const, args: [id] as const },
      { address: VAULTS, abi: vaultsAbi, functionName: "isEligible" as const, args: [id] as const },
    ]),
  });
  const tokens = taken.flatMap(({ id, slot }, i) => {
    const [o, e, p, g] = reads.slice(i * 4, i * 4 + 4);
    if (o.status !== "success" || e.status !== "success" || p.status !== "success" || g.status !== "success") return []; // burned between the two reads
    return [{ id, slot, owner: o.result as Address, earned: e.result as bigint, pending: p.result as bigint, eligible: g.result as boolean }];
  });
  return { live: Number(live), paused, tokens };
}

export function VaultsPanel({ token }: { token: Address | null }) {
  const { account, ready } = useWallet();
  const [state, setState] = useState<State | "unavailable" | null>(null);
  const [mine, setMine] = useState<{ dna: bigint; allowance: bigint; owed: bigint } | null>(null);
  const [status, setStatus] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setState(await readState().catch(() => "unavailable" as const));
    if (account && token) {
      const c = pub();
      const r = await Promise.all([
        c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, VAULTS] }),
        c.readContract({ address: VAULTS, abi: vaultsAbi, functionName: "owed", args: [account] }),
      ]).catch(() => null);
      setMine(r ? { dna: r[0], allowance: r[1], owed: r[2] } : null);
    } else setMine(null);
  }, [account, token]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load, tick]);

  async function send(label: string, tx: Tx) {
    if (!account) return void connect();
    if (!checkTx(tx, token)) throw new Error("this page only sends the exact approval, mint, claim, burn or withdraw");
    const c = pub();
    const code = await c.getCode({ address: VAULTS });
    if (!code || keccak256(code) !== VAULTS_CODEHASH) throw new Error("the code at the vaults' address is not the code this page was built for; nothing was sent");
    // the contract's own refusal (full, paused, not the owner, nothing to approve) stops here, before the wallet
    await c.call({ account, to: tx.to, data: tx.data });
    await sendTx(account, tx, label, (m, h) => { setStatus(m); if (h) setSent(h); });
  }

  async function run(steps: [string, Tx][]) {
    setBusy(true);
    setSent(null);
    try {
      for (const [label, tx] of steps) await send(label, tx);
      setStatus(`${steps.map(([l]) => l).join(", then ")}: done.`);
      refreshBalances();
      setTick((t) => t + 1);
    } catch (e) {
      setStatus(why(e));
    } finally {
      setBusy(false);
    }
  }

  const mint = () => {
    if (!token || !mine) return;
    const steps: [string, Tx][] = mine.allowance >= DEPOSIT ? [] : [["approve 200,000 DNA", approveCall(token)]];
    void run([...steps, ["mint", mintCall()]]);
  };

  const canMint = ready && !!token && !!mine && mine.dna >= DEPOSIT && state !== null && state !== "unavailable" && !state.paused && state.live < MAX_LIVE;
  const slots = state && state !== "unavailable" ? slotsOf(state.tokens) : null;
  const me = account?.toLowerCase();
  return (
    <div className={s.panel}>
      {state === "unavailable" ? <p className={ui.prose}>The vaults can&apos;t be read right now. Try again in a minute.</p>
        : !state ? <p className={`${ui.prose} ${ui.dim}`}>Reading the slots...</p>
        : <p className={ui.prose}><strong className={ui.strong}>{state.live} of {MAX_LIVE}</strong> slots taken{state.paused && " · new mints are paused by the Safe; burns and claims still work"}</p>}
      <div className={s.actions}>
        <button type="button" className={ui.button} disabled={busy || (ready && !canMint)} onClick={() => (account ? mint() : void connect())}>
          {account ? "Mint: lock 200,000 DNA" : "Connect a wallet to mint"}
        </button>
        {ready && mine && mine.dna < DEPOSIT && <span className={ui.dim}>You hold {fmtEth(mine.dna, 0)} DNA; a mint locks exactly 200,000.</span>}
        {ready && account && mine && mine.owed > BigInt(0) && <button type="button" className={ui.button} disabled={busy} onClick={() => void run([["withdraw", withdrawCall(account)]])}>Withdraw {fmtEth(mine.owed)} ETH owed to you</button>}
        {ready && account && mine && mine.owed > BigInt(0) && <span className={ui.dim}>If this wallet can&apos;t receive ETH, call withdraw with another address of yours <a className={ui.link} href={`https://etherscan.io/address/${VAULTS}#writeContract`} target="_blank" rel="noopener noreferrer">on Etherscan</a>.</span>}
      </div>
      {status && <p className={`${ui.prose} ${ui.dim}`} aria-live="polite">{status}{sent && <> · <a className={ui.link} href={etherscanTx(sent)} target="_blank" rel="noopener noreferrer">Etherscan</a></>}</p>}
      {slots && (
        <ol className={s.slots}>
          {slots.map(({ n, token: t }) => (
            <li key={n} className={t ? s.taken : s.free}>
              <div className={s.art}>{t ? <img src={artOf(n)} alt={`Vault in slot ${n}`} width={160} height={160} loading="lazy" /> : <span className={s.n}>{n}</span>}</div>
              <div className={s.meta}>
                <span className={ui.label}>Slot {n}{t && ` · #${t.id.toString()}`}</span>
                {t ? (
                  <>
                    <span className={s.line}>{t.owner.toLowerCase() === me ? "yours" : `${t.owner.slice(0, 6)}…${t.owner.slice(-4)}`}</span>
                    <span className={s.line}>{fmtEth(t.earned)} ETH earned{t.pending > BigInt(0) && ` · ${fmtEth(t.pending)} unclaimed`}{!t.eligible && " · joins at the next fund"}</span>
                    {t.owner.toLowerCase() === me && (
                      <span className={s.own}>
                        <button type="button" className={ui.button} disabled={busy || t.pending === BigInt(0)} onClick={() => void run([[`claim #${t.id}`, claimCall(t.id)]])}>Claim</button>
                        <button type="button" className={ui.button} disabled={busy} onClick={() => void run([[`burn #${t.id}`, burnCall(t.id)]])}>Burn: get 200,000 DNA back</button>
                      </span>
                    )}
                  </>
                ) : <span className={`${s.line} ${ui.dim}`}>free</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
