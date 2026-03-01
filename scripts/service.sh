#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/state/runtime/issue-hunter.pid"
LOG_FILE="$ROOT_DIR/state/runtime/server.log"
CONFIG_PATH="${ISSUE_HUNTER_CONFIG_PATH:-$ROOT_DIR/state/config.json}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"

command="${1:-status}"

mkdir -p "$ROOT_DIR/state/runtime"

is_running() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    return 1
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

start() {
  if is_running; then
    echo "Issue Hunter is already running (pid: $(cat "$PID_FILE"))."
    return 0
  fi

  if [[ -f "$PID_FILE" ]]; then
    rm -f "$PID_FILE"
  fi

  if [[ ! -f "$ROOT_DIR/dist/server.js" ]]; then
    echo "Missing dist/server.js, running build first..."
    (cd "$ROOT_DIR" && npm run build)
  fi

  echo "Starting Issue Hunter on http://$HOST:$PORT ..."
  (
    cd "$ROOT_DIR"
    nohup env \
      ISSUE_HUNTER_CONFIG_PATH="$CONFIG_PATH" \
      HOST="$HOST" \
      PORT="$PORT" \
      node dist/server.js >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )

  sleep 1
  if is_running; then
    echo "Issue Hunter started (pid: $(cat "$PID_FILE"))."
    echo "Log file: $LOG_FILE"
  else
    echo "Failed to start Issue Hunter. Check log: $LOG_FILE"
    exit 1
  fi
}

stop() {
  if ! is_running; then
    echo "Issue Hunter is not running."
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  echo "Stopping Issue Hunter (pid: $pid) ..."
  kill "$pid" >/dev/null 2>&1 || true

  for _ in {1..20}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done

  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "Force killing Issue Hunter (pid: $pid) ..."
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi

  rm -f "$PID_FILE"
  echo "Issue Hunter stopped."
}

status() {
  if is_running; then
    echo "Issue Hunter is running (pid: $(cat "$PID_FILE"))."
    echo "URL: http://$HOST:$PORT"
    echo "Log file: $LOG_FILE"
  else
    echo "Issue Hunter is not running."
    echo "Log file: $LOG_FILE"
  fi
}

restart() {
  stop
  start
}

case "$command" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    restart
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
