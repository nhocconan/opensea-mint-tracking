#!/usr/bin/env bash
# Integration tests (PRD §15): real PostgreSQL + Valkey containers, then the
# db package's integration suite: migrations apply, upsert idempotency,
# feed queries, outbox claiming, and reorg replay.
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=hoodmint-integration
POSTGRES_PORT=55432
VALKEY_PORT=56379

cleanup() {
  docker compose -f scripts/integration-compose.yaml down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

say() { printf '\033[36m[it]\033[0m %s\n' "$*"; }

say "starting integration postgres/valkey"
POSTGRES_PORT=$POSTGRES_PORT VALKEY_PORT=$VALKEY_PORT \
  docker compose -f scripts/integration-compose.yaml up -d --wait >/dev/null

export DATABASE_URL="postgres://hoodmint:hoodmint@127.0.0.1:${POSTGRES_PORT}/hoodmint"
export VALKEY_URL="redis://127.0.0.1:${VALKEY_PORT}/0"
export APP_ENCRYPTION_KEY="$(printf 'a%.0s' {1..43} | base64)"
export BETTER_AUTH_SECRET="integration-test-secret-0123456789abcdef"

say "applying migrations against real PostgreSQL"
pnpm migrate

say "running integration suite"
pnpm --filter @hoodmint/db run test:integration

say "integration tests complete"
