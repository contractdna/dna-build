// Changes to the engine's own code and to the rules it runs under, said in public while they can still be stopped.
//  - A code update: the Safe schedules addComposeHash(new) on the DstackApp through its TimelockController
//    (CallScheduled); from 1 h later anyone can execute it (CallExecuted: allowed, the old version still runs), and
//    until then the Safe can cancel it (Cancelled). "It's in" only once this engine runs that compose hash (its own
//    enclave report). What it changes is its release record's `notes` (3-6 plain lines written at release time, in the
//    public repository: deploy/releases/<compose hash>.json, else deploy/release.json when its composeHash matches); a
//    record that can't be read (not a 404) waits for a retry. With no notes the post is code's fixed line, its diff if
//    the record names a commit. What it does is never guessed.
//  - The Safe's queued registry ops and their cancels, a draw interval proposed (the Safe's or the agent's) or
//    cancelled, the Safe's cancels of game steps, a pause: one plain line of what changes, code's words and the chain's
//    numbers.
//  - The day's changelog (after each UTC day, src/sequencer.ts): every real change of the day in one post (code updates,
//    the Safe's executed changes, draw intervals, site changes, the sequencer's ships); a day with none posts nothing.
// Each is one outbox row (src/x.ts publishEvent): the site at once, X by priority as code's template (src/event-posts.ts,
// no model), mirrored to Telegram when it posts. A queued row that a later one supersedes (executed, cancelled) is never
// posted: the later post says it.
import { decodeAbiParameters, type Hex, type Log, parseAbi, parseEventLogs } from "viem";
import { ANNOUNCEMENTS_URL } from "./announce.ts";
import { d } from "./config.ts";
import { ENCLAVE, tcbInfo } from "./enclave.ts";
import { edb as sql } from "./db.ts";
import { decodeOp } from "./lib.ts";
import type { Vector } from "./policy.ts";
import { Defer } from "./jobs.ts";
import { alert } from "./telegram.ts";
import { addressOf, pub } from "./tx.ts";
import { feeFacts, instructionLike, safeTitle, screenLine, TX_URL } from "./voice.ts";
import { publishEvent } from "./x.ts";

type Ev = Record<string, unknown>;
type ChainEv = { eventName: string; args: Record<string, unknown>; transactionHash: Hex; logIndex?: number | null };

/** addComposeHash(bytes32): the DstackApp call that allows a new compose hash (a new engine version). */
export const ADD_COMPOSE_HASH = "0xdfc77223";
const timelockAbi = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
]);
/** The code timelock the watcher reads (none in a deployment without one). */
export const timelockAddresses = () => (d.codeTimelock && d.dstackApp ? [d.codeTimelock] : []);

/** The compose hash a timelock call adds to the DstackApp's allow-list, or null (another call: a device, a removal). */
export function composeHashOf(target: string, data: Hex, app: string | undefined = d.dstackApp): Hex | null {
  if (!app || target.toLowerCase() !== app.toLowerCase() || data.slice(0, 10).toLowerCase() !== ADD_COMPOSE_HASH) return null;
  try { return decodeAbiParameters([{ type: "bytes32" }], `0x${data.slice(10)}`)[0]; } catch { return null; }
}

// ---------------------------------------------------------------- release notes (the public repository)

/** Where release records are read (public, no token) and where a commit's diff is. Test seam: `fetch`. */
export const RELEASES = {
  base: "https://raw.githubusercontent.com/contractdna/dna-build/main/deploy/",
  repo: "https://github.com/contractdna/dna-build",
  fetch: (url: string) => fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" }),
};
export const MAX_NOTES = 6;
export type Release = { commit?: string; notes: string[] };

/** A record's `notes` → the lines a post may lean on: plain printable ASCII, at most 80 characters, no link, handle,
 *  number word, banned term or order to the reader (digits are judged apart: each becomes a figure the post may state); at most 6. A line
 *  that fails is left out, never rewritten. */
export function notesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((n) => {
    if (typeof n !== "string") return [];
    const t = n.normalize("NFKC").replace(/\s+/g, " ").trim();
    return t.length <= 80 && /^[\x20-\x7e]+$/.test(t) && !instructionLike(t) && screenLine(t.replace(/\d+(?:\.\d+)?/g, "N"), 80) ? [t] : [];
  }).slice(0, MAX_NOTES);
}
/** The numbers in the notes ("draws every 24h max" → 24): the only figures of theirs a post may state. */
export const figuresOf = (notes: string[]) => [...new Set(notes.flatMap((n) => [...n.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))))];

/** The release record for a compose hash (its own file first, then the current record), or null: neither is published
 *  (404) for this hash. A timeout, a network error or any other status throws Defer: that post stays queued and
 *  retries while the others go (src/x.ts sendOne), never says "no release notes" for notes it could not read. */
export async function releaseFor(hash: string): Promise<Release | null> {
  const h = hash.replace(/^0x/, "").toLowerCase();
  for (const path of [`releases/${h}.json`, "release.json"]) {
    const unread = (e: Error) => { throw new Defer(60_000, `release record ${path}: ${e.message}`); };
    const r = await RELEASES.fetch(`${RELEASES.base}${path}`).catch(unread);
    if (r.status === 404) continue;
    if (!r.ok) throw new Defer(60_000, `release record ${path}: HTTP ${r.status}`);
    const body = await r.text().catch(unread);
    let j: { composeHash?: unknown; commit?: unknown; notes?: unknown };
    try { j = JSON.parse(body.slice(0, 65_536)); } catch { continue; } // published but not JSON: no record there
    if (String(j?.composeHash ?? "").replace(/^0x/, "").toLowerCase() !== h) continue;
    return { ...(typeof j.commit === "string" && /^[0-9a-f]{40}$/.test(j.commit) ? { commit: j.commit } : {}), notes: notesOf(j.notes) };
  }
  return null;
}

// ---------------------------------------------------------------- what a change is, in code's words

const kind = (k: unknown) => (Number(k) === 1 ? "split" : "fee");
const plates = () => new Set(((d as { plates?: string[] }).plates ?? []).map((p) => p.toLowerCase()));
/** A registry op the Safe queued → what changes (a noun phrase) and its numbers. */
export function registryChange(op: number, data: Hex, feePlates: Set<string> = plates()): Ev & { change: string } {
  const { name, args } = decodeOp(op, data);
  switch (name) {
    case "Register": return { change: `registering a new ${kind(args[1])} module` };
    case "SetShadow": return { change: "a shadow test on a fee plate: fees computed on live swaps, not charged" };
    case "SetCanary": return { change: "a canary test: a new fee charged on a sample of live swaps" };
    case "PromoteActive": return { change: "making a tested module the live one" };
    case "SetParams": {
      const w = Array.isArray(args[1]) && args[1].length === 4 ? (args[1] as Hex[]).map((x) => Number(BigInt(x))) : null;
      if (!w) return { change: "new settings for a module" };
      if (feePlates.has(String(args[0]).toLowerCase())) return { change: "new fee settings on a plate", fee: feeFacts(w.slice(0, 3) as Vector) };
      // ParamSplit's own rule (contracts/src/modules/ParamSplit.sol): anything else is not a split it would use
      const [b, l, t, g] = w;
      if (b >= 2000 && b <= 5000 && l >= 2000 && l <= 5000 && t >= 1000 && t <= 4000 && g <= 2000 && b + l + t + g === 10_000) {
        return { change: "a fee split change", split: { buybackPct: b / 100, liquidityPct: l / 100, treasuryPct: t / 100, gamesPct: g / 100 } };
      }
      return { change: "new settings for a module" };
    }
    case "SetAgent": return { change: "handing the agent role to a new key" };
    case "SetAnchorKey": return { change: "a new anchor key, the key that pins the engine's log on-chain" };
    case "SetLevel": return { change: "a new autonomy level for the engine", level: Number(args[0]) };
    case "UnpauseAgent": return { change: "unpausing the engine" };
    case "ApproveCodehash": return { change: `approving new ${kind(args[1])} module code by its hash` };
    case "RevokeCodehash": return { change: "revoking approved module code" };
    default: return { change: "a registry change" };
  }
}
/** The Safe's cancels of a game step (the agent's, or a proposal waiting its hour). */
const GAME_CANCELS: Record<string, string> = {
  ListCancelled: "a posted jackpot list: no draw from it",
  RewardCancelled: "a queued idea reward: the amount goes back to the idea reserve",
  BallotCancelled: "a ballot",
  OutcomeCancelled: "an idea round's proposed outcome",
  CancelledByGuardian: "a sealed mystery mutation",
};

const lower = (v: unknown) => String(v ?? "").toLowerCase();
const queuedRow = async (ref: string) =>
  (await sql<{ event: Ev }[]>`select event from x_outbox where event->>'event' = 'change_queued' and event->>'ref' = ${ref} order by id desc limit 1`)[0]?.event;

/** Watcher hook (src/x.ts onChainEvent, before its own cases): an owner change becomes one outbox row. true = handled
 *  here; the agent's own queued ops and the Safe's vetoes of them stay with x.ts. */
export async function onOwnerChange(e: ChainEv): Promise<boolean> {
  const a = e.args;
  const agent = addressOf("agent")?.toLowerCase();
  let ev: Ev | null = null;
  switch (e.eventName) {
    case "Queued":
      if (lower(a.proposer) === agent) return false;
      ev = { event: "change_queued", ref: `op:${a.id}`, who: "the Safe", eta: String(a.eta), ...registryChange(Number(a.op), a.data as Hex) };
      break;
    case "Cancelled": {
      const ref = `op:${a.id}`;
      let q = await queuedRow(ref);
      if (!q) {
        // queued before this watcher saw it: the indexed Queued says whose it was
        const [c] = await sql<{ op: number; data: Hex; proposer: string }[]>`select (args->>'op')::int as op, args->>'data' as data, args->>'proposer' as proposer
          from chain_log where event = 'Queued' and address = ${d.registry.toLowerCase()} and args->>'id' = ${String(a.id)}`;
        if (!c || lower(c.proposer) === agent) return false; // the agent's op: a veto (x.ts)
        q = { who: "the Safe", ...registryChange(c.op, c.data) };
      }
      ev = { ...q, event: "change_cancelled", ref };
      break;
    }
    case "DrawIntervalProposed": {
      const who = lower(a.by) === lower(d.safe) ? "the Safe" : lower(a.by) === agent ? "me" : null;
      if (!who) return false;
      ev = { event: "change_queued", ref: `interval:${a.eta}`, who, eta: String(a.eta), change: "a new draw interval", hours: Number(a.value) / 3600 };
      break;
    }
    case "DrawIntervalCancelled": {
      const [p] = await sql<{ event: Ev }[]>`select event from x_outbox where event->>'event' = 'change_queued' and event->>'ref' like 'interval:%' order by id desc limit 1`;
      ev = { ...(p?.event ?? { change: "a new draw interval" }), event: "change_cancelled", ref: p?.event.ref ?? `interval:${e.transactionHash}` };
      break;
    }
    case "AgentPaused":
      // an unpause is the UnpauseAgent op, said when it was queued
      if (!a.paused) return true;
      ev = { event: "change_done", ref: `pause:${e.transactionHash}`, change: "the engine's agent key is paused: no new changes from it until the Safe unpauses it" };
      break;
    default:
      if (!GAME_CANCELS[e.eventName]) return false;
      ev = { event: "change_cancelled", ref: `${e.eventName}:${e.transactionHash}`, change: GAME_CANCELS[e.eventName] };
  }
  await publishEvent(`${e.eventName}:${e.transactionHash}:${e.logIndex ?? 0}`, ev, `${TX_URL}${e.transactionHash}`);
  return true;
}

const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000Z", "Z");
/** The code timelock's logs in a watched range (src/watch.ts): a code update scheduled, executed or cancelled → a
 *  signers' alert and one outbox row each. Other timelock calls (devices, removals) are not code updates. */
export async function onTimelockLogs(logs: Log[]) {
  for (const e of parseEventLogs({ abi: timelockAbi, logs })) {
    const id = e.args.id;
    const link = `${TX_URL}${e.transactionHash}`;
    // keys carry the tx: a cancelled batch scheduled again (same targets, data and salt) has the same timelock id
    const k = `${id}:${e.transactionHash}`;
    if (e.eventName === "Cancelled") {
      const [s] = await sql<{ event: { hash: string } }[]>`select event from x_outbox where event->>'event' = 'update_queued' and event->>'id' = ${id} order by id desc limit 1`;
      if (!s) continue; // not a code update, or scheduled before this watcher ran
      await alert(`Code update cancelled: compose hash ${s.event.hash} (timelock id ${id}).`, `alert:update:cancelled:${k}`);
      await publishEvent(`update:cancelled:${k}`, { event: "update_cancelled", id, hash: s.event.hash }, link);
      continue;
    }
    const hash = composeHashOf(e.args.target, e.args.data);
    if (!hash) continue;
    if (e.eventName === "CallScheduled") {
      const eta = Number((await pub.getBlock({ blockNumber: e.blockNumber })).timestamp + e.args.delay);
      await alert(`Code update scheduled: compose hash ${hash}. Executable by anyone at ${iso(eta)}: the Safe must cancel timelock id ${id} before then to stop it.`, `alert:update:scheduled:${k}`);
      await publishEvent(`update:scheduled:${k}`, { event: "update_queued", id, hash, eta: String(eta) }, link);
    } else {
      await alert(`Code update executed: compose hash ${hash} is allowed; the CVM can switch to it.`, `alert:update:executed:${k}`);
      const at = Number((await pub.getBlock({ blockNumber: e.blockNumber })).timestamp);
      // the version this engine already ran before the allow (the Safe re-allowing it, a back-out): nothing to switch to
      if (bare(hash) === (await running()) && at * 1000 >= RUNNING.bootAt) continue;
      await publishEvent(`update:executed:${k}`, { event: "update_allowed", id, hash, tx: e.transactionHash, at: String(at) }, link);
    }
  }
  await runningCheck();
}

const bare = (h: unknown) => String(h ?? "").replace(/^0x/, "").toLowerCase();
/** The compose hash this engine runs (the enclave's own report; null outside one) and when this process started.
 *  Test seam. */
export const RUNNING = { composeHash: async (): Promise<string | null> => (ENCLAVE.on ? (await tcbInfo()).composeHash : null), bootAt: Date.now() };
/** This engine's compose hash, bare; null outside an enclave or when the report can't be read (never fails a tick). */
const running = async () => bare(await RUNNING.composeHash().catch(() => null)) || null;
/** The release notes of the version this engine runs, as last read: the watcher tick reads them (primeRunningNotes),
 *  so a reply or a decision never waits on the public repository; [] until read, outside an enclave, or with no record. */
const NOTES = { hash: "", notes: [] as string[], triedAt: 0 };
export async function runningNotes(): Promise<string[]> {
  const h = await running();
  return h && NOTES.hash === h ? NOTES.notes : [];
}
/** Read the running version's release record once; with none yet or a failed read, again after 10 minutes. */
export async function primeRunningNotes(h: string, now = Date.now()) {
  if (NOTES.hash === h || now - NOTES.triedAt < 10 * 60_000) return;
  NOTES.triedAt = now;
  const r = await releaseFor(h).catch(() => null);
  if (r) Object.assign(NOTES, { hash: h, notes: r.notes });
}
/** "It's in" once this engine runs the newest allowed update's code and started after the allow (it switched; a
 *  version it ran before the allow is no switch): once per allow (key update:running:<timelock id>:<tx>), its link the
 *  execute tx. Called every watcher tick: the newest allowed row (a backward scan of the outbox, small) when there is
 *  nothing to say. */
export async function runningCheck() {
  const mine = await running();
  if (!mine) return;
  void primeRunningNotes(mine).catch(() => {});
  const [a] = await sql<{ event: Ev; link: string | null }[]>`select event, link from x_outbox where event->>'event' = 'update_allowed' order by id desc limit 1`;
  if (!a || bare(a.event.hash) !== mine || !(Number(a.event.at) * 1000 < RUNNING.bootAt)) return;
  const key = `update:running:${a.event.id}:${a.event.tx}`;
  if ((await sql`select 1 from x_outbox where event_key = ${key}`).length) return;
  await publishEvent(key, { event: "update_running", id: a.event.id, hash: a.event.hash }, a.link ?? ANNOUNCEMENTS_URL);
}

// ---------------------------------------------------------------- send time: the facts a post gets

/** Code's words for where a change is (`stage`): what the writer reacts to and may never claim past. */
const STAGE = {
  update_queued: "an update to my own code waits in the public timelock; `notes` are its release notes and all it changes; it can land from activatesAt UTC (someone has to execute it) unless the Safe's owners call it off first; nothing has changed yet",
  update_due: "an update to my own code has waited out its public hour in the timelock; `notes` are its release notes and all it changes; it lands once someone executes it; nothing has changed yet",
  update_allowed: "the timelock executed the update: the new version is allowed and the Safe's owners can no longer stop it, but i still run the old one; i switch to it on my next restart; `notes` are what it will change; it is not live yet",
  update_running: "it's in: i now run the new version; `notes` are what changed",
  update_cancelled: "the Safe's owners called off the queued update to my own code; nothing changed, the current version keeps running",
  change_queued: "`who` put this in the public queue: `change`; it can land from activatesAt UTC (someone has to execute it) unless the Safe's owners call it off first; nothing has changed yet",
  change_due: "`who` put this in the public queue: `change`; its public hour is over and it takes effect once executed",
  change_cancelled: "the Safe's owners called this off before it took effect: `change`; nothing changed",
  change_done: "the Safe's owners did this, in effect now: `change`",
  change_in: "`who` put this in the public queue and it went through: in effect now: `change`",
};
const at = (s: number) => { const t = new Date(s * 1000); return { utcHour: t.getUTCHours(), utcMinute: t.getUTCMinutes() }; };
const hhmm = (s: number) => new Date(s * 1000).toISOString().slice(11, 16);
const NO_NOTES = "It has no release notes to show, so what it changes is not described here.";
/** Code's own line for an update with no notes (the writer never gets to describe it). */
export function fixedLine(event: string, eta: number | null): string {
  if (event === "update_running") return `Engine update is in: the engine now runs the new version. ${NO_NOTES}`;
  if (event === "update_allowed") return `Engine update allowed: the Safe can no longer stop it, and the engine switches to it on its next restart. ${NO_NOTES}`;
  return eta ? `Engine update queued. ${NO_NOTES} It can land from ${hhmm(eta)} UTC; the Safe can cancel it until then.`
    : `Engine update queued; its public hour is over. ${NO_NOTES}`;
}

/** Pure: a code update's facts at send time (`now` in seconds). `rec`: its release record (null: none found). */
export function updateFacts(ev: Ev, rec: Release | null, now: number): Ev {
  const notes = rec?.notes ?? [];
  const eta = Number(ev.eta ?? 0);
  const open = ev.event === "update_queued" && now < eta;
  const figures = figuresOf(notes);
  const base: Ev = { event: ev.event, hash: ev.hash, ...(open ? { activatesAt: at(eta), minutesLeft: Math.ceil((eta - now) / 60) } : {}), ...(notes.length ? { notes } : {}), ...(figures.length ? { figures } : {}) };
  if (ev.event === "update_cancelled") return { ...base, stage: STAGE.update_cancelled };
  if (!notes.length) return { ...base, fixed: fixedLine(String(ev.event), open ? eta : null), ...(rec?.commit ? { append: `The diff: ${RELEASES.repo}/commit/${rec.commit}` } : {}) };
  return { ...base, stage: ev.event === "update_queued" ? (open ? STAGE.update_queued : STAGE.update_due) : STAGE[ev.event as "update_allowed" | "update_running"] };
}

/** Pure: an owner change's facts at send time (`now` in seconds): code's line and numbers, the time while it is open. */
export function changeFacts(ev: Ev, now: number): Ev {
  const { eta: _eta, ref: _ref, ...f } = ev;
  if (ev.event !== "change_queued") return { ...f, stage: STAGE[ev.event as "change_cancelled" | "change_done"] };
  const eta = Number(ev.eta);
  return now < eta ? { ...f, activatesAt: at(eta), minutesLeft: Math.ceil((eta - now) / 60), stage: STAGE.change_queued } : { ...f, stage: STAGE.change_due };
}

/** The queued change went through: the registry op executed, or a draw interval set after its proposal's hour. */
async function changeExecuted(ref: string, eta: number): Promise<boolean> {
  const [kind, id] = ref.split(":");
  if (kind === "op") return (await sql`select 1 from chain_log where event = 'Executed' and address = ${d.registry.toLowerCase()} and args->>'id' = ${id}`).length > 0;
  return kind === "interval" && (await sql`select 1 from chain_log where event = 'DrawIntervalSet' and at >= to_timestamp(${eta})`).length > 0;
}
/** src/x.ts resolve for these events. null: superseded (a later executed or cancelled row says it). A queued change
 *  that went through before its post: said as in effect (the queued words would be stale). */
export async function resolveChange(ev: Ev, now = Math.floor(Date.now() / 1000)): Promise<Ev | null> {
  if (String(ev.event).startsWith("update_")) {
    // superseded: an executed or cancelled row after this schedule (eta tells a re-schedule of the same id apart)
    if (ev.event === "update_queued" && (await sql`select 1 from x_outbox x where x.event->>'id' = ${String(ev.id)} and x.event->>'event' in ('update_allowed', 'update_cancelled')
      and x.id > (select max(id) from x_outbox where event->>'event' = 'update_queued' and event->>'id' = ${String(ev.id)} and event->>'eta' = ${String(ev.eta)})`).length) return null;
    if (ev.event === "update_allowed" && (await sql`select 1 from x_outbox where event_key = ${`update:running:${ev.id}:${ev.tx}`}`).length) return null; // "it's in" says it
    return updateFacts(ev, await releaseFor(String(ev.hash)), now);
  }
  if (ev.event === "change_queued" && (await sql`select 1 from x_outbox where event->>'event' = 'change_cancelled' and event->>'ref' = ${String(ev.ref)}`).length) return null;
  if (ev.event === "change_queued" && (await changeExecuted(String(ev.ref), Number(ev.eta)))) {
    const { eta: _eta, ref: _ref, ...f } = ev;
    return { ...f, event: "change_done", stage: STAGE.change_in };
  }
  return changeFacts(ev, now);
}

/** A code update scheduled, neither executed nor cancelled, still in its hour (the pending block's line), or null.
 *  simplification: the plain outbox rows, not verified: writer context only, like the story lines. */
export async function pendingUpdate(now = Date.now()): Promise<{ etaMs: number } | null> {
  const [r] = await sql<{ eta: string }[]>`select o.event->>'eta' as eta from x_outbox o where o.event->>'event' = 'update_queued'
    and not exists (select 1 from x_outbox x where x.event->>'id' = o.event->>'id' and x.event->>'event' in ('update_allowed', 'update_cancelled') and x.id > o.id)
    order by o.id desc limit 1`;
  const etaMs = Number(r?.eta) * 1000;
  return r && etaMs > now ? { etaMs } : null;
}


// ---------------------------------------------------------------- the day's changelog

const titled = (lead: string, t: unknown) => { const s = safeTitle(t, 80); return s ? `${lead}: ${s}` : lead; };
/** What a site record of the day says changed (null: not a change). */
const notesTail = (f: Ev) => (Array.isArray(f.notes) && f.notes.length ? `: ${f.notes.join("; ")}` : "");
const ANNOUNCED: Record<string, (f: Ev) => string | null> = {
  update_running: (f) => `the engine runs a new version${notesTail(f)}`,
  update_allowed: (f) => `an engine update was allowed; the engine switches to it on its next restart${notesTail(f)}`,
  change_done: (f) => (typeof f.change === "string" ? f.change : null),
  site_changed: (f) => titled("the website changed", f.title),
  seq_shipped: (f) => titled("a new game shipped", f.title),
  outcome: (f) => (f.outcome === "kept (promoted)" ? "a tested fee became the live fee" : null),
};
/** An executed registry change's line, with its numbers. */
export function changeLine(c: Ev & { change: string }): string {
  const s = c.split as Record<string, number> | undefined;
  if (s) return `the fee split changed: buyback ${s.buybackPct}%, liquidity ${s.liquidityPct}%, treasury ${s.treasuryPct}%, games ${s.gamesPct}%`;
  if (c.level !== undefined) return `the engine's autonomy level is now ${c.level}`;
  return `the Safe's change went through: ${c.change}`;
}
/** Every real change in [from, to), oldest first, each said once: the day's site records (code updates, site changes,
 *  ships, a pause, a promoted fee), the Safe's executed registry ops, draw interval changes. */
export async function changesIn(from: Date, to: Date): Promise<string[]> {
  const out: string[] = [];
  const docs = (await sql<{ doc: { type: string; facts: Ev } }[]>`select doc from log where kind = 'announce' and at >= ${from} and at < ${to} order by log.seq`).map((r) => r.doc);
  // an allowed update already running by the day's end is said once, as running
  const running = new Set(docs.filter((x) => x.type === "update_running").map((x) => bare(x.facts?.hash)));
  for (const x of docs) {
    if (x.type === "update_allowed" && running.has(bare(x.facts?.hash))) continue;
    const line = ANNOUNCED[x.type]?.(x.facts ?? {});
    if (line) out.push(line);
  }
  const promoted = docs.some((x) => x.type === "outcome" && x.facts?.outcome === "kept (promoted)");
  const agent = addressOf("agent")?.toLowerCase() ?? "";
  for (const c of await sql<{ op: number; data: Hex }[]>`select (q.args->>'op')::int as op, q.args->>'data' as data from chain_log x
    join chain_log q on q.event = 'Queued' and q.address = x.address and q.args->>'id' = x.args->>'id'
    where x.event = 'Executed' and x.address = ${d.registry.toLowerCase()} and x.at >= ${from} and x.at < ${to} and lower(q.args->>'proposer') <> ${agent}
    order by x.block, x.log_index`) {
    const ch = registryChange(c.op, c.data);
    if (!(promoted && decodeOp(c.op, c.data).name === "PromoteActive")) out.push(changeLine(ch)); // the promoted fee's line says it
  }
  for (const c of await sql<{ v: string }[]>`select args->>'value' as v from chain_log where event = 'DrawIntervalSet' and at >= ${from} and at < ${to} order by block, log_index`) {
    out.push(`draws now run every ${Number(c.v) / 3600} hours`);
  }
  return [...new Set(out)];
}
const CHANGELOG_STAGE = "every change to me yesterday (the UTC day that just ended), all of it: `changes`. say what changed; it all happened and is in effect";
/** After the UTC day `day`: its changelog, one post (key changes:<day>) listing every change, or nothing when nothing
 *  changed. Never an empty changelog. Waits until the indexer has the whole day. */
export async function changelog(day: string, live: boolean): Promise<string> {
  const from = new Date(`${day}T00:00:00Z`), to = new Date(from.getTime() + 86_400_000);
  const [c] = await sql<{ at: Date }[]>`select at from cursor`;
  if (!c || c.at < to) return "waiting: the indexer has not reached the day's end";
  const changes = await changesIn(from, to);
  if (!changes.length) return "no post: nothing changed";
  if (!live) return "no post: the engine is not live";
  const figures = figuresOf(changes);
  await publishEvent(`changes:${day}`, { event: "day_changes", day, date: day, changes, ...(figures.length ? { figures } : {}), stage: CHANGELOG_STAGE }, ANNOUNCEMENTS_URL);
  return `changelog for ${day}: ${changes.length} changes`;
}
