#!/usr/bin/env bash
# Start the Sanda dashboard on port 4040.
#
# Safe to run repeatedly: postStartCommand and `sanda web` both call it. It
# finds node without a login shell, detaches the server with setsid so
# Codespaces does not reap it when the hook exits, and waits until
# /api/health answers before reporting success.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PORT="${SANDA_WEB_PORT:-4040}"
LOG="${SANDA_WEB_LOG:-/tmp/sanda-web.log}"
WAIT_SECONDS="${SANDA_WEB_WAIT:-15}"

log()  { printf '[sanda] %s\n' "$*"; }
warn() { printf '[sanda] %s\n' "$*" >&2; }

healthy() {
  curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1
}

# postStartCommand runs in a non-login shell where nvm's node is not on PATH.
load_node_path() {
  export NVM_DIR="${NVM_DIR:-/usr/local/share/nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  fi

  local dir
  for dir in "$NVM_DIR/current/bin" \
             /usr/local/share/nvm/current/bin \
             /usr/local/share/nvm/versions/node/*/bin \
             /usr/local/bin \
             /usr/bin; do
    [ -d "$dir" ] || continue
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) PATH="$dir:$PATH" ;;
    esac
  done
  export PATH
}

wait_healthy() {
  local i
  for ((i = 0; i < WAIT_SECONDS * 4; i++)); do
    healthy && return 0
    # After a second, a missing process means it already crashed (bad port,
    # missing module); stop waiting instead of burning the full timeout.
    if [ "$i" -ge 4 ] && ! pgrep -f "node .*sanda/web/server\.js" >/dev/null 2>&1; then
      return 1
    fi
    sleep 0.25
  done
  return 1
}

print_log() {
  [ -s "$LOG" ] || return 0
  warn "last lines of $LOG:"
  tail -n 20 "$LOG" >&2
}

if healthy; then
  exit 0
fi

load_node_path

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  warn "node not found (checked PATH and nvm). The Node devcontainer feature provides it; rebuild the container."
  exit 1
fi

# A previous instance may still be booting; do not start a second one.
if pgrep -f "node .*sanda/web/server\.js" >/dev/null 2>&1 && wait_healthy; then
  log "dashboard already running on port $PORT"
  exit 0
fi

STARTED_AT=$SECONDS

# setsid gives the server its own session, so it outlives this shell.
if command -v setsid >/dev/null 2>&1; then
  setsid "$NODE_BIN" "$SCRIPT_DIR/server.js" </dev/null >"$LOG" 2>&1 &
else
  nohup "$NODE_BIN" "$SCRIPT_DIR/server.js" </dev/null >"$LOG" 2>&1 &
fi

if wait_healthy; then
  log "dashboard on http://127.0.0.1:${PORT} (log: ${LOG})"
  exit 0
fi

warn "dashboard did not answer on port ${PORT} after $((SECONDS - STARTED_AT))s"
print_log
exit 1
