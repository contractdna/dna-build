"use client";
// A jackpot draw, checked in the visitor's browser: the chain's own events are re-read
// over a public RPC (by block), the list record is fetched from the public log API, and everything else is computed
// here: the record's bytes against the posted dataHash, the Merkle root from every leaf, the walk from the VRF word
// (ticket j = keccak256(word, j) mod total, a wallet already picked skipped) → the 10 winners, every skipped excluded
// wallet re-read on chain, and the record's enclave signature. Nothing is trusted from our server except bytes it
// returns. A full rebuild of the balances needs the whole Transfer history: the CLI does that.
import { useState } from "react";
import { createPublicClient, type Hex, http, keccak256, parseAbi, parseAbiItem, parseEventLogs, stringToHex } from "viem";
import { checkRecord, sameHex } from "../../proof/verify";
import { ui } from "../../_ui/ui";
import s from "../play.module.css";
import { type DrawList, leafHash, proofOf, rootOf, tree, verifyProof, walk, WINNERS } from "./tickets";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
const rpcHost = new URL(RPC).host;
const DRAWN = parseAbiItem("event Drawn(uint256 indexed window, uint256 rand, uint256 prize, uint256 share, uint256 winners, uint256 ticketsUsed)");
const POSTED = parseAbiItem("event ListPosted(uint256 indexed window, uint256 capBps, uint256 minBalance, bytes32 root, uint256 totalTickets, uint256 holders, string uri, bytes32 dataHash, uint256 eta)");
const FULFILLED = parseAbiItem("event DrawFulfilled(uint256 indexed reqId, uint256 indexed window, uint256 rand)");
const SETTLE_LOGS = parseAbi(["event Winner(uint256 indexed window, uint256 rank, address indexed account, uint256 share, uint256 prizeId)", "event WinnerExcluded(uint256 indexed window, address winner, uint256 prize)"]);
const IS_EXCLUDED = parseAbi(["function isExcluded(address) view returns (bool)"]);

type Step = { label: string; status: "pass" | "fail" | "skip"; detail?: string };
export type DrawRef = { window: number; gamePot: Hex; blocks: { drawn: number; posted: number; fulfilled: number | null }; logSigner: string | null };

async function run(r: DrawRef): Promise<Step[]> {
  const out: Step[] = [];
  const push = (label: string, ok: boolean | null, detail?: string) => out.push({ label, status: ok === null ? "skip" : ok ? "pass" : "fail", detail });
  const c = createPublicClient({ transport: http(RPC) });
  const at = (b: number) => ({ address: r.gamePot, fromBlock: BigInt(b), toBlock: BigInt(b) });
  const [drawn] = await c.getLogs({ ...at(r.blocks.drawn), event: DRAWN, args: { window: BigInt(r.window) } });
  const [posted] = (await c.getLogs({ ...at(r.blocks.posted), event: POSTED, args: { window: BigInt(r.window) } })).slice(-1);
  if (!drawn || !posted) { push(`The draw's events are on Ethereum (read via ${rpcHost})`, false); return out; }
  const d = drawn.args, p = posted.args;
  push(`The draw's events are on Ethereum (read via ${rpcHost})`, true, `window ${p.window}, ${p.holders} holders, ${p.totalTickets} tickets`);
  const rec = await (await fetch(p.uri!)).json() as { kind: string; ref: string | null; body: string; eprev: string | null; ehash: string | null; esig: string | null };
  push("The published list hashes to the dataHash posted on-chain", keccak256(stringToHex(rec.body)) === p.dataHash!.toLowerCase(), p.uri);
  const list = JSON.parse(rec.body) as DrawList;
  const layers = tree(list.leaves.map(leafHash));
  push(`Recomputing the Merkle root from all ${list.leaves.length} leaves gives the on-chain root`, rootOf(layers).toLowerCase() === p.root!.toLowerCase(), p.root!);
  let cum = BigInt(0);
  const contiguous = list.leaves.every((l, i) => { const ok = l.index === i && BigInt(l.cumStart) === cum && (i === 0 || list.leaves[i - 1].account < l.account); cum += BigInt(l.tickets); return ok; });
  push("Every holder has one contiguous ticket range, sorted, adding up to the posted total", contiguous && cum === p.totalTickets && list.leaves.length === Number(p.holders));
  const max = list.leaves.reduce((m, l) => (BigInt(l.tickets) > m ? BigInt(l.tickets) : m), BigInt(0));
  push(`No wallet holds more than ${Number(p.capBps) / 100}% of the tickets`, max * BigInt(10_000) <= p.capBps! * cum);
  if (r.blocks.fulfilled !== null) {
    const [f] = await c.getLogs({ ...at(r.blocks.fulfilled), event: FULFILLED, args: { window: BigInt(r.window) } });
    push("GamePot recorded this word from its VRF coordinator (DrawFulfilled)", !!f && f.args.rand === d.rand, f ? `tx ${f.transactionHash}` : undefined);
  } else push("GamePot recorded this word from its VRF coordinator (DrawFulfilled)", null, "fulfilment not indexed yet");
  // the settle's own logs: who was paid, and every ticket skipped because its wallet is excluded (re-read on chain)
  const rc = await c.getTransactionReceipt({ hash: drawn.transactionHash! });
  const logs = parseEventLogs({ abi: SETTLE_LOGS, logs: rc.logs.filter((l) => sameHex(l.address, r.gamePot)) });
  const paid = logs.flatMap((l) => (l.eventName === "Winner" ? [l.args] : []));
  const skipped = logs.flatMap((l) => (l.eventName === "WinnerExcluded" ? [l.args.winner] : []));
  const onChain = await Promise.all(skipped.map((a) => c.readContract({ address: r.gamePot, abi: IS_EXCLUDED, functionName: "isExcluded", args: [a], blockNumber: rc.blockNumber })));
  push("Every wallet the draw skipped as excluded is excluded on chain (GamePot.isExcluded at the draw's block)", onChain.every(Boolean), skipped.length ? skipped.join(", ") : "none skipped");
  const w = walk(list, d.rand!, new Set(skipped.filter((_, i) => onChain[i]).map((a) => a.toLowerCase())));
  const walked = w.used.filter((u) => u.skip === "excluded").map((u) => u.leaf.account.toLowerCase()).sort().join();
  push(`The walk from the random word (ticket j = keccak256(word, j) mod ${p.totalTickets}, a wallet already picked skipped) uses ${w.used.length} tickets, as the chain did`,
    BigInt(w.used.length) === d.ticketsUsed && walked === skipped.map((a) => a.toLowerCase()).sort().join(), `chain: ${d.ticketsUsed}`);
  const same = w.winners.length === paid.length && BigInt(w.winners.length) === d.winners && w.winners.every((a, i) => paid.some((x) => x.rank === BigInt(i) && sameHex(x.account!, a)));
  push(`It picks the same ${w.winners.length} winners, in the same order`, same, w.winners.map((a, i) => `#${i + 1} ${a}`).join(" · "));
  push(`Each gets prize / ${WINNERS}, the rest went back to the pot`, d.share === d.prize! / BigInt(WINNERS) && paid.every((x) => x.share === d.share));
  push("Every walked ticket's Merkle proof verifies against the on-chain root", w.used.every((u) => verifyProof(proofOf(layers, u.leaf.index), p.root!, leafHash(u.leaf))));
  if (rec.esig) {
    const sig = await checkRecord(rec);
    push("The list was written and signed inside the enclave (the attested log key)", sig.ehashOk && (r.logSigner ? sameHex(sig.signer, r.logSigner) : null), sig.signer ?? "no signer");
  } else push("The list was written and signed inside the enclave (the attested log key)", null, "not an enclave record (pre-enclave build)");
  return out;
}

export function DrawCheck(props: DrawRef) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setError(null);
    try { setSteps(await run(props)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={s.check}>
      <button className={ui.button} type="button" onClick={go} disabled={busy}>{busy ? "Checking…" : "Check this draw in my browser"}</button>
      {error && <p role="alert" className={s.failText}>{error}</p>}
      {steps && (
        <ol className={s.steps2}>
          {steps.map((x) => (
            <li key={x.label}><span className={x.status === "pass" ? s.pass : x.status === "fail" ? s.failText : ui.dim}>{x.status === "pass" ? "PASS" : x.status === "fail" ? "FAIL" : "SKIP"}</span> {x.label}{x.detail && <span className={s.mono}> {x.detail}</span>}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
