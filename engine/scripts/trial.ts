// The live trial (W8, phase 1: the engine's AI; the Sequencer comes in phase 2). Runs the engine's model calls end to
// end through the production call paths (the same prompts, schemas, models and cap logic) on realistic inputs, and
// writes a plain report: what went in, what came out, how long it took, what it cost. No database, no chain writes,
// no X, no Telegram: calls are booked in an in-memory ledger (src/llm.ts useLedger) with a hard trial budget, and a
// call whose worst case would cross it is refused before it is made.
//   live: OPENROUTER_API_KEY_ENGINE=… XAI_API_KEY=… node scripts/trial.ts [--budget 25] [--rpc <mainnet RPC>] [--pool <token>:<fee>:<tickSpacing>]
//   dry:  node scripts/trial.ts --dry   (the local fakes' synthetic answers and a synthetic swap set: no network)
// Keys come from the env only and are never printed. It refuses to start with a wallet key, an X or Telegram token or a
// database URL in the env, and forces ENGINE_MODE=dry_run.
// Steps: intake screen on trial/inputs/ideas.json → an IdeaMarket round of the picked ideas (reader, brain outcome,
// red team) → brain build on the top accepted build ideas → brain reward for one fee idea (a synthetic kept result) →
// research (xAI direct, web + X search) → Main's hypothesis on real market stats → red team, Main go/no-go, gate →
// narrator note → one X post draft through the post filter (never posted) → golden-set tryouts for intake and brain.
// Market stats: the last ~24 h of Swap events of one hook-less Uniswap v4 pool on mainnet (native ETH and `token`,
// hooks = 0, so the pool id itself proves there is no hook), read-only eth_getLogs on a public RPC. Default: ETH/USDC
// 0.05%. A hook-less pool has no project fee: the swap fee its events report (LP + protocol fee) stands in for it.
// Output: trial/out/report-<UTC>.md and .json (gitignored).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbiItem, type Address, type Hex } from "viem";
import type { CallRow, Spend } from "../src/llm.ts";
import type { Paired } from "../src/observe.ts";
import type { Vector } from "../src/policy.ts";

const { values: arg } = parseArgs({ options: {
  dry: { type: "boolean", default: false }, budget: { type: "string", default: "25" },
  rpc: { type: "string", default: "https://ethereum-rpc.publicnode.com" }, pool: { type: "string" },
  out: { type: "string" },
} });
const die = (msg: string): never => { console.error(`trial: ${msg}`); process.exit(2); };

// ---------------------------------------------------------------- env: nothing that can write anywhere

/** Env names a trial must not see: wallet keys, signing/seal keys, X and Telegram tokens, database URLs and libpq PG* settings. */
const FORBIDDEN = /PRIVATE_KEY|MNEMONIC|SIGNING_KEY|SEAL_KEY|DATABASE_URL|^PG|^X_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN)$|^TELEGRAM_BOT_TOKEN$|^STUDIO_TOKEN$/;
const forbidden = Object.keys(process.env).filter((k) => process.env[k] && FORBIDDEN.test(k)).sort();
if (forbidden.length) die(`refusing to run with ${forbidden.join(", ")} set: a trial has no database, wallet, X or Telegram access. Unset them.`);
const budget = Number(arg.budget);
if (!(budget > 0)) die("--budget must be a positive number of USD");
if (!arg.dry && (!process.env.OPENROUTER_API_KEY_ENGINE || !process.env.XAI_API_KEY)) die("live mode needs OPENROUTER_API_KEY_ENGINE and XAI_API_KEY in the env (or run --dry)");
// the registry's models only (no legacy overrides), the production endpoints (live) or the local fakes (dry)
for (const k of ["GROK_MODEL", "NARRATE_MODEL", "REDTEAM_MODEL", "REDTEAM_GATE_MODEL", "MEDIA_VISION_MODEL", "OPENROUTER_API_BASE", "XAI_API_BASE"]) delete process.env[k];
Object.assign(process.env, { ENGINE_MODE: "dry_run", LLM_MODE: "live", ENGINE_PRELAUNCH: "1" });
const { startFakes } = await import("./fakes.ts");
const { synthetic } = await import("./synthetic.ts");
const fakes = arg.dry ? await startFakes() : null;
if (fakes) {
  fakes.llm.xai = (b) => synthetic("xai", b);
  fakes.llm.anthropic = (b) => synthetic("anthropic", b);
  Object.assign(process.env, { OPENROUTER_API_KEY_ENGINE: "dry", XAI_API_KEY: "dry", OPENROUTER_API_BASE: fakes.url, XAI_API_BASE: fakes.url });
}

const { llm, useLedger } = await import("../src/llm.ts");
const { Defer } = await import("../src/jobs.ts");
const agents = await import("../src/agents.ts");
const { brainCall } = await import("../src/brain.ts");
const { ideaGate, instructionMarkers, outcomeGates, pick, reportRow, screenDecision } = await import("../src/ideas.ts");
const { rewardCaps, rewardWei } = await import("../src/idea-queue.ts");
const { briefOf, GOAL, RESEARCH_QUESTION } = await import("../src/loop.ts");
const { HOOK_FEES, pctOf } = await import("../src/hook-fees.ts");
const { model, registryInfo, REGISTRY } = await import("../src/models.ts");
const { stats } = await import("../src/observe.ts");
const { clampVector, LIMITS, MODELS, POLICY } = await import("../src/policy.ts");
const { analytic, candidateGates } = await import("../src/sim.ts");
const { loadCases, tryout } = await import("../src/tryout.ts");
const { appendWeight, factNumbers, factSheet, feeFacts, postFilter, TX_URL, writePosts } = await import("../src/voice.ts");
const { LLM } = await import("../src/config.ts");

// ---------------------------------------------------------------- the ledger and the steps

type Booked = CallRow & { step: string; at: string };
const calls: Booked[] = [];
const alerts: string[] = [];
const failures: { step: string; what: string; refused: boolean; error: string }[] = [];
let current = "";
const spent = () => calls.reduce((n, c) => n + c.costUsd, 0);
useLedger({
  spend: async (): Promise<Spend> => {
    const by: Record<string, number> = {};
    for (const c of calls) by[c.budget] = (by[c.budget] ?? 0) + c.costUsd;
    return { total: spent(), by, real: by, month: { total: spent(), by } };
  },
  record: async (r) => { calls.push({ ...r, step: current, at: new Date().toISOString() }); },
  alert: async (text) => { alerts.push(text); },
  refuse: (s, est) => (s.total + est > budget ? `trial budget $${budget} (spent $${s.total.toFixed(4)}, this call's worst case $${est.toFixed(4)})` : null),
});

/** One model call; a failure or a refusal is booked and returns null (the step goes on). */
async function ask<T>(what: string, f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch (e) {
    failures.push({ step: current, what, refused: e instanceof Defer, error: (e as Error).message.replace(/\s+/g, " ").slice(0, 600) });
    return null;
  }
}
type Step = { name: string; about: string; ms: number; input: unknown; output: unknown; error?: string; lines?: string[] };
const steps: Step[] = [];
async function step<T extends { output: unknown; lines?: string[] }>(name: string, about: string, input: unknown, f: () => Promise<T>): Promise<T | undefined> {
  current = name;
  const t = Date.now();
  console.log(`trial: ${name}`);
  try {
    const r = await f();
    steps.push({ name, about, ms: Date.now() - t, input, output: r.output, lines: r.lines });
    return r;
  } catch (e) {
    steps.push({ name, about, ms: Date.now() - t, input, output: null, error: (e as Error).message.slice(0, 600) });
    return undefined;
  }
}
const flags: string[] = [];

// ---------------------------------------------------------------- market: a real hook-less v4 pool

const POOL_MANAGER: Address = "0x000000000004444c5dc75cB358380D2e3dE08A90"; // Uniswap v4 PoolManager, Ethereum mainnet
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const [token, fee, spacing] = (arg.pool ?? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:500:10").split(":"); // USDC, 0.05%
if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !(Number(fee) >= 0) || !(Number(spacing) > 0)) die("--pool is <token address>:<fee pips>:<tick spacing>");
const POOL_KEY = { currency0: ZERO, currency1: token as Address, fee: Number(fee), tickSpacing: Number(spacing), hooks: ZERO };
const POOL_ID = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
  [POOL_KEY.currency0, POOL_KEY.currency1, POOL_KEY.fee, POOL_KEY.tickSpacing, POOL_KEY.hooks]));
const SWAP = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
type SwapLog = { blockNumber: bigint; logIndex: number; transactionHash: Hex; args: { amount0?: bigint; amount1?: bigint; tick?: number; fee?: number } };
const abs = (x: bigint) => (x < 0n ? -x : x);
const DAY_BLOCKS = 7200n; // 24 h of 12 s slots (missed slots make the window a little longer: its real span is reported)

/** v4 Swap logs → the engine's paired swaps. ETH is currency0; the event's swap fee (pips) on the ETH side stands in for
 *  DNA's project fee (gross = the swap's ETH, project = gross × fee). Times: interpolated between the window's ends. */
const toPaired = (logs: SwapLog[], at: (block: number) => number): Paired[] => logs.map((l) => {
  const a0 = l.args.amount0 ?? 0n, pips = Number(l.args.fee ?? 0), eth = abs(a0);
  return { block: Number(l.blockNumber), logIndex: l.logIndex, at: at(Number(l.blockNumber)), tx: l.transactionHash, buy: a0 < 0n, ethWei: eth, tokenWei: abs(l.args.amount1 ?? 0n), tick: Number(l.args.tick ?? 0),
    fee: { buy: a0 < 0n, exactInput: true, gross: eth, project: (eth * BigInt(pips)) / 1_000_000n, pips } };
});

async function market() {
  let head: { number: bigint; timestamp: bigint }, first: { number: bigint; timestamp: bigint }, logs: SwapLog[] = [];
  if (arg.dry) {
    // synthetic: 400 swaps over a day, a random-walk tick, the pool's fee plus a protocol share
    head = { number: 20_000_000n, timestamp: 1_760_000_000n };
    first = { number: head.number - DAY_BLOCKS, timestamp: head.timestamp - 86_400n };
    let tick = -198_300, seed = 7;
    const rnd = () => ((seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647);
    logs = Array.from({ length: 400 }, (_, i) => {
      tick += Math.round((rnd() - 0.5) * 40);
      const eth = BigInt(Math.round(rnd() * 5e18));
      return { blockNumber: first.number + BigInt(i * 18), logIndex: 0, transactionHash: `0x${i.toString(16).padStart(64, "0")}` as Hex, args: { amount0: rnd() < 0.5 ? -eth : eth, amount1: 1n, tick, fee: POOL_KEY.fee + 125 } };
    });
  } else {
    const c = createPublicClient({ transport: http(arg.rpc, { retryCount: 3, timeout: 30_000 }) });
    head = await c.getBlock();
    first = await c.getBlock({ blockNumber: head.number - DAY_BLOCKS });
    for (let b = first.number; b <= head.number; b += 1000n) {
      const to = b + 999n < head.number ? b + 999n : head.number;
      logs.push(...(await c.getLogs({ address: POOL_MANAGER, event: SWAP, args: { id: POOL_ID }, fromBlock: b, toBlock: to })) as SwapLog[]);
    }
  }
  const t0 = Number(first.timestamp) * 1000, t1 = Number(head.timestamp) * 1000;
  const span = Number(head.number - first.number);
  const swaps = toPaired(logs, (n) => t0 + ((t1 - t0) * (n - Number(first.number))) / span);
  const s = stats(swaps, { fromMs: t0, toMs: t1 + 1, capPips: 50_000 });
  return { swaps, stats: s, brief: briefOf(s, Number(head.number)), fromBlock: Number(first.number), toBlock: Number(head.number) };
}

// ---------------------------------------------------------------- the run

const startedAt = new Date();
const rpcHost = arg.dry ? "synthetic (no network)" : new URL(arg.rpc).host; // the host only: a URL may carry a key
const poolInfo = { chain: "Ethereum mainnet", poolManager: POOL_MANAGER, poolId: POOL_ID, key: POOL_KEY, rpc: rpcHost,
  note: "hook-less (hooks = 0 is part of the pool id). It has no project fee: the swap fee its Swap events report (LP + protocol fee, pips) stands in for DNA's project fee, so meanPips and the analytic sim compare DNA's 1%-3.5% policy band against this pool's own fee level. Volumes are the ETH side. Not DNA's pool (not launched)." };

const m = await step("market", "24 h stats of a real hook-less Uniswap v4 pool (code, no model)", poolInfo, async () => {
  const r = await market();
  return { ...r, output: { fromBlock: r.fromBlock, toBlock: r.toBlock, swapsRead: r.swaps.length, brief: r.brief, stats: r.stats } };
});
if (!m) flags.push("market: no stats (RPC failed): the round, hypothesis, red team, note and post steps ran without them or were skipped");

// --- a. intake screen (gate → screen → candidate, as src/ideas.ts intakeHandler; no author or round state is kept)
type Post = { id: string; kind: string; expect: string[]; text: string };
const posts: Post[] = JSON.parse(readFileSync(new URL("../trial/inputs/ideas.json", import.meta.url), "utf8"));
const now = Date.now();
const author = { created_at: "2020-01-01T00:00:00.000Z", public_metrics: { followers_count: 1000 }, verified_type: "blue" }; // passes the author gate
type Cand = { mention_id: string; post: string; class: "fee" | "build"; score: number; title: string; body: string };
const intake = await step("intake", "the X idea filter on 30 realistic posts: code gate, then the quarantined reader's screen, then code's decision", { posts: posts.length, file: "trial/inputs/ideas.json" }, async () => {
  const rows: Record<string, unknown>[] = [];
  const cands: Cand[] = [];
  const texts: string[] = [];
  for (const [i, p] of posts.entries()) {
    const gated = ideaGate({ text: p.text, user: author }, { authorIdeas: 0, texts }, now);
    if (gated) { rows.push({ id: p.id, kind: p.kind, expect: p.expect, status: "gated", reason: gated }); flags.push(`intake ${p.id}: gated by code before the model (${gated})`); continue; }
    const r = await ask(`screen ${p.id}`, () => agents.screenMention(p.text));
    if (!r) { rows.push({ id: p.id, kind: p.kind, expect: p.expect, status: "error" }); continue; }
    const d = screenDecision(r.data);
    const match = p.expect.includes(r.data.screen);
    rows.push({ id: p.id, kind: p.kind, expect: p.expect, screen: r.data.screen, match, clarity: r.data.clarity, feasibility: r.data.feasibility, value: r.data.value, status: d.status, reason: d.reason, title: r.data.title, body: r.data.body });
    if (!match) flags.push(`intake ${p.id}: screened ${r.data.screen}, intended ${p.expect.join("|")}`);
    if (d.status === "candidate") {
      texts.push(p.text);
      cands.push({ mention_id: String(i + 1), post: p.id, class: d.class, score: d.score, title: d.title, body: d.body });
      const markers = instructionMarkers(`${d.title} ${d.body}`);
      if (p.kind === "injection") flags.push(`intake ${p.id}: an injection attempt became a ${d.class} candidate (score ${d.score}); its restatement ${markers.length ? "kept injection markers" : "has no injection markers"}`);
      if (markers.length) flags.push(`intake ${p.id}: the restatement carries instruction-like text (${markers.join(", ")}): "${`${d.title} | ${d.body}`.slice(0, 160)}"`);
    }
  }
  const scored = rows.filter((r) => r.screen !== undefined);
  const ok = scored.filter((r) => r.match).length;
  const inj = rows.filter((r) => r.kind === "injection");
  const summary = { screened: scored.length, matchedIntent: ok, injections: inj.length, injectionsScreenedOut: inj.filter((r) => r.status !== "candidate").length, candidates: cands.length };
  const lines = [
    `Matched the intended class: ${ok} of ${scored.length}. Injection attempts kept out of the candidates: ${summary.injectionsScreenedOut} of ${inj.length}.`, "",
    "| post | intended | screen | match | clarity/feas./value | status | public reason |", "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${(r.expect as string[]).join(", ")} | ${r.screen ?? "-"} | ${r.match === undefined ? "-" : r.match ? "yes" : "NO"} | ${r.screen === undefined ? "-" : `${r.clarity}/${r.feasibility}/${r.value}`} | ${r.status} | ${String(r.reason ?? "").replace(/\|/g, "/")} |`),
    "", "Candidate restatements (what later stages see):", "",
    ...cands.map((c) => `- ${c.post} (${c.class}, ${c.score}/30): ${c.title} | ${c.body}`.replace(/\n/g, " ")),
  ];
  return { cands, output: { summary, rows }, lines };
});

// --- b1. the IdeaMarket round (src/ideas.ts researchRound minus the chain): reader → brain outcome → sims → red team
const cands = intake?.cands ?? [];
const round = await step("round", "an IdeaMarket round of the picked candidates: the reader's spec per idea, the brain's outcome, analytic sims for accepted fee vectors, the red team, code's overrides (reportRow)",
  { picked: Math.min(cands.length, LIMITS.intakePerRound), of: cands.length }, async () => {
    const top = pick(cands, LIMITS.intakePerRound).top;
    const ideas = top.map((c, i) => ({ id: i + 1, index: i, title: c.title, body: c.body, post: c.post }));
    const reads = new Map<number, { id: number; kind: string; summary: string; spec: string; untrusted: true }>();
    for (const i of ideas) {
      const r = await ask(`read idea ${i.id}`, () => agents.readIdea(i.title, i.body));
      if (r) reads.set(i.id, { id: i.id, kind: r.data.kind, summary: agents.sanitize(r.data.summary), spec: agents.sanitize(r.data.spec), untrusted: true });
    }
    const input = { round: 1, ideas: [...reads.values()], policyBounds: POLICY, stats: m?.stats ?? null };
    const out = reads.size ? await ask("brain outcome", () => llm(brainCall("outcome", input))) : null;
    const decided = out?.data.ideas ?? [];
    const days = m ? (m.stats.toMs - m.stats.fromMs) / 86_400_000 : 1;
    const sims: Record<number, unknown> = {};
    for (const x of decided) if (x.decision === "accept" && x.kind === "fee" && x.params && m) sims[x.id] = { params: [x.params.base, x.params.mult, x.params.cap], ...analytic(m.swaps, [x.params.base, x.params.mult, x.params.cap], days, 50_000), label: "uncalibrated", analyticOnly: true };
    const rt = out ? await ask("red team (outcome)", () => agents.redTeam(false, { stage: "idea round 1 outcome", candidate: decided.map((x) => ({ id: x.id, decision: x.decision, kind: x.kind })), sim: sims, gates: outcomeGates(decided.filter((x) => x.decision === "accept").map((x) => x.kind)), quotedHypothesis: decided.map((x) => `#${x.id} ${x.decision}: ${x.reason}`).join(" | ") })) : null;
    const block = rt?.data.verdict === "block" ? agents.sanitize(rt.data.findings[0]?.title ?? "see report") : null;
    const byId = new Map(decided.map((x) => [x.id, x]));
    const rows = ideas.filter((i) => reads.has(i.id)).map((i) => ({ post: i.post, ...reportRow(i, byId.get(i.id), reads.get(i.id)!, block), brain: byId.get(i.id) ?? null, sim: sims[i.id] ?? null }));
    for (const r of rows) if (r.brain && (r.brain.decision !== r.decision)) flags.push(`round: idea ${r.id} (${r.post}): the brain said ${r.brain.decision}, code made it ${r.decision} (${r.reason})`);
    if (rt?.data.verdict === "block") flags.push(`round: the red team blocked the outcome (${block})`);
    const lines = [
      `Brain (${out?.model ?? "no answer"}): ${rows.filter((r) => r.decision === "accept").length} accepted, ${rows.filter((r) => r.decision === "reject").length} rejected, ${rows.filter((r) => r.decision === "void").length} void of ${rows.length}. Red team: ${rt?.data.verdict ?? "no answer"}.`, "",
      "| # | post | reader kind | decision | kind | params / rubric | reason |", "|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.id} | ${r.post} | ${reads.get(r.id)?.kind} | ${r.decision} | ${r.kind} | ${r.params ? `${r.params.base}/${r.params.mult}/${r.params.cap}` : r.rubric ? `${r.rubric.value}+${r.rubric.fit}+${r.rubric.clarity}+${r.rubric.originality}` : "-"} | ${String(r.reason).replace(/\|/g, "/")} |`),
      "", ...(rt ? ["Red-team findings:", "", ...rt.data.findings.map((f) => `- ${f.severity}: ${f.title}: ${f.detail}`)] : []),
    ];
    return { rows, output: { brainInput: input, brain: out?.data ?? null, redTeam: rt?.data ?? null, report: rows }, lines };
  });

// --- b2. brain build on the top accepted build ideas (the golden set's input shape; the Sequencer's own comes in phase 2)
const builds = (() => {
  const acc = (round?.rows ?? []).filter((r) => r.decision === "accept" && r.kind === "build" && r.rubric)
    .map((r) => ({ from: `round idea ${r.id} (${r.post})`, spec: r.spec ?? r.title, rubricScore: r.rubric!.value + r.rubric!.fit + r.rubric!.clarity + r.rubric!.originality }));
  if (acc.length) return acc.sort((a, b) => b.rubricScore - a.rubricScore).slice(0, 3);
  flags.push("build: no accepted build idea in the round: the top build candidates from intake were used, with no rubric score");
  return cands.filter((c) => c.class === "build").sort((a, b) => b.score - a.score).slice(0, 3).map((c) => ({ from: `intake ${c.post}`, spec: `${c.title}. ${c.body}`, rubricScore: null }));
})();
await step("build", "the brain's build / no-build on the top build specs", { specs: builds.length, budgetEth: 0.05 }, async () => {
  const out: Record<string, unknown>[] = [];
  for (const b of builds) {
    const input = { spec: b.spec, rubricScore: b.rubricScore, budgetEth: 0.05 };
    const r = await ask(`brain build (${b.from})`, () => llm(brainCall("build", input)));
    out.push({ from: b.from, input, model: r?.model ?? null, decision: r?.data ?? null });
  }
  return { output: out, lines: out.map((o) => `- ${o.from}: ${JSON.stringify(o.decision)}`) };
});

// --- b3. brain reward for one fee idea, on a synthetic kept result and synthetic GamePot caps (rewardCaps, rewardWei)
const feeRow = (round?.rows ?? []).find((r) => r.decision === "accept" && r.kind === "fee");
const feeCand = cands.find((c) => c.class === "fee");
const pot = { canPropose: true, excluded: false, minReward: 10n ** 16n, maxBps: 2500n, reserve: 10n ** 18n, reserveCap: 5n * 10n ** 18n, budgetStart: 0n, dayBudget: 0n, daySpent: 0n };
const caps = rewardCaps(pot, Math.floor(Date.now() / 1000));
if (!feeRow) flags.push("reward: no accepted fee idea in the round: the top fee candidate from intake was used");
await step("reward", "the brain's reward for a fee idea whose experiment was kept (synthetic result: nothing ran) inside synthetic pot caps (0.01-0.25 ETH)", { idea: feeRow ? `round idea ${feeRow.id} (${feeRow.post})` : feeCand ? `intake ${feeCand.post}` : null }, async () => {
  const idea = feeRow ? { title: feeRow.title, summary: feeRow.summary, spec: feeRow.spec, untrusted: true } : feeCand ? { title: feeCand.title, summary: feeCand.title, spec: feeCand.body, untrusted: true } : null;
  if (!idea) throw new Error("no fee idea to reward");
  const input = { basis: "kept", idea, result: { title: idea.title, result: "Canary ran 4 h on 212 in-window swaps: swap retention 96%, project fee per day +6% vs the baseline, 0 module failures; promoted and still live at the end of the experiment.", decision: "kept" }, capsEth: { min: Number(caps.min) / 1e18, max: Number(caps.max) / 1e18 } };
  const r = await ask("brain reward", () => llm(brainCall("reward", input)));
  const wei = r ? rewardWei(r.data.amountEth, caps) : null;
  return { output: { input, model: r?.model ?? null, decision: r?.data ?? null, clampedWei: wei === null ? null : String(wei) }, lines: [`Decision: ${JSON.stringify(r?.data ?? null)}; after code's clamp: ${wei === null ? "-" : `${Number(wei) / 1e18} ETH`}.`] };
});

// --- d. research (xAI direct, web + X search), the loop's question
const research = await step("research", "Research: Grok on xAI direct with web_search and x_search, the loop's fee question (output is untrusted)", { question: RESEARCH_QUESTION }, async () => {
  const input = { trigger: "no research yet", stats: m ? { swapsPerDay: m.brief.swapsPerDay, realizedVolPct: m.brief.realizedVolPct, meanPips: m.brief.meanPips } : null };
  const r = await ask("research", () => agents.research(RESEARCH_QUESTION, input, [{ type: "web_search" }, { type: "x_search" }]));
  const reduced = r ? { ...agents.reduceResearch(r.data), claims: agents.reduceResearch(r.data).claims.slice(0, 3) } : null;
  return { reduced, output: { input, model: r?.model ?? null, research: r?.data ?? null, mainSees: reduced }, lines: r ? [`Summary: ${r.data.summary}`, "", ...r.data.findings.map((f) => `- ${f.claim} (${f.source})`)] : [] };
});

// --- c. Main's hypothesis on the real stats (src/loop.ts searchCycle), clamp, analytic sim, gates
// the three launch plates (contracts/script/Launch.s.sol plateParams / feeBounds), all Proposed: the loop targets A
const PLATES = [15_000, 20_000, 25_000].map((base, i) => ({ label: "ABC"[i], status: 1, params: [base, [3_000, 10_000, 18_000][i], 35_000] as Vector, min: [10_000, 1_000, 10_000], max: [35_000, 18_000, 35_000] }));
const hyp = !m ? undefined : await step("hypothesis", "Main's hypothesis and fee vector on the real 24 h stats, clamped to policy and plate bounds, then the analytic sim and code's gates (no fork replay: DNA's pool does not exist yet)", null, async () => {
  const input = {
    objective: GOAL, stats: m.brief, deltas: null, rules: [], research: research?.reduced ?? null, activeParams: `baseline ${pctOf(HOOK_FEES.baseline)} (no active plate)`, last: null,
    plates: PLATES.map(({ label, status, params, min, max }) => ({ label, status, params, min, max })), policyBounds: POLICY,
  };
  const r = await ask("hypothesis", () => agents.hypothesize(input));
  if (!r) throw new Error("no hypothesis");
  const clean = agents.sanitize;
  const h = { ...r.data, title: clean(r.data.title), hypothesis: clean(r.data.hypothesis), evidenceFor: clean(r.data.evidenceFor), evidenceAgainst: clean(r.data.evidenceAgainst) };
  const asked: Vector = [h.params.base, h.params.mult, h.params.cap];
  const vector = clampVector(asked, PLATES[0]);
  if (asked.some((x, i) => x !== vector[i])) flags.push(`hypothesis: the vector ${asked.join("/")} was clamped to ${vector.join("/")}`);
  const days = (m.stats.toMs - m.stats.fromMs) / 86_400_000;
  const a = analytic(m.swaps, vector, days, 50_000);
  const e1 = a.elasticity.find((x) => x.eps === 1)!;
  const pct = (x: number) => Number((x * 100).toFixed(2));
  const simNumbers = {
    revenueDeltaPct: a.baseline.projectEthPerDay ? pct(e1.projectEthPerDay / a.baseline.projectEthPerDay - 1) : 0, retentionDeltaPct: pct(e1.swapRetention - 1),
    capDeltaPct: pct(a.candidate.atCapShare - a.baseline.atCapShare), baselineEthPerDay: a.baseline.projectEthPerDay, candidateEthPerDay: e1.projectEthPerDay, swaps: m.swaps.length,
    candidateReverts: -1, moduleFailed: -1, maxGasDelta: -1,
  };
  const gates = candidateGates(a, null, m.swaps.filter((s) => s.fee).length).filter((g) => !g.startsWith("no fork replay"));
  if (gates.length) flags.push(`hypothesis: code's gates failed: ${gates.join("; ")}`);
  return { h, vector, simNumbers, gates, output: { input, model: r.model, hypothesis: h, clamped: vector, analytic: a, simNumbers, gatesFailed: gates },
    lines: [`${h.title}: ${h.hypothesis}`, `For: ${h.evidenceFor}`, `Against: ${h.evidenceAgainst}`, `Vector asked ${asked.join("/")}, after clamp ${vector.join("/")}; confidence ${h.confidence}.`, `Sim at ε=1: revenue ${simNumbers.revenueDeltaPct}%, retention ${simNumbers.retentionDeltaPct}%, at cap ${pct(a.candidate.atCapShare)}%. Gates failed: ${gates.length ? gates.join("; ") : "none"} (fork replay not run).`] };
});

// --- e. red team (routine), Main's go / no-go, the gate (before SetCanary)
const run = hyp ? { label: "A", vector: hyp.vector, simNumbers: hyp.simNumbers, hypothesis: hyp.h.hypothesis } : null;
await step("red-team", "the routine red team on the candidate, Main's go / no-go if it passed, then the gate red team the loop runs before SetCanary", run, async () => {
  if (!run || !hyp) throw new Error("no candidate (hypothesis step failed)");
  const rt = await ask("red team (candidate)", () => agents.redTeam(false, { stage: "candidate", candidate: { plate: run.label, params: run.vector }, sim: run.simNumbers, gates: hyp.gates, quotedHypothesis: run.hypothesis, context: { gates: hyp.gates } }));
  const go = rt?.data.verdict === "pass"
    ? await ask("Main go / no-go", () => agents.decide({ hypothesis: run.hypothesis, params: run.vector, sim: run.simNumbers, gates: hyp.gates.length ? hyp.gates : "all passed", redTeam: "pass", level: 5, mode: "dry_run" }))
    : null;
  const gate = await ask("gate red team", () => agents.redTeam(true, { stage: "canary", candidate: { plate: run.label, params: run.vector }, sim: run.simNumbers, gates: "passed at queue time", quotedHypothesis: run.hypothesis, context: {} }));
  for (const [n, x] of [["routine", rt], ["gate", gate]] as const) if (x?.data.verdict === "block") flags.push(`red team (${n}): block: ${x.data.findings.map((f) => `${f.severity} ${f.title}`).join("; ")}`);
  const fmt = (x: typeof rt) => (x ? [`verdict ${x.data.verdict} (${x.model})`, ...x.data.findings.map((f) => `  - ${f.severity}: ${f.title}: ${f.detail}`)] : ["no answer"]);
  return { output: { redTeam: rt?.data ?? null, mainDecide: go?.data ?? (rt ? "skipped: the red team blocked" : null), gate: gate?.data ?? null },
    lines: ["Routine:", ...fmt(rt), "", `Main go / no-go: ${go ? JSON.stringify(go.data) : "not asked (production asks only after a red-team pass)"}`, "", "Gate:", ...fmt(gate)] };
});

// --- narrator note (a cycle of a running experiment: src/loop.ts monitorCycle)
await step("note", "the narrator's cycle note for the candidate as if in shadow for 1.5 h, checked by textOk as the loop does", null, async () => {
  if (!run || !m) throw new Error("no candidate");
  const input = { stage: "shadow", plate: run.label, vector: run.vector, hoursInStage: 1.5, now: m.brief, change: null, sim: run.simNumbers };
  const r = await ask("narrator note", () => agents.note(input));
  if (!r) throw new Error("no note");
  const text = agents.sanitize(r.data.note);
  const usable = agents.textOk(text, agents.allowedNumbers(input));
  if (!usable) flags.push(`note: failed the number/link check, the loop would use its template: "${text}"`);
  return { output: { input, model: r.model, note: r.data, usable }, lines: [`"${text}" (confidence ${r.data.confidence}; usable: ${usable ? "yes" : "NO, template instead"})`] };
});

// --- one X post draft for the candidate's queued SetParams (src/x.ts: fact sheet → writer → postFilter; never posted)
await step("post", "one X post draft for the candidate's queued SetParams: fact sheet, writer, post filter with a tx link appended (not posted: no X access)", null, async () => {
  if (!run) throw new Error("no candidate");
  const facts = factSheet({ event: "queued", op: "SetParams", plate: run.label, fee: feeFacts(run.vector), activatesAt: new Date(Date.now() + 3600_000).toISOString().slice(0, 16).replace("T", " ") + " UTC", opId: 1 });
  const suffix = `${TX_URL}0x${"0".repeat(64)}`;
  const r = await ask("x writer", () => writePosts(facts, [])); // tone brief: none (the tone scout needs the database)
  if (!r) throw new Error("no draft");
  const candidates = r.data.candidates.map((text) => ({ text, issues: postFilter(text, factNumbers(facts), appendWeight(suffix)) }));
  const chosen = candidates.find((c) => !c.issues.length) ?? null;
  if (!chosen) flags.push("post: no writer candidate passed the post filter (the post would be skipped)");
  return { output: { facts, model: r.model, candidates, chosen: chosen?.text ?? null },
    lines: candidates.map((c) => `- ${c.issues.length ? `REJECTED (${c.issues.join(", ")})` : "passes"}: "${c.text}"`) };
});

// --- f. golden-set tryouts on the registry's models
for (const role of ["intake", "brain"] as const) {
  await step(`tryout-${role}`, `the ${role} golden set (engine/tryout/${role}) on the registry's model, every case as the role's real call`, { model: model(role) }, async () => {
    const causes: Record<string, string> = {};
    const t = await tryout(role, model(role), loadCases(role), (c) => llm(c), (id, cause) => { causes[id] = cause.replace(/\s+/g, " "); });
    if (t.failed.length) flags.push(`tryout ${role}: ${t.failed.length} of ${t.cases} failed: ${t.failed.map((id) => `${id} (${causes[id]})`).join("; ")}`);
    return { output: { ...t, causes, passRate: t.cases ? Number(((t.cases - t.failed.length) / t.cases).toFixed(3)) : 0 }, lines: [`${t.cases - t.failed.length} of ${t.cases} passed on ${t.model}; failed: ${t.failed.join(", ") || "none"}.`, ...t.failed.map((id) => `- ${id}: ${causes[id]}`)] };
  });
}

// ---------------------------------------------------------------- report

const usd = (x: number) => `$${x.toFixed(4)}`;
const sumBy = (k: (c: Booked) => string) => Object.entries(calls.reduce<Record<string, { n: number; usd: number; ms: number }>>((o, c) => {
  const r = (o[k(c)] ??= { n: 0, usd: 0, ms: 0 });
  r.n++; r.usd += c.costUsd; r.ms += c.ms;
  return o;
}, {}));
const finishedAt = new Date();
const callsOut = calls.map(({ step, agent, via, provider, requestedModel, returnedModel, inputTokens, outputTokens, costUsd, ms, ok, error }) => ({ step, agent, via, provider, requestedModel, returnedModel, inputTokens, outputTokens, costUsd, ms, ok, error }));
const json = {
  trial: "W8 phase 1 (engine AI)", mode: arg.dry ? "dry (synthetic answers, no network)" : "live", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
  budgetUsd: budget, spentUsd: Number(spent().toFixed(6)), engineMode: "dry_run", caps: { dailyCapUsd: LLM.dailyCapUsd, subCapsUsd: LLM.subCapsUsd },
  registry: registryInfo(), models: Object.fromEntries(Object.entries(REGISTRY.roles).map(([r, e]) => [r, e.model])), modelsUsed: MODELS,
  pool: poolInfo, steps, calls: callsOut, failures, alerts, flags,
  totals: { calls: calls.length, rejectedOutputs: calls.filter((c) => !c.ok).length, refused: failures.filter((f) => f.refused).length, byStep: Object.fromEntries(sumBy((c) => c.step)), byModel: Object.fromEntries(sumBy((c) => c.requestedModel)) },
};
const md = [
  `# Live trial, phase 1 (engine AI): ${startedAt.toISOString()}`, "",
  `Mode: ${json.mode}. Engine mode: dry_run (no database, no chain writes, no X, no Telegram). Budget ${usd(budget)}, spent ${usd(spent())} on ${calls.length} model calls in ${((finishedAt.getTime() - startedAt.getTime()) / 60_000).toFixed(1)} min.`,
  `Models: ${Object.entries(MODELS).map(([k, v]) => `${k} ${v}`).join(", ")}, brain ${model("brain")}, intake ${model("intake")}. Registry sha256 ${json.registry.sha256.slice(0, 16)}.`,
  `Market: ${poolInfo.chain} Uniswap v4 pool ${POOL_ID} (ETH / ${token}, fee ${fee}, tick spacing ${spacing}, hooks 0), via ${rpcHost}. ${poolInfo.note}`, "",
  "## Cost", "", "| step | calls | cost | model time |", "|---|---|---|---|",
  ...sumBy((c) => c.step).map(([k, v]) => `| ${k} | ${v.n} | ${usd(v.usd)} | ${(v.ms / 1000).toFixed(1)} s |`), "",
  "| model | calls | cost |", "|---|---|---|", ...sumBy((c) => c.requestedModel).map(([k, v]) => `| ${k} | ${v.n} | ${usd(v.usd)} |`), "",
  "## Steps", "",
  ...steps.flatMap((s) => {
    const sc = calls.filter((c) => c.step === s.name);
    return [`### ${s.name}`, "", s.about, "", `Time ${(s.ms / 1000).toFixed(1)} s, ${sc.length} calls, ${usd(sc.reduce((n, c) => n + c.costUsd, 0))}.${s.error ? ` FAILED: ${s.error}` : ""}`, "",
      ...(s.lines?.length ? [...s.lines, ""] : []),
      "<details><summary>input and output (JSON)</summary>", "", "```json", JSON.stringify({ input: s.input, output: s.output }, (_, v) => (typeof v === "bigint" ? String(v) : v), 2), "```", "", "</details>", ""];
  }),
  "## Assessment data", "",
  "Code's flags (mismatches, overrides, filter misses, failed gates, failed tryout cases); judging the outputs above is left to the reader.", "",
  ...(flags.length ? flags.map((f) => `- ${f}`) : ["- none"]), "",
  "## Failures and refusals", "",
  ...(failures.length ? failures.map((f) => `- ${f.step} / ${f.what}: ${f.refused ? "REFUSED (budget or cap)" : "failed"}: ${f.error}`) : ["- none"]), "",
  "## Alerts the engine would have sent", "", ...(alerts.length ? alerts.map((a) => `- ${a}`) : ["- none"]), "",
  "## Calls", "", "| step | agent | model | via / provider | in / out tokens | cost | time | ok |", "|---|---|---|---|---|---|---|---|",
  ...calls.map((c) => `| ${c.step} | ${c.agent} | ${c.returnedModel} | ${c.via} / ${c.provider ?? "-"} | ${c.inputTokens} / ${c.outputTokens} | ${usd(c.costUsd)} | ${(c.ms / 1000).toFixed(1)} s | ${c.ok ? "yes" : `NO: ${String(c.error).slice(0, 120).replace(/\|/g, "/")}`} |`),
  "",
].join("\n");

const dir = arg.out ? resolve(arg.out) : fileURLToPath(new URL("../trial/out/", import.meta.url));
mkdirSync(dir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
writeFileSync(join(dir, `report-${stamp}.json`), `${JSON.stringify(json, (_, v) => (typeof v === "bigint" ? String(v) : v), 2)}\n`);
writeFileSync(join(dir, `report-${stamp}.md`), md);
console.log(`trial: ${calls.length} calls, ${usd(spent())} of ${usd(budget)}, ${failures.length} failures, ${flags.length} flags → ${join(dir, `report-${stamp}.md`)}`);
await fakes?.close();
process.exit(0);
