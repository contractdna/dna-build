# Load tests

The scripts behind `docs/CAPACITY.md`. They use no dependencies beyond what `web/` already installs (`postgres`) and need
the same tools as `engine/scripts/e2e.sh`: anvil/forge/cast, Docker, Node 24, `npm ci` in `engine/` and `web/`.

| script | what it does |
| --- | --- |
| `stack.sh` | Starts the local LIVE stack and keeps it running until Ctrl-C: anvil, LaunchLocal + DevActions, Docker Postgres on :55435, the indexer loop (`POLL_MS=1000`), `next build && next start` LIVE on :3079 as the read-only `dna_web` role, and chain actions every 15 s. |
| `sse.mjs` | N SSE clients (default 5,000; 20 per `x-real-ip`) held for `HOLD_S`. A probe `pg_notify` goes out every second, and fan-out latency is the time from the probe's `at` until a client receives it. Then the reconnect storm: every client drops and reconnects with its Last-Event-ID within `STORM_S`. The script samples server RSS/CPU and `dna_web` Postgres connections every 5 s. |
| `http.mjs` | Open-model page/API load. Requests go out on schedule even when earlier ones are still running, ramping to `RATE` req/s over `RAMP_S` and then holding for `HOLD_S`, round-robin over `PATHS`. Reports p50/p95/p99 per path, errors, server RSS/CPU and DB connections. |
| `rpc-count.mjs` | Counting JSON-RPC proxy. Point an indexer, the engine or anvil's `--fork-url` at it to get calls per method and their cost in Alchemy CU and dRPC CU. |

```bash
LOGS=/tmp/dna-load web/scripts/loadtest/stack.sh &                    # wait for "stack up"
cd web
N=5000 HOLD_S=120 STORM_S=10 node scripts/loadtest/sse.mjs              # (a) + (c)
RATE=300 RAMP_S=30 HOLD_S=120 node scripts/loadtest/http.mjs            # (b)
# two "replicas": start a second `next start -p 3080` (same env), then run sse.mjs/http.mjs once per port
# RPC: TARGET=http://127.0.0.1:18555 PORT=18600 node scripts/loadtest/rpc-count.mjs, then RPC_URL=http://127.0.0.1:18600 for the process under test
```

Caveats:

- The load generator runs on the same machine as the server, so the latencies include the client's own event loop.
- On macOS, `kern.ipc.somaxconn` is 128. Past saturation, connections fail with `connect ETIMEDOUT` (the accept backlog is full) before they would queue on Linux.
- With two `sse.mjs` runs at once, every client gets both runs' probes, so "delivered" comes out at 2× "expected".
- After long `evm_setIntervalMining 1` runs (about 1,300 blocks), anvil stopped answering once. Restart the stack if `actions.log` shows timeouts.
