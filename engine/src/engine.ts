// DNA engine: job worker + scheduler + head watcher + Telegram long poll + /health, one process, one replica.
// Runs the keepers, anchors, tx sender, Telegram approvals, X, the agent loop (observe → hypothesis → simulate → red
// team → decide → plate state machine), IdeaMarket and genesis. The indexer (src/indexer.ts) is a separate service and
// never holds keys.
//   node src/engine.ts                         run
//   node src/engine.ts enqueue <kind> [json]   insert a job now (operator / e2e), e.g. enqueue anchor '{"day":"2026-10-05"}'
//   node src/engine.ts draft <kind> <json>     create an approval draft (payload.text = exact final text)
// Env: see config.ts. ENCLAVE=1 (the Phala CVM build): env
// lockdown + TEE-derived keys (config.ts), no CLI and no registry:queue handler (no operator path to the agent key),
// signed state and the enclave log chain (log.ts), the boot check against log-head rollback (head.ts).
import { createServer } from "node:http";
import { AGENT_LOOP, GAS, IDEAS_LIVE, KEEPER, LLM, LOOP, PORT, PRELAUNCH, SCHEDULER_MS, WATCH, X } from "./config.ts";
import { edb as sql, migrate } from "./db.ts";
import { dstackKeyProvider, ENCLAVE } from "./enclave.ts";
import { ownerCommand } from "./approve.ts";
import { CT, ctHandler } from "./ct.ts";
import { attestation, nonceOk } from "./attest.ts";
import { gameAgentHandler, gameKeeperHandlers } from "./games.ts";
import { bootAnchor, bootCheck, persistHead } from "./head.ts";
import { setKeyProvider } from "./sealed.ts";
import { enqueue, type Handler, schedule, type Schedule, startWorker } from "./jobs.ts";
import { ideaLoopHandler } from "./idea-queue.ts";
import { intakeHandler, liveHandler, roundsHandler } from "./ideas.ts";
import { ideaOfDayHandler, ideaUpdatesHandler, shoutoutHandler, threadsHandler } from "./x-social.ts";
import { pagesDailyHandler, seqHandler, seqHourlyHandler } from "./sequencer.ts";
import { selfHandler } from "./self.ts";
import { revertHandler } from "./pages.ts";
import { anchorHandler, endCanaryHandler, KEEPER_EVERY, keeperHandlers, queueHandler } from "./keepers.ts";
import { clonesHandler } from "./clones.ts";
import { dailyCap, partition, spendToday } from "./llm.ts";
import { cycleHandler, genesisHandler, getLoop, journalHandler, prelaunchCycleHandler, pulseHandler, tickHandler } from "./loop.ts";
import { closeFork, forkStats } from "./sim.ts";
import { observeHandler } from "./observe.ts";
import { getFlags, initMode, setOverride, waitWhenHalted } from "./mode.ts";
import { alert, alertHandler, createDraft, draftHandler, pollTelegram, publicHandler } from "./telegram.ts";
import { AGENT_HOLD, balances } from "./tx.ts";
import { keyAddresses, lastWatched, minuteChecks, watchTick } from "./watch.ts";
import { CHARACTER_MEMORY, deletePost, digestHandler, mentionsHandler, postDraft, quotesHandler, pressReply, repliesHandler, scoutHandler, sendHandler, setMuted } from "./x.ts";
import { auditHandler, characterContext } from "./character.ts";
import { labHandler, labSchedule } from "./lab.ts";
import { launchHandler, milestonesHandler, progressHandler, recapHandler, siteChangesHandler, statusHandler, treasuryHandler, xSchedules } from "./status.ts";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd && ENCLAVE.on) throw new Error("the enclave build has no CLI commands");
await migrate();
const boot = ENCLAVE.on ? await enclaveBoot() : undefined;
async function enclaveBoot() {
  setKeyProvider(dstackKeyProvider()); // the X refresh token is sealed with a TEE-derived key
  return bootCheck(); // throws: the process exits, the enclave refuses to start
}
if (cmd === "enqueue") {
  console.log("job", await enqueue(rest[0], rest[1] ? JSON.parse(rest[1]) : {}));
  process.exit(0);
}
if (cmd === "draft") {
  console.log("draft", await createDraft(rest[0], JSON.parse(rest[1])));
  process.exit(0);
}
if (cmd) throw new Error(`unknown command ${cmd}`);

await initMode();
// the X writer's memory is wired here and only here (test/character-imports.test.ts)
CHARACTER_MEMORY.context = characterContext;

const base: Record<string, Handler> = {
  alert: alertHandler,
  "tg:public": publicHandler,
  genesis: genesisHandler,
  draft: draftHandler({ x_post: postDraft }),
};
// Pre-launch (no deployment): genesis research once, then an analytic cycle every CYCLE_MS (+ alerts and X drafts).
// Otherwise the full engine. Halted: every job that calls a model waits (mode.ts MODEL_JOBS).
const handlers: Record<string, Handler> = waitWhenHalted(PRELAUNCH ? { ...base, cycle: prelaunchCycleHandler } : {
  ...base,
  ...keeperHandlers,
  ...gameKeeperHandlers,
  "games:agent": gameAgentHandler,
  anchor: anchorHandler,
  // the operator's CLI path to an agent op: never in the enclave build (agentOpGate refuses ops no experiment owns)
  ...(ENCLAVE.on ? {} : { "registry:queue": queueHandler }),
  "registry:endCanary": endCanaryHandler,
  "x:mentions": mentionsHandler,
  "x:quotes": quotesHandler,
  "x:replies": repliesHandler,
  "x:send": sendHandler,
  "x:digest": digestHandler,
  "x:ct": ctHandler,
  "x:status": statusHandler,
  "site:changes": siteChangesHandler,
  "treasury": treasuryHandler,
  "x:recap": recapHandler,
  "x:milestones": milestonesHandler,
  "x:launch": launchHandler,
  "x:progress": progressHandler,
  "x:lab": labHandler,
  "x:scout": scoutHandler,
  "voice:audit": auditHandler,
  observe: observeHandler,
  clones: clonesHandler,
  cycle: cycleHandler,
  "plates:tick": tickHandler,
  journal: journalHandler,
  pulse: pulseHandler,
  "ideas:intake": intakeHandler,
  "ideas:rounds": roundsHandler,
  "ideas:live": liveHandler,
  "ideas:loop": ideaLoopHandler,
  "x:idea_updates": ideaUpdatesHandler,
  "x:idea_of_day": ideaOfDayHandler,
  "x:shoutout": shoutoutHandler,
  "x:threads": threadsHandler,
  "seq:step": seqHandler,
  "seq:hourly": seqHourlyHandler,
  "pages:daily": pagesDailyHandler,
  "pages:revert": revertHandler,
  "brain:self": selfHandler,
});

const DAY = 86_400_000;
const HOUR = 3600_000;
const prevDay = (start: Date) => ({ day: new Date(start.getTime() - DAY).toISOString().slice(0, 10) });
const schedules: Schedule[] = PRELAUNCH ? [{ kind: "cycle", everyMs: LOOP.cycleMs }] : [
  ...Object.entries(KEEPER_EVERY).map(([k, everyMs]) => ({ kind: `keeper:${k}`, everyMs })),
  { kind: "keeper:execute", everyMs: KEEPER.executeMs },
  { kind: "keeper:finalize", everyMs: KEEPER.executeMs },
  // the game layer (no-ops until its contracts are in the deployment): pot/board with the execute cadence; the agent's
  // jackpot params + list, ballot / mystery / interval tasks hourly with the loop
  { kind: "keeper:games", everyMs: KEEPER.executeMs },
  // every website change gets one post (src/status.ts siteChangesHandler)
  { kind: "site:changes", everyMs: KEEPER.executeMs },
  // the Safe's DNA moves: a buy on the pool, a transfer out (src/status.ts treasuryHandler)
  { kind: "treasury", everyMs: KEEPER.executeMs },
  ...(AGENT_LOOP ? [{ kind: "games:agent", everyMs: HOUR }] : []),
  // 00:10 UTC: anchor the day that just ended
  { kind: "anchor", everyMs: DAY, offsetMs: 10 * 60_000, payload: prevDay },
  ...(X.userId ? [{ kind: "x:mentions", everyMs: X.mentionsMs }, { kind: "ideas:intake", everyMs: X.mentionsMs }, { kind: "x:replies", everyMs: X.mentionsMs }, ...(IDEAS_LIVE ? [{ kind: "x:quotes", everyMs: HOUR }] : [])] : []),
  // X posting: the outbox drains one item a minute within the caps; the tone brief daily at 06:00 UTC; the status at
  // 14:00 and 22:00 UTC, the recap Sundays 18:00 UTC, milestones hourly, the launch-day posts and chain progress every
  // 2 h (src/status.ts); the lab every 2 h on a launch day, 6 h after (src/lab.ts)
  ...(X.clientId ? [{ kind: "x:send", everyMs: X.sendMs }, { kind: "x:scout", everyMs: DAY, offsetMs: 6 * HOUR }, { kind: "voice:audit", everyMs: 7 * DAY, offsetMs: 5 * HOUR }, { kind: "x:digest", everyMs: DAY, offsetMs: 23 * HOUR, payload: (start: Date) => ({ due: start.toISOString() }) }, ...xSchedules(), labSchedule()] : []),
  // agent loop: observe every 5 min (a feed line per finalized
  // advance), the full cycle every CYCLE_MS, plate ticks with the keeper cadence, an hourly pulse, journal 00:05 UTC.
  // Periods without a payload coalesce (jobs.ts schedule): a cycle still running or deferred never stacks a backlog.
  { kind: "observe", everyMs: LOOP.observeMs },
  // takes on crypto Twitter: about 5 a day at seeded times, each only when there is something worth one (src/ct.ts)
  ...(X.clientId ? [{ kind: "x:ct", everyMs: CT.everyMs }] : []),
  // copy pools: new DNA pools without the hook + the leakage share (src/clones.ts), with the loop's cadence
  { kind: "clones", everyMs: LOOP.cycleMs },
  { kind: "plates:tick", everyMs: KEEPER.executeMs },
  ...(AGENT_LOOP ? [{ kind: "cycle", everyMs: LOOP.cycleMs }] : []),
  { kind: "pulse", everyMs: LOOP.pulseMs },
  { kind: "journal", everyMs: DAY, offsetMs: 5 * 60_000, payload: prevDay },
  { kind: "ideas:rounds", everyMs: HOUR },
  // live mode (IDEA_MODE=live): each site submit judged within a minute of being indexed (X ideas: in ideas:intake)
  ...(IDEAS_LIVE ? [{ kind: "ideas:live", everyMs: 60_000 }] : []),
  // accepted ideas of final rounds: fee ideas into the experiment pipeline, rewards for kept ones (with the agent loop)
  ...(AGENT_LOOP ? [{ kind: "ideas:loop", everyMs: HOUR }] : []),
  // the social layer on X (src/x-social.ts): ideas' progress told to their authors every 10 min, the idea of the day at
  // 20:00 UTC, the idea-givers' shoutout Sundays 17:00 UTC, thread turns every 30 min
  ...(X.userId && X.clientId ? [{ kind: "x:idea_updates", everyMs: 10 * 60_000 }, { kind: "x:idea_of_day", everyMs: DAY, offsetMs: 20 * HOUR },
    { kind: "x:shoutout", everyMs: 7 * DAY, offsetMs: 3 * DAY + 17 * HOUR }, { kind: "x:threads", everyMs: 30 * 60_000 }] : []),
  // the Sequencer (src/sequencer.ts): a build step a minute (from launch: SEQ_OPEN_DELAY_MIN, default 0); games, release and the
  // day's post hourly
  { kind: "seq:step", everyMs: 60_000 },
  { kind: "seq:hourly", everyMs: HOUR, offsetMs: 15 * 60_000 },
  // every shipped game's live page, as visitors get it, through the page check (src/pages.ts)
  { kind: "pages:daily", everyMs: DAY, offsetMs: 4 * HOUR },
  // the brain's self-file (src/self.ts), signed fresh at 00:15 UTC, after the day's anchor
  { kind: "brain:self", everyMs: DAY, offsetMs: 15 * 60_000 },
];
if (PRELAUNCH) await enqueue("genesis", {}, { dedupeKey: "genesis" });

let stopping = false;
// a failed alert job is not re-alerted (Telegram down would otherwise chain alerts about alerts)
const stopWorker = startWorker(handlers, (job, err) => job.kind !== "alert" && void alert(`Job ${job.kind} #${job.id} failed ${job.attempts}× (last: ${String((err as Error)?.message ?? err).slice(0, 300)})`, `alert:jobfail:${job.id}`));

const loop = (name: string, ms: number, fn: () => Promise<unknown>) => (async () => {
  while (!stopping) {
    await fn().catch((e) => console.error(`${name} failed:`, (e as Error).message ?? e));
    await new Promise((r) => setTimeout(r, ms));
  }
})();

const health = async () => {
  const [flags, [due], spend, bal, st] = await Promise.all([
    getFlags(),
    sql<{ oldest: Date | null; n: number }[]>`select min(run_at) as oldest, count(*)::int as n from job where status = 'queued' and run_at <= now()`,
    spendToday(), balances().catch(() => ({})), getLoop(),
  ]);
  return {
    ...flags, prelaunch: PRELAUNCH, keys: keyAddresses(), balancesEth: bal, lastWatcherBlock: lastWatched()?.toString() ?? null,
    loop: { cycleMs: LOOP.cycleMs, cycle: st.cycle, cyclesToday: st.day === new Date().toISOString().slice(0, 10) ? st.cyclesToday ?? 0 : 0, searchThread: st.thread ?? null, fork: forkStats },
    dueJobs: due.n, oldestDueJobAgeS: due.oldest ? Math.round((Date.now() - due.oldest.getTime()) / 1000) : 0,
    llmSpendTodayUsd: Number(spend.total.toFixed(4)), llmSpendByBudget: spend.by, llmCapUsd: dailyCap(Date.now()), gas: { maxGwei: GAS.maxGwei },
  };
};

const commands = {
  // `by` is the sender's allowlist place (src/telegram.ts signerTag): the public log never holds a Telegram id
  "/halt": async (by: string) => `Mode: ${(await setOverride("halted", by)).mode}`,
  "/dryrun": async (by: string) => `Mode: ${(await setOverride("dry_run", by)).mode}`,
  "/mute": async (by: string) => { await setMuted(true, by); return "X posting muted: the queue is dropped; /unmute resumes."; },
  "/unmute": async (by: string) => { await setMuted(false, by); return "X posting resumed."; },
  // a brake: removes one of our own posts, never posts (src/x.ts deletePost)
  "/delete": async (by: string, args: string[]) => deletePost(args[0], by),
  "/live": async () => "live is env-only: an operator sets ENGINE_MODE=live on Railway (that redeploy clears Telegram overrides).",
  "/status": async () => JSON.stringify(await health(), null, 1),
  // M1: a Safe owner's signature on a delayed record or a pending draft (the signature is the gate; scripts/owner-digest.ts)
  "/approve": async (_by: string, args: string[]) => ownerCommand("approve", args),
  "/veto": async (_by: string, args: string[]) => ownerCommand("veto", args),
  "/budget": async () => {
    const s = await spendToday();
    const cap = dailyCap(Date.now());
    const p = partition(cap);
    const dev = s.by.dev ?? 0;
    return `LLM today $${s.total.toFixed(2)} / $${cap} (month $${(s.month?.total ?? 0).toFixed(2)} / $${LLM.monthlyCapUsd})\nSequencer: $${dev.toFixed(2)} / $${p.dev.toFixed(2)} (reservations included)\nshared: $${(s.total - dev).toFixed(2)} / $${p.shared.toFixed(2)}\n${Object.entries(LLM.subCapsUsd).map(([b, c]) => `${b}: $${(s.by[b] ?? 0).toFixed(2)} / $${c}`).join("\n")}`;
  },
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://engine");
  // read-only, public (the /proof page fetches it from the browser): a fresh quote bound to the caller's nonce
  if (url.pathname === "/attestation" && ENCLAVE.on) {
    const cors = { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" };
    const nonce = url.searchParams.get("nonce");
    if (req.method !== "GET" || !nonceOk(nonce)) return void res.writeHead(400, cors).end(JSON.stringify({ error: "GET /attestation?nonce=<1-32 bytes hex>" }));
    // simplification: one quote per request, no rate limit (a quote is cheap for the guest agent); add one if it's abused
    return void attestation(nonce).then(
      (a) => res.writeHead(200, cors).end(JSON.stringify(a)),
      (e) => res.writeHead(503, cors).end(JSON.stringify({ error: String((e as Error).message) })),
    );
  }
  if (url.pathname !== "/health") return void res.writeHead(404).end();
  health().then(
    (h) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(h)),
    (e) => res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: String((e as Error).message) })),
  );
}).listen(PORT);

const heartbeat = async () => {
  const flags = await getFlags();
  await sql`insert into state (key, block, value) values ('engine', ${Number(lastWatched() ?? 0)}, ${sql.json({ mode: flags.mode, at: new Date().toISOString(), lastWatcherBlock: Number(lastWatched() ?? 0) })})
    on conflict (key) do update set block = excluded.block, value = excluded.value, updated_at = now()`;
};

const loops = [
  loop("scheduler", SCHEDULER_MS, () => schedule(schedules)),
  ...(PRELAUNCH ? [] : [loop("watcher", WATCH.pollMs, watchTick)]),
  loop("heartbeat", 60_000, async () => { await heartbeat(); const headErr = boot ? persistHead(boot.scannedTo) : null; if (headErr) await alert(`Enclave: the disk head could not be written (${headErr.slice(0, 200)}); agent txs wait, the heartbeat retries.`, `alert:headsync:${new Date().toISOString().slice(0, 13)}`); if (boot && AGENT_HOLD.why) await bootAnchor().catch((e) => alert(`Boot anchor not mined yet (agent txs wait): ${(e as Error).message}`, `alert:bootanchor:${new Date().toISOString().slice(0, 13)}`)); if (!PRELAUNCH) await minuteChecks(); }),
  pollTelegram(commands, () => stopping, pressReply),
];
console.log(`engine up: mode ${(await getFlags()).mode}, port ${PORT}, ${Object.keys(handlers).length} job kinds`);

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  stopWorker();
  server.close();
  await Promise.race([Promise.all(loops), new Promise((r) => setTimeout(r, 5000))]);
  await closeFork();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
