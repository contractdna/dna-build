#!/usr/bin/env bash
# Deploy DNA to a running anvil (started with `anvil --slots-in-an-epoch 1`) and drive it through every indexed event.
# Usage: engine/scripts/devchain.sh [launch|actions|all|dev <fn>...]   (default all). RPC_URL defaults to
# http://127.0.0.1:8545.
# Writes engine/deployments/31337.json. Mines 2 blocks after each action so `finalized` (= head - 2 with 1-slot epochs)
# covers it.
set -euo pipefail
cd "$(dirname "$0")/../../contracts"
RPC="${RPC_URL:-http://127.0.0.1:8545}"
DEV=script/DevActions.s.sol:DevActions

mine() { cast rpc anvil_mine "${1:-2}" --rpc-url "$RPC" >/dev/null; }
travel() { cast rpc evm_increaseTime "$1" --rpc-url "$RPC" >/dev/null; mine 1; }
run() {
  local log; log="$(mktemp)"
  forge script "$@" --rpc-url "$RPC" --broadcast >"$log" 2>&1 || { cat "$log"; exit 1; }
  mine 2
}
dev() { echo "· DevActions $1"; run "$DEV" --sig "$1()"; }

launch() {
  echo "· LaunchLocal"
  run script/Launch.s.sol:LaunchLocal
  # IdeaMarket + BountyBoard: plain CREATE after the registry (SPEC §0), from anvil account 6 (any deployer works)
  echo "· IdeaMarket + BountyBoard"
  local out="../engine/deployments/31337.json" key=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
  local token registry im bb
  token="$(node -p "require('$out').token")"; registry="$(node -p "require('$out').registry")"
  im="$(forge create src/IdeaMarket.sol:IdeaMarket --rpc-url "$RPC" --private-key $key --broadcast --constructor-args "$token" "$registry" | awk '/Deployed to:/ {print $3}')"
  bb="$(forge create src/BountyBoard.sol:BountyBoard --rpc-url "$RPC" --private-key $key --broadcast --constructor-args "$registry" | awk '/Deployed to:/ {print $3}')"
  node -e "const f='$out', j=require(f); Object.assign(j, { ideaMarket: '$im', bountyBoard: '$bb' }); require('fs').writeFileSync(f, JSON.stringify(j, null, 2) + '\n')"
  mine 2
}

actions() {
  # each advance executes what the previous one queued (1 h later: registry MIN_DELAY), then queues the next step
  travel 300                  # past DNAHook's 4-minute launch window (its per-wallet cap would refuse the dev buy)
  dev swaps
  dev advance; travel 3600    # queue register x3
  dev advance; travel 3600    # registered; queue setShadow(bad), setShadow(split)
  dev advance; travel 3600    # shadows; queue setCanary(bad), setCanary(split)
  dev advance                 # canaries; queue setShadow(good), promote(split)
  dev rollback; travel 3600   # breaker trips on the reverting canary; anyone rolls back
  dev advance; travel 3600    # good shadow, split active; queue setCanary(good)
  dev advance; travel 3600    # good canary; queue promote(good)
  dev advance                 # adaptive fee active
  dev swaps
  dev distribute
  dev cancelDemo
}

case "${1:-all}" in
  launch) launch ;;
  actions) actions ;;
  all) launch; actions ;;
  dev) shift; for f in "$@"; do dev "$f"; done ;; # e.g. `devchain.sh dev swaps cancelDemo`
  *) echo "usage: $0 [launch|actions|all|dev <fn>...]" >&2; exit 2 ;;
esac
