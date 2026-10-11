#!/usr/bin/env bash
# Mainnet-fork dress rehearsal of the launch-day OPERATOR path, with the exact mainnet scripts:
#   anvil --fork-url (chain 1) → real Safe 2-of-3 (v1.4.1) → LaunchMainnet (envelope) → "Programmable signs" →
#   LaunchMainnet --broadcast (real Router + graph deployer + real ERC-1271 check) → PostLaunchMainnet --broadcast →
#   Safe T0 batch from the generated Transaction Builder JSON → indexer backfill from the launch block → web LIVE
#   (/api/health, /api/core) → engine in dry_run (/health).
# Programmable's signature: on a fork we impersonate the owner of their 1-of-2 permit-authority Safe and approveHash()
# the Safe message hash of our digest, then pass the approved-hash signature (r = owner, s = 0, v = 1). The Router's
# isValidSignature path is the real one; on mainnet PERMIT_SIGNATURE is what Programmable sends back instead.
# The DNA Safe's T0 batch is sent by impersonating the Safe (its 2-of-3 signing is covered by test/fork/Rehearsal.t.sol).
# Needs anvil/forge/cast/jq, Docker (or REHEARSAL_DATABASE_URL = an EMPTY database, superuser), Node 24, `npm ci` in
# engine/ and web/. FORK_RPC defaults to https://ethereum-rpc.publicnode.com. Ports: anvil 18546, pg 55436, web 3079,
# engine 18091. Outputs land in engine/deployments/fork/ (gitignored) and the broadcast logs in a temp dir.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FORK_RPC="${FORK_RPC:-https://ethereum-rpc.publicnode.com}"
export RPC_URL=http://127.0.0.1:18546
WEB=http://127.0.0.1:3079
ENGINE=http://127.0.0.1:18091/health
LOGS="$(mktemp -d)"
OUT="$ROOT/engine/deployments/fork"
mkdir -p "$OUT"
PIDS=()
CONTAINER=""
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "logs: $LOGS"
}
trap cleanup EXIT
c() { cast "$@" --rpc-url "$RPC_URL"; }

# Safe v1.4.1 + Programmable
SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
SAFE_SINGLETON=0x41675C099F32341bf84BFc5382aF534df5C7461a
SAFE_HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
ROUTER=0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3   # the 24-hour successor fresh 3.6 packs bind
PROGRAMMABLE_SIGNER=0x032b1c7b96793717F0BD2f11eb86cd10CdefC4a3
ZERO=0x0000000000000000000000000000000000000000
# anvil default keys (public test keys): 0 launch wallet + deployer, 1-3 Safe owners, 4 agent, 5 anchor, 6 keeper
K=(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
   0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
   0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
   0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e)
A=(); for k in "${K[@]}"; do A+=("$(cast wallet address --private-key "$k")"); done

echo "· anvil fork of $FORK_RPC"
anvil --fork-url "$FORK_RPC" --slots-in-an-epoch 1 --port 18546 >"$LOGS/anvil.log" 2>&1 & PIDS+=($!)
until c block-number >/dev/null 2>&1; do sleep 0.3; done
[ "$(c chain-id)" = 1 ] || { echo "fork is not chain 1"; exit 1; }

if [ -z "${REHEARSAL_DATABASE_URL:-}" ]; then
  echo "· postgres (docker)"
  CONTAINER=dna-rehearsal-$$
  docker run -d --rm --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dna -p 55436:5432 postgres:16-alpine >/dev/null
  until docker exec "$CONTAINER" pg_isready -U postgres -d dna -q 2>/dev/null; do sleep 0.5; done
  sleep 1
  REHEARSAL_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55436/dna
fi
export DATABASE_URL="$REHEARSAL_DATABASE_URL"

echo "· Safe 2-of-3 (v1.4.1 proxy)"
SETUP="$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "[${A[1]},${A[2]},${A[3]}]" 2 $ZERO 0x $SAFE_HANDLER $ZERO 0 $ZERO)"
SALT_NONCE="$(date +%s)$RANDOM"
SAFE="$(c call $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)(address)" $SAFE_SINGLETON "$SETUP" "$SALT_NONCE" --from "${A[0]}")"
c send $SAFE_FACTORY "createProxyWithNonce(address,bytes,uint256)" $SAFE_SINGLETON "$SETUP" "$SALT_NONCE" --private-key "${K[0]}" >/dev/null
[ "$(c call "$SAFE" "getThreshold()(uint256)")" = 2 ] || { echo "Safe setup failed"; exit 1; }

# the launch env: identical for the envelope run and the broadcast run
export SAFE LAUNCH_WALLET="${A[0]}" AGENT="${A[4]}" ANCHOR_KEY="${A[5]}" EXCLUDED_WALLETS="${A[1]},${A[2]},${A[3]}"
# the operator's confirmation of the frozen tokenURI handle (mainnet: typed by hand at pack time)
export X_HANDLE_CONFIRMED="$(sed -n 's/.*X_HANDLE = "\(.*\)";.*/\1/p' "$ROOT/contracts/src/DNAToken.sol")"
export ROUTE_NAMESPACE="$(cast keccak "dna.fork.ns.$SALT_NONCE")" ROUTE_NONCE="$(cast keccak "dna.fork.nonce.$SALT_NONCE")"
export VALID_AFTER="$(c block latest -f timestamp)"
export ENVELOPE="../engine/deployments/fork/1.envelope.json" DEPLOYMENT_OUT="../engine/deployments/fork/1.json" SAFE_BATCH_OUT="../engine/deployments/fork/1.safe-t0.json"
export FOUNDRY_BROADCAST="$LOGS/broadcast" # never mix fork broadcast logs with real chain-1 logs
cd "$ROOT/contracts"
fs() { local log="$LOGS/$1.log"; shift; forge script "$@" --rpc-url "$RPC_URL" >"$log" 2>&1 || { cat "$log"; exit 1; }; }

echo "· LaunchMainnet (plan + envelope)"
fs envelope script/Launch.s.sol:LaunchMainnet
DIGEST="$(jq -r .digest "$OUT/1.envelope.json")"
echo "  digest $DIGEST"

echo "· Programmable signs (fork: approved hash on their authority Safe)"
AUTH="$(c call $ROUTER "PERMIT_AUTHORITY()(address)")"
MSG_HASH="$(c call $SAFE_HANDLER "getMessageHashForSafe(address,bytes)(bytes32)" "$AUTH" "$(cast abi-encode "f(bytes32)" "$DIGEST")")"
c rpc anvil_impersonateAccount $PROGRAMMABLE_SIGNER >/dev/null
c rpc anvil_setBalance $PROGRAMMABLE_SIGNER 0xde0b6b3a7640000 >/dev/null
c send "$AUTH" "approveHash(bytes32)" "$MSG_HASH" --from $PROGRAMMABLE_SIGNER --unlocked >/dev/null
SIGNER_HEX="$(echo "${PROGRAMMABLE_SIGNER#0x}" | tr 'A-F' 'a-f')"
export PERMIT_SIGNATURE="0x000000000000000000000000${SIGNER_HEX}0000000000000000000000000000000000000000000000000000000000000000""01"

echo "· LaunchMainnet --broadcast (launchAndStampV1 from the launch wallet)"
fs launch script/Launch.s.sol:LaunchMainnet --broadcast --slow --private-key "${K[0]}"
unset PERMIT_SIGNATURE
TOKEN="$(jq -r .token "$OUT/1.envelope.json")"
HOOK="$(jq -r .hook "$OUT/1.envelope.json")"
[ "$(c call $ROUTER "launchIdByToken(address)(bytes32)" "$TOKEN")" != 0x0000000000000000000000000000000000000000000000000000000000000000 ] || { echo "not stamped"; exit 1; }
echo "  token $TOKEN hook $HOOK"
# post-launch checks: opening tick 201107 and the LP NFT owned by 0xdEaD
TX="$(jq -r '.receipts[0].transactionHash' "$LOGS/broadcast/Launch.s.sol/1/run-latest.json")"
TICK="$(c receipt "$TX" --json | jq -r '.logs[] | select(.address|ascii_downcase=="0x000000000004444c5dc75cb358380d2e3de08a90") | select(.topics[0]=="0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438") | .data' \
  | xargs cast abi-decode --input "f(uint24,int24,address,uint160,int24)" | tail -1 | cut -d' ' -f1)"
[ "$TICK" = 201107 ] || { echo "opening tick $TICK != 201107"; exit 1; }
LP_ID="$(c receipt "$TX" --json | jq -r '.logs[] | select(.address|ascii_downcase=="0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e") | .topics[3]' | head -1)"
[ "$(c call 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e "ownerOf(uint256)(address)" "$LP_ID")" = 0x000000000000000000000000000000000000dEaD ] || { echo "LP NFT not burnt"; exit 1; }
echo "  launch tx $TX: opening tick $TICK, LP NFT $LP_ID owned by 0xdEaD"

echo "· PostLaunchMainnet --broadcast (registry, vaults, plates, IdeaMarket, BountyBoard)"
fs post script/Launch.s.sol:PostLaunchMainnet --broadcast --slow --private-key "${K[0]}"
REGISTRY="$(jq -r .registry "$OUT/1.json")"
# every post-launch contract (incl. the plates listed in 1.json) has code
for x in registry feeVault buybackBurn liquidityVault ideaMarket bountyBoard; do
  [ "$(c code "$(jq -r ".$x" "$OUT/1.json")")" != 0x ] || { echo "$x has no code"; exit 1; }
done
[ "$(jq '.plates | length' "$OUT/1.json")" = 4 ] || { echo "1.json lacks the 4 plates"; exit 1; }
for p in $(jq -r '.plates[]' "$OUT/1.json"); do [ "$(c code "$p")" != 0x ] || { echo "plate $p has no code"; exit 1; }; done

echo "· Safe T0 batch from the Transaction Builder JSON (impersonated Safe)"
c rpc anvil_impersonateAccount "$SAFE" >/dev/null
c rpc anvil_setBalance "$SAFE" 0xde0b6b3a7640000 >/dev/null
n="$(jq '.transactions | length' "$OUT/1.safe-t0.json")"
for i in $(seq 0 $((n - 1))); do
  c send "$(jq -r ".transactions[$i].to" "$OUT/1.safe-t0.json")" "$(jq -r ".transactions[$i].data" "$OUT/1.safe-t0.json")" --from "$SAFE" --unlocked >/dev/null
done
[ "$(c call "$REGISTRY" "hook()(address)")" = "$HOOK" ] || { echo "registry not initialized"; exit 1; }
[ "$(c call "$REGISTRY" "nextId()(uint256)")" = 4 ] || { echo "expected 4 queued registers"; exit 1; }
c rpc anvil_mine 3 >/dev/null # finalized (head - 2) covers everything
# warm the fork cache one read at a time: the indexer's ~15 parallel snapshot reads of not-yet-cached mainnet slots
# (PoolManager claims) can stall anvil's forking backend on a public RPC
for who in feeVault buybackBurn liquidityVault platformRevenue; do
  c call 0x000000000004444c5dc75cB358380D2e3dE08A90 "balanceOf(address,uint256)(uint256)" "$(jq -r ".$who" "$OUT/1.json")" 0 --block finalized >/dev/null
done

echo "· indexer --once (backfill from the launch block)"
cd "$ROOT/engine"
export CHAIN_ID=1 DEPLOYMENT_FILE="$OUT/1.json"
node src/indexer.ts --once >"$LOGS/indexer.log" 2>&1 || { cat "$LOGS/indexer.log"; exit 1; }
node -e "require('postgres')(process.env.DATABASE_URL)\`alter role dna_web with login password 'rehearsal'\`.then(() => process.exit(0))"
WEB_DB="$(node -e "const u = new URL(process.env.DATABASE_URL); u.username = 'dna_web'; u.password = 'rehearsal'; console.log(u.href)")"

echo "· web (next dev, LIVE)"
cd "$ROOT/web"
NEXT_PUBLIC_LIVE=1 DATABASE_URL="$WEB_DB" npx next dev -p 3079 >"$LOGS/web.log" 2>&1 & PIDS+=($!)
until curl -sf "$WEB/api/health" >/dev/null; do sleep 0.5; done
curl -sf "$WEB/api/health" | jq -e '.stale == false' >/dev/null || { echo "web: indexer stale"; curl -s "$WEB/api/health"; exit 1; }
curl -sf "$WEB/api/core" >"$LOGS/core.json"
jq -e '.autonomy == 5 and .rollbacks == 0 and .block > 0' "$LOGS/core.json" >/dev/null || { echo "web: unexpected core"; cat "$LOGS/core.json"; exit 1; }
echo "  /api/core: $(jq -c '{block, autonomy, proposals, epoch, activeModules, state}' "$LOGS/core.json")"

echo "· engine (ENGINE_MODE=dry_run)"
cd "$ROOT/engine"
# never reach real services from a rehearsal: drop every external credential inherited from the shell, point every
# API base at a closed local port and replay LLM fixtures only
env -u TELEGRAM_BOT_TOKEN -u TELEGRAM_GROUP_ID -u TELEGRAM_ALLOWED_USER_IDS -u X_CLIENT_ID -u X_CLIENT_SECRET \
  -u X_REFRESH_TOKEN -u X_USER_ID -u XAI_API_KEY -u OPENROUTER_API_KEY_ENGINE \
  TELEGRAM_API_BASE=http://127.0.0.1:9 X_API_BASE=http://127.0.0.1:9 XAI_API_BASE=http://127.0.0.1:9 \
  OPENROUTER_API_BASE=http://127.0.0.1:9 LLM_MODE=replay \
  ENGINE_MODE=dry_run PORT=18091 AGENT_PRIVATE_KEY="${K[4]}" ANCHOR_PRIVATE_KEY="${K[5]}" KEEPER_PRIVATE_KEY="${K[6]}" \
  node src/engine.ts >"$LOGS/engine.log" 2>&1 & PIDS+=($!)
until curl -sf "$ENGINE" >/dev/null; do sleep 0.5; done
curl -sf "$ENGINE" | jq -e '.mode == "dry_run"' >/dev/null || { echo "engine not in dry_run"; curl -s "$ENGINE"; exit 1; }
echo "REHEARSAL PASS (token $TOKEN, hook $HOOK, Safe $SAFE)"
