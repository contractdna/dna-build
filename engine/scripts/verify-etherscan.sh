#!/usr/bin/env bash
# Verify every DNA contract on Etherscan (launch graph, the post-launch set, and GameFactory + GameFunder once the Safe's
# funding batch has deployed them), from the public commit's contracts/.
#
#   usage, from the root of the launch checkout (the public commit's contracts/ with submodules in place, launch.json,
#   engine/deployments/): bash <any checkout>/engine/scripts/verify-etherscan.sh <rpc-url> [chain]
#   chain: mainnet (default) | sepolia | ... Run after the post-launch deploys wrote the deployment JSON; rerun when it
#   gains gameFactory + gameFunder (contracts already verified are skipped by forge).
#
# Inputs (env, all optional except EXCLUDED_WALLETS when a convictionVault is listed):
#   ROOT              default the current directory (the launch checkout)
#   PUBLIC_TREE       the tree id of contracts/ in the public commit (git rev-parse $SOURCE_REVISION:contracts);
#                     HEAD:contracts must equal it. Default: launch-v2's
#   EXCLUDED_WALLETS  the exact comma-separated list the post-launch deploy used (contracts/.env.launch), IN THE SAME
#                     ORDER: it is ConvictionVault's address[] arg, so its order is part of the address chain
#                     (vault → GamePot → FeeVault → the hook's immutables); a reordered list gives other addresses
#   DEPLOYMENT        default engine/deployments/<chainid>.json        (addresses; absent/zero keys are skipped)
#   ENVELOPE          default engine/deployments/<chainid>.envelope.json (postLaunchSalt for the CREATE2 self-check)
#   LAUNCH_JSON       default launch.json  (route A pack: graph init code + args, checked byte for byte; required on
#                     mainnet)
#   VRF_KEY_HASH      default the mainnet 200 gwei lane (GamePot's 6th constructor arg; Launch.s.sol VRF_KEY_HASH)
#   SALT_NONCE / WEEKLY_BUDGET_WEI / PER_GAME_CAP_WEI   the live GameFunder's values (defaults 0 / 2 ETH / 0.1 ETH:
#                     the second ladder level, deployed alone through 0x4e59 with salt 0; the first was
#                     FundingSetup.s.sol's 0.2 ETH): GameFactory = (Safe, registry), GameFunder = (Safe, GameFactory, budget, cap), both
#                     CREATE2 via 0x4e59 with salt = SALT_NONCE as bytes32
#   CHECK_ONLY=1      run the build + bytecode/args self-checks only (no on-chain code check, no key read, nothing
#                     submitted): usable before launch on the planned addresses
#   PLATFORM_RECIPIENT / GRAPH_FACTORY   defaults: the mainnet values baked into PlatformRevenue / Bootstrap
#
# The Etherscan key is read from the macOS credential store (service dna.etherscan, account dna) into the environment
# (forge reads ETHERSCAN_API_KEY itself): it never appears in argv, output or a file. Nothing here sends a
# transaction; the RPC is only read.
#
# Before submitting anything it proves the submission will match (fails closed):
#   - contracts/ builds with the pinned settings (forge build src)
#   - each 0x4e59 CREATE2 address recomputes from forge's creation bytecode + the exact args below
#   - each graph target's init code in launch.json equals forge's creation bytecode, and its args equal ours
#   - every listed address has code on chain
set -euo pipefail

RPC=${1:?usage: verify-etherscan.sh <rpc-url> [chain]}
CHAIN=${2:-mainnet}
ROOT=${ROOT:-$(pwd)}
C=$ROOT/contracts
SOLC=v0.8.26+commit.8a97fa7a
CREATE2=0x4e59b44847b379578588920cA78FbF26c0B4956C

fail() { echo "✗ $*" >&2; exit 1; }
[ -f "$C/foundry.toml" ] || fail "run from the launch checkout's root (no contracts/foundry.toml under $ROOT)"
for t in forge cast jq curl security; do command -v $t >/dev/null || fail "missing $t"; done

CID=$(cast chain-id --rpc-url "$RPC") || fail "RPC unreachable"
case $CHAIN in mainnet) [ "$CID" = 1 ] || fail "chain mainnet but the RPC is chain $CID" ;; esac
D=${DEPLOYMENT:-$ROOT/engine/deployments/$CID.json}
E=${ENVELOPE:-$ROOT/engine/deployments/$CID.envelope.json}
LJ=${LAUNCH_JSON:-$ROOT/launch.json}
[ -f "$D" ] || fail "no deployment JSON at $D"
[ -f "$E" ] || fail "no envelope at $E"
# on mainnet the graph targets (token, hook, PlatformRevenue, Bootstrap) are checked against the pack: never skipped
[ "$CHAIN" != mainnet ] || [ -f "$LJ" ] || fail "no launch.json at $LJ: mainnet checks the graph's init code against it"

PLATFORM_RECIPIENT=${PLATFORM_RECIPIENT:-0xD88539d3c4C460136a733A3Fd60cf6BF269079da}
GRAPH_FACTORY=${GRAPH_FACTORY:-0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887}
VRF_KEY_HASH=${VRF_KEY_HASH:-0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9}

j() { local v; v=$(jq -r "$1 // empty" "$D"); [ "$v" = 0x0000000000000000000000000000000000000000 ] && v=; echo "$v"; }
lc() { echo "$1" | tr 'A-F' 'a-f'; }
PM=$(j .poolManager) POSM=$(j .positionManager) SAFE=$(j .safe) AGENT=$(j .agent) ANCHOR=$(j .anchorKey)
TOKEN=$(j .token) HOOK=$(j .hook) PLATFORM=$(j .platformRevenue) BOOTSTRAP=$(j .bootstrap)
REG=$(j .registry) BB=$(j .buybackBurn) LV=$(j .liquidityVault) CV=$(j .convictionVault) GP=$(j .gamePot)
FV=$(j .feeVault) MB=$(j .mutationBoard) IM=$(j .ideaMarket) BO=$(j .bountyBoard) VRF=$(j .vrfCoordinator)
GF=$(j .gameFactory) GFU=$(j .gameFunder)
SALT=$(jq -r '.postLaunchSalt // empty' "$E")

# Etherscan publishes the source it is given, and with bytecode_hash = none any source that compiles to the same
# bytecode (a comment edit, say) would verify: so the tree must be the public commit's, unmodified.
PUBLIC_TREE=${PUBLIC_TREE:-c8187cd2f73610f62fa589fd876fe3fd35e3cf52}   # contracts/ of contractdna/dna@896a81b = launch-v2:contracts
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  tree=$(git -C "$ROOT" rev-parse HEAD:contracts)
  [ "$tree" = "$PUBLIC_TREE" ] || fail "HEAD:contracts is $tree, not the public commit's $PUBLIC_TREE"
  git -C "$ROOT" diff --quiet HEAD -- contracts/src contracts/foundry.toml contracts/foundry.lock || fail "contracts/ has local edits"
  git -C "$ROOT" submodule status --recursive contracts/lib | grep -q '^[-+U]' && fail "a contracts/lib submodule is missing or off its pinned commit"
  echo "• contracts/ = public tree $PUBLIC_TREE, clean"
elif [ "$CHAIN" = mainnet ] && [ -z "${CHECK_ONLY:-}" ]; then
  fail "not a git checkout: cannot prove contracts/ is the public commit"
else
  echo "• not a git checkout: source tree not checked ($CHAIN dry run)"
fi

echo "• building contracts/ (pinned settings: solc 0.8.26, cancun, optimizer 800, bytecode_hash none)"
(cd "$C" && forge build src >/dev/null) || fail "forge build failed"
bc() { jq -r .bytecode.object "$C/out/$1.sol/$1.json"; }

# name | address | source path | 0x4e59 salt (empty: not a 0x4e59 deploy) | constructor args (hex, 0x = none)
ROWS=()
add() { ROWS+=("$1|$2|$3|$4|$5"); }
enc() { cast abi-encode "$@"; }
[ -n "$TOKEN" ] && add DNAToken "$TOKEN" src/DNAToken.sol "" "$(enc 'f(address)' "$BOOTSTRAP")"
[ -n "$HOOK" ] && add DNAHook "$HOOK" src/DNAHook.sol "" "$(enc 'f(address,address,address,address,address,address)' "$PM" "$TOKEN" "$REG" "$FV" "$PLATFORM" "$BB")"
[ -n "$PLATFORM" ] && add PlatformRevenue "$PLATFORM" src/PlatformRevenue.sol "" "$(enc 'f(address,address)' "$PM" "$PLATFORM_RECIPIENT")"
[ -n "$BOOTSTRAP" ] && add Bootstrap "$BOOTSTRAP" src/Bootstrap.sol "" "$(enc 'f(address,address,address)' "$SAFE" "$POSM" "$GRAPH_FACTORY")"
[ -n "$REG" ] && add ModuleRegistry "$REG" src/ModuleRegistry.sol "$SALT" "$(enc 'f(address,address,address,uint8,address)' "$SAFE" "$AGENT" "$ANCHOR" 5 "$SAFE")"
[ -n "$BB" ] && add BuybackBurn "$BB" src/BuybackBurn.sol "$SALT" "$(enc 'f(address,address)' "$PM" "$SAFE")"
[ -n "$LV" ] && add LiquidityVault "$LV" src/LiquidityVault.sol "$SALT" "$(enc 'f(address,address)' "$PM" "$SAFE")"
if [ -n "$CV" ]; then
  : "${EXCLUDED_WALLETS:?set EXCLUDED_WALLETS exactly as the post-launch deploy used it, same order (contracts/.env.launch)}"
  add ConvictionVault "$CV" src/ConvictionVault.sol "$SALT" "$(enc 'f(address,address,address[])' "$REG" "$SAFE" "[$EXCLUDED_WALLETS]")"
fi
[ -n "$GP" ] && add GamePot "$GP" src/GamePot.sol "$SALT" "$(enc 'f(address,address,address,address,address,bytes32)' "$PM" "$SAFE" "$CV" "$REG" "$VRF" "$VRF_KEY_HASH")"
[ -n "$FV" ] && add FeeVault "$FV" src/FeeVault.sol "$SALT" "$(enc 'f(address,address,address,address,address,address)' "$PM" "$REG" "$BB" "$LV" "$GP" "$SAFE")"
[ -n "$MB" ] && add MutationBoard "$MB" src/MutationBoard.sol "$SALT" "$(enc 'f(address,address)' "$CV" "$REG")"
[ -n "$IM" ] && add IdeaMarket "$IM" src/IdeaMarket.sol "$SALT" "$(enc 'f(address,address)' "$TOKEN" "$REG")"
[ -n "$BO" ] && add BountyBoard "$BO" src/BountyBoard.sol "$SALT" "$(enc 'f(address)' "$REG")"
for i in 0 1 2 3; do
  p=$(j ".plates[$i]"); [ -n "$p" ] || continue
  ps=$(cast keccak "$(enc 'f(string,uint256)' dna.plate $i)")
  if [ $i -lt 3 ]; then add AdaptiveFee "$p" src/modules/AdaptiveFee.sol "$ps" 0x; else add BaselineSplit "$p" src/modules/BaselineSplit.sol "$ps" 0x; fi
done
# GameFactory (the Safe's funding batch) and the live GameFunder: CREATE2 via 0x4e59, salt = SALT_NONCE as bytes32
FS=$(cast to-uint256 "${SALT_NONCE:-0}")
[ -n "$GF" ] && add GameFactory "$GF" src/games/GameFactory.sol "$FS" "$(enc 'f(address,address)' "$SAFE" "$REG")"
[ -n "$GFU" ] && add GameFunder "$GFU" src/games/GameFunder.sol "$FS" "$(enc 'f(address,address,uint256,uint256)' "$SAFE" "$GF" "${WEEKLY_BUDGET_WEI:-2000000000000000000}" "${PER_GAME_CAP_WEI:-100000000000000000}")"
[ ${#ROWS[@]} -gt 0 ] || fail "nothing to verify"

echo "• self-checks (nothing is submitted unless all pass)"
bad=0
for r in "${ROWS[@]}"; do
  IFS='|' read -r n a p s args <<<"$r"
  [ -n "${CHECK_ONLY:-}" ] || [ "$(cast code "$a" --rpc-url "$RPC")" != 0x ] || { echo "  ✗ $n $a has no code"; bad=1; continue; }
  if [ -n "$s" ]; then
    h=$(cast keccak "$(bc "$n")${args#0x}")
    want=0x$(cast keccak "0xff${CREATE2#0x}${s#0x}${h#0x}" | cut -c27-)
    [ "$(lc "$want")" = "$(lc "$a")" ] && echo "  ✓ $n init code reproduces $a (0x4e59 CREATE2)" \
      || { echo "  ✗ $n: forge bytecode + args give $want, not $a"; bad=1; }
  elif [ -f "$LJ" ]; then
    got=$(jq -r --arg n "$n" '.verificationBundle.components[] | select(.contractName == $n) | .constructorArguments' "$LJ")
    tid=$(jq -r --arg n "$n" '.verificationBundle.components[] | select(.contractName == $n) | .targetId' "$LJ")
    init=$(jq -r --arg t "$tid" '.graphBundle.targets[] | select(.targetId == $t) | .creationBytecode' "$LJ")
    [ "$(lc "$init")" = "$(lc "$(bc "$n")")" ] && [ "$(lc "$got")" = "$(lc "$args")" ] \
      && echo "  ✓ $n init code + args equal launch.json ($tid)" \
      || { echo "  ✗ $n differs from launch.json ($tid): bytecode or args"; bad=1; }
  else
    echo "  - $n: not a 0x4e59 deploy and no launch.json: bytecode not pre-checked"
  fi
done
[ $bad = 0 ] || fail "self-checks failed: fix before submitting (nothing was sent to Etherscan)"
[ -z "${CHECK_ONLY:-}" ] || { echo "✓ CHECK_ONLY: ${#ROWS[@]} contracts pass the self-checks"; exit 0; }

# -w prints the value: captured here, never shown, and passed on only through the environment
KEY=$(security find-generic-password -s dna.etherscan -a dna -w 2>/dev/null) || fail "no Etherscan key in the credential store (service dna.etherscan, account dna)"
export ETHERSCAN_API_KEY=$KEY
unset KEY

echo "• submitting to Etherscan ($CHAIN)"
failed=()
for r in "${ROWS[@]}"; do
  IFS='|' read -r n a p s args <<<"$r"
  echo "  → $n $a"
  ca=(); [ "$args" != 0x ] && ca=(--constructor-args "$args")
  (cd "$C" && forge verify-contract "$a" "$p:$n" --chain "$CHAIN" --compiler-version "$SOLC" --watch \
    --retries 15 --delay 10 "${ca[@]}") || failed+=("$n $a")
done

echo "• Etherscan readback (getsourcecode)"
for r in "${ROWS[@]}"; do
  IFS='|' read -r n a _ <<<"$r"
  out=$(curl -sS --max-time 30 --config <(printf 'url = "https://api.etherscan.io/v2/api?chainid=%s&module=contract&action=getsourcecode&address=%s&apikey=%s"\n' "$CID" "$a" "$ETHERSCAN_API_KEY"))
  name=$(printf '%s' "$out" | jq -r '.result[0].ContractName // empty' 2>/dev/null)
  [ "$name" = "$n" ] && echo "  ✓ $n $a verified" || { echo "  ✗ $n $a not verified (Etherscan says: ${name:-nothing})"; failed+=("$n $a (readback)"); }
  sleep 0.4
done

[ ${#failed[@]} = 0 ] || { printf '✗ %s\n' "${failed[@]}" >&2; exit 1; }
echo "✓ all ${#ROWS[@]} contracts verified on $CHAIN"
