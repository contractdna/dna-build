// Test helpers: a Chromium to drive (PAGECHECK_CHROMIUM, else a system or Playwright-cache one) and a chain the way
// the engine hands it over: a state dump loaded into the check's own anvil.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { rpc, startAnvil } from "../src/util.ts";

export function chromiumPath(): string | undefined {
  if (process.env.PAGECHECK_CHROMIUM) return process.env.PAGECHECK_CHROMIUM;
  for (const p of ["/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"]) if (existsSync(p)) return p;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const d of readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const p = join(cache, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    if (existsSync(p)) return p;
  }
  return undefined;
}

export const GAME = "0x00000000000000000000000000000000000ca5e0";
export const FACTORY = "0x00000000000000000000000000000000000fac70";
/** Runtime code answering any call with one 32-byte word: 0 (the game: not paused, not retired) or 1 (isGame). */
export const WORD = (v: 0 | 1) => `0x60${v ? "01" : "00"}60005260206000f3`;
/** A factory whose every answer is the block timestamp (the clock test reads the chain's time through it). */
export const CLOCK = "0x4260005260206000f3";

/** A mainnet-like head (the engine starts the chain it dumps from the staging head: number, time, base fee, coinbase). */
export const LOOK = { number: 21_000_000, baseFee: "0x1a13b8600", coinbase: "0x95222290dd7278aa3ddd389cc1e1d165cc4bafe5" };
/** The engine's side, in short: a chain with the game and the factory, dumped; then the check's anvil loads the dump. */
export async function chain(factoryCode = WORD(1), gameCode = WORD(0)) {
  const dir = mkdtempSync(join(tmpdir(), "pc-genesis-"));
  writeFileSync(join(dir, "genesis.json"), JSON.stringify({ config: { chainId: 1 }, number: `0x${LOOK.number.toString(16)}`, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, gasLimit: "0x1c9c380", alloc: {} }));
  const a = await startAnvil(undefined, undefined, ["--init", join(dir, "genesis.json")]);
  let dump: string;
  try {
    await rpc(a.url, "anvil_setCode", [GAME, gameCode]);
    await rpc(a.url, "anvil_setCode", [FACTORY, factoryCode]);
    dump = await rpc<string>(a.url, "anvil_dumpState");
  } finally {
    a.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  return startAnvil(dump, { baseFee: LOOK.baseFee, coinbase: LOOK.coinbase });
}
