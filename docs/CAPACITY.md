# Capacity: launch day (about 5,000 concurrent visitors)

What the stack can carry, what it costs in RPC, how to size Railway, and what to watch on the day. Load-test scripts
and the commands to reproduce: `web/scripts/loadtest/` (README there). Every number below was either measured with
the setup described under "Web results" or computed from the per-call costs cited under "Sources".

## TL;DR

- **The website never calls the RPC.** It reads Postgres (the indexer's tables) and one Postgres `LISTEN`. Visitor
  count does not change RPC usage, which comes only from the indexer and the engine.
- **RPC: ~2.2M Alchemy CU/day, ~66M CU/month, ~$35/month on PAYG** without the agent loop. The Free tier
  (30M CU/month, 300 CU/s) is not enough, so PAYG is required.
- **15-minute agent loop** (section "The 15-minute loop"): RPC ~2.5M CU/day (~$40/month) typical,
  ~4.2M (~$67) when every cycle runs a fresh fork sim; LLM ~$96/month typical, ~$300 busy, hard cap $100/day.
- **Alchemy budget alert: $75/month** (≈ 1.9× typical with the loop). A second alert at $150 means something is looping.
- **dRPC key daily limit: 5,000,000 CU/day.** That covers a full-day Alchemy outage (~70k calls × 20 CU = 1.4M CU/day)
  with 3× margin plus the slow growth of IdeaMarket round scans. Worst case at the cap: ~$1.50/day.
- **Web: 5,000 SSE clients on one Node process** held with 0 drops, 100 % event delivery and fan-out p99 107 ms, at
  ~97 KB of RSS per connection. A full 5,000-client reconnect storm within 10 s fully recovered with first frame
  p99 < 1 s. **Uncached pages saturate a process at ~350 req/s** (one laptop-class core). Plan **3 web replicas**, and put
  **Cloudflare** in front: LIVE HTML is CDN-cacheable for 5 s.

## Design choices behind these numbers

| where | behaviour | why |
| --- | --- | --- |
| `engine/src/indexer.ts` | Skips the tick when `finalized` has not moved past the last completed pass (refreshes `checked_at` only). A *lower* finalized (a lagging fallback node) is treated the same way, so an older block is never snapshotted. | Mainnet `finalized` moves once per epoch (~6.4 min), so 31 of 32 ticks re-read the same logs and state. Same block, same data: no safety change. Cuts 15 calls per tick down to 1 (unit-tested: an idle tick makes exactly one `eth_getBlockByNumber`). |
| `engine/src/indexer.ts` | `cursor.checked_at` means "last **complete** pass (logs + snapshot)": the per-window cursor upsert does not refresh it. A snapshot failing 3 ticks in a row fails the tick. | Otherwise a permanently failing snapshot would be invisible: `checked_at` would stay fresh, so neither `/api/health` `stale` nor the engine's "Indexer stale" alert would fire, and every tick would re-run the full tier. Instead the tick logs `tick failed` and backs off, and `checked_at` goes stale after 5 min, which raises the alert. |
| `engine/src/indexer.ts` | Snapshot: 14 `eth_call`s → **one** deployless Multicall3 `eth_call` (+ `getBalance`) | 384 → 46 CU per snapshot. `allowFailure: false` throws on any failed read, exactly like 14 separate calls under `Promise.all` would. Deployless, so it works on anvil and at any block. Verified against the real endpoints (below). |
| `engine/src/watch.ts` | `hook.breaker()` is read when the block range has a hook `ModuleFailed` log, otherwise once a minute | `failCount` only rises with a `ModuleFailed` log, which the watcher reads at every new block anyway. The per-minute read covers start-up, stalls > 100 blocks and the hourly re-alert while the breaker is tripped. e2e (failing canary → keeper rollback) still passes. |
| `web/app/api/stream/route.ts`, `web/app/_data/clientIp.ts` | `SSE_GLOBAL_MAX` (default 6000/instance), `SSE_PER_IP_MAX` (default 20), `SSE_IP_HEADER` (`cf-connecting-ip` behind Cloudflare). The header is trusted **only when the TCP peer (`x-real-ip`, set by Railway's edge) is inside Cloudflare's published ranges**; otherwise `x-real-ip` is used. | Carriers and campuses put many visitors behind one IP. Behind Cloudflare, `x-real-ip` is a Cloudflare edge IP shared by thousands. The origin is also reachable directly (`*.up.railway.app`, or Railway's edge with `Host: genomedna.xyz`), and there a spoofed `cf-connecting-ip` would dodge the per-IP cap. No shared secret is involved. The ranges are a dated constant in `clientIp.ts` (from cloudflare.com/ips-v4 and /ips-v6, 2026-10-06), refreshed by hand. A missing new range only makes those visitors count per edge IP. Unit-tested both ways. |
| `web/app/api/stream/route.ts` | `retry:` is a random 3–10 s per stream. Each stream ends itself after a random 10–14 min (before Railway's 15-min cut). | Reconnects never line up into one wave (a deploy, Railway's cut, a blip). |
| `web/app/api/stream/route.ts` | Connect-time reads (core snapshot, newest id, Last-Event-ID replay ≤ 200 rows) are shared by every stream that asks within 2 s. The cache is cleared on every chain/core NOTIFY. A reconnect with Last-Event-ID **always** gets a fresh core snapshot after the replay. | A storm of 5,000 reconnects is a handful of queries instead of 5,000 × 6. A cached read never predates a change this instance has broadcast, and a stream subscribes before it reads. A core-only change (e.g. a level or route snapshot) has no chain_log row to replay, so it needs the snapshot. |
| `web/app/api/stream/route.ts` | A client with > 256 unread frames is dropped (`ctrl.error`, so its queue is discarded instead of drained) | Bounded memory per connection (a stalled reader would otherwise buffer forever). |
| `web/app/_data/live.ts` | `getHealth` memoized 5 s like the other getters | Every open tab polls `/api/health` each minute: at 5,000 tabs that is ~83 req/s, each a DB query. |
| `web/app/_live/LiveProvider.tsx` | After a refused stream (429/503), retry after a random 20–40 s | Refused clients do not come back together. |
| `web/next.config.ts` | LIVE only: page HTML gets `Cache-Control: public, max-age=0, s-maxage=5` | See "CDN" below. Mock mode sends no extra headers. |

Considered and not done:

- **JSON-RPC batching (viem `batch: true`).** No CU saving: Alchemy bills a batch as "CU of method × times called" and
  "does not recommend using batch requests as they can be less reliable". dRPC charges a flat 20 CU per method call.
  Multicall is the real saving (14 calls → 1 billed call), and it is implemented.
- **Indexer head tier + engine watcher both fetch the pool's `Swap` logs at head.** Sharing them through Postgres would
  save ~430k CU/day (~$7/month), but it couples the two services. Not worth the coupling at launch.
- **`keeper:finalize` re-reads every IdeaMarket round each 10 min (2 calls per round, +1 round a week).** That is about
  +2k calls/day per month of rounds, ~$1/month after six months. Starting the scan at the oldest non-final round needs
  "empty past round = done" semantics checked against the contract first. Follow-up.
- **`WATCH_POLL_MS=12000`.** Saves 144k CU/day (~$2/month) but delays breaker and alert detection by up to 12 s. Keep
  4 s.

## Web results

Test setup: a single ARM64 workstation, Node 24.15.0, Next 16.3.8, Postgres 16-alpine in Docker on the same machine.
The load generator runs on the same machine too. Stack: `stack.sh`, i.e.
anvil + LaunchLocal + DevActions dataset, the indexer at `POLL_MS=1000` (a block event every second, **12× mainnet**),
chain actions every 15 s, and `next build && next start` LIVE as the read-only `dna_web` role. "CPU %" is one core = 100 %.

| test | load | result |
| --- | --- | --- |
| (a) SSE hold | 5,000 streams (20 per IP), ramped at 500/s, held 120 s; 1 block event/s + 1 probe NOTIFY/s | 5,000/5,000 open throughout; **0 refused, 0 errors, 0 server-side drops**; 600,000/600,000 probe frames delivered. **Fan-out latency (NOTIFY → client) p50 60 / p95 89 / p99 107 / max 128 ms.** RSS 166 → 649 MB (**≈ 97 KB per connection**). CPU 15–30 %. Postgres 6 connections (pool 5 + LISTEN 1). |
| (c) reconnect storm | all 5,000 dropped, each reconnects with its Last-Event-ID at a random moment within 10 s | **5,000/5,000 reconnected, 0 refused, 0 errors.** Time to first frame **p50 199 / p95 916 / p99 993 ms**. Peak CPU 39 %. Postgres stayed at 6 connections (shared replay read). |
| (b) pages + API | 300 req/s round-robin over `/`, `/modules`, `/treasury`, `/proposals`, `/api/core`; 30 s ramp + 120 s hold; one process | 40,499 requests, **0 errors**. **p50 5 / p95 27 / p99 74 / max 509 ms** (pages p99 81–88 ms, `/api/core` p99 20 ms). CPU ~100 % (one core). RSS ≤ 835 MB. Postgres 6. |
| saturation | same mix at 400 / 480 / 600 / 900 req/s, one process | At 400 req/s: 18 % connect timeouts, p50 508 ms. **The knee is ~350 req/s per process** (~2.9 ms CPU per page). |
| 2 replicas, combined | 2 processes, each 2,500 SSE + 150 req/s for 120 s, then the storm | SSE: 0 drops, 100 % delivery, fan-out p99 99 ms; storm first frame p99 1.05 s. HTTP: p50 5 / p95 ~100 / p99 ~230 ms, 1 ECONNRESET in 38,250. CPU ~94 % per process. Postgres 12 total. |

Response headers, checked with `curl` against `next start` (LIVE):

| request | Cache-Control |
| --- | --- |
| `/`, `/modules`, `/treasury`, `/modules?m=…` (HTML) | `public, max-age=0, s-maxage=5` (the load runs above were made with an extra `stale-while-revalidate=10`; the origin-side cost is identical) |
| any page with the `rsc: 1` header (client navigation, prefetch) | `private, no-cache, no-store, max-age=0, must-revalidate` (Next's default) |
| 404 | `private, no-cache, no-store, …` |
| `/api/core` and the other `/api/<name>` | `public, s-maxage=10, stale-while-revalidate=30` (Cloudflare ignores the `stale-while-revalidate` part, see below) |
| `/api/stream` | `no-cache, no-transform` · `/api/health`: `no-store` |

Why the header holds on dynamic pages: Next 16 docs (`guides/cdn-caching.md`) say dynamic pages get
`private, no-cache, no-store`, but `next.config` `headers()` can set Cache-Control for responses other than immutable
assets (`next-config-js/headers.md`). The runtime (`dist/build/templates/app-page-runtime.js`) only applies its
default when none is set yet (`!isSSG && !res.getHeader('Cache-Control')`). RSC requests are excluded with
`missing: [{ type: "header", key: "rsc" }]`, because they would otherwise inherit `public` too.

Per-connection memory: ~97 KB, so 6,000 streams (the default cap) ≈ 0.6 GB on top of a ~0.2–0.4 GB base heap.

Production differs from the test: mainnet head events arrive every 12 s (the test used 1 s), so fan-out CPU is about
12× lower. Railway vCPUs are shared and slower per thread than the test machine's performance cores. The sizing below assumes
about half.

## RPC budget (mainnet, per day)

Model: 12 s blocks → 7,200 blocks/day. `finalized` advances once per epoch (32 slots ≈ 384 s), i.e. 225 times/day.
Indexer `POLL_MS` 12 s → 7,200 ticks. Watcher `WATCH_POLL_MS` 4 s → 21,600 ticks, with a new block on 7,200 of them.

**Alchemy CU per call** (alchemy.com/docs/reference/compute-unit-costs, checked Oct 2026): `eth_blockNumber` 10,
`eth_getBlockByNumber` 20, `eth_getLogs` 60, `eth_call` 26, `eth_getBalance` 20, `eth_getStorageAt` / `eth_getCode` /
`eth_getTransactionCount` / `eth_getTransactionReceipt` / `eth_estimateGas` 20, `eth_feeHistory` 10 (tx fees: once per send, plus once per bump, plus once per dry_run),
`eth_sendRawTransaction` 40, batch = "CU of method × times called". **dRPC (paid):** a flat 20 CU per call.

| source | calls/day | Alchemy CU/day |
| --- | ---: | ---: |
| indexer: `getBlock(finalized)` every tick | 7,200 | 144,000 |
| indexer: reorg check `getBlock(cursor)` | 225 | 4,500 |
| indexer: 3 × `getLogs` per finalized advance | 675 | 40,500 |
| indexer: snapshot per finalized advance (1 multicall `eth_call` + `getBalance`) | 450 | 10,350 |
| indexer: head tier (`getBlock(latest)` + `getLogs`) | 14,400 | 576,000 |
| **indexer total** | **22,950** | **775,350** |
| watcher: `eth_blockNumber` every 4 s | 21,600 | 216,000 |
| watcher: 2 × `getLogs` per new block | 14,400 | 864,000 |
| watcher: `breaker()` | 1,440 | 37,440 |
| engine: key balances (3 × per minute) | 4,320 | 86,400 |
| engine: keepers (distribute/claim/expire hourly, process/add every 10 min) | ~1,360 | ~34,000 |
| engine: `keeper:execute` every 10 min | ~720 | ~21,600 |
| engine: `keeper:finalize` every 10 min (month 1; +2 calls per round per run) | ~1,900 | ~48,000 |
| engine: `plates:tick` every 10 min (while an experiment is open) | ~1,440 | ~34,000 |
| engine: `ideas:rounds` hourly, live txs (~15/day × ~25 calls) | ~525 | ~11,000 |
| engine: daily anvil fork sim (`SIM_FORK_RPC_URL`, Alchemy only; the 15-min loop replaces it, see below) | ~3,000 | ~60,000 |
| engine: observe (hourly), journal, genesis | 0 (Postgres only) | 0 |
| **total** | **~73,700** | **~2.18M** |
| **per month (×30.4)** | | **~66M CU ≈ $35** |

For comparison: re-reading the reorg check and the snapshot on every tick with 14 separate `eth_call`s, and reading
`breaker()` at every block, would cost ~193,000 calls and ~5.2M CU a day (~158M CU ≈ $83 a month).

Measured with `rpc-count.mjs` against anvil (12 s blocks, `POLL_MS=12000`, 6 min each). Locally `finalized` = head − 2,
so it advances on **every** tick: this measures an advance tick, and the mainnet model applies it to 1 tick in 32.
- Indexer: 9 calls per advance tick, with 1 `eth_call` (multicall). With 14 separate reads it is 22 (14 `eth_call`,
  3 `getBlock`, 4 `getLogs`, 1 `getBalance`). The model above matches.
- Engine (dry_run, no keys, so no balance reads): `eth_blockNumber` exactly every 4 s, 2 `getLogs` per block, and
  `breaker()` about once a minute.
- **Fork sim (one realistic replay):** anvil `--fork-url` lazily fetches state from upstream. With 200 swaps replayed
  twice (baseline + candidate): **1,490 upstream calls = 29,680 CU** (579 `eth_getStorageAt`, 806
  `eth_getTransactionReceipt`, 24 each of `getBalance`/`getCode`/`getTransactionCount`, plus a few
  chain-id/block calls). With 20 swaps: 365 calls / 7,180 CU. The receipt lookups come from anvil asking upstream for
  each new local tx hash. Real mainnet swaps touch more distinct ticks than the 9 recycled local ones, so the budget
  above is 2× the measurement. Peak locally: ~5,000 CU/s for the ~10 s the replay runs.

**Deployless Multicall3 on the real endpoints** (2026-10-06 20:58 UTC, viem 2.57.3, the snapshot's shape: 14 reads
including 4 × PoolManager `balanceOf`, `allowFailure: false`):

| endpoint | at `finalized` (26,135,810) | at `finalized − 7200` (~1 day old) |
| --- | --- | --- |
| Alchemy (PAYG key) | OK, 14 results | OK, 14 results |
| dRPC public (`eth.drpc.org`) | OK | OK |
| publicnode (`ethereum-rpc.publicnode.com`) | OK | **FAIL** "Invalid parameters were provided to the RPC method" |

The indexer only reads at `finalized`, which all three serve. publicnode rejects older blocks (pruned state; other
reports have it rejecting the deployless call itself), so it is not a fallback candidate. Alchemy and dRPC are the
two `RPC_URL` entries.

**Throughput.** Peak Alchemy CU/s measured: indexer advance tick 372 (710 with 14 separate reads),
engine start-up burst 580, fork sim ~5,000. Each of these exceeds the Free tier's 300 CU/s. PAYG allows 10,000 CU/s.

**Alchemy budget.** Expected ~2.2M CU/day, ~66M CU/month, ~$35/month at $0.525/M CU (PAYG) without the agent loop;
with the 15-minute loop ~2.5M CU/day (~$40) typical and ~4.2M (~$67) busy. Set the dashboard alerts at
**$75/month** and **$150/month**. A day above **5M CU** means something is retrying in a loop.
Check the engine/indexer logs for `tick failed` and the job failure alerts.

**dRPC daily limit: 5,000,000 CU/day** on the dRPC key (dashboard → key → limits). If Alchemy is down for a full day,
everything on `RPC_URL` goes to dRPC: ~70k calls/day (indexer 23k + watcher 37k + keepers/balances/plates ~11k). The
fork sim is not included because it uses `SIM_FORK_RPC_URL` (Alchemy only), and a failed sim fails its gate, which is
safe. 70k calls × 20 CU = **1.4M CU/day**, so 3× margin is 4.2M. 5M also covers the round-scan growth. At $0.30/M,
the cap costs at most ~$1.50/day. dRPC's free tier (210M CU / 30 days, public nodes only) works as a stopgap, but a
paid key with this daily limit is the launch setting.

**RPC_URL: Alchemy first, dRPC second.** Both the indexer and the engine split `RPC_URL` on commas into a viem
`fallback([...http(url, { retryCount: 2 })])`. A request goes to the first URL, and on error (after retries) to the
next. viem's default `rank: false` sends every new request to Alchemy first again, so a recovered Alchemy is used
right away. Set it with `RAILWAY_PROJECT=<id> ALCHEMY_APP=<id> bash engine/scripts/set-rpc-secrets.sh` (it reads both keys without echoing them and
validates them). By hand:

```
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/<ALCHEMY_KEY>,https://lb.drpc.live/ethereum/<DRPC_KEY>   # indexer + engine, sealed
SIM_FORK_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/<ALCHEMY_KEY>                                  # engine, sealed (archive state)
```

## The 15-minute loop: LLM and RPC per month

The agent's visible loop runs every 15 min, always (96 cycles/day), and the plate timings are hours-based (2 h shadow,
4 h canary, 1 h kill window, registry delays 1 h).

**Swap volume the timings need.** A 4 h canary holds only two 100-block windows (100 of every 600 blocks ≈ 40 min
in-window), so its 10 in-window fee swaps (`MIN_CANARY_SAMPLES`) need **~15 fee-paying swaps per hour**. The shadow
samples 1 swap in 10, so 5 ShadowFee samples in 2 h need ~25 swaps per hour. Below that a stage is extended in 1 h
steps (up to 3×) and then closed as "insufficient data": slower, never wrong. The retention kill likewise waits for a
full window and ≥ 10 expected in-window swaps before it judges.

### LLM

Prices (per 1M tokens, < 200k-token prompts, checked 2026-10-07): grok-4.7 $2 in / $0.50 cached in / $6 out; grok-4.3
$1.25 / $0.20 / $2.50 (docs.x.ai/docs/models, docs.x.ai/developers/models/grok-4.3); Claude Opus 5.5 $4 in / $0.20
cache read / $20 out; Claude Fable 5.1 $10 / $0.25 / $50 (platform.claude.com/docs/en/about-claude/pricing). xAI
web_search $5 / 1k calls; x_search bills per post fetched, budgeted at $0.05 per tool turn (`XAI_SEARCH_USD_PER_CALL`).
A search call's pre-call estimate also counts the results each turn feeds back, re-read on every later pass: 120k
input tokens per turn (`XAI_SEARCH_TOKENS_PER_TURN`; a live 2-turn research call read 295k in all and cost $0.75).
An answer over a schema limit is asked for once more (`llm()`), so one call can cost up to twice its estimate, and the
retry passes the caps on its own. For W4: a Sequencer order's reservation must cover 2× each call's estimate.
Otherwise a retry the cap refuses throws the usual cap `Defer`, and the order code treats it as an ordinary cap defer.
Every call except server-side search (web and X) goes through OpenRouter at these same provider prices (no markup; its 5.5% fee is paid when
credits are bought) and is costed by OpenRouter's reported `usage.cost` (docs/MODELS.md).

Cost controls:
- **Main (grok-4.7) every search cycle, compact**: this window's 10 numbers, the change since the last cycle, the last
  candidate and why it was not queued, ≤ 3 memory rules, ≤ 3 research claims; `reasoning.effort: "low"`; ≤ 2,000
  output tokens. While an experiment runs, a cycle only narrates it with **grok-4.3** (low effort, ≤ 600 tokens).
- **Opus red team only for a new candidate that passed every deterministic gate**; a candidate is "the same" when
  plate + vector + market regime (log2 buckets of realized volatility and swaps/day) hash equal, and then the last
  verdict is reused. At most `MAX_REDTEAM_PER_DAY` = 12 routine runs. **Fable only before SetCanary, an active-plate
  SetParams, or PromoteActive**.
- **Research only on a trigger** (volatility regime change, new X mentions, a closed idea round, a week-old result),
  **at most hourly**, 2 tool turns, ≤ 6 findings.
- Lessons, journal text and cycle notes use grok-4.3.
- **Prompt caching:** xAI caches a shared prefix automatically (through OpenRouter too); a direct X-search prompt also
  sends a stable `prompt_cache_key` (routes it to one server) and cost accounting prices `input_tokens_details.cached_tokens` at the cached rate
  (docs.x.ai/developers/advanced-api-usage/prompt-caching). Anthropic: only the brain's call is cached (its system
  prompt carries the generated project context, well above the 512-token minimum prefix); the red-team prompts are
  under it, so a breakpoint there would only add the 1.25× write (platform.claude.com/docs/en/build-with-claude/prompt-caching).
  Cost accounting prices Anthropic cache writes and reads at each model's listed rates (`engine/models.json`).
- **Caps:** hard daily cap `LLM_DAILY_USD_CAP` $300/day (the first week too); `LLM_MONTHLY_USD_CAP` $3,000. Each
  day's cap is split: the Sequencer (dev) 65 %, everything else 35 % (at $300: $195 / $105); inside the
  shared part, sub-caps research $20 / red team $40 / rest $40, research pausing at 80 % of it; in a month dev pauses
  at 60 %, research at 80 %, the rest at 100 % (docs/MODELS.md). Telegram alert at 70 % of each part.
  Over a cap a call is refused before it is made and the cycle carries on code-only: no LLM cap defers the cycle (the
  gas guard, a halt and the daily agent-op maximum still can defer the jobs they gate).

Per-call assumptions (tokens; not yet measured on production traffic: check `llm_call` after the first day):

| call | model | in (cached) / out | $ per call |
| --- | --- | ---: | ---: |
| Main hypothesis (search cycle) | grok-4.7, low | 2,000 (600) / 1,200 | 0.0103 |
| cycle note (experiment open) | grok-4.3, low | 1,000 (400) / 500 | 0.0021 |
| go / no-go (after a red-team pass) | grok-4.7 | 1,500 / 3,000 | 0.021 |
| routine red team | Opus 5.5, medium | 3,000 / 6,000 | 0.132 |
| gate red team | Fable 5.1, high | 4,000 / 8,000 | 0.44 |
| research (2 search turns) | grok-4.7 + tools | 20,000 / 3,000 + $0.10 | 0.158 |
| intake / idea reader | grok-4.7 | 1,000 / 1,000 | 0.008 |
| lesson, journal | grok-4.3, low | 1,000 / 500 | 0.002 |

| scenario (per day) | what runs | $/day | $/month (×30.4) |
| --- | --- | ---: | ---: |
| **typical launch day** | 2 experiments (≈ 16 h of 64 monitored cycles) + 32 search cycles; 4 Opus, 4 go/no-go, 2 Fable, 6 research, 30 mentions, 6 lessons/journal | **≈ 3.2** | **≈ 96** |
| **busy** | 96 search cycles at 3,000/2,000 tokens, Opus at the daily max (12, 8,000 out), 3 Fable, research every hour (24), 12 go/no-go, 100 mentions | **≈ 10** | **≈ 300** |
| **hard ceiling** | `LLM_DAILY_USD_CAP`, `LLM_MONTHLY_USD_CAP` | 300 | 3,000 |

A busy day of this shape is unit-tested against the caps (test/loop.test.ts "cost accounting at 96 cycles/day"): every budget stays
under its sub-cap and the total under the 70 % alert of the shared part.

### RPC (Alchemy CU) for 96 cycles/day

**Fork sim, measured** with `rpc-count.mjs` as the fork's upstream on the local devchain (`engine/scripts/e2e.sh`, the
fast-loop phase prints these lines; 5 swaps replayed twice):

| sim | upstream calls | Alchemy CU |
| --- | ---: | ---: |
| first sim: anvil spawned | 303 | 5,940 |
| next sims: same anvil, `anvil_reset` to the new finalized block | 288 | 5,640 |
| same finalized block: `evm_revert` to the clean snapshot | 217 | 4,340 |

By method (6 sims): `eth_getStorageAt` 892, `eth_getTransactionReceipt` 130, `eth_getAccountInfo` 79, `eth_getBalance` /
`eth_getTransactionCount` / `eth_getCode` ~64 each, the rest < 25. The long-lived fork saves the spawn and ~5 % of the
upstream calls, not more: anvil fetches a new block's state lazily, and an `evm_revert` also drops the state fetched
after the snapshot, so even a same-block run re-reads most of it. The real savings are elsewhere:
- **Replay window** (`SIM_REPLAY_WINDOW` 50): the swaps since the last sim plus the newest 50, not the newest 200.
- **Safety reuse** (`SIM_REUSE_BLOCKS` 300 ≈ 1 h): the same candidate (plate + vector) in the same regime reuses the
  last fork result while its fork is < 1 h old; the analytic revenue is recomputed every cycle. Set 0 to always replay.
- **No sim while an experiment runs** (those cycles only narrate).

Per sim on mainnet: the measurement under "RPC budget" (200 swaps: 29,680 CU; 20 swaps: 7,180 CU) is linear, ≈ 4,700 CU + 125 CU
per swap, which this run matches (5 swaps: predicted 5,300, measured 5,640). At 50 swaps that is ≈ 10,900 CU, doubled
for mainnet's larger state as above: **≈ 22,000 CU (~1,100 calls) per fresh sim**.

| source | typical day | busy day (every cycle a fresh sim) |
| --- | ---: | ---: |
| fork sims | 32 search cycles, ~half reused → 16 × 22k = **~350k CU** | 96 × 22k = **~2.1M CU** |
| search cycle reads (3 × `getModule`, `level`, `getBlock`; ~124 CU) | 32 × 124 ≈ 4k | 96 × 124 ≈ 12k |
| an extra `plates:tick` per monitored cycle (~9 calls, ~220 CU) | 64 × 220 ≈ 14k | 0 |
| observe (every 5 min), pulse (hourly), cycle records | 0 (Postgres only) | 0 |
| **loop total** (replaces the daily sim's ~60k) | **~0.37M CU/day** | **~2.1M CU/day** |
| **whole stack** (the table above, 2.18M, − 60k + loop) | **~2.5M CU/day ≈ 75M/month ≈ $40** | **~4.2M CU/day ≈ 128M/month ≈ $67** |

The fork uses `SIM_FORK_RPC_URL` (Alchemy only), so a dRPC failover day is unchanged (a failed sim fails its gate).

### Monthly cost of the 15-minute loop (assumptions above)

| | typical | busy | hard ceiling |
| --- | ---: | ---: | ---: |
| LLM (OpenRouter; web/X search on xAI) | ~$96 | ~$300 | $3,040 (`LLM_DAILY_USD_CAP` $100/day) |
| RPC, whole stack (Alchemy PAYG $0.525/M CU) | ~$40 | ~$67 | the Alchemy budget alert |
| **total** | **~$136** | **~$367** | |

Watch after launch: `llm_call` (`select budget, sum(cost_usd) from llm_call where at > now() - interval '1 day' group by 1`)
and Alchemy's daily CU against these numbers, and replace the assumptions with the measured per-call figures.

## Railway sizing

| service | replicas | resources (limit) | notes |
| --- | --- | --- | --- |
| **web** | **3** | 2 vCPU / 2 GB each | Next renders on one thread, so replicas add capacity and extra vCPUs per replica mostly help GC/IO. Per replica at launch: ~1,700 SSE (~0.2 GB) + its share of ~300 req/s. Measured: one laptop core carries 2,500 SSE + 150 req/s at ~94 %. A Railway vCPU is assumed to be about half that. With Cloudflare caching HTML, 2 replicas would do; keep 3 for headroom and rolling deploys. Health check `/api/health`. |
| **indexer** | **1** (single writer, advisory lock) | 0.5 vCPU / 512 MB | 1 Postgres connection. |
| **engine** | **1** (must) | 2 vCPU / 2 GB | Node + one long-lived anvil fork child (spawned once, reset per new finalized block; a replay runs a few seconds every 15 min). `PG_MAX=10`. |
| **watchdog** | **1** | 0.5 vCPU / 1 GB | No DB, no keys. Polls `ListPosted` once a minute; per posted list (≤ one per window, ≥ 12 h apart) it rebuilds from the full DNA Transfer history through each provider: `getLogs` over the token + vault in 10,000-block windows plus one `getBlock` per block with logs, 8 at a time (no cache across lists; add one if the history makes a rebuild slower than the 30-min page deadline). Measured CPU side (`node engine/scripts/bench-tickets.ts`, Apple Silicon laptop): 1.05 M transfers among 50,000 holders → accumulate 0.6 s + build 1.2 s, ~1 GB heap, so give it **1 GB**. The RPC side of a full rebuild is not measured yet. |
| **Postgres** | 1 | 1 vCPU / 1 GB, 5 GB volume | `max_connections` default 100 is enough (math below). The data is small (chain_log + engine log). chain_log holds **every** DNA Transfer (the jackpot draw rebuilds holder balances from them), about one row per swap or wallet transfer: at 10k transfers a day that is ~4 M rows (~1.5 GB with the jsonb args) a year; raise the volume before it fills. |

**Postgres connections.** Web replica: pool `max: 5` + 1 `LISTEN` = **6** (measured). Indexer: 1. Engine: `PG_MAX` 10 +
1 (migrate pool) = 11.
- Steady state with 3 web replicas: 18 + 1 + 11 = **30**.
- During a rolling deploy, old and new web replicas overlap: 36 + 1 + 11 = **48**, plus a console session or two ≈ 50
  of 100.
- Each extra web replica adds 6 (12 during a deploy). Past 8 replicas, raise `max_connections` or lower the web pool.

**Railway edge limits** (docs.railway.com/networking/public-networking/specs-and-limits):
- Requests run up to 15 min while data flows and close after 5 min idle. The SSE pings every 25 s, and each stream
  ends itself after 10–14 min.
- **10,000 concurrent connections** and ~11,000 RPS per domain. At ~10k simultaneous viewers the edge, not the app,
  is the ceiling. Next steps at that point would be a second domain or Cloudflare → origin HTTP/2. Not needed for 5k.

## CDN: Cloudflare in front of genomedna.xyz

1. DNS: `genomedna.xyz` → the Railway custom-domain target, **proxied** (orange cloud). SSL/TLS mode **Full** (not
   Flexible). Railway: "we may not always be able to issue a certificate for the domain, but Cloudflare to Railway
   traffic will be encrypted with TLS using the default Railway `*.up.railway.app` certificate".
2. Cache rule **"LIVE HTML"**: expression
   `(http.host eq "genomedna.xyz" and not starts_with(http.request.uri.path, "/api/") and not starts_with(http.request.uri.path, "/_next/") and not http.request.uri.query contains "_rsc" and not any(http.request.headers.names[*] eq "rsc"))`
   → **Eligible for cache**, Edge TTL **"Use cache-control header if present, bypass cache if not"**, Browser TTL
   **respect origin**, cache key **with** the query string (the default; `/modules?m=` and `/memory?…` vary by it).
   Cloudflare honours `s-maxage` and never stores `private`/`no-store`
   (developers.cloudflare.com/cache/concepts/cache-control/), so RSC payloads stay uncached even without the
   `rsc`/`_rsc` exclusions. The exclusions keep anyone from seeding an HTML response under an `_rsc` cache key.
   The same page says "`s-maxage` disables `stale-while-revalidate`", so the origin sends no SWR on HTML: an
   expired entry is revalidated before it is served, and HTML is never more than 5 s old.
   **Status-code TTL: 500–599 → no-store**, so an origin error page is never cached, not even for 5 s.
3. Cache rule **"API JSON"**: `starts_with(http.request.uri.path, "/api/") and not http.request.uri.path in {"/api/stream" "/api/health"}`
   → Eligible for cache, Edge TTL "use cache-control header if present". The routes already send `s-maxage=10` (and
   `immutable` for closed `/api/log/<day>` pages).
4. `/api/stream` is not cached (`no-cache`, and no rule makes it eligible). Cloudflare's 100 s proxy read timeout is
   covered by the 25 s ping.
5. Then set **`SSE_IP_HEADER=cf-connecting-ip`** on web. Otherwise every visitor's per-IP count lands on a handful
   of Cloudflare IPs, and `SSE_PER_IP_MAX=20` would refuse most of them. The header is honoured only from a
   Cloudflare peer (`web/app/_data/clientIp.ts`), so setting it early is harmless.
6. Check: `curl -sI https://genomedna.xyz/modules | grep -i cf-cache-status` gives `MISS`, then `HIT` within 5 s.
   The same request with `-H 'rsc: 1'` gives `BYPASS`/`DYNAMIC`.

Effect: page renders at the origin drop from one per visit to about one per page per query variant per Cloudflare
PoP every 5 s. Client-side navigations (RSC) still reach the origin, but they render the same memoized getters.
Deploy skew: for up to ~5 s after a deploy (the HTML `s-maxage`, with no stale serving), Cloudflare can serve HTML
that points at the previous build's `/_next/static` chunks. Those are usually still in Cloudflare's cache (immutable,
1 year). Purge the HTML on deploy if a deploy ever 404s a chunk.

Setup checklist for genomedna.xyz:

- [ ] `@` CNAME → Railway, proxied
- [ ] `www` proxied, with a 301 to the root
- [ ] SSL/TLS Full, Always Use HTTPS, minimum TLS 1.2
- [ ] cache rules "LIVE HTML" and "API JSON" (steps 2–3), status-code TTL 5xx → no-store
- [ ] `SSE_IP_HEADER=cf-connecting-ip` on web (step 5; can be set early, it only takes effect for requests arriving
      from Cloudflare)
- [ ] the `cf-cache-status` check (step 6)

## Railway settings (non-secret, copy-paste)

```
# web (3 replicas, 2 vCPU / 2 GB, health check /api/health)
NEXT_PUBLIC_LIVE=1                 # build-time; switches the site to live data
SSE_GLOBAL_MAX=6000                # per replica (~0.6 GB of streams at the cap)
SSE_PER_IP_MAX=20
SSE_IP_HEADER=cf-connecting-ip     # trusted only from Cloudflare peers (clientIp.ts), so safe to set early

# indexer (1 replica, 0.5 vCPU / 512 MB)
CHAIN_ID=1
POLL_MS=12000
LOG_WINDOW=10000
HEAD_TAG=latest

# engine (1 replica, 2 vCPU / 2 GB)
CHAIN_ID=1
WATCH_POLL_MS=4000
PG_MAX=10
SIM_MAX_SWAPS=200
SIM_REPLAY_WINDOW=50
SIM_REUSE_BLOCKS=300
CYCLE_MS=900000                    # the 15-min loop
LLM_DAILY_USD_CAP=100

# Postgres: defaults (max_connections 100), 5 GB volume
```

## Launch-day monitoring

| watch | where | threshold | knob |
| --- | --- | --- | --- |
| web CPU per replica | Railway metrics | > 80 % for 5 min | Add a replica (+6 Postgres connections each). Turn on the Cloudflare HTML rule if it is not on yet. |
| web memory per replica | Railway metrics | > 1.5 GB | Lower `SSE_GLOBAL_MAX` (refused clients retry in 20–40 s, maybe onto another replica) or add a replica. |
| `too many streams` 503s | web logs | any sustained | Global cap reached: add a replica, or raise `SSE_GLOBAL_MAX` if memory allows. |
| `too many streams from this address` 429s | web logs | more than a trickle | Raise `SSE_PER_IP_MAX` (50). Behind Cloudflare, first check that `SSE_IP_HEADER=cf-connecting-ip` is set. |
| HTTP p95 / 5xx rate | Railway HTTP metrics | p95 > 1 s, or 5xx > 1 % | Replicas, Cloudflare cache rule. Check Postgres. |
| Postgres connections | `select usename, count(*) from pg_stat_activity group by 1` | > 70 | Web is 6 per replica: look for a stuck engine/indexer or console sessions. |
| indexer freshness | `/api/health` → `stale`; engine "Indexer stale" alert | `stale: true` | Indexer logs. RPC: is dRPC taking over? |
| engine watcher | engine `/health` → `lastWatcherBlock` vs head | > 25 blocks behind (~5 min) | Engine logs / RPC. |
| Alchemy CU | Alchemy dashboard | > 5M CU/day, or the $75 alert | Look for a retry loop (`tick failed`, job failures). |
| dRPC usage | dRPC dashboard | any material use on a normal day | Alchemy is erroring: check its status page and error codes. |
| Cloudflare cache | `cf-cache-status` on HTML | mostly `MISS` after 5 min | Rule order/expression. Origin must send `public, … s-maxage=5`. |

## Sources

- Alchemy CU per method and batch billing: https://www.alchemy.com/docs/reference/compute-unit-costs
- Alchemy batch requests (limit 1,000 per batch; "does not recommend using batch requests"): https://www.alchemy.com/docs/reference/batch-requests
- Alchemy plans (Free 30M CU/month at 300 CU/s; PAYG $0.525/M CU at 10,000 CU/s): https://www.alchemy.com/docs/reference/pricing-plans
- dRPC pricing (free 210M CU/30 days on public nodes; paid flat 20 CU/method at $0.30/M CU; per-key limits in the dashboard): https://drpc.org/docs/pricing/requests, https://drpc.org/docs/pricing/compute-units, https://drpc.org/docs/gettingstarted/createaccount
- dRPC endpoint format `https://lb.drpc.live/ethereum/<KEY>`: https://drpc.org/docs/gettingstarted/firstrequest
- Railway limits (15 min / 5 min idle, 10,000 connections, ~11k RPS per domain, `X-Real-IP`, Cloudflare note): https://docs.railway.com/networking/public-networking/specs-and-limits
- Cloudflare cache-control handling: https://developers.cloudflare.com/cache/concepts/cache-control/ · cache rule settings: https://developers.cloudflare.com/cache/how-to/cache-rules/settings/
- Next 16 (in `web/node_modules/next/dist/docs/`): `01-app/02-guides/cdn-caching.md`, `01-app/02-guides/self-hosting.md`, `01-app/03-api-reference/05-config/01-next-config-js/headers.md`
