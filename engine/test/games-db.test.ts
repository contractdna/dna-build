// The game layer against a real Postgres (fresh database) and a fake chain that answers GamePot / ConvictionVault /
// MutationBoard / registry calls from a state object (reverts carry the contract's error, so the quiet simulation sees
// "PrizeTooSmall" exactly as on chain): every keeper decision path, the holder jackpot's params / list / settle, the
// agent's ballot / mystery / interval tasks, idea rewards (keeper pay, claims, fact sheets), the X fact sheets for game
// events, and the indexer.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { type Abi, type Address, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult, type Hex, keccak256, parseGwei, parseTransaction, stringToHex, toHex, zeroAddress } from "viem";
import { feeHistory, startFakes } from "../scripts/fakes.ts";
import { synthetic } from "../scripts/synthetic.ts";

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL unset";
const fakes = await startFakes();
fakes.llm.xai = (b) => synthetic("xai", b);
const dbName = `dna_games_${process.pid}`;
const admin = ADMIN ? postgres(ADMIN, { max: 1, onnotice: () => {} }) : undefined;
if (ADMIN) {
  await admin!.unsafe(`create database ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: u.href, RPC_URL: `${fakes.url}/rpc`, ENGINE_MODE: "live", TX_POLL_MS: "5", LLM_MODE: "live",
    XAI_API_BASE: fakes.url, XAI_API_KEY: "k", OPENROUTER_API_BASE: fakes.url, OPENROUTER_API_KEY_ENGINE: "k", X_API_BASE: fakes.url, X_CLIENT_ID: "cid", X_REFRESH_TOKEN: "seed", X_USER_ID: "42", SECRET_SEAL_KEY: "11".repeat(32),
    AGENT_PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", ANCHOR_PRIVATE_KEY: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", KEEPER_PRIVATE_KEY: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    // the deterministic gates on a tiny synthetic window: what is tested here is the game logic, not the gates
    GATE_MIN_SWAPS: "3", GATE_MIN_RETENTION: "0", GATE_MIN_REVENUE_LIFT: "-1", GATE_MAX_CAP_SHARE: "1",
  });
}
const { edb: sql, migrate } = await import("../src/db.ts");
const abi = await import("../src/abi.ts");
const games = await import("../src/games.ts");
const jackpot = await import("../src/jackpot.ts");
const tk = await import("../src/tickets.ts");
const tx = await import("../src/tx.ts");
const xM = await import("../src/x.ts");
const modeM = await import("../src/mode.ts");
const { d } = await import("../src/config.ts");

before(async () => { if (ADMIN) { await migrate(); await modeM.initMode(); } });
after(async () => {
  await sql.end({ timeout: 1 });
  const { sql: one } = await import("../src/db.ts");
  await one.end({ timeout: 1 });
  if (admin) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); await admin.end(); }
  await fakes.close();
});

const job = () => ({ id: "0", kind: "t", payload: {}, attempts: 1, max_attempts: 5, created_at: new Date(), dedupe_key: null }) as never;
const E = 10n ** 18n, H = 3600, D = 86_400;
const T = Math.floor(Date.now() / 1000);
const agent = tx.addressOf("agent")!;

// ---------------------------------------------------------------- fake chain: views from `st`, writes recorded
const st = {
  now: T, block: 1000n, level: 5, paused: false,
  draw: NO_DRAW() as unknown[], windowId: 0n, windowStart: 0, windowEnd: 0, lastDrawnWindow: 0n, totalLocked: 10n ** 25n,
  drawInterval: D, stalledSince: 0n, pendingInterval: [0, 0, zeroAddress] as unknown[],
  ideaReserve: 2n * E, queuedRewards: 0n, rewards: {} as Record<string, unknown[]>, subId: 1n,
  // the pot's books (GamePot._sync's inputs): ERC-6909 claims + native ETH vs jackpot + reserve + queued + escrow + owed
  claims: 2n * E, eth: 0n, jackpotPot: 0n, owedTotal: 0n, subBal: 0n, // claims = ideaReserve: nothing arrived
  prizes: {} as Record<string, unknown[]>, supply: 10n ** 27n, excluded: [] as string[],
  pendingMystery: 0n, mysteryCount: 0n, mysteries: {} as Record<string, unknown[]>, ballotCount: 0n, lastBallotAt: 0n, ballots: {} as Record<string, unknown[]>, winner: 0,
  reverts: {} as Record<string, string>, sent: [] as { to: string; fn: string; args: readonly unknown[]; gas?: bigint }[], estimate: 100_000n,
  failEstimate: undefined as string | undefined, baseFee: parseGwei("1"),
  splitModule: zeroAddress as string, split: [3500n, 3500n, 3000n, 0n, true] as unknown[],
};
function NO_DRAW() { return [0n, 0, 0, 0, 0n, 0n, `0x${"00".repeat(32)}`, 0n, 0n]; }
const COORD = [{ type: "function", name: "getSubscription", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint96" }, { type: "uint96" }, { type: "uint64" }, { type: "address" }, { type: "address[]" }] }] as const;
const ABIS: [string, readonly unknown[]][] = [[d.poolManager, abi.poolManagerAbi], [d.vrfCoordinator!, COORD], [d.gamePot!, abi.gamePotAbi], [d.convictionVault!, abi.convictionVaultAbi], [d.mutationBoard!, abi.mutationBoardAbi], [d.registry, abi.registryAbi], [d.feeVault, abi.feeVaultAbi], [d.token, abi.tokenAbi], [d.ideaMarket!, abi.ideaMarketAbi]];
const abiOf = (to: string) => ABIS.find(([a]) => a.toLowerCase() === to.toLowerCase())?.[1] as Abi | undefined;
const VIEW: Record<string, (args: readonly unknown[]) => unknown> = {
  level: () => st.level, agentPaused: () => st.paused, agent: () => agent, totalSupply: () => st.supply,
  draw: () => st.draw, windowId: () => st.windowId, windowStart: () => st.windowStart, windowEnd: () => st.windowEnd, lastDrawnWindow: () => st.lastDrawnWindow,
  totalLocked: () => st.totalLocked, balanceOf: () => st.claims, jackpotPot: () => st.jackpotPot, owedTotal: () => st.owedTotal, POT_CAP: () => 15n * E, JACKPOT_BPS: () => 7000n,
  SUB_MIN: () => E / 100n, coordinator: () => d.vrfCoordinator, getSubscription: () => [0n, st.subBal, 0n, d.gamePot, []], drawInterval: () => st.drawInterval, stalledSince: () => st.stalledSince, pendingInterval: () => st.pendingInterval,
  ideaReserve: () => st.ideaReserve, queuedRewards: () => st.queuedRewards, subId: () => st.subId,
  rewards: ([id]) => st.rewards[String(id)] ?? [zeroAddress, 0n, zeroAddress, 0, `0x${"00".repeat(32)}`], prizes: ([id]) => st.prizes[String(id)] ?? [zeroAddress, 0n, 0], isExcluded: ([a]) => st.excluded.includes(String(a).toLowerCase()),
  pendingMystery: () => st.pendingMystery, mysteryCount: () => st.mysteryCount,
  mysteries: ([id]) => st.mysteries[String(id)] ?? [`0x${"00".repeat(32)}`, 0, 0, zeroAddress], ballotCount: () => st.ballotCount, lastBallotAt: () => st.lastBallotAt,
  ballots: ([id]) => st.ballots[String(id)], winner: () => st.winner,
  splitRoute: () => ({ module: st.splitModule, params: Array(4).fill(`0x${"00".repeat(32)}`) }), currentSplit: () => st.split, rounds: () => [1, 4, 0, 0, 0, zeroAddress, 0n, 0n, 0n, 0n],
};
function call(c: { to: string; data: Hex }) {
  const a = abiOf(c.to);
  if (!a) return "0x";
  const { functionName, args = [] } = decodeFunctionData({ abi: a, data: c.data });
  if (st.reverts[functionName]) throw Object.assign(new Error("execution reverted"), { code: 3, data: encodeErrorResult({ abi: a, errorName: st.reverts[functionName] }) });
  const v = VIEW[functionName];
  const out = v ? v(args) : (a.find((x) => (x as { name?: string }).name === functionName) as unknown as { outputs: unknown[] }).outputs.length ? 1n : undefined;
  return encodeFunctionResult({ abi: a, functionName, result: out as never });
}
Object.assign(fakes.rpc, {
  eth_chainId: () => toHex(31337),
  eth_blockNumber: () => toHex(st.block),
  eth_getBlockByNumber: () => ({ number: toHex(st.block), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"00".repeat(32)}`, timestamp: toHex(st.now), baseFeePerGas: toHex(st.baseFee), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], miner: zeroAddress, difficulty: "0x0", extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, size: "0x0", stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, uncles: [], totalDifficulty: "0x0", mixHash: `0x${"00".repeat(32)}` }),
  eth_maxPriorityFeePerGas: () => "0x0", // what public RPCs answer: never read (fees come from eth_feeHistory)
  eth_feeHistory: (p: unknown[]) => feeHistory(p, st.baseFee),
  eth_estimateGas: ([c]: [{ to: string; data: Hex }]) => {
    const a = abiOf(c.to);
    if (a && st.failEstimate && decodeFunctionData({ abi: a, data: c.data }).functionName === st.failEstimate) {
      st.failEstimate = undefined; // once: an RPC hiccup, not a revert
      throw Object.assign(new Error("upstream unavailable"), { code: -32000 });
    }
    return toHex(st.estimate);
  },
  eth_call: ([c]: [{ to: string; data: Hex }]) => call(c),
  eth_getBalance: () => toHex(st.eth),
  eth_getTransactionCount: () => toHex(st.sent.length),
  eth_sendRawTransaction: ([raw]: [Hex]) => {
    const t = parseTransaction(raw);
    const { functionName, args = [] } = decodeFunctionData({ abi: abiOf(t.to!)!, data: t.data! });
    st.sent.push({ to: t.to!, fn: functionName, args, gas: t.gas });
    return keccak256(raw);
  },
  eth_getTransactionReceipt: ([h]: [string]) => ({ transactionHash: h, transactionIndex: "0x0", blockHash: `0x${"22".repeat(32)}`, blockNumber: toHex(st.block), from: agent, to: d.gamePot,
    cumulativeGasUsed: "0xc350", gasUsed: "0xc350", effectiveGasPrice: toHex(parseGwei("2")), contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2" }),
});
const sentFns = () => st.sent.map((s) => s.fn);
const reset = () => { st.sent = []; st.reverts = {}; };
const chain = (block: number, li: number, at: Date, event: string, args: Record<string, unknown>, address = "0x") =>
  sql`insert into chain_log (block, log_index, tx, block_hash, at, address, event, args) values (${block}, ${li}, ${`0x${block.toString(16)}`}, '0x', ${at}, ${address.toLowerCase()}, ${event}, ${sql.json(args as never)})`;
const ago = (s: number) => new Date((T - s) * 1000);

// ---------------------------------------------------------------- keepers
const listed = (over: Record<number, unknown> = {}) => Object.assign(NO_DRAW(), { 0: 4n, 1: T - H }, over);
test("keeper:games: a due draw is simulated first — a gate that says no (PrizeTooSmall) sends and logs nothing", { skip }, async () => {
  reset();
  st.draw = listed(); // window 4's list, past its veto hour
  st.reverts.requestDraw = "PrizeTooSmall";
  const out = await games.gameKeeperHandlers["keeper:games"].run(job()) as { fn: string; waiting?: string }[];
  assert.deepEqual(out[0], { fn: "requestDraw", waiting: "PrizeTooSmall" });
  assert.equal(st.sent.length, 0);
  assert.equal((await sql`select count(*)::int as n from log where kind = 'tx'`)[0].n, 0, "no sim_revert record spam");
  delete st.reverts.requestDraw;
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(st.sent.find((s) => s.fn === "requestDraw")!.args, [], "permissionless, no arguments");
  reset();
  st.draw = listed({ 1: T + 1 });
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.ok(!sentFns().includes("requestDraw"), "never inside the Safe's veto hour");
  reset();
  st.draw = NO_DRAW();
  st.windowId = 2n;
  st.windowEnd = T - 60;
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(sentFns(), ["rollWindow"]);
  st.windowEnd = T + D;
  // fees arrived that no sync() counted yet: the keeper syncs them into the jackpot and the idea reserve
  reset();
  st.claims = st.ideaReserve + E;
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(sentFns(), ["sync"]);
  // a small arrival: synced once a distribute period, judged from the latest indexed Synced
  reset();
  st.claims = st.ideaReserve + E / 50n;
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(sentFns(), ["sync"], "no Synced yet");
  reset();
  await chain(9001, 0, ago(30 * 60), "Synced", { arrived: "0", jackpotPot: "0", ideaReserve: "0", overflowBurned: "0" });
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(sentFns(), [], "synced 30 min ago");
  await sql`delete from chain_log where block = 9001`;
  // a due draw held back by a gate still lets the sync through; one that goes out syncs on its own
  reset();
  st.draw = listed();
  st.reverts.requestDraw = "PrizeTooSmall";
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(sentFns(), ["sync"], "PrizeTooSmall: the jackpot still moves");
  reset();
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(sentFns(), ["requestDraw"], "requestDraw syncs first");
  st.draw = NO_DRAW();
  st.claims = st.ideaReserve;
});

test("fail-closed alerts: a game tx revert that is no gate, a split fallback with a module set, a VRF request open > 30 min", { skip }, async () => {
  const alerts = async (like: string) => (await sql<{ n: number }[]>`select count(*)::int as n from job where kind = 'alert' and payload->>'text' ilike ${like}`)[0].n; // ilike: addresses come back checksummed
  reset();
  st.draw = listed();
  st.reverts.requestDraw = "PrizeTooSmall";
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.equal(await alerts("Game tx requestDraw%"), 0, "a gate that says not yet stays quiet");
  st.reverts.requestDraw = "BadConfig"; // stands in for a coordinator change: InvalidRequestConfirmations, GasLimitTooBig
  const out = await games.gameKeeperHandlers["keeper:games"].run(job()) as { fn: string; waiting?: string }[];
  assert.deepEqual(out[0], { fn: "requestDraw", waiting: "BadConfig" }, "still not sent");
  assert.equal(st.sent.length, 0);
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.equal(await alerts("Game tx requestDraw would revert: BadConfig.%the VRF coordinator%"), 1, "once a day, not every run");
  delete st.reverts.requestDraw;

  await games.failClosedChecks(T);
  assert.equal(await alerts("Fee split fell back%"), 0, "no split module: the 35/35/30/0 baseline is expected");
  assert.equal(await alerts("VRF request%"), 0, "nothing requested");
  st.splitModule = `0x${"00".repeat(19)}aa`;
  st.draw = listed({ 2: T - 31 * 60, 5: 7n }); // requested 31 min ago, not fulfilled
  await games.failClosedChecks(T);
  await games.failClosedChecks(T);
  assert.equal(await alerts(`Fee split fell back to 35/35/30/0 (games off) although split module ${st.splitModule} is set%`), 1);
  assert.equal(await alerts("VRF request 7 (window 4) unfulfilled for 31 min. Check subscription 1 on the coordinator: anyone can top it up with fundSubscriptionWithNative(1).%"), 1);
  st.split = [3000n, 3000n, 2500n, 1500n, false]; // the module works: games on
  st.splitModule = `0x${"00".repeat(19)}bb`;
  await games.failClosedChecks(T);
  assert.equal(await alerts("Fee split fell back%"), 1);
  st.splitModule = zeroAddress;
  st.split = [3500n, 3500n, 3000n, 0n, true];
  st.draw = NO_DRAW();
});

test("keeper:games: a gas spike defers a routine roll but abortDraw goes out at the emergency ceiling; the Defer comes after", { skip }, async () => {
  reset();
  st.draw = listed({ 2: T - 37 * H, 4: E / 10n, 5: 7n }); // requested 37 h ago: abortDraw due (urgent)
  st.stalledSince = BigInt(T - 37 * H);
  st.windowEnd = T - 60; // rollWindow due (normal ceiling)
  st.baseFee = parseGwei("50"); // ~100 gwei maxFee: over MAX_GWEI 20, under EMERGENCY_MAX_GWEI 200
  try {
    await assert.rejects(games.gameKeeperHandlers["keeper:games"].run(job()), /gas guard/);
    assert.deepEqual(sentFns(), ["abortDraw"], "the routine roll waits; the urgent call is not held back by it");
  } finally {
    st.baseFee = parseGwei("1");
    st.stalledSince = 0n;
    st.windowEnd = T + D;
    st.draw = NO_DRAW();
  }
});

test("keeper:games: abort after the VRF timeout, rescue only once stalled 14 d; the draw interval", { skip }, async () => {
  reset();
  st.draw = listed({ 2: T - 37 * H, 4: E / 10n, 5: 7n });
  st.stalledSince = BigInt(T - 37 * H);
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(sentFns(), ["abortDraw"]);
  reset();
  st.stalledSince = BigInt(T - 15 * D);
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(sentFns(), ["rescueToBuyback"]);
  reset();
  st.draw = NO_DRAW();
  st.stalledSince = 0n;
  st.pendingInterval = [2 * D, T - 1, agent];
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(sentFns(), ["executeDrawInterval"]);
  st.pendingInterval = [0, 0, zeroAddress];
});

test("keeper:games: a queued idea reward is paid once its public hour is over; never inside it, never paid or cancelled ones, nothing while payReward says no", { skip }, async () => {
  reset();
  const to = "0x00000000000000000000000000000000000000c7";
  const queued = (block: number, id: number) => chain(block, 0, ago(2 * H), "RewardQueued", { id: String(id), to, amount: String(E / 10n), ideaRef: `0x${"ab".repeat(32)}`, eta: String(T - H) });
  await queued(20, 1); // due
  await queued(21, 2); // still in the Safe's hour (eta on chain: T + 1)
  await queued(22, 3); // paid already (indexed)
  await chain(23, 0, ago(H), "RewardPaid", { id: "3", to, amount: String(E / 10n), claimId: "0" });
  await queued(24, 4); // cancelled (indexed)
  await chain(25, 0, ago(H), "RewardCancelled", { id: "4" });
  const ref = (n: number) => `0x${String(n).padStart(64, "0")}`;
  st.rewards = { 1: [to, E / 10n, agent, T - H, ref(1)], 2: [to, E / 10n, agent, T + 1, ref(2)], 3: [to, E / 10n, agent, T - H, ref(3)], 4: [to, E / 10n, agent, T - H, ref(4)] };
  try {
    await games.gameKeeperHandlers["keeper:games"].run(job());
    assert.deepEqual(st.sent.filter((s) => s.fn === "payReward").map((s) => s.args), [[1n]]);
    reset();
    st.reverts.payReward = "Unauthorized"; // the agent is paused (or the recipient became excluded): the simulation says no
    const out = await games.gameKeeperHandlers["keeper:games"].run(job()) as { fn: string; waiting?: string }[];
    assert.deepEqual(out.find((o) => o.fn === "payReward"), { fn: "payReward", waiting: "Unauthorized" });
    assert.equal(st.sent.length, 0);
  } finally {
    reset();
    st.rewards = {};
    await chain(26, 0, ago(H / 2), "RewardPaid", { id: "1", to, amount: String(E / 10n), claimId: "0" });
    await chain(27, 0, ago(H / 2), "RewardCancelled", { id: "2" });
  }
});

test("keeper:games: expired claims (failed pushes: Winner.prizeId and RewardPaid.claimId != 0) return to the jackpot; claimed ones are left alone; halted does nothing", { skip }, async () => {
  reset();
  const winner = "0x00000000000000000000000000000000000000c1";
  const won = (block: number, rank: number, at: Date, prizeId: number) => chain(block, rank, at, "Winner", { window: "1", rank: String(rank), account: winner, share: String(E / 10n), prizeId: String(prizeId) });
  await won(10, 0, ago(31 * D), 1);
  await won(10, 1, ago(31 * D), 0); // pushed in the settle: no prize record, never swept
  await won(10, 2, ago(31 * D), 2);
  await chain(12, 0, ago(30 * D), "PrizeClaimed", { drawId: "2" });
  await won(13, 0, ago(2 * D), 3);
  await won(14, 0, ago(31 * D), 4);
  await chain(15, 0, ago(31 * D), "RewardPaid", { id: "9", to: winner, amount: String(E / 10n), claimId: "5" }); // a reward's failed push: claim 5
  await chain(16, 0, ago(31 * D), "RewardPaid", { id: "10", to: winner, amount: String(E / 10n), claimId: "0" }); // pushed: no claim
  st.prizes = { 1: [winner, E / 10n, T - 31 * D], 2: [winner, E / 10n, T - 31 * D], 3: [winner, E / 10n, T - 2 * D], 4: [winner, 0n, T - 31 * D], 5: [winner, E / 10n, T - 31 * D] };
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(st.sent.filter((s) => s.fn === "expireClaim").map((s) => s.args), [[1n], [5n]], "claimed (indexed, or amount 0 on chain), not yet due: never expired; a reward's claim expires like a share");
  reset();
  await modeM.setOverride("halted", "test");
  assert.equal(await games.gameKeeperHandlers["keeper:games"].run(job()), "halted");
  await sql`update engine_flags set override = null`;
  st.prizes = {};
});

test("keeper:games: our sealed mystery is revealed inside its window; an unrevealed one is marked broken", { skip }, async () => {
  reset();
  const salt = toHex(9n, { size: 32 }), payload = toHex('{"op":"SetParams","vector":[22500,0,22500]}');
  const commitment = games.commitmentOf(salt, payload);
  await games.storePreimage(commitment, salt, payload);
  st.pendingMystery = 1n;
  st.mysteries = { 1: [commitment, T - H, 1, agent] };
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(st.sent.find((s) => s.fn === "reveal")?.args, [1n, salt, payload]);
  reset();
  st.mysteries = { 1: [commitment, T - 25 * H, 1, agent] };
  await games.gameKeeperHandlers["keeper:games"].run(job());
  assert.deepEqual(sentFns(), ["markBroken"]);
  st.pendingMystery = 0n;
  // a preimage that does not match its commitment is never revealed
  assert.equal(await games.loadPreimage(`0x${"ee".repeat(32)}`), null);
});

// ---------------------------------------------------------------- the holder jackpot (src/jackpot.ts)
type ParamsDoc = { window: number; start: number; capBps: number; minBalance: string; cex: string[] };
const holder = (i: number) => `0x${(0xa000 + i).toString(16).padStart(40, "0")}` as Address;
const W4 = { start: T - 26 * H, end: T - 2 * H };

test("jackpot params: recorded, anchored and MINED before the window starts, announced; once per window", { skip }, async () => {
  reset();
  const now0 = W4.start - 2 * H;
  Object.assign(st, { windowId: 3n, windowStart: W4.start - D, windowEnd: W4.start, drawInterval: D, now: now0 }); // window 3 open: window 4 is next
  try {
    assert.deepEqual(await jackpot.paramsTask(now0), { window: 4, start: W4.start, anchor: "mined" });
    const [rec] = await sql<{ seq: string; hash: string; doc: ParamsDoc }[]>`select seq::text, encode(hash, 'hex') as hash, doc from log where kind = 'game' and ref = 'jackpot:params:4'`;
    assert.deepEqual(st.sent.find((s) => s.fn === "anchor")!.args, [`0x${rec.hash}`, `https://genomedna.xyz/api/log/${rec.seq}`], "the record itself is anchored");
    assert.deepEqual([rec.doc.window, rec.doc.start, rec.doc.capBps, rec.doc.minBalance, rec.doc.cex], [4, W4.start, 200, String(1_000n * E), []], "no posted draw yet: 2%");
    assert.match((rec.doc as ParamsDoc & { reasoning: string }).reasoning, /Per-wallet cap 2%.*\(no draw was posted in the last 2 windows; a 1% cap needs a recent draw with at least 100 wallets, so 2% until one has them\)/);
    const [anc] = await sql<{ doc: { paramsSeq: string; status: string; blockTime: number } }[]>`select doc from log where kind = 'game' and ref = 'jackpot:params-anchor:4'`;
    assert.deepEqual([anc.doc.paramsSeq, anc.doc.status, anc.doc.blockTime], [rec.seq, "mined", now0], "the anchor's block time is kept");
    assert.equal((await jackpot.paramsOf(4, W4.start)).why, null);
    assert.match(String((await jackpot.paramsOf(4, now0)).why), /not anchored before the window started/, "mined at or after the start does not count");
    const [ann] = await sql<{ doc: { title: string; priority: number } }[]>`select doc from log where kind = 'announce' and ref = 'jackpot-params:4'`;
    assert.match(ann.doc.title, /^Jackpot window 4 \(starts .+\): cap 2% per wallet, minimum average balance 1,000 DNA, 0 exchange wallets excluded$/);
    assert.equal(ann.doc.priority, 2);
    reset();
    assert.match(String(await jackpot.paramsTask(now0)), /params for window 4 anchored/);
    assert.equal(st.sent.length, 0, "once per window");
    // an anchor that reverted (or never left: sim_revert) is not an announcement: the same record is anchored again
    const { record } = await import("../src/records.ts");
    await record("game", "jackpot:params-anchor:4", { kind: "jackpot-params-anchor", window: 4, paramsSeq: rec.seq, root: `0x${rec.hash}`, tx: null, status: "reverted", blockTime: null, at: new Date().toISOString() });
    reset();
    assert.deepEqual(await jackpot.paramsTask(now0), { window: 4, start: W4.start, anchor: "mined" });
    assert.deepEqual(st.sent.find((s) => s.fn === "anchor")!.args, [`0x${rec.hash}`, `https://genomedna.xyz/api/log/${rec.seq}`], "the same params record");
    assert.equal((await sql`select 1 from log where kind = 'game' and ref = 'jackpot:params:4'`).length, 1, "no second params record");
    // the anchor was deferred long enough that the record's cap input is stale: a fresh record is issued, not re-anchored
    await record("game", "jackpot:params-anchor:4", { kind: "jackpot-params-anchor", window: 4, paramsSeq: rec.seq, root: `0x${rec.hash}`, tx: null, status: "reverted", blockTime: null, at: new Date().toISOString() });
    const was = Number((await sql<{ asOfBlock: number }[]>`select (doc->'capInput'->>'asOfBlock')::int as "asOfBlock" from log where kind = 'game' and ref = 'jackpot:params:4'`)[0].asOfBlock);
    await sql`insert into cursor (id, block, hash, at) values (1, ${was + 151}, '0x', now()) on conflict (id) do update set block = ${was + 151}, at = now()`;
    reset();
    try {
      assert.deepEqual(await jackpot.paramsTask(now0), { window: 4, start: W4.start, anchor: "mined" });
      const recs = await sql<{ seq: string; hash: string; doc: ParamsDoc & { capInput: { asOfBlock: number } } }[]>`select seq::text, encode(hash, 'hex') as hash, doc from log where kind = 'game' and ref = 'jackpot:params:4' order by log.seq`;
      assert.equal(recs.length, 2, "a second params record");
      assert.equal(recs[1].doc.capInput.asOfBlock, was + 151, "with a fresh cap input");
      assert.deepEqual(st.sent.find((s) => s.fn === "anchor")!.args, [`0x${recs[1].hash}`, `https://genomedna.xyz/api/log/${recs[1].seq}`], "the fresh record is the one anchored");
    } finally {
      await sql`delete from cursor`;
    }
  } finally {
    st.now = T;
  }
});

test("jackpot list: built from chain_log at the agreed end block, recorded (body = the list), posted with the last leaf bound; settled from it", { skip }, async () => {
  reset();
  Object.assign(st, { windowId: 5n, windowStart: W4.end, windowEnd: W4.end + D, lastDrawnWindow: 0n, draw: NO_DRAW() });
  await chain(600, 0, new Date(W4.start * 1000), "WindowRolled", { window: "4", start: String(W4.start), end: String(W4.end) }, d.gamePot!);
  for (let i = 0; i < 120; i++) await chain(601, i, new Date((W4.start - H) * 1000), "Transfer", { from: zeroAddress, to: holder(i), value: String(1_000n * E) }, d.token);
  await chain(602, 0, new Date((W4.start - H) * 1000), "Transfer", { from: zeroAddress, to: d.feeVault, value: String(10n ** 9n * E) }, d.token); // a protocol contract
  await chain(603, 0, new Date((W4.start - H) * 1000), "Transfer", { from: zeroAddress, to: holder(500), value: String(10n ** 9n * E) }, "0x0000000000000000000000000000000000000bad"); // another token
  await chain(900, 0, new Date((W4.end + 60) * 1000), "Transfer", { from: zeroAddress, to: holder(999), value: String(10n ** 6n * E) }, d.token); // after the end block
  await sql`insert into cursor (id, block, hash, at) values (1, 800, '0x', now()) on conflict (id) do update set block = 800, at = now()`;
  const saved = { ...jackpot.JACKPOT_DEPS };
  const asked: { block?: number; extra?: string[] } = {};
  Object.assign(jackpot.JACKPOT_DEPS, {
    windowBlocks: async (start: number, end: number) => (start === W4.start && end === W4.end ? { startBlock: 601, endBlock: 700, endBlockHash: `0x${"ab".repeat(32)}` } : null),
    exclusions: async (block: number, _a: string[], extra: string[]) => { Object.assign(asked, { block, extra }); return [zeroAddress, d.feeVault.toLowerCase(), ...extra]; },
  });
  Object.assign(st, { jackpotPot: 0n, claims: st.ideaReserve + E }); // nobody called sync(): 1 ETH of arrivals, 0.7 to the jackpot
  try {
    await sql`update cursor set block = 650`;
    assert.equal(await jackpot.listTask(new Date(), T), "waiting for the indexer", "chain_log must reach the end block");
    await sql`update cursor set block = 800`;
    const out = await jackpot.listTask(new Date(), T) as { window: number; holders: number; status: string };
    assert.deepEqual([out.window, out.holders, out.status], [4, 120, "mined"]);
    assert.deepEqual(asked, { block: 700, extra: [] }, "exclusions read at the end block, with the params' exchange list");
    const post = st.sent.find((s) => s.fn === "postList")!;
    const [rec] = await sql<{ seq: string; body: string }[]>`select seq::text, body from log where kind = 'game' and ref = 'jackpot:list:4'`;
    const list = JSON.parse(rec.body) as import("../src/tickets.ts").DrawList;
    const [params] = await sql<{ seq: string }[]>`select seq::text from log where kind = 'game' and ref = 'jackpot:params:4'`;
    assert.deepEqual(post.args.slice(0, 5), [4n, { capBps: 200n, minBalance: 1_000n * E }, list.root, 120_000n, 120n]);
    assert.equal(post.args[7], `https://genomedna.xyz/api/log/${rec.seq}`);
    assert.equal(post.args[8], keccak256(stringToHex(rec.body)), "dataHash = keccak256 of exactly the record's body");
    const last = post.args[5] as { index: bigint; account: Address; cumStart: bigint; tickets: bigint };
    assert.deepEqual([last.index, last.cumStart + last.tickets], [119n, 120_000n], "the last leaf ends at the total");
    assert.ok(tk.verifyProof(post.args[6] as Hex[], list.root, tk.leafHash({ index: 119, account: last.account, cumStart: last.cumStart, tickets: last.tickets })));
    assert.deepEqual([list.paramsSeq, list.startBlock, list.endBlock, list.capBps], [params.seq, 601, 700, 200]);
    assert.ok(!list.leaves.some((l) => [d.feeVault.toLowerCase(), holder(500), holder(999)].includes(l.account)), "protocol contract, other token, after the end block: none");
    assert.deepEqual(tk.checkList(list, [d.feeVault]), []);
    const [intent] = await sql`select 1 from log where kind = 'tx' and ref = 'agent:game:postList'`;
    assert.ok(intent, "sent with the agent key");

    // posted: never again; settle once VRF delivered, with every leaf the 10-winner walk uses, in order
    reset();
    st.claims = st.ideaReserve + st.jackpotPot; // (synced by now: the keeper's sync is tested above)
    st.draw = Object.assign(NO_DRAW(), { 0: 4n, 1: T + H, 6: list.root });
    assert.equal(await jackpot.listTask(new Date(), T), "this window's list is posted");
    const rand = 999n;
    st.draw = Object.assign(NO_DRAW(), { 0: 4n, 1: T - 3 * H, 2: T - 2 * H, 3: T - H, 4: E / 10n, 5: 7n, 6: list.root, 7: 120_000n, 8: rand });
    st.excluded = [tk.pickWinners(list, rand).winners[3].toLowerCase()]; // excluded on chain since the list was built: settle skips it
    st.estimate = 500_000n; // what eth_estimateGas sees; a receiver can burn more at inclusion
    await games.gameKeeperHandlers["keeper:games"].run(job());
    st.estimate = 100_000n;
    const settled = st.sent.find((s) => s.fn === "settle")!;
    assert.equal(settled.gas, games.SETTLE_GAS_MIN, "a settle estimated at 500k is sent with exactly the floor: max(500k × 1.2, 1.8M), the floor applied once");
    const [leaves, proofs] = settled.args as [{ index: bigint; account: Address; cumStart: bigint; tickets: bigint }[], Hex[][]];
    const walk = tk.pickWinners(list, rand, new Set(st.excluded));
    assert.ok(walk.used.some((u) => u.skip === "excluded"));
    assert.deepEqual(leaves.map((l) => Number(l.index)), walk.used.map((u) => u.index), "exactly the walk's tickets, in order (the excluded one included)");
    leaves.forEach((l, k) => {
      const t = tk.ticketAt(rand, k, 120_000n);
      assert.ok(l.cumStart <= t && t < l.cumStart + l.tickets, `leaf ${k} holds ticket ${k}`);
      assert.ok(tk.verifyProof(proofs[k], list.root, tk.leafHash({ index: Number(l.index), account: l.account, cumStart: l.cumStart, tickets: l.tickets })));
    });
    assert.equal(walk.winners.length, 10);
    assert.ok(!walk.winners.map((w) => w.toLowerCase()).includes(st.excluded[0]));
    st.excluded = [];
    // a list that is not ours (the Safe posted it): no settle from us; void after DRAW_SETTLE_WINDOW
    reset();
    st.draw[6] = `0x${"77".repeat(32)}`;
    const o = await games.gameKeeperHandlers["keeper:games"].run(job()) as { fn: string; waiting?: string }[];
    assert.ok(o.some((x) => x.fn === "settle" && /no list record of ours/.test(x.waiting ?? "")) && !sentFns().includes("settle"));
    st.draw[3] = T - 7 * D;
    await games.gameKeeperHandlers["keeper:games"].run(job());
    assert.deepEqual(sentFns(), ["voidDraw"]);

    // the Safe cancelled the list: the same list is never re-posted
    reset();
    st.claims = st.ideaReserve + E;
    st.draw = NO_DRAW();
    // a cancel the finalized index hasn't caught up with yet: read live through the providers
    const cancelLog = { address: d.gamePot, topics: encodeEventTopics({ abi: abi.gamePotAbi, eventName: "ListCancelled", args: { window: 4n } }), data: "0x", blockNumber: toHex(705n), logIndex: "0x0",
      transactionHash: `0x${"ce".repeat(32)}`, transactionIndex: "0x0", blockHash: `0x${"cf".repeat(32)}`, removed: false };
    fakes.rpc.eth_getLogs = () => [cancelLog];
    try {
      assert.match(String(await jackpot.listTask(new Date(), T)), /not re-posting it unchanged/);
      assert.equal(st.sent.length, 0);
    } finally {
      delete fakes.rpc.eth_getLogs;
    }
    await chain(701, 0, ago(60), "ListCancelled", { window: "4" }, d.gamePot!);
    assert.match(String(await jackpot.listTask(new Date(), T)), /not re-posting it unchanged/);
    assert.equal(st.sent.length, 0);
    st.lastDrawnWindow = 4n;
    assert.equal(await jackpot.listTask(new Date(), T), "this window was drawn");
  } finally {
    Object.assign(jackpot.JACKPOT_DEPS, saved);
    Object.assign(st, { claims: st.ideaReserve });
    st.draw = NO_DRAW();
    st.lastDrawnWindow = 0n;
  }
});

test("jackpot list: skipped (recorded once) without params anchored before the window, below the minimum prize, or with no eligible holders", { skip }, async () => {
  reset();
  const W5 = { start: W4.end, end: T - H };
  Object.assign(st, { windowId: 6n, windowStart: W5.end, windowEnd: W5.end + D, draw: NO_DRAW() });
  await chain(710, 0, new Date(W5.start * 1000), "WindowRolled", { window: "5", start: String(W5.start), end: String(W5.end) }, d.gamePot!);
  const saved = { ...jackpot.JACKPOT_DEPS };
  Object.assign(jackpot.JACKPOT_DEPS, {
    windowBlocks: async () => ({ startBlock: 702, endBlock: 750, endBlockHash: `0x${"cd".repeat(32)}` }),
    exclusions: async () => [zeroAddress, d.feeVault.toLowerCase()],
  });
  const { record } = await import("../src/records.ts");
  try {
    assert.equal(await jackpot.listTask(new Date(), T), "no params were announced for this window");
    const p = await record("game", "jackpot:params:5", { kind: "jackpot-params", window: 5, start: W5.start, capBps: 100, minBalance: String(1_000_000n * E), cex: [], cexHash: tk.excludedHash([]), reasoning: "r", at: new Date().toISOString() });
    await record("game", "jackpot:params-anchor:5", { kind: "jackpot-params-anchor", window: 5, paramsSeq: p.seq, root: "0x", tx: null, status: "mined", blockTime: W5.start, at: new Date().toISOString() });
    assert.match(String(await jackpot.listTask(new Date(), T)), /not anchored before the window started/, "mined in the window's first block is too late");
    await record("game", "jackpot:params-anchor:5", { kind: "jackpot-params-anchor", window: 5, paramsSeq: p.seq, root: "0x", tx: null, status: "mined", blockTime: W5.start - 1, at: new Date().toISOString() });
    // the synced pot (arrivals counted as GamePot._sync would) must cover the minimum prize + the VRF top-up (SUB_MIN)
    Object.assign(st, { jackpotPot: jackpot.J.MIN_PRIZE + E / 100n - 1n, claims: jackpot.J.MIN_PRIZE + E / 100n - 1n + st.ideaReserve });
    assert.equal(await jackpot.listTask(new Date(), T), "pot below the minimum prize", "the pot must cover the minimum prize + the VRF top-up");
    Object.assign(st, { jackpotPot: 0n, claims: st.ideaReserve + E });
    assert.match(String(await jackpot.listTask(new Date(), T)), /no ticket level fits a 1% cap with 0 eligible wallets/, "nobody holds a 1,000,000 DNA average");
    assert.equal(st.sent.length, 0);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from log where kind = 'game' and ref = 'jackpot:list-skip:5'`;
    assert.equal(n, 1, "one skip record per window");
    // the cap rule, from the chain: the last POSTED draw (the newest ListPosted the cursor covers) had fewer than
    // 100 wallets → 2%, with that input in the params record so anyone can recompute it; a skipped window is no input
    reset();
    await sql`update cursor set block = 800`;
    await chain(760, 5, ago(H), "ListPosted", { window: "5", holders: "80", totalTickets: "1000" }, d.gamePot!);
    await chain(900, 5, ago(60), "ListPosted", { window: "6", holders: "500", totalTickets: "1000" }, d.gamePot!); // past the cursor: not read
    Object.assign(st, { windowId: 6n, windowStart: W5.end, windowEnd: T + 2 * H, drawInterval: D });
    assert.deepEqual(await jackpot.paramsTask(T), { window: 7, start: T + 2 * H, anchor: "mined" });
    const [p7] = await sql<{ doc: { capBps: number; reasoning: string; capInput: unknown } }[]>`select doc from log where kind = 'game' and ref = 'jackpot:params:7'`;
    assert.equal(p7.doc.capBps, 200);
    assert.deepEqual(p7.doc.capInput, { asOfBlock: 800, lastList: { window: 5, holders: 80, block: 760 } });
    assert.match(p7.doc.reasoning, /the last posted draw had 80 wallets, fewer than the 100 a 1% cap needs, so 2% until a draw has more/);
  } finally {
    Object.assign(jackpot.JACKPOT_DEPS, saved);
    Object.assign(st, { windowId: 0n, windowStart: 0, windowEnd: 0 }); // the agent tests below: no jackpot work
  }
});

// ---------------------------------------------------------------- agent tasks
async function swaps() {
  for (let i = 0; i < 6; i++) {
    const at = ago(H * (i + 1));
    const fee = { buy: true, exactInput: true, gross: String(E), project: String(E / 50n), platform: String(E / 1000n), pips: "20000" };
    await chain(100 + i, 0, at, "FeeTaken", fee);
    await chain(100 + i, 1, at, "Swap", { amount0: String(-E), amount1: "5", tick: String(i * 10) });
  }
  await sql`insert into cursor (id, block, hash, at) values (1, 200, '0x', ${new Date()}) on conflict (id) do update set block = 200, at = now()`;
}

test("games:agent: proposes a ballot of 3 gate-passing options (named, recorded with their descriptors before the proposal)", { skip }, async () => {
  reset();
  await swaps();
  const out = await games.gameAgentHandler.run(job()) as Record<string, unknown>;
  const p = st.sent.find((s) => s.fn === "propose")!;
  const rec = (await sql<{ doc: { options: { name: string; vector: number[]; descriptor: Hex }[]; descriptors: Hex[] } }[]>`select doc from log where kind = 'game' and ref = 'ballot:1'`)[0].doc;
  assert.deepEqual(p.args[0], rec.descriptors);
  assert.equal(rec.options.length, 3);
  for (const o of rec.options) assert.equal(games.descriptorOf({ name: o.name, vector: o.vector as [number, number, number] }), o.descriptor, "anyone can check a descriptor");
  assert.ok(out.ballot);
});

test("games:agent: a failing jackpot task is alerted and never holds back the ballot, mystery and interval tasks", { skip }, async () => {
  reset();
  st.reverts.windowId = "NotInitialized";
  try {
    const out = await games.gameAgentHandler.run(job()) as Record<string, unknown>;
    assert.match(String(out.jackpotList), /^error: /);
    assert.match(String(out.jackpotParams), /^error: /);
    assert.ok("ballot" in out && "mystery" in out && "interval" in out, "the other tasks ran");
    const [a] = await sql<{ n: number }[]>`select count(*)::int as n from job where kind = 'alert' and payload->>'text' like 'Jackpot list task failed%'`;
    assert.equal(a.n, 1);
  } finally {
    delete st.reverts.windowId;
  }
});

test("games:agent: no ballot while less than 1% of DNA is staked: the AI picks its own experiments", { skip }, async () => {
  reset();
  st.totalLocked = st.supply / 100n - 1n;
  const saved = [st.ballotCount, st.lastBallotAt];
  st.ballotCount = 0n;
  st.lastBallotAt = 0n;
  try {
    const out = await games.gameAgentHandler.run(job()) as Record<string, unknown>;
    assert.equal(out.ballot, games.VOTES_CLOSED);
    assert.ok(!sentFns().includes("propose"));
  } finally {
    st.totalLocked = 10n ** 25n;
    [st.ballotCount, st.lastBallotAt] = saved as [bigint, bigint];
  }
});

test("games:agent: at the ballot's end the winner is queued or, if it can't be, ballotSkipped with the reason's hash", { skip }, async () => {
  reset();
  st.ballotCount = 1n;
  st.lastBallotAt = BigInt(T - 4 * D);
  const descs = (await sql<{ doc: { descriptors: Hex[] } }[]>`select doc from log where kind = 'game' and ref = 'ballot:1' order by seq desc limit 1`)[0].doc.descriptors;
  st.ballots = { 1: [[`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, `0x${"03".repeat(32)}`], BigInt(T - 3 * D), BigInt(T - 60), false, false, [0n, 5n, 0n]] };
  st.winner = 1;
  // a ballot under the predicted id that someone else proposed: our record's descriptors are not on chain
  assert.match(String((await games.gameAgentHandler.run(job()) as { ballot: string }).ballot), /not ours/);
  assert.ok(!sentFns().some((f) => f.startsWith("ballot")), "no ballotRun / ballotSkipped for a ballot that is not ours");
  reset();
  st.ballots[1][0] = descs;
  // an experiment already runs: the winner can't be queued now
  await sql`insert into thread (id, kind, stage, data) values ('T-0099', 'fee', 'shadow', ${sql.json({ id: "T-0099", stage: "shadow" } as never)})`;
  await games.gameAgentHandler.run(job());
  const skipped = st.sent.find((s) => s.fn === "ballotSkipped")!;
  assert.equal(skipped.args[0], 1n);
  const rec = (await sql<{ doc: { result: { skipped: string } } }[]>`select doc from log where kind = 'game' and ref = 'ballot:1' order by seq desc limit 1`)[0].doc;
  assert.equal(skipped.args[1], keccak256(toHex(rec.result.skipped)));
  assert.match(rec.result.skipped, /already running/);
  await sql`delete from thread where id = 'T-0099'`;
  st.ballots = {};
  st.ballotCount = 0n;
});

test("games:agent: a retry after the board call failed resends ballotRun with the recorded op id; the winner is queued once", { skip }, async () => {
  reset();
  const descs = (await sql<{ doc: { descriptors: Hex[] } }[]>`select doc from log where kind = 'game' and ref = 'ballot:1' order by seq desc limit 1`)[0].doc.descriptors;
  // a second ballot of ours whose voting just ended
  const { record } = await import("../src/records.ts");
  const opts = (await sql<{ doc: { options: unknown[] } }[]>`select doc from log where kind = 'game' and ref = 'ballot:1' order by seq limit 1`)[0].doc.options;
  await record("game", "ballot:2", { kind: "ballot", descriptors: descs, options: opts, ballot: 2, at: new Date().toISOString() });
  st.ballotCount = 2n;
  st.ballots = { 2: [descs, BigInt(T - 3 * D), BigInt(T - 60), false, false, [5n, 0n, 0n]] };
  st.winner = 0;
  st.lastBallotAt = BigInt(T);
  const queued: unknown[] = [];
  const saved = games.GAME_DEPS.queueCandidate;
  games.GAME_DEPS.queueCandidate = async (c) => { queued.push(c.source); return { opId: "77", thread: "T-0077" }; };
  st.failEstimate = "ballotRun";
  try {
    await assert.rejects(games.gameAgentHandler.run(job()), /upstream unavailable/);
    assert.ok(!sentFns().includes("ballotRun"));
    const rec = (await sql<{ doc: { result: Record<string, unknown> } }[]>`select doc from log where kind = 'game' and ref = 'ballot:2' order by seq desc limit 1`)[0].doc;
    assert.deepEqual(rec.result, { option: 0, opId: "77", thread: "T-0077" }, "recorded before the board call");
    await games.gameAgentHandler.run(job());
    assert.deepEqual(st.sent.find((s) => s.fn === "ballotRun")?.args, [2n, 0, 77n]);
    assert.ok(!sentFns().includes("ballotSkipped"), "never a false 'failed the safety checks'");
    assert.deepEqual(queued, ["ballot 2"], "queued once");
  } finally {
    games.GAME_DEPS.queueCandidate = saved;
    st.failEstimate = undefined;
    st.ballots = {};
    st.ballotCount = 0n;
  }
});

test("games:agent: a Defer inside queueCandidate after the run was saved: the retry finds that run and sends ballotRun, never ballotSkipped", { skip }, async () => {
  reset();
  const { record } = await import("../src/records.ts");
  const { Defer } = await import("../src/jobs.ts");
  const [r1] = await sql<{ doc: { descriptors: Hex[]; options: unknown[] } }[]>`select doc from log where kind = 'game' and ref = 'ballot:1' order by seq limit 1`;
  await record("game", "ballot:3", { kind: "ballot", descriptors: r1.doc.descriptors, options: r1.doc.options, ballot: 3, at: new Date().toISOString() });
  st.ballotCount = 3n;
  st.ballots = { 3: [r1.doc.descriptors, BigInt(T - 3 * D), BigInt(T - 60), false, false, [0n, 0n, 5n]] };
  st.winner = 2;
  st.lastBallotAt = BigInt(T);
  const run = { id: "T-0091", stage: "queued_shadow", source: "ballot 3", ops: [] as string[] };
  let calls = 0;
  const saved = games.GAME_DEPS.queueCandidate;
  games.GAME_DEPS.queueCandidate = async () => {
    calls++;
    await sql`insert into thread (id, kind, stage, data) values (${run.id}, 'fee', ${run.stage}, ${sql.json(run as never)})`; // saved, then:
    throw new Defer(60_000, "gas guard: 90 gwei");
  };
  try {
    await assert.rejects(games.gameAgentHandler.run(job()), /gas guard/);
    await assert.rejects(games.gameAgentHandler.run(job()), /the winner's op is not queued yet/, "its own run, op still pending: wait, don't skip");
    // by now the run moved to its canary stage: ops holds SetCanary's id, allOps still starts with the ballot's op
    await sql`update thread set data = jsonb_set(jsonb_set(data, '{ops}', '["120"]'), '{allOps}', '["91", "120"]') where id = ${run.id}`;
    await games.gameAgentHandler.run(job());
    assert.deepEqual(st.sent.find((s) => s.fn === "ballotRun")?.args, [3n, 2, 91n]);
    assert.ok(!sentFns().includes("ballotSkipped"));
    assert.equal(calls, 1, "queued once");
  } finally {
    games.GAME_DEPS.queueCandidate = saved;
    await sql`delete from thread where id = ${run.id}`;
    st.ballots = {};
    st.ballotCount = 0n;
  }
});

test("games:agent: a revealed mystery of ours behind a later Run still gets its verdict", { skip }, async () => {
  reset();
  const salt = toHex(5n, { size: 32 }), payload = toHex('{"op":"SetParams","vector":[25000,0,25000]}');
  const c = games.commitmentOf(salt, payload);
  await games.storePreimage(c, salt, payload);
  st.mysteryCount = 6n;
  st.mysteries = { 5: [c, T - 2 * D, 2, agent], 6: [`0x${"cd".repeat(32)}`, T - D, 3, agent] };
  st.lastBallotAt = BigInt(T);
  const saved = games.GAME_DEPS.queueCandidate;
  games.GAME_DEPS.queueCandidate = async () => ({ opId: "95", thread: "T-0095" });
  try {
    await games.gameAgentHandler.run(job());
    assert.deepEqual(st.sent.find((s) => s.fn === "mysteryRun")?.args, [5n, 95n]);
  } finally {
    games.GAME_DEPS.queueCandidate = saved;
    st.mysteryCount = 0n;
    st.mysteries = {};
  }
});

test("games:agent: an older revealed mystery of ours behind a newer seal still gets its verdict", { skip }, async () => {
  reset();
  const salt = toHex(7n, { size: 32 }), payload = toHex('{"op":"SetParams","vector":[25000,0,25000]}');
  const c1 = games.commitmentOf(salt, payload);
  await games.storePreimage(c1, salt, payload);
  st.mysteryCount = 2n;
  st.pendingMystery = 2n;
  st.mysteries = { 1: [c1, T - 2 * D, 2, agent], 2: [`0x${"ab".repeat(32)}`, T + 6 * D, 1, agent] };
  st.lastBallotAt = BigInt(T);
  const saved = games.GAME_DEPS.queueCandidate;
  games.GAME_DEPS.queueCandidate = async () => ({ opId: "88", thread: "T-0088" });
  try {
    await games.gameAgentHandler.run(job());
    assert.deepEqual(st.sent.find((s) => s.fn === "mysteryRun")?.args, [1n, 88n]);
  } finally {
    games.GAME_DEPS.queueCandidate = saved;
    st.mysteryCount = 0n;
    st.pendingMystery = 0n;
    st.mysteries = {};
  }
});

test("games:agent: a sealed mystery (preimage kept sealed), the draw interval", { skip }, async () => {
  reset();
  for (let i = 0; i < 7; i++) await chain(300 + i, 0, ago(D * i + H), "FeeTaken", { project: String(E), gross: String(50n * E), pips: "20000", buy: true }); // 7 ETH in 7 d
  await chain(310, 0, ago(2 * D), "Synced", { arrived: String(7n * E / 10n), jackpotPot: "0", ideaReserve: "0", overflowBurned: "0" }); // 0.7 ETH arrived → 0.07 ETH/day to the jackpot
  st.lastBallotAt = BigInt(T); // no ballot this hour
  st.drawInterval = 3 * D; // set before the 24 h cap
  await games.gameAgentHandler.run(job());
  st.drawInterval = D;
  const seal = st.sent.find((s) => s.fn === "seal")!;
  const commitment = seal.args[0] as Hex;
  assert.equal(Number(seal.args[1]), T + 2 * D + H, "reveal = now + REVEAL_MIN (2 d) + 1 h");
  const pre = await games.loadPreimage(commitment);
  assert.ok(pre && games.commitmentOf(pre.salt, pre.payload) === commitment);
  const [{ v }] = await sql<{ v: string }[]>`select value as v from secret where key = ${`mystery:${commitment.toLowerCase()}`}`;
  assert.match(v, /^v1:/, "the preimage is sealed at rest");
  assert.ok(!JSON.stringify((await sql`select doc from log where kind = 'game'`).map((r) => r.doc)).includes(pre!.payload), "no payload in public records before the reveal");
  assert.deepEqual(st.sent.find((s) => s.fn === "proposeDrawInterval")?.args, [D], "0.07 ETH/day, a 3 d interval → down to the 24 h cap");
  const [iv] = await sql<{ seq: string }[]>`select seq::text from log where kind = 'game' and ref = 'interval' and (doc->>'interval')::int = ${D}`;
  const [itx] = await sql<{ seq: string }[]>`select seq::text from log where kind = 'tx' and ref = 'agent:game:proposeDrawInterval'`;
  assert.ok(iv && Number(iv.seq) < Number(itx.seq), "the interval decision is recorded before the call");
  reset();
  st.level = 4;
  assert.match(String(await games.gameAgentHandler.run(job())), /level < 5/);
  st.level = 5;
});

// ---------------------------------------------------------------- X and the indexer
test("X: a ballot under the predicted id that is not the one on chain gets no fact sheet", { skip }, async () => {
  const descs = (await sql<{ doc: { descriptors: Hex[] } }[]>`select doc from log where kind = 'game' and ref = 'ballot:1' order by seq limit 1`)[0].doc.descriptors;
  assert.deepEqual((await games.gameFacts({ name: "BallotProposed", args: { ballot: "1", options: descs } }))?.facts.votingHours, 24, "the contract's VOTING, not a literal");
  assert.equal(await games.gameFacts({ name: "BallotProposed", args: { ballot: "1", options: [`0x${"0a".repeat(32)}`, descs[1], descs[2]] } }), null);
});

test("announcements: idea rewards with their signed record as proof; ballot weights; mystery verdicts; prize expiry; the idea round's payout", { skip }, async () => {
  // an idea reward: the amount and the claim fallback; the proof is the reward record its ideaRef names (Anchored root)
  const to = "0x00000000000000000000000000000000000000c8", ref = `0x${"cd".repeat(32)}`;
  await chain(400, 0, ago(2 * H), "Anchored", { root: ref, uri: "https://genomedna.xyz/api/log/321" });
  await chain(401, 0, ago(2 * H), "RewardQueued", { id: "7", to, amount: String(E / 5n), ideaRef: ref, eta: String(T - H) });
  const paid = (await games.gameFacts({ name: "RewardPaid", args: { id: "7", to, amount: String(E / 5n), claimId: "0" } }))!;
  assert.deepEqual(paid.facts, { event: "reward_paid", reward: 7, rewardEth: 0.2, claimable: false, claim: 0, claimDays: 7 }, "no address in the fact sheet");
  assert.equal(paid.append, "proof https://genomedna.xyz/api/log/321");
  const failed = (await games.gameFacts({ name: "RewardPaid", args: { id: "7", to, amount: String(E / 5n), claimId: "12" } }))!.facts;
  assert.deepEqual([failed.claimable, failed.claim], [true, 12]);
  assert.equal((await games.gameFacts({ name: "RewardPaid", args: { id: "8", to, amount: String(E / 5n), claimId: "0" } }))!.append, undefined, "no queue indexed: no proof link");
  // ballot weights from the on-chain tallies
  const descs = (await sql<{ doc: { descriptors: Hex[] } }[]>`select doc from log where kind = 'game' and ref = 'ballot:1' order by seq limit 1`)[0].doc.descriptors;
  st.ballots = { 1: [descs, 0n, 0n, false, true, [10n ** 22n, 3n * 10n ** 22n, 0n]] };
  const reads = { n: 0 }, viewBallots = VIEW.ballots;
  VIEW.ballots = (a) => (reads.n++, viewBallots(a));
  const b = (await games.gameFacts({ name: "BallotRun", args: { ballot: "1", option: 1, registryOpId: "5" } }))!.facts;
  VIEW.ballots = viewBallots;
  assert.deepEqual([b.ballot, b.winnerWeight, b.totalWeight], [1, 30_000, 40_000]);
  assert.equal(reads.n, 1, "the ballot is read once");
  st.ballots = {};
  // a mystery verdict with its reason as a fixed phrase (the raw reason had a threshold)
  const { record } = await import("../src/records.ts");
  await record("game", "mystery:41", { kind: "mystery-result", result: { skipped: "gates failed: retention 45% < 70%" }, at: new Date().toISOString() });
  assert.deepEqual((await games.gameFacts({ name: "Rejected", args: { mystery: "41", reasonHash: "0x" } }))!.facts, { event: "mystery_result", mystery: 41, outcome: "rejected", reason: "failed the safety checks" });
  assert.deepEqual((await games.gameFacts({ name: "PrizeExpired", args: { drawId: "3", amount: String(E / 10n) } }))!.facts, { event: "prize_expired", drawId: 3, prizeEth: 0.1, claimDays: 7 });
  // the idea round: 2 of 4 accepted; rejected stake 30,000 over accepted stake 80,000 = +37.5%; the report link appended
  await record("report", "round:6", { round: 6, ideas: [], at: new Date().toISOString() });
  const r = (await games.gameFacts({ name: "RoundFinalized", args: { round: "6", accepted: "5", voided: "0", acceptedStake: String(80_000n * E), rejectedStake: String(30_000n * E), expired: false } }))!;
  assert.deepEqual(r.facts, { event: "idea_round", round: 6, accepted: 2, ideas: 4, refunded: false, payoutPct: 37.5 });
  assert.match(r.append!, /^report https:\/\/genomedna\.xyz\/api\/log\/\d+$/);
  assert.equal((await games.gameFacts({ name: "RoundFinalized", args: { round: "6", accepted: "0", voided: "0", acceptedStake: "0", rejectedStake: String(E), expired: true } }))!.facts.refunded, true);
});

test("X: a jackpot draw posts the winners and the share from the fact sheet; code appends the proof page and the tx link; the site line names every winner", { skip }, async () => {
  const winner = "0x00000000000000000000000000000000000000c1", other = "0x00000000000000000000000000000000000000c2";
  const h = `0x${"ab".repeat(32)}` as Hex;
  const paid = [{ window: 9n, rank: 0n, account: winner, share: E / 20n, prizeId: 0n }, { window: 9n, rank: 1n, account: other, share: E / 20n, prizeId: 4n }];
  await xM.onChainEvent({ eventName: "Drawn", args: { window: 9n, rand: 77n, prize: E / 2n, share: E / 20n, winners: 2n, ticketsUsed: 3n, paid }, transactionHash: h, logIndex: 0 });
  const r = await xM.sendHandler.run(job()) as { tweetId: string };
  assert.ok(r.tweetId);
  const post = fakes.calls.findLast((c) => c.path === "/2/tweets")!.body.text as string;
  assert.equal(post, `Jackpot window 9 drawn: 2 winners, 0.05 ETH each (0.1 ETH in all). 1 prize can be claimed within 7 days.\nproof https://genomedna.xyz/play/draw/9\nhttps://etherscan.io/tx/${h}`, "the proof page (every winner's full address) and the tx, appended by code");
  const [rec] = await sql<{ doc: { facts: Record<string, unknown> } }[]>`select doc from log where kind = 'x_post' and doc->>'status' = 'attempt' order by seq desc limit 1`;
  const { bounds: _, day: _d, first: _f, earlier: _e, hoursSinceLaunch: _h, ...facts } = rec.doc.facts;
  assert.deepEqual(facts, { event: "jackpot_drawn", window: 9, winners: 2, shareEth: 0.05, prizeEth: 0.1, claimable: 1, claimDays: 7 }, "paid out = share × winners; the unfilled ranks went back to the pot");
  const [ann] = await sql<{ doc: { title: string; proof: string } }[]>`select doc from log where kind = 'announce' and ref = ${`Drawn:${h}:0`}`;
  assert.equal(ann.doc.title, `Jackpot window 9: 2 winners, 0.05 ETH each: ${winner}, ${other}; 1 claimable for 7 days`);
  assert.equal(ann.doc.proof, "https://genomedna.xyz/play/draw/9");
});

test("indexer: GamePot, ConvictionVault and MutationBoard events land in chain_log (finalized, decoded)", { skip }, async () => {
  const { finalizedTier } = await import("../src/indexer.ts");
  const saved = { blk: fakes.rpc.eth_getBlockByNumber, logs: fakes.rpc.eth_getLogs, call: fakes.rpc.eth_call, bal: fakes.rpc.eth_getBalance };
  const block = (n: bigint) => ({ ...(saved.blk as () => Record<string, unknown>)(), number: toHex(n), hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: toHex(1_700_000_000n + n * 12n) });
  const log = (address: string, a: readonly unknown[], eventName: string, args: Record<string, unknown>, data: Hex, li: number) => ({
    address, topics: encodeEventTopics({ abi: a as Abi, eventName, args } as never), data, blockNumber: toHex(70n), logIndex: toHex(li),
    transactionHash: `0x${"cd".repeat(31)}${li.toString(16).padStart(2, "0")}`, transactionIndex: "0x0", blockHash: `0x${(70n).toString(16).padStart(64, "0")}`, removed: false,
  });
  const winner = "0x00000000000000000000000000000000000000c1";
  const filters: { address: string | string[]; topics?: unknown[] }[] = [];
  Object.assign(fakes.rpc, {
    eth_getBlockByNumber: ([tag]: [string]) => block(tag === "finalized" ? 70n : BigInt(tag)),
    eth_getBalance: () => "0x0",
    eth_call: () => encodeAbiParameters([{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }], [Array.from({ length: 34 }, () => [true, `0x${"00".repeat(1024)}`] as const)]),
    eth_getLogs: ([f]: [{ address: string | string[]; topics?: unknown[] }]) => (filters.push(f), !Array.isArray(f.address)) ? [] : [
      log(d.gamePot!, abi.gamePotAbi, "Drawn", { window: 9n }, encodeAbiParameters(Array.from({ length: 5 }, () => ({ type: "uint256" })), [77n, E / 10n, E / 100n, 10n, 12n]), 0),
      log(d.convictionVault!, abi.convictionVaultAbi, "Locked", { id: 4n, owner: winner }, encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }, { type: "uint256" }], [10n ** 22n, 1, 15n * 10n ** 21n]), 1),
      log(d.mutationBoard!, abi.mutationBoardAbi, "Sealed", { mystery: 1n, by: winner }, encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [`0x${"cd".repeat(32)}`, 1_800_000_000n]), 2),
    ],
  });
  await sql`delete from cursor`; // the agent tests' synthetic cursor is not on this fake chain (the reorg guard would exit)
  try {
    await finalizedTier();
    const rows = await sql<{ event: string; args: Record<string, string> }[]>`select event, args from chain_log where block = 70 order by log_index`;
    assert.deepEqual(rows.map((r) => r.event), ["Drawn", "Locked", "Sealed"]);
    const tokenQuery = filters.find((f) => typeof f.address === "string" && f.address.toLowerCase() === d.token.toLowerCase())!;
    assert.deepEqual(tokenQuery.topics, [encodeEventTopics({ abi: abi.tokenAbi, eventName: "Transfer" })[0]], "every DNA Transfer, not only burns (the jackpot rebuilds balances from them)");
    assert.deepEqual([rows[0].args.prize, rows[0].args.share, rows[0].args.winners, rows[0].args.ticketsUsed], [String(E / 10n), String(E / 100n), "10", "12"]);
    assert.deepEqual([rows[1].args.id, rows[1].args.tier], ["4", 1]);
    assert.equal(rows[2].args.commitment, `0x${"cd".repeat(32)}`);
    const [{ g }] = await sql<{ g: Record<string, unknown> }[]>`select value->'game' as g from state where key = 'chain'`;
    assert.deepEqual(Object.keys(g).sort(), ["board", "pot", "vault"]);
  } finally {
    Object.assign(fakes.rpc, { eth_getBlockByNumber: saved.blk, eth_getLogs: saved.logs, eth_call: saved.call, eth_getBalance: saved.bal });
  }
});

// the indexer keeps the last finalized block it took (module state): a later indexer test needs finalized > 90 and deletes the cursor
test("indexer: a window with more logs than one insert can bind (8 parameters a row, 65535 a statement) lands whole", { skip }, async () => {
  const { finalizedTier } = await import("../src/indexer.ts");
  const saved = { blk: fakes.rpc.eth_getBlockByNumber, logs: fakes.rpc.eth_getLogs, call: fakes.rpc.eth_call, bal: fakes.rpc.eth_getBalance };
  const block = (n: bigint) => ({ ...(saved.blk as () => Record<string, unknown>)(), number: toHex(n), hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: toHex(1_700_000_000n + n * 12n) });
  const N = 9_000;
  const from = "0x00000000000000000000000000000000000000a1", to = "0x00000000000000000000000000000000000000b2";
  const transfer = (li: number) => ({
    address: d.token, topics: encodeEventTopics({ abi: abi.tokenAbi, eventName: "Transfer", args: { from, to } } as never), data: encodeAbiParameters([{ type: "uint256" }], [BigInt(li + 1)]),
    blockNumber: toHex(90n), logIndex: toHex(li), transactionHash: `0x${li.toString(16).padStart(64, "0")}`, transactionIndex: "0x0", blockHash: `0x${(90n).toString(16).padStart(64, "0")}`, removed: false,
  });
  Object.assign(fakes.rpc, {
    eth_getBlockByNumber: ([tag]: [string]) => block(tag === "finalized" ? 90n : BigInt(tag)),
    eth_getBalance: () => "0x0",
    eth_call: () => encodeAbiParameters([{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }], [Array.from({ length: 34 }, () => [true, `0x${"00".repeat(1024)}`] as const)]),
    eth_getLogs: ([f]: [{ address: string | string[] }]) => typeof f.address === "string" && f.address.toLowerCase() === d.token.toLowerCase() ? Array.from({ length: N }, (_, li) => transfer(li)) : [],
  });
  await sql`delete from cursor`;
  try {
    await finalizedTier();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from chain_log where block = 90 and event = 'Transfer'`;
    assert.equal(n, N);
    const [{ block: cur }] = await sql<{ block: string }[]>`select block from cursor`;
    assert.equal(Number(cur), 90, "the cursor moves past the window");
  } finally {
    Object.assign(fakes.rpc, { eth_getBlockByNumber: saved.blk, eth_getLogs: saved.logs, eth_call: saved.call, eth_getBalance: saved.bal });
  }
});
