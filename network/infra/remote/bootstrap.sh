#!/usr/bin/env bash
# Idempotent server bootstrap for the Lattice public testnet (Ubuntu 26.04 LTS,
# also 24.04; x86_64).
# Normally started by infra/deploy.sh from the uploaded repository copy:
#
#   sudo bash <upload>/infra/remote/bootstrap.sh --public-ip <ip> [options]
#
# Options:
#   --public-ip <ipv4>       Elastic IP (stored as LATTICE_PUBLIC_IP).
#   --domain <domain>        Switch to domain mode (stored as LATTICE_DOMAIN).
#   --clear-domain           Return to IP mode.
#   --force-domain           Skip the DNS pre-check for domain mode.
#   --ip-tls auto|off        IP-mode TLS policy (stored as LATTICE_IP_TLS).
#   --skip-fork-build        Do not start the background Lattice fork build.
#   --skip-os                Skip apt/hardening phases (faster app-only redeploy).
#
# Every phase converges to the same state when re-run.
set -euo pipefail

UPLOAD="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
INFRA="${UPLOAD}/infra"
# shellcheck source=SCRIPTDIR/lib/common.sh
. "${INFRA}/remote/lib/common.sh"
# shellcheck disable=SC2034 # read by log() in common.sh
LATTICE_LOG_TAG=lattice-bootstrap

NODE_VERSION=22.23.3
NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
PNPM_VERSION=10.19.0
CADDY_KEY_FINGERPRINT=65760C51EDEA2017CEA2CA15155B6D79CA56EA34
CADDY_MIN_IP_CERT_VERSION=2.10.1
AGAVE_INSTALL_DIR="${LATTICE_HOME}/.local/share/solana/install"

APT_PACKAGES=(
  ca-certificates curl gnupg rsync jq git xz-utils zstd acl cron logrotate
  ufw fail2ban python3-systemd unattended-upgrades nftables
  build-essential pkg-config libssl-dev libudev-dev zlib1g-dev
  llvm clang libclang-dev cmake make protobuf-compiler libprotobuf-dev bzip2 python3
  # Distribution default major version: 18 on Ubuntu 26.04, 16 on 24.04.
  postgresql postgresql-client
)

public_ip=""
domain=""
domain_set=0
force_domain=0
ip_tls=""
skip_fork_build=0
skip_os=0
while (($#)); do
  case "$1" in
    --public-ip) public_ip="$2"; shift 2 ;;
    --domain) domain="$2"; domain_set=1; shift 2 ;;
    --clear-domain) domain=""; domain_set=1; shift ;;
    --force-domain) force_domain=1; shift ;;
    --ip-tls) ip_tls="$2"; shift 2 ;;
    --skip-fork-build) skip_fork_build=1; shift ;;
    --skip-os) skip_os=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
take_lock lattice-bootstrap
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0750 "${LATTICE_LOG_DIR}"
BOOT_LOG="${LATTICE_LOG_DIR}/bootstrap-${RUN_ID}.log"
exec > >(tee -a "${BOOT_LOG}") 2>&1
export DEBIAN_FRONTEND=noninteractive
cd /

phase() { log "==== $* ===="; }

# ---------------------------------------------------------------------------
setup_os() {
  phase "OS packages and hardening"
  if command -v cloud-init >/dev/null; then cloud-init status --wait >/dev/null 2>&1 || true; fi
  apt-get update -q
  if [[ ! -f "${LATTICE_STATE}/os-upgraded" ]]; then
    apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade
  fi
  apt-get install -y -q --no-install-recommends "${APT_PACKAGES[@]}"
  timedatectl set-timezone Etc/UTC || true

  install -m 0644 "${INFRA}/config/apt-52-lattice-unattended-upgrades" /etc/apt/apt.conf.d/52lattice-unattended-upgrades
  systemctl enable --now unattended-upgrades

  # Firewall: exactly 22, 80, 443 inbound (the EC2 security group narrows 22).
  local desired current
  desired=$'ufw allow 22/tcp\nufw allow 80/tcp\nufw allow 443/tcp'
  current="$(ufw show added 2>/dev/null | grep '^ufw ' || true)"
  if [[ "${current}" != "${desired}" ]]; then
    log "resetting ufw rules to the allowlist"
    ufw --force reset >/dev/null
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow 22/tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
  fi
  ufw logging low
  ufw --force enable

  install -m 0644 "${INFRA}/config/fail2ban-lattice.local" /etc/fail2ban/jail.d/lattice.local
  systemctl enable fail2ban
  systemctl restart fail2ban

  # Sorted before 60-cloudimg-settings.conf: sshd uses the first value it reads.
  install -m 0644 "${INFRA}/config/sshd-60-lattice.conf" /etc/ssh/sshd_config.d/10-lattice.conf
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  else
    rm -f /etc/ssh/sshd_config.d/10-lattice.conf
    warn "sshd rejected the hardening drop-in; removed it"
  fi

  install -m 0644 "${INFRA}/config/sysctl-21-agave-validator.conf" /etc/sysctl.d/21-agave-validator.conf
  install -m 0644 "${INFRA}/config/sysctl-60-lattice-host.conf" /etc/sysctl.d/60-lattice-host.conf
  install -m 0644 "${INFRA}/config/limits-90-solana-nofiles.conf" /etc/security/limits.d/90-solana-nofiles.conf
  sysctl --system >/dev/null

  install -d -m 0755 /etc/systemd/journald.conf.d
  install -m 0644 "${INFRA}/config/journald-lattice.conf" /etc/systemd/journald.conf.d/lattice.conf
  systemctl restart systemd-journald

  # 32 GiB RAM: a 16 GiB swap file absorbs Agave link-time peaks without OOM.
  if [[ -z "$(swapon --noheadings --show=NAME)" ]]; then
    local mem_gb
    mem_gb="$(awk '/MemTotal/ { printf "%d", $2 / 1048576 }' /proc/meminfo)"
    if (( mem_gb < 64 )); then
      log "creating 16G swap file"
      [[ -f /swapfile ]] || fallocate -l 16G /swapfile
      chmod 0600 /swapfile
      mkswap /swapfile >/dev/null
      swapon /swapfile
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    fi
  fi

  install -d -m 0755 "${LATTICE_STATE}"
  touch "${LATTICE_STATE}/os-upgraded"
  [[ -f /var/run/reboot-required ]] && warn "kernel/library updates need a reboot (do it during a quiet window: sudo reboot)"
  return 0
}

setup_user_and_dirs() {
  phase "lattice user and directories"
  if ! id "${LATTICE_USER}" >/dev/null 2>&1; then
    useradd --system --home-dir "${LATTICE_HOME}" --create-home --shell /usr/sbin/nologin "${LATTICE_USER}"
  fi
  install -d -m 0750 -o "${LATTICE_USER}" -g "${LATTICE_USER}" "${LATTICE_HOME}"
  install -d -m 0750 -o "${LATTICE_USER}" -g "${LATTICE_USER}" "${LATTICE_LEDGER}"
  install -d -m 0700 -o "${LATTICE_USER}" -g "${LATTICE_USER}" "${LATTICE_KEYS}" "${LATTICE_KEYS}/bridge"
  install -d -m 0755 "${LATTICE_STATE}" "${LATTICE_BIN_DIR}" "${LATTICE_GENESIS_PROGRAMS}"
  install -d -m 0750 -o "${LATTICE_USER}" -g "${LATTICE_USER}" "${LATTICE_HOME}/bridge" "${LATTICE_BRIDGE_DATA}"
  install -d -m 0755 -o "${LATTICE_USER}" -g "${LATTICE_USER}" "${LATTICE_HOME}/build" "${LATTICE_BUILD_SRC}"
  install -d -m 0755 /opt/lattice
  install -d -m 0755 -o "${LATTICE_USER}" -g "${LATTICE_USER}" "${LATTICE_RELEASES}"
  install -d -m 0750 -o root -g "${LATTICE_USER}" "${LATTICE_LOG_DIR}"
  install -d -m 0700 "${LATTICE_BACKUPS}" "${LATTICE_BACKUPS}/pg" "${LATTICE_BACKUPS}/ledger"
}

imds_public_ip() {
  local token
  token="$(curl -fsS --max-time 2 -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null)" || return 0
  curl -fsS --max-time 2 -H "X-aws-ec2-metadata-token: ${token}" \
    http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true
}

setup_env() {
  phase "configuration (${LATTICE_ENV_FILE})"
  install -d -m 0750 -o root -g "${LATTICE_USER}" "${LATTICE_ETC}"
  local example="${INFRA}/env/testnet.env.example" ip key line
  ip="${public_ip:-$(env_get LATTICE_PUBLIC_IP)}"
  [[ "${ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "--public-ip <ipv4> is required on the first run"
  if [[ ! -f "${LATTICE_ENV_FILE}" ]]; then
    sed "s/__PUBLIC_IP__/${ip}/g" "${example}" >"${LATTICE_ENV_FILE}"
    chown root:"${LATTICE_USER}" "${LATTICE_ENV_FILE}"
    chmod 0640 "${LATTICE_ENV_FILE}"
    log "created ${LATTICE_ENV_FILE} from testnet.env.example"
  else
    while IFS= read -r line; do
      [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)= ]] || continue
      key="${BASH_REMATCH[1]}"
      if ! grep -q "^${key}=" "${LATTICE_ENV_FILE}"; then
        printf '%s\n' "${line//__PUBLIC_IP__/${ip}}" >>"${LATTICE_ENV_FILE}"
        log "added new setting ${key} from example"
      fi
    done <"${example}"
  fi
  install -m 0644 "${INFRA}/env/internal.env" "${LATTICE_ETC}/internal.env"

  env_set LATTICE_PUBLIC_IP "${ip}"
  (( domain_set )) && env_set LATTICE_DOMAIN "${domain}"
  if [[ -n "${ip_tls}" ]]; then
    [[ "${ip_tls}" =~ ^(auto|off)$ ]] || die "--ip-tls must be auto or off"
    env_set LATTICE_IP_TLS "${ip_tls}"
  fi
  [[ "$(env_get LATTICE_ENVIRONMENT)" == "testnet" ]] || die "LATTICE_ENVIRONMENT must be testnet"

  local imds
  imds="$(imds_public_ip)"
  if [[ -n "${imds}" && "${imds}" != "${ip}" ]]; then
    warn "instance metadata reports public IPv4 ${imds}, configured ${ip}; is the Elastic IP associated?"
  fi
}

install_node() {
  phase "Node.js ${NODE_VERSION} (pinned) and pnpm ${PNPM_VERSION} via corepack"
  local dir="/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64"
  if [[ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "v${NODE_VERSION}" ]]; then
    local tarball="/tmp/node-v${NODE_VERSION}-linux-x64.tar.xz"
    curl -fsSL --retry 3 -o "${tarball}" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
    echo "${NODE_SHA256}  ${tarball}" | sha256sum -c -
    install -d -m 0755 /usr/local/lib/nodejs
    rm -rf "${dir}"
    tar -xJf "${tarball}" -C /usr/local/lib/nodejs
    rm -f "${tarball}"
    ln -sfn "${dir}" /usr/local/lib/nodejs/current
    local tool
    for tool in node npm npx corepack; do
      ln -sfn "/usr/local/lib/nodejs/current/bin/${tool}" "/usr/local/bin/${tool}"
    done
  fi
  /usr/local/bin/corepack enable --install-directory /usr/local/bin pnpm
  as_lattice "corepack install -g pnpm@${PNPM_VERSION} >/dev/null && pnpm --version" | grep -qx "${PNPM_VERSION}" \
    || die "pnpm ${PNPM_VERSION} is not active for the lattice user"
  log "node $(/usr/local/bin/node --version), pnpm ${PNPM_VERSION}"
}

install_rust() {
  phase "Rust toolchain for chain/agave"
  local toolchain
  toolchain="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "${UPLOAD}/chain/agave/rust-toolchain.toml")"
  [[ -n "${toolchain}" ]] || die "cannot read channel from chain/agave/rust-toolchain.toml"
  as_lattice "
    if [[ ! -x \"\$HOME/.cargo/bin/rustup\" ]]; then
      tmp=\$(mktemp -d)
      base=https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu
      curl -fsSL --retry 3 -o \"\$tmp/rustup-init\" \"\$base/rustup-init\"
      expected=\$(curl -fsSL --retry 3 \"\$base/rustup-init.sha256\" | cut -d' ' -f1)
      echo \"\$expected  \$tmp/rustup-init\" | sha256sum -c -
      chmod +x \"\$tmp/rustup-init\"
      \"\$tmp/rustup-init\" -y --no-modify-path --profile minimal --default-toolchain none
      rm -rf \"\$tmp\"
    fi
    rustup toolchain install '${toolchain}' --profile minimal --component rustfmt
    rustup default '${toolchain}'
    [[ -f \"\$HOME/.cargo/env\" ]] || echo 'export PATH=\"\$HOME/.cargo/bin:\$PATH\"' >\"\$HOME/.cargo/env\"
    rustc --version
  "
}

setup_postgres() {
  phase "PostgreSQL (distribution default)"
  systemctl enable --now postgresql
  local pg=(runuser -u postgres --)
  if ! "${pg[@]}" psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${LATTICE_USER}'" | grep -qx 1; then
    "${pg[@]}" createuser --no-superuser --no-createdb --no-createrole "${LATTICE_USER}"
  fi
  if ! "${pg[@]}" psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'lattice'" | grep -qx 1; then
    "${pg[@]}" createdb --owner "${LATTICE_USER}" lattice
  fi
  # Peer authentication over the Unix socket only; no password exists to leak.
  as_lattice "psql -d lattice -h /var/run/postgresql -tAc 'SELECT current_user'" | grep -qx "${LATTICE_USER}"
}

version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

install_caddy() {
  phase "Caddy (official stable apt repository)"
  local keyring=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
  if [[ ! -f "${keyring}" ]]; then
    local key fpr
    key="$(mktemp)"
    curl -fsSL --retry 3 -o "${key}" https://dl.cloudsmith.io/public/caddy/stable/gpg.key
    fpr="$(GNUPGHOME="$(mktemp -d)" gpg --show-keys --with-colons "${key}" | awk -F: '/^fpr/ { print $10; exit }')"
    [[ "${fpr}" == "${CADDY_KEY_FINGERPRINT}" ]] || die "Caddy signing key fingerprint mismatch: ${fpr}"
    gpg --dearmor <"${key}" >"${keyring}"
    chmod 0644 "${keyring}"
    rm -f "${key}"
  fi
  echo "deb [signed-by=${keyring}] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    >/etc/apt/sources.list.d/caddy-stable.list
  if ! command -v caddy >/dev/null; then
    apt-get update -q
    apt-get install -y -q caddy
  fi
  install -d -m 0755 /etc/systemd/system/caddy.service.d
  install -m 0644 "${INFRA}/systemd/caddy-lattice.conf" /etc/systemd/system/caddy.service.d/lattice.conf
  systemctl daemon-reload
  systemctl enable --now caddy
  log "$(caddy version)"
}

install_infra() {
  phase "Lattice scripts, gateway, systemd units, cron"
  install -d -m 0755 "${LATTICE_LIB}" "${LATTICE_LIB}/bin"
  install -m 0644 "${INFRA}/remote/lib/common.sh" "${LATTICE_LIB}/common.sh"
  local script name
  for script in "${INFRA}"/remote/bin/*; do
    name="$(basename "${script}")"
    install -m 0755 "${script}" "${LATTICE_LIB}/bin/${name}"
    [[ "${name}" == "lattice-validator-start" ]] || ln -sfn "${LATTICE_LIB}/bin/${name}" "/usr/local/sbin/${name}"
  done
  install -m 0644 "${INFRA}/gateway/rpc-gateway.mjs" "${LATTICE_LIB}/rpc-gateway.mjs"
  install -m 0644 "${INFRA}/config/lattice-edge.nft" "${LATTICE_ETC}/lattice-edge.nft"
  install -m 0644 "${INFRA}/config/cron-lattice" /etc/cron.d/lattice
  local unit
  for unit in "${INFRA}"/systemd/*.service; do
    install -m 0644 "${unit}" "/etc/systemd/system/$(basename "${unit}")"
  done
  systemctl daemon-reload
  systemctl enable lattice-edge-limits lattice-validator lattice-gateway lattice-web lattice-monitor lattice-recorder
  systemctl restart lattice-edge-limits
  systemctl restart lattice-gateway

  local so
  for so in "${UPLOAD}"/chain/target/deploy/*.so; do
    [[ -f "${so}" ]] && install -m 0644 "${so}" "${LATTICE_GENESIS_PROGRAMS}/$(basename "${so}")"
  done
  return 0
}

install_validator_binary() {
  local artifact="$1" sha target
  [[ -x "${artifact}" ]] || die "missing validator artifact ${artifact}"
  sha="$(sha256sum "${artifact}" | cut -c1-16)"
  target="${LATTICE_BIN_DIR}/solana-test-validator-${sha}"
  [[ -x "${target}" ]] || install -m 0755 "${artifact}" "${target}"
  if [[ "$(readlink "${LATTICE_BIN_DIR}/solana-test-validator" 2>/dev/null || true)" != "${target}" ]]; then
    ln -sfn "${target}" "${LATTICE_BIN_DIR}/solana-test-validator.new"
    mv -Tf "${LATTICE_BIN_DIR}/solana-test-validator.new" "${LATTICE_BIN_DIR}/solana-test-validator"
    VALIDATOR_CHANGED=1
    log "installed validator binary ${target}: $("${target}" --version)"
  fi
  # Keep the active binary and the two newest others (rollback targets).
  find "${LATTICE_BIN_DIR}" -maxdepth 1 -name 'solana-test-validator-*' -printf '%T@ %p\n' | sort -rn | awk 'NR > 3 { print $2 }' |
    while read -r old; do [[ "${old}" == "${target}" ]] || rm -f "${old}"; done
}

# Live validator: the unmodified, pinned Agave release from the official Anza
# installer. Binaries are copied root-owned into /var/lib/lattice/bin.
install_agave_release() {
  local release
  release="$(env_get LATTICE_AGAVE_RELEASE)"
  release="${release:-v4.3.0}"
  [[ "${release}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid LATTICE_AGAVE_RELEASE ${release}"
  phase "Agave ${release} release binaries (Anza installer)"
  local want="${release#v}" bin="${AGAVE_INSTALL_DIR}/releases/${release#v}/solana-release/bin"
  if ! "${bin}/solana-test-validator" --version 2>/dev/null | grep -q " ${want} "; then
    as_lattice "sh -c \"\$(curl -sSfL https://release.anza.xyz/${release}/install)\""
  fi
  [[ -x "${bin}/solana-test-validator" ]] || bin="${AGAVE_INSTALL_DIR}/active_release/bin"
  "${bin}/solana-test-validator" --version | grep -q " ${want} " || die "installed solana-test-validator is not ${want}"
  install_validator_binary "${bin}/solana-test-validator"
  local tool
  for tool in solana solana-keygen; do
    [[ -x "${bin}/${tool}" ]] && install -m 0755 "${bin}/${tool}" "/usr/local/bin/${tool}"
  done
  return 0
}

# Lattice fork (chain/agave + chain/patches): built in the background at low
# CPU/IO priority so the live validator is not starved. Never installed into
# the live service by this script.
start_fork_build() {
  phase "background Lattice fork build"
  if systemctl is-active --quiet lattice-fork-build; then
    log "fork build already running (journalctl -u lattice-fork-build)"
    return 0
  fi
  systemctl reset-failed lattice-fork-build 2>/dev/null || true
  rsync -a --delete --chown="${LATTICE_USER}:${LATTICE_USER}" \
    --exclude=/chain/agave/target/ --exclude=/chain/evidence/lattice-build-*/ \
    --exclude=node_modules/ --exclude=.next/ \
    "${UPLOAD}/" "${LATTICE_BUILD_SRC}/"
  local script=chain/scripts/build-lattice-validator.sh args="--no-apt --skip-tests"
  if [[ ! -f "${LATTICE_BUILD_SRC}/${script}" ]]; then
    script=chain/scripts/pq-build.sh
    args=""
  fi
  local build_log="${LATTICE_HOME}/build/fork-build-${RUN_ID}.log"
  ln -sfn "${build_log}" "${LATTICE_LOG_DIR}/fork-build.log"
  systemd-run --unit=lattice-fork-build --description="Lattice Agave fork build (${RUN_ID})" \
    --property=User="${LATTICE_USER}" --property=Group="${LATTICE_USER}" \
    --property=Nice=19 --property=CPUWeight=10 --property=IOWeight=10 \
    --property=MemoryHigh=16G --property=MemoryMax=22G \
    --property=WorkingDirectory="${LATTICE_BUILD_SRC}" \
    --setenv=HOME="${LATTICE_HOME}" --setenv=USER="${LATTICE_USER}" \
    --setenv=PATH="${LATTICE_HOME}/.cargo/bin:/usr/local/bin:/usr/bin:/bin" \
    --setenv=LATTICE_MIN_FREE_GB=60 --setenv=PQ_MIN_FREE_GB=60 \
    /bin/bash -c "exec >>'${build_log}' 2>&1; echo \"fork build ${RUN_ID} started \$(date -u)\"; bash ${script} ${args}; status=\$?; echo \"fork build exit \${status} at \$(date -u)\"; exit \${status}"
  log "fork build started: ${script} ${args}; log ${build_log} (also ${LATTICE_LOG_DIR}/fork-build.log)"
}

# Operator-attested bridge demo state on this testnet (isolated SPL test mints,
# unbacked). Created once so lattice-recorder has something to reconcile.
setup_bridge_demo() {
  phase "bridge demo state for lattice-recorder"
  if [[ -f "${LATTICE_BRIDGE_DATA}/local-state.json" ]]; then
    log "bridge demo state exists"
  elif ! as_lattice "
      cd '${LATTICE_CURRENT}/services/bridge'
      set -a; . '${LATTICE_ENV_FILE}'; set +a
      node --import tsx src/setup-local.ts
    " >"${LATTICE_LOG_DIR}/bridge-setup-${RUN_ID}.log" 2>&1; then
    tail -n 20 "${LATTICE_LOG_DIR}/bridge-setup-${RUN_ID}.log" >&2 || true
    warn "bridge demo setup failed; lattice-recorder stays inactive"
    return 0
  fi
  systemctl restart lattice-recorder || true
}

start_validator() {
  phase "validator service"
  [[ -f "${LATTICE_DISK_GUARD_FLAG}" ]] && die "disk guard tripped ($(cat "${LATTICE_DISK_GUARD_FLAG}")); free space, then: sudo rm ${LATTICE_DISK_GUARD_FLAG}"
  [[ -x "${LATTICE_BIN_DIR}/solana-test-validator" ]] || die "no validator binary installed"
  local fresh=0
  [[ -e "${LATTICE_LEDGER}/genesis.bin" ]] || fresh=1
  if ! systemctl is-active --quiet lattice-validator; then
    systemctl reset-failed lattice-validator 2>/dev/null || true
    systemctl start lattice-validator
  elif (( VALIDATOR_CHANGED )); then
    log "restarting validator on the new binary (ledger preserved)"
    systemctl restart lattice-validator
  fi
  (( fresh )) && log "no ledger yet: the validator is creating the testnet genesis"
  if ! wait_for_rpc 900; then
    journalctl -u lattice-validator -n 80 --no-pager >&2 || true
    die "validator RPC did not become healthy"
  fi
  relocate_validator_keys
  local previous genesis
  previous="$(env_get NEXT_PUBLIC_NATIVE_GENESIS_HASH)"
  genesis="$(record_genesis)" || die "could not record genesis"
  if [[ -n "${previous}" && "${previous}" != "${genesis}" ]]; then
    alert crit "testnet genesis changed from ${previous} to ${genesis} without lattice-reset-testnet; website will be rebuilt for the new genesis"
  fi
  log "validator healthy; genesis ${genesis}; slot $(rpc_call getSlot)"
}

caddy_apply() {
  local file=/etc/caddy/Caddyfile new
  new="$(mktemp /etc/caddy/Caddyfile.XXXXXX)"
  "${LATTICE_LIB}/bin/lattice-render-caddy" "$@" >"${new}"
  chmod 0644 "${new}"
  runuser -u caddy -- caddy validate --config "${new}" --adapter caddyfile >/dev/null || { rm -f "${new}"; die "rendered Caddyfile is invalid"; }
  if ! cmp -s "${new}" "${file}"; then
    [[ -f "${file}" ]] && cp -p "${file}" "${file}.previous"
    mv -f "${new}" "${file}"
    systemctl reload caddy || systemctl restart caddy
  else
    rm -f "${new}"
  fi
}

tls_ready() {
  local host="$1"
  for _ in $(seq 1 "${2:-30}"); do
    if curl -sS -o /dev/null --max-time 10 --connect-to "${host}:443:127.0.0.1:443" "https://${host}/rpc/health" 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

configure_edge() {
  phase "Caddy edge configuration"
  local ip domain policy email state
  ip="$(env_get LATTICE_PUBLIC_IP)"
  domain="$(env_get LATTICE_DOMAIN)"
  policy="$(env_get LATTICE_IP_TLS)"
  email="$(env_get ACME_EMAIL)"
  state="$(cat "${LATTICE_STATE}/ip-tls" 2>/dev/null || echo off)"
  local email_args=()
  [[ -n "${email}" ]] && email_args=(--email "${email}")

  if [[ -n "${domain}" ]]; then
    local name resolved
    for name in "${domain}" "rpc.${domain}" "ws.${domain}"; do
      resolved="$(getent ahostsv4 "${name}" | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
      if [[ " ${resolved} " != *" ${ip} "* ]]; then
        (( force_domain )) || die "DNS for ${name} resolves to '${resolved}', not ${ip}. Fix the A record or pass --force-domain"
        warn "DNS for ${name} resolves to '${resolved}', not ${ip} (continuing: --force-domain)"
      fi
    done
    caddy_apply --ip "${ip}" --domain "${domain}" "${email_args[@]}"
    if tls_ready "${domain}" 36 && tls_ready "rpc.${domain}" 12 && tls_ready "ws.${domain}" 12; then
      log "domain TLS active for ${domain}, rpc.${domain}, ws.${domain}"
    else
      warn "certificates not confirmed yet; Caddy keeps retrying (journalctl -u caddy)"
    fi
    echo domain >"${LATTICE_STATE}/edge-mode"
  else
    if [[ "${policy}" == "off" ]]; then
      state=off
    elif [[ "${state}" != "on" ]]; then
      if version_ge "$(caddy version | awk '{ sub(/^v/, "", $1); print $1 }')" "${CADDY_MIN_IP_CERT_VERSION}"; then
        log "requesting a Let's Encrypt IP certificate for ${ip} (shortlived profile)"
        caddy_apply --ip "${ip}" --ip-tls attempt "${email_args[@]}"
        if tls_ready "${ip}" 30; then
          state=on
        else
          state=off
          warn "IP certificate not issued within 150 s; serving plain HTTP (journalctl -u caddy | grep -i acme)"
        fi
      else
        warn "Caddy older than ${CADDY_MIN_IP_CERT_VERSION}; IP certificates unavailable, plain HTTP"
        state=off
      fi
    fi
    caddy_apply --ip "${ip}" --ip-tls "${state}" "${email_args[@]}"
    echo "${state}" >"${LATTICE_STATE}/ip-tls"
    echo ip >"${LATTICE_STATE}/edge-mode"
    log "IP mode, TLS ${state}"
  fi
  derive_public_urls
}

# ---------------------------------------------------------------------------
VALIDATOR_CHANGED=0
log "Lattice bootstrap ${RUN_ID} from ${UPLOAD} (log ${BOOT_LOG})"
if (( skip_os )); then
  for tool in jq /usr/local/bin/node /usr/local/bin/pnpm caddy psql; do
    command -v "${tool}" >/dev/null || die "--skip-os requires a fully bootstrapped host (missing ${tool})"
  done
else
  setup_os
fi
setup_user_and_dirs
setup_env
if (( ! skip_os )); then
  install_node
  install_rust
  setup_postgres
  install_caddy
fi
install_infra
install_agave_release
start_validator
configure_edge
phase "application release"
"${LATTICE_LIB}/bin/lattice-release" "${UPLOAD}" --label "bootstrap-${RUN_ID}"
setup_bridge_demo
(( skip_fork_build )) || start_fork_build
phase "summary"
"${LATTICE_LIB}/bin/lattice-status" || true
log "bootstrap ${RUN_ID} complete"
