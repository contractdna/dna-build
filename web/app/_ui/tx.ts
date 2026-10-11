"use client";
// What a game page may use to reach the chain (the Sequencer's pages import only this, react, next/link, next/image,
// the shared UI and their own files):
//  - useGame(): the server's snapshot of the game (its zero-argument views, funded / paused / retired), so a visitor
//    without a wallet still sees the game;
//  - play(game, fn, args): one transaction to this game through the page's wallet guard (guard.ts), value 0;
//  - read(game, fn, args): one view call through the wallet (per-player reads).
//  - hashSecret(secret): keccak256 of a 32-byte secret, computed here (a commitment never sends its secret to a node).
// Writes go only through the guard, which re-checks everything; the checks here (the code at the address is the
// code this page was built for) come first so a visitor sees a plain reason.
import { createContext, createElement, type ReactNode, useContext, useEffect, useState } from "react";
import { type Abi, decodeFunctionResult, encodeFunctionData, keccak256 } from "viem";
import { guardReady, guardStop } from "./guard";

export type GameJson = { slug: string; title: string; chainId: 1; address: `0x${string}`; codehash: `0x${string}`; abi: unknown[] };
export type Snapshot = { slug: string; title: string; views: Record<string, string>; isGame: boolean; paused: boolean; retired: boolean; freeBalanceWei: string; at: number };
type Eip1193 = { isDNAGuard?: boolean; request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
export type Result<T> = { ok: true; value: T } | { ok: false; why: string };

const Ctx = createContext<Snapshot | null>(null);
/** The layout's snapshot of this game (null when the chain could not be read). */
export const useGame = () => useContext(Ctx);

/** Wraps a game page. The game's own code never runs on the server and never without the guard: until the page is
 *  mounted in the browser, and only behind a working guard, only the snapshot's title and state are shown. The game is
 *  unmounted the moment the guard reports a pull or a pause, and comes back after a pause only. */
export function GameRoot({ snapshot, title, children }: { snapshot: Snapshot | null; title: string; children: ReactNode }) {
  const [phase, setPhase] = useState<"server" | "unsafe" | "ready">("server");
  const [stop, setStop] = useState<{ why: string; pulled: boolean } | null>(null);
  useEffect(() => {
    setPhase(guardReady(window) ? "ready" : "unsafe");
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ why?: string; pulled?: boolean }>).detail;
      setStop((s) => (s?.pulled ? s : { why: String(d?.why ?? "this game is paused"), pulled: !!d?.pulled }));
    };
    const back = () => setStop((s) => (s?.pulled ? s : null));
    window.addEventListener("dna:killed", on);
    window.addEventListener("dna:resumed", back);
    // a pull or pause announced before this effect ran (the guard's first check can beat hydration)
    const now = guardStop(window);
    if (now) setStop(now);
    return () => { window.removeEventListener("dna:killed", on); window.removeEventListener("dna:resumed", back); };
  }, []);
  const state = !snapshot ? "Reading the game from the chain..." : snapshot.retired ? "Retired. Anything you won stays claimable." : snapshot.paused ? "Paused." : "";
  const head = createElement("h1", { key: "t" }, title);
  if (phase === "server") return createElement("main", null, head, state ? createElement("p", { key: "s" }, state) : null);
  if (phase === "unsafe") return createElement("main", null, head, createElement("p", { role: "status" }, "This page can't reach your wallet safely, so the game is not loaded. Use another browser or wallet."));
  if (stop) return createElement("main", null, head, createElement("p", { role: "status" }, stop.pulled ? `This game was pulled: ${stop.why}.` : `This game is paused: ${stop.why}.`));
  // data-dna-game: the enclave's page check requires it (a game that never mounts would show it nothing to check)
  return createElement(Ctx.Provider, { value: snapshot }, createElement("div", { "data-dna-game": "", style: { display: "contents" } }, children));
}

const wallet = (): Eip1193 | null => {
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  return eth && eth.isDNAGuard === true ? eth : null;
};
const why = (e: unknown) => String((e as { message?: string })?.message ?? e).slice(0, 200);

/** One transaction to the game: `fn(args)`, no value. */
export async function play(game: GameJson, fn: string, args: unknown[] = []): Promise<Result<`0x${string}`>> {
  const eth = wallet();
  if (!eth) return { ok: false, why: "No wallet found on this page." };
  try {
    const data = encodeFunctionData({ abi: game.abi as Abi, functionName: fn, args });
    const code = (await eth.request({ method: "eth_getCode", params: [game.address, "latest"] })) as `0x${string}`;
    if (!code || code === "0x" || keccak256(code) !== game.codehash) return { ok: false, why: "The game's contract is not the one this page was built for." };
    const [from] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    const hash = (await eth.request({ method: "eth_sendTransaction", params: [{ from, to: game.address, data, value: "0x0" }] })) as `0x${string}`;
    return { ok: true, value: hash };
  } catch (e) {
    return { ok: false, why: why(e) };
  }
}

/** keccak256 of a 32-byte secret (0x and 64 hex digits), as a game's `keccak256(abi.encode(secret))`; null if malformed. */
export const hashSecret = (secret: string): `0x${string}` | null => (/^0x[0-9a-fA-F]{64}$/.test(secret) ? keccak256(secret as `0x${string}`) : null);

/** One view call through the wallet: `fn(args)` on the game. */
export async function read<T = unknown>(game: GameJson, fn: string, args: unknown[] = []): Promise<Result<T>> {
  const eth = wallet();
  if (!eth) return { ok: false, why: "No wallet found on this page." };
  try {
    const data = encodeFunctionData({ abi: game.abi as Abi, functionName: fn, args });
    const out = (await eth.request({ method: "eth_call", params: [{ to: game.address, data }, "latest"] })) as `0x${string}`;
    return { ok: true, value: decodeFunctionResult({ abi: game.abi as Abi, functionName: fn, data: out }) as T };
  } catch (e) {
    return { ok: false, why: why(e) };
  }
}
