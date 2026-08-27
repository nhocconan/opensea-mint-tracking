#!/usr/bin/env bash
# Production posture: Docker web + worker + migrate + stores.
# Uses compose.yaml + compose.prod-posture.yaml (no published DB/queue ports).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_LIB_TAG="start-prod"
# shellcheck source=env-lib.sh
source "${SCRIPT_DIR}/env-lib.sh"
cd "$ROOT"

WEB_PORT="${HOODMINT_WEB_PORT}"
DEV_DIR="${ROOT}/.dev"
mkdir -p "$DEV_DIR"

if ! bash "${SCRIPT_DIR}/env-setup.sh" --mode=prod; then
  err "environment is not ready — follow the steps printed above, then re-run scripts/start-prod.sh"
  exit 1
fi

# Local Next would collide on :3960.
if [ -x "${SCRIPT_DIR}/stop-dev.sh" ]; then
  say "stopping any local-dev web/worker so production can bind :${WEB_PORT}"
  bash "${SCRIPT_DIR}/stop-dev.sh" >/dev/null || true
fi

say "starting production compose (compose.yaml + compose.prod-posture.yaml)"
docker compose -f compose.yaml -f compose.prod-posture.yaml up --build -d

say "waiting for http://127.0.0.1:${WEB_PORT}/health/live"
if ! wait_http "http://127.0.0.1:${WEB_PORT}/health/live" 180; then
  err "web never became live — last logs:"
  docker compose -f compose.yaml -f compose.prod-posture.yaml logs --tail=50 web >&2 || true
  docker compose -f compose.yaml -f compose.prod-posture.yaml ps
  exit 1
fi

setup_code="$(http_code "http://127.0.0.1:${WEB_PORT}/setup")"
if [ "$setup_code" != "200" ]; then
  err "/setup returned HTTP ${setup_code}"
  docker compose -f compose.yaml -f compose.prod-posture.yaml logs --tail=40 web >&2 || true
  exit 1
fi
setup_body="$(curl -sS --max-time 8 "http://127.0.0.1:${WEB_PORT}/setup" || true)"
if ! echo "$setup_body" | grep -qiE 'HoodMint|setup|Sign in|Pulse'; then
  err "/setup did not return a HoodMint Radar HTML body"
  exit 1
fi

app_url="$(env_get APP_URL)"
cat <<EOF

HoodMint Radar (production posture) is up.

  Web            http://127.0.0.1:${WEB_PORT}
  Public origin  ${app_url}
  Setup          http://127.0.0.1:${WEB_PORT}/setup
  Health         http://127.0.0.1:${WEB_PORT}/health/live
  Postgres       unpublished (compose.prod)
  Valkey         unpublished (compose.prod)

Stop with scripts/stop-prod.sh
First admin (if none exists): make token → open Setup.
Public deploy: set APP_URL=https://your-domain in .env and put a reverse
proxy in front of :${WEB_PORT}.
EOF
