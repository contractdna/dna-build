// Server side of the play origin's game pages: which game a request is for (its game.json) and the
// snapshot a visitor without a wallet sees (the game's zero-argument views and the kit's state, read through a
// server-side RPC, so the page itself never needs the network).
import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Abi, createPublicClient, getAddress, http } from "viem";
import { mainnet } from "viem/chains";
import type { GameJson, Snapshot } from "../_ui/tx.ts";
import { SLUG } from "../../security.ts";

/** The GameFactory (games' isGame); unset: the zero address, so the wallet guard refuses every transaction. */
export const FACTORY = (process.env.GAME_FACTORY ?? `0x${"0".repeat(40)}`) as `0x${string}`;

/** A game's game.json, or null (bad slug, no folder, bad file). */
export function loadGame(slug: string, root = process.cwd()): GameJson | null {
  if (!SLUG.test(slug)) return null;
  try {
    const g = JSON.parse(readFileSync(join(root, "app", "g", slug, "game.json"), "utf8")) as GameJson;
    return g.slug === slug && g.chainId === 1 ? { ...g, address: getAddress(g.address) } : null;
  } catch {
    return null;
  }
}

type AbiFn = { type: string; name?: string; inputs?: unknown[]; outputs?: { type: string }[]; stateMutability?: string };
/** The views a snapshot reads: no inputs, one plain output (numbers, booleans, addresses, short bytes). */
export const zeroArgViews = (abi: unknown[]) =>
  (abi as AbiFn[]).filter((f) => f.type === "function" && (f.stateMutability === "view" || f.stateMutability === "pure") && (f.inputs ?? []).length === 0
    && (f.outputs ?? []).length === 1 && /^(u?int\d*|bool|address|bytes\d+)$/.test(f.outputs![0].type)).map((f) => f.name!).slice(0, 24);

const KIT = [
  { type: "function", name: "paused", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "retired", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "freeBalance", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;
const IS_GAME = [{ type: "function", name: "isGame", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" }] as const;

const memo = new Map<string, { at: number; p: Promise<Snapshot | null> }>();
/** The game as the chain has it, read at most once per 5 s per game per server (the HTML is CDN-cached 5 s too). */
export function snapshot(g: GameJson, now = Date.now()): Promise<Snapshot | null> {
  const m = memo.get(g.slug);
  if (m && now - m.at < 5_000) return m.p;
  const p = readSnapshot(g);
  memo.set(g.slug, { at: now, p });
  return p;
}

/** The game as the chain has it now (PLAY_RPC_URL, server only); null when it can't be read. */
async function readSnapshot(g: GameJson): Promise<Snapshot | null> {
  const url = process.env.PLAY_RPC_URL;
  if (!url) return null;
  const c = createPublicClient({ chain: mainnet, transport: http(url, { timeout: 3_000, retryCount: 1 }) });
  try {
    const [isGame, paused, retired, free] = await Promise.all([
      c.readContract({ address: FACTORY, abi: IS_GAME, functionName: "isGame", args: [g.address] }),
      c.readContract({ address: g.address, abi: KIT, functionName: "paused" }),
      c.readContract({ address: g.address, abi: KIT, functionName: "retired" }),
      c.readContract({ address: g.address, abi: KIT, functionName: "freeBalance" }),
    ]);
    const views: Record<string, string> = {};
    await Promise.all(zeroArgViews(g.abi).map(async (n) => {
      try { views[n] = String(await c.readContract({ address: g.address, abi: g.abi as Abi, functionName: n })); } catch { /* left out */ }
    }));
    return { slug: g.slug, title: g.title, views, isGame, paused, retired, freeBalanceWei: String(free), at: Date.now() };
  } catch {
    return null;
  }
}
