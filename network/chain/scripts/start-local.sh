#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LEDGER="${ROOT}/chain/ledger/local-development"
PINNED_VALIDATOR="${HOME}/.local/share/solana/install/active_release/bin/solana-test-validator"
if [[ -x "${PINNED_VALIDATOR}" ]]; then
  VALIDATOR="${AGAVE_VALIDATOR_BIN:-${PINNED_VALIDATOR}}"
else
  VALIDATOR="${AGAVE_VALIDATOR_BIN:-solana-test-validator}"
fi

if ! command -v "${VALIDATOR}" >/dev/null 2>&1; then
  echo "Missing ${VALIDATOR}. Build the pinned Agave source first; see chain/README.md." >&2
  exit 1
fi

RESET_ARGS=()
if [[ "${1:-}" == "--reset" ]]; then
  if [[ "${LATTICE_ENVIRONMENT:-local-development}" != "local-development" ]]; then
    echo "Reset is restricted to LATTICE_ENVIRONMENT=local-development." >&2
    exit 1
  fi
  RESET_ARGS+=(--reset)
fi

mkdir -p "${LEDGER}"
exec "${VALIDATOR}" \
  --ledger "${LEDGER}" \
  --bind-address 127.0.0.1 \
  --rpc-port 8899 \
  --faucet-port 9900 \
  --limit-ledger-size "${LATTICE_LEDGER_SHREDS:-100000}" \
  ${RESET_ARGS[@]+"${RESET_ARGS[@]}"}
