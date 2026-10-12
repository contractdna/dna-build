// The idea replay: the live idea path (src/ideas.ts intakeHandler + judgeLive, src/x.ts's idea reply) run again over
// exported X mentions, offline. Gate → screen → the author's daily cap and the title repeat → the quarantined reader →
// the brain's outcome → the closest buildable version (standIn) → the red team on an acceptance → code's rules
// (reportRow, settled), then the reply the author would get: the reply reader's kind, intakeFactOf's facts and the
// writer's draft through the reply filters (never posted). Nothing is read from or written to a database, the chain, X
// or Telegram: the model calls go through the production call paths into an in-memory ledger with a hard budget.
//   live: OPENROUTER_API_KEY_ENGINE=… XAI_API_KEY=… node scripts/replay-ideas.ts [--input <export.json>] [--budget 15] --out <file.md>
//   dry:  node scripts/replay-ideas.ts --dry --input <export.json> --out <file.md>   (the local fakes: no network)
// Input: { mentions: [{ id, author_id, username, text, at, user, status, reason }] } (status/reason: the verdict the
// mention had before, shown next to the new one). Default: trial/out/replay-mentions.json (gitignored: real posts).
// Keys come from the env only and are never printed. It refuses a wallet key, an X or Telegram token or a database URL
// in the env, and forces ENGINE_MODE=dry_run. Stats: none (no chain), as for a fee idea judged before the pool traded.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CallRow, Spend } from "../src/llm.ts";

const { values: arg } = parseArgs({ options: {
  dry: { type: "boolean", default: false }, budget: { type: "string", default: "15" },
  input: { type: "string", default: new URL("../trial/out/replay-mentions.json", import.meta.url).pathname }, out: { type: "string" },
} });
const die = (msg: string): never => { console.error(`replay: ${msg}`); process.exit(2); };

const FORBIDDEN = /PRIVATE_KEY|MNEMONIC|SIGNING_KEY|SEAL_KEY|DATABASE_URL|^PG|^X_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN)$|^TELEGRAM_BOT_TOKEN$|^STUDIO_TOKEN$/;
const forbidden = Object.keys(process.env).filter((k) => process.env[k] && FORBIDDEN.test(k)).sort();
if (forbidden.length) die(`refusing to run with ${forbidden.join(", ")} set: a replay has no database, wallet, X or Telegram access. Unset them.`);
const budget = Number(arg.budget);
if (!(budget > 0)) die("--budget must be a positive number of USD");
if (!arg.out) die("--out <file.md> is required");
if (!arg.dry && (!process.env.OPENROUTER_API_KEY_ENGINE || !process.env.XAI_API_KEY)) die("live mode needs OPENROUTER_API_KEY_ENGINE and XAI_API_KEY in the env (or run --dry)");
type M = { id: string; author_id: string | null; username?: string; text: string; at: string; user?: Record<string, unknown>; status?: string; reason?: string };
let mentions: M[];
try {
  mentions = (JSON.parse(readFileSync(arg.input!, "utf8")) as { mentions: M[] }).mentions;
} catch (e) {
  die(`can't read --input ${arg.input}: ${(e as Error).message}`);
}
mentions = mentions!.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

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
const agents = await import("../src/agents.ts");
const { brainCall } = await import("../src/brain.ts");
const { authorCap, ideaGate, outcomeGates, reportRow, screenDecision, settled, standIn, titleKey, LIVE_BACKFILL_DAYS } = await import("../src/ideas.ts");
const { POLICY } = await import("../src/policy.ts");
const { TRYOUT_SELF } = await import("../src/tryout.ts");
const { model } = await import("../src/models.ts");
const { mechanicsFor } = await import("../src/mechanics.ts");
const { allyIssues, chooseShapes, claimFacts, claimIssues, classifyMention, draftInCharacter, factNumbers, factSheet, intentOf, judgeCall, parrotIssue, pickBest, postFilter, promiseIssue, shapesFor, voiceIssues } = await import("../src/voice.ts");
const { bundleIssues, intakeFactOf } = await import("../src/x.ts");

const calls: CallRow[] = [];
const failures: string[] = [];
const spent = () => calls.reduce((n, c) => n + c.costUsd, 0);
useLedger({
  spend: async (): Promise<Spend> => {
    const by: Record<string, number> = {};
    for (const c of calls) by[c.budget] = (by[c.budget] ?? 0) + c.costUsd;
    return { total: spent(), by, real: by, month: { total: spent(), by } };
  },
  record: async (r) => { calls.push(r); },
  alert: async () => {},
  refuse: (s, est) => (s.total + est > budget ? `replay budget $${budget} (spent $${s.total.toFixed(4)}, this call's worst case $${est.toFixed(4)})` : null),
});
async function ask<T>(what: string, f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch (e) {
    failures.push(`${what}: ${(e as Error).message.replace(/\s+/g, " ").slice(0, 300)}`);
    return null;
  }
}
/** `f` over `xs`, `n` at a time, in input order. */
async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}

// ---------------------------------------------------------------- 1. the screen (independent per mention: in parallel)

const LINK = /https?:\/\/|www\./i;
const screens = await pool(mentions, 8, (m) => LINK.test(m.text.replace(/@\w+/g, "")) ? Promise.resolve(null) : ask(`screen ${m.id}`, () => agents.screenMention(m.text)));

// ---------------------------------------------------------------- 2. intake, in post order (the gate's 7-day texts, the daily cap, title repeats)

type Row = { m: M; status: string; reason: string; screen?: string; cand?: { title: string; body: string; score: number; class: string } };
const rows: Row[] = [];
const IDEA = new Set(["candidate", "duplicate"]); // statuses an idea reaches here (the judge comes after)
const day = (m: M) => m.at.slice(0, 10);
const within = (a: M, b: M) => Date.parse(b.at) - Date.parse(a.at) <= LIVE_BACKFILL_DAYS * 86_400_000;
for (const [k, m] of mentions.entries()) {
  const earlier = rows.filter((r) => IDEA.has(r.status) && within(r.m, m));
  const gated = ideaGate({ text: m.text, user: m.user ?? null }, earlier.map((r) => r.m.text), true);
  if (gated) { rows.push({ m, status: "gated", reason: gated }); continue; }
  const s = screens[k];
  if (!s) { rows.push({ m, status: "error", reason: "the screen failed" }); continue; }
  const d = screenDecision(s.data, true);
  if (d.status === "screened") { rows.push({ m, status: "screened", reason: d.reason, screen: s.data.screen }); continue; }
  const cap = authorCap(rows.filter((r) => IDEA.has(r.status) && r.m.author_id === m.author_id && day(r.m) === day(m)).length, true);
  if (cap) { rows.push({ m, status: "gated", reason: cap, screen: s.data.screen }); continue; }
  if (earlier.some((r) => r.cand && titleKey(r.cand.title) === titleKey(d.title))) { rows.push({ m, status: "duplicate", reason: "same title as an idea received in the last 7 days", screen: s.data.screen }); continue; }
  rows.push({ m, status: "candidate", reason: d.reason, screen: s.data.screen, cand: { title: d.title, body: d.body, score: d.score, class: d.class } });
}

// ---------------------------------------------------------------- 3. the judge (judgeLive's steps, no DB): in parallel

type Judged = { status: "queued" | "rejected"; reason: string; understood?: string; plain: string; instead?: string; target?: string; spec?: string; kind?: string; redTeam?: string };
const judged = new Map<Row, Judged>();
await pool(rows.filter((r) => r.cand), 4, async (r) => {
  const c = r.cand!;
  const rd = await ask(`read ${r.m.id}`, () => agents.readIdea(c.title, c.body));
  if (!rd) return;
  const read = { id: 0, kind: rd.data.kind, summary: agents.sanitize(rd.data.summary), spec: agents.sanitize(rd.data.spec), untrusted: true as const };
  const out = await ask(`brain ${r.m.id}`, () => llm(brainCall("outcome", { mode: "live: one idea, judged as it came in", round: 0, ideas: [read], policyBounds: POLICY, stats: null }, model("brain"), TRYOUT_SELF)));
  if (!out) return;
  const j = out.data.ideas.find((y) => y.id === 0) ?? out.data.ideas[0];
  const { v0, x, spec } = standIn(j, read, r.m.author_id ? { source: "x", authorId: r.m.author_id, postId: r.m.id } : null);
  let block: string | null = null, redTeam: string | undefined;
  if (x?.decision === "accept") {
    const rt = await ask(`red team ${r.m.id}`, () => agents.redTeam(false, { stage: `live idea x:${r.m.id} outcome${v0 ? " (its closest buildable version)" : ""}`, candidate: [{ id: 0, decision: x.decision, kind: x.kind }], sim: {}, gates: outcomeGates([x.kind]), quotedHypothesis: `#0 ${x.decision}: ${v0 ? `build instead: ${v0.title}: ${v0.spec}` : x.reason}` }));
    // no answer from the red team: as in production, nothing is queued without one
    block = rt ? (rt.data.verdict === "block" ? agents.sanitize(rt.data.findings[0]?.title ?? "see the red team") : null) : "no red-team answer";
    redTeam = rt?.data.verdict ?? "no answer";
  }
  const row = reportRow({ id: 0, index: -1 }, x, spec, block);
  const { variant, understood, plain } = settled(j, x, v0, row);
  const queued = row.decision === "accept" && (row.kind === "build" || row.kind === "fee");
  judged.set(r, {
    status: queued ? "queued" : "rejected", reason: queued ? (variant ? `a buildable version (${variant.target}): ${row.title}` : `accepted (${row.kind})`) : `${row.decision}: ${row.reason}`,
    understood, plain, kind: row.kind, spec: queued ? row.spec : undefined, redTeam, ...(variant ? { instead: row.title, target: variant.target } : {}),
  });
});

// ---------------------------------------------------------------- 4. the reply (the reply reader, intakeFactOf, the writer through the filters)

type Reply = { kind?: string; facts?: Record<string, unknown>; text?: string; issues?: string[] };
const replies = await pool(rows, 6, async (r): Promise<Reply> => {
  const cls = await ask(`reply reader ${r.m.id}`, () => classifyMention(r.m.text));
  if (!cls) return {};
  // only a mention the reply reader calls an idea gets the idea facts (src/x.ts: raw.category === "idea")
  if (cls.data.kind !== "idea") return { kind: cls.data.kind };
  const v = judged.get(r);
  const status = v?.status ?? r.status;
  const fact = intakeFactOf({ status, score: r.cand?.score ?? null, reason: v?.reason ?? r.reason, title: r.cand?.title ?? null },
    { cls: r.cand?.class ?? null, understood: v?.understood ?? null, plain: v?.plain ?? null, instead: v?.instead ?? null }, true);
  const topic = cls.data.topic;
  const facts = factSheet({ event: "reply", category: "idea", topic, question: cls.data.question || undefined, mechanics: mechanicsFor(topic, false), ...fact });
  const allowed = factNumbers(facts);
  const filter = (text: string) => [...postFilter(text, allowed, 0, { intent: intentOf(facts), priceJoke: false, claim: claimFacts(facts) }), ...claimIssues(facts, text), ...allyIssues(facts, text), ...promiseIssue(text),
    ...voiceIssues(facts, text, { linked: false, mention: r.m.text }), ...[parrotIssue(facts, text)].filter((x): x is string => !!x), ...bundleIssues(text)];
  const shapes = chooseShapes(shapesFor("reply", facts, undefined), [], "reply");
  const w = await ask(`writer ${r.m.id}`, () => draftInCharacter(facts, [], filter, null, undefined, shapes));
  if (!w) return { kind: "idea", facts };
  const passing = w.candidates.filter((c) => !c.issues.length);
  const j = passing.length >= 2 ? await ask(`reply judge ${r.m.id}`, () => llm(judgeCall(facts, passing.map((c) => c.text), []))) : null;
  const best = pickBest(w.candidates, j?.data ?? null);
  return { kind: "idea", facts, text: best?.text, issues: best ? undefined : [...new Set(w.candidates.flatMap((c) => c.issues))] };
});

// ---------------------------------------------------------------- the report

const cell = (s: unknown, n = 400) => String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, n);
const before = (m: M) => cell(`${m.status ?? "-"}${m.reason ? `: ${m.reason}` : ""}`, 160);
const verdict = (r: Row) => {
  const v = judged.get(r);
  if (v) return v.status === "queued" ? (v.instead ? "**buildable version**" : "**in**") : "out";
  if (r.cand) return "judge failed";
  return r.status === "gated" ? `held back (${r.reason})` : r.status === "duplicate" ? "a repeat" : r.status === "screened" ? `not an idea (${r.screen})` : r.status;
};
const built = (r: Row) => {
  const v = judged.get(r);
  if (!v) return "-";
  if (v.status !== "queued") return cell(`- (${v.reason})`, 260);
  return cell(v.instead ? `${v.target}: ${v.instead}. ${v.spec ?? ""}` : `${v.kind}: ${v.spec ?? ""}`, 420);
};
const all = rows.map((r, k) => ({ r, reply: replies[k] }));
const ideaRows = all.filter(({ r, reply }) => r.cand || reply.kind === "idea" || (r.m.status && r.m.status !== "screened"));
const rest = all.filter((x) => !ideaRows.includes(x));
const count = (f: (r: Row) => boolean) => rows.filter(f).length;
const judgedAll = [...judged.values()];
const md = [
  "# Idea replay",
  "",
  `${arg.dry ? "Dry (synthetic answers)" : "Live models"}, offline: nothing posted, no database. ${mentions.length} mentions from ${mentions[0]?.at.slice(0, 10)} to ${mentions.at(-1)?.at.slice(0, 10)}. ${calls.length} model calls, $${spent().toFixed(4)} of $${budget}. The judge gets the tryout self-file (src/tryout.ts) and no pool stats (no chain).`,
  "",
  `Ideas judged: ${judged.size}. In: ${judgedAll.filter((v) => v.status === "queued" && !v.instead).length}. A buildable version: ${judgedAll.filter((v) => v.instead).length}. Out: ${judgedAll.filter((v) => v.status === "rejected").length}. Held back by the gate: ${count((r) => r.status === "gated")} (links: ${count((r) => /^links/.test(r.reason))}, one a day: ${count((r) => /^already/.test(r.reason))}, near repeat: ${count((r) => /near-duplicate/.test(r.reason))}). Not ideas: ${count((r) => r.status === "screened")}.`,
  "",
  "## Ideas",
  "",
  "Every mention the screen read as an idea, the reply reader called an idea, or that had an idea verdict before.",
  "",
  "| # | author | post | before | now | what would be built | why (plain) | reply they would see |",
  "|---|---|---|---|---|---|---|---|",
  ...ideaRows.map(({ r, reply }, i) => `| ${i + 1} | @${cell(r.m.username ?? r.m.author_id, 30)} | ${cell(r.m.text, 220)} | ${before(r.m)} | ${cell(verdict(r), 120)} | ${built(r)} | ${cell(judged.get(r)?.plain ?? "-", 240)} | ${reply.text ? cell(reply.text, 400) : reply.kind === "idea" ? `(no draft passed: ${cell(reply.issues?.join(", ") ?? "writer failed", 200)})` : `(reply reader: ${reply.kind ?? "failed"}; no idea reply)`} |`),
  "",
  "## Everything else",
  "",
  "| author | post | before | screen now | reply reader |",
  "|---|---|---|---|---|",
  ...rest.map(({ r, reply }) => `| @${cell(r.m.username ?? r.m.author_id, 30)} | ${cell(r.m.text, 160)} | ${before(r.m)} | ${cell(verdict(r), 80)} | ${reply.kind ?? "failed"} |`),
  "",
  "## Failures and refusals",
  "",
  ...(failures.length ? failures.map((f) => `- ${cell(f, 400)}`) : ["none"]),
  "",
];
const outPath = resolve(arg.out!);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, md.join("\n"));
console.log(`replay: ${mentions.length} mentions, ${judged.size} judged, ${calls.length} calls, $${spent().toFixed(4)} of $${budget}, ${failures.length} failures → ${outPath}`);
await fakes?.close?.();
process.exit(0);
