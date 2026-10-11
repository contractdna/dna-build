#!/usr/bin/env bash
# The engine image's binary media (the logo video, the fallback plates, the studio's style references) are release
# assets, not source files. Each is pinned by sha256 in media/release.sha256. This script downloads every missing file
# from MEDIA_BASE_URL (asset name = the path with "/" replaced by "_") and verifies every file, present or downloaded.
# Exit 1 on any mismatch, and the mismatching file is removed: a build or test must never run on unpinned bytes.
#   engine/scripts/fetch-media.sh                       # default: the media-v1 release of contractdna/dna-contracts
#   MEDIA_BASE_URL=file:///path/to/assets engine/scripts/fetch-media.sh
set -euo pipefail
MEDIA_BASE_URL="${MEDIA_BASE_URL:-https://github.com/contractdna/dna-contracts/releases/download/media-v1}"
cd "$(dirname "$0")/../media"

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

bad=0
while read -r want path; do
  [ -n "$path" ] || continue
  if [ ! -f "$path" ] || [ "$(sha "$path")" != "$want" ]; then
    rm -f "$path" # a failed re-download must never leave the bad file behind
    mkdir -p "$(dirname "$path")"
    tmp="$path.part"
    if ! curl -fsSL --retry 3 -o "$tmp" "$MEDIA_BASE_URL/${path//\//_}"; then
      echo "fetch-media: cannot download $path from $MEDIA_BASE_URL" >&2; rm -f "$tmp"; bad=1; continue
    fi
    mv "$tmp" "$path"
  fi
  got="$(sha "$path")"
  if [ "$got" != "$want" ]; then echo "fetch-media: $path sha256 $got, pinned $want: removed" >&2; rm -f "$path"; bad=1; fi
done < release.sha256
[ "$bad" = 0 ] || exit 1
echo "fetch-media: $(grep -c . release.sha256) files verified"
