# Lattice public testnet runbook

Single EC2 host (Ubuntu 26.04 LTS, x86_64) running a **testnet**: unbacked
faucet units, no real funds, no mainnet keys. Current deployment facts
(IP, genesis, versions) are in [`DEPLOYED.md`](DEPLOYED.md).

```
Internet ─► ufw (22/80/443) ─► nftables per-IP limits ─► Caddy :80/:443
   /            ─► lattice-web       127.0.0.1:3000  (Next.js)
   /rpc  /ws    ─► lattice-gateway   127.0.0.1:8080  ─► validator 127.0.0.1:8899 / :8900
   /api/faucet, /api/rpc, /api/bridge/* ─► lattice-gateway (strict limits) ─► lattice-web
lattice-validator  solana-test-validator; gossip/TPU on 127.0.0.1; RPC 8899, PubSub 8900 and
                   faucet 9900 listen on 0.0.0.0 (hardcoded in v4.3.0) but are loopback-only
                   (unit IP filter + nftables drop + ufw + security group)
lattice-monitor    probes 127.0.0.1:8899/8900 → PostgreSQL (rpc_observations)
lattice-recorder   bridge demo reconciliation samples
lattice-fork-build transient unit: background build of the Lattice Agave fork
```

## Layout on the server

| Path | Contents |
| --- | --- |
| `/etc/lattice/lattice.env` | All configuration (root:lattice 0640). Edit, then redeploy. |
| `/opt/lattice/releases/<id>`, `/opt/lattice/current` | Application releases; `current` is a symlink |
| `/var/lib/lattice/ledger` | Validator ledger (bounded blockstore, snapshots every 100 slots) |
| `/var/lib/lattice/keys` | Validator identity, vote, stake and faucet keypairs (dir 0700, files 0600); `bridge/` holds demo operator keys |
| `/var/lib/lattice/bin` | Validator binaries (root-owned copies, `solana-test-validator` symlink) |
| `/var/lib/lattice/build/src` | Build tree for the Lattice fork (`chain/agave/target`) |
| `/var/lib/lattice/state` | Genesis record, TLS state, alert state, disk guard flag |
| `/var/backups/lattice` | Nightly PostgreSQL dumps and ledger snapshot sets (0700) |
| `/var/log/lattice` | Bootstrap, release, and build logs; `fork-build.log` → current fork build |
| `/usr/local/sbin/lattice-*` | Operator commands (below) |

**Keys never leave the server and never enter the website.** The validator
keypairs are generated on the server at genesis and live only under
`/var/lib/lattice/keys`; the ledger directory holds symlinks to them. Nothing
under `NEXT_PUBLIC_*` is secret. `deploy.sh` never uploads `keys/`,
`*keypair*.json`, `.env*`, or ledgers.

## Deploy and update

From the repository root on the Mac:

```sh
infra/deploy.sh 18.213.75.190 ~/Downloads/HHGA.pem
```

This is idempotent: it uploads the repository to `~ubuntu/lattice-upload`,
then runs `infra/remote/bootstrap.sh` as a transient systemd unit
(`lattice-bootstrap-<timestamp>`) and streams its log. If SSH drops, the
bootstrap keeps running; re-attach with
`ssh … sudo journalctl -fu 'lattice-bootstrap-*'`.

Useful options (passed through to bootstrap):

- `--skip-os` — skip apt, hardening, and toolchain/PostgreSQL/Caddy phases
  (fast app-only update). Only for a host that completed one full bootstrap;
  bootstrap refuses it if node, pnpm, caddy, or psql are missing.
- `--skip-fork-build` — don't start the background fork build.
- `--ip-tls off` — never try an IP certificate.
- `--dry-run` — list what would be uploaded.

An update builds a **new release** (`pnpm install --frozen-lockfile`, web
build with `/etc/lattice/lattice.env`), switches `/opt/lattice/current`
atomically, restarts web, monitor, recorder, and gateway, and health-checks
`/` and `/api/network-manifest`. If the check fails, it automatically switches
back to the previous release. The validator is restarted only if its binary
changed; the ledger is always preserved.

If the tool-side SSH session can't run `deploy.sh` (e.g. it needs an
interactive approval), the manual equivalent is: the `rsync` line from
`deploy.sh`, then
`ssh … sudo systemd-run --unit=lattice-bootstrap-N /bin/bash /home/ubuntu/lattice-upload/infra/remote/bootstrap.sh --public-ip <ip>`.

## Status, restart, logs

```sh
ssh -i ~/Downloads/HHGA.pem ubuntu@18.213.75.190
sudo lattice-status                         # services, genesis, slot, URLs, disk, RAM
sudo systemctl restart lattice-web          # or lattice-validator, lattice-gateway, lattice-monitor, lattice-recorder, caddy
journalctl -u lattice-validator -f          # validator (streams via --log; never into the ledger dir)
journalctl -u lattice-gateway -f            # per-minute stats: forwarded, denied methods, rate-limited, websockets
journalctl -u caddy -f ; sudo tail -f /var/log/caddy/lattice-access.log
journalctl -t lattice-alert                 # every alert raised by the cron jobs
sudo lattice-healthcheck ; sudo lattice-disk-alarm
```

Journald is capped at 4 GB / 21 days. Caddy access logs roll at 50 MiB × 10.

## Rollback

```sh
sudo lattice-rollback                 # previous application release
sudo lattice-rollback 20261008T221500Z
sudo lattice-rollback --validator     # previous validator binary (restarts the validator)
```

Rollback refuses releases built for a different genesis (the genesis is
compiled into the site); after a reset, rebuild instead:
`sudo lattice-release /opt/lattice/current`.

## Reset the testnet (destructive, guarded)

```sh
ssh -t … sudo lattice-reset-testnet --confirm-genesis <current-genesis-hash> [--purge]
```

Refused unless `LATTICE_ENVIRONMENT=testnet`, the hash matches the live
genesis, and you type `RESET <first 8 chars>` on a terminal. It backs up
first, archives the old ledger (or deletes it with `--purge`), archives the
validator keys under `keys/archive/reset-<ts>`, clears the genesis-bound
bridge demo state, starts a fresh genesis, records it, and rebuilds the
website. Then update `DEPLOYED.md`. The bridge demo is recreated on the next
deploy (or: `sudo -u lattice bash -c 'cd /opt/lattice/current/services/bridge && set -a && . /etc/lattice/lattice.env && node --import tsx src/setup-local.ts'`).

## Rotate keys

- **SSH:** create a new EC2 key pair, append its public key to
  `~ubuntu/.ssh/authorized_keys`, test a login with it, then remove the old
  line. Password login is disabled (`/etc/ssh/sshd_config.d/10-lattice.conf`).
- **Validator identity / vote / stake / faucet:** `solana-test-validator`
  generates these at genesis and the identity is the genesis bootstrap
  leader, so in-place rotation is not possible. Rotation means a guarded
  reset (new genesis). Old keys are archived under `/var/lib/lattice/keys/archive/`.
- **Bridge demo operator keys** (`/var/lib/lattice/keys/bridge`): stop
  `lattice-recorder`, move the directory into `keys/archive/`, delete
  `/var/lib/lattice/bridge/data/local-state.json`, and redeploy (setup runs again).
- **PostgreSQL:** peer authentication over the Unix socket; no password exists.
- **ACME account / certificates:** managed by Caddy under `/var/lib/caddy`.

## Backups

Nightly at 03:17 UTC (`/etc/cron.d/lattice`, `lattice-backup`):

- `pg_dump -Fc lattice` → `/var/backups/lattice/pg/`, kept 14 days;
  `rpc_observations` rows older than 30 days are deleted.
- The newest ledger snapshot archive, `genesis.bin`/`genesis.tar.bz2`, a tar
  of `/var/lib/lattice/keys`, and bridge demo state, with SHA256SUMS →
  `/var/backups/lattice/ledger/<ts>/`, newest 3 kept. Skipped when the disk is
  above the critical threshold.

These live on the same EBS volume. For off-host copies, set
`LATTICE_BACKUP_S3_URI` (needs awscli and an instance role), take EBS
snapshots (AWS Data Lifecycle Manager), or pull them:
`rsync -a -e "ssh -i ~/Downloads/HHGA.pem" --rsync-path="sudo rsync" ubuntu@18.213.75.190:/var/backups/lattice/ ./lattice-backups/`.
Restore PostgreSQL with `sudo -u postgres pg_restore -c -d lattice <dump>`.

## Disk guard (runaway-ledger protection)

`lattice-disk-alarm` runs every 5 minutes. It warns at 75% root usage or a
60 GB ledger, goes critical at 85%, and at **92% or a 120 GB ledger** stops the
validator and writes `/var/lib/lattice/state/disk-guard-tripped`. The unit
has `ConditionPathExists=!…`, so the validator stays stopped, even across
reboots, until you free space and run:

```sh
sudo rm /var/lib/lattice/state/disk-guard-tripped && sudo systemctl start lattice-validator
```

The ledger is bounded by `--limit-blockstore-size` (the v4.3.0 name for
`--limit-ledger-size`, `LATTICE_LEDGER_LIMIT_SHREDS`, default 2,000,000
shreds), the test validator keeps 2 full snapshot archives, and logs go to
journald, not the ledger directory. Alerts go to the journal
(`journalctl -t lattice-alert`) and, if set, to `ALERT_WEBHOOK_URL`.
For alerts while the host itself is down, add a CloudWatch alarm on the
instance status check.

## Edge protection

- **Security group / ufw:** 22 (user's IP only at the SG), 80, 443. ufw
  allows exactly those; fail2ban bans repeated SSH failures (systemd backend,
  ufw action).
- **nftables** (`lattice-edge-limits`): ≤128 concurrent connections and
  ≤40 new connections/s per source IP on 80/443.
- **Caddy:** request bodies capped at 64 KB for `/rpc`, 4 KB for `/ws`, 16 KB
  for limited API routes, and 1 MB for the site; HTTP/1.1 and HTTP/2 only;
  security headers; JSON access log.
- **lattice-gateway** (`infra/gateway/rpc-gateway.mjs`, Node standard library
  only, unit-tested with `node --test infra/gateway/`): stock Caddy cannot
  read JSON-RPC bodies or rate-limit, so the gateway enforces:
  - an explicit JSON-RPC method allowlist (read methods, `sendTransaction`,
    `simulateTransaction`). `requestAirdrop` and every unlisted method are
    rejected with HTTP 403 and JSON-RPC -32601. Heavy scans
    (`getProgramAccounts`, `getLargestAccounts`, `getSupply`) are off unless
    `GATEWAY_ALLOW_HEAVY_METHODS=1`.
  - batches of at most 20 requests.
  - token buckets of 20 req/s per IP (burst 40), 400 req/s globally, and
    5 `sendTransaction`/s per IP; HTTP 429 with `Retry-After` beyond that.
  - WebSockets: ≤8 concurrent per IP, ≤512 total, 1 upgrade/s per IP
    (burst 10), client→server traffic ≤4 KiB/s (burst 64 KiB), 6 h lifetime.
  - site faucet (1 SOL of unbacked test units per request): the gateway
    allows 1 request per IP per 10 minutes and 30 per hour globally
    (`GATEWAY_FAUCET_IP_INTERVAL_SEC`, `GATEWAY_FAUCET_GLOBAL_PER_HOUR`);
    behind it the route itself limits per IP, per recipient address
    (10 minutes) and 120 per hour globally (`LATTICE_SITE_FAUCET_*`), keyed
    on the client IP the gateway passes as `X-Forwarded-For`. The
    bridge demo mutation routes return 403 unless `LATTICE_PUBLIC_BRIDGE_DEMO=1`.

  All limits are environment variables (`GATEWAY_*`, see the top of the
  gateway). A dedicated Caddy plugin (`github.com/mholt/caddy-ratelimit`,
  needs a custom `xcaddy` build) is not used, so Caddy stays on the signed
  apt package with automatic security updates.
- **Validator sockets:** Agave v4.3.0 `solana-test-validator` hardcodes the
  RPC (8899), PubSub (8900) and faucet (9900) listeners to `0.0.0.0`
  (`test-validator/src/lib.rs`); `--bind-address 127.0.0.1` only covers
  gossip/TPU/TVU. Three independent layers keep them loopback-only: the unit's
  `IPAddressDeny=any` / `IPAddressAllow=localhost` (verified: requests to the
  instance's private IP get no answer), an nftables `tcp dport {8899,8900,9900}
  drop` for non-loopback traffic in `lattice-edge-limits`, and ufw/the
  security group.

## TLS and adding a domain

**IP mode (current).** Let's Encrypt has issued IP-address certificates
generally since 15 January 2026, only under the `shortlived` profile (about 6-day
certificates, renewed automatically). Caddy ≥ 2.10.1 supports them for IPv4
(this host: Caddy v2.11.7 from the official apt repository; the first
certificate was issued in ~15 s via TLS-ALPN-01 on 443, so issuance and
renewal do not depend on port 80).
With `LATTICE_IP_TLS=auto`, bootstrap first serves HTTP and HTTPS together,
waits up to 150 s for the certificate, and switches to HTTPS only once a
verified TLS request succeeds. Otherwise it stays on plain HTTP and records
`off` in `/var/lib/lattice/state/ip-tls`. The URLs compiled into the site
follow that outcome (an HTTPS page cannot call `http://` RPC). With TLS on,
`http://<ip>/rpc` and `ws://<ip>/ws` are still served directly (same gateway
limits; WebSocket clients do not follow redirects) and every other HTTP path
redirects to HTTPS. `lattice-healthcheck` alerts if the IP
certificate gets within 48 h of expiry. To stay on plain HTTP:
`--ip-tls off`.

**Domain mode (one variable).**

1. Create DNS A records for `<domain>`, `rpc.<domain>`, and `ws.<domain>` →
   `18.213.75.190`.
2. Run `infra/deploy.sh 18.213.75.190 ~/Downloads/HHGA.pem --skip-os --domain <domain>`
   (or set `LATTICE_DOMAIN=<domain>` in `/etc/lattice/lattice.env` and redeploy).

Bootstrap refuses to switch unless all three names resolve to the IP
(`--force-domain` overrides). It renders `https://<domain>` (site),
`https://rpc.<domain>` (JSON-RPC), and `wss://ws.<domain>` (PubSub) with
automatic certificates, redirects `http://<ip>` to the domain, and rebuilds
the site with the new public URLs. `--clear-domain` returns to IP mode.

## Validator: release vs. Lattice fork

The live validator is the **unmodified Agave v4.3.0 release** from the
official Anza installer (`LATTICE_AGAVE_RELEASE`), copied root-owned into
`/var/lib/lattice/bin`. Its own genesis was created on this server.

The **Lattice fork** (`chain/agave`, branch `lattice/pq-mldsa-v1`; patches in
`chain/patches/`) builds in the background as `lattice-fork-build`
(Nice 19, low CPU/IO weight, MemoryMax 22G) via
`chain/scripts/build-lattice-validator.sh --no-apt --skip-tests`:

```sh
systemctl status lattice-fork-build
tail -f /var/log/lattice/fork-build.log
ls /var/lib/lattice/build/src/chain/agave/target/release/
cat /var/lib/lattice/build/src/chain/evidence/lattice-build-*/summary.txt
```

The script's `smoke-genesis` step fails against fork commit `2987a72ad` (and
upstream 4.3.0): `solana-genesis` now requires `--bootstrap-validator-bls-pubkey`
(Alpenglow), which `chain/scripts/lattice-genesis.sh` does not pass yet. The
binaries themselves build (`build-release` PASS); fix the genesis script before
relying on the fork's `solana-genesis`. `solana-test-validator` generates its
own genesis and is unaffected.

The live service is **not switched automatically**. Switching to the fork
changes the runtime and feature set. Do it as a guarded reset, so the fork's
features (ML-DSA syscall, `lattice-bridge` builtin) are active from genesis:

```sh
sudo install -m 0755 /var/lib/lattice/build/src/chain/agave/target/release/solana-test-validator \
  /var/lib/lattice/bin/solana-test-validator-fork-$(date +%Y%m%d)
sudo ln -sfn /var/lib/lattice/bin/solana-test-validator-fork-$(date +%Y%m%d) /var/lib/lattice/bin/solana-test-validator
# optional: LATTICE_GENESIS_BPF_PROGRAMS=FQn1rtLkx2wTqXQK4Ur96HATPdQhHeFyA5v2F1NSChBn:lattice_pq_vault.so
ssh -t … sudo lattice-reset-testnet --confirm-genesis <current-genesis>
```

`lattice-rollback --validator` returns to the release binary (on a
fork-created ledger that also needs a reset).

## Cost control

The instance (m7i.2xlarge class) and its 500 GB gp3 volume cost money while
they exist. To pause:

```sh
aws ec2 stop-instances --region us-east-1 --instance-ids <id>   # or EC2 console → Stop
```

When stopped you pay only for EBS storage and the Elastic IP (AWS bills idle
and associated public IPv4 hourly). All services are enabled and come back on
start. The ledger resumes from disk with the same genesis. Terminating the
instance destroys the ledger and keys unless you snapshot the volume first.

## Known limitations

- Single node: no decentralisation, no redundancy. An instance failure is an outage.
- The faucet issues **unbacked test units**. They can never become production units.
- PubSub messages on `/ws` are proxied byte-for-byte. Connection counts and
  client byte rates are limited, but individual subscription methods are not
  filtered (Agave PubSub has no administrative methods).
- Blockstore footprint: shreds are capped by `--limit-blockstore-size`, but
  RocksDB write-ahead logs add up to 4 GiB (Agave's `max_total_wal_size`)
  before forced flushes free them. Expect a ledger of several GB that grows
  for the first ~30 minutes, then levels off; the disk guard covers the rest.
- The host reports pending kernel/library updates after the first
  `dist-upgrade`; reboot in a quiet window (`sudo reboot`; every service is
  enabled and the ledger resumes).
