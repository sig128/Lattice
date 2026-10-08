#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${ROOT}/chain/agave"
COMMIT="825efd18292aff6ffcf9daa0f7612f21b3531a72"

if [[ -e "${DEST}" ]]; then
  echo "Refusing to replace ${DEST}. Remove it explicitly if you intend to refetch." >&2
  exit 1
fi

git clone --filter=blob:none --no-checkout https://github.com/anza-xyz/agave.git "${DEST}"
git -C "${DEST}" checkout --detach "${COMMIT}"
test "$(git -C "${DEST}" rev-parse HEAD)" = "${COMMIT}"
echo "Pinned Agave source checked out at ${DEST}"
