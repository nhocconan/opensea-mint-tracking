#!/usr/bin/env bash
# Stop the production-posture compose stack (volumes kept).
#   --down  compose down
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_LIB_TAG="stop-prod"
# shellcheck source=env-lib.sh
source "${SCRIPT_DIR}/env-lib.sh"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  err "docker is not available"
  exit 1
fi

if [ "${1:-}" = "--down" ]; then
  say "docker compose down (volumes kept)"
  docker compose -f compose.yaml -f compose.prod-posture.yaml down --remove-orphans
else
  say "stopping compose services (volumes kept)"
  docker compose -f compose.yaml -f compose.prod-posture.yaml stop
fi

say "stopped. Restart with scripts/start-prod.sh"
