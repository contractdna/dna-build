#!/usr/bin/env bash
# Local LIVE stack for the load tests: anvil → LaunchLocal + DevActions → Docker Postgres → indexer loop →
# `next build && next start` (LIVE, read-only dna_web role) → chain actions every 15 s so the feed keeps moving.
# Runs until Ctrl-C. Ports: anvil 18555, Postgres 55435, web 3079. Prerequisites as engine/scripts/e2e.sh.
#   STACK_POLL_MS   indexer POLL_MS (default 1000: 12× production, so every SSE client gets ~1 event/s)
#   SSE_GLOBAL_MAX / SSE_PER_IP_MAX pass through to the web server. SKIP_BUILD=1 reuses web/.next.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOGS="${LOGS:-$(mktemp -d)}"
export RPC_URL=http://127.0.0.1:18555
PIDS=()
CONTAINER=dna-load-$$
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "logs: $LOGS"
}
trap cleanup EXIT

anvil --slots-in-an-epoch 1 --port 18555 --silent & PIDS+=($!)
docker run -d --rm --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dna -p 55435:5432 postgres:16-alpine >/dev/null
until docker exec "$CONTAINER" pg_isready -U postgres -d dna -q 2>/dev/null; do sleep 0.5; done
sleep 1
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55435/dna
until cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1; do sleep 0.2; done

"$ROOT/engine/scripts/devchain.sh" all >"$LOGS/devchain.log"
cd "$ROOT/engine"
node src/indexer.ts --once >"$LOGS/indexer-once.log"
node -e "require('postgres')(process.env.DATABASE_URL)\`alter role dna_web with login password 'load'\`.then(() => process.exit(0))"
cast rpc evm_setIntervalMining 1 --rpc-url "$RPC_URL" >/dev/null # a block (→ an SSE "block" event) every second
POLL_MS="${STACK_POLL_MS:-1000}" node src/indexer.ts >"$LOGS/indexer.log" 2>&1 & PIDS+=($!)

cd "$ROOT/web"
[ -n "${SKIP_BUILD:-}" ] || NEXT_PUBLIC_LIVE=1 npx next build >"$LOGS/build.log" 2>&1
NEXT_PUBLIC_LIVE=1 DATABASE_URL=postgres://dna_web:load@127.0.0.1:55435/dna npx next start -p 3079 >"$LOGS/web.log" 2>&1 & PIDS+=($!)
until curl -sf http://127.0.0.1:3079/api/health >/dev/null; do sleep 0.5; done
echo "stack up: web http://127.0.0.1:3079 · PG_ADMIN_URL=$DATABASE_URL · logs $LOGS"

# chain actions so finalized feed rows (Queued/Cancelled/…) and swap counts keep arriving
while true; do
  "$ROOT/engine/scripts/devchain.sh" dev swaps cancelDemo >>"$LOGS/actions.log" 2>&1 || echo "chain action failed (see $LOGS/actions.log)"
  sleep 15
done
