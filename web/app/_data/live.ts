// LIVE getters (NEXT_PUBLIC_LIVE=1): Postgres rows written by the engine indexer → the page types in ./types.
// Server-only. Every getter awaits connection() first, so pages that use them render per request and the build never
// touches the database. Results are memoized for 5 s per server instance.
import { connection } from "next/server";
import postgres from "postgres";
import { type Core, type FeedEvent, initialCore, reduce } from "../_live/feed";
import { activeModules, compact, eth, FEED_EVENTS, fmtParam, OPS, SEQ_STAGES, short, STATUS, toFeed, toSeqEvent, ZERO } from "./chain";
import { FEE, PROJECT_FEE_CAP } from "./launchFee";
import * as m from "./mock";

export { FEED_EVENTS, toFeed };
import type { Announcement, SeqEvent, AutonomyLevel, Clone, Leakage, Epoch, Experiment, Flow, Hex, Idea, Intervention, JournalEntry, MemoryEntry, Module, Pipeline, QueuedOp, SecurityItem, SplitShare, Thread, ThreadStep, Vault } from "./types";

// ---------------------------------------------------------------- db

const g = globalThis as { dnaSql?: postgres.Sql };
/** Read-only pool (web's DATABASE_URL is the dna_web role). One per process, also across dev HMR reloads. */
export const db = () => (g.dnaSql ??= postgres(process.env.DATABASE_URL ?? "", { max: 5, idle_timeout: 30, onnotice: () => {} }));

type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type ChainRow = { block: number; log_index: number; tx: Hex; at: Date; address: string; event: string; args: Args };

const rows = (events: string[], newestFirst = false, limit = 100_000) => db()<ChainRow[]>`
  select block::int as block, log_index, tx, at, address, event, args from chain_log where event = any(${events})
  order by ${newestFirst ? db()`block desc, log_index desc` : db()`block, log_index`} limit ${limit}`;

async function state<T>(key: string): Promise<T | undefined> {
  return (await db()<{ value: T }[]>`select value from state where key = ${key}`)[0]?.value;
}

function memo<T>(fn: () => Promise<T>): () => Promise<T> {
  let at = 0, p: Promise<T> | undefined;
  return async () => {
    await connection();
    if (!p || Date.now() - at > 5_000) {
      at = Date.now();
      p = fn();
      p.catch(() => { p = undefined; }); // never cache a failure
    }
    return p;
  };
}

// ---------------------------------------------------------------- engine records (hash-chained log, phase 2B)

type Rec<T> = T & { _seq: string; _at: Date };
/** Newest record per ref of `kind`, newest first. Bodies were zod-validated by the engine (engine/src/records.ts). */
async function latestPerRef<T>(kind: string): Promise<Rec<T>[]> {
  const r = await db()<{ doc: T; seq: string; at: Date }[]>`select * from (select distinct on (ref) doc, seq::text as seq, at from log
    where kind = ${kind} order by ref, log.seq desc) x order by seq::bigint desc`; // log.seq: "seq" is the ::text alias here
  return r.map((x) => ({ ...x.doc, _seq: x.seq, _at: x.at }));
}
function strip<T>(r: Rec<T>): T {
  const { _seq, _at, ...rest } = r as Rec<T> & Record<string, unknown>;
  void _seq; void _at;
  return rest as unknown as T;
}

// ---------------------------------------------------------------- shapes written by the indexer

type Deployment = { chainId: number; startBlock: number; safe: Hex; agent: Hex; token: Hex; hook: Hex; registry: Hex; feeVault: Hex; buybackBurn: Hex; liquidityVault: Hex; platformRevenue: Hex;
  bountyBoard?: Hex; ideaMarket?: Hex; convictionVault?: Hex; gamePot?: Hex };
type Manifest = { name: string; version: string; kind: Module["kind"]; author: string; review: Module["review"]; risk: Module["risk"]; summary: string; killConditions: string[]; params: { key: string; unit?: "pips" | "x1e4" }[] };
type Snapshot = {
  level: number; agentPaused: boolean; lastRollbackBlock: string;
  route: { active: Hex; canary: Hex; shadow: Hex }; split: { module: Hex }; currentSplit: [string, string, string, string, boolean]; // FeeVault: buyback, lp, treasury, game bps, baseline
  claims: Record<"feeVault" | "buybackBurn" | "liquidityVault" | "platformRevenue", string>; lpPositions: string; safeEth: string;
};

export const rowToFeed = (r: ChainRow) => toFeed({ block: r.block, logIndex: r.log_index, at: r.at.toISOString(), event: r.event, args: r.args });

// ---------------------------------------------------------------- core (homepage + shell ticker)

/** Chain-backed part of Core, plus the engine fields (simulations, goal, task, hypothesis, confidence, next) from its
 *  newest `core` record once the engine has written one. */
export async function coreNow(): Promise<Partial<Core>> {
  const [[c], chain, head, cursor, recent, [eng]] = await Promise.all([
    db()<{ proposals: number; rollbacks: number; epochs: number }[]>`select
      count(*) filter (where event = 'Queued')::int as proposals,
      count(*) filter (where event = 'RolledBack')::int as rollbacks,
      count(*) filter (where event = 'StatusChanged' and args->>'to' = '4')::int as epochs
      from chain_log where event in ('Queued', 'RolledBack', 'StatusChanged')`,
    state<Snapshot>("chain"), state<{ block: number }>("head"),
    db()<{ block: number }[]>`select block::int as block from cursor`,
    rows(FEED_EVENTS, true, 12),
    db()<{ doc: Pick<Core, "goal" | "task" | "hypothesis" | "confidence" | "next" | "simulations"> }[]>`select doc from log where kind = 'core' order by seq desc limit 1`,
  ]);
  const r = chain?.route;
  // engine fields from its newest core record (no record yet: LiveProvider's blank core, never sample values)
  const engine = eng ? { goal: eng.doc.goal, task: eng.doc.task, hypothesis: eng.doc.hypothesis, confidence: eng.doc.confidence, next: eng.doc.next, simulations: eng.doc.simulations, engine: true } : {};
  const events = recent.reverse().map(rowToFeed).filter((e): e is FeedEvent => e !== null);
  return {
    autonomy: chain?.level ?? 0,
    epoch: c.epochs, // epoch = each PromoteActive (phase 1; the engine declares epochs later)
    activeModules: activeModules(r, chain?.split), // baseline counts as 1 when nothing is Active
    proposals: c.proposals,
    rollbacks: c.rollbacks,
    block: head?.block ?? cursor[0]?.block ?? 0,
    state: r && !ZERO.test(r.canary) ? "canary" : r && !ZERO.test(r.shadow) ? "testing" : "observing",
    log: events.reduce(reduce, { ...initialCore, log: [] }).log.slice(-5),
    ...engine,
  };
}
export const getCore = memo(coreNow);
/** DNAToken address from the deployment manifest (header CA). */
export const getToken = memo(async () => (await state<Deployment>("deployment"))?.token);
/** The game and idea contracts people call directly (staking, ideas), from the deployment manifest. */
export const getContracts = memo(async () => {
  const d = await state<Deployment>("deployment");
  return { ideaMarket: d?.ideaMarket ?? null, convictionVault: d?.convictionVault ?? null };
});
/** Token + hook from the deployment manifest (the swap box's pool key); undefined until the launch is in it. */
export const getPool = memo(async () => {
  const d = await state<Deployment>("deployment");
  return d && !ZERO.test(d.token) && !ZERO.test(d.hook) ? { token: d.token, hook: d.hook } : undefined;
});
/** /trade: DNA pools without DNA's hook (engine `clone` records, newest first) and the newest leakage window. */
export const getClones = memo(async (): Promise<{ clones: Clone[]; leakage: Leakage | null }> => {
  const clones = (await latestPerRef<Clone>("clone")).map(strip);
  const [l] = await db()<{ doc: Leakage }[]>`select doc from log where kind = 'leakage' order by seq desc limit 1`;
  return { clones, leakage: l?.doc ?? null };
});
/** When the pool opened (unix s): the launch tx's block time. Its initial buy is the first FeeTaken the indexer saw (it
 *  backfills from a block just before the launch); null before that. */
export const getLaunchedAt = memo(async () => {
  const [r] = await db()<{ at: Date | null }[]>`select min(at) as at from chain_log where event = 'FeeTaken'`;
  return r?.at ? Math.floor(r.at.getTime() / 1000) : null;
});

// ---------------------------------------------------------------- modules

const modulesRaw = memo(async (): Promise<Module[]> => {
  const [all, manifests] = await Promise.all([rows(["Registered", "StatusChanged", "ParamsSet", "CanaryWindow"]), state<Record<string, Manifest>>("manifests")]);
  const by = new Map<string, { reg?: ChainRow; status?: number; params?: string[]; win?: { period: number; len: number } }>();
  for (const r of all) {
    const k = String(r.args.module).toLowerCase();
    const e = by.get(k) ?? {};
    by.set(k, e);
    if (r.event === "Registered") Object.assign(e, { reg: r, win: undefined }); // a re-register starts a new record
    else if (r.event === "StatusChanged") e.status = Number(r.args.to);
    else if (r.event === "ParamsSet") e.params = r.args.params;
    else e.win = { period: Number(r.args.period), len: Number(r.args.len) };
  }
  const ids = new Set<string>();
  return [...by.values()].filter((e) => e.reg).map(({ reg, status = 1, params, win }) => {
    const a = reg!.args;
    const man = manifests?.[a.specHash];
    const st = STATUS[status] ?? "proposed";
    let id = man ? `${man.name}@${man.version}` : `module-${String(a.module).slice(2, 8).toLowerCase()}`;
    if (ids.has(id)) id = `${id}#${String(a.module).slice(2, 6)}`; // same manifest twice: keep React keys unique
    ids.add(id);
    return {
      id, name: man?.name ?? id, version: man?.version ?? "v?",
      kind: Number(a.kind) === 0 ? "FeePolicy" : "SplitPolicy", status: st, address: a.module, codeHash: a.codehash,
      author: man?.author ?? "unknown", review: man?.review ?? "none", risk: man?.risk ?? "high",
      canaryShare: st === "canary" && win ? Math.round((win.len / win.period) * 100) : 0,
      killConditions: man?.killConditions ?? [],
      params: (man?.params ?? []).map((p, i) => ({ key: p.key, value: fmtParam(params?.[i], p.unit), bounds: `${fmtParam(a.minParams[i], p.unit)}–${fmtParam(a.maxParams[i], p.unit)}` })),
      registeredBlock: reg!.block,
      // a split module's manifest describes its own split, not the one fees follow now (live: /treasury)
      summary: (man?.summary ?? "No manifest matches this spec hash.") + (Number(a.kind) === 1 && st !== "active" && st !== "canary" ? " Not the live split: that one is on Treasury." : ""),
    } satisfies Module;
  }).sort((x, y) => y.registeredBlock - x.registeredBlock);
});
export const getModules = modulesRaw;

const label = (mods: Module[], a: string) => {
  const x = mods.find((m) => m.address.toLowerCase() === a.toLowerCase());
  return x ? `${x.name} ${x.version}` : short(a);
};

// ---------------------------------------------------------------- epochs (engine records; before the engine runs, each PromoteActive starts one)

export const getEpochs = memo(async (): Promise<Epoch[]> => {
  const recs = await latestPerRef<Epoch>("epoch");
  if (recs.length) return recs.map(strip).sort((a, b) => a.n - b.n); // the engine's epoch records (genesis 0, promotions, rollbacks)
  const [sc, lvl, mods, dep, chain] = await Promise.all([rows(["StatusChanged"]), rows(["LevelSet"]), modulesRaw(), state<Deployment>("deployment"), state<Snapshot>("chain")]);
  if (!dep) return [];
  const levelAt = (b: number) => lvl.reduce((l, r) => (r.block <= b ? Number(r.args.to) : l), lvl.length ? Number(lvl[0].args.from) : chain?.level ?? 0);
  const promos = sc.filter((r) => Number(r.args.to) === 4);
  const starts = [dep.startBlock, ...promos.map((r) => r.block)];
  let after = "baseline fee + split";
  return starts.map((block, n) => {
    const end = starts[n + 1] ?? Number.MAX_SAFE_INTEGER;
    const branches = sc.filter((r) => r.block >= block && r.block < end && [4, 6].includes(Number(r.args.to)))
      .map((r) => ({ id: `${r.block}-${r.log_index}`, label: label(mods, r.args.module), outcome: Number(r.args.to) === 4 ? "active" as const : "rolled_back" as const }));
    const before = n === 0 ? "uninitialized" : after;
    after = n === 0 ? after : label(mods, promos[n - 1].args.module);
    return {
      n, name: n === 0 ? "GENESIS" : `EPOCH ${String(n).padStart(2, "0")}`, block, before, after,
      changed: n === 0 ? "launch" : `promoted ${after}`,
      rollbacks: branches.filter((b) => b.outcome === "rolled_back").length,
      autonomy: [levelAt(block), levelAt(end - 1)],
      branches: n === 0 ? [{ id: "genesis", label: "baseline", outcome: "active" }, ...branches] : branches,
    };
  });
});

// ---------------------------------------------------------------- autonomy + interventions

const interventionsRaw = memo(async (): Promise<(Intervention & { at: string; block: number; kind: "guardian" | "rollback" })[]> => {
  const [all, dep] = await Promise.all([rows(["Queued", "Cancelled", "AgentPaused", "LevelSet", "RolledBack", "CanaryEnded"]), state<Deployment>("deployment")]);
  const ops = new Map(all.filter((r) => r.event === "Queued").map((r) => [String(r.args.id), Number(r.args.op)]));
  const safe = dep?.safe.toLowerCase();
  const out: (Intervention & { at: string; block: number; kind: "guardian" | "rollback" })[] = [];
  for (const r of all) {
    const base = { date: r.at.toISOString(), at: r.at.toISOString(), block: r.block, tx: r.tx, reason: "on-chain record", kind: "guardian" as const };
    const a = r.args;
    if (r.event === "Cancelled") {
      const op = ops.get(String(a.id));
      out.push({ ...base, who: "Safe", action: `Cancelled queued op #${a.id}${op === undefined ? "" : ` (${OPS[op]})`}` });
    } else if (r.event === "AgentPaused") {
      out.push({ ...base, who: a.paused ? "Safe" : "Timelock (Safe-queued)", action: a.paused ? "Paused the agent" : "Unpaused the agent" });
    } else if (r.event === "LevelSet") {
      const down = Number(a.to) < Number(a.from);
      out.push({ ...base, who: down ? "Safe" : "Timelock (Safe-queued)", action: `${down ? "Lowered" : "Raised"} level ${a.from} → ${a.to}` });
    } else if (r.event === "RolledBack" && String(a.by).toLowerCase() === safe) {
      out.push({ ...base, kind: "rollback", who: "Safe", action: `Rolled back the ${Number(a.kind) === 0 ? "fee" : "split"} route` });
    } else if (r.event === "CanaryEnded" && String(a.by).toLowerCase() === safe) {
      // not a rollback: the plate returns to Proposed and the 5-day level-raise clock is untouched
      out.push({ ...base, who: "Safe", action: `Ended the fee canary (${short(a.module)} back to Proposed)` });
    }
  }
  return out.reverse();
});

type Attest = { simulations: number; redteamRuns: number; redteamPasses: number; openHighFindings: number; canariesPassed: number };
/** Progress of attested criteria from the engine's newest `autonomy` record (counts from its log). */
function attested(text: string, a: Attest): { progress: string } | undefined {
  if (text.startsWith("1,000+ simulations")) return { progress: a.simulations.toLocaleString("en-US") };
  if (text.startsWith("100+ adversarial tests")) return { progress: `${a.redteamPasses} / 100` };
  if (text.startsWith("No unresolved critical")) return { progress: `${a.openHighFindings} open` };
  if (text.startsWith("3 canaries without rollback")) return { progress: `${Math.min(3, a.canariesPassed)} / 3` };
}

export const getAutonomy = memo(async () => {
  const [chain, lvl, dep, head, interventions, [att]] = await Promise.all([state<Snapshot>("chain"), rows(["LevelSet"]), state<Deployment>("deployment"), state<{ block: number }>("head"), interventionsRaw(),
    db()<{ doc: Attest }[]>`select doc from log where kind = 'autonomy' order by seq desc limit 1`]);
  const current = chain?.level ?? 0;
  const lrb = Number(chain?.lastRollbackBlock ?? 0);
  const days = lrb ? ((head?.block ?? lrb) - lrb) / 7200 : null; // registry counts 5 days as 5 × 7200 blocks (LEVEL_RAISE_BLOCKS)
  const levels: AutonomyLevel[] = m.autonomy.map((l) => ({
    ...l,
    // level + rollback clock are on-chain; criteria/attestations are phase 2 (the ladder section carries a sample
    // badge): levels at or below the current one show as met, above it only the 5-day clock is computed
    criteria: l.criteria.map((c) =>
      l.n <= current ? { ...c, met: true, progress: undefined }
      : c.text.startsWith(`${m.RAISE_DAYS} days since last rollback`)
        ? { ...c, met: days === null || days >= m.RAISE_DAYS, progress: days === null ? "no rollback yet" : `${Math.min(m.RAISE_DAYS, Math.floor(days))} / ${m.RAISE_DAYS} days` }
        // engine counts are evidence for the attesters, never the attestation itself: met stays false here
        : att && attested(c.text, att.doc) ? { ...c, met: false, progress: attested(c.text, att.doc)!.progress }
        : { ...c, met: false, progress: undefined }),
    unlockedBlock: l.n <= current ? (lvl.find((r) => Number(r.args.from) < l.n && Number(r.args.to) >= l.n)?.block ?? dep?.startBlock) : undefined,
  }));
  return { levels, current, attested: !!att, interventions: interventions.map(({ date, who, action, reason, tx }) => ({ date, who, action, reason, tx })) };
});

// ---------------------------------------------------------------- treasury

export const getTreasury = memo(async () => {
  const [chain, dep, recent] = await Promise.all([
    state<Snapshot>("chain"), state<Deployment>("deployment"),
    // chain_log holds every DNA Transfer (the jackpot's balances): only burns (to 0x0) are treasury flows. A FeeTaken
    // with no project fee (a buyback pays only Programmable's platform fee) moves nothing into DNA's vaults.
    // every swap writes a FeeTaken: at most 5 of them, so distributions, buybacks, liquidity adds and burns still show
    db()<ChainRow[]>`select * from (
      (select block::int as block, log_index, tx, at, address, event, args from chain_log
        where event = 'FeeTaken' and (args->>'project')::numeric <> 0 order by block desc, log_index desc limit 5)
      union all
      (select block::int as block, log_index, tx, at, address, event, args from chain_log
        where event = any(${["Distributed", "Buyback", "LiquidityAdded"]})
          or (event = 'Transfer' and args->>'to' = '0x0000000000000000000000000000000000000000')
        order by block desc, log_index desc limit 20)) f
      order by block desc, log_index desc limit 20`,
  ]);
  if (!chain || !dep) return { vaults: [] as Vault[], split: [] as SplitShare[], flows: [] as Flow[], limits: m.limits };
  const c = chain.claims;
  const pot = (chain as Snapshot & { game?: Game }).game?.pot;
  const vaults: Vault[] = [
    { name: "FeeVault", address: dep.feeVault, balance: eth(c.feeVault), unit: "ETH", note: "undistributed project fees" },
    { name: "Safe (treasury)", address: dep.safe, balance: eth(chain.safeEth), unit: "ETH", note: "Safe 2-of-3 · receives the treasury share" },
    // simplification: the indexer does not track the BountyBoard and IdeaMarket balances yet: the real addresses, and
    // the balance left to Etherscan (the address copies from the row). GamePot shows its balance once the indexer has read the game contracts.
    ...([["BountyBoard", dep.bountyBoard, "escrow + agent allowance · agent spends it from level 7"],
      ["IdeaMarket escrow", dep.ideaMarket, "DNA staked on ideas · held until claimed"],
      ["GamePot", dep.gamePot, "jackpot pot + idea reserve, each capped at 15 ETH"]] as const)
      .flatMap(([name, address, note]) => (!address ? []
        : name === "GamePot" && pot ? [{ name, address, balance: eth((BigInt(pot.jackpotPot) + BigInt(pot.ideaReserve)).toString()), unit: "ETH", note }]
        : [{ name, address, balance: "on Etherscan", unit: "", note }])),
    { name: "BuybackBurn", address: dep.buybackBurn, balance: eth(c.buybackBurn), unit: "ETH", note: "next buyback ≤ 0.5% impact" },
    { name: "LiquidityVault", address: dep.liquidityVault, balance: String(chain.lpPositions), unit: "positions", note: `add-only auto-LP · ${eth(c.liquidityVault)} ETH pending` },
    { name: "Initial LP", address: "0x000000000000000000000000000000000000dEaD", balance: "locked", unit: "forever", note: "2 LP NFTs minted to 0xdEaD" },
    { name: "PlatformRevenue", address: dep.platformRevenue, balance: eth(c.platformRevenue), unit: "ETH", note: `Programmable ${FEE.platform}, not ours · immutable` },
  ];
  const [b, l, t, g] = chain.currentSplit.map(Number);
  const split: SplitShare[] = [
    { dest: "buyback-burn", bps: b, min: 2000, max: 5000 },
    { dest: "auto-liquidity", bps: l, min: 2000, max: 5000 },
    { dest: "treasury", bps: t, min: 1000, max: 4000 },
    { dest: "games", bps: g, min: 0, max: 2000 },
  ];
  const flows: Flow[] = recent.map((r) => {
    const a = r.args, at = r.at.toISOString(), tx = r.tx;
    switch (r.event) {
      // only the launch tax (blocks 0 to 8) is above the cap, and the hook sends all of it to BuybackBurn, not FeeVault
      case "FeeTaken": return { at, tx, kind: "fee" as const, amount: `${eth(a.project)} ETH${Number(a.pips) > PROJECT_FEE_CAP ? " · launch tax → BuybackBurn" : ""}` };
      case "Distributed": return { at, tx, kind: "distribute" as const, amount: `${eth(a.amount)} ETH` };
      case "Buyback": return { at, tx, kind: "buyback" as const, amount: `${eth(a.spent)} ETH` };
      case "LiquidityAdded": return { at, tx, kind: "auto-lp" as const, amount: `${eth(a.eth)} ETH` };
      default: return { at, tx, kind: "burn" as const, amount: `${compact(a.value)} DNA` }; // Transfer to 0x0
    }
  });
  return { vaults, split, flows, limits: m.limits };
});

// ---------------------------------------------------------------- security

export const getSecurity = memo(async (): Promise<SecurityItem[]> => {
  const [rbs, mods, dep, interventions] = await Promise.all([rows(["RolledBack"]), modulesRaw(), state<Deployment>("deployment"), interventionsRaw()]);
  const who = (by: string) => by.toLowerCase() === dep?.safe.toLowerCase() ? "the Safe" : by.toLowerCase() === dep?.agent.toLowerCase() ? "the agent" : `${short(by)} (permissionless: breaker tripped)`;
  const rollbacks: SecurityItem[] = rbs.map((r, i) => {
    const gone = [r.args.active, r.args.canary].filter((a: string) => !ZERO.test(a)).map((a: string) => label(mods, a));
    return {
      id: `RB-${i + 1}`, kind: "rollback", severity: "low", status: "resolved", date: r.at.toISOString(), ref: `block ${r.block.toLocaleString("en-US")}`,
      title: `${Number(r.args.kind) === 0 ? "Fee" : "Split"} route rolled back to baseline`,
      detail: `${gone.join(", ") || "route"} rolled back by ${who(r.args.by)}; baseline restored in the same transaction.`,
    };
  });
  const guardian: SecurityItem[] = interventions.filter((x) => x.kind === "guardian").map((x, i) => ({
    id: `G-${interventions.length - i}`, kind: "guardian", severity: "info", status: "resolved", date: x.at, ref: `block ${x.block.toLocaleString("en-US")}`,
    title: x.action, detail: `${x.who}. Transaction ${short(x.tx ?? "")}.`,
  }));
  const redTeam = (await latestPerRef<SecurityItem>("security")).map(strip);
  // red-team findings: engine records (R-n). Disclosures are standing text.
  return [...redTeam, ...rollbacks.reverse(), ...guardian, ...m.security.filter((s) => s.kind === "disclosure")];
});

// ---------------------------------------------------------------- registry queue (/proposals)

export const getQueue = memo(async (): Promise<QueuedOp[]> => {
  const all = await rows(["Queued", "Executed", "Cancelled"]);
  const done = new Map(all.filter((r) => r.event !== "Queued").map((r) => [String(r.args.id), r.event]));
  return all.filter((r) => r.event === "Queued").reverse().map((r) => ({
    id: Number(r.args.id), op: OPS[Number(r.args.op)] ?? `op ${r.args.op}`,
    target: r.args.target ?? (r.args.level !== undefined ? `level ${r.args.level}` : undefined),
    proposer: r.args.proposer, eta: new Date(Number(r.args.eta) * 1000).toISOString(), tx: r.tx,
    status: done.get(String(r.args.id)) === "Executed" ? "executed" : done.get(String(r.args.id)) === "Cancelled" ? "cancelled" : "pending",
  }));
});

// ---------------------------------------------------------------- engine pages (/mind, /lab, /memory, /journal, /xp)

/** Newest thread (fee experiment or genesis) and its steps; undefined until the engine wrote one. */
export const getThread = memo(async (): Promise<(Thread & { pipeline?: Pipeline }) | undefined> => {
  const [t] = await db()<{ doc: Thread & { pipeline?: Pipeline } }[]>`select doc from log where kind = 'thread' order by seq desc limit 1`;
  if (!t) return undefined;
  const steps = await db()<{ doc: ThreadStep & { thread?: string } }[]>`select doc from log where kind = 'step' and ref = ${t.doc.id} order by seq`;
  return { id: t.doc.id, title: t.doc.title, status: t.doc.status, pipeline: t.doc.pipeline, steps: steps.map(({ doc: { thread, ...st } }) => (void thread, st)) };
});

/** The three lab benches: the newest experiment per bench, plus the current thread's pipeline stage. */
export const getLab = memo(async (): Promise<{ experiments: Experiment[]; pipeline: Pipeline }> => {
  // simplification: reads every experiment ref to keep 3 (one per sim since the 15-min loop: ~100/day, so ~36k rows a year);
  // memoized 5 s. Upgrade: `distinct on (doc->>'bench')` over the newest rows, or a limit, when it shows in query time
  const recs = (await latestPerRef<Experiment & { thread?: string }>("experiment"));
  const byBench = new Map<string, Experiment>();
  for (const r of recs) if (!byBench.has(r.bench)) { const { thread, ...e } = strip(r); void thread; byBench.set(e.bench, e); }
  const t = await getThread();
  const stages = ["research", "simulate", "red-team", "canary", "measure", "rollback", "memory"] as const;
  return { experiments: [...byBench.values()].sort((a, b) => a.bench.localeCompare(b.bench)), pipeline: t?.pipeline ?? stages.map((stage) => ({ stage, current: stage === "research" })) };
});

export const getMemory = memo(async (): Promise<MemoryEntry[]> => {
  const recs = await latestPerRef<MemoryEntry & { genesis?: boolean }>("memory");
  return recs.map((r) => { const { genesis, ...e } = strip(r); void genesis; return e; }).sort((a, b) => b.id - a.id);
});

/** Daily entries + the engine's hourly pulse (ref 'pulse': today so far), dropped once that day's journal exists. */
export const getJournal = memo(async (): Promise<JournalEntry[]> => {
  const recs = await latestPerRef<JournalEntry & { genesis?: boolean; pulse?: boolean }>("journal");
  const days = new Set(recs.filter((r) => !r.pulse).map((r) => r.day));
  const out = recs.filter((r) => !r.pulse || !days.has(r.day)).map((r) => { const { genesis, pulse, ...e } = strip(r); void genesis; void pulse; return e; });
  return out;
});

/** Every announcement the engine made, newest first (one record per event, written the moment it saw it). */
export const getAnnouncements = memo(async (): Promise<Announcement[]> => {
  const recs = await db()<{ ref: string; doc: { type: string; title: string; tx: string | null; proof: string | null; priority: number; at: string } }[]>`
    select ref, doc from log where kind = 'announce' order by log.seq desc limit 300`;
  return recs.map((r) => ({ key: r.ref, type: r.doc.type, title: r.doc.title, at: r.doc.at, tx: r.doc.tx, proof: r.doc.proof, priority: r.doc.priority }));
});

/** The Sequencer's public story, newest first: its announcements only (what W6 renders; live updates are W6's). */
const seqFeed = memo(async (): Promise<SeqEvent[]> => {
  const recs = await db()<{ doc: { type: string; title: string; at: string; facts?: Args } }[]>`
    select doc from log where kind = 'announce' and doc->>'type' = any(${SEQ_STAGES as string[]}) order by log.seq desc limit 300`;
  return recs.map((r) => toSeqEvent(r.doc)).filter((e): e is SeqEvent => !!e);
});
export const getSeqFeed = async (limit = 50) => (await seqFeed()).slice(0, Math.max(0, limit));

/** IdeaMarket from chain events; engine statuses (closed rounds only) and final outcomes merged in. */
export const getIdeas = memo(async (): Promise<{ ideas: Idea[]; start: string | null; roundMs: number }> => {
  const [all, im] = await Promise.all([rows(["IdeaSubmitted", "Staked", "RoundFinalized", "OutcomeProposed"]),
    state<{ start: string; roundLength?: number }>("ideaMarket")]); // the indexer reads roundEnd(0) and ROUND_LENGTH
  const subs = all.filter((r) => r.event === "IdeaSubmitted");
  const empty = { ideas: [] as Idea[], start: im?.start ?? null, roundMs: (im?.roundLength ?? 86_400) * 1000 };
  if (!subs.length) return empty;
  const engine = new Map((await latestPerRef<{ id: number; status: Idea["status"]; resolution?: string }>("idea")).map((r) => [r.id, r]));
  const fin = new Map(all.filter((r) => r.event === "RoundFinalized").map((r) => [Number(r.args.round), r.args]));
  const stakes = new Map<number, { total: number; stakers: Set<string> }>();
  for (const r of all.filter((x) => x.event === "Staked")) {
    const e = stakes.get(Number(r.args.id)) ?? { total: 0, stakers: new Set<string>() };
    e.total = Number(BigInt(r.args.ideaTotal)) / 1e18;
    e.stakers.add(String(r.args.staker).toLowerCase());
    stakes.set(Number(r.args.id), e);
  }
  const ideas = subs.map((r): Idea => {
    const a = r.args, id = Number(a.id), round = Number(a.round), done = fin.get(round);
    const bit = (mask: string | undefined) => !!mask && ((BigInt(mask) >> BigInt(a.index)) & BigInt(1)) === BigInt(1);
    const st = stakes.get(id);
    const status: Idea["status"] = done
      ? (BigInt(done.accepted) === BigInt(0) || bit(done.voided) ? "void" : bit(done.accepted) ? "accepted" : "rejected")
      : engine.get(id)?.status ?? "open";
    return {
      id, round, title: String(a.title), summary: String(a.body).slice(0, 280), author: a.author, staked: st?.total ?? 0, stakers: st?.stakers.size ?? 0,
      status, submitted: r.at.toISOString().slice(0, 10), resolution: done ? `Final${done.expired ? " (expired: all void)" : ""}` : engine.get(id)?.resolution,
    };
  }).reverse();
  return { ...empty, ideas };
});

type IntakeRec = { mention: string; round: number; status: string; reason?: string };
export type IntakeSummary = { total: number; ideas: number; reasons: { status: string; n: number; example: string }[] };
const IDEA_STATUSES = new Set(["candidate", "picked", "submitted", "not_picked", "duplicate"]); // engine/src/ideas.ts
/** What the engine decided about every X mention it read (its signed `intake` records, newest per mention): counts by
 *  status with the most common public reason. Counts only: the mentions' authors and texts stay off the page. */
export const getIntake = memo(async (): Promise<IntakeSummary> => {
  const recs = await latestPerRef<IntakeRec>("intake");
  const by = new Map<string, Map<string, number>>();
  for (const r of recs) {
    const reasons = by.get(r.status) ?? new Map<string, number>();
    by.set(r.status, reasons);
    const why = (r.reason ?? "").replace(/, score .*$/, ""); // a candidate's score varies; its kind does not
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }
  const reasons = [...by].map(([status, rs]) => ({ status, n: [...rs.values()].reduce((a, b) => a + b, 0), example: [...rs].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.n - a.n);
  return { total: recs.length, ideas: recs.filter((r) => IDEA_STATUSES.has(r.status)).length, reasons };
});

export type XpRow = { addr: Hex; xp: number; staking: number; ideas: number; work: number; bounties: number };
export const getXp = memo(async () => db()<XpRow[]>`select addr, xp::int as xp, staking::int as staking, ideas::int as ideas, work::int as work, bounties::int as bounties
  from xp order by xp desc, addr limit 100`);

// ---------------------------------------------------------------- the games (/play)

type Game = {
  pot?: { jackpotPot: string; ideaReserve: string; queuedRewards: string; drawInterval: number; windowId: string; windowStart: number; windowEnd: number;
    draw: { window: string; eta: number; reqId: string; fulfilledAt: number; prize: string; totalTickets: string } };
  vault?: { totalLocked: string; count: string }; board?: { ballotCount: string; pendingMystery: string; mysteryCount: string };
};
export type PlayLive = {
  jackpot: {
    potEth: string; prizeEth: string /* an upper bound: the draw first tops the VRF subscription up from the pot */;
    window: number; windowEndsAt: string | null; stage: "window open" | "list posted" | "drawing" | "settling";
    lastWin: { window: number; shareEth: string; at: string; winners: { rank: number; account: Hex; pushed: boolean }[] } | null;
  };
  locked: { dna: string; positions: number; stakedPct: number; votesOpen: boolean };
  ballot: { id: number; status: "veto window" | "voting" | "ended" | "cancelled" | "resolved"; start: string; end: string; options: { name: string; weight: string }[]; result: string | null } | null;
  mystery: { id: number; status: string; commitment: Hex; revealAt: string; salt: Hex | null; payload: Hex | null } | null;
};
const iso = (s: number | string) => new Date(Number(s) * 1000).toISOString();
/** Holders vote only while ≥ 1% of DNA is staked (engine/src/games.ts ballotsOpen). */
const staked = (locked: string, supply: string | undefined) => {
  const s = BigInt(supply ?? "0");
  return { stakedPct: s > BigInt(0) ? Number((BigInt(locked) * BigInt(10_000)) / s) / 100 : 0, votesOpen: s > BigInt(0) && BigInt(locked) * BigInt(100) >= s };
};
const PRIZE_CAP = BigInt("3000000000000000000"); // GamePot.PRIZE_CAP (3 ETH)
const MYSTERY = ["", "sealed", "revealed", "queued for testing", "rejected by the safety checks", "broken (not revealed in time)", "cancelled by the Safe"];
/** LIVE /play from the indexer's game snapshot + finalized game events; undefined until the contracts are deployed. */
export const getPlay = memo(async (): Promise<PlayLive | undefined> => {
  const g = (await state<{ game?: Game }>("chain"))?.game;
  if (!g?.pot) return undefined;
  const p = g.pot;
  const [lastWin] = await rows(["Drawn"], true, 1);
  const won = lastWin ? await db()<ChainRow[]>`select block::int as block, log_index, tx, at, address, event, args from chain_log where event = 'Winner' and tx = ${lastWin.tx} order by log_index` : [];
  const supply = (await state<{ totalSupply?: string }>("chain"))?.totalSupply;
  const prize = BigInt(p.jackpotPot) < PRIZE_CAP ? BigInt(p.jackpotPot) : PRIZE_CAP;
  // ballot: the newest proposal, tallies from each position's latest vote (a re-vote moves its weight)
  const [bp] = await rows(["BallotProposed"], true, 1);
  let ballot: PlayLive["ballot"] = null;
  if (bp) {
    const id = String(bp.args.ballot);
    const ends = await db()<{ event: string; args: Args }[]>`select event, args from chain_log where event in ('BallotCancelled', 'BallotRun', 'BallotSkipped') and args->>'ballot' = ${id}`;
    const tally = await db()<{ option: number; w: string }[]>`select option, sum(w)::text as w from (select distinct on (args->>'positionId') (args->>'option')::int as option, (args->>'weight')::numeric as w
      from chain_log where event = 'Voted' and args->>'ballot' = ${id} order by args->>'positionId', block desc, log_index desc) v group by option`;
    const found = (await db()<{ doc: { options?: { name: string }[]; descriptors?: string[] } }[]>`select doc from log where kind = 'game' and ref = ${`ballot:${id}`} order by log.seq desc limit 1`)[0]?.doc;
    // the record is keyed by the predicted id: its names count only if its descriptors are the proposal's
    const opts = (bp.args.options ?? []) as unknown as string[];
    const rec = found?.descriptors?.length === opts.length && found.descriptors.every((x, i) => x.toLowerCase() === String(opts[i]).toLowerCase()) ? found : undefined;
    const now = Date.now() / 1000;
    const run = ends.find((e) => e.event === "BallotRun"), skipped = ends.find((e) => e.event === "BallotSkipped");
    ballot = {
      id: Number(id), start: iso(bp.args.start), end: iso(bp.args.end),
      status: ends.some((e) => e.event === "BallotCancelled") ? "cancelled" : run || skipped ? "resolved" : now < Number(bp.args.start) ? "veto window" : now < Number(bp.args.end) ? "voting" : "ended",
      options: [0, 1, 2].map((i) => ({ name: rec?.options?.[i]?.name ?? `Option ${"ABC"[i]}`, weight: compact(tally.find((t) => t.option === i)?.w ?? "0") })),
      result: run ? `option ${"ABC"[Number(run.args.option)]} queued for testing (registry op #${run.args.registryOpId})` : skipped ? "the winner failed the safety checks and was not queued" : null,
    };
  }
  const [sealed] = await rows(["Sealed"], true, 1);
  let mystery: PlayLive["mystery"] = null;
  if (sealed) {
    const id = String(sealed.args.mystery);
    const ev = await db()<{ event: string; args: Args }[]>`select event, args from chain_log where event in ('Revealed', 'Run', 'Rejected', 'Broken', 'CancelledByGuardian') and args->>'mystery' = ${id} order by block, log_index`;
    const status = ev.length ? ({ Revealed: 2, Run: 3, Rejected: 4, Broken: 5, CancelledByGuardian: 6 } as Record<string, number>)[ev.at(-1)!.event] : 1;
    const rev = ev.find((e) => e.event === "Revealed");
    mystery = { id: Number(id), status: MYSTERY[status], commitment: sealed.args.commitment, revealAt: iso(sealed.args.revealAt), salt: rev?.args.salt ?? null, payload: rev?.args.payload ?? null };
  }
  return {
    jackpot: {
      potEth: eth(p.jackpotPot), prizeEth: eth(prize.toString()), window: Number(p.windowId), windowEndsAt: Number(p.windowEnd) ? iso(p.windowEnd) : null,
      stage: p.draw.fulfilledAt ? "settling" : p.draw.reqId !== "0" ? "drawing" : p.draw.window !== "0" ? "list posted" : "window open",
      lastWin: lastWin ? { window: Number(lastWin.args.window), shareEth: eth(lastWin.args.share), at: lastWin.at.toISOString(),
        winners: won.map((r) => ({ rank: Number(r.args.rank), account: r.args.account, pushed: String(r.args.prizeId) === "0" })) } : null,
    },
    locked: { dna: compact(g.vault?.totalLocked ?? "0"), positions: Number(g.vault?.count ?? 0), ...staked(g.vault?.totalLocked ?? "0", supply) },
    ballot, mystery,
  };
});

export type DrawLive = {
  window: number; rand: string; prizeEth: string; shareEth: string; ticketsUsed: number; at: string;
  winners: { rank: number; account: Hex; prizeId: number; paid: "pushed" | "claimed" | "expired" | "claimable" }[];
  gamePot: Hex; blocks: { drawn: number; posted: number; fulfilled: number | null };
  tx: { drawn: Hex; posted: Hex; requested: Hex | null; fulfilled: Hex | null };
  list: { uri: string; dataHash: Hex; root: Hex; totalTickets: string; holders: number; capBps: number };
};
/** One settled jackpot draw (by window: a window is drawn at most once), its Winner rows, and the chain rows the
 *  browser check needs (finalized; the check re-reads them by block). */
export const getDraw = async (window: number): Promise<DrawLive | undefined> => {
  await connection();
  const w = String(window);
  const [dr] = await db()<ChainRow[]>`select block::int as block, log_index, tx, at, address, event, args from chain_log where event = 'Drawn' and args->>'window' = ${w} limit 1`;
  if (!dr) return undefined;
  const before = (event: string) => db()<ChainRow[]>`select block::int as block, log_index, tx, at, address, event, args from chain_log
    where event = ${event} and args->>'window' = ${w} and block <= ${dr.block} order by block desc, log_index desc limit 1`;
  const [[posted], [requested], [fulfilled], won] = await Promise.all([before("ListPosted"), before("DrawRequested"), before("DrawFulfilled"),
    db()<ChainRow[]>`select block::int as block, log_index, tx, at, address, event, args from chain_log where event = 'Winner' and tx = ${dr.tx} order by log_index`]);
  if (!posted) return undefined;
  const ids = won.map((r) => String(r.args.prizeId)).filter((id) => id !== "0");
  const ends = ids.length ? await db()<ChainRow[]>`select block::int as block, log_index, tx, at, address, event, args from chain_log where event in ('PrizeClaimed', 'PrizeExpired') and args->>'drawId' = any(${ids})` : [];
  const paid = (id: string) => (id === "0" ? "pushed" : ends.some((e) => e.event === "PrizeClaimed" && String(e.args.drawId) === id) ? "claimed"
    : ends.some((e) => e.event === "PrizeExpired" && String(e.args.drawId) === id) ? "expired" : "claimable");
  return {
    window, rand: String(dr.args.rand), prizeEth: eth(dr.args.prize), shareEth: eth(dr.args.share), ticketsUsed: Number(dr.args.ticketsUsed), at: dr.at.toISOString(),
    winners: won.map((r) => ({ rank: Number(r.args.rank), account: r.args.account, prizeId: Number(r.args.prizeId), paid: paid(String(r.args.prizeId)) })),
    gamePot: dr.address as Hex, blocks: { drawn: dr.block, posted: posted.block, fulfilled: fulfilled?.block ?? null },
    tx: { drawn: dr.tx, posted: posted.tx, requested: requested?.tx ?? null, fulfilled: fulfilled?.tx ?? null },
    list: { uri: String(posted.args.uri), dataHash: posted.args.dataHash, root: posted.args.root, totalTickets: String(posted.args.totalTickets), holders: Number(posted.args.holders), capBps: Number(posted.args.capBps) },
  };
};

// ---------------------------------------------------------------- proof of AI (/proof)

export type AnchorRow = { block: number; at: string; tx: Hex; root: Hex; uri: string };
/** The newest on-chain Anchored roots (finalized). The registry /proof checks comes from release.json, not the DB. */
export const getProofChain = memo(async () => {
  const anchors = await rows(["Anchored"], true, 20);
  return {
    anchors: anchors.map((r): AnchorRow => ({ block: r.block, at: r.at.toISOString(), tx: r.tx, root: r.args.root, uri: r.args.uri })),
  };
});

export type ProofBrain = { seq: string; day: string; sha256: string; personaSha256: string | null; contextSha256: string };
/** The newest signed self-file record (engine/src/self.ts): the persona, context and self-file hashes the brain's
 *  decision records name (the persona's text is private). */
export const getProofBrain = memo(async (): Promise<ProofBrain | null> => {
  const [r] = await db()<{ seq: string; doc: Omit<ProofBrain, "seq"> }[]>`select seq::text, doc from log where kind = 'self' order by log.seq desc limit 1`;
  return r ? { seq: r.seq, day: r.doc.day, sha256: r.doc.sha256, personaSha256: r.doc.personaSha256 ?? null, contextSha256: r.doc.contextSha256 } : null;
});

// ---------------------------------------------------------------- health

const STALE_MS = 5 * 60_000;
// memoized like the getters: every open tab polls /api/health once a minute (5,000 tabs ≈ 83 req/s)
export const getHealth = memo(async () => {
  const [c] = await db()<{ block: number; at: Date; checked_at: Date }[]>`select block::int as block, at, checked_at from cursor`;
  return c
    ? { live: true, block: c.block, at: c.at.toISOString(), checkedAt: c.checked_at.toISOString(), stale: Date.now() - c.checked_at.getTime() > STALE_MS }
    : { live: true, block: null, at: null, checkedAt: null, stale: true };
});
