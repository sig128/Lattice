# shellcheck shell=bash
# Build environment for programs/* (source it). Reuses the Command Line Tools
# workaround from chain/scripts/pq-env.sh and one shared, lean target dir.
_PROGRAMS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=../chain/scripts/pq-env.sh
source "${_PROGRAMS_DIR}/../chain/scripts/pq-env.sh"
export CARGO_TARGET_DIR="${_PROGRAMS_DIR}/target"
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_TEST_DEBUG=0
export CARGO_INCREMENTAL=0
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
