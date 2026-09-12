#!/usr/bin/env bash
#
# Starts or stops a disposable local Postgres for integration tests.
#
# It never touches the hosted Supabase project: the cluster lives under
# .tmp/ in this repository and is safe to delete at any time.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="${TEST_PGDATA:-$ROOT/.tmp/testdb}"
PGPORT="${TEST_PGPORT:-5433}"
PGSOCKET="${TEST_PGSOCKET:-/tmp}"
DBNAME="${TEST_PGDATABASE:-trip_test}"

# Finds a PostgreSQL installation that actually runs. A broken install can have
# pg_ctl on PATH while the server binary fails to load its libraries, so each
# candidate is checked by running it, not by testing for the file.
find_bin() {
  local candidates=()
  if [ -n "${TEST_PGBIN:-}" ]; then
    candidates+=("$TEST_PGBIN")
  fi
  if command -v pg_ctl >/dev/null 2>&1; then
    candidates+=("$(dirname "$(command -v pg_ctl)")")
  fi
  for dir in /Library/PostgreSQL/*/bin /opt/homebrew/opt/postgresql@*/bin /usr/lib/postgresql/*/bin; do
    candidates+=("$dir")
  done

  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate/pg_ctl" ] && "$candidate/postgres" -V >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done

  echo "Could not find a working PostgreSQL installation." >&2
  echo "Install PostgreSQL 15 or newer, or set TEST_PGBIN to its bin directory." >&2
  exit 1
}

BIN="$(find_bin)"

case "${1:-start}" in
  start)
    if [ ! -d "$PGDATA" ]; then
      mkdir -p "$(dirname "$PGDATA")"
      "$BIN/initdb" -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
    fi
    if ! "$BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
      "$BIN/pg_ctl" -D "$PGDATA" \
        -o "-p $PGPORT -c listen_addresses=127.0.0.1 -k $PGSOCKET" \
        -l "$PGDATA/server.log" start >/dev/null
    fi
    "$BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres \
      -tAc "select 1 from pg_database where datname='$DBNAME'" | grep -q 1 \
      || "$BIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U postgres "$DBNAME"
    echo "TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:$PGPORT/$DBNAME"
    ;;
  stop)
    "$BIN/pg_ctl" -D "$PGDATA" stop >/dev/null 2>&1 || true
    echo "stopped"
    ;;
  destroy)
    "$BIN/pg_ctl" -D "$PGDATA" stop >/dev/null 2>&1 || true
    rm -rf "$PGDATA"
    echo "removed $PGDATA"
    ;;
  *)
    echo "usage: scripts/test-db.sh [start|stop|destroy]" >&2
    exit 1
    ;;
esac
