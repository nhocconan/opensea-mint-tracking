#!/usr/bin/env bash
# Stop every HoodMint Radar dev resource started by scripts/start-dev.sh.
# The default is a full Compose teardown (containers and network); named volumes
# are deliberately kept so a normal stop never destroys development data.
#   --all   compatibility alias for the default full teardown
#   --down  compatibility alias for the default full teardown
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=dev-ports.sh
source "${SCRIPT_DIR}/dev-ports.sh"
cd "$ROOT"

DEV_DIR="${ROOT}/.dev"
say() { printf '\033[36m[stop-dev]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[stop-dev]\033[0m %s\n' "$*" >&2; }

case "${1:-}" in
  ""|--all|--down) ;;
  *)
    echo "usage: scripts/stop-dev.sh [--all|--down]" >&2
    exit 2
    ;;
esac

pid_alive() {
  local file="$1"
  [ -f "$file" ] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  [ -n "${pid}" ] && kill -0 "$pid" 2>/dev/null
}

stop_pidfile() {
  local name="$1" file="$2"
  if pid_alive "$file"; then
    say "stopping local ${name} (pid $(cat "$file"))"
    kill "$(cat "$file")" 2>/dev/null || true
    sleep 0.3
    if pid_alive "$file"; then
      kill -9 "$(cat "$file")" 2>/dev/null || true
    fi
  fi
  rm -f "$file"
}

stop_pidfile web "${DEV_DIR}/web.pid"
stop_pidfile worker "${DEV_DIR}/worker.pid"

# Leftover next-dev from an older port (e.g. 3950) must not block 3960.
if command -v lsof >/dev/null 2>&1; then
  leftover="$(lsof -nP -iTCP:"${HOODMINT_WEB_PORT}" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "${leftover}" ]; then
    say "killing leftover listener on :${HOODMINT_WEB_PORT} (${leftover})"
    # shellcheck disable=SC2086
    kill ${leftover} 2>/dev/null || true
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  err "Docker CLI is unavailable; cannot stop the complete HoodMint stack."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  err "Docker daemon is unavailable; cannot stop the complete HoodMint stack."
  exit 1
fi

say "docker compose down (all HoodMint containers/network; volumes kept)"
docker compose down --remove-orphans

say "stopped. Restart with scripts/start-dev.sh (web :${HOODMINT_WEB_PORT})"
