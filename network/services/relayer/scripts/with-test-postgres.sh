#!/usr/bin/env bash
# Runs a command against a throwaway PostgreSQL cluster in a temp directory.
# The cluster is stopped and deleted on exit. Usage: with-test-postgres.sh <cmd...>
set -euo pipefail

if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  exec "$@"
fi

PORT="${TEST_PG_PORT:-55432}"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/lattice-relayer-pg.XXXXXX")"
cleanup() {
  pg_ctl -D "$DIR/data" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

initdb -D "$DIR/data" -U lattice --auth=trust -E UTF8 --no-locale >/dev/null
pg_ctl -D "$DIR/data" -l "$DIR/log" -w \
  -o "-p $PORT -k $DIR -c listen_addresses='' -c fsync=on -c shared_buffers=16MB" start >/dev/null
createdb -h "$DIR" -p "$PORT" -U lattice relayer_test

export TEST_DATABASE_URL="postgresql://lattice@/relayer_test?host=$DIR&port=$PORT"
"$@"
