#!/usr/bin/env bash
# Hermetic end-to-end check of phase 1 + the phase-2A engine:
#   anvil (--slots-in-an-epoch 1) → LaunchLocal + DevActions (devchain.sh) → indexer --once → web in LIVE mode
#   → assert the JSON getters + Last-Event-ID replay → indexer loop + new chain actions → assert the SSE stream got them.
# Needs anvil/forge/cast, Docker (or E2E_DATABASE_URL pointing at an EMPTY database as a superuser), Node 24, and
# `npm ci` done in engine/ and web/. Ports: anvil 18545, Postgres 55433, web 3078.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOGS="$(mktemp -d)"
export RPC_URL=http://127.0.0.1:18545
WEB=http://127.0.0.1:3078
PIDS=()
CONTAINER=""
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "logs: $LOGS"
}
trap cleanup EXIT

echo "· anvil"
anvil --slots-in-an-epoch 1 --port 18545 --silent & PIDS+=($!)

if [ -z "${E2E_DATABASE_URL:-}" ]; then
  echo "· postgres (docker)"
  CONTAINER=dna-e2e-$$
  docker run -d --rm --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dna -p 55433:5432 postgres:16-alpine >/dev/null
  until docker exec "$CONTAINER" pg_isready -U postgres -d dna -q 2>/dev/null; do sleep 0.5; done
  sleep 1
  E2E_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/dna
fi
export DATABASE_URL="$E2E_DATABASE_URL"
until cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1; do sleep 0.2; done

"$ROOT/engine/scripts/devchain.sh" all

echo "· indexer --once"
cd "$ROOT/engine"
node src/indexer.ts --once

# the web reads through the read-only role, exactly as in production
node -e "
  const sql = require('postgres')(process.env.DATABASE_URL);
  sql\`alter role dna_web with login password 'e2e'\`.then(() => sql.end());
"
WEB_DB="$(node -e "const u = new URL(process.env.DATABASE_URL); u.username = 'dna_web'; u.password = 'e2e'; console.log(u.href)")"

echo "· web (next dev, LIVE)"
cd "$ROOT/web"
NEXT_PUBLIC_LIVE=1 DATABASE_URL="$WEB_DB" npx next dev -p 3078 >"$LOGS/web.log" 2>&1 & PIDS+=($!)
until curl -sf "$WEB/api/health" >/dev/null; do sleep 0.5; done

echo "· assert getters"
cd "$ROOT/engine"
node scripts/e2e-assert.ts getters

echo "· live stream"
curl -sN "$WEB/api/stream" >"$LOGS/stream.txt" & PIDS+=($!)
POLL_MS=300 node src/indexer.ts >"$LOGS/indexer.log" 2>&1 & PIDS+=($!)
sleep 2
"$ROOT/engine/scripts/devchain.sh" dev swaps cancelDemo # mines 2 blocks after each: finalized (head - 2) covers them
sleep 3
cd "$ROOT/engine"
node scripts/e2e-assert.ts stream "$LOGS/stream.txt"

echo "· engine (dry_run → live; keepers, agent ops, breaker rollback, anchor, Telegram/X fakes)"
LOGS="$LOGS" WEB="$WEB" node scripts/e2e-engine.ts

echo "· reorg guard (cursor hash no longer canonical → exit 2)"
node -e "require('postgres')(process.env.DATABASE_URL)\`update cursor set hash = '0xbad'\`.then(() => process.exit(0))"
set +e; node src/indexer.ts --once >"$LOGS/reorg.log" 2>&1; code=$?; set -e
[ "$code" = 2 ] || { echo "expected exit 2, got $code"; cat "$LOGS/reorg.log"; exit 1; }
echo "E2E PASS"
