// Engine end-to-end (called by e2e.sh after the indexer/web phases, with the indexer loop still running):
//   dry_run: keepers only estimate (chain unchanged) → live: distribute / process / add / execute land; the agent key
//   queues SetShadow + SetCanary for the reverting dev module, the keeper executes them; swaps fail the canary 3× →
//   the watcher trips → keeper's permissionless rollback; IdeaMarket finalize + BountyBoard expire; daily anchor →
//   Anchored indexed → verify-log passes and /api/log/<day> serves the anchored head; the agent's queued op posted by
//   the X pipeline (fact sheet → writer → filter → tx link); Telegram approval → X post (fakes); X mentions stored, a
//   reply (category only) and an opt-out; /halt. Telegram, X and LLMs are local fakes (scripts/fakes.ts): no real keys.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { promisify } from "node:util";
import postgres from "postgres";
import { type Address, createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, type Hex, http, keccak256, parseAbi, parseAbiParameters, parseEther, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import * as abi from "../src/abi.ts";
import { encodeOp } from "../src/lib.ts";
import { ownerDigestOn, targetOf } from "../src/owner-sig.ts";
import { startFakes } from "./fakes.ts";
import { synthetic } from "./synthetic.ts";
import { WINNERS } from "../src/tickets.ts";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:18545";
const WEB = process.env.WEB ?? "http://127.0.0.1:3078";
const LOGS = process.env.LOGS ?? "/tmp";
const ROOT = new URL("../../", import.meta.url).pathname;
const HEALTH = "http://127.0.0.1:18090/health";
const d = JSON.parse(readFileSync(new URL("../deployments/31337.json", import.meta.url), "utf8")) as Record<string, Address>;
// anvil default keys (public test keys): 0 Safe, 2 agent, 3 anchor key, 5 keeper
const KEY = {
  safe: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  anchor: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  keeper: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
} as const;
const keeperAddr = privateKeyToAccount(KEY.keeper).address;

const sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
const pub = createPublicClient({ chain: foundry, transport: http(RPC), cacheTime: 0 });
const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: foundry, transport: http(RPC) });
const fakes = await startFakes();
// no model keys in CI: the fakes answer every LLM call with SYNTHETIC schema-valid outputs (scripts/synthetic.ts)
fakes.llm.xai = (b) => synthetic("xai", b);
fakes.llm.anthropic = (b) => synthetic("anthropic", b);

const rpc = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
const mine = (n = 2) => rpc("anvil_mine", [`0x${n.toString(16)}`]);
const travel = async (s: number) => { await rpc("evm_increaseTime", [`0x${s.toString(16)}`]); await mine(1); };
const read = <T>(address: Address, a: readonly unknown[], functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi: a as never, functionName, args } as never) as Promise<T>;
/** Send a setup tx and require it to succeed: a reverted setup must never look like a keeper bug. */
async function ok(what: string, h: Promise<Hex>) {
  const r = await pub.waitForTransactionReceipt({ hash: await h });
  assert.equal(r.status, "success", `${what} reverted`);
}
const status = async (m: Address) => (await read<{ status: number }>(d.registry, abi.registryAbi, "getModule", [m])).status;
const claims = (o: Address) => read<bigint>(d.poolManager, abi.poolManagerAbi, "balanceOf", [o, 0n]);
async function until<T>(what: string, fn: () => Promise<T | undefined | false | null>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
const txRecord = (purpose: string, mode: string, status?: string) =>
  sql`select doc from log where kind = 'tx' and ref = ${purpose} and doc->>'mode' = ${mode} ${status ? sql`and doc->>'status' = ${status}` : sql``} order by log.seq desc limit 1`.then((r) => r[0]?.doc);
const tgTexts = () => fakes.calls.filter((c) => c.path.endsWith("/sendMessage")).map((c) => String(c.body.text));

const env = {
  ...process.env, CHAIN_ID: "31337", RPC_URL: RPC, PORT: "18090",
  AGENT_PRIVATE_KEY: KEY.agent, ANCHOR_PRIVATE_KEY: KEY.anchor, KEEPER_PRIVATE_KEY: KEY.keeper,
  KEEPER_INTERVAL_MS: "2000", EXECUTE_INTERVAL_MS: "2000", SCHEDULER_MS: "1000", WATCH_POLL_MS: "300", TX_POLL_MS: "200",
  TELEGRAM_API_BASE: fakes.url, TELEGRAM_BOT_TOKEN: "e2e", TELEGRAM_GROUP_ID: "-100", TELEGRAM_ALLOWED_USER_IDS: "7", TELEGRAM_POLL_TIMEOUT_S: "1",
  X_API_BASE: fakes.url, X_CLIENT_ID: "cid", X_REFRESH_TOKEN: "seed", X_USER_ID: "42", X_AI_REPLIES_APPROVED: "1", X_MENTIONS_INTERVAL_MS: "2000", X_SEND_INTERVAL_MS: "2000", X_POST_SPACING_MIN: "0", // no 20-min gap: the run must not depend on the time of day (a 23:00 digest)
  SECRET_SEAL_KEY: "11".repeat(32), // test-only seal key (src/sealed.ts local provider)
  XAI_API_BASE: fakes.url, OPENROUTER_API_BASE: fakes.url, LLM_MODE: "live", XAI_API_KEY: "synthetic", OPENROUTER_API_KEY_ENGINE: "synthetic", LOG_BASE_URL: WEB,
  // agent loop on a devchain clock: no shadow wait, a long canary (the kill condition ends it), small windows/samples,
  // the simulator forks this anvil; the daily cycle only runs when enqueued
  AGENT_LOOP: "0", SHADOW_HOURS: "0", CANARY_HOURS: "1000", CANARY_PERIOD_BLOCKS: "100", CANARY_LEN_BLOCKS: "50",
  KILL_MIN_SWAPS: "3", KILL_WINDOW_HOURS: "48", GATE_MIN_SWAPS: "3", MIN_SHADOW_SAMPLES: "0", MIN_CANARY_SAMPLES: "0",
  // the 4 devchain swaps move ticks hard (volEma large): loosen the cap-share and retention gates here, they are unit-tested
  GATE_MAX_CAP_SHARE: "1", GATE_MIN_RETENTION: "0.5", SIM_FORK_RPC_URL: RPC, MAX_AGENT_QUEUE_PER_DAY: "20",
  IDEA_OUTCOME_DELAY_MS: "0", // an outcome report is in effect at once (its public hour and the vetoes are unit-tested)
};

let engine: ReturnType<typeof spawn> | undefined;
function startEngine(mode: string, extra: Record<string, string> = {}, log = mode) {
  const out = createWriteStream(`${LOGS}/engine-${log}.log`);
  engine = spawn(process.execPath, ["src/engine.ts"], { cwd: `${ROOT}engine`, stdio: ["ignore", "pipe", "pipe"], env: { ...env, ENGINE_MODE: mode, ...extra } });
  engine.stdout!.pipe(out);
  engine.stderr!.pipe(out);
  return until("engine /health", async () => (await fetch(HEALTH)).ok);
}
async function stopEngine() {
  const e = engine!;
  const done = new Promise((r) => e.once("exit", r));
  e.kill("SIGTERM");
  await done;
}
// async: the fakes live in this process, so a sync child call that talks to them would deadlock
const engineCli = async (...args: string[]) => (await promisify(execFile)(process.execPath, ["src/engine.ts", ...args], { cwd: `${ROOT}engine`, env: { ...env, ENGINE_MODE: "live" }, encoding: "utf8" })).stdout;
const devchain = (...fns: string[]) => execFileSync(`${ROOT}engine/scripts/devchain.sh`, ["dev", ...fns], { env: { ...process.env, RPC_URL: RPC }, stdio: "inherit" });

try {
  // ---------------------------------------------------------------- setup: a due Safe op + fees in FeeVault
  const [{ bad }] = await sql<{ bad: Address }[]>`select args->>'canary' as bad from chain_log where event = 'RolledBack' limit 1`;
  assert.equal(await status(bad), 6, "dev reverting module starts RolledBack");
  const spec = keccak256(readFileSync(new URL("../modules/dev-reverting-fee-v0.json", import.meta.url)));
  const z4 = Array(4).fill(`0x${"00".repeat(32)}`);
  const reg = encodeOp("Register", [bad, 0, spec, z4, z4, z4]);
  await ok("Safe queue Register", wallet(KEY.safe).writeContract({ address: d.registry, abi: abi.registryAbi, functionName: "queue", args: [reg.op, reg.data] }));
  const registerId = await read<bigint>(d.registry, abi.registryAbi, "nextId");
  console.log(`  Safe queued Register(dev reverting module) as op #${registerId}`);
  await travel(4 * 3600); // Register due (1 h); process (1 h) / add (4 h) cooldowns over
  const feeClaims = await claims(d.feeVault);
  assert.ok(feeClaims >= parseEther("0.05"), `FeeVault has ${feeClaims} claims`);

  // ---------------------------------------------------------------- dry_run: estimates only
  console.log("· engine dry_run");
  await startEngine("dry_run");
  await until("dry-run distribute", () => txRecord("keeper:distribute", "dry_run", "dry_run"));
  await until("dry-run execute", () => txRecord("keeper:execute", "dry_run", "dry_run"));
  assert.equal((await (await fetch(HEALTH)).json()).mode, "dry_run");
  assert.equal(await claims(d.feeVault), feeClaims, "dry_run moved nothing");
  assert.notEqual((await read<readonly unknown[]>(d.registry, abi.registryAbi, "queued", [registerId]))[2], 0n, "op still queued");
  assert.equal((await sql`select count(*)::int as n from log where kind = 'tx' and doc->>'mode' = 'live'`)[0].n, 0);
  await stopEngine();

  // ---------------------------------------------------------------- live keepers
  console.log("· engine live");
  const [lastProcess, lastAdd] = await Promise.all([read<bigint>(d.buybackBurn, abi.buybackBurnAbi, "lastProcess"), read<bigint>(d.liquidityVault, abi.liquidityVaultAbi, "lastAdd")]);
  await startEngine("live");
  assert.equal((await (await fetch(HEALTH)).json()).mode, "live"); // the env change cleared nothing (no override) and went live
  await until("Register executed", async () => (await status(bad)) === 1);
  await until("distribute mined", () => txRecord("keeper:distribute", "live", "mined"));
  assert.ok((await claims(d.feeVault)) < parseEther("0.05"));
  await until("buyback processed", async () => (await read<bigint>(d.buybackBurn, abi.buybackBurnAbi, "lastProcess")) > lastProcess);
  await until("liquidity added", async () => (await read<bigint>(d.liquidityVault, abi.liquidityVaultAbi, "lastAdd")) > lastAdd);
  assert.equal((await txRecord("keeper:process", "live", "mined")).from, keeperAddr);

  // ---------------------------------------------------------------- agent ops → keeper executes → breaker → rollback
  await engineCli("enqueue", "registry:queue", JSON.stringify({ op: "SetShadow", args: [bad] }));
  await until("agent queued SetShadow", () => txRecord("agent:queue:SetShadow", "live", "mined"));
  await until("Queued alert", async () => tgTexts().find((t) => t.includes("SetShadow(") && t.includes("Executable by anyone")));
  await travel(3600);
  await until("SetShadow executed", async () => (await status(bad)) === 2);
  const start = await pub.getBlockNumber();
  await engineCli("enqueue", "registry:queue", JSON.stringify({ op: "SetCanary", args: [bad, Number(start), 1000, 500] }));
  await until("agent queued SetCanary", () => txRecord("agent:queue:SetCanary", "live", "mined"));
  await travel(3600);
  await until("SetCanary executed", async () => (await status(bad)) === 3);
  await until("Executed alert", async () => tgTexts().find((t) => t.startsWith("⚠ Executed") && t.includes("our keeper key")));
  console.log("· failing canary swaps");
  devchain("swaps", "swaps"); // 4 module calls in the canary window, each fails
  await until("keeper rollback", async () => (await status(bad)) === 6, 90_000);
  const rb = await until("rollback tx record", () => txRecord("keeper:rollback", "live", "mined"));
  assert.equal(rb.from, keeperAddr);
  const rbLog = await pub.getContractEvents({ address: d.registry, abi: abi.registryAbi, eventName: "RolledBack", fromBlock: start });
  assert.equal(rbLog.at(-1)!.args.by, keeperAddr);
  assert.ok(tgTexts().some((t) => t.includes("Breaker tripped")));
  assert.ok(tgTexts().some((t) => t.includes("ModuleFailed")));

  // ---------------------------------------------------------------- IdeaMarket finalize + BountyBoard expire
  const agent = wallet(KEY.agent);
  await ok("agent IdeaMarket.submit", agent.writeContract({ address: d.ideaMarket, abi: abi.ideaMarketAbi, functionName: "submit", args: ["e2e idea", "body", 0n] }));
  const now = (await pub.getBlock()).timestamp;
  await ok("agent BountyBoard.propose", agent.writeContract({ address: d.bountyBoard, abi: abi.bountyBoardAbi, functionName: "propose", args: [1n, now + 3600n, "e2e bounty", "", []] }));
  const round = await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "currentRound");
  const end = await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "roundEnd", [round]);
  await travel(Number(end - (await pub.getBlock()).timestamp) + 60); // round closed (≥ 1 h: the bounty's deadline passes too)
  await ok("agent IdeaMarket.proposeOutcome", agent.writeContract({ address: d.ideaMarket, abi: abi.ideaMarketAbi, functionName: "proposeOutcome", args: [round, 0n, 1n, `0x${"ab".repeat(32)}`, "e2e"] }));
  await until("bounty expired", async () => (await read<readonly [bigint, bigint, number]>(d.bountyBoard, abi.bountyBoardAbi, "bounties", [1n]))[2] === 5);
  await travel(86_400);
  await until("round finalized", async () => (await read<readonly [number]>(d.ideaMarket, abi.ideaMarketAbi, "rounds", [round]))[0] === 2);

  // ---------------------------------------------------------------- daily anchor → indexed → verify
  const day = new Date().toISOString().slice(0, 10);
  await engineCli("enqueue", "anchor", JSON.stringify({ day }));
  const anchored = await until("anchor record", async () => (await sql`select doc from log where kind = 'anchor' and ref = ${day} and doc->>'mode' = 'live'`)[0]?.doc);
  await engineCli("enqueue", "anchor", JSON.stringify({ day })); // idempotent: a second run is a no-op
  await mine(3);
  await until("Anchored indexed", async () => (await sql`select 1 from chain_log where event = 'Anchored' and args->>'root' = ${anchored.root}`).length);
  const verify = execFileSync(process.execPath, ["scripts/verify-log.ts"], { cwd: `${ROOT}engine`, env: process.env, encoding: "utf8" });
  assert.match(verify, /log OK: \d+ records, head 0x[0-9a-f]{64}; 1\/1 anchors match/);
  const page = await (await fetch(`${WEB}/api/log/${day}`)).json();
  assert.ok(page.records.some((r: { hash: string; seq: string }) => r.hash === anchored.root && r.seq === anchored.seq), "/api/log/<day> serves the anchored head");
  assert.equal(anchored.uri, `${WEB}/api/log/${day}`);
  assert.ok(!tgTexts().some((t) => t.includes("UNEXPECTED Anchored")));
  assert.equal((await sql`select count(*)::int as n from log where kind = 'anchor' and ref = ${day}`)[0].n, 1);

  // ---------------------------------------------------------------- X pipeline; Telegram approval → X post; mentions; /halt
  // the engine's queued op was posted on its own: fact sheet → code's template (no writer) → filter → the tx link
  const auto = await until("pipeline post", async () => fakes.calls.find((c) => c.path === "/2/tweets" && /^Queued[ .][^\n]*\nhttps:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}$/.test(String(c.body.text))));
  assert.ok(!auto.body.reply, "a state-change post is not a reply");
  assert.ok((await sql`select 1 from log where kind = 'x_post' and doc->>'status' = 'attempt' and doc->'facts'->>'event' = 'queued' and doc->>'model' = 'code'`).length, "code wrote it from the fact sheet");
  const text = "Breaker tripped on a dev canary; the keeper rolled the fee route back to baseline. $DNA";
  const draftId = (await engineCli("draft", "x_post", JSON.stringify({ text }))).trim().split(" ")[1];
  await until("draft message", async () => tgTexts().find((t) => t.startsWith(`Draft #${draftId}`) && t.includes(text)));
  const cb = (update_id: number, from: number) => ({ update_id, callback_query: { id: `q${update_id}`, from: { id: from }, message: { message_id: 1, chat: { id: -100 } }, chat_instance: "1", data: `d:${draftId}:a` } });
  fakes.tgUpdates.push(cb(1, 666)); // not allowlisted
  await until("rejected press answered", async () => fakes.calls.find((c) => c.path.endsWith("/answerCallbackQuery") && c.body.text === "not allowed"));
  fakes.tgUpdates.push(cb(2, 7)); // allowlisted, but a press approves nothing
  await until("press refused", async () => fakes.calls.find((c) => c.path.endsWith("/answerCallbackQuery") && /needs a Safe owner's signature/.test(String(c.body.text))));
  assert.equal((await sql`select status from draft where id = ${draftId}`)[0].status, "pending");
  // a Safe owner signs the draft's pending record and sends /approve <seq> <signature>. The devchain's "Safe" is an EOA
  // (anvil key 0): give it, for this step only, code answering getOwners() = [OWNER], finalized (head - 2) before use.
  const OWNER = privateKeyToAccount(`0x${"0".repeat(63)}1`);
  await rpc("anvil_setCode", [d.safe, `0x6020600052600160205273${OWNER.address.slice(2).toLowerCase()}60405260606000f3`]);
  await mine(3);
  const [pend] = await sql<{ seq: string; kind: string; ref: string; body: string }[]>`select seq::text, kind, ref, body from log where kind = 'draft' and ref = ${draftId} and doc->>'status' = 'pending'`;
  const digest = ownerDigestOn("approve", targetOf(pend), { chainId: 31337, safe: d.safe, enclave: `0x${"00".repeat(20)}` }); // a plain build: no log key
  fakes.tgUpdates.push({ update_id: 4, message: { message_id: 4, chat: { id: -100 }, from: { id: 7 }, text: `/approve ${pend.seq} ${await OWNER.signMessage({ message: { raw: `0x${digest}` } })}` } });
  const tweet = await until("X post", async () => fakes.calls.find((c) => c.path === "/2/tweets" && c.body.text === text));
  assert.deepEqual(tweet.body, { text });
  await until("draft done", async () => (await sql`select status from draft where id = ${draftId}`)[0].status === "done");
  assert.ok(tgTexts().some((t) => t.startsWith(`draft #${draftId} approved by Safe owner ${OWNER.address.toLowerCase()}`)));
  await rpc("anvil_setCode", [d.safe, "0x"]); // the Safe is a plain EOA again (it sends txs below)
  await mine(1);
  fakes.mentions.push({ id: "1001", text: "how does the jackpot work? @contractdna", author_id: "77" }, { id: "1002", text: "stop", author_id: "78" }); // not ideas: the intake skips them
  await until("mention stored", async () => (await sql`select 1 from x_mention where id = '1001'`).length);
  // a reply (in_reply_to the mention; the writer never saw the mention text); "stop" opts its author out
  const reply = await until("reply", async () => fakes.calls.find((c) => c.path === "/2/tweets" && c.body.reply?.in_reply_to_tweet_id === "1001"));
  // a reply is measured against earlier replies only (none yet), so the synthetic second candidate goes
  assert.equal(reply.body.text, "Synthetic post about a reply event.");
  assert.ok((await sql`select 1 from log where kind = 'x_post' and doc->>'status' = 'attempt' and doc->>'text' = ${reply.body.text} and doc->>'author' = '77'
    and doc->>'shape' is not null`).length, "the reader's X id and the shape are in the signed record"); // replies carry a shape (deadpan, roast …), no format
  await until("opt-out", async () => (await sql`select 1 from x_optout where author_id = '78'`).length);
  assert.ok(!fakes.calls.some((c) => c.path === "/2/tweets" && c.body.reply?.in_reply_to_tweet_id === "1002"));
  fakes.tgUpdates.push({ update_id: 5, message: { message_id: 5, chat: { id: -100 }, from: { id: 7 }, text: "/halt" } });
  await until("halted", async () => (await (await fetch(HEALTH)).json()).mode === "halted");
  await stopEngine();
  console.log("ENGINE E2E PASS (2A)");
  await agentLoop();
  await fastLoop();
  await money();
  await ideaReward();
  console.log("ENGINE E2E PASS");
} catch (e) {
  if (engine && engine.exitCode === null) await stopEngine();
  console.error(e);
  // diagnostics: the agent loop's last reasoning steps, unfinished/failed jobs, the last tx records, the engine's own log
  console.error((await sql`select doc->>'text' as t from log where kind = 'step' order by seq desc limit 6`).map((r) => `step: ${r.t}`).join("\n"));
  console.error(await sql`select kind, status, count(*)::int as n, min(run_at) as oldest from job group by 1, 2 order by 1, 2`);
  console.error(await sql`select id, kind, status, attempts, run_at, left(last_error, 300) as err from job where status <> 'done' or last_error is not null order by id desc limit 20`);
  console.error((await sql`select seq, ref, body from log where kind = 'tx' order by log.seq desc limit 10`).map((r) => `${r.seq} ${r.ref} ${r.body}`).join("\n"));
  for (const m of ["dry_run", "live", "fast", "money", "reward"]) { try { console.error(`--- engine-${m}.log\n${readFileSync(`${LOGS}/engine-${m}.log`, "utf8").slice(-4000)}`); } catch { /* phase not reached */ } }
  process.exitCode = 1;
} finally {
  await sql.end();
  await fakes.close();
}

// ================================================================ phase 2B: the agent loop
//   observe → candidate → sim (fork of this anvil) → red team (synthetic) → SetParams + SetShadow → +1 h → executed
//   → Fable → SetCanary → +1 h → executed → swaps only outside the canary window → kill condition → endCanary;
//   X mention → idea filter (gate, screen) → next round: submit → round closes → research → brain outcome → delayed report → proposeOutcome → +24 h (IdeaMarket veto)
//   → finalize → XP; journal → X draft → approve → post; the web's LIVE pages render the records.
async function agentLoop() {
  const reg = (addr: Address) => read<{ status: number; params: readonly Hex[] }>(d.registry, abi.registryAbi, "getModule", [addr]);
  const run = async () => (await sql<{ id: string; stage: string; data: Record<string, any> }[]>`select id, stage, data from thread where kind = 'fee' order by created_at desc limit 1`)[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const safe = wallet(KEY.safe);
  const exec = async (id: bigint) => ok(`execute #${id}`, safe.writeContract({ address: d.registry, abi: abi.registryAbi, functionName: "execute", args: [id] }));
  const head = async () => Number(await pub.getBlockNumber());
  await sql`update engine_flags set override = null`; // the 2A phase ended /halt-ed; an operator lifts it

  // ---------------------------------------------------------------- two more AdaptiveFee plates (bounds 1–3.5%)
  console.log("· register plates B, C");
  const key6 = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e";
  const plates: Address[] = [];
  for (let i = 0; i < 2; i++) {
    const out = execFileSync("forge", ["create", "src/modules/AdaptiveFee.sol:AdaptiveFee", "--rpc-url", RPC, "--private-key", key6, "--broadcast"], { cwd: `${ROOT}contracts`, encoding: "utf8" });
    plates.push(out.match(/Deployed to: (0x[0-9a-fA-F]{40})/)![1] as Address);
  }
  const spec = keccak256(readFileSync(new URL("../modules/adaptive-fee-v1.json", import.meta.url)));
  const w = (x: number) => `0x${x.toString(16).padStart(64, "0")}` as Hex;
  const ids: bigint[] = [];
  for (const [i, m] of plates.entries()) {
    // launch plates: base 2.0% / 2.5%, multiplier 1.0× / 1.8×, cap 3.5%; bounds fee 1–3.5%, multiplier 1,000–18,000
    const p = i === 0 ? [20_000, 10_000, 35_000] : [25_000, 18_000, 35_000];
    const q = encodeOp("Register", [m, 0, spec, [w(p[0]), w(p[1]), w(p[2]), w(0)], [w(10_000), w(1_000), w(10_000), w(0)], [w(35_000), w(18_000), w(35_000), w(0)]]);
    await ok("Safe queue Register plate", safe.writeContract({ address: d.registry, abi: abi.registryAbi, functionName: "queue", args: [q.op, q.data] }));
    ids.push(await read<bigint>(d.registry, abi.registryAbi, "nextId"));
  }
  await travel(3600 + 60);
  for (const id of ids) await exec(id);
  assert.deepEqual(await Promise.all(plates.map(async (m) => (await reg(m)).status)), [1, 1]);

  // ---------------------------------------------------------------- fresh fee-paying swaps for the trailing window
  devchain("swaps", "swaps");
  await mine(3);
  await until("swaps indexed", async () => (await sql`select count(*)::int as n from chain_log where event = 'FeeTaken' and at > (select at from cursor) - interval '1 hour'`)[0].n >= 4);

  // ---------------------------------------------------------------- daily cycle → SetParams + SetShadow
  console.log("· agent loop: cycle");
  await startEngine("live", { SHADOW_HOURS: "2", MIN_SHADOW_SAMPLES: "1" });
  await engineCli("enqueue", "cycle");
  const r1 = await until("experiment queued", async () => { const r = await run(); return r?.stage === "queued_shadow" && r.data.ops.length === 2 && !r.data.planned?.length && r; }, 180_000);
  const target = r1.data.plate as Address;
  assert.equal(target.toLowerCase(), plates[0].toLowerCase(), "first free plate (B) is the candidate");
  assert.equal(r1.data.ops.length, 2, "SetParams + SetShadow");
  const sim = (await sql`select doc from log where kind = 'sim' order by seq desc limit 1`)[0].doc;
  assert.equal(sim.label, "uncalibrated");
  assert.ok(sim.replayed >= 4 && sim.safety?.candidateReverts === 0 && sim.safety.moduleFailed === 0, `fork replay ran: ${JSON.stringify(sim.safety)}`);
  assert.deepEqual(sim.elasticity.map((e: { eps: number }) => e.eps), [0.5, 1, 2]);
  assert.ok((await sql`select 1 from log where kind = 'security' and doc->>'kind' = 'red-team'`).length, "red-team finding recorded");
  await until("SetParams mined", () => txRecord("agent:queue:SetParams", "live", "mined"));
  await until("SetShadow mined", () => txRecord("agent:queue:SetShadow", "live", "mined"));

  // +1 h (registry MIN_DELAY): the keeper executes both (gates re-judged) → shadow. SHADOW_HOURS=2 with
  // MIN_SHADOW_SAMPLES=1: no swaps for 2.5 h → the shadow is extended 1 h ("insufficient data so far" on /lab), then a
  // ShadowFee arrives → Fable red team → SetCanary queued
  await travel(3600 + 60);
  await until("plate in shadow with the vector", async () => (await reg(target)).status === 2);
  await until("run in shadow", async () => (await run())?.stage === "shadow");
  await travel(9000); // 2.5 h: past the 2 h shadow, inside its first 1 h extension
  await until("shadow extended for data", async () => (await sql`select doc->>'note' as n from log where kind = 'experiment' order by seq desc limit 1`)[0]?.n?.includes("insufficient data so far: 0 shadow samples < 1; shadow extended 1 h"));
  assert.equal((await run())!.stage, "shadow", "short of data: extended, not passed");
  for (let i = 0; i < 4 && !(await sql`select 1 from chain_log where event = 'ShadowFee' and lower(args->>'module') = ${target.toLowerCase()}`).length; i++) {
    devchain("swaps", "swaps"); // the hook samples every 10th swap into ShadowFee
    await mine(3);
    await new Promise((r) => setTimeout(r, 1500));
  }
  const r2 = await until("SetCanary queued", async () => { const r = await run(); return r?.stage === "queued_canary" && r; }, 90_000);
  assert.deepEqual((await reg(target)).params.slice(0, 3).map((h) => Number(BigInt(h))), r2.data.vector);
  assert.ok((await sql`select 1 from log where kind = 'plate' and doc->>'event' = 'redteam' and doc->>'model' = 'claude-fable-5-1'`).length, "Fable red team before SetCanary");
  await until("SetCanary mined", () => txRecord("agent:queue:SetCanary", "live", "mined"));
  await travel(3600 + 60);
  const r3 = await until("canary live", async () => { const r = await run(); return r?.stage === "canary" && r; }, 90_000);
  assert.equal((await reg(target)).status, 3);

  // ---------------------------------------------------------------- kill condition: traders avoid the canary window
  console.log("· kill condition");
  const route = await read<{ canaryStart: bigint; canaryPeriod: number; canaryLen: number }>(d.registry, abi.registryAbi, "route");
  const start = Number(route.canaryStart), period = Number(route.canaryPeriod);
  let b = await head();
  let next = start + Math.ceil((b - start) / period) * period + 52; // past a full in-window stretch, out of the window
  if (next - b < 52) next += period;
  await mine(next - b);
  b = await head();
  assert.ok((b - start) % period >= 50, "positioned outside the window");
  devchain("swaps", "swaps");
  const h2 = await head();
  assert.ok(Math.floor((h2 - start) / period) === Math.floor((b - start) / period), "the swaps stayed outside the window");
  await mine(3);
  await until("canary ended", async () => (await reg(target)).status === 1, 120_000);
  const killed = await until("experiment closed", async () => { const r = await run(); return r?.stage === "closed" && r; });
  assert.match(killed.data.reason, /kill condition: in-window swap rate 0%/);
  assert.equal((await txRecord("agent:endCanary", "live", "mined")).fn, "endCanary");
  await mine(3); // finalized = head - 2 on this devchain
  await until("CanaryEnded indexed", async () => (await sql`select 1 from chain_log where event = 'CanaryEnded'`).length);
  const mem = (await sql`select doc from log where kind = 'memory' order by seq desc limit 1`)[0].doc;
  assert.deepEqual([mem.decision, mem.refs[0]], ["rejected", { label: "thread", ref: r3.id }]);
  assert.ok(mem.futureRule);
  assert.equal((await sql`select doc->>'status' as s from log where kind = 'experiment' order by seq desc limit 1`)[0].s, "rejected");
  await until("CanaryEnded alert", async () => tgTexts().find((t) => /Canary 0x.* ended \(by/.test(t)));

  // ---------------------------------------------------------------- IdeaMarket: intake → closed round → outcome
  console.log("· ideas");
  const cur = await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "currentRound");
  await travel(Number((await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "roundEnd", [cur])) - (await pub.getBlock()).timestamp) + 60); // a round that starts with the engine running
  const collect = await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "currentRound");
  // the idea filter: a gated-in author (the fakes' default profile), no link → a candidate of this round; the round's top
  // 16 are submitted at the start of the NEXT round (a full round of staking)
  fakes.mentions.push({ id: "2001", text: "@contractdna idea: charge a lower fee on swaps under 0.05 ETH so small traders keep coming", author_id: "88" });
  await until("intake candidate", async () => (await sql`select 1 from intake where mention_id = '2001' and status = 'candidate'`).length, 60_000);
  await travel(Number((await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "roundEnd", [collect])) - (await pub.getBlock()).timestamp) + 60);
  await mine(3);
  const round = collect + 1n;
  await until("intake submitted", async () => (await sql`select 1 from intake where mention_id = '2001' and status = 'submitted' and submit_round = ${Number(round)}`).length, 60_000);
  await mine(3);
  const sub = await until("IdeaSubmitted indexed", async () => (await sql`select args from chain_log where event = 'IdeaSubmitted' and (args->>'round')::int = ${Number(round)}`)[0]?.args);
  assert.equal(String(sub.author).toLowerCase(), privateKeyToAccount(KEY.agent).address.toLowerCase());
  assert.ok(!/https?:|@contractdna/.test(sub.title + sub.body), "no links or handles reach the chain");
  assert.equal((await sql`select count(*)::int as n from log where kind = 'idea'`)[0].n, 0, "no idea status while the round is open");
  await travel(Number(await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "ROUND_LENGTH")) + 60); // the round closes
  await mine(3);
  await engineCli("enqueue", "ideas:rounds");
  // the brain's outcome: a delayed report record (its public hour is 0 here), no Telegram click; the signers are told how to veto
  const rr = await until("outcome report", async () => (await sql<{ seq: string; doc: { ideas: { decision: string; kind: string }[]; effectiveAt: string } }[]>`select seq::text, doc from log where kind = 'report' and ref = ${`round:${round}`} order by log.seq desc limit 1`)[0], 120_000);
  assert.deepEqual([rr.doc.ideas[0].decision, rr.doc.ideas[0].kind], ["accept", "fee"]);
  assert.ok(rr.doc.effectiveAt);
  const rep = await (await fetch(`${WEB}/api/log/${rr.seq}`)).json();
  const reportHash = keccak256(new TextEncoder().encode(rep.body));
  await until("veto instructions to the signers", async () => tgTexts().some((t) => t.includes(`outcome (report ${rr.seq})`) && t.includes(`/veto ${rr.seq} <signature>`)), 30_000);
  await engineCli("enqueue", "ideas:rounds"); // in effect: no veto, the agent not paused
  await until("proposeOutcome mined", () => txRecord(`agent:idea:proposeOutcome:${reportHash}`, "live", "mined"), 60_000);
  // the idea records are written after the tx record (proposeOutcome: send, then one record per idea): wait for them
  assert.equal(await until("idea status recorded", async () => (await sql`select doc->>'status' as s from log where kind = 'idea' and ref = ${String(sub.id)} and doc->>'status' not in ('researching', 'simulating', 'red-team') order by seq desc limit 1`)[0]?.s, 30_000), "accepted");
  await travel(86_400 + 60);
  await until("round finalized", async () => (await read<readonly [number]>(d.ideaMarket, abi.ideaMarketAbi, "rounds", [round]))[0] === 2, 60_000);
  await mine(3);
  await until("RoundFinalized indexed", async () => (await sql`select 1 from chain_log where event = 'RoundFinalized' and (args->>'round')::int = ${Number(round)}`).length);
  const xp = await (await fetch(`${WEB}/api/xp`)).json();
  assert.ok(xp.some((x: { addr: string; ideas: number }) => x.addr === String(sub.author).toLowerCase() && x.ideas === 500), "accepted idea → 500 XP");

  // ---------------------------------------------------------------- journal (no X post: state changes only)
  console.log("· journal");
  const today = new Date().toISOString().slice(0, 10);
  await engineCli("enqueue", "journal", JSON.stringify({ day: today }));
  await until("journal record", async () => (await sql`select 1 from log where kind = 'journal' and ref = ${today}`).length);
  assert.equal((await sql`select count(*)::int as n from draft where kind = 'x_post' and payload ? 'journal'`)[0].n, 0, "no daily status post");

  // ---------------------------------------------------------------- the web renders the records (LIVE)
  console.log("· web LIVE pages");
  const page = async (p: string) => (await fetch(`${WEB}${p}`)).text();
  const thread = await (await fetch(`${WEB}/api/thread`)).json();
  assert.equal(thread.id, r3.id);
  assert.equal(thread.sample, undefined);
  const mind = await page("/mind");
  assert.ok(mind.includes(thread.title.replace(/&/g, "&amp;")) && !mind.includes("sample data · engine not live yet"), "/mind from records");
  const lab = await page("/lab/experiments");
  assert.ok(lab.includes("uncalibrated simulation") && lab.includes(`adaptive-fee plate ${killed.data.label}`));
  assert.ok((await page("/memory")).includes("Synthetic result"));
  const j = await (await fetch(`${WEB}/api/journal`)).json();
  const day = j.entries.find((e: { date: string }) => e.date === today);
  assert.ok(day && !j.sample);
  assert.ok((await page(`/journal/${day.day}`)).includes(`Day ${day.day}`));
  const sec = await page("/security");
  assert.ok(sec.includes("R-0001") && sec.includes("Synthetic finding"));
  const ev = await (await fetch(`${WEB}/api/epochs`)).json();
  assert.equal(ev[0].name, "GENESIS");
  const props = await page("/proposals");
  assert.ok(props.includes(String(sub.title).replace(/&/g, "&amp;")));
  const home = await page("/");
  assert.equal(home.split("sample data · engine not live yet").length - 1, 0, "goal/task, simulations, hypothesis come from the core record");
  assert.ok((await page("/xp")).includes("Leaderboard"));
  await stopEngine();
  console.log("AGENT LOOP E2E PASS");
}

// ================================================================ the 15-minute loop, at CYCLE_MS = 20 s
//   AGENT_LOOP on, dry_run (nothing queued): several cycles each write thread steps + a core record ("cycle N · …"),
//   observe writes a record per finalized block, the SSE stream carries them as feed lines and fresh core snapshots;
//   one long-lived anvil fork (spawned once, anvil_reset per new finalized block); the red team is not re-run for the
//   same candidate in the same regime. The fork's upstream goes through the counting proxy (rpc-count.mjs): the
//   per-sim RPC cost behind docs/CAPACITY.md.
async function fastLoop() {
  console.log("· 15-min loop at CYCLE_MS=20s");
  const proxy = spawn(process.execPath, [`${ROOT}web/scripts/loadtest/rpc-count.mjs`], { env: { ...process.env, TARGET: RPC, PORT: "18601", REPORT_S: "1" }, stdio: ["ignore", "pipe", "ignore"] });
  let counts: { calls: number; alchemyCu: number; byMethod: Record<string, number> } = { calls: 0, alchemyCu: 0, byMethod: {} };
  proxy.stdout!.on("data", (b: Buffer) => { for (const l of String(b).split("\n")) if (l.startsWith("{")) counts = JSON.parse(l); });
  const t0 = new Date();
  const sims = async () => (await sql<{ n: number }[]>`select count(*)::int as n from log where kind = 'sim' and doc->>'forkBlock' <> 'null' and at > ${t0}`)[0].n;
  try {
    // fresh fee-paying swaps inside the trailing 24 h (chain time) so every cycle has something to simulate
    devchain("swaps", "swaps");
    await mine(3);
    await until("swaps indexed", async () => (await sql`select count(*)::int as n from chain_log where event = 'FeeTaken' and at > (select at from cursor) - interval '1 hour'`)[0].n >= 4);
    const frames: { kind: string; text?: string; core?: { task?: string } }[] = [];
    const ctrl = new AbortController();
    const res = await fetch(`${WEB}/api/stream`, { signal: ctrl.signal });
    const reading = (async () => {
      const rd = res.body!.getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await rd.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buf += new TextDecoder().decode(value);
        const parts = buf.split("\n\n");
        buf = parts.pop()!;
        for (const p of parts) for (const l of p.split("\n")) if (l.startsWith("data: ")) frames.push(JSON.parse(l.slice(6)));
      }
    })();
    await startEngine("dry_run", { AGENT_LOOP: "1", CYCLE_MS: "20000", OBSERVE_MS: "3000", SEARCH_THREAD_CYCLES: "3", SIM_REUSE_BLOCKS: "0", SIM_FORK_RPC_URL: "http://127.0.0.1:18601" }, "fast");
    const loopOf = async () => (await (await fetch(HEALTH)).json()).loop as { cycle: number; fork: { spawns: number; resets: number; reuses: number } };
    const start = (await loopOf()).cycle;
    await until("first fork sim", async () => (await sims()) >= 1, 120_000);
    await new Promise((r) => setTimeout(r, 1500)); // the proxy reports every second
    const first = { ...counts };
    // a new finalized block between cycles (finalized = head - 2 here): each later sim rolls the fork forward
    for (let i = 0; i < 3; i++) {
      const n = await sims();
      const c0 = (await sql<{ b: number }[]>`select block::int as b from cursor`)[0].b;
      await mine(3);
      await until("finalized advanced", async () => (await sql<{ b: number }[]>`select block::int as b from cursor`)[0].b > c0);
      await until(`fork sim ${n + 1}`, async () => (await sims()) > n, 90_000);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const rolled = { ...counts };
    const n = (await sims()) - 1;
    // no new block: the next sim reuses the warm fork (evm_revert to the clean snapshot, state already fetched)
    const n1 = await sims();
    await until("warm fork sim", async () => (await sims()) > n1, 90_000);
    await new Promise((r) => setTimeout(r, 1500));
    const loop = await loopOf();
    assert.ok(loop.cycle - start >= 4, `≥ 4 cycles ran (${loop.cycle - start})`);
    assert.deepEqual([loop.fork.spawns, loop.fork.resets >= 2, loop.fork.reuses >= 1], [1, true, true], `one long-lived fork, rolled forward: ${JSON.stringify(loop.fork)}`);
    console.log(`  warm sim (same block, no reset): ${counts.calls - rolled.calls} upstream calls / ${counts.alchemyCu - rolled.alchemyCu} CU`);
    const sw = (await sql<{ r: number }[]>`select (doc->>'replayed')::int as r from log where kind = 'sim' and doc->>'forkBlock' <> 'null' order by seq desc limit 1`)[0].r;
    console.log(`  fork RPC (devchain, ${sw} swaps replayed ×2): first sim (spawn) ${first.calls} calls / ${first.alchemyCu} CU; then per sim (anvil_reset) ${Math.round((rolled.calls - first.calls) / n)} calls / ${Math.round((rolled.alchemyCu - first.alchemyCu) / n)} CU over ${n} sims; by method ${JSON.stringify(counts.byMethod)}`);
    // records: a core per cycle with the cycle in the task, a thread that grows, one search thread, observe per block
    const cores = await sql<{ task: string }[]>`select doc->>'task' as task from log where kind = 'core' and at > ${t0} order by seq`;
    assert.ok(new Set(cores.map((c) => c.task).filter((t) => /^cycle \d+ · /.test(t))).size >= 4, "homepage task changes every cycle");
    // SEARCH_THREAD_CYCLES=3: a search thread collects 3 cycles, then closes into one memory entry and a new one opens
    const tids = await sql<{ ref: string; n: number }[]>`select ref, count(*)::int as n from log where kind = 'step' and at > ${t0} group by ref order by min(seq)`;
    assert.ok(tids.length >= 2 && tids[0].n >= 3 * 4, `/mind thread grows per cycle, then rolls over (${JSON.stringify(tids)})`);
    const mem = (await sql`select doc from log where kind = 'memory' and at > ${t0} order by seq limit 1`)[0]?.doc;
    assert.deepEqual([mem?.decision, mem?.refs[0].ref], ["rejected", tids[0].ref], "the closed search thread became one memory entry");
    assert.equal((await sql`select doc->>'status' as s from log where kind = 'thread' and ref = ${tids[0].ref} order by seq desc limit 1`)[0].s, "decided");
    const [{ obs }] = await sql<{ obs: number }[]>`select count(distinct ref)::int as obs from log where kind = 'observe' and at > ${t0}`;
    assert.ok(obs >= 3, `observe records per finalized block (${obs})`);
    const [{ rt }] = await sql<{ rt: number }[]>`select count(*)::int as rt from log where kind = 'plate' and doc->>'event' = 'redteam' and at > ${t0}`;
    assert.ok(rt < loop.cycle - start, `red team skipped for an already reviewed candidate (${rt} runs in ${loop.cycle - start} cycles)`);
    const lab = await (await fetch(`${WEB}/api/lab`)).json();
    assert.ok(!lab.sample && lab.experiments.some((e: { status: string }) => e.status === "rejected"), "/lab updates per sim");
    // the live feed: engine records arrive as lines, the core snapshot carries the current task
    ctrl.abort();
    await reading;
    const texts = frames.filter((f) => f.kind === "chain").map((f) => f.text ?? "");
    assert.ok(texts.some((t) => t.startsWith("observed block ")), "observe → feed line");
    assert.ok(texts.some((t) => t.startsWith("simulation completed")), "sim → feed line");
    assert.ok(texts.some((t) => t.startsWith("market · evidence for")), "cycle step → feed line");
    assert.ok(frames.some((f) => f.kind === "testing"), "hypothesis → feed");
    assert.ok(frames.filter((f) => f.kind === "core" && /^cycle \d+ · /.test(f.core?.task ?? "")).length >= 3, "core snapshots carry the new task");
    const home = await (await fetch(`${WEB}/`)).text();
    assert.equal(home.split("sample data · engine not live yet").length - 1, 0, "no sample badges where real records exist");
    await stopEngine();
    console.log("FAST LOOP E2E PASS");
  } finally {
    proxy.kill("SIGTERM");
  }
}

// ================================================================ phase 2C: the money paths on the real contracts
//   jackpot: params recorded, anchored and mined before the window → holders hold through it, the pot is funded → the
//   keeper rolls the window closed → the agent's list (built from chain_log, recorded) → postList → the 1 h veto → the
//   keeper's requestDraw → a VRF word (the local coordinator stands in for Chainlink) → the keeper's settle (the walk
//   from our list record) → Drawn: prizes pushed to the winners, the site's line, the X post with its card (a plate: no
//   studio) and the proof link, /play/draw/<w>; verify-draw.ts rebuilds the list and the winners from the posted record plus chain history.
//   idea rewards: queueReward → the public hour → the keeper's payReward pushes it → the site's line; the same ideaRef
//   again reverts RefUsed.
async function money() {
  // (inside: the module runs its phases before a top-level const below them would be initialized)
  const TRADER_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // anvil key 4: DevActions' trader
  // 60 fresh holders: with no recent draw the cap is 2% a wallet, so a list needs at least 50 eligible wallets
  const HOLDERS = Array.from({ length: 60 }, (_, i) => `0x${keccak256(stringToHex(`e2e holder ${i}`)).slice(26)}` as Address);
  const COORD = parseAbi(["function fulfill(uint256 id, uint256 word)"]);
  console.log("· money: jackpot params → window → list → veto hour → VRF → settle → announcement + X post");
  const gp = d.gamePot;
  const pot = <T>(fn: string, args: unknown[] = []) => read<T>(gp, abi.gamePotAbi, fn, args);
  const now = async () => Number((await pub.getBlock()).timestamp);
  const events = (eventName: string) => pub.getContractEvents({ address: gp, abi: abi.gamePotAbi, eventName: eventName as never, fromBlock: 0n }) as unknown as Promise<{ args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint }[]>;
  const safe = wallet(KEY.safe);
  let wd: ReturnType<typeof watchdog> | undefined;
  await startEngine("live", { X_DAILY_POSTS: "100" }, "money"); // earlier phases spent today's 50 posts
  try {
    // params for the next window that can still be announced: recorded, anchored and mined before it starts
    await engineCli("enqueue", "games:agent", "{}");
    const anc = await until("jackpot params anchored", async () => (await sql`select doc from log where kind = 'game' and ref like 'jackpot:params-anchor:%' and doc->>'status' = 'mined' order by seq desc limit 1`)[0]?.doc, 90_000);
    const w = Number(anc.window);
    const [rec] = await sql`select doc from log where kind = 'game' and ref = ${`jackpot:params:${w}`} order by seq desc limit 1`;
    const start = Number(rec.doc.start);
    assert.ok(anc.blockTime < start, "the params were anchored before the window starts");
    console.log(`  window ${w}: params anchored at ${anc.blockTime}, the window starts at ${start}`);

    // holders: the trader's DNA over 60 fresh wallets before the window starts; 2 ETH into the pot
    const trader = wallet(TRADER_KEY);
    const each = (await read<bigint>(d.token, abi.tokenAbi, "balanceOf", [trader.account.address])) / BigInt(HOLDERS.length + 1);
    assert.ok(each >= 2_000n * 10n ** 18n, `the trader's DNA (${each}) covers ${HOLDERS.length} holders above the minimum balance`);
    const holders = HOLDERS;
    for (const h of holders) await ok("DNA to a holder", trader.writeContract({ address: d.token, abi: abi.tokenAbi, functionName: "transfer", args: [h, each] }));
    await ok("ETH into the pot", safe.sendTransaction({ to: gp, value: parseEther("2") }));

    // the window opens and closes (the keeper rolls it); its end finalizes and the indexer has it
    if (start > (await now())) await travel(start - (await now()) + 1);
    await until(`window ${w} open`, async () => Number(await pot<bigint>("windowId")) >= w);
    await travel(Number(await pot<number>("windowEnd")) - (await now()) + 60);
    await until(`window ${w} closed`, async () => Number(await pot<bigint>("windowId")) > w);
    await mine(3);

    // the watchdog (read-only, its own process) from here on: it verifies a list while it is pending, then its draw
    wd = watchdog("money");

    // the agent's list: built from chain_log, recorded (the record body IS the list), posted
    // one games:agent job at a time, each awaited to its end (never two racing postLists). After each: a skip record or a
    // jackpot task error fails the run; no list yet means one of the task's "waiting for …" answers (finality, the
    // indexer), so the block advances and the job runs again
    const runAgent = async () => {
      const id = (await engineCli("enqueue", "games:agent", "{}")).trim().split(" ")[1];
      const j = await until(`games:agent job ${id}`, async () => (await sql`select status, last_error from job where id = ${id} and status in ('done', 'failed')`)[0], 90_000);
      assert.equal(j.status, "done", `games:agent job ${id}: ${j.last_error}`);
    };
    let listed: { args: Record<string, unknown> } | undefined;
    let runs = 0;
    for (let i = 0; i < 8 && !listed; i++) {
      await runAgent();
      runs++;
      const [skip] = await sql`select doc from log where kind = 'game' and ref = ${`jackpot:list-skip:${w}`}`;
      assert.ok(!skip, `window ${w}'s list was skipped: ${JSON.stringify(skip?.doc)}`);
      const [err] = await sql`select payload->>'text' as text from job where kind = 'alert' and payload->>'text' like 'Jackpot list task failed%' limit 1`;
      assert.ok(!err, String(err?.text));
      listed = (await events("ListPosted")).find((e) => e.args.window === BigInt(w));
      if (!listed) await mine(2);
    }
    if (!listed) {
      // why not: what the agent recorded, what it alerted, and the chain and indexer state it read
      const skips = await sql`select ref, doc from log where kind = 'game' and ref like 'jackpot:%' order by seq desc limit 8`;
      const [cur] = await sql`select block::int as block from cursor`;
      console.error({ skips: skips.map((r) => [r.ref, JSON.stringify(r.doc).slice(0, 300)]), alerts: tgTexts().filter((t) => /jackpot/i.test(t)).slice(-5), cursor: cur?.block,
        head: Number(await pub.getBlockNumber()), windowId: await pot("windowId"), windowStart: await pot("windowStart"), windowEnd: await pot("windowEnd"),
        lastDrawn: await pot("lastDrawnWindow"), draw: String(await pot("draw")), jackpotPot: await pot("jackpotPot"), now: await now(),
        rolled: (await sql`select args from chain_log where event = 'WindowRolled' order by block desc limit 3`).map((r) => r.args) });
    }
    assert.ok(listed, `window ${w}'s list was posted`);
    console.log(`  list: ${listed.args.holders} holders, ${listed.args.totalTickets} tickets, ${listed.args.uri}, after ${runs} games:agent run(s)`);
    assert.ok(runs <= 3, `the list took ${runs} games:agent runs (at most a couple of "waiting for" answers expected)`);
    const [listRec] = await sql`select doc from log where kind = 'game' and ref = ${`jackpot:list:${w}`} order by seq desc limit 1`;
    assert.equal(String(listRec.doc.root).toLowerCase(), String(listed.args.root).toLowerCase(), "the posted root is our list record's");
    assert.ok(holders.every((h) => listRec.doc.leaves.some((l: { account: string }) => l.account.toLowerCase() === h.toLowerCase())), "every holder is on the list");

    await until("watchdog verifies the posted list", async () => wd!.out().includes(`Jackpot list window ${w} verified`), 120_000);

    // the Safe's veto hour, then the keeper requests; the coordinator answers; the keeper settles
    await travel(3600 + 60);
    const reqId = await until("requestDraw", async () => { const dr = await pot<readonly unknown[]>("draw"); return (dr[5] as bigint) !== 0n ? (dr[5] as bigint) : undefined; });
    await ok("VRF fulfil", safe.writeContract({ address: d.vrfCoordinator, abi: COORD, functionName: "fulfill", args: [reqId, BigInt(keccak256(stringToHex(`e2e draw ${w}`)))] }));
    await mine(1);
    const drawn = await until("Drawn", async () => (await events("Drawn")).find((e) => e.args.window === BigInt(w)), 90_000);
    const won = (await events("Winner")).filter((e) => e.args.window === BigInt(w));
    assert.equal(Number(drawn.args.winners), WINNERS, "61 eligible holders: all 10 winners drawn");
    assert.equal(won.length, WINNERS);
    assert.equal(drawn.args.share, (drawn.args.prize as bigint) / 10n, "equal shares of the prize");
    assert.ok(won.every((e) => e.args.prizeId === 0n), "every prize was pushed (no claim needed)");
    console.log(`  drawn: ${won.length} winners × ${Number(drawn.args.share) / 1e18} ETH`);
    await mine(3);

    // the public side: the site's line, the X post (card + proof link), the draw page, and an independent rebuild
    const ann = await until("jackpot announcement", async () => (await sql`select doc from log where kind = 'announce' and doc->>'type' = 'jackpot_drawn' and doc->'facts'->>'window' = ${String(w)}`)[0]?.doc, 60_000);
    assert.match(ann.title, new RegExp(`^Jackpot window ${w}: ${won.length} winners?`));
    const post = await until("jackpot X post", async () => fakes.calls.find((c) => c.path === "/2/tweets" && String(c.body.text).includes(`/play/draw/${w}`)), 90_000);
    assert.equal(post.body.media?.media_ids?.length, 1, "the jackpot post carries its card");
    assert.ok((await sql`select 1 from log where kind = 'x_post' and doc->'media'->>'source' = 'plate' and doc->'facts'->>'event' = 'jackpot_drawn' and doc->'facts'->>'window' = ${String(w)}`).length, "the card's sha256 and source are in the signed record");
    assert.equal((await fetch(`${WEB}/play/draw/${w}`)).status, 200);
    const verify = await promisify(execFile)(process.execPath, ["scripts/verify-draw.ts", "--window", String(w), "--rpc", RPC, "--deployment", "deployments/31337.json"], { cwd: `${ROOT}engine`, encoding: "utf8" });
    assert.match(verify.stdout, /PASS {2}list rebuilt and checked/);
    assert.match(verify.stdout, /PASS {2}winners the walk over/);
    await until("watchdog verifies the draw", async () => wd!.out().includes(`Jackpot draw window ${w} verified: ${WINNERS} winners`), 120_000);

    // idea rewards: queue → the public hour → the keeper pays; an ideaRef is used once
    console.log("· money: idea reward queue → hour → payReward; RefUsed");
    await ok("sync", safe.writeContract({ address: gp, abi: abi.gamePotAbi, functionName: "sync" }));
    const amount = (await pot<bigint>("ideaReserve")) / 10n;
    assert.ok(amount >= 10n ** 16n, `the idea reserve covers a reward (${amount})`);
    const ref = keccak256(stringToHex("e2e idea reward"));
    await ok("queueReward", safe.writeContract({ address: gp, abi: abi.gamePotAbi, functionName: "queueReward", args: [holders[1], amount, ref] }));
    await assert.rejects(pub.simulateContract({ account: safe.account, address: gp, abi: abi.gamePotAbi, functionName: "queueReward", args: [holders[2], amount, ref] }), /RefUsed/);
    const before = await pub.getBalance({ address: holders[1] });
    await travel(3600 + 60);
    const paid = await until("RewardPaid", async () => (await events("RewardPaid")).find((e) => String(e.args.to).toLowerCase() === holders[1].toLowerCase()), 60_000);
    assert.equal(paid.args.claimId, 0n, "pushed, no claim");
    assert.equal((await pub.getBalance({ address: holders[1] })) - before, amount);
    await mine(3);
    await until("reward announcement", async () => (await sql`select 1 from log where kind = 'announce' and doc->>'type' = 'reward_paid' and doc->'facts'->>'reward' = ${String(paid.args.id)}`).length, 60_000);

    // a recipient that refuses ETH: the push fails, the reward becomes a claim; unclaimed for CLAIM_WINDOW, the keeper
    // expires it back to the pot and the site says so
    // recipients that refuse ETH: the push fails and a claim opens. One claims it through its own call (a forwarder that
    // reverts on plain ETH but relays calldata to GamePot); the other never does, and after CLAIM_WINDOW the keeper
    // expires it back to the pot and the site says so
    console.log("· money: refused pushes become claims: one claimed, one expired by the keeper after the claim window");
    const deployed = async (code: Hex) => (await pub.waitForTransactionReceipt({ hash: await safe.sendTransaction({ data: code }) })).contractAddress!;
    const refuser = await deployed("0x6460006000fd6000526005601bf3"); // runtime: PUSH1 0 PUSH1 0 REVERT
    // runtime (54 bytes): no calldata → revert; else CALL GamePot with the calldata, revert if that reverts
    const forwarderRuntime = `3615603057366000600037600060003660006000` + `73${gp.slice(2).toLowerCase()}` + "5af115603057005b60006000fd";
    const forwarder = await deployed(`0x6036600c60003960366000f3${forwarderRuntime}`);
    assert.equal((await pub.getCode({ address: forwarder }))?.length, 2 + 54 * 2, "the forwarder's runtime is 54 bytes");
    const small = (await pot<bigint>("ideaReserve")) / 20n;
    await ok("queueReward to a refuser", safe.writeContract({ address: gp, abi: abi.gamePotAbi, functionName: "queueReward", args: [refuser, small, keccak256(stringToHex("e2e refused reward"))] }));
    await ok("queueReward to a forwarder", safe.writeContract({ address: gp, abi: abi.gamePotAbi, functionName: "queueReward", args: [forwarder, small, keccak256(stringToHex("e2e claimed reward"))] }));
    await travel(3600 + 60);
    const claimOf = async (to: Address) => {
      const e = await until(`RewardPaid as a claim to ${to}`, async () => (await events("RewardPaid")).find((x) => String(x.args.to).toLowerCase() === to.toLowerCase()), 60_000);
      assert.ok((e.args.claimId as bigint) !== 0n, "the push failed: a claim was opened");
      return e.args.claimId as bigint;
    };
    const [expiring, claiming] = [await claimOf(refuser), await claimOf(forwarder)];
    // the winner (the forwarder) claims to an EOA inside the window
    const payee = holders[3];
    const beforeClaim = await pub.getBalance({ address: payee });
    await ok("claim through the forwarder", safe.sendTransaction({ to: forwarder, data: encodeFunctionData({ abi: abi.gamePotAbi, functionName: "claim", args: [[claiming], payee] }) }));
    const got = (await events("PrizeClaimed")).find((e) => e.args.drawId === claiming);
    assert.ok(got, "PrizeClaimed");
    assert.equal((await pub.getBalance({ address: payee })) - beforeClaim, small);
    // the other one expires
    await travel(7 * 86_400 + 60);
    const expired = await until("PrizeExpired", async () => (await events("PrizeExpired")).find((e) => e.args.drawId === expiring), 60_000);
    assert.equal(expired.args.amount, small);
    assert.ok(!(await events("PrizeExpired")).some((e) => e.args.drawId === claiming), "a claimed prize never expires");
    // the expiry itself moves the amount from what is owed back into the jackpot (read around its block)
    const at = (fn: string, blockNumber: bigint) => pub.readContract({ address: gp, abi: abi.gamePotAbi, functionName: fn as never, blockNumber } as never) as Promise<bigint>;
    const eb = expired.blockNumber;
    assert.equal((await at("jackpotPot", eb)) - (await at("jackpotPot", eb - 1n)), small, "the jackpot gets the expired claim");
    assert.equal((await at("owedTotal", eb - 1n)) - (await at("owedTotal", eb)), small, "it is no longer owed");
    await mine(3);
    await until("expiry announcement", async () => (await sql`select 1 from log where kind = 'announce' and doc->>'type' = 'prize_expired' and doc->'facts'->>'drawId' = ${String(expiring)}`).length, 60_000);
    await until("claim announcement", async () => (await sql`select 1 from log where kind = 'announce' and doc->>'type' = 'prize_claimed' and doc->'facts'->>'drawId' = ${String(claiming)}`).length, 60_000);
    // no agent postList ever reverted (one awaited job at a time: no race)
    assert.equal((await sql`select 1 from log where kind = 'tx' and ref = 'agent:game:postList' and doc->>'status' in ('reverted', 'sim_revert')`).length, 0);

    // the watchdog pages a tampered list inside the veto hour; the Safe cancels it
    console.log("· money: watchdog: a tampered list paged, the Safe cancels it");
    {
      // a fresh closed window (the keeper catches the windows up after the long travel first)
      await until("windows caught up", async () => (await now()) < Number(await pot<number>("windowEnd")), 60_000);
      const id0 = Number(await pot<bigint>("windowId"));
      await travel(Number(await pot<number>("windowEnd")) - (await now()) + 60);
      await until("window rolled", async () => Number(await pot<bigint>("windowId")) > id0, 60_000);
      const [bad] = await pot<readonly [bigint, bigint]>("latestClosedWindow");
      // one leaf, a valid proof: the contract accepts it; its uri points at another window's record, so no rebuild matches
      const leaf = { index: 0n, account: holders[0], cumStart: 0n, tickets: 100n };
      const root = keccak256(keccak256(encodeAbiParameters(parseAbiParameters("uint256, address, uint256, uint256"), [leaf.index, leaf.account, leaf.cumStart, leaf.tickets])));
      await ok("Safe posts a tampered list", safe.writeContract({ address: gp, abi: abi.gamePotAbi, functionName: "postList",
        args: [bad, { capBps: 200n, minBalance: 1_000n * 10n ** 18n }, root, 100n, 1n, leaf, [], String(listed.args.uri), keccak256(stringToHex("tampered"))] }));
      await mine(3);
      await until("watchdog pages the tampered list", async () => wd!.out().includes(`JACKPOT LIST MISMATCH — window ${bad}`), 120_000);
      await ok("Safe cancelList", safe.writeContract({ address: gp, abi: abi.gamePotAbi, functionName: "cancelList", args: [bad] }));
      assert.ok((await events("ListCancelled")).some((e) => e.args.window === bad));
      console.log(`  watchdog: window ${w}'s list and draw verified; window ${bad} paged MISMATCH and cancelled`);
    }
    console.log("MONEY E2E PASS");
  } finally {
    wd?.stop();
    await stopEngine();
  }
}

/** The jackpot and reward watchdog (scripts/watchdog.ts) as its own read-only process. No Telegram token: its pages go to
 *  stdout only (its sender talks to the real Bot API). */
function watchdog(name: string) {
  const log = createWriteStream(`${LOGS}/watchdog-${name}.log`);
  let out = "";
  const p = spawn(process.execPath, ["scripts/watchdog.ts"], { cwd: `${ROOT}engine`, stdio: ["ignore", "pipe", "pipe"],
    // RPC_URL is the same anvil twice (the watchdog wants two providers): the multi-provider cross-check is not exercised here
    env: { PATH: process.env.PATH ?? "", RPC_URL: `${RPC},${RPC}`, DEPLOYMENT_FILE: `${ROOT}engine/deployments/31337.json`, PORT: "18095" } });
  p.stdout!.on("data", (c) => { out += c; log.write(c); });
  p.stderr!.on("data", (c) => log.write(c));
  return { out: () => out, stop: () => p.kill("SIGTERM") };
}

// ================================================================ phase 2D: an idea's reward, decided and queued by the agent
//   an X idea ("a raffle game", a build idea) → the idea filter → IdeaMarket submit → the round closes → the brain's
//   outcome (accepted, build) → proposeOutcome → finalized → the idea queue (build, queued); its author binds a payout
//   wallet by mention. The Sequencer is stood in for by its last step (a signed `ship` record, the idea shipped,
//   rewardShipped). Then the engine alone: the brain sizes the reward inside the on-chain caps, the signed `reward`
//   record is anchored, the agent queues it, the watchdog checks the queue against the records (in this plain build only
//   the enclave hashes are missing: everything else must check out), the public hour, the
//   keeper pays the bound wallet.
async function ideaReward() {
  console.log("· idea reward, the agent's path: X idea → round → build queue → ship (stand-in) → brain → record → anchor → queueReward → watchdog → paid");
  const payee = "0x52908400098527886E0F7030069857D2E4169EE7" as Address; // EIP-55 test vector, never a real wallet
  await startEngine("live", { X_DAILY_POSTS: "100" }, "reward");
  let wd: ReturnType<typeof watchdog> | undefined;
  try {
    // a round that starts with the engine running; the idea and its author's wallet binding come in as mentions
    const cur = await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "currentRound");
    await travel(Number((await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "roundEnd", [cur])) - (await pub.getBlock()).timestamp) + 60);
    const collect = await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "currentRound");
    fakes.mentions.push({ id: "3001", text: "@contractdna idea: a weekly raffle game for holders who stake, drawn by the AI", author_id: "89" });
    await until("intake candidate", async () => (await sql`select 1 from intake where mention_id = '3001' and status = 'candidate'`).length, 60_000);
    fakes.mentions.push({ id: "3002", text: `@contractdna ${payee}`, author_id: "89" });
    await until("binding recorded", async () => (await sql`select 1 from log where kind = 'binding' and ref = 'x:89'`).length, 60_000);
    await travel(Number((await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "roundEnd", [collect])) - (await pub.getBlock()).timestamp) + 60);
    await mine(3);
    const round = collect + 1n;
    await until("intake submitted", async () => (await sql`select 1 from intake where mention_id = '3001' and status = 'submitted' and submit_round = ${Number(round)}`).length, 60_000);
    await mine(3);
    await travel(Number(await read<bigint>(d.ideaMarket, abi.ideaMarketAbi, "ROUND_LENGTH")) + 60); // the round closes
    await mine(3);
    await engineCli("enqueue", "ideas:rounds");
    const rr = await until("outcome report", async () => (await sql<{ seq: string; doc: { ideas: { decision: string; kind: string }[] } }[]>`select seq::text, doc from log where kind = 'report' and ref = ${`round:${round}`} order by log.seq desc limit 1`)[0], 120_000);
    assert.deepEqual([rr.doc.ideas[0].decision, rr.doc.ideas[0].kind], ["accept", "build"]);
    const rep = await (await fetch(`${WEB}/api/log/${rr.seq}`)).json();
    const reportHash = keccak256(new TextEncoder().encode(rep.body));
    await engineCli("enqueue", "ideas:rounds");
    await until("proposeOutcome mined", () => txRecord(`agent:idea:proposeOutcome:${reportHash}`, "live", "mined"), 60_000);
    await travel(86_400 + 60);
    await until("round finalized", async () => (await read<readonly [number]>(d.ideaMarket, abi.ideaMarketAbi, "rounds", [round]))[0] === 2, 60_000);
    await mine(3);
    await until("RoundFinalized indexed", async () => (await sql`select 1 from chain_log where event = 'RoundFinalized' and (args->>'round')::int = ${Number(round)}`).length);

    // the idea queue takes the accepted build idea
    await engineCli("enqueue", "ideas:loop");
    const build = await until("build idea queued", async () => (await sql<{ id: string; data: { source: { source: string; authorId?: string } } }[]>`select id::text, data from idea_queue where kind = 'build' and status = 'queued' and (data->>'round')::int = ${Number(round)}`)[0], 60_000);
    assert.deepEqual([build.data.source.source, build.data.source.authorId], ["x", "89"], "the idea is credited to its X author");

    // the Sequencer's last step, stood in for: a signed ship record, the idea shipped, its reward started
    const standIn = `const q = await import("./src/idea-queue.ts"); const { append } = await import("./src/log.ts"); const id = process.argv[1];
      await q.setBuildStatus(id, "queued", "building", "e2e");
      const rec = await append("ship", "ship:e2e-" + id, { kind: "ship", verdict: "ship", title: "e2e stand-in build", build: "e2e", idea: id, effectiveAt: new Date().toISOString() });
      await q.setBuildStatus(id, "building", "shipped", "e2e"); await q.rewardShipped(id, rec.seq); console.log(rec.seq); process.exit(0);`;
    const ship = (await promisify(execFile)(process.execPath, ["--input-type=module", "-e", standIn, build.id], { cwd: `${ROOT}engine`, env: { ...env, ENGINE_MODE: "live" }, encoding: "utf8" })).stdout.trim();
    console.log(`  build idea ${build.id} shipped (stand-in ship record ${ship})`);

    // the engine alone from here: brain → reward record → anchor → the agent's queueReward; the watchdog checks it
    wd = watchdog("reward");
    await engineCli("enqueue", "ideas:loop");
    const row = await until("reward queued by the agent", async () => (await sql<{ data: { reward: { record: { seq: string; root: string; amount: string }; brain: string } } }[]>`select data from idea_queue where id = ${build.id} and status = 'rewarded'`)[0], 120_000);
    const rec = row.data.reward.record;
    // the record as the site serves it cites the author's binding record; its root is that log row's hash (this plain
    // build has no enclave hash)
    const served = await (await fetch(`${WEB}/api/log/${rec.seq}`)).json();
    const [bindingRow] = await sql<{ seq: string }[]>`select seq::text from log where kind = 'binding' and ref = 'x:89' order by seq desc limit 1`;
    assert.equal(JSON.parse(served.body).binding, bindingRow.seq, "the reward cites the author's binding record");
    const [logRow] = await sql<{ h: string }[]>`select encode(hash, 'hex') as h from log where seq = ${rec.seq}`;
    assert.equal(rec.root.toLowerCase(), `0x${logRow.h}`, "the anchored root is the reward record's log hash");
    const queued = (await pub.getContractEvents({ address: d.gamePot, abi: abi.gamePotAbi, eventName: "RewardQueued", fromBlock: 0n }) as unknown as { args: { id: bigint; to: Address; amount: bigint; ideaRef: Hex } }[])
      .find((e) => e.args.ideaRef.toLowerCase() === rec.root.toLowerCase());
    assert.ok(queued, "RewardQueued carries the anchored record's root");
    assert.equal(queued.args.to.toLowerCase(), payee.toLowerCase(), "paid to the author's bound wallet");
    assert.equal(String(queued.args.amount), rec.amount);
    assert.ok((await sql`select 1 from chain_log where event = 'Anchored' and lower(args->>'root') = ${rec.root.toLowerCase()}`).length || (await pub.getContractEvents({ address: d.registry, abi: abi.registryAbi, eventName: "Anchored", args: { root: rec.root as Hex }, fromBlock: 0n })).length, "the record was anchored on chain");
    assert.equal((await sql`select doc->>'kind' as k from log where seq = ${row.data.reward.brain}`)[0]?.k, "reward", "the amount is the brain's signed decision");
    // the watchdog's verdict on this queue. This build is the plain one (no enclave log chain): records carry no enclave
    // hash, so the watchdog flags that, and the binding checks that need a signed binding record cascade from it (the
    // payee is asserted above directly). Every other check (the record's payee and amount, the ship basis before the
    // decision, the record backing no other reward, not excluded) must pass
    const id = queued.args.id;
    const verdict = await until("the watchdog checks the queue against the records", async () => wd!.out().split("\n").find((l) => l.includes(`Idea reward #${id} checked`) || l.includes(`IDEA REWARD #${id} MISMATCH`)), 120_000)
      .catch((e) => { console.error(`--- watchdog output\n${wd!.out().slice(-3000)}`); throw e; });
    const problems = verdict.includes("MISMATCH") ? verdict.replace(/^.*MISMATCH — /, "").replace(/\. Safe: cancelReward.*$/, "").split("; ") : [];
    const plainBuildOnly = /enclave hash does not recompute|^the anchored record is not the one ideaRef names$|^the cited binding \d+ is not a signed binding of X user \d+$|^no binding of the author was in force at the queue$/;
    assert.deepEqual(problems.filter((x) => !plainBuildOnly.test(x)), [], `the watchdog found more than the plain build's missing enclave hashes: ${verdict}`);

    // the public hour, then the keeper pays the bound wallet
    const before = await pub.getBalance({ address: payee });
    await travel(3600 + 60);
    const paid = await until("RewardPaid", async () => (await pub.getContractEvents({ address: d.gamePot, abi: abi.gamePotAbi, eventName: "RewardPaid", args: { id: queued.args.id }, fromBlock: 0n }))[0], 60_000);
    assert.equal(paid.args.claimId, 0n);
    assert.equal((await pub.getBalance({ address: payee })) - before, queued.args.amount);
    console.log(`  reward #${queued.args.id}: ${Number(queued.args.amount) / 1e18} ETH to the bound wallet, record ${rec.seq}; the watchdog flagged only what a plain build lacks (enclave hashes)`);
    console.log("IDEA REWARD E2E PASS");
  } finally {
    wd?.stop();
    await stopEngine();
  }
}
