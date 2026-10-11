#!/usr/bin/env bash
# Programmable's launch CLI 4.1.5 (the packer for Ethereum profile 3.6.0 under the v2 routed-fee policy, recipient
# 0xD885…79da), built from its PUBLIC source at the commit its GitHub Release `programmable-launch-v4.1.5` tags:
#   PROGRAMMABLE@74458fb646564b7c04daa3b99084eb7ea530a53b (2026-10-09T13:12Z; packages/launch is identical at 1a9119f,
#   "Unify new Ethereum Custom platform fees under D885"). 4.1.5 refuses a submission whose policy differs from the
#   live capabilities; 4.1.3 can no longer read them.
# Checks, fail closed: the tarball's sha256, then a digest of every packages/launch file (sorted "sha256  ./path"
# lines, hashed again: survives a GitHub re-encoding of the tarball), then `--version` = 4.1.5. Dependencies: npm ci
# from the package's own npm-shrinkwrap.json, production only (viem), no install scripts.
#
# Usage: bash engine/scripts/programmable-cli.sh            → prints the CLI path (builds it once, then reuses it)
#        "$(bash engine/scripts/programmable-cli.sh)" pack --config programmable-launch.config.json --output launch.json
set -euo pipefail

COMMIT=74458fb646564b7c04daa3b99084eb7ea530a53b
TARBALL_SHA256=43bcee11fe3690bce93df8295aa6a666d04b85f95dc02a89831f849d1397e94f
TREE_DIGEST=2d51bd65d59c419a7857589d3abb4ae59b8195d78f5fe408c7b74c061f0099c1   # packages/launch, 155 files
VERSION=4.1.5
DIR="${PROGRAMMABLE_CLI_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dna/programmable-launch-$VERSION-${COMMIT:0:12}}"
CLI="$DIR/packages/launch/bin/programmable-launch.mjs"

fail() { echo "programmable-cli: $*" >&2; exit 1; }
# sha256 of every file but node_modules (NUL-separated: any file name is safe), sorted, then hashed again
treeDigest() { (cd "$1" && find . -type f -not -path "./node_modules/*" -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1); }

if [[ ! -f "$DIR/.verified" ]]; then
  rm -rf "$DIR" && mkdir -p "$DIR"
  curl --fail --location --silent --show-error --max-time 600 -o "$DIR/src.tar.gz" \
    "https://codeload.github.com/programmablehq/PROGRAMMABLE/tar.gz/$COMMIT"
  got=$(shasum -a 256 "$DIR/src.tar.gz" | cut -d' ' -f1)
  [[ "$got" == "$TARBALL_SHA256" ]] || echo "programmable-cli: tarball sha256 $got (pinned $TARBALL_SHA256); checking the file digest instead" >&2
  tar -xzf "$DIR/src.tar.gz" -C "$DIR" --strip-components=1 "PROGRAMMABLE-$COMMIT/packages/launch"
  rm "$DIR/src.tar.gz"
  (cd "$DIR/packages/launch" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
  touch "$DIR/.verified"
fi
# every invocation, not only the first: the cached source must still be the reviewed one
got=$(treeDigest "$DIR/packages/launch")
[[ "$got" == "$TREE_DIGEST" ]] || fail "packages/launch digest $got, pinned $TREE_DIGEST: not the reviewed source (delete $DIR to rebuild)"
v=$(node "$CLI" --version 2>/dev/null || node "$CLI" --help | head -1)
[[ "$v" == *"$VERSION"* ]] || fail "CLI reports '$v', expected $VERSION"
echo "$CLI"
