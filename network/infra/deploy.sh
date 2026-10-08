#!/usr/bin/env bash
# Deploy the Lattice public testnet from a workstation.
#
#   infra/deploy.sh <public-ip> <path-to-pem> [bootstrap options] [--dry-run]
#
# 1. rsyncs this repository to ubuntu@<ip>:lattice-upload/ (no node_modules,
#    .next, build targets, ledgers, keys, .env files or local state);
# 2. runs infra/remote/bootstrap.sh as a transient systemd unit, so a dropped
#    SSH session does not kill a long build, and streams its log.
# Bootstrap options are passed through, e.g. --domain example.com,
# --clear-domain, --ip-tls off, --skip-os, --skip-fork-build.
# --dry-run only lists what rsync would upload.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 64; }
(( $# >= 2 )) || usage
IP="$1"
PEM="$2"
shift 2
[[ "${IP}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "first argument must be an IPv4 address" >&2; exit 64; }
[[ -f "${PEM}" ]] || { echo "key file not found: ${PEM}" >&2; exit 64; }

dry_run=0
passthrough=()
for arg in "$@"; do
  if [[ "${arg}" == "--dry-run" ]]; then dry_run=1; else passthrough+=("${arg}"); fi
done

mode="$(stat -f '%Lp' "${PEM}" 2>/dev/null || stat -c '%a' "${PEM}")"
if [[ "${mode}" != "400" && "${mode}" != "600" ]]; then
  echo "tightening permissions on ${PEM} (${mode} -> 600); ssh refuses readable keys" >&2
  chmod 600 "${PEM}"
fi

SSH_OPTS=(
  -i "${PEM}"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=10
  -o ConnectTimeout=15
  -o ControlMaster=auto
  -o "ControlPath=${HOME}/.ssh/lattice-%r@%h-%p"
  -o ControlPersist=15m
)
REMOTE="ubuntu@${IP}"
# shellcheck disable=SC2029 # remote command strings are built and quoted locally
ssh_remote() { ssh "${SSH_OPTS[@]}" "${REMOTE}" "$@"; }
rsync_ssh="ssh$(printf ' %q' "${SSH_OPTS[@]}")"

# Anchored where a bare name would also match Agave sources (chain/agave/ledger
# is a crate; storage-bigtable ships a .pem CA bundle).
RSYNC_FILTER=(
  --include=/chain/target/
  --include=/chain/target/deploy/
  --include=/chain/target/deploy/*.so
  --exclude=/chain/target/**
  --exclude=/.git/
  --exclude=node_modules/
  --exclude=.next/
  --exclude=target/
  --exclude=/chain/ledger/
  --exclude=test-ledger/
  --exclude=/keys/
  --exclude=/services/bridge/data/
  --exclude=/chain/evidence/lattice-build-*/
  --exclude=.env
  --exclude=.env.*
  --exclude=/infra/env/*.env
  --exclude=*keypair*.json
  --exclude=/*.pem
  --exclude=*.log
  --exclude=*.tsbuildinfo
  --exclude=dist/
  --exclude=/coverage/
  --exclude=.DS_Store
)

if (( dry_run )); then
  rsync -a --dry-run -v "${RSYNC_FILTER[@]}" "${ROOT}/" "/tmp/lattice-deploy-dry-run/"
  exit 0
fi

echo "== waiting for SSH on ${IP}"
for attempt in $(seq 1 30); do
  ssh_remote true 2>/dev/null && break
  (( attempt == 30 )) && { echo "SSH to ${REMOTE} failed" >&2; exit 1; }
  sleep 10
done

echo "== uploading repository"
rsync -az --delete "${RSYNC_FILTER[@]}" -e "${rsync_ssh}" "${ROOT}/" "${REMOTE}:lattice-upload/"

unit="lattice-bootstrap-$(date -u +%Y%m%d%H%M%S)"
remote_args="$(printf ' %q' --public-ip "${IP}" ${passthrough[@]+"${passthrough[@]}"})"
echo "== starting bootstrap as ${unit} (re-attach: ssh ${REMOTE} sudo journalctl -fu ${unit})"
ssh_remote "sudo systemd-run --unit=${unit} --description='Lattice bootstrap' \
  --property=TimeoutStartSec=infinity --setenv=HOME=/root \
  /bin/bash /home/ubuntu/lattice-upload/infra/remote/bootstrap.sh${remote_args}"

# Stream the unit's journal until it finishes, then report its exit status.
ssh_remote "sudo journalctl -fu ${unit} -o cat -n all & jpid=\$!
  while true; do
    state=\$(systemctl show -p ActiveState --value ${unit} 2>/dev/null)
    case \"\${state}\" in active|activating|deactivating) sleep 5 ;; *) break ;; esac
  done
  sleep 2; kill \${jpid} 2>/dev/null
  result=\$(systemctl show -p Result --value ${unit}); status=\$(systemctl show -p ExecMainStatus --value ${unit})
  sudo systemctl reset-failed ${unit} 2>/dev/null || true
  echo \"== bootstrap result: \${result} (exit \${status})\"
  [ \"\${result}\" = success ]"
