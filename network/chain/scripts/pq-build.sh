#!/usr/bin/env bash
# Build the Lattice PQ fork's solana-test-validator (release, lean profile).
# Aborts the build if free disk drops below PQ_MIN_FREE_GB so a shared host
# (and the unmodified validator running on it) is never starved of space.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/pq-env.sh"
MIN_FREE_GB="${PQ_MIN_FREE_GB:-1.5}"

free_gb() { df -k "${PQ_ROOT}" | awk 'NR==2 { printf "%.2f", $4 / 1048576 }'; }

cd "${PQ_AGAVE}"
cargo build --release --bin solana-test-validator "$@" &
BUILD_PID=$!
while kill -0 "${BUILD_PID}" 2>/dev/null; do
  if awk -v f="$(free_gb)" -v m="${MIN_FREE_GB}" 'BEGIN { exit !(f < m) }'; then
    echo "pq-build: free disk $(free_gb) GiB < ${MIN_FREE_GB} GiB; stopping build" >&2
    pkill -TERM -P "${BUILD_PID}" || true
    kill -TERM "${BUILD_PID}" || true
    exit 75
  fi
  sleep 10
done
wait "${BUILD_PID}"
echo "pq-build: done; free disk $(free_gb) GiB; binary ${PQ_BIN}/solana-test-validator"
