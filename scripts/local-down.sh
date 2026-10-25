#!/usr/bin/env bash
# Stop local Keycloak (and Mailpit unless --keycloak-only). Data stays in Postgres keycloak_local.
set -euo pipefail
LOCAL_DIR="${LOCAL_DIR:-$HOME/Repositories/ocn-keycloak/local}"
PIDFILE="$LOCAL_DIR/keycloak.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  PID=$(cat "$PIDFILE")
  # kc.sh execs java as a child; stop the whole group.
  pkill -TERM -P "$PID" 2>/dev/null || true
  kill -TERM "$PID" 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
  echo ">> Keycloak stopped"
fi
rm -f "$PIDFILE"
if [ "${1:-}" != "--keycloak-only" ]; then brew services stop mailpit >/dev/null 2>&1 && echo ">> Mailpit stopped"; fi
