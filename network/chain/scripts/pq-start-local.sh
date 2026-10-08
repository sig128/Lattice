#!/usr/bin/env bash
# Start the Lattice PQ fork's solana-test-validator on isolated ports with the
# pq-vault program loaded at genesis. Does not touch the unmodified validator
# (8899/8900/9900, chain/ledger/local-development).
# RPC 8999, WebSocket 9000 (RPC+1), faucet 9990, gossip 10050, dynamic 10100-10200.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/pq-env.sh"

VALIDATOR="${PQ_BIN}/solana-test-validator"
PROGRAM_SO="${PQ_ROOT}/chain/target/deploy/lattice_pq_vault.so"
PROGRAM_ID="FQn1rtLkx2wTqXQK4Ur96HATPdQhHeFyA5v2F1NSChBn"
MLDSA_FEATURE="2e8mniAJiRxZz5JFAU2mX8KzCN6Z16GRGkBD7fnPF62P"

[[ -x "${VALIDATOR}" ]] || { echo "Missing ${VALIDATOR}; run chain/scripts/pq-build.sh" >&2; exit 1; }
[[ -f "${PROGRAM_SO}" ]] || { echo "Missing ${PROGRAM_SO}; run cargo-build-sbf in chain/programs/pq-vault" >&2; exit 1; }
"${VALIDATOR}" --version

RESET_ARGS=()
[[ "${1:-}" == "--reset" ]] && RESET_ARGS+=(--reset)

mkdir -p "${PQ_LEDGER}"
# solana-test-validator activates every feature in FEATURE_NAMES at genesis,
# including enable_mldsa65_verify_syscall (${MLDSA_FEATURE}).
exec "${VALIDATOR}" \
  --ledger "${PQ_LEDGER}" \
  --bind-address 127.0.0.1 \
  --rpc-port "${PQ_RPC_PORT}" \
  --faucet-port "${PQ_FAUCET_PORT}" \
  --gossip-port "${PQ_GOSSIP_PORT}" \
  --dynamic-port-range "${PQ_DYNAMIC_PORT_RANGE}" \
  --limit-blockstore-size 20000 \
  --bpf-program "${PROGRAM_ID}" "${PROGRAM_SO}" \
  "${RESET_ARGS[@]}"
