// Staging run of post images against the real services: the studio's own generate() (OpenAI Images, each event in the
// style production would pick after the ones before it; moderation, the near-duplicate check, the vision rubric), then
// the enclave's checks on every image
// the studio passed (size, visible pixels, the in-enclave yes/no vision check on the registry's vision model), then the
// card the enclave would post (that art + worst-case facts) and the fallback plate card. Nothing is posted or sent.
// Output: a contact sheet (index.html: every candidate with its verdict and scores, every card) and report.json, in
// stage/out/images-<UTC>/ (gitignored), for a human to judge the style and the thresholds.
//   live: OPENAI_API_KEY=… OPENROUTER_API_KEY_ENGINE=… node scripts/stage-images.ts [--max-images 30] [--events outcome,digest] [--budget 2]
//   dry:  node scripts/stage-images.ts --dry   (the local fakes: synthetic images and answers, no network)
// Cost: images are capped by the studio's own round cap (STUDIO_DAILY_ROUNDS = max-images / 3, fresh per run): a
// generate() takes up to 2 rounds of 3 candidates per event and stops at the first round with a passing candidate.
// The vision checks are model calls under --budget (USD, in-memory ledger). STUDIO_VIA=openrouter is honoured.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { die, dryFakes, guardEnv, memLedger, outDir, writeJson } from "./stage-lib.ts";

const NAME = "stage-images";
const { values: arg } = parseArgs({ options: {
  dry: { type: "boolean", default: false }, "max-images": { type: "string", default: "30" }, events: { type: "string" },
  budget: { type: "string", default: "2" }, out: { type: "string" },
} });
guardEnv(NAME);
const maxImages = Number(arg["max-images"]);
if (!(Number.isInteger(maxImages) && maxImages >= 3 && maxImages <= 60)) die(NAME, "--max-images is a whole number in 3..60");
const budget = Number(arg.budget);
if (!(budget > 0)) die(NAME, "--budget must be a positive number of USD");
const dir = outDir("images", arg.out);
for (const k of ["MEDIA_VISION_MODEL", "OPENAI_API_BASE", "OPENROUTER_API_BASE", "XAI_API_BASE", "STUDIO_DAILY_ROUNDS"]) delete process.env[k];
// the studio's own state (round cap, near-duplicate store) lives in this run's directory: the cap is per run
Object.assign(process.env, { STUDIO_DIR: join(dir, "studio"), STUDIO_DAILY_ROUNDS: String(Math.floor(maxImages / 3)) });
const fakes = arg.dry ? await dryFakes() : null;
if (fakes) Object.assign(process.env, { OPENAI_API_KEY: "dry", OPENROUTER_API_KEY_ENGINE: "dry", OPENROUTER_API_KEY_STUDIO: "dry" });
if (!process.env.OPENAI_API_KEY) die(NAME, "needs OPENAI_API_KEY (images, moderation, rubric) or --dry");
if (!process.env.OPENROUTER_API_KEY_ENGINE) die(NAME, "needs OPENROUTER_API_KEY_ENGINE (the in-enclave vision check) or --dry");
if (process.env.STUDIO_VIA === "openrouter" && !process.env.OPENROUTER_API_KEY_STUDIO) die(NAME, "STUDIO_VIA=openrouter needs OPENROUTER_API_KEY_STUDIO");

const ledger = await memLedger(budget);
const studio = await import("../src/studio.ts");
const { ART_EVENTS, artIssue, composite, factLayer, MAX_BYTES, plateIndex, plates, shapeOf, slotsOf, visiblePixels, visionIssue } = await import("../src/card.ts");
const { MEDIA } = await import("../src/config.ts");
const { moodOf, pickStyle } = await import("../src/media-slots.ts");
const shown: string[] = []; // the styles this run used, newest first (production: the last 3 image posts)

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const GENERATION = 128;
const fakeAddr = (i: number) => `0x${createHash("sha256").update(`stage-winner-${i}`).digest("hex").slice(0, 40)}`;
/** Worst case for the fact layer: the longest figures each event can carry (10 winners, big weights, 5 square figures). */
const SAMPLES: Record<string, { facts: Record<string, unknown>; raw?: Record<string, unknown> }> = {
  outcome: { facts: { event: "outcome", outcome: "kept (promoted)", plate: "C", fee: { basePct: 2.4, multiplier: 1.3, capPct: 3.5 }, samples: 12_840, reason: "promoted to the live fee" } },
  jackpot_drawn: { facts: { event: "jackpot_drawn", window: 1234, winners: 10, shareEth: 0.123, prizeEth: 1.23 }, raw: { args: { paid: Array.from({ length: 10 }, (_, i) => ({ account: fakeAddr(i) })) } } },
  ballot_result: { facts: { event: "ballot_result", ballot: 42, outcome: "queued for testing", winnerWeight: 1_234_567.891, totalWeight: 9_876_543.21 } },
  mystery_result: { facts: { event: "mystery_result", mystery: 7, outcome: "rejected" } },
  digest: { facts: { event: "digest", generation: GENERATION, survived: 3, extinct: 12, winners: 10, ethPaid: 12.345, dnaBurned: 207_512_345 } },
};
const events = (arg.events ? arg.events.split(",") : [...ART_EVENTS]).map((e) => e.trim());
for (const e of events) if (!SAMPLES[e]) die(NAME, `unknown event ${e} (one of ${ART_EVENTS.join(", ")})`);

// every candidate the studio sees, with each gate's answer (generate() keeps only the winner)
type Cand = { event: string; round: number; i: number; file: string; sha: string; bytes: number; size: string | null; flagged?: boolean; scores?: unknown; reason?: string; chosen?: boolean; phash?: string };
const cands: Cand[] = [];
const usage: unknown[] = [];
let current = "";
const base = studio.activeClient();
const bySha = (png: Buffer) => cands.find((c) => c.sha === sha256(png));
const client: typeof base = {
  async images(prompt, refs, n, size) {
    const r = await base.images(prompt, refs, n, size);
    usage.push(r.usage);
    const round = new Set(cands.filter((c) => c.event === current).map((c) => c.round)).size;
    r.images.forEach((img, i) => {
      const file = `cand-${current}-r${round}-${i}.${img[0] === 0x89 ? "png" : "jpg"}`;
      writeFileSync(join(dir, file), img);
      cands.push({ event: current, round, i, file, sha: sha256(img), bytes: img.length, size: artIssue(img, shapeOf(current)) });
    });
    return r;
  },
  async flagged(png) { const f = await base.flagged(png); const c = bySha(png); if (c) c.flagged = f; return f; },
  async rubric(png, recent, style) { const s = await base.rubric(png, recent, style); const c = bySha(png); if (c) c.scores = s; return s; },
};

type Out = { event: string; meta: unknown; art?: { file: string; enclave: string | null; ms: number }; card?: { file: string; bytes: number; overLimit: boolean }; plate?: { file: string; plate: string; bytes: number } | { error: string } };
const results: Out[] = [];
const runId = new Date().toISOString();
const p = plates();
for (const event of events) {
  current = event;
  const { facts, raw = {} } = SAMPLES[event];
  const shape = shapeOf(event);
  const key = `stage:${event}:${runId}`;
  console.error(`${NAME}: ${event}`);
  const style = pickStyle(event, moodOf(facts), shown);
  shown.unshift(style);
  const meta = await studio.generate(key, slotsOf(facts, key, style), shape, client).catch((e) => ({ status: "error", error: (e as Error).message.slice(0, 300) }));
  for (const c of cands.filter((c) => c.event === event)) {
    c.reason = (meta as { reasons?: string[] }).reasons?.find((r) => r.startsWith(`round ${c.round} candidate ${c.i}:`))?.split(": ").slice(1).join(": ");
    c.chosen = (meta as { sha256?: string }).sha256 === c.sha;
  }
  const layer = factLayer(facts, raw, GENERATION);
  const out: Out = { event, meta };
  if ((meta as { status: string }).status === "ready") {
    const art = readFileSync(join(process.env.STUDIO_DIR!, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.art`));
    // the enclave's re-check (src/card.ts studioArt), every step of it
    const t = Date.now();
    const enclave = artIssue(art, shape) ?? (visiblePixels(art) === 0 ? "fully transparent" : null) ?? (await visionIssue(art));
    const card = composite(art, layer, shape);
    const file = `card-${event}.png`;
    writeFileSync(join(dir, file), card);
    out.art = { file: cands.find((c) => c.event === event && c.chosen)?.file ?? "", enclave, ms: Date.now() - t };
    out.card = { file, bytes: card.length, overLimit: card.length > MAX_BYTES };
  }
  try {
    const i = plateIndex(key, p.plates, null, []);
    const card = composite(p.bytes(i), layer, shape);
    writeFileSync(join(dir, `plate-${event}.png`), card);
    out.plate = { file: `plate-${event}.png`, plate: p.plates[i].file, bytes: card.length };
  } catch (e) {
    out.plate = { error: (e as Error).message.slice(0, 200) };
  }
  results.push(out);
}

// near-duplicates across every candidate of the run (the studio checks each against the ones it kept)
for (const c of cands) if (!c.size) c.phash = studio.phash(readFileSync(join(dir, c.file))).toString(16);
const pairs: { a: string; b: string; d: number }[] = [];
const hashed = cands.filter((c) => c.phash);
for (let x = 0; x < hashed.length; x++) for (let y = x + 1; y < hashed.length; y++) pairs.push({ a: hashed[x].file, b: hashed[y].file, d: studio.hamming(BigInt(`0x${hashed[x].phash}`), BigInt(`0x${hashed[y].phash}`)) });
pairs.sort((a, b) => a.d - b.d);

type Scores = Record<"onBrand" | "clean" | "room" | "original", number>;
const scored = cands.map((c) => c.scores as Scores | undefined).filter((s): s is Scores => !!s);
const dist = (k: keyof Scores) => { const v = scored.map((s) => s[k]).sort((a, b) => a - b); return v.length ? { min: v[0], median: v[Math.floor(v.length / 2)], max: v.at(-1) } : null; };
const report = {
  mode: arg.dry ? "dry (local fakes, synthetic images)" : "live", at: new Date().toISOString(), via: studio.STUDIO.via, imageModel: studio.STUDIO.model, rubricModel: studio.STUDIO.rubricModel,
  visionModel: MEDIA.visionModel, minScore: studio.STUDIO.minScore, dupDistance: studio.STUDIO.dupDistance, maxImages, refs: studio.references().refs.length, platesPlaceholder: p.placeholder,
  totals: {
    events: events.length, ready: results.filter((r) => (r.meta as { status: string }).status === "ready").length, candidates: cands.length,
    flagged: cands.filter((c) => c.flagged).length, wrongSize: cands.filter((c) => c.size).length, rubricSawText: cands.filter((c) => (c.scores as { text?: boolean } | undefined)?.text).length,
    lowScore: cands.filter((c) => c.reason?.startsWith("low")).length, nearDuplicate: cands.filter((c) => c.reason?.startsWith("near-duplicate")).length,
    enclaveRejected: results.filter((r) => r.art?.enclave).length, cardsOverLimit: results.filter((r) => r.card?.overLimit).length,
    closestPair: pairs[0] ?? null, visionUsd: Number(ledger.spent().toFixed(4)),
  },
  scores: { onBrand: dist("onBrand"), clean: dist("clean"), room: dist("room"), original: dist("original") },
  results, candidates: cands, nearestPairs: pairs.slice(0, 10), imageUsage: usage, visionCalls: ledger.calls, alerts: ledger.alerts,
};
writeJson(dir, "report.json", report);
writeFileSync(join(dir, "index.html"), sheet(report));
console.error(`${NAME}: ${report.totals.ready}/${events.length} events got art, ${cands.length} candidates, ${report.totals.enclaveRejected} rejected by the enclave check; ${dir}/index.html`);
await fakes?.close();
process.exit(0);

function sheet(r: typeof report) {
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const img = (f: string, w = 384) => `<a href="${esc(f)}"><img src="${esc(f)}" width="${w}" loading="lazy"></a>`;
  const rows = r.results.map((o) => {
    const cs = r.candidates.filter((c) => c.event === o.event).map((c) => `<figure class="${c.chosen ? "won" : ""}">${img(c.file, 256)}<figcaption>r${c.round}·${c.i} ${c.chosen ? "<b>chosen</b>" : esc(c.reason ?? (c.size ? c.size : "not reached"))}<br>${c.scores ? esc(JSON.stringify(c.scores)) : ""}${c.flagged ? " <b>flagged</b>" : ""}</figcaption></figure>`).join("");
    const plate = o.plate && "file" in o.plate ? `<figure>${img(o.plate.file)}<figcaption>plate ${esc(o.plate.plate)} · ${o.plate.bytes} bytes</figcaption></figure>` : `<p>plate: ${esc(o.plate && "error" in o.plate ? o.plate.error : "none")}</p>`;
    const card = o.card ? `<figure>${img(o.card.file)}<figcaption>card · ${o.card.bytes} bytes${o.card.overLimit ? " <b>OVER 5 MB</b>" : ""} · enclave: ${esc(o.art?.enclave ?? "pass")}</figcaption></figure>` : `<p>no studio art: ${esc((o.meta as { status?: string }).status)}</p>`;
    return `<h2>${esc(o.event)}</h2><div class="row">${card}${plate}</div><h3>candidates</h3><div class="row">${cs}</div>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><title>Image staging ${esc(r.at)}</title>
<style>body{font:14px system-ui;background:#05090b;color:#f2efe6;margin:24px}figure{margin:0 12px 12px 0;display:inline-block;vertical-align:top;max-width:400px}figcaption{font-size:12px;color:#9fb3b3}.won img{outline:3px solid #c9f2e4}pre{white-space:pre-wrap;color:#c9f2e4}</style>
<h1>Image staging · ${esc(r.mode)}</h1><pre>${esc(JSON.stringify({ via: r.via, imageModel: r.imageModel, rubricModel: r.rubricModel, visionModel: r.visionModel, totals: r.totals, scores: r.scores }, null, 2))}</pre>${rows}`;
}
