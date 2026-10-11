// The site's event stream. Mock mode: the simulated feed below. LIVE (NEXT_PUBLIC_LIVE=1): /api/stream (indexer).
// Server events carry { id, at (ISO), block } so reconnect replays dedupe and show true times; counters come only
// from `core` snapshots, never from increments (the reducer skips them for events with an id).
import type { Core, LogTone } from "../_data/types";

export type { Core };

type Envelope = { id?: string; at?: string; block?: number };
export type FeedEvent = Envelope & (
  | { kind: "swaps"; n: number }
  | { kind: "mev" }
  | { kind: "testing" }
  | { kind: "simulation"; runs: number; confidence: number }
  | { kind: "rejected" }
  | { kind: "canary" }
  | { kind: "activated" }
  | { kind: "rollback" }
  | { kind: "epoch" }
  | { kind: "recovered" }
  | { kind: "block"; block: number }
  | { kind: "core"; core: Partial<Core> } // chain-backed snapshot (LIVE)
  | { kind: "chain"; text: string; tone: LogTone } // any other chain event, as one log line (LIVE)
);
export const initialCore: Core = {
  status: "ONLINE",
  autonomy: 4,
  epoch: 3,
  activeModules: 2, // active fee + active split (baseline counts as 1)
  simulations: 8421,
  proposals: 312,
  rollbacks: 1,
  block: 26131552,
  goal: "improve LP efficiency during high volatility",
  task: "testing adaptive-fee plate A",
  hypothesis: "dynamic fees could improve LP returns without hurting organic volume",
  confidence: 72,
  next: ["red team test", "canary deployment if passed"],
  state: "observing",
  log: [
    { id: 1, time: "17:41", text: "analyzed 128 swaps", tone: "plain" },
    { id: 2, time: "17:42", text: "detected MEV pattern", tone: "alert" },
    { id: 3, time: "17:43", text: "simulation completed", tone: "plain" },
    { id: 4, time: "17:43", text: "candidate rejected", tone: "reject" },
    { id: 5, time: "17:44", text: "testing new configuration", tone: "plain" },
  ],
};

/** LIVE's starting point before (or without) the server snapshot: zeros and empty lines, never the sample values above. */
export const blankCore: Core = {
  status: "ONLINE", autonomy: 0, epoch: 0, activeModules: 1, simulations: 0, proposals: 0, rollbacks: 0, block: 0,
  goal: "", task: "", hypothesis: "", confidence: 0, next: [], state: "observing", log: [],
};

let logId = 100;
const hhmm = () => new Date().toTimeString().slice(0, 5);

export function reduce(c: Core, e: FeedEvent): Core {
  // server events: their own id (unique across reconnects) and true UTC time; mock: a counter and local time
  const push = (c: Core, text: string, tone: LogTone = "plain"): Core => ({
    ...c,
    log: [...c.log, { id: e.id ?? logId++, time: e.at ? e.at.slice(11, 16) : hhmm(), text, tone }].slice(-6),
  });
  const k = e.id ? 0 : 1; // counters move only in mock mode; LIVE counts arrive in `core` snapshots
  switch (e.kind) {
    case "block":
      return { ...c, block: e.block };
    case "swaps":
      return push(c, `analyzed ${e.n} swaps`);
    case "mev":
      return push(c, "detected MEV pattern", "alert");
    case "testing":
      return push({ ...c, state: "testing", next: ["simulation", "red team test"] }, "testing new configuration");
    case "simulation":
      return push(
        { ...c, simulations: c.simulations + e.runs * k, confidence: e.confidence, next: ["red team test", "canary deployment if passed"] },
        "simulation completed",
      );
    case "rejected":
      return push({ ...c, state: "observing", proposals: c.proposals + k, next: ["observe market", "draft next hypothesis"] }, "candidate rejected", "reject");
    case "canary":
      return push({ ...c, state: "canary", proposals: c.proposals + k, next: ["measure canary", "activate or roll back"] }, "canary deployment started", "good");
    case "activated": // promotion replaces the active plate: module count unchanged
      return push({ ...c, state: "observing", next: ["observe market", "draft next hypothesis"] }, "module activated", "good");
    case "rollback":
      return push({ ...c, state: "rollback", rollbacks: c.rollbacks + k, next: ["restore baseline", "record lesson"] }, "rollback executed", "reject");
    case "recovered":
      return { ...c, state: "observing" };
    case "epoch":
      return push({ ...c, epoch: c.epoch + k, state: "observing" }, `epoch ${String(c.epoch + 1).padStart(2, "0")} began`, "good");
    case "core":
      return { ...c, ...e.core };
    case "chain":
      return push(c, e.text, e.tone);
  }
}

/** Story-shaped mock cadence: observe → test → reject | canary → activate | rollback. */
export function startMockFeed(emitRaw: (e: FeedEvent) => void): () => void {
  let alive = true;
  const emit = (e: FeedEvent) => { if (alive) emitRaw(e); }; // a stopped feed (StrictMode remount) never emits
  let block = initialCore.block;
  const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
  const between = (a: number, b: number) => a + Math.random() * (b - a);
  const swaps = () => emit({ kind: "swaps", n: Math.round(between(12, 180)) });

  const blocks = setInterval(() => emit({ kind: "block", block: ++block }), 12000);

  (async () => {
    await wait(2.5);
    while (alive) {
      for (let i = 0, n = Math.round(between(2, 4)); i < n && alive; i++) {
        swaps();
        if (Math.random() < 0.22) { await wait(between(1.5, 2.5)); emit({ kind: "mev" }); }
        await wait(between(3, 5));
      }
      if (!alive) break;
      emit({ kind: "testing" });
      for (let i = 0; i < 2 && alive; i++) { await wait(between(3, 4.5)); swaps(); }
      await wait(between(2, 3));
      emit({ kind: "simulation", runs: Math.round(between(40, 220)), confidence: Math.round(between(58, 86)) });
      await wait(between(2.5, 4));
      if (Math.random() < 0.6) {
        emit({ kind: "rejected" });
      } else {
        emit({ kind: "canary" });
        for (let i = 0; i < 3 && alive; i++) { await wait(between(4, 6)); swaps(); }
        await wait(between(2, 4));
        emit(Math.random() < 0.7 ? { kind: "activated" } : { kind: "rollback" });
      }
      await wait(between(4, 6));
    }
  })();

  return () => {
    alive = false;
    clearInterval(blocks);
  };
}
