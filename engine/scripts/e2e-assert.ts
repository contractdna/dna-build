// Assertions for scripts/e2e.sh. `getters`: the web's JSON API + Last-Event-ID replay after devchain.sh. `stream <file>`: what an
// open SSE stream received while the indexer loop ran and DevActions swapped + cancelled.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const WEB = process.env.WEB ?? "http://127.0.0.1:3078";
const get = async (p: string) => (await fetch(`${WEB}/api/${p}`)).json();

async function getters() {
  const core = await get("core");
  assert.deepEqual(
    { autonomy: core.autonomy, epoch: core.epoch, activeModules: core.activeModules, proposals: core.proposals, rollbacks: core.rollbacks, state: core.state },
    { autonomy: 5, epoch: 2, activeModules: 2, proposals: 12, rollbacks: 1, state: "observing" },
  );
  assert.ok(core.block > 0 && core.log.length === 5);
  assert.match(core.notes.activeModules, /baseline/);

  // homepage: the token address from the deployment manifest (copyable on the last screen); /live shows no sample badge
  const home = await (await fetch(`${WEB}/`)).text();
  const token: string = JSON.parse(readFileSync(new URL("../deployments/31337.json", import.meta.url), "utf8")).token;
  assert.ok(home.includes(token), "homepage CA (the full checksummed address)");
  const live = await (await fetch(`${WEB}/live`)).text();
  assert.ok(!live.includes("sample data"), "/live shows no sample badge in LIVE");

  const mods: { id: string; status: string; params: { value: string }[] }[] = await get("modules");
  assert.deepEqual(Object.fromEntries(mods.map((m) => [m.id, m.status])), {
    "adaptive-fee@v1": "active", "split-baseline@v1": "active", "dev-reverting-fee@v0": "rolled_back",
  });
  assert.deepEqual(mods.find((m) => m.id === "adaptive-fee@v1")!.params.map((p) => p.value), ["2.00%", "1.3×", "5.00%"]);

  const epochs = await get("epochs");
  assert.deepEqual(epochs.map((e: { name: string; rollbacks: number }) => [e.name, e.rollbacks]), [["GENESIS", 1], ["EPOCH 01", 0], ["EPOCH 02", 0]]);

  const queue: { op: string; status: string; target?: string }[] = await get("queue");
  assert.equal(queue.length, 12);
  assert.equal(queue.filter((q) => q.status === "executed").length, 11);
  assert.deepEqual(queue[0], { ...queue[0], op: "SetLevel", status: "cancelled", target: "level 6" });
  assert.ok(queue.filter((q) => q.op === "Register").every((q) => q.target?.startsWith("0x")));

  const t = await get("treasury");
  assert.deepEqual(new Set(t.flows.map((f: { kind: string }) => f.kind)), new Set(["fee", "distribute", "buyback", "burn", "auto-lp"]));
  assert.equal(t.split.reduce((n: number, s: { bps: number }) => n + s.bps, 0), 10_000);

  const sec: { kind: string }[] = await get("security");
  assert.equal(sec.filter((s) => s.kind === "rollback").length, 1);
  assert.equal(sec.filter((s) => s.kind === "guardian").length, 1);

  const autonomy = await get("autonomy");
  assert.equal(autonomy.current, 5);
  assert.equal(autonomy.interventions[0].action, "Cancelled queued op #12 (SetLevel)");

  const health = await get("health");
  assert.equal(health.stale, false);

  // accounting: FeeVault received exactly the FeeTaken project fees before it distributed
  const sql = postgres(process.env.DATABASE_URL!);
  const [{ fees, distributed }] = await sql`select
    (select sum((args->>'project')::numeric) from chain_log where event = 'FeeTaken'
       and block < (select block from chain_log where event = 'Distributed')) as fees,
    (select (args->>'amount')::numeric from chain_log where event = 'Distributed') as distributed`;
  assert.equal(String(fees), String(distributed));
  // swaps are persisted at finalized but never NOTIFYd from there; the head tier is the only swap source
  const [{ swaps }] = await sql`select count(*)::int as swaps from chain_log where event = 'Swap'`;
  assert.equal(swaps, 9); // bootstrap buy + swaps() ×2 (2 each) + 3 rollback buys + 1 buyback (platform fee only)
  await sql.end();
  console.log("getters OK");
}

async function replay() {
  // ids depend on how many blocks the run mined: read them instead of hardcoding
  const sql = postgres(process.env.DATABASE_URL!);
  const [promo] = await sql`select block::int as block, log_index from chain_log where event = 'StatusChanged' and args->>'to' = '4' order by block desc, log_index desc limit 1`;
  const [newest] = await sql`select block::int as block, log_index from chain_log where event = 'Cancelled' order by block desc limit 1`;
  await sql.end();
  const ctrl = new AbortController();
  const res = await fetch(`${WEB}/api/stream`, { headers: { "Last-Event-ID": `${promo.block - 1}:999999` }, signal: ctrl.signal });
  const reader = res.body!.getReader();
  let text = "";
  const until = Date.now() + 2000;
  while (Date.now() < until && !text.includes('"kind":"core"')) text += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  const last = `id: ${newest.block}:${newest.log_index}`;
  assert.ok(text.includes(`id: ${promo.block}:${promo.log_index}`) && text.includes('"kind":"activated"'), "promotion replayed");
  assert.ok(text.includes(last), "replay reaches the newest row");
  assert.ok(text.indexOf('"kind":"core"') > text.indexOf(last), "snapshot comes after the replayed rows");
  console.log("replay OK");
}

function stream(file: string) {
  const events = readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  const kinds = events.map((e) => e.kind);
  assert.equal(kinds[0], "core", "first message is the core snapshot");
  assert.ok(events.some((e) => e.kind === "swaps" && e.n >= 1 && e.id.startsWith("h:")), "head tier swaps");
  assert.ok(events.some((e) => e.kind === "block"), "head tier blocks");
  assert.ok(events.some((e) => e.kind === "chain" && e.text === "queued op #13 cancelled by the Safe" && /^\d+:\d+$/.test(e.id)), "finalized registry event");
  const cores = kinds.filter((k) => k === "core").length;
  assert.ok(cores >= 2 && cores <= 6, `core re-sent only when chain state changed (got ${cores})`); // not every tick
  assert.equal(events.findLast((e) => e.kind === "core").core.proposals, 13, "counts follow registry events");
  const ids = events.filter((e) => e.id).map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "no double emission");
  console.log(`stream OK (${events.length} events: ${[...new Set(kinds)].join(", ")})`);
}

const [mode, file] = process.argv.slice(2);
if (mode === "getters") { await getters(); await replay(); } else stream(file);
