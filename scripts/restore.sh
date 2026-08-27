#!/usr/bin/env bash
# Restore PostgreSQL from backups/<file> (PRD §13: restore smoke-tested path).
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?usage: make restore file=backups/xxx.sql.gz}"
[ -f "$FILE" ] || { echo "no such file: $FILE"; exit 2; }
echo "restoring ${FILE} into compose postgres (this drops/recreates app data)"
gunzip -c "$FILE" | docker compose exec -T postgres psql -U hoodmint -d hoodmint
echo "restore complete — restart app services: docker compose restart web worker"
