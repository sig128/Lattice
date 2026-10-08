#!/usr/bin/env bash
# Create a Lattice genesis ledger with the lattice-bridge accounts using the
# fork's solana-genesis (patches 0004-0007). See docs/NATIVE_ISSUANCE.md.
#
#   lattice-genesis.sh --network mainnet|testnet --config BRIDGE.yaml \
#       --ledger DIR --bootstrap-validator IDENTITY VOTE STAKE \
#       [--faucet-pubkey FILE --faucet-lamports N]   (testnet only)
#       [-- extra solana-genesis args]
#
# mainnet: no faucet, inflation none, and solana-genesis refuses to write a
# ledger unless every genesis lamport (plus the runtime reserve) is backed
# by bootstrap deposits listed in the config. testnet: faucet allowed; the
# uncovered amount is written to the bridge state and printed as UNBACKED.
#
# Env: SOLANA_GENESIS (binary, default: on PATH or chain/agave/target/release),
#      LATTICE_RUNTIME_RESERVE_LAMPORTS (default 2000000000),
#      LATTICE_BOOTSTRAP_VALIDATOR_LAMPORTS (default 500000000000),
#      LATTICE_BOOTSTRAP_STAKE_LAMPORTS (default 500000000000),
#      LATTICE_SLOTS_PER_EPOCH (default 432000), LATTICE_HASHES_PER_TICK (default 12500).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
network="" config="" ledger="" faucet_pubkey="" faucet_lamports=""
validators=()
extra=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) network="$2"; shift 2 ;;
    --config) config="$2"; shift 2 ;;
    --ledger) ledger="$2"; shift 2 ;;
    --bootstrap-validator) validators+=("$2" "$3" "$4"); shift 4 ;;
    --faucet-pubkey) faucet_pubkey="$2"; shift 2 ;;
    --faucet-lamports) faucet_lamports="$2"; shift 2 ;;
    --) shift; extra=("$@"); break ;;
    *) echo "lattice-genesis: unknown argument $1" >&2; exit 64 ;;
  esac
done

[[ "${network}" == mainnet || "${network}" == testnet ]] || { echo "--network mainnet|testnet required" >&2; exit 64; }
[[ -f "${config}" ]] || { echo "--config FILE required" >&2; exit 64; }
[[ -n "${ledger}" ]] || { echo "--ledger DIR required" >&2; exit 64; }
[[ ${#validators[@]} -ge 3 ]] || { echo "--bootstrap-validator IDENTITY VOTE STAKE required" >&2; exit 64; }
if [[ -e "${ledger}" ]]; then
  echo "lattice-genesis: ${ledger} exists; refusing to overwrite a ledger" >&2
  exit 1
fi
if [[ "${network}" == mainnet && -n "${faucet_pubkey}${faucet_lamports}" ]]; then
  echo "lattice-genesis: Lattice mainnet genesis must not have a faucet" >&2
  exit 64
fi

genesis_bin="${SOLANA_GENESIS:-}"
if [[ -z "${genesis_bin}" ]]; then
  if [[ -x "${ROOT}/chain/agave/target/release/solana-genesis" ]]; then
    genesis_bin="${ROOT}/chain/agave/target/release/solana-genesis"
  else
    genesis_bin="$(command -v solana-genesis)"
  fi
fi
"${genesis_bin}" --help | grep -q -- --lattice-network || {
  echo "lattice-genesis: ${genesis_bin} is not the Lattice fork (no --lattice-network)" >&2
  exit 1
}

args=(
  --cluster-type development
  --lattice-network "${network}"
  --lattice-bridge-config "${config}"
  --lattice-runtime-reserve-lamports "${LATTICE_RUNTIME_RESERVE_LAMPORTS:-2000000000}"
  --ledger "${ledger}"
  --inflation none
  --slots-per-epoch "${LATTICE_SLOTS_PER_EPOCH:-432000}"
  --hashes-per-tick "${LATTICE_HASHES_PER_TICK:-12500}"
  --bootstrap-validator-lamports "${LATTICE_BOOTSTRAP_VALIDATOR_LAMPORTS:-500000000000}"
  --bootstrap-validator-stake-lamports "${LATTICE_BOOTSTRAP_STAKE_LAMPORTS:-500000000000}"
)
for ((i = 0; i < ${#validators[@]}; i += 3)); do
  args+=(--bootstrap-validator "${validators[i]}" "${validators[i + 1]}" "${validators[i + 2]}")
done
if [[ "${network}" == testnet && -n "${faucet_pubkey}" ]]; then
  args+=(--faucet-pubkey "${faucet_pubkey}" --faucet-lamports "${faucet_lamports:?--faucet-lamports required}")
fi

"${genesis_bin}" "${args[@]}" ${extra[@]+"${extra[@]}"} | tee "${ledger}.genesis-report.txt"
if [[ "${network}" == mainnet ]] && ! grep -q '^UNBACKED lamports: *0$' "${ledger}.genesis-report.txt"; then
  echo "lattice-genesis: mainnet report does not show zero unbacked lamports" >&2
  exit 1
fi
echo "lattice-genesis: ${network} ledger at ${ledger}; report ${ledger}.genesis-report.txt"
