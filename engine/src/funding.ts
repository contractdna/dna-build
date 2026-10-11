// Game funding through the Safe's Roles → Delay path (contracts/docs/funding.md). The funder key (dna/funder) may only
// queue GameFunder.fund(game, amount) through Roles; Delay holds it 1 h (the Safe can veto) and then anyone executes
// it. Delay is strictly FIFO: a queued fund that reverts at execution blocks every later one until it expires (24 h)
// or the Safe skips it. So nothing is queued that could revert: every cap is checked with what is already queued and
// not yet executed counted in, then the exact call is run from the Safe (eth_call at the agreed block) first, and an
// amount of 0 or below MIN_FUND is never queued.
// Amounts: a small start at ship (the week's budget spread over the days left in it, at most the per-game cap) and
// top-ups once real players arrive (5 new distinct players since the last executed fund, each at most a third of the
// per-game cap). No room ⇒ the game ships "awaiting funding" and is retried hourly. Every queued fund is a signed
// `fund` record {game, amount, delayNonce, tx}; the watchdog matches Delay's TransactionAdded against them.
import { type Address, decodeEventLog, decodeFunctionData, encodeFunctionData, getAbiItem, type Hex, parseAbi, type PublicClient, stringToHex } from "viem";
import * as abi from "./abi.ts";
import { agreedHead, readAgreed } from "./chainref.ts";
import { d } from "./config.ts";
import { append } from "./log.ts";
import { trustedDocs } from "./records.ts";
import { getLogsChunked } from "./ticket-source.ts";
import { alert } from "./telegram.ts";
import { addressOf, pub, ROLES_ABI, send } from "./tx.ts";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
export const MIN_FUND = 10n ** 16n; // 0.01 ETH
export const TOPUP_PLAYERS = 5;
/** Roles v2 role key of the funding path (FundingSetup.s.sol ROLE_KEY = "dna-game-funder"). */
export const ROLE_KEY = stringToHex("dna-game-funder", { size: 32 });

const FUNDER_ABI = abi.gameFunderAbi;
const FUNDED = getAbiItem({ abi: abi.gameFunderAbi, name: "Funded" });
/** Zodiac Delay 1.1.1 (not built here: contracts/script/FundingSetup.s.sol pins its mastercopy by codehash). */
export const DELAY_ABI = parseAbi([
  "function txNonce() view returns (uint256)",
  "function queueNonce() view returns (uint256)",
  "function txCooldown() view returns (uint256)",
  "function txExpiration() view returns (uint256)",
  "function txCreatedAt(uint256 nonce) view returns (uint256)",
  "function txHash(uint256 nonce) view returns (bytes32)",
  "function skipExpired()",
  "function executeNextTx(address to, uint256 value, bytes data, uint8 operation)",
  "event TransactionAdded(uint256 indexed queueNonce, bytes32 indexed txHash, address to, uint256 value, bytes data, uint8 operation)",
]);

// ---------------------------------------------------------------- pure rules

/** What the amounts and the room depend on (all wei; times in ms). `pending`: our funds queued in Delay and not yet
 *  executed (Delay nonce ≥ txNonce). `oldestSpendAt`: the oldest GameFunder spend still inside the rolling week. */
export type FundState = {
  weeklyBudget: bigint; perGameCap: bigint; spentInWindow: bigint; balance: bigint; oldestSpendAt?: number;
  funded: Record<string, bigint>; pending: { game: string; amount: bigint }[];
};
const key = (a: string) => a.toLowerCase();
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
export const pendingFor = (s: FundState, game: string) => sum(s.pending.filter((p) => key(p.game) === key(game)).map((p) => p.amount));
export const pendingAll = (s: FundState) => sum(s.pending.map((p) => p.amount));
/** Days left in the rolling week (at least 1): until the oldest counted spend leaves it; 7 when nothing is counted. */
export const daysLeftInWeek = (s: FundState, now: number) => (s.oldestSpendAt === undefined ? 7 : Math.max(1, Math.ceil((s.oldestSpendAt + WEEK - now) / DAY)));

/** The amount to queue now: a start (at ship) or a top-up (after new players). 0n = nothing (below MIN_FUND). */
export function fundAmount(s: FundState, game: string, now: number, kind: "start" | "topup"): bigint {
  const left = s.weeklyBudget - s.spentInWindow - pendingAll(s);
  const perDay = left > 0n ? left / BigInt(daysLeftInWeek(s, now)) : 0n;
  const room = s.perGameCap - (s.funded[key(game)] ?? 0n) - pendingFor(s, game);
  const a = min(kind === "start" ? s.perGameCap : s.perGameCap / 3n, room, perDay);
  return a >= MIN_FUND ? a : 0n;
}

/** Why queuing fund(game, amount) could revert at execution (with what is queued counted in), or null. */
export function fundRoom(s: FundState, game: string, amount: bigint, g: { isGame: boolean; live: boolean }): string | null {
  if (amount <= 0n) return "zero amount";
  if (amount < MIN_FUND) return "below MIN_FUND";
  if (!g.isGame) return "not a game of the factory";
  if (!g.live) return "the game is retired";
  if ((s.funded[key(game)] ?? 0n) + pendingFor(s, game) + amount > s.perGameCap) return "over the per-game cap";
  if (s.spentInWindow + pendingAll(s) + amount > s.weeklyBudget) return "over the weekly budget";
  if (s.balance - pendingAll(s) < amount) return "GameFunder's balance is short";
  return null;
}

/** A top-up is due: enough new distinct players since the last executed fund and nothing queued for the game. */
export const topupDue = (s: FundState, game: string, newPlayers: number) => newPlayers >= TOPUP_PLAYERS && pendingFor(s, game) === 0n;

/** Delay's queue head: an entry past cooldown + expiration jams nothing but must be skipped before ours can follow. */
export type DelayState = { txNonce: bigint; queueNonce: bigint; headCreatedAt: bigint; cooldown: bigint; expiration: bigint };
export const headExpired = (q: DelayState, nowS: number) => q.txNonce < q.queueNonce && q.headCreatedAt > 0n && q.headCreatedAt + q.cooldown + q.expiration < BigInt(nowS);
/** The queue head can be executed now (cooldown over, not expired). */
export const headReady = (q: DelayState, nowS: number) => q.txNonce < q.queueNonce && q.headCreatedAt > 0n && q.headCreatedAt + q.cooldown <= BigInt(nowS) && !headExpired(q, nowS);

// ---------------------------------------------------------------- our records and what became of them

export type FundRecord = { kind: "fund"; game: Address; amount: string; delayNonce: string; tx: Hex; block: string; build: string; reason: "start" | "topup"; at: string };
/** Our signed fund records, newest first. */
export const fundRecords = async (limit = 200) => (await trustedDocs<FundRecord>("fund", undefined, limit)).filter((r) => r.kind === "fund");

/** Pure: the games whose funding is stopped. A fund of ours that Delay's queue passed (nonce < txNonce) with no Funded
 *  for its game at or after its tx was vetoed by the Safe (setTxNonce) or expired: the game gets no more funds from
 *  us, so the Safe never has to veto the same fund every hour. A Funded for the game after it (the Safe calling
 *  GameFunder.fund for it, through Delay or directly) restarts it. */
export function stoppedGames(records: FundRecord[], txNonce: bigint, fundedSince: Record<string, bigint | undefined>) {
  const out = new Set<string>();
  const newest = new Map<string, FundRecord>();
  for (const r of records) if (!newest.has(key(r.game))) newest.set(key(r.game), r); // records are newest first
  for (const [g, r] of newest) {
    if (BigInt(r.delayNonce) >= txNonce) continue; // still queued
    const f = fundedSince[g];
    if (f === undefined || f < BigInt(r.block)) out.add(g);
  }
  return out;
}

// ---------------------------------------------------------------- chain reads (a seam: tests stand in for the chain)

const fn = (c: PublicClient, address: Address, a: readonly unknown[], functionName: string, args: unknown[], blockNumber: bigint) =>
  c.readContract({ address, abi: a, functionName, args, blockNumber } as never) as Promise<unknown>;
const big = (x: unknown) => BigInt(String(x));

export type ChainState = { block: bigint; weeklyBudget: bigint; perGameCap: bigint; spentInWindow: bigint; balance: bigint; q: DelayState; oldestSpendAt?: number; funded: Record<string, bigint>; lastFundedBlock: Record<string, bigint | undefined> };
export const FUND_DEPS = {
  /** GameFunder's caps and spend, Delay's queue, and per game its total and its newest Funded at or after `games[g]`
   *  (our newest fund record's block), at the agreed block. */
  chain: async (games: Record<string, bigint>): Promise<ChainState> => {
    const b = await agreedHead();
    const [weeklyBudget, perGameCap, spentInWindow, balance, txNonce, queueNonce, cooldown, expiration] = await readAgreed(async (c) => (await Promise.all([
      fn(c, d.gameFunder!, FUNDER_ABI, "weeklyBudget", [], b), fn(c, d.gameFunder!, FUNDER_ABI, "perGameCap", [], b), fn(c, d.gameFunder!, FUNDER_ABI, "spentInWindow", [], b),
      c.getBalance({ address: d.gameFunder!, blockNumber: b }),
      fn(c, d.delay!, DELAY_ABI, "txNonce", [], b), fn(c, d.delay!, DELAY_ABI, "queueNonce", [], b), fn(c, d.delay!, DELAY_ABI, "txCooldown", [], b), fn(c, d.delay!, DELAY_ABI, "txExpiration", [], b),
    ])).map(String)).then((xs) => xs.map(BigInt));
    const headCreatedAt = big(await readAgreed((c) => fn(c, d.delay!, DELAY_ABI, "txCreatedAt", [txNonce], b).then(String)));
    const funded: Record<string, bigint> = {};
    const lastFundedBlock: Record<string, bigint | undefined> = {};
    for (const [g, since] of Object.entries(games)) {
      funded[g] = big(await readAgreed((c) => fn(c, d.gameFunder!, FUNDER_ABI, "fundedTotal", [g], b).then(String)));
      const blocks = await readAgreed(async (c) => (await getLogsChunked((lo, hi) => c.getLogs({ address: d.gameFunder!, event: FUNDED, args: { game: g as Address }, fromBlock: lo, toBlock: hi }), since, b)).map((l) => String(l.blockNumber)));
      lastFundedBlock[g] = blocks.length ? BigInt(blocks.at(-1)!) : undefined;
    }
    // the oldest spend still counted: GameFunder's Funded logs of the last 7 days (plus a margin), timestamped
    const head = await pub.getBlock({ blockNumber: b });
    const from = b > 60_000n ? b - 60_000n : 0n; // ≈ 8.3 days of 12 s blocks
    const recent = await readAgreed(async (c) => (await c.getLogs({ address: d.gameFunder!, event: FUNDED, fromBlock: from, toBlock: b })).map((l) => String(l.blockNumber)));
    let oldestSpendAt: number | undefined;
    for (const n of recent) {
      const t = Number((await pub.getBlock({ blockNumber: BigInt(n) })).timestamp) * 1000;
      if (t + WEEK > Number(head.timestamp) * 1000) { oldestSpendAt = t; break; }
    }
    return { block: b, weeklyBudget, perGameCap, spentInWindow, balance, q: { txNonce, queueNonce, headCreatedAt, cooldown, expiration }, oldestSpendAt, funded, lastFundedBlock };
  },
  game: async (game: Address, block: bigint) => {
    const [isGame, live] = await readAgreed(async (c) => [Boolean(await fn(c, d.gameFactory!, abi.gameFactoryAbi, "isGame", [game], block)), Boolean(await fn(c, d.gameFactory!, abi.gameFactoryAbi, "isLive", [game], block))]);
    return { isGame, live };
  },
  /** The exact call as the Safe will make it after the hour (every provider must agree it does not revert). */
  safeCall: (data: Hex, block: bigint) => readAgreed(async (c) => c.call({ account: d.safe, to: d.gameFunder!, data, blockNumber: block }).then(() => "ok", (e: Error) => `revert: ${(e as { shortMessage?: string }).shortMessage ?? e.message}`.slice(0, 200))),
  send: (c: Parameters<typeof send>[0]) => send(c),
  receipt: (hash: Hex) => pub.getTransactionReceipt({ hash }),
  /** The funder key's next nonce (an earlier pending queue tx whose nonce is still open may yet land). */
  nonce: () => pub.getTransactionCount({ address: addressOf("funder")!, blockTag: "latest" }),
};

/** Delay's queue and GameFunder's caps at the agreed block, our pending funds, the stopped games, and the block of
 *  each game's newest executed fund (from our signed records: top-ups count the players who came after it). */
export async function fundState() {
  if (!d.gameFunder || !d.delay) throw new Error("no GameFunder / Delay in the deployment");
  const records = await fundRecords();
  const games: Record<string, bigint> = {};
  for (const r of records) games[key(r.game)] ??= BigInt(r.block); // newest first: each game's newest record
  const c = await FUND_DEPS.chain(games);
  const pending = records.filter((r) => BigInt(r.delayNonce) >= c.q.txNonce).map((r) => ({ game: r.game, amount: BigInt(r.amount) }));
  const stopped = stoppedGames(records, c.q.txNonce, c.lastFundedBlock);
  const lastFunded: Record<string, bigint> = {};
  for (const r of [...records].reverse()) if (BigInt(r.delayNonce) < c.q.txNonce && !stopped.has(key(r.game))) lastFunded[key(r.game)] = BigInt(r.block);
  const s: FundState = { weeklyBudget: c.weeklyBudget, perGameCap: c.perGameCap, spentInWindow: c.spentInWindow, balance: c.balance, oldestSpendAt: c.oldestSpendAt, funded: c.funded, pending };
  return { s, q: c.q, block: c.block, records, lastFunded, stopped };
}

// ---------------------------------------------------------------- queue

/** The signed fund record of a mined queue tx, from its receipt's TransactionAdded (the amount from its calldata). */
async function recordOf(hash: Hex, game: Address, build: string, reason: "start" | "topup", nowMs: number) {
  const rc = await FUND_DEPS.receipt(hash);
  const added = rc.logs.filter((l) => l.address.toLowerCase() === d.delay!.toLowerCase()).map((l) => {
    try { return decodeEventLog({ abi: DELAY_ABI, data: l.data, topics: l.topics }); } catch { return null; }
  }).find((e) => e?.eventName === "TransactionAdded");
  if (!added || added.eventName !== "TransactionAdded") throw new Error(`fund tx ${hash}: no TransactionAdded from Delay`);
  const call = decodeFunctionData({ abi: FUNDER_ABI, data: added.args.data });
  const [to, amount] = call.args as [Address, bigint];
  if (call.functionName !== "fund" || key(to) !== key(game) || key(added.args.to) !== key(d.gameFunder!)) throw new Error(`fund tx ${hash}: its Delay entry is not fund(${game})`);
  const rec: FundRecord = { kind: "fund", game, amount: String(amount), delayNonce: String(added.args.queueNonce), tx: hash, block: String(rc.blockNumber), build, reason, at: new Date(nowMs).toISOString() };
  await append("fund", `fund:${key(game)}`, rec);
  return { queued: true as const, amount, delayNonce: added.args.queueNonce };
}

/** Queue fund(game, amount) for a build, if it can't revert: the room with the queue counted in, the queue's head not
 *  expired (skipExpired first), the exact call run from the Safe, then Roles.execTransactionWithRole with the funder
 *  key and its TransactionAdded matched to a signed `fund` record. Returns what happened (a reason when nothing was
 *  queued). Never throws for "no room". A queue tx that mined before a crash lost its record is found by its purpose
 *  and recorded, never sent twice (a second Delay entry would jam the FIFO queue). */
export async function queueFund(game: Address, build: string, reason: "start" | "topup", nowMs = Date.now()): Promise<{ queued: false; why: string } | { queued: true; amount: bigint; delayNonce: bigint }> {
  if (!d.gameFunder || !d.delay || !d.roles || !d.gameFactory) return { queued: false, why: "no funding path in the deployment" };
  const st = await fundState();
  const n = st.records.filter((r) => key(r.game) === key(game)).length;
  const purpose = `seq:fund:${build}:${key(game)}:${n}`;
  const attempts = await trustedDocs<{ status: string; hash?: Hex; hashes?: Hex[]; nonce?: number }>("tx", purpose, 20);
  const landed = attempts.find((t) => t.status === "mined" && t.hash);
  if (landed) return recordOf(landed.hash!, game, build, reason, nowMs);
  // a crash with the queue tx still pending: its receipt first, never a second (differently sized) Delay entry
  if (attempts[0]?.status === "pending") {
    for (const h of attempts[0].hashes ?? []) if ((await FUND_DEPS.receipt(h).catch(() => null))?.status === "success") return recordOf(h, game, build, reason, nowMs);
    if (attempts[0].nonce !== undefined && (await FUND_DEPS.nonce()) <= attempts[0].nonce) return { queued: false, why: `an earlier queue tx of this fund (nonce ${attempts[0].nonce}) is still pending` };
  }
  if (st.stopped.has(key(game))) {
    await alert(`Funding stopped for game ${game}: a queued fund was vetoed or expired. Nothing more is queued for it until the Safe funds it once (GameFunder.fund).`, `alert:fund:stopped:${key(game)}`);
    return { queued: false, why: "funding stopped: a queued fund was vetoed or expired (the Safe funding it once restarts it)" };
  }
  if (headExpired(st.q, Math.floor(nowMs / 1000))) {
    const ours = st.records.some((r) => BigInt(r.delayNonce) === st.q.txNonce);
    if (ours) await alert(`Funding: our queued fund at Delay nonce ${st.q.txNonce} expired unexecuted (past cooldown + expiration); skipping it so the queue moves.`, `alert:fund:expired:${st.q.txNonce}`);
    await FUND_DEPS.send({ key: "funder", to: d.delay, abi: DELAY_ABI, fn: "skipExpired", purpose: `seq:fund:skip:${st.q.txNonce}` });
    return { queued: false, why: `Delay's head (nonce ${st.q.txNonce}${ours ? ", one of ours" : ""}) had expired: skipped first, retried next run` };
  }
  const amount = fundAmount(st.s, game, nowMs, reason);
  const why = fundRoom(st.s, game, amount, await FUND_DEPS.game(game, st.block));
  if (why) return { queued: false, why };
  const data = encodeFunctionData({ abi: FUNDER_ABI, functionName: "fund", args: [game, amount] });
  const sim = await FUND_DEPS.safeCall(data, st.block);
  if (sim !== "ok") return { queued: false, why: `fund(${game}, ${amount}) from the Safe ${sim}` };
  const sent = await FUND_DEPS.send({ key: "funder", to: d.roles, abi: ROLES_ABI, fn: "execTransactionWithRole", args: [d.gameFunder, 0n, data, 0, ROLE_KEY, true], purpose });
  if (sent.status === "dry_run") return { queued: false, why: "dry run" };
  if (sent.status === "sim_revert") {
    // the Safe's own call passed, so Roles refused: the key lost its role (NoMembership) or the scope changed
    await alert(`Funding: Roles refused the funder key's queue of fund(${game}) (${sent.error ?? ""}): check the key still holds its role.`, `alert:fund:roles:${new Date(nowMs).toISOString().slice(0, 13)}`);
  }
  if (sent.status !== "mined" || !sent.hash) return { queued: false, why: `the queue tx ${sent.status}: ${sent.error ?? ""}` };
  return recordOf(sent.hash, game, build, reason, nowMs);
}

/** Execute Delay's head when its cooldown is over (permissionless; the keeper pays the gas), if it is one of ours. */
export async function executeReady(nowMs = Date.now()) {
  if (!d.gameFunder || !d.delay) return "no funding path";
  const st = await fundState();
  if (!headReady(st.q, Math.floor(nowMs / 1000))) return "nothing ready";
  const r = st.records.find((x) => BigInt(x.delayNonce) === st.q.txNonce);
  if (!r) return `Delay's head (nonce ${st.q.txNonce}) is not one of our fund records: left to the Safe`;
  const data = encodeFunctionData({ abi: FUNDER_ABI, functionName: "fund", args: [r.game, BigInt(r.amount)] });
  const s = await FUND_DEPS.send({ key: "keeper", to: d.delay, abi: DELAY_ABI, fn: "executeNextTx", args: [d.gameFunder, 0n, data, 0], purpose: `keeper:fund:${st.q.txNonce}` });
  return `executed fund ${r.game} ${r.amount}: ${s.status}`;
}
