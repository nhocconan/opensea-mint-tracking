#!/usr/bin/env bash
# pg_dump the compose PostgreSQL service into backups/ (timestamped, gzip).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="backups/hoodmint-${STAMP}.sql.gz"
docker compose exec -T postgres pg_dump -U hoodmint -d hoodmint | gzip > "$OUT"
echo "wrote ${OUT} ($(du -h "${OUT}" | cut -f1))"
