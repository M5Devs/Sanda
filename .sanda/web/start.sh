#!/usr/bin/env bash
# Start the Sanda dashboard on port 4040 (idempotent — safe to run on every
# container start; it exits early when a healthy instance is already up).

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PORT="${SANDA_WEB_PORT:-4040}"
LOG="${SANDA_WEB_LOG:-/tmp/sanda-web.log}"

healthy() {
  curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1
}

if healthy; then
  exit 0
fi

export NVM_DIR="${NVM_DIR:-/usr/local/share/nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi
export PATH="$HOME/.local/bin:$NVM_DIR/current/bin:$PATH"

# Another instance may still be booting; give it a moment before spawning.
if pgrep -f "node .*sanda/web/server\.js" >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    healthy && exit 0
    sleep 0.2
  done
fi

if ! command -v node >/dev/null 2>&1; then
  printf '[sanda] node not found; dashboard not started\n' >&2
  exit 0
fi

nohup node "$SCRIPT_DIR/server.js" >>"$LOG" 2>&1 &

for _ in $(seq 1 40); do
  if healthy; then
    printf '[sanda] dashboard on http://127.0.0.1:%s\n' "$PORT"
    exit 0
  fi
  sleep 0.25
done

printf '[sanda] dashboard did not start; see %s\n' "$LOG" >&2
exit 0
