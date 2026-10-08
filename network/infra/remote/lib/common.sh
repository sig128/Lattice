# shellcheck shell=bash disable=SC2034
# Shared paths and helpers for the Lattice server scripts.
# Installed to /usr/local/lib/lattice/common.sh; sourced, never executed.

LATTICE_USER=lattice
LATTICE_HOME=/var/lib/lattice
LATTICE_ETC=/etc/lattice
LATTICE_ENV_FILE=/etc/lattice/lattice.env
LATTICE_LIB=/usr/local/lib/lattice
LATTICE_RELEASES=/opt/lattice/releases
LATTICE_CURRENT=/opt/lattice/current
LATTICE_LEDGER=/var/lib/lattice/ledger
LATTICE_KEYS=/var/lib/lattice/keys
LATTICE_STATE=/var/lib/lattice/state
LATTICE_BIN_DIR=/var/lib/lattice/bin
LATTICE_GENESIS_PROGRAMS=/var/lib/lattice/genesis-programs
LATTICE_BRIDGE_DATA=/var/lib/lattice/bridge/data
LATTICE_BUILD_SRC=/var/lib/lattice/build/src
LATTICE_LOG_DIR=/var/log/lattice
LATTICE_BACKUPS=/var/backups/lattice
LATTICE_DISK_GUARD_FLAG=/var/lib/lattice/state/disk-guard-tripped
LATTICE_RPC_INTERNAL=http://127.0.0.1:8899
LATTICE_VALIDATOR_KEYFILES=(validator-keypair.json vote-account-keypair.json stake-account-keypair.json faucet-keypair.json)
LATTICE_APP_UNITS=(lattice-gateway lattice-web lattice-monitor lattice-recorder)

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LATTICE_LOG_TAG:-lattice}" "$*" >&2; }
warn() { log "WARNING: $*"; }
die() { log "ERROR: $*"; exit 1; }

require_root() {
  [[ "${EUID}" -eq 0 ]] || die "run as root (sudo)"
}

# Serialise mutating scripts (bootstrap, release, reset, backup) on one lock.
take_lock() {
  local name="${1:-lattice}"
  exec 9>"/run/lock/${name}.lock"
  flock -n 9 || die "another ${name} operation is running (lock /run/lock/${name}.lock)"
}

env_get() {
  local key="$1" file="${2:-${LATTICE_ENV_FILE}}"
  [[ -f "${file}" ]] || return 0
  awk -F= -v k="${key}" '$1 == k { sub(/^[^=]*=/, ""); v = $0 } END { if (v != "") print v }' "${file}"
}

# Values must be plain tokens: the env file is read by bash and by systemd.
env_set() {
  local key="$1" value="$2" file="${3:-${LATTICE_ENV_FILE}}" tmp
  [[ "${value}" =~ ^[A-Za-z0-9_.,:/?=@%+~-]*$ ]] || die "refusing unsafe value for ${key}: ${value}"
  tmp="$(mktemp "${file}.XXXXXX")"
  awk -F= -v k="${key}" -v v="${value}" '
    $1 == k { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "${file}" >"${tmp}"
  chown root:"${LATTICE_USER}" "${tmp}"
  chmod 0640 "${tmp}"
  mv -f "${tmp}" "${file}"
}

load_env() {
  [[ -f "${LATTICE_ENV_FILE}" ]] || die "missing ${LATTICE_ENV_FILE}; run bootstrap first"
  set -a
  # shellcheck disable=SC1090
  . "${LATTICE_ENV_FILE}"
  set +a
}

# Run a command string as the lattice user with a clean, predictable environment.
as_lattice() {
  runuser -u "${LATTICE_USER}" -- env -i \
    HOME="${LATTICE_HOME}" USER="${LATTICE_USER}" LOGNAME="${LATTICE_USER}" LANG=C.UTF-8 \
    PATH="${LATTICE_HOME}/.cargo/bin:/usr/local/bin:/usr/bin:/bin" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1 CI=1 \
    bash -euo pipefail -c "$1"
}

rpc_call() {
  local method="$1" params="${2:-[]}"
  curl -fsS --max-time 5 -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" \
    "${LATTICE_RPC_INTERNAL}" | jq -er '.result'
}

wait_for_rpc() {
  local timeout="${1:-300}" waited=0
  until [[ "$(rpc_call getHealth 2>/dev/null || true)" == "ok" ]]; do
    if (( waited >= timeout )); then return 1; fi
    sleep 5
    waited=$((waited + 5))
  done
}

# solana-test-validator writes its keypairs into the ledger at genesis and only
# reads them afterwards. Move them to the keys directory (0700, files 0600) and
# leave symlinks so the validator finds them on restart.
relocate_validator_keys() {
  local name src dst archive
  install -d -m 0700 -o "${LATTICE_USER}" -g "${LATTICE_USER}" "${LATTICE_KEYS}"
  for name in "${LATTICE_VALIDATOR_KEYFILES[@]}"; do
    src="${LATTICE_LEDGER}/${name}"
    dst="${LATTICE_KEYS}/${name}"
    [[ -f "${src}" && ! -L "${src}" ]] || continue
    if [[ -f "${dst}" ]] && ! cmp -s "${src}" "${dst}"; then
      archive="${LATTICE_KEYS}/archive/$(date -u +%Y%m%dT%H%M%SZ)"
      install -d -m 0700 -o "${LATTICE_USER}" -g "${LATTICE_USER}" "${archive}"
      mv "${dst}" "${archive}/${name}"
    fi
    install -m 0600 -o "${LATTICE_USER}" -g "${LATTICE_USER}" "${src}" "${dst}"
    rm -f "${src}"
    ln -s "${dst}" "${src}"
    chown -h "${LATTICE_USER}:${LATTICE_USER}" "${src}"
    log "validator key ${name} moved to ${dst} (mode 600)"
  done
}

record_genesis() {
  local genesis
  genesis="$(rpc_call getGenesisHash)" || die "validator did not return a genesis hash"
  [[ "${genesis}" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || die "unexpected genesis hash: ${genesis}"
  env_set NEXT_PUBLIC_NATIVE_GENESIS_HASH "${genesis}"
  install -d -m 0755 "${LATTICE_STATE}"
  jq -n --arg genesis "${genesis}" --arg at "$(date -u +%FT%TZ)" \
    '{environment: "testnet", genesisHash: $genesis, recordedAt: $at}' >"${LATTICE_STATE}/genesis.json"
  printf '%s\n' "${genesis}"
}

# Public URLs follow from LATTICE_DOMAIN / LATTICE_PUBLIC_IP / TLS state.
derive_public_urls() {
  local domain ip tls
  domain="$(env_get LATTICE_DOMAIN)"
  ip="$(env_get LATTICE_PUBLIC_IP)"
  tls="$(cat "${LATTICE_STATE}/ip-tls" 2>/dev/null || echo off)"
  if [[ -n "${domain}" ]]; then
    env_set LATTICE_SITE_URL "https://${domain}"
    env_set NEXT_PUBLIC_NATIVE_HTTP_RPC "https://rpc.${domain}"
    env_set NEXT_PUBLIC_NATIVE_WS_RPC "wss://ws.${domain}"
  elif [[ "${tls}" == "on" ]]; then
    env_set LATTICE_SITE_URL "https://${ip}"
    env_set NEXT_PUBLIC_NATIVE_HTTP_RPC "https://${ip}/rpc"
    env_set NEXT_PUBLIC_NATIVE_WS_RPC "wss://${ip}/ws"
  else
    env_set LATTICE_SITE_URL "http://${ip}"
    env_set NEXT_PUBLIC_NATIVE_HTTP_RPC "http://${ip}/rpc"
    env_set NEXT_PUBLIC_NATIVE_WS_RPC "ws://${ip}/ws"
  fi
  env_set NEXT_PUBLIC_LATTICE_ENVIRONMENT testnet
}

# Alerts go to the journal (priority-tagged) and optionally to a webhook
# (Slack/Discord/ntfy-compatible JSON body {"text": ...}).
alert() {
  local priority="$1" message="$2" webhook
  logger -t lattice-alert -p "user.${priority}" -- "${message}"
  log "ALERT(${priority}): ${message}"
  webhook="$(env_get ALERT_WEBHOOK_URL)"
  if [[ -n "${webhook}" ]]; then
    curl -fsS --max-time 10 -H 'content-type: application/json' \
      -d "$(jq -n --arg text "[lattice $(hostname)] ${message}" '{text: $text, content: $text}')" \
      "${webhook}" >/dev/null || warn "alert webhook delivery failed"
  fi
}

# Emit an alert only when the level changes, or every $3 seconds while it persists.
alert_on_change() {
  local key="$1" level="$2" repeat="${3:-21600}" message="$4" priority="${5:-warning}"
  local file="${LATTICE_STATE}/alert-${key}" previous="" last=0 now
  now="$(date +%s)"
  if [[ -f "${file}" ]]; then read -r previous last <"${file}" || true; fi
  if [[ "${level}" != "${previous}" ]] || { [[ "${level}" != "ok" ]] && (( now - ${last:-0} >= repeat )); }; then
    if [[ "${level}" == "ok" && -n "${previous}" && "${previous}" != "ok" ]]; then
      alert notice "RECOVERED ${key}: ${message}"
    elif [[ "${level}" != "ok" ]]; then
      alert "${priority}" "${key} ${level}: ${message}"
    fi
    printf '%s %s\n' "${level}" "${now}" >"${file}"
  fi
}
