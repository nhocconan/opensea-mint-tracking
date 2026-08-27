#!/usr/bin/env bash
# Local development: secrets + Postgres + Valkey + migrate + web + worker.
# Host-published ports start at 3960 (scripts/dev-ports.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_LIB_TAG="start-dev"
# shellcheck source=env-lib.sh
source "${SCRIPT_DIR}/env-lib.sh"
cd "$ROOT"

if [ "${1:-}" = "--stop" ]; then
  exec "${SCRIPT_DIR}/stop-dev.sh"
fi

WEB_PORT="${HOODMINT_WEB_PORT}"
PG_HOST_PORT="${HOODMINT_PG_PORT}"
VALKEY_HOST_PORT="${HOODMINT_VALKEY_PORT}"
WORKER_HEALTH_PORT="${HOODMINT_WORKER_HEALTH_PORT}"
DEV_DIR="${ROOT}/.dev"
mkdir -p "$DEV_DIR"

if ! bash "${SCRIPT_DIR}/env-setup.sh" --mode=dev; then
  err "environment is not ready — follow the steps printed above, then re-run scripts/start-dev.sh"
  exit 1
fi

export APP_ENV=development
export APP_URL="http://localhost:${WEB_PORT}"
export PORT="${WEB_PORT}"
export WORKER_HEALTH_PORT="${WORKER_HEALTH_PORT}"
export NODE_ENV=development
export DATABASE_URL="postgres://hoodmint:hoodmint@127.0.0.1:${PG_HOST_PORT}/hoodmint"
export VALKEY_URL="redis://127.0.0.1:${VALKEY_HOST_PORT}/0"
APP_ENCRYPTION_KEY="$(env_get APP_ENCRYPTION_KEY)"
BETTER_AUTH_SECRET="$(env_get BETTER_AUTH_SECRET)"
export APP_ENCRYPTION_KEY BETTER_AUTH_SECRET

COMPOSE_FILES=(-f compose.yaml)
compose() { docker compose "${COMPOSE_FILES[@]}" "$@"; }

VALKEY_PUBLISH=1
if port_busy "$VALKEY_HOST_PORT"; then
  say "host :${VALKEY_HOST_PORT} already bound — Valkey stays compose-internal"
  cat >"$DEV_DIR/compose.valkey-internal.yaml" <<'YAML'
services:
  valkey:
    ports: !reset []
YAML
  COMPOSE_FILES=(-f compose.yaml -f "$DEV_DIR/compose.valkey-internal.yaml")
  VALKEY_PUBLISH=0
else
  rm -f "$DEV_DIR/compose.valkey-internal.yaml"
fi

if [ "$VALKEY_PUBLISH" = "1" ]; then
  say "starting data stores (postgres :${PG_HOST_PORT}, valkey :${VALKEY_HOST_PORT})"
else
  say "starting data stores (postgres :${PG_HOST_PORT}, valkey compose-internal)"
fi
compose up -d postgres valkey

say "waiting for store health"
stores_ok=0
for _ in $(seq 1 60); do
  status="$(compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null || true)"
  if echo "$status" | grep -q '^postgres healthy' && echo "$status" | grep -q '^valkey healthy'; then
    stores_ok=1
    break
  fi
  sleep 1
done
if [ "$stores_ok" != "1" ]; then
  err "postgres/valkey never became healthy"
  compose ps
  compose logs --tail=40 postgres valkey >&2 || true
  exit 1
fi
ok "stores healthy"

web_up=0
if [ "$(http_code "http://127.0.0.1:${WEB_PORT}/health/live")" = "200" ]; then
  web_up=1
fi

use_local_web=0
use_local_worker=0
if command -v pnpm >/dev/null 2>&1 && [ -d node_modules ]; then
  use_local_web=1
  if [ "$VALKEY_PUBLISH" = "1" ] && ! port_busy "$WORKER_HEALTH_PORT"; then
    use_local_worker=1
  fi
fi

if [ "$web_up" = "1" ]; then
  say "web already healthy on :${WEB_PORT} — reusing"
elif [ "$use_local_web" = "1" ]; then
  say "local web path: migrate + next :${WEB_PORT}"
  compose stop web >/dev/null 2>&1 || true
  pnpm migrate
  if pid_alive "$DEV_DIR/web.pid" && [ "$(http_code "http://127.0.0.1:${WEB_PORT}/health/live")" != "200" ]; then
    say "stale web pid is not serving :${WEB_PORT} — restarting"
    kill "$(cat "$DEV_DIR/web.pid")" 2>/dev/null || true
    rm -f "$DEV_DIR/web.pid"
  fi
  if ! pid_alive "$DEV_DIR/web.pid"; then
    nohup pnpm --filter @hoodmint/web exec next dev -p "${WEB_PORT}" >"$DEV_DIR/web.log" 2>&1 &
    echo $! >"$DEV_DIR/web.pid"
  fi
  if [ "$use_local_worker" = "1" ]; then
    say "local worker on :${WORKER_HEALTH_PORT}"
    compose stop worker >/dev/null 2>&1 || true
    if ! pid_alive "$DEV_DIR/worker.pid"; then
      nohup pnpm --filter @hoodmint/worker run dev >"$DEV_DIR/worker.log" 2>&1 &
      echo $! >"$DEV_DIR/worker.pid"
    fi
  else
    say "docker worker (host :${WORKER_HEALTH_PORT} not free for a local worker)"
    compose up -d worker
  fi
  say "waiting for http://127.0.0.1:${WEB_PORT}/health/live"
  wait_http "http://127.0.0.1:${WEB_PORT}/health/live" 90
else
  say "docker path: compose migrate + web + worker on :${WEB_PORT}"
  compose up -d --build migrate web worker
  say "waiting for http://127.0.0.1:${WEB_PORT}/health/live"
  wait_http "http://127.0.0.1:${WEB_PORT}/health/live" 180
fi

say "probing /setup"
setup_code="$(http_code "http://127.0.0.1:${WEB_PORT}/setup")"
if [ "$setup_code" != "200" ]; then
  err "/setup returned HTTP ${setup_code}"
  compose logs --tail=40 web >&2 || true
  if [ -f "$DEV_DIR/web.log" ]; then
    tail -n 40 "$DEV_DIR/web.log" >&2 || true
  fi
  exit 1
fi
setup_body="$(curl -sS --max-time 8 "http://127.0.0.1:${WEB_PORT}/setup" || true)"
if ! echo "$setup_body" | grep -qiE 'HoodMint|setup|Sign in|Pulse'; then
  err "/setup did not return a HoodMint Radar HTML body"
  exit 1
fi

valkey_line="Valkey         compose-internal (host :${VALKEY_HOST_PORT} was busy)"
if [ "$VALKEY_PUBLISH" = "1" ]; then
  valkey_line="Valkey         127.0.0.1:${VALKEY_HOST_PORT}"
fi

cat <<EOF

HoodMint Radar (dev) is up.

  Web            http://localhost:${WEB_PORT}
  Setup          http://localhost:${WEB_PORT}/setup
  Health         http://localhost:${WEB_PORT}/health/live
  Postgres       127.0.0.1:${PG_HOST_PORT}
  ${valkey_line}
  Worker health  127.0.0.1:${WORKER_HEALTH_PORT}

Stop everything started by this command with scripts/stop-dev.sh.
First admin: make token → open the Setup URL.
EOF
