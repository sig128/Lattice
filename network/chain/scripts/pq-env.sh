# shellcheck shell=bash
# Shared environment for building and running the Lattice PQ fork.
# Source it: `source chain/scripts/pq-env.sh`

PQ_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
export PQ_ROOT
export PQ_AGAVE="${PQ_ROOT}/chain/agave"
export PQ_LEDGER="${PQ_ROOT}/chain/ledger/pq-local"
export PQ_BIN="${PQ_AGAVE}/target/release"

# The Xcode.app toolchain on this host fails inside xcodebuild; the
# Command Line Tools toolchain works and is all cargo/cc need.
if [[ -d /Library/Developer/CommandLineTools ]]; then
  export DEVELOPER_DIR=/Library/Developer/CommandLineTools
  # The CLT linker rejects the MacOSX27 SDK stubs ("unknown architecture").
  if [[ -d "${DEVELOPER_DIR}/SDKs/MacOSX26.sdk" ]]; then
    export SDKROOT="${DEVELOPER_DIR}/SDKs/MacOSX26.sdk"
  fi
  # bindgen (rocksdb) needs libclang.
  export LIBCLANG_PATH="${DEVELOPER_DIR}/usr/lib"
fi
export CARGO_TARGET_DIR="${PQ_AGAVE}/target"

# Isolated ports: the unmodified validator uses 8899/8900/9900.
export PQ_RPC_PORT=8999
export PQ_FAUCET_PORT=9990
export PQ_GOSSIP_PORT=10050
export PQ_DYNAMIC_PORT_RANGE=10100-10200
export PQ_RPC_URL="http://127.0.0.1:${PQ_RPC_PORT}"

# Lean release profile: the host has very little free disk.
export CARGO_PROFILE_RELEASE_LTO=off
export CARGO_PROFILE_RELEASE_DEBUG=0
export CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO=off
export CARGO_PROFILE_RELEASE_STRIP=debuginfo
export CARGO_INCREMENTAL=0
