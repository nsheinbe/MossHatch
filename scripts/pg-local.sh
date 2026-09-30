#!/bin/sh
# Local PostgreSQL 16 for tests (no Docker needed). Usage: scripts/pg-local.sh start|stop|status
# Data lives in $MH_PGDATA (default /tmp/mosshatch-pg); the server listens on 127.0.0.1:54329 as user "postgres" with trust auth.
set -e
BIN=/usr/lib/postgresql/16/bin
DATA=${MH_PGDATA:-/tmp/mosshatch-pg}
PORT=${MH_PGPORT:-54329}
RUNAS=mhpg
id "$RUNAS" >/dev/null 2>&1 || useradd -m "$RUNAS"
case "$1" in
  start)
    if [ ! -d "$DATA/base" ]; then
      mkdir -p "$DATA"; chown "$RUNAS" "$DATA"
      su "$RUNAS" -c "$BIN/initdb -D $DATA -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null"
    fi
    su "$RUNAS" -c "$BIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c max_connections=200' -l $DATA/log -w start" >/dev/null
    echo "postgres://postgres@127.0.0.1:$PORT/postgres" ;;
  stop) su "$RUNAS" -c "$BIN/pg_ctl -D $DATA -m fast stop" ;;
  status) su "$RUNAS" -c "$BIN/pg_ctl -D $DATA status" ;;
esac
