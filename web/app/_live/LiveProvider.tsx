"use client";

import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from "react";
import { LIVE } from "../_data/flags";
import { blankCore, initialCore, reduce, startMockFeed, type Core, type FeedEvent } from "./feed";
import { LabSound } from "./sound";

type Listener = (e: FeedEvent) => void;
type Live = {
  core: Core;
  emit: (e: FeedEvent) => void;
  subscribe: (fn: Listener) => () => void;
  soundOn: boolean;
  toggleSound: () => Promise<void>;
  stale: boolean; // LIVE only: the indexer has not completed a pass in 5 minutes (/api/health)
  streaming: boolean; // LIVE only: /api/stream is open (false before it opens and while a refused stream waits to retry)
  ca?: string; // LIVE only: DNAToken address from the deployment manifest
};

const LiveContext = createContext<Live | null>(null);

// the sound choice survives visits; storage can throw (private mode, blocked site data): then it is simply not remembered
const SOUND_KEY = "dna.sound";
const readSound = () => { try { return localStorage.getItem(SOUND_KEY); } catch { return null; } };
const saveSound = (v: "on" | "off") => { try { localStorage.setItem(SOUND_KEY, v); } catch { /* not remembered */ } };

export function useLive(): Live {
  const v = useContext(LiveContext);
  if (!v) throw new Error("useLive must be used inside <LiveProvider>");
  return v;
}

const CUES: Partial<Record<FeedEvent["kind"], Parameters<LabSound["play"]>[0]>> = {
  swaps: "swaps", mev: "mev", testing: "testing", simulation: "simulation", rejected: "rejected",
  canary: "canary", activated: "activated", rollback: "rollback", epoch: "epoch",
};

/**
 * LIVE: the indexer's SSE stream. EventSource reconnects by itself after a dropped connection (Last-Event-ID replay);
 * replays are deduped by id. A refused or failed response (429/503 connection caps, 5xx) closes it for good, so then
 * open a fresh one after 20–40 s (jittered: refused clients must not come back in one wave; it gets a full snapshot).
 * `onOpen` reports open / closed for good; a dropped connection that EventSource is already retrying still counts as open.
 */
function startLiveFeed(emit: (e: FeedEvent) => void, onOpen: (open: boolean) => void): () => void {
  const seen = new Set<string>();
  let es: EventSource;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const open = () => {
    es = new EventSource("/api/stream");
    es.onopen = () => onOpen(true);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as FeedEvent;
      if (e.id) {
        if (seen.has(e.id)) return;
        seen.add(e.id);
        if (seen.size > 1000) seen.delete(seen.values().next().value!); // oldest first (insertion order)
      }
      emit(e);
    };
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED || stopped) return;
      onOpen(false);
      retry = setTimeout(open, 20_000 + Math.random() * 20_000);
    };
  };
  open();
  return () => { stopped = true; clearTimeout(retry); es.close(); };
}

/**
 * Site-wide live state: one event stream (mock feed, or the indexer's SSE when LIVE), the CORE snapshot it reduces
 * into, and the lab sound. Pages read `core`; the homepage specimen subscribes to raw events to react.
 * `initial`: the server-rendered chain-backed core (LIVE), so the first paint already shows real numbers.
 */
export function LiveProvider({ children, initial, ca }: { children: React.ReactNode; initial?: Partial<Core>; ca?: string }) {
  const [core, dispatch] = useReducer(reduce, initial, (i) => ({ ...(LIVE ? blankCore : initialCore), ...i }));
  const listeners = useRef(new Set<Listener>());
  const sound = useRef<LabSound | null>(null);
  const [soundOn, setSoundOn] = useState(true); // the visitor's choice: on unless they turned it off (remembered)
  const want = useRef(true);
  const soundOnRef = useRef(false); // actually audible: the browser has let the audio start
  const [stale, setStale] = useState(false);
  const [streaming, setStreaming] = useState(false);

  const emit = useCallback((e: FeedEvent) => {
    dispatch(e);
    const cue = CUES[e.kind];
    if (cue && soundOnRef.current) sound.current?.play(cue, e.kind === "swaps" ? e.n : 0);
    if (e.kind === "rollback") setTimeout(() => dispatch({ kind: "recovered" }), 2600);
    listeners.current.forEach((fn) => fn(e));
  }, []);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  const toggleSound = useCallback(async () => {
    if (want.current) {
      want.current = false; soundOnRef.current = false; setSoundOn(false); saveSound("off");
      sound.current?.disable();
    } else {
      want.current = true; setSoundOn(true); saveSound("on");
      sound.current ??= new LabSound();
      await sound.current.enable();
      soundOnRef.current = sound.current.running;
    }
  }, []);

  // Sound is on by default, but browsers hold audio back until a user gesture: start it on the first one, no prompt.
  // Scroll and wheel are listened for too, but they never count as a gesture, so on them we wait (no AudioContext is
  // made before the browser would allow it). The sound button handles its own click.
  useEffect(() => {
    if (readSound() === "off") { want.current = false; setSoundOn(false); return; }
    const EVENTS = ["pointerdown", "keydown", "touchstart", "touchend", "click", "wheel", "scroll"];
    let trying = false;
    const stop = () => EVENTS.forEach((e) => removeEventListener(e, start, true));
    function start(e: Event) {
      if (!want.current) return stop();
      if (trying || (e.target instanceof Element && e.target.closest("[data-sound-toggle]"))) return;
      const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
      if (ua && !ua.hasBeenActive) return;
      trying = true;
      sound.current ??= new LabSound();
      void sound.current.enable().catch(() => {});
      // the context resumes asynchronously; if the browser still says no, keep listening for a real gesture
      setTimeout(() => {
        trying = false;
        if (!sound.current?.running) return;
        stop();
        soundOnRef.current = want.current;
        if (!want.current) sound.current.disable(); // turned off while it was starting
      }, 400);
    }
    EVENTS.forEach((e) => addEventListener(e, start, { capture: true, passive: true }));
    return stop;
  }, []);

  // ?nofeed isolates reactions for review
  useEffect(() => (location.search.includes("nofeed") ? undefined : (LIVE ? startLiveFeed(emit, setStreaming) : startMockFeed(emit))), [emit]);

  useEffect(() => {
    if (!LIVE) return;
    const check = () => fetch("/api/health").then((r) => r.json()).then((h) => setStale(!!h.stale)).catch(() => setStale(true));
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, []);

  return <LiveContext.Provider value={{ core, emit, subscribe, soundOn, toggleSound, stale, streaming, ca }}>{children}</LiveContext.Provider>;
}
