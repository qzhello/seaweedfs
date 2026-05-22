#!/usr/bin/env bash
#
# restart.sh — stop and restart the local dev stack (backend + frontend).
#
#   Backend  : cmd/controller  → http :8081  (config/config.dev.yaml)
#   Collector: cmd/collector   → background metrics collector
#   Frontend : web/ pnpm dev   → http :3001  (Next.js, turbo)
#
# Usage:
#   ./restart.sh                 restart everything (controller + collector + web)
#   ./restart.sh --backend-only  only the Go controller (+ collector)
#   ./restart.sh --frontend-only only the Next.js web app
#   ./restart.sh --no-collector  skip the collector process
#   ./restart.sh stop            stop everything, start nothing
#
# Logs  -> logs/{controller,collector,web}.log
# PIDs  -> logs/{controller,collector,web}.pid
#
# Safe to run repeatedly: it always frees the ports first so you never
# end up with two servers fighting over :8081 / :3001.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

CONFIG="config/config.dev.yaml"
BACKEND_PORT=8081
FRONTEND_PORT=3001
ENV_FILE="$ROOT/.env.local"

# Ensure a TIER_MASTER_KEY exists. The controller refuses to store
# encrypted secrets (AI provider API keys, storage backend creds) when
# it's missing, so first-time setup would fail with 503. We generate
# one and persist it to .env.local; the file is gitignored. Operators
# can override this for prod by setting TIER_MASTER_KEY in the
# environment before calling this script.
ensure_master_key() {
  if [ -n "${TIER_MASTER_KEY:-}" ]; then
    return 0
  fi
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
  fi
  if [ -z "${TIER_MASTER_KEY:-}" ]; then
    say "generating TIER_MASTER_KEY into $ENV_FILE (first-run setup)"
    local key
    key=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 999)
    if [ -z "$key" ] || [ ${#key} -ne 64 ]; then
      warn "failed to generate TIER_MASTER_KEY — neither openssl nor xxd produced a 64-char hex string"
      return 1
    fi
    {
      echo "# Auto-generated $(date -Iseconds) by restart.sh"
      echo "# AES-256-GCM key (32 random bytes, hex). Used to encrypt secrets at rest."
      echo "# DO NOT commit this file."
      echo "TIER_MASTER_KEY=$key"
    } >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    export TIER_MASTER_KEY="$key"
    ok "wrote TIER_MASTER_KEY (rotate by deleting $ENV_FILE — note this invalidates existing encrypted secrets)"
  else
    export TIER_MASTER_KEY
  fi
}

# ---- arg parsing -----------------------------------------------------------
DO_BACKEND=1
DO_FRONTEND=1
DO_COLLECTOR=1
STOP_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --backend-only)  DO_FRONTEND=0 ;;
    --frontend-only) DO_BACKEND=0; DO_COLLECTOR=0 ;;
    --no-collector)  DO_COLLECTOR=0 ;;
    stop|--stop)     STOP_ONLY=1 ;;
    -h|--help)       grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg (try --help)" >&2; exit 1 ;;
  esac
done

# ---- helpers ---------------------------------------------------------------
say() { printf '\033[1;36m›\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m!\033[0m %s\n' "$*"; }

# Kill whatever owns a TCP port (the actual listening process — works
# regardless of how it was started: `go run`, compiled binary, next dev).
free_port() {
  local port="$1" pids
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    say "freeing port ${port} (pids: $(echo "$pids" | tr '\n' ' '))"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
    pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      warn "port ${port} still busy — sending SIGKILL"
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

kill_pidfile() {
  local name="$1" pf="$LOG_DIR/$1.pid"
  if [ -f "$pf" ]; then
    local pid; pid="$(cat "$pf" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      say "stopping $name (pid $pid)"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pf"
  fi
}

# Poll a port until something is listening, or time out.
wait_port() {
  local port="$1" label="$2" tries=60
  while [ "$tries" -gt 0 ]; do
    if lsof -ti "tcp:${port}" >/dev/null 2>&1; then
      ok "$label is up on :$port"
      return 0
    fi
    sleep 1
    tries=$((tries - 1))
  done
  warn "$label did not come up on :$port within 60s — check $LOG_DIR/$label.log"
  return 1
}

# ---- stop phase ------------------------------------------------------------
say "stopping existing processes…"
kill_pidfile controller
kill_pidfile collector
kill_pidfile web
[ "$DO_BACKEND" = 1 ]  && free_port "$BACKEND_PORT"
[ "$DO_FRONTEND" = 1 ] && free_port "$FRONTEND_PORT"
# Catch any orphaned collector (no port of its own to grep).
pkill -f 'cmd/collector' 2>/dev/null || true
pkill -f 'bin/collector' 2>/dev/null || true

if [ "$STOP_ONLY" = 1 ]; then
  ok "stopped. (nothing restarted — 'stop' mode)"
  exit 0
fi

# ---- start backend ---------------------------------------------------------
if [ "$DO_BACKEND" = 1 ]; then
  ensure_master_key

  say "building backend…"
  go build -o bin/controller ./cmd/controller
  [ "$DO_COLLECTOR" = 1 ] && go build -o bin/collector ./cmd/collector

  say "starting controller…"
  TIER_MASTER_KEY="$TIER_MASTER_KEY" nohup ./bin/controller --config "$CONFIG" > "$LOG_DIR/controller.log" 2>&1 &
  echo $! > "$LOG_DIR/controller.pid"

  if [ "$DO_COLLECTOR" = 1 ]; then
    say "starting collector…"
    TIER_MASTER_KEY="$TIER_MASTER_KEY" nohup ./bin/collector --config "$CONFIG" > "$LOG_DIR/collector.log" 2>&1 &
    echo $! > "$LOG_DIR/collector.pid"
  fi
fi

# ---- start frontend --------------------------------------------------------
if [ "$DO_FRONTEND" = 1 ]; then
  if [ ! -d web/node_modules ]; then
    say "web/node_modules missing — running pnpm install…"
    (cd web && pnpm install)
  fi
  say "starting web (next dev)…"
  ( cd web && nohup pnpm dev > "$LOG_DIR/web.log" 2>&1 & echo $! > "$LOG_DIR/web.pid" )
fi

# ---- wait & summary --------------------------------------------------------
[ "$DO_BACKEND" = 1 ]  && wait_port "$BACKEND_PORT"  controller || true
[ "$DO_FRONTEND" = 1 ] && wait_port "$FRONTEND_PORT" web        || true

echo
ok "dev stack restarted"
[ "$DO_BACKEND" = 1 ]  && echo "  backend   http://localhost:${BACKEND_PORT}   (logs: logs/controller.log)"
[ "$DO_COLLECTOR" = 1 ] && [ "$DO_BACKEND" = 1 ] && echo "  collector running               (logs: logs/collector.log)"
[ "$DO_FRONTEND" = 1 ] && echo "  frontend  http://localhost:${FRONTEND_PORT}   (logs: logs/web.log)"
echo
echo "tail logs:  tail -f logs/web.log logs/controller.log"
echo "stop all :  ./restart.sh stop"
