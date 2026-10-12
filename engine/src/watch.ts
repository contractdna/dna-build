// Head watcher (latest tag, not finalized: alerts must be fast; nothing here is persisted except the cursor).
// Per new block: registry + hook + pool Swap logs → alerts; hook.breaker() → failCount ≥ 3 enqueues the keeper's
// permissionless rollback (dedupe per breaker window). Every minute: indexer staleness, key balances, failed jobs.
import { type Address, formatEther, type Hex, parseEventLogs } from "viem";
import * as abi from "./abi.ts";
import { BALANCES, d, type KeyName, WATCH } from "./config.ts";
import { edb as sql } from "./db.ts";
import { enqueue } from "./jobs.ts";
import { decodeOp } from "./lib.ts";
import { mode } from "./mode.ts";
import { alert } from "./telegram.ts";
import { addressOf, balances, pub } from "./tx.ts";
import { onChainEvent } from "./x.ts";
import { announceAddresses, failClosedChecks, gameEventAbi } from "./games.ts";
import { onTimelockLogs, timelockAddresses } from "./upgrades.ts";
import { vaultEventAbi, vaultsAddress } from "./vaults.ts";

const events = [...abi.registryAbi, ...abi.hookAbi, ...gameEventAbi, ...vaultEventAbi];
const swapEvent = abi.poolManagerAbi.find((x) => x.type === "event" && x.name === "Swap")!;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (s: bigint) => new Date(Number(s) * 1000).toISOString().replace(".000Z", "Z");
const fmtArg = (v: unknown): string => (Array.isArray(v) ? `[${v.map(fmtArg).join(",")}]` : typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v) ? short(v) : String(v));

type Ev = { eventName: string; args: Record<string, any>; transactionHash: Hex; blockNumber: bigint; logIndex?: number }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Who sent the tx: our keeper / agent / anchor key, the Safe (an EOA Safe sends itself; a Gnosis Safe is the tx's
 *  `to`, executed by a signer), or someone else. */
async function sender(tx: Hex) {
  const t = await pub.getTransaction({ hash: tx });
  const from = t.from.toLowerCase();
  const ours = (["keeper", "agent", "anchor"] as KeyName[]).find((k) => addressOf(k)?.toLowerCase() === from);
  const safe = d.safe.toLowerCase();
  return ours ? `our ${ours} key` : from === safe || t.to?.toLowerCase() === safe ? "the Safe" : `${short(from)} (not ours)`;
}

/** Pure: alert text for a registry/hook event, or null (not alert-worthy). Async lookups are passed in. */
export function describe(e: Ev, by?: string, anchoredOk?: boolean): string | null {
  const a = e.args;
  switch (e.eventName) {
    case "Queued": {
      const op = decodeOp(Number(a.op), a.data);
      return `Queued #${a.id} ${op.name}(${op.args.map(fmtArg).join(", ")}) by ${short(a.proposer)}. Executable by anyone at ${when(a.eta)}: the Safe must cancel before then to stop it.`;
    }
    case "Executed": return `Executed #${a.id} (${decodeOp(Number(a.op), "0x").name}) by ${by}.`;
    case "Cancelled": return `Cancelled queued op #${a.id}.`;
    case "LevelSet": return `Autonomy level ${a.from} → ${a.to}.`;
    case "AgentPaused": return a.paused ? "Agent PAUSED by the Safe." : "Agent unpaused.";
    case "Anchored": return anchoredOk ? null : `UNEXPECTED Anchored root ${a.root} uri ${a.uri} (sent by ${by}).`;
    case "ModuleFailed": return `ModuleFailed ${short(a.module)} (failCount ${a.failCount}).`;
    case "RolledBack": return `Rolled back the ${Number(a.kind) === 0 ? "fee" : "split"} route (by ${by}).`;
    case "CanaryEnded": return `Canary ${short(a.module)} ended (by ${short(a.by)}); the module is back to Proposed.`;
    case "CodehashApproved": return `Safe approved codehash ${a.codehash} for agent Register (level 10), kind ${Number(a.kind) === 0 ? "fee" : "split"}.`;
    case "CodehashRevoked": return `Safe revoked codehash ${a.codehash}.`;
    // the game layer: proposals the Safe can still veto, with the deadline
    case "BallotProposed": return `Ballot #${a.ballot} proposed by ${short(a.by)}; voting opens ${when(a.start)}. The Safe can cancelBallot(${a.ballot}) until it resolves (inside the first hour it frees this round's slot).`;
    case "RewardQueued": return `Idea reward #${a.id} queued: ${formatEther(a.amount)} ETH to ${short(a.to)} (record ${String(a.ideaRef).slice(0, 10)}…). Payable from ${when(a.eta)}: the Safe can cancelReward(${a.id}) until then; the watchdog checks its records.`;
    case "RewardCancelled": return `Idea reward #${a.id} cancelled by the Safe; the amount is back in the idea reserve.`;
    case "DrawIntervalProposed": return `Draw interval → ${Number(a.value) / 3600} h proposed by ${short(a.by)}; executable at ${when(a.eta)}: the Safe can cancelDrawInterval() until then.`;
    case "Sealed": return `Mystery #${a.mystery} sealed by ${short(a.by)}, reveal at ${when(a.revealAt)}. The Safe can cancelSeal(${a.mystery}) while it is sealed.`;
    case "ListPosted": return `Jackpot list for window ${a.window} posted: ${a.holders} holders, ${a.totalTickets} tickets, cap ${Number(a.capBps) / 100}%. The watchdog rebuilds it now; the Safe can cancelList(${a.window}) until the draw is requested (from ${when(a.eta)}).`;
    case "WinnerExcluded": return `Jackpot window ${a.window}: a drawn ticket's wallet ${a.winner} is excluded; the walk skipped it. Check how an excluded wallet got into the list.`;
    case "DrawAborted": return `Jackpot draw aborted (VRF request ${a.reqId} timed out); the prize is back in the pot.`;
    case "Rescued": return `GamePot rescued ${a.amount} wei to BuybackBurn (VRF stalled ≥ 14 d).`;
    default: return null;
  }
}

/** Agent-loop reactions at head: any registry state change re-runs the plate state machine (Executed by anyone →
 *  gates re-judged → endCanary if failing); a ModuleFailed from the open experiment's canary plate ends the canary at
 *  once (kill condition 1), without waiting for the finalized indexer. */
async function react(e: Ev) {
  if (["Executed", "Cancelled", "CanaryEnded", "RolledBack", "StatusChanged", "LevelSet", "AgentPaused"].includes(e.eventName)) {
    await enqueue("plates:tick", {}, { dedupeKey: `tick:${e.transactionHash}` });
  }
  if (e.eventName === "ModuleFailed") {
    const [run] = await sql<{ id: string }[]>`select id from thread where kind = 'fee' and stage in ('canary', 'tune_queued', 'promote_queued', 'promote_requested')
      and lower(data->>'plate') = ${String(e.args.module).toLowerCase()}`;
    if (!run) return;
    await enqueue("registry:endCanary", { run: run.id }, { dedupeKey: `endCanary:${e.transactionHash}` });
    await enqueue("plates:tick", { kill: `ModuleFailed from the canary plate (tx ${e.transactionHash})` }, { dedupeKey: `tick:kill:${e.transactionHash}` });
  }
}

let last: bigint | undefined;
let breakerAt = 0; // wall-clock ms of the last breaker() read

export async function watchTick() {
  const head = await pub.getBlockNumber();
  if (last === undefined) {
    const [s] = await sql<{ value: { block: number } }[]>`select value from state where key = 'engine_watch'`;
    last = s ? BigInt(s.value.block) : head - 1n;
  }
  if (head <= last) return;
  const from = last + 1n > head - 100n ? last + 1n : head - 100n; // ≤ 100 blocks after a stall
  const [core, swaps] = await Promise.all([
    pub.getLogs({ address: [d.registry, d.hook, ...announceAddresses(), ...timelockAddresses(), ...(vaultsAddress() ? [vaultsAddress()!] : [])], fromBlock: from, toBlock: head }),
    pub.getLogs({ address: d.poolManager, event: swapEvent, args: { id: d.poolId }, fromBlock: from, toBlock: head }),
  ]);
  // the code timelock's logs apart (its Cancelled(bytes32) is not the registry's Cancelled(uint256)): src/upgrades.ts
  const tl = new Set(timelockAddresses().map((a) => a.toLowerCase()));
  await onTimelockLogs(core.filter((l) => tl.has(l.address.toLowerCase())));
  // an event with no arguments (GamePot's DrawIntervalCancelled()) decodes to args undefined
  const evs = parseEventLogs({ abi: events, logs: core.filter((l) => !tl.has(l.address.toLowerCase())) }).map((e) => ({ ...e, args: e.args ?? {} })) as unknown as Ev[];
  for (const e of evs) {
    const by = ["Executed", "Anchored", "RolledBack"].includes(e.eventName) ? await sender(e.transactionHash) : undefined;
    let anchoredOk: boolean | undefined;
    if (e.eventName === "Anchored") {
      const [hit] = await sql`select 1 from log where hash = decode(${String(e.args.root).slice(2)}, 'hex') or ehash = decode(${String(e.args.root).slice(2)}, 'hex')`;
      anchoredOk = !!hit && by === "our anchor key";
    }
    const text = describe(e, by, anchoredOk);
    if (text) await alert(text, `alert:ev:${e.transactionHash}:${e.eventName}:${e.args.id ?? e.args.root ?? ""}`);
    await react(e);
    // a draw's post names its winners: the settle's Winner logs, same tx, so in this same range
    if (e.eventName === "Drawn") e.args.paid = evs.filter((w) => w.eventName === "Winner" && w.transactionHash === e.transactionHash).map((w) => w.args);
    await onChainEvent(e); // X: a state change worth a post (src/x.ts decides; one outbox row per log)
  }
  for (const s of swaps) {
    const eth = s.args.amount0! < 0n ? -s.args.amount0! : s.args.amount0!;
    if (eth >= WATCH.largeSwapWei) await alert(`Large swap: ${formatEther(eth)} ETH (${s.args.amount0! < 0n ? "buy" : "sell"}) tx ${s.transactionHash}`, `alert:swap:${s.transactionHash}:${s.logIndex}`);
  }
  // failCount only rises with a hook ModuleFailed log, which this tick just read: read breaker() when one appeared, and
  // otherwise once a minute (start-up, a stall > 100 blocks, the hourly re-alert while tripped). Saves ~1 eth_call
  // per block (docs/CAPACITY.md).
  const failed = evs.some((e) => e.eventName === "ModuleFailed");
  if (!failed && Date.now() - breakerAt < 60_000) return void (await advance(head));
  const [failCount, windowStart] = await pub.readContract({ address: d.hook, abi: abi.hookAbi, functionName: "breaker" });
  breakerAt = Date.now(); // only after a successful read: a failed one is retried next tick
  if (failCount >= 3) {
    // hourly while it stays tripped: a new rollback job (if the last one failed) and a fresh alert
    const hour = new Date().toISOString().slice(0, 13);
    await enqueue("keeper:rollback", {}, { dedupeKey: `rollback:${windowStart}:${hour}`, maxAttempts: 20 });
    const m = await mode();
    const action = m === "live" ? "the keeper is rolling back the fee route" : `engine is ${m}: NOT rolling back; anyone (or the Safe) can call registry.rollback(0)`;
    await alert(`Breaker tripped (failCount ${failCount}, window ${windowStart}): ${action}.`, `alert:breaker:${windowStart}:${hour}`);
  }
  await advance(head);
}

async function advance(head: bigint) {
  last = head;
  await sql`insert into state (key, block, value) values ('engine_watch', ${Number(head)}, ${sql.json({ block: Number(head) })})
    on conflict (key) do update set block = excluded.block, value = excluded.value, updated_at = now()`;
}
export const lastWatched = () => last;

/** Minute checks. Alert dedupe keys carry the hour, so a persisting problem re-alerts hourly, not every minute. */
export async function minuteChecks() {
  const hour = new Date().toISOString().slice(0, 13);
  const [c] = await sql<{ checked_at: Date }[]>`select checked_at from cursor`;
  if (!c || Date.now() - c.checked_at.getTime() > WATCH.indexerStaleMs) await alert(`Indexer stale: last pass ${c?.checked_at.toISOString() ?? "never"}.`, `alert:stale:${hour}`);
  for (const [k, eth] of Object.entries(await balances()) as [KeyName, number][]) {
    if (eth < BALANCES[k].alert) await alert(`Low balance: ${k} key ${addressOf(k)} has ${eth.toFixed(4)} ETH (alert < ${BALANCES[k].alert}).`, `alert:bal:${k}:${hour}`);
  }
  await failClosedChecks();
}

export const keyAddresses = () => Object.fromEntries((["agent", "anchor", "keeper"] as KeyName[]).map((k) => [k, addressOf(k) ?? null])) as Record<KeyName, Address | null>;
