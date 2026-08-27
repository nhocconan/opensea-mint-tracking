#!/usr/bin/env bash
# Step-by-step environment doctor. Creates/fills .env; never overwrites secrets.
#   scripts/env-setup.sh --mode=dev
#   scripts/env-setup.sh --mode=prod
#   scripts/env-setup.sh --mode=prod --check-only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_LIB_TAG="env-setup"
# shellcheck source=env-lib.sh
source "${SCRIPT_DIR}/env-lib.sh"
cd "$ROOT"

MODE="dev"
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --mode=dev | --mode=prod) MODE="${arg#--mode=}" ;;
    --check-only) CHECK_ONLY=1 ;;
    -h | --help)
      print_setup_guide dev
      exit 0
      ;;
    *)
      err "unknown argument: ${arg}"
      print_setup_guide dev
      exit 2
      ;;
  esac
done

FAILED=0
step() { say "Step $1 — $2"; }

step "1/6" "prerequisites (docker, openssl)"
if ! require_openssl; then
  FAILED=1
else
  ok "openssl present"
fi
if ! require_docker; then
  FAILED=1
else
  ok "docker daemon is up"
fi
if [ "$FAILED" -eq 1 ]; then
  print_setup_guide "$MODE"
  exit 1
fi

step "2/6" ".env file"
if [ ! -f .env ]; then
  if [ "$CHECK_ONLY" = "1" ]; then
    err ".env is missing (copy .env.example → .env)"
    FAILED=1
  else
    cp .env.example .env
    ok "created .env from .env.example"
  fi
else
  ok ".env exists"
fi

step "3/6" "secrets (never overwrite non-empty values)"
if [ "$CHECK_ONLY" = "1" ]; then
  if [ -z "$(env_get APP_ENCRYPTION_KEY)" ]; then
    err "APP_ENCRYPTION_KEY is empty"
    FAILED=1
  else
    ok "APP_ENCRYPTION_KEY is set"
  fi
  if [ -z "$(env_get BETTER_AUTH_SECRET)" ]; then
    err "BETTER_AUTH_SECRET is empty"
    FAILED=1
  else
    ok "BETTER_AUTH_SECRET is set"
  fi
else
  ensure_secret APP_ENCRYPTION_KEY
  ensure_secret BETTER_AUTH_SECRET
  key_len="$(env_get APP_ENCRYPTION_KEY | { openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' '; } || echo 0)"
  if [ "${key_len}" != "32" ]; then
    err "APP_ENCRYPTION_KEY must be base64 of exactly 32 bytes (got ${key_len})"
    FAILED=1
  else
    ok "APP_ENCRYPTION_KEY is a 32-byte key"
  fi
  secret_len="$(env_get BETTER_AUTH_SECRET | wc -c | tr -d ' ')"
  if [ "${secret_len}" -lt 32 ]; then
    err "BETTER_AUTH_SECRET must be at least 32 characters"
    FAILED=1
  else
    ok "BETTER_AUTH_SECRET length is ${secret_len}"
  fi
fi

step "4/6" "host ports and APP_URL (3960 sequence)"
if [ "$CHECK_ONLY" != "1" ]; then
  if [ "$MODE" = "dev" ]; then
    upsert_env APP_ENV development
    upsert_env APP_URL "http://localhost:${HOODMINT_WEB_PORT}"
  else
    upsert_env APP_ENV production
    current_url="$(env_get APP_URL)"
    if [ -z "${current_url}" ] || echo "${current_url}" | grep -qE 'localhost:(3000|3950)(/|$)'; then
      upsert_env APP_URL "http://localhost:${HOODMINT_WEB_PORT}"
    fi
  fi
  upsert_env PORT "${HOODMINT_WEB_PORT}"
  upsert_env WORKER_HEALTH_PORT "${HOODMINT_WORKER_HEALTH_PORT}"
  upsert_env DATABASE_URL "postgres://hoodmint:hoodmint@127.0.0.1:${HOODMINT_PG_PORT}/hoodmint"
  upsert_env VALKEY_URL "redis://127.0.0.1:${HOODMINT_VALKEY_PORT}/0"
fi
ok "APP_URL=$(env_get APP_URL)"
ok "PORT=$(env_get PORT)  WORKER_HEALTH_PORT=$(env_get WORKER_HEALTH_PORT)"
ok "DATABASE_URL host=$(env_get DATABASE_URL | sed 's#.*@##')"

if [ "$MODE" = "prod" ]; then
  app_url="$(env_get APP_URL)"
  if echo "${app_url}" | grep -q '^http://localhost'; then
    say "APP_URL is localhost — fine for a local production smoke."
    say "For a public deploy, set APP_URL=https://your-domain in .env (https required)."
  elif ! echo "${app_url}" | grep -q '^https://'; then
    err "Production APP_URL must be https://… (http is allowed only for localhost)."
    FAILED=1
  else
    ok "APP_URL is https — public-origin posture"
  fi
fi

step "5/6" "APP_ENV"
ok "APP_ENV=$(env_get APP_ENV)"

step "6/6" "optional provider credentials (Admin UI can set these later)"
if [ -n "$(env_get OPENSEA_API_KEY)" ]; then
  ok "OPENSEA_API_KEY is set (value hidden)"
else
  say "OPENSEA_API_KEY empty — worker can mint a free instant key, or set one in Admin → OpenSea"
fi
if [ -n "$(env_get RPC_URL)" ]; then
  ok "RPC_URL is set"
else
  say "RPC_URL empty — on-chain radar stays idle until you add an HTTP RPC"
fi

if [ "$FAILED" -eq 1 ]; then
  print_setup_guide "$MODE"
  exit 1
fi

ok "environment is ready for ${MODE}"
