// Server-Sent Events: the live feed. One Postgres LISTEN per server instance fans out to every open stream.
//  - first message: the chain-backed core snapshot (only when the client sends no Last-Event-ID), with the id of the
//    newest chain row so a reconnect replays from there
//  - reconnect (Last-Event-ID `${block}:${logIndex}`): replay ≤ 200 newer feed rows from chain_log, then (if any were
//    replayed) a fresh core snapshot so counters catch up
//  - chain events carry an SSE `id:`; head-tier events (block, swaps) carry their id only in the JSON (`h:${block}`),
//    so Last-Event-ID always points into chain_log. The client dedupes by id.
// Railway ends HTTP responses after 15 min; EventSource reconnects on its own and resumes via Last-Event-ID.
// Reconnect storms (a deploy, Railway's cut, a network blip) are smoothed: each stream ends itself after a random
// 10–14 min (so cuts never line up), `retry:` is a random 3–10 s per stream, and the connect-time reads (snapshot,
// newest id, replay by Last-Event-ID) are shared by every stream that asks within 2 s and no feed change happened.
// Caps per instance: SSE_GLOBAL_MAX (default 6000), SSE_PER_IP_MAX (default 20: carriers/campuses share IPs).
// Env is read at server start (next start), not baked in at build.
import { clientIp } from "../../_data/clientIp";
import { LIVE } from "../../_data/flags";
import { elogToFeed } from "../../_data/chain";
import { type ChainRow, coreNow, db, FEED_EVENTS, rowToFeed, toFeed } from "../../_data/live";

const PER_IP = Number(process.env.SSE_PER_IP_MAX || 20);
const GLOBAL = Number(process.env.SSE_GLOBAL_MAX || 6000);
const IP_HEADER = process.env.SSE_IP_HEADER?.trim().toLowerCase();
const REPLAY = 200;
const MAX_QUEUED = 256; // frames buffered for a client that stopped reading: past this it is dropped (it reconnects)

const clients = new Set<(chunk: string) => void>();
const perIp = new Map<string, number>();
let listening: Promise<unknown> | undefined;

const frame = (data: unknown, id?: string) => `${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const broadcast = (chunk: string) => clients.forEach((send) => send(chunk));
const jitter = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

// Connect-time reads, shared. Cleared on every chain/core notify, so a cached read never predates a change this
// instance has already broadcast (a stream subscribes before it reads: anything newer reaches it live).
const shared = new Map<string, Promise<unknown>>();
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let p = shared.get(key) as Promise<T> | undefined;
  if (!p) {
    const q = (p = fn());
    shared.set(key, q);
    const drop = () => { if (shared.get(key) === q) shared.delete(key); };
    q.catch(drop);
    setTimeout(drop, 2_000);
  }
  return p;
}

async function onNotify(payload: string) {
  const n = JSON.parse(payload);
  if (n.t !== "head") shared.clear();
  if (n.t === "log") {
    const e = toFeed(n);
    if (e) broadcast(frame(e, e.id));
  } else if (n.t === "head") {
    if (n.swaps) broadcast(frame({ id: `h:${n.block}:swaps`, at: n.at, block: n.block, kind: "swaps", n: n.swaps }));
    broadcast(frame({ id: `h:${n.block}`, at: n.at, block: n.block, kind: "block" }));
  } else if (n.t === "core" || (n.t === "elog" && n.kind === "core")) {
    broadcast(frame({ kind: "core", core: await coreNow() }));
  } else if (n.t === "elog") {
    // engine log record: the NOTIFY carries only seq/kind/ref (8000-byte cap); the body is read back by seq
    const [r] = await db()<{ doc: Record<string, unknown> }[]>`select doc from log where seq = ${n.seq}`;
    const e = r && elogToFeed({ ...n, doc: r.doc });
    if (e) broadcast(frame(e));
  }
}

// postgres.js re-LISTENs after reconnects; on a failed first attempt the next stream retries
const listen = () => (listening ??= db().listen("feed", (p) => void onNotify(p).catch(console.error)).catch((e) => { listening = undefined; throw e; }));

export async function GET(request: Request) {
  if (!LIVE) return new Response("live feed is off (NEXT_PUBLIC_LIVE unset)", { status: 404 });
  // client IP: SSE_IP_HEADER (cf-connecting-ip) only from a Cloudflare peer, else Railway's x-real-ip (../../_data/clientIp).
  // VERIFY ON DEPLOY that it is the visitor.
  const ip = clientIp(request.headers, IP_HEADER);
  if (clients.size >= GLOBAL) return new Response("too many streams", { status: 503, headers: { "Retry-After": "30" } });
  if ((perIp.get(ip) ?? 0) >= PER_IP) return new Response("too many streams from this address", { status: 429, headers: { "Retry-After": "30" } });
  await listen();

  const last = request.headers.get("last-event-id")?.match(/^(\d{1,12}):(\d{1,6})$/);
  const enc = new TextEncoder();
  let send: (chunk: string) => void = () => {};
  let ping: ReturnType<typeof setInterval>;
  let life: ReturnType<typeof setTimeout>;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    clearTimeout(life);
    clients.delete(send);
    const left = (perIp.get(ip) ?? 1) - 1;
    if (left > 0) perIp.set(ip, left); else perIp.delete(ip);
  };
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  request.signal.addEventListener("abort", close);

  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      send = (chunk) => {
        // a client that stopped reading: drop it rather than buffer without bound
        // (error, not close: an errored stream drops its queue at once instead of draining it to a reader that stalled)
        if ((ctrl.desiredSize ?? 0) < -MAX_QUEUED) { close(); try { ctrl.error(new Error("slow client")); } catch {} return; }
        try { ctrl.enqueue(enc.encode(chunk)); } catch { close(); }
      };
      send(`retry: ${jitter(3_000, 10_000)}\n\n`);
      clients.add(send); // subscribe before reading, so nothing falls between the read and the first notify
      try {
        if (last) {
          const rows = await once(`r:${last[1]}:${last[2]}`, () => db()<ChainRow[]>`select block::int as block, log_index, tx, at, address, event, args from chain_log
            where (block, log_index) > (${last[1]}, ${last[2]}) and event = any(${FEED_EVENTS}) order by block, log_index limit ${REPLAY}`);
          for (const r of rows) { const e = rowToFeed(r); if (e) send(frame(e, e.id)); }
          // counters only move via snapshots: always resync after a reconnect (a core-only change, e.g. a level or route
          // snapshot, has no chain_log row to replay)
          send(frame({ kind: "core", core: await once("core", coreNow) }));
        } else {
          const [newest, core] = await Promise.all([
            once("newest", () => db()<{ block: number; log_index: number }[]>`select block::int as block, log_index from chain_log order by block desc, log_index desc limit 1`).then((r) => r[0]),
            once("core", coreNow),
          ]);
          send(frame({ kind: "core", core }, newest ? `${newest.block}:${newest.log_index}` : undefined));
        }
      } catch (e) {
        console.error("stream start failed", e);
      }
      if (!closed) {
        ping = setInterval(() => send(": ping\n\n"), 25_000);
        // end before Railway's 15-min cut, at a random point, so reconnects never arrive in one wave
        life = setTimeout(() => { close(); try { ctrl.close(); } catch {} }, jitter(10 * 60_000, 14 * 60_000));
      }
    },
    cancel: close,
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
