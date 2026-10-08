#!/usr/bin/env bash
# Build and test the Lattice Agave fork on the build server
# (Ubuntu 24.04, m7i.2xlarge: 8 vCPU / 32 GiB, 500 GB disk).
#
#   chain/scripts/build-lattice-validator.sh [--no-apt] [--skip-tests]
#       [--full-runtime-tests] [--smoke-validator]
#
# 1. Installs build dependencies (apt) and rustup (toolchain from
#    chain/agave/rust-toolchain.toml, currently 1.97.1).
# 2. Uses chain/agave if it is a git checkout; otherwise clones Agave at the
#    pinned commit (chain/upstream.lock.json) and applies chain/patches/*.patch
#    with `git am` on branch lattice/pq-mldsa-v1.
# 3. Builds release binaries: agave-validator, solana-test-validator,
#    solana-genesis, solana-keygen, solana.
# 4. Runs the fork's tests (transaction-context hook, lattice-bridge crate,
#    builtins, genesis, svm, runtime bank-level bridge tests, clippy).
# 5. Smoke: builds a mainnet-style (no faucet, fully backed) and a testnet
#    (faucet, labelled unbacked) genesis with throwaway keys. With
#    --smoke-validator, boots a single validator on the mainnet-style ledger
#    and records getSupply vs. the genesis account sum (measures the runtime
#    reserve).
#
# Output: chain/evidence/lattice-build-<UTC timestamp>/ (logs + summary.txt).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGAVE="${ROOT}/chain/agave"
PATCHES="${ROOT}/chain/patches"
UPSTREAM_COMMIT="825efd18292aff6ffcf9daa0f7612f21b3531a72"
BRANCH="lattice/pq-mldsa-v1"
MIN_FREE_GB="${LATTICE_MIN_FREE_GB:-60}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${ROOT}/chain/evidence/lattice-build-${STAMP}"
JOBS="${CARGO_BUILD_JOBS:-$(nproc)}"

APT=1 TESTS=1 FULL_RUNTIME=0 SMOKE_VALIDATOR=0
for arg in "$@"; do
  case "${arg}" in
    --no-apt) APT=0 ;;
    --skip-tests) TESTS=0 ;;
    --full-runtime-tests) FULL_RUNTIME=1 ;;
    --smoke-validator) SMOKE_VALIDATOR=1 ;;
    *) echo "unknown argument ${arg}" >&2; exit 64 ;;
  esac
done

mkdir -p "${OUT}"
SUMMARY="${OUT}/summary.txt"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "${SUMMARY}"; }
free_gb() { df -BG --output=avail "${ROOT}" | tail -1 | tr -dc '0-9'; }
step() {
  # step NAME CMD... : run, tee to OUT/NAME.log, record PASS/FAIL, keep going.
  local name="$1"; shift
  log "START ${name}: $*"
  if "$@" >"${OUT}/${name}.log" 2>&1; then
    log "PASS  ${name}"
  else
    log "FAIL  ${name} (exit $?; see ${OUT}/${name}.log)"
    FAILED+=("${name}")
  fi
}
FAILED=()

if (( $(free_gb) < MIN_FREE_GB )); then
  echo "need >= ${MIN_FREE_GB} GiB free, have $(free_gb) GiB" >&2
  exit 75
fi

# 1. System dependencies and toolchain ------------------------------------
if (( APT )); then
  log "apt: installing build dependencies"
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential pkg-config libssl-dev libudev-dev zlib1g-dev \
    llvm clang libclang-dev cmake protobuf-compiler \
    git curl ca-certificates python3 jq
fi
if ! command -v rustup >/dev/null; then
  log "installing rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
fi
# shellcheck disable=SC1091
source "${HOME}/.cargo/env"

# 2. Source ---------------------------------------------------------------
if [[ -d "${AGAVE}/.git" ]]; then
  log "using existing checkout ${AGAVE} ($(git -C "${AGAVE}" rev-parse --abbrev-ref HEAD) $(git -C "${AGAVE}" rev-parse --short HEAD))"
else
  log "cloning Agave ${UPSTREAM_COMMIT} and applying ${PATCHES}/*.patch"
  git clone --filter=blob:none --no-checkout https://github.com/anza-xyz/agave.git "${AGAVE}"
  git -C "${AGAVE}" checkout -b "${BRANCH}" "${UPSTREAM_COMMIT}"
  git -C "${AGAVE}" -c user.name="Lattice Build" -c user.email="build@lattice.local" \
    am --committer-date-is-author-date "${PATCHES}"/*.patch
fi
cd "${AGAVE}"
TOOLCHAIN="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)"
rustup toolchain install "${TOOLCHAIN}" --profile minimal --component clippy,rustfmt
log "toolchain $(rustc --version); tree $(git rev-parse "HEAD^{tree}"); commit $(git rev-parse HEAD)"
git log --oneline "${UPSTREAM_COMMIT}..HEAD" | tee -a "${SUMMARY}"

# 3. Build ----------------------------------------------------------------
step build-release cargo build --release -j "${JOBS}" \
  --bin agave-validator --bin solana-test-validator --bin solana-genesis \
  --bin solana-keygen --bin solana
BIN="${AGAVE}/target/release"

# 4. Tests ----------------------------------------------------------------
if (( TESTS )); then
  step test-transaction-context cargo test -j "${JOBS}" -p solana-transaction-context \
    --features agave-unstable-api,dev-context-only-utils --lib
  step test-mldsa-verify cargo test -j "${JOBS}" -p agave-mldsa-verify
  step test-lattice-bridge-pure cargo test -j "${JOBS}" -p solana-lattice-bridge-program --lib
  step test-lattice-bridge-processor cargo test -j "${JOBS}" -p solana-lattice-bridge-program \
    --features dev-context-only-utils --lib
  step clippy-lattice-bridge cargo clippy -j "${JOBS}" -p solana-lattice-bridge-program \
    --all-targets --features dev-context-only-utils -- -D warnings
  step test-builtins cargo test -j "${JOBS}" -p solana-builtins \
    --features agave-unstable-api,dev-context-only-utils --lib
  step test-genesis cargo test -j "${JOBS}" -p solana-genesis
  step test-feature-set cargo test -j "${JOBS}" -p agave-feature-set --lib
  step test-svm cargo test -j "${JOBS}" -p solana-svm --features agave-unstable-api,dev-context-only-utils --lib
  step test-runtime-lattice cargo test -j "${JOBS}" -p solana-runtime --lib lattice_bridge
  step test-runtime-capitalization cargo test -j "${JOBS}" -p solana-runtime --lib capitalization
  if (( FULL_RUNTIME )); then
    # Catches upstream tests affected by the new builtin (bank hashes,
    # builtin counts). Slow (tens of minutes).
    step test-runtime-full cargo test -j "${JOBS}" -p solana-runtime --lib
  fi
fi

# 5. Smoke: genesis --------------------------------------------------------
SMOKE="${OUT}/smoke"
mkdir -p "${SMOKE}"
keygen() { "${BIN}/solana-keygen" new --no-bip39-passphrase --silent --force -o "$1" >/dev/null; "${BIN}/solana-keygen" pubkey "$1"; }
# Called as an `if` condition by step(), where `set -e` does not apply:
# every command that matters ends in `|| return 1`.
smoke_genesis() {
  local g1 g2 g3 operator identity vote stake faucet
  g1="$(keygen "${SMOKE}/guardian-1.json")" || return 1
  g2="$(keygen "${SMOKE}/guardian-2.json")" || return 1
  g3="$(keygen "${SMOKE}/guardian-3.json")" || return 1
  operator="$(keygen "${SMOKE}/operator.json")" || return 1
  identity="${SMOKE}/identity.json"; vote="${SMOKE}/vote.json"; stake="${SMOKE}/stake.json"
  faucet="${SMOKE}/faucet.json"
  for key in "${identity}" "${vote}" "${stake}" "${faucet}"; do keygen "${key}" >/dev/null || return 1; done
  local common
  common=$(cat <<EOF
solana_genesis_hash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
source_program_id: "${operator}"
source_mint: "So11111111111111111111111111111111111111112"
source_decimals: 6
guardian_scheme: ed25519
guardian_threshold: 2
guardians:
  - ed25519: "${g1}"
  - ed25519: "${g2}"
  - ed25519: "${g3}"
max_mint_per_epoch_lamports: 100000000000000
bootstrap_surplus_recipient: "${operator}"
EOF
)
  # 1,000,000 source tokens (6 decimals) of bootstrap deposits back mainnet.
  printf 'deployment_label: "smoke-mainnet"\n%s\nbootstrap_deposits:\n  - { sequence: 0, source_amount: 1000000000000, recipient: "%s" }\n' \
    "${common}" "${operator}" >"${SMOKE}/mainnet.yaml"
  printf 'deployment_label: "smoke-testnet"\n%s\nbootstrap_deposits: []\n' "${common}" >"${SMOKE}/testnet.yaml"

  SOLANA_GENESIS="${BIN}/solana-genesis" "${ROOT}/chain/scripts/lattice-genesis.sh" \
    --network mainnet --config "${SMOKE}/mainnet.yaml" --ledger "${SMOKE}/ledger-mainnet" \
    --bootstrap-validator "${identity}" "${vote}" "${stake}" || return 1
  SOLANA_GENESIS="${BIN}/solana-genesis" "${ROOT}/chain/scripts/lattice-genesis.sh" \
    --network testnet --config "${SMOKE}/testnet.yaml" --ledger "${SMOKE}/ledger-testnet" \
    --bootstrap-validator "${identity}" "${vote}" "${stake}" \
    --faucet-pubkey "${faucet}" --faucet-lamports 500000000000000000 || return 1
  grep -q 'UNBACKED lamports: *[1-9]' "${SMOKE}/ledger-testnet.genesis-report.txt" || return 1

  # Negative checks: mainnet must refuse a faucet and an unbacked genesis.
  if SOLANA_GENESIS="${BIN}/solana-genesis" "${ROOT}/chain/scripts/lattice-genesis.sh" \
      --network mainnet --config "${SMOKE}/testnet.yaml" --ledger "${SMOKE}/ledger-should-fail" \
      --bootstrap-validator "${identity}" "${vote}" "${stake}"; then
    echo "mainnet genesis without backing unexpectedly succeeded" >&2
    return 1
  fi
  if "${BIN}/solana-genesis" --cluster-type development --lattice-network mainnet \
      --lattice-bridge-config "${SMOKE}/mainnet.yaml" --ledger "${SMOKE}/ledger-faucet-fail" \
      --bootstrap-validator "${identity}" "${vote}" "${stake}" \
      --faucet-pubkey "${faucet}" --faucet-lamports 1; then
    echo "mainnet genesis with faucet unexpectedly succeeded" >&2
    return 1
  fi
}
if [[ -x "${BIN}/solana-genesis" && -x "${BIN}/solana-keygen" ]]; then
  step smoke-genesis smoke_genesis
else
  log "SKIP  smoke-genesis (binaries missing)"
fi

# Optional: boot the mainnet-style ledger and compare supply with genesis.
smoke_validator() {
  local ledger="${SMOKE}/ledger-mainnet" rpc=18899
  "${BIN}/agave-validator" --identity "${SMOKE}/identity.json" \
    --vote-account "${SMOKE}/vote.json" --ledger "${ledger}" \
    --rpc-port "${rpc}" --gossip-port 18001 --dynamic-port-range 18100-18200 \
    --bind-address 127.0.0.1 --allow-private-addr --full-rpc-api \
    --no-wait-for-vote-to-start-leader --no-os-network-limits-test \
    --init-complete-file "${SMOKE}/init-complete" --log "${SMOKE}/validator.log" &
  local pid=$!
  trap 'kill ${pid} 2>/dev/null || true' RETURN
  for _ in $(seq 1 120); do [[ -f "${SMOKE}/init-complete" ]] && break; sleep 2; done
  [[ -f "${SMOKE}/init-complete" ]] || { echo "validator did not finish init" >&2; return 1; }
  sleep 10
  curl -s -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSupply"}' "http://127.0.0.1:${rpc}" | tee "${SMOKE}/getSupply.json" || return 1
  echo
  python3 - "${SMOKE}/getSupply.json" "${SMOKE}/ledger-mainnet.genesis-report.txt" <<'PY'
import json, re, sys
total = json.load(open(sys.argv[1]))["result"]["value"]["total"]
report = open(sys.argv[2]).read()
genesis = int(re.search(r"Genesis account lamports: +(\d+)", report).group(1))
reserve = int(re.search(r"Runtime reserve \(slot 0\): +(\d+)", report).group(1))
print(f"getSupply.total={total} genesis_accounts={genesis} runtime_created~={total - genesis} reserve={reserve}")
print("reserve covers runtime-created lamports" if total - genesis <= reserve else "RESERVE TOO SMALL")
PY
}
if (( SMOKE_VALIDATOR )); then
  step smoke-validator smoke_validator
fi

log "binaries: ${BIN}/{agave-validator,solana-test-validator,solana-genesis,solana-keygen,solana}"
log "free disk: $(free_gb) GiB"
if (( ${#FAILED[@]} )); then
  log "FAILED steps: ${FAILED[*]}"
  exit 1
fi
log "all steps passed"
