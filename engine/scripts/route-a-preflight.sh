#!/usr/bin/env bash
# Route A pre-submission checks, in order. Sends nothing that persists: Programmable's preflight
# "never allocates a nonce, persists a launch, signs, or broadcasts" (CLI 4.1.5 `validate --help`).
#   1. the profile gate: GET /v3/capabilities still admits 3.6.0 with the pinned 0.3% v2 policy, recipient 0xD885…79da (route-a.ts gate)
#   2. our pins + the v3.6 OpenAPI on the packed request (route-a.ts check)
#   3. Programmable's local validate: byte-identical reproduction of launch.json from the config (no network)
#   4. Programmable's REMOTE validate (= POST /v3/custom-launches/preflight, quota-free): needs the launch operator's
#      API key (scopes custom-launch:create + custom-launch:read) in the Programmable CLI's credential store, where the
#      CLI reads it (service api.programmable.market, account PROGRAMMABLE_API_KEY). Never an argument or a file.
# Usage, from the repo root: bash engine/scripts/route-a-preflight.sh launch.json   (writes preflight.json)
set -euo pipefail

LAUNCH=${1:?usage: route-a-preflight.sh <launch.json>}
CONFIG=programmable-launch.config.json
[[ -f "$LAUNCH" && -f "$CONFIG" ]] || { echo "run from the repo root after route-a.ts build and programmable-launch pack ($CONFIG, $LAUNCH)" >&2; exit 1; }
if [[ -n "${PROGRAMMABLE_API_KEY:-}" ]]; then
  echo "PROGRAMMABLE_API_KEY is set in the environment: unset it, the key belongs in the Programmable CLI's credential store" >&2; exit 1
fi
# presence only: -w would print the key
security find-generic-password -s api.programmable.market -a PROGRAMMABLE_API_KEY >/dev/null 2>&1 \
  || { echo "no Programmable API key in the Programmable CLI's credential store yet (the launch operator's key): stop" >&2; exit 1; }

CLI=$(bash engine/scripts/programmable-cli.sh)
node engine/scripts/route-a.ts gate
node engine/scripts/route-a.ts check "$LAUNCH"
node "$CLI" validate "$LAUNCH" --config "$CONFIG" >/dev/null || { echo "local validate failed: launch.json is not reproduced from the config (repack)" >&2; exit 1; }
echo "local validate: reproduced from the config"
node "$CLI" validate "$LAUNCH" --config "$CONFIG" --remote > preflight.json
jq '{disposition, hardBlockFindingCodes, needsEvidenceFindingCodes, launchEligibility}' preflight.json
jq -e '(.hardBlockFindingCodes // []) | length == 0' preflight.json >/dev/null \
  || { echo "HARD BLOCK: stop, read the remediations in preflight.json" >&2; exit 1; }
echo "preflight clean: preflight.json (keep it in the launch log). Submit is a separate, deliberate step."
