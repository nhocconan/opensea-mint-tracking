#!/usr/bin/env bash
# Mint a one-time /setup bootstrap token for a DOCKERIZED production deploy.
#
# Why this exists (not `make token`): `make token` runs on the HOST and needs
# APP_ENCRYPTION_KEY / DATABASE_URL / VALKEY_URL in the shell plus a reachable
# Postgres. In the prod-behind-Traefik topology those live only inside the
# compose network (unpublished DB port) and are never exported to the host
# shell, so `make token` fails with "Invalid environment configuration". This
# script instead inserts the token's fingerprint straight into Postgres via
# the running container — the same value `issueBootstrapToken` would store
# (sha256(token) truncated to 12 hex, matching packages/secrets' fingerprint).
set -euo pipefail

# Pick the compose file this host actually runs (the real prod file is
# gitignored; fall back to the committed sample, then plain compose).
if [ -n "${COMPOSE_FILE:-}" ]; then
  COMPOSE=(docker compose -f "$COMPOSE_FILE")
elif [ -f docker-compose.prod.yml ]; then
  COMPOSE=(docker compose -f docker-compose.prod.yml)
elif [ -f compose.prod.yaml ]; then
  COMPOSE=(docker compose -f compose.prod.yaml)
else
  COMPOSE=(docker compose)
fi
PG_SERVICE="${PG_SERVICE:-postgres}"
TTL_MIN="${TTL_MIN:-30}"

TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
HASH=$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,12))" "$TOKEN")

"${COMPOSE[@]}" exec -T "$PG_SERVICE" \
  psql -U hoodmint -d hoodmint -c \
  "insert into bootstrap_tokens (token_hash, expires_at) values ('$HASH', now() + interval '$TTL_MIN minutes')" \
  >/dev/null

echo "One-time setup token (valid ${TTL_MIN} minutes, single use):"
echo "  $TOKEN"
echo "Open https://<your-domain>/setup and paste it, then sign in at /login."
