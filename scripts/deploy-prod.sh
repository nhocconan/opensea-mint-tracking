#!/usr/bin/env bash
# Rebuild and restart prod services, archiving container logs FIRST.
#
# Two operational failures this wraps up:
#  1. `docker compose up` without -p/-f targets the *dev* project, tries to
#     create a second network, fails, and reads like a prod outage. Prod is
#     project `hoodmint-radar-prod` with docker-compose.prod.yml.
#  2. Rebuilding recreates the container, and json-file logs die with it. The
#     worker logs for the 2026-09-16 21:00 GTD and 21:30 FCFS were destroyed by
#     a deploy twenty minutes after the mint, while they were still the only
#     evidence of what went wrong. Archive before touching anything.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="hoodmint-radar-prod"
COMPOSE_FILE="${ROOT}/docker-compose.prod.yml"
ARCHIVE_DIR="${ROOT}/logs/archive"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"

services=("$@")
if [ "${#services[@]}" -eq 0 ]; then
  services=(worker web)
fi

mkdir -p "$ARCHIVE_DIR"
for svc in "${services[@]}"; do
  container="${PROJECT}-${svc}-1"
  if docker inspect "$container" >/dev/null 2>&1; then
    dest="${ARCHIVE_DIR}/${STAMP}-${svc}.log"
    docker logs "$container" >"$dest" 2>&1 || true
    gzip -f "$dest"
    echo "archived ${container} -> ${dest}.gz"
  fi
done

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up --build -d "${services[@]}"

for svc in "${services[@]}"; do
  container="${PROJECT}-${svc}-1"
  docker inspect "$container" >/dev/null 2>&1 || continue
  # Only wait on services that declare a healthcheck.
  if [ "$(docker inspect -f '{{if .State.Health}}yes{{end}}' "$container")" = yes ]; then
    until [ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" = healthy ]; do sleep 3; done
  fi
  echo "${container} $(docker inspect -f '{{.State.Status}}' "$container")"
done
