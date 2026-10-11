#!/usr/bin/env bash
# Load the project's RPC endpoints into Railway without ever printing a key.
#   RPC_URL           = <Alchemy>,<dRPC>   (indexer + engine; viem fallback order: Alchemy first, dRPC second)
#   SIM_FORK_RPC_URL  = <Alchemy>          (engine; archive state for the daily anvil fork)
# The dRPC key is read from a hidden prompt (or DRPC_KEY env); the Alchemy key comes from the Alchemy CLI (app $ALCHEMY_APP).
# Both endpoints are checked (chain id, finalized head, eth_getLogs, archive eth_call) before anything is written.
# Values go to Railway via --stdin, so they never appear in process args or shell history.
# After it runs: seal RPC_URL and SIM_FORK_RPC_URL in the Railway dashboard (variable → ⋯ → Seal); the CLI can't seal.
#
# Usage (from anywhere):   RAILWAY_PROJECT=<project id> ALCHEMY_APP=<app id> bash engine/scripts/set-rpc-secrets.sh
# Needs: alchemy CLI (authed), railway CLI (logged in), curl, python3.
set -euo pipefail

PROJECT=${RAILWAY_PROJECT:?set RAILWAY_PROJECT (the Railway project id)}
RAILWAY_ENV=production
ALCHEMY_APP=${ALCHEMY_APP:?set ALCHEMY_APP (the Alchemy app id)}
POOL_MANAGER=0x000000000004444c5dc75cB358380D2e3dE08A90

trap 'unset ALCHEMY_URL DRPC_URL DRPC_KEY KEY' EXIT

fail() { echo "✗ $*" >&2; exit 1; }
for c in alchemy railway curl python3; do command -v "$c" >/dev/null || fail "missing $c"; done

# --- Alchemy (no echo) ---
KEY=$(alchemy --json --no-interactive --reveal app get "$ALCHEMY_APP" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["apiKey"])') || fail "could not read the Alchemy key (alchemy auth?)"
ALCHEMY_URL="https://eth-mainnet.g.alchemy.com/v2/$KEY"
unset KEY

# --- dRPC (hidden prompt; accepts the bare key or the full endpoint URL from the dRPC dashboard) ---
if [[ -z "${DRPC_KEY:-}" ]]; then
  read -rsp "Paste the dRPC key or its Ethereum endpoint URL (input hidden): " DRPC_KEY; echo
fi
[[ -n "$DRPC_KEY" ]] || fail "empty dRPC key"
if [[ "$DRPC_KEY" == https://* ]]; then DRPC_URL="$DRPC_KEY"; else DRPC_URL="https://lb.drpc.live/ethereum/$DRPC_KEY"; fi
unset DRPC_KEY

# --- check an endpoint: prints only pass/fail, never the URL ---
rpc() { # url method params → result (or "ERR:<message>")
  curl -sS --max-time 20 -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" "$1" \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(json.dumps(d["result"]) if "result" in d else "ERR:"+str(d.get("error",{}).get("message","?"))[:120])' 2>/dev/null || echo "ERR:request failed"
}
check() { # name url
  local name=$1 url=$2 r fin from
  r=$(rpc "$url" eth_chainId '[]');                       [[ "$r" == '"0x1"' ]] || fail "$name: eth_chainId → $r"
  fin=$(rpc "$url" eth_getBlockByNumber '["finalized",false]' | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["number"])' 2>/dev/null) \
    || fail "$name: finalized block not served"
  from=$(printf '0x%x' $(( fin - 1000 )))
  r=$(rpc "$url" eth_getLogs "[{\"address\":\"$POOL_MANAGER\",\"fromBlock\":\"$from\",\"toBlock\":\"$from\"}]")
  [[ "$r" != ERR:* ]] || fail "$name: eth_getLogs → ${r#ERR:} (free/public tier? the indexer needs eth_getLogs)"
  r=$(rpc "$url" eth_call "[{\"to\":\"$POOL_MANAGER\",\"data\":\"0x1e2eaeaf0000000000000000000000000000000000000000000000000000000000000000\"},\"0x14FB180\"]")
  [[ "$r" != ERR:* ]] && archive=yes || archive="no (${r#ERR:})"
  echo "✓ $name: mainnet, finalized $((fin)), eth_getLogs ok, archive state @22,000,000: $archive"
}
check Alchemy "$ALCHEMY_URL"
check dRPC "$DRPC_URL"

# --- write to Railway (stdin only) ---
set_var() { # service key value
  printf %s "$3" | railway variable set "$2" --stdin --service "$1" -p "$PROJECT" -e "$RAILWAY_ENV" --skip-deploys >/dev/null \
    || fail "railway: could not set $2 on $1"
  echo "✓ $1: $2 set"
}
for svc in indexer engine; do set_var "$svc" RPC_URL "$ALCHEMY_URL,$DRPC_URL"; done
set_var engine SIM_FORK_RPC_URL "$ALCHEMY_URL"

echo
echo "Done. Now seal RPC_URL (indexer, engine) and SIM_FORK_RPC_URL (engine) in the Railway dashboard:"
echo "  https://railway.com/project/$PROJECT  →  service → Variables → ⋯ → Seal"
