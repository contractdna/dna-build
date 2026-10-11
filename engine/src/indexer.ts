// DNA indexer. Two tiers per tick:
//  - finalized: every DNA log up to the `finalized` block → chain_log (+ cursor) in one transaction per window, then
//    a state snapshot read at that block. Only finalized data is persisted, so there is nothing to roll back.
//  - head (HEAD_TAG, default latest): block number + swap count → NOTIFY only, never persisted.
// Env: DATABASE_URL, RPC_URL (comma-separated → fallback order), CHAIN_ID, POLL_MS, LOG_WINDOW, HEAD_TAG.
// `--once`: one tick, then exit (tests). Exit codes: 1 = tick failed under --once, 2 = reorg below the cursor.
// cursor.checked_at = the last COMPLETE pass (logs + snapshot): a pass that keeps failing leaves it to go stale (5 min →
// /api/health stale, engine "Indexer stale" alert). Imported (tests) it only exports finalizedTier; run, it loops.
import { readdirSync, readFileSync } from "node:fs";
import { createPublicClient, fallback, http, keccak256, parseEventLogs, type Address, type BlockTag, type Log } from "viem";
import * as abi from "./abi.ts";
import { lock, migrate, sql } from "./db.ts";
import { feedPayload, gameLogs, isRangeError, jsonSafe, logRow, nextRange, notifiable, type Row } from "./lib.ts";

import type { Deployment } from "./config.ts";

const env = process.env;
const CHAIN_ID = Number(env.CHAIN_ID ?? 31337);
const POLL_MS = Number(env.POLL_MS ?? 12_000);
const LOG_WINDOW = BigInt(env.LOG_WINDOW ?? 10_000);
const HEAD_TAG = (env.HEAD_TAG ?? "latest") as BlockTag;
const ONCE = process.argv.includes("--once");

// DEPLOYMENT_FILE: only for scripts/rehearsal.sh (a mainnet fork must not overwrite the committed deployments/1.json)
const d: Deployment = JSON.parse(readFileSync(env.DEPLOYMENT_FILE ?? new URL(`../deployments/${CHAIN_ID}.json`, import.meta.url), "utf8"));
if (d.chainId !== CHAIN_ID || /^0x0+$/.test(d.registry)) throw new Error(`deployments/${CHAIN_ID}.json is a placeholder: fill it after launch`);

const client = createPublicClient({
  transport: fallback((env.RPC_URL ?? "http://127.0.0.1:8545").split(",").map((u) => http(u.trim(), { retryCount: 2 }))),
});

const swapEvent = abi.poolManagerAbi.find((x) => x.type === "event" && x.name === "Swap")!;
const transferEvent = abi.tokenAbi.find((x) => x.type === "event" && x.name === "Transfer")!;
// one address-array query (no event filter) decoded with the merged ABI: viem can't combine `events` with `args`
// IdeaMarket + BountyBoard (when deployed): their events feed the engine's idea research, the web and the XP view;
// GamePot, ConvictionVault, MutationBoard (when deployed): the game keepers, the agent's game tasks, /play and X
const optional = [d.ideaMarket, d.bountyBoard, d.gamePot, d.convictionVault, d.mutationBoard].filter((a): a is Address => !!a);
const coreAddresses = [d.hook, d.registry, d.feeVault, d.buybackBurn, d.liquidityVault, d.platformRevenue, ...optional];
const coreAbi = [...abi.registryAbi, ...abi.hookAbi, ...abi.feeVaultAbi, ...abi.buybackBurnAbi, ...abi.liquidityVaultAbi, ...abi.platformRevenueAbi, ...abi.ideaMarketAbi, ...abi.bountyBoardAbi,
  ...abi.gamePotAbi, ...abi.convictionVaultAbi, ...abi.mutationBoardAbi].filter((x) => x.type === "event");

// The Sequencer's games (src/lib.ts gameLogs), when a GameFactory is deployed: games already indexed come from chain_log.
const knownGames = async () => (await sql<{ game: Address }[]>`select distinct lower(args->>'game') as game from chain_log where event = 'GameDeployed' and address = ${d.gameFactory!.toLowerCase()}`).map((r) => r.game);

// FeeTaken ↔ Swap pairing (by tx hash) is done by the engine (src/observe.ts `pair`), from these rows.
async function fetchLogs(fromBlock: bigint, toBlock: bigint) {
  const [swaps, burns, core, games] = await Promise.all([
    client.getLogs({ address: d.poolManager, event: swapEvent, args: { id: d.poolId }, fromBlock, toBlock }),
    // every DNA Transfer (burns are the ones to 0x0): the holder jackpot's balances are rebuilt from them
    client.getLogs({ address: d.token, event: transferEvent, fromBlock, toBlock }),
    client.getLogs({ address: coreAddresses, fromBlock, toBlock }),
    d.gameFactory ? gameLogs(d.gameFactory, fromBlock, toBlock, (a) => client.getLogs(a), knownGames) : [],
  ]);
  return [...swaps, ...burns, ...parseEventLogs({ abi: coreAbi, logs: core }), ...games] as (Log & { eventName: string; args: Record<string, unknown> })[];
}

async function toRows(logs: Awaited<ReturnType<typeof fetchLogs>>): Promise<Row[]> {
  // simplification: one getBlock per distinct block when the RPC omits log.blockTimestamp; batch if backfills get slow
  const times = new Map<bigint, bigint>();
  for (const l of logs) if (l.blockTimestamp) times.set(l.blockNumber!, l.blockTimestamp);
  const missing = [...new Set(logs.map((l) => l.blockNumber!))].filter((n) => !times.has(n));
  await Promise.all(missing.map(async (n) => times.set(n, (await client.getBlock({ blockNumber: n })).timestamp)));
  return logs
    .map((l) => logRow(l, new Date(Number(times.get(l.blockNumber!)) * 1000)))
    .sort((a, b) => a.block - b.block || a.log_index - b.log_index);
}

// last finalized block fully ingested + snapshotted by this process. Mainnet `finalized` moves once per epoch (~6.4 min,
// ~1 in 32 ticks): an unchanged finalized block has the same logs and the same state, so the tick only refreshes
// checked_at (1 RPC call instead of ~19; see docs/CAPACITY.md). A lower finalized (a lagging fallback node) is treated
// the same way: never re-snapshot an older block.
let doneFin: bigint | undefined;
let snapFails = 0; // consecutive snapshot failures at or above startBlock

export async function finalizedTier() {
  const fin = await client.getBlock({ blockTag: "finalized" });
  if (doneFin !== undefined && fin.number <= doneFin) {
    await sql`update cursor set checked_at = now()`;
    return;
  }
  const [cur] = await sql<{ block: string; hash: string }[]>`select block, hash from cursor`;
  if (cur && (await client.getBlock({ blockNumber: BigInt(cur.block) })).hash !== cur.hash) {
    console.error(`FATAL: block ${cur.block} no longer has hash ${cur.hash} (reorg past finality). Needs a human.`);
    process.exit(2);
  }
  let from = cur ? BigInt(cur.block) + 1n : BigInt(d.startBlock);
  let window = LOG_WINDOW;
  let fed = false; // a feed event went out: core counters (proposals, rollbacks, epoch) changed too
  const tip = Number(fin.timestamp) * 1000; // freshness vs the finalized tip, not the wall clock (~13 min behind)
  while (from <= fin.number) {
    const r = nextRange(from, fin.number, window);
    let rows: Row[];
    try {
      rows = await toRows(await fetchLogs(r.from, r.to));
    } catch (e) {
      if (isRangeError(e) && window > 1n) { window /= 2n; continue; } // known size/range limit: halve and retry now
      throw e; // anything else: the next tick retries from the same cursor
    }
    const end = r.to === fin.number ? fin : await client.getBlock({ blockNumber: r.to });
    await sql.begin(async (tx) => {
      await lock(tx);
      if (rows.length) await tx`insert into chain_log ${tx(rows.map((x) => ({ ...x, args: tx.json(x.args as never) })))} on conflict do nothing`;
      await tx`insert into cursor (id, block, hash, at) values (1, ${Number(r.to)}, ${end.hash}, ${new Date(Number(end.timestamp) * 1000)})
        on conflict (id) do update set block = excluded.block, hash = excluded.hash, at = excluded.at
        where cursor.block < excluded.block`;
      for (const row of rows) {
        if (!notifiable(row, tip)) continue;
        await tx`select pg_notify('feed', ${feedPayload(row)})`;
        fed = true;
      }
    });
    if (rows.length) console.log(`finalized ${r.from}-${r.to}: ${rows.length} logs`);
    from = r.to + 1n;
  }
  if (!(await snapshot(fin.number, fin.timestamp, fed))) {
    // a snapshot that keeps failing must not be silent: fail the tick (log + backoff) and let checked_at go stale
    if (++snapFails >= 3) throw new Error(`state snapshot at finalized ${fin.number} failed ${snapFails} ticks in a row`);
    return;
  }
  snapFails = 0;
  doneFin = fin.number;
  await sql`update cursor set checked_at = now()`;
}

/** Chain state at the finalized block → state('chain'); NOTIFY core when it changed. False = not taken (retry). */
async function snapshot(blockNumber: bigint, timestamp: bigint, force: boolean) {
  if (blockNumber < BigInt(d.startBlock)) return true;
  const c = (address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) => ({ address, abi, functionName, args });
  const claims = (owner: Address) => c(d.poolManager, abi.poolManagerAbi, "balanceOf", [owner, 0n]);
  let v: unknown[];
  try {
    // 14 reads → ONE eth_call (deployless Multicall3: no deployed contract needed, works on anvil too); any failed
    // read throws, exactly like the Promise.all of single reads it replaces
    const [reads, safeEth] = await Promise.all([
      client.multicall({
        deployless: true, allowFailure: false, blockNumber,
        contracts: [
          c(d.registry, abi.registryAbi, "level"), c(d.registry, abi.registryAbi, "agentPaused"),
          c(d.registry, abi.registryAbi, "lastRollbackBlock"), c(d.registry, abi.registryAbi, "route"),
          c(d.registry, abi.registryAbi, "splitRoute"), c(d.feeVault, abi.feeVaultAbi, "currentSplit"),
          c(d.hook, abi.hookAbi, "observables"), c(d.hook, abi.hookAbi, "breaker"),
          claims(d.feeVault), claims(d.buybackBurn), claims(d.liquidityVault), claims(d.platformRevenue),
          c(d.liquidityVault, abi.liquidityVaultAbi, "positions"), c(d.token, abi.tokenAbi, "totalSupply"),
          ...gameReads().map(([a, x, f, args]) => c(a, x, f, args)),
        ] as never,
      }) as Promise<unknown[]>,
      client.getBalance({ address: d.safe, blockNumber }),
    ]);
    v = [...reads, safeEth];
  } catch (e) {
    console.warn("snapshot failed (RPC, or contracts not deployed at this block yet?)", (e as Error).message.split("\n")[0]);
    return false;
  }
  const [level, agentPaused, lastRollbackBlock, route, split, currentSplit, observables, breaker, fee, bb, lp, platform, lpPositions, totalSupply, ...rest] = v;
  const safeEth = rest.pop();
  const value = jsonSafe({
    level, agentPaused, lastRollbackBlock, route, split, currentSplit, observables, breaker, lpPositions, totalSupply, safeEth,
    claims: { feeVault: fee, buybackBurn: bb, liquidityVault: lp, platformRevenue: platform },
    ...(rest.length ? { game: gameState(rest) } : {}),
  }) as Record<string, unknown>;
  // jsonb equality (key order is normalized in jsonb, so comparing JSON strings would always differ)
  const [prev] = await sql<{ same: boolean }[]>`select value = ${sql.json(value as never)} as same from state where key = 'chain'`;
  const changed = force || !prev?.same;
  await sql.begin(async (tx) => {
    await tx`insert into state (key, block, value) values ('chain', ${Number(blockNumber)}, ${tx.json(value as never)})
      on conflict (key) do update set block = excluded.block, value = excluded.value, updated_at = now()`;
    if (changed) await tx`select pg_notify('feed', ${JSON.stringify({ t: "core", block: Number(blockNumber), at: new Date(Number(timestamp) * 1000).toISOString() })})`;
  });
  return true;
}

/** The game layer's state, read in the same multicall (nothing extra while it isn't deployed). */
const GAME_POT = ["jackpotPot", "ideaReserve", "queuedRewards", "owedTotal", "drawInterval", "draw", "drawCount", "pendingInterval", "stalledSince", "subId", "windowId", "windowStart", "windowEnd", "lastDrawnWindow"] as const;
const GAME_VAULT = ["totalLocked", "count"] as const;
const GAME_BOARD = ["ballotCount", "lastBallotAt", "mysteryCount", "pendingMystery"] as const;
type Read = [Address, readonly unknown[], string, unknown[]?];
function gameReads(): Read[] {
  return [
    ...(d.gamePot ? GAME_POT.map((f) => [d.gamePot!, abi.gamePotAbi, f] as Read) : []),
    ...(d.convictionVault ? GAME_VAULT.map((f) => [d.convictionVault!, abi.convictionVaultAbi, f] as Read) : []),
    ...(d.mutationBoard ? GAME_BOARD.map((f) => [d.mutationBoard!, abi.mutationBoardAbi, f] as Read) : []),
  ];
}
/** Multicall results (in gameReads order) → {pot, vault, board}; tuples become named objects. */
export function gameState(r: unknown[]) {
  const take = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, r.shift()])) as Record<K, unknown>;
  const pot = d.gamePot ? (take(GAME_POT) as Record<string, unknown>) : undefined;
  if (pot) {
    const [window, listEta, requestedAt, fulfilledAt, prize, reqId, root, totalTickets, rand] = pot.draw as unknown[];
    pot.draw = { window, eta: listEta, requestedAt, fulfilledAt, prize, reqId, root, totalTickets, rand };
    const [value, eta2, by] = pot.pendingInterval as unknown[];
    pot.pendingInterval = { value, eta: eta2, proposer: by };
  }
  return { pot, vault: d.convictionVault ? take(GAME_VAULT) : undefined, board: d.mutationBoard ? take(GAME_BOARD) : undefined };
}

let lastHead: bigint | undefined;

/** Head tier: newest block + swaps since the last tick. Ephemeral (NOTIFY only); finalized ingestion persists swaps. */
async function headTier() {
  const head = await client.getBlock({ blockTag: HEAD_TAG });
  const n = head.number!;
  if (lastHead !== undefined && n <= lastHead) return;
  const from = lastHead === undefined ? n : lastHead + 1n > n - 100n ? lastHead + 1n : n - 100n; // ≤ 100 blocks after a stall
  const swaps = await client.getLogs({ address: d.poolManager, event: swapEvent, args: { id: d.poolId }, fromBlock: from, toBlock: n });
  lastHead = n;
  const at = new Date(Number(head.timestamp) * 1000).toISOString();
  await sql.begin(async (tx) => {
    await tx`insert into state (key, block, value) values ('head', ${Number(n)}, ${tx.json({ block: Number(n), at })})
      on conflict (key) do update set block = excluded.block, value = excluded.value, updated_at = now()`;
    await tx`select pg_notify('feed', ${JSON.stringify({ t: "head", block: Number(n), at, swaps: swaps.length })})`;
  });
}

/** IdeaMarket's round clock: START = roundEnd(0) − ROUND_LENGTH, both from the contract. */
export async function ideaMarketClock(address: Address, c: Pick<typeof client, "readContract"> = client) {
  const [end0, len] = await Promise.all([
    c.readContract({ address, abi: abi.ideaMarketAbi, functionName: "roundEnd", args: [0n] }),
    c.readContract({ address, abi: abi.ideaMarketAbi, functionName: "ROUND_LENGTH" }),
  ]) as [bigint, bigint];
  return { start: new Date(Number(end0 - len) * 1000).toISOString(), roundLength: Number(len) };
}

/** Deployment + manifests (keyed by specHash = keccak256 of the manifest file bytes) for the web. */
async function loadStatic() {
  const dir = new URL("../modules/", import.meta.url);
  const manifests: Record<string, unknown> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const bytes = readFileSync(new URL(f, dir));
    manifests[keccak256(bytes)] = JSON.parse(bytes.toString("utf8"));
  }
  // IdeaMarket START (round r runs [START + L·r, START + L·(r+1)), L = ROUND_LENGTH read from the contract): the web's
  // round clocks
  const im = d.ideaMarket ? await ideaMarketClock(d.ideaMarket) : null;
  for (const [key, value] of [["deployment", d], ["manifests", manifests], ...(im ? [["ideaMarket", im] as const] : [])] as const) {
    await sql`insert into state (key, block, value) values (${key}, 0, ${sql.json(value as never)})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }
}

// run as a script (not imported by a test). import.meta.main is Node ≥ 24.2; this works on every Node 24
if (import.meta.filename === process.argv[1]) await main();

async function main() {
  await migrate();
  await loadStatic();
  let failures = 0;
  for (;;) {
    try {
      await finalizedTier();
      await headTier();
      failures = 0;
    } catch (e) {
      // non-range RPC/DB errors: retried from the same cursor, backing off 2×, 4×, … up to 16× POLL_MS
      console.error(`tick failed (${++failures} in a row):`, e);
      if (ONCE) process.exit(1);
    }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, POLL_MS * Math.min(2 ** failures, 16)));
  }
  await sql.end();
}
