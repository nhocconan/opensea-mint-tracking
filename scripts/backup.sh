#!/usr/bin/env bash
# HoodMint Radar — full backup (PostgreSQL + config + secrets), encrypted.
#
#   scripts/backup.sh [--plain] [--no-verify] [--keep-days N] [--keep-min N]
#                     [--out DIR] [--label TEXT]
#
# What one backup contains (single archive, atomic, self-describing):
#   db/hoodmint.dump.zst     pg_dump custom format (-Fc, parallel-restorable),
#                            zstd-compressed — every durable state lives here
#   config/.env              runtime secrets (APP_ENCRYPTION_KEY, auth secret,
#                            OpenSea keys, DB password …)
#   config/docker-compose.prod.yml
#   config/secrets/*         worker-only wallet key half (X25519 private)
#   manifest.json            git commit, PG version, DB size, exact row counts
#                            of the important tables, sha256 of every part
#
# Encryption: the archive is sealed with gpg AES-256 (symmetric) using the
# passphrase in backups/.passphrase (created on first run, mode 600 — COPY IT
# SOMEWHERE SAFE: without it a backup is unrecoverable). --plain skips the
# encryption AND omits config/secrets (never write secrets in clear).
#
# Verification (default on): the dump is re-read with `pg_restore --list`
# from a throwaway postgres container, the archive is re-decrypted and its
# sha256 manifest re-checked — a backup that cannot be restored is not a
# backup. Retention prunes old archives but always keeps the newest
# --keep-min (default 7) regardless of age.
#
# Optional off-site copy: BACKUP_RSYNC_TARGET="user@host:/path" (rsync -a).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PLAIN=0
VERIFY=1
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
KEEP_MIN="${BACKUP_KEEP_MIN:-7}"
OUT_DIR="${BACKUP_DIR:-$ROOT/backups}"
LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plain) PLAIN=1 ;;
    --no-verify) VERIFY=0 ;;
    --keep-days) KEEP_DAYS="$2"; shift ;;
    --keep-min) KEEP_MIN="$2"; shift ;;
    --out) OUT_DIR="$2"; shift ;;
    --label) LABEL="-$2"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[36m[backup]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[backup]\033[0m %s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || { err "missing tool: $1"; exit 1; }; }
need docker; need zstd; need sha256sum; need tar
[ "$PLAIN" = 1 ] || need gpg

# ── Locate the running postgres (prod compose first, then dev) ────────────
COMPOSE_FILE=""
for f in docker-compose.prod.yml compose.prod.yaml compose.yaml docker-compose.yml; do
  if [ -f "$f" ] && docker compose -f "$f" ps -q postgres 2>/dev/null | grep -q .; then
    COMPOSE_FILE="$f"; break
  fi
done
[ -n "$COMPOSE_FILE" ] || { err "no running postgres service found in any compose file"; exit 1; }
PG_CID="$(docker compose -f "$COMPOSE_FILE" ps -q postgres)"
PG_USER="${POSTGRES_USER:-hoodmint}"
PG_DB="${POSTGRES_DB:-hoodmint}"
PG_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$PG_CID")"
psqlx() { docker exec -i "$PG_CID" psql -U "$PG_USER" -d "$PG_DB" -tAq -v ON_ERROR_STOP=1 "$@"; }

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="hoodmint-${STAMP}${LABEL}"
WORK="$(mktemp -d "${OUT_DIR}/.tmp-${NAME}.XXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/db" "$WORK/config/secrets"

# ── 1. Database: pg_dump -Fc (consistent snapshot, parallel-restorable) ────
say "dumping ${PG_DB} from ${COMPOSE_FILE} (${PG_IMAGE})"
docker exec "$PG_CID" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc -Z 0 --no-owner --no-privileges \
  | zstd -T0 -q -3 -o "$WORK/db/hoodmint.dump.zst"
DUMP_BYTES="$(stat -c %s "$WORK/db/hoodmint.dump.zst")"
[ "$DUMP_BYTES" -gt 1024 ] || { err "dump is suspiciously small (${DUMP_BYTES} B)"; exit 1; }

# ── 2. Row counts + metadata for the manifest (restore verifies against it) ─
TABLES="projects drop_stages wallets mint_plans execution_attempts eligibility_checks mint_events supply_snapshots audit_logs credentials settings rpc_endpoints \"user\" session passkey"
COUNTS_JSON="{"
first=1
for t in $TABLES; do
  c="$(psqlx -c "select count(*) from ${t}" 2>/dev/null || echo -n "null")"
  key="${t//\"/}"
  [ $first = 1 ] || COUNTS_JSON+=","
  COUNTS_JSON+="\"${key}\":${c:-null}"
  first=0
done
COUNTS_JSON+="}"
PG_VERSION="$(psqlx -c 'show server_version')"
DB_SIZE="$(psqlx -c "select pg_database_size('${PG_DB}')")"
MIGRATION="$(psqlx -c 'select coalesce(max(id)::text, $$none$$) from drizzle.__drizzle_migrations' 2>/dev/null || echo unknown)"
GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# ── 3. Config + secrets (encrypted archives only) ───────────────────────────
INCLUDED_CONFIG="[]"
if [ "$PLAIN" = 0 ]; then
  inc=()
  for f in .env docker-compose.prod.yml compose.prod.yaml; do
    [ -f "$f" ] && { cp -p "$f" "$WORK/config/"; inc+=("$f"); }
  done
  if [ -d secrets ]; then
    for s in secrets/*; do
      [ -f "$s" ] && { cp -p "$s" "$WORK/config/secrets/"; inc+=("$s"); }
    done
  fi
  INCLUDED_CONFIG="$(printf '%s\n' "${inc[@]}" | python3 -c 'import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')"
else
  rmdir "$WORK/config/secrets"
  say "--plain: config/secrets NOT included (would be cleartext)"
fi

# ── 4. Manifest with per-file sha256 ───────────────────────────────────────
( cd "$WORK" && find db config -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum ) > "$WORK/SHA256SUMS"
cat > "$WORK/manifest.json" <<EOF
{
  "name": "${NAME}",
  "created_at": "${STAMP}",
  "host": "$(hostname)",
  "git_commit": "${GIT_COMMIT}",
  "compose_file": "${COMPOSE_FILE}",
  "postgres_image": "${PG_IMAGE}",
  "postgres_version": "${PG_VERSION}",
  "database": "${PG_DB}",
  "db_size_bytes": ${DB_SIZE},
  "dump_format": "pg_dump -Fc -Z0 | zstd",
  "dump_bytes": ${DUMP_BYTES},
  "last_migration": "${MIGRATION}",
  "encrypted": $([ "$PLAIN" = 0 ] && echo true || echo false),
  "config_files": ${INCLUDED_CONFIG},
  "row_counts": ${COUNTS_JSON}
}
EOF

# ── 5. Seal: tar → zstd → (gpg AES-256) ─────────────────────────────────────
if [ "$PLAIN" = 0 ]; then
  PASS_FILE="${BACKUP_PASSPHRASE_FILE:-$OUT_DIR/.passphrase}"
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    PASS_FILE="$WORK/.pass"; umask 077; printf '%s' "$BACKUP_PASSPHRASE" > "$PASS_FILE"
  elif [ ! -f "$PASS_FILE" ]; then
    umask 077; openssl rand -base64 48 | tr -d '\n' > "$PASS_FILE"
    say "NEW passphrase written to ${PASS_FILE} — store a copy off this server NOW"
  fi
  chmod 600 "$PASS_FILE"
  ARCHIVE="${OUT_DIR}/${NAME}.tar.zst.gpg"
  tar -C "$WORK" -cf - manifest.json SHA256SUMS db config \
    | zstd -T0 -q -3 \
    | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 \
          --compress-algo none --pinentry-mode loopback --passphrase-file "$PASS_FILE" \
          -o "$ARCHIVE"
else
  ARCHIVE="${OUT_DIR}/${NAME}.tar.zst"
  tar -C "$WORK" -cf - manifest.json SHA256SUMS db | zstd -T0 -q -3 -o "$ARCHIVE"
fi
chmod 600 "$ARCHIVE"
cp "$WORK/manifest.json" "${OUT_DIR}/${NAME}.manifest.json"
( cd "$OUT_DIR" && sha256sum "$(basename "$ARCHIVE")" > "${NAME}.sha256" )

# ── 6. Verify: decrypt + checksums + pg_restore --list on the dump ──────────
if [ "$VERIFY" = 1 ]; then
  say "verifying archive (decrypt, checksums, pg_restore --list)"
  V="$(mktemp -d "${OUT_DIR}/.verify-${NAME}.XXXX")"
  if [ "$PLAIN" = 0 ]; then
    gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASS_FILE" -d "$ARCHIVE" \
      | zstd -d -q | tar -C "$V" -xf -
  else
    zstd -d -q -c "$ARCHIVE" | tar -C "$V" -xf -
  fi
  ( cd "$V" && sha256sum --quiet -c SHA256SUMS )
  ( cd "$OUT_DIR" && sha256sum --quiet -c "${NAME}.sha256" )
  # File, not pipe: pg_restore --list closes stdin after the TOC header and a
  # pipe would end the script with SIGPIPE under pipefail.
  zstd -d -q -c "$V/db/hoodmint.dump.zst" > "$V/db/hoodmint.dump"
  TOC_ENTRIES="$(docker run --rm -i "$PG_IMAGE" pg_restore --list < "$V/db/hoodmint.dump" | grep -c 'TABLE DATA' || true)"
  rm -rf "$V"
  [ "${TOC_ENTRIES:-0}" -gt 0 ] || { err "pg_restore --list found no TABLE DATA entries"; exit 1; }
  say "verified: ${TOC_ENTRIES} tables in dump, checksums OK"
fi

# ── 7. Retention ────────────────────────────────────────────────────────────
mapfile -t ALL < <(ls -1t "$OUT_DIR"/hoodmint-*.tar.zst* 2>/dev/null | grep -vE '\.(sha256|manifest\.json)$' || true)
if [ "${#ALL[@]}" -gt "$KEEP_MIN" ]; then
  for old in "${ALL[@]:$KEEP_MIN}"; do
    if [ -n "$(find "$old" -mtime +"$KEEP_DAYS" 2>/dev/null)" ]; then
      base="${old%.tar.zst*}"
      rm -f "$old" "${base}.manifest.json" "${base}.sha256"
      say "pruned $(basename "$old") (older than ${KEEP_DAYS}d)"
    fi
  done
fi

# ── 8. Optional off-site copy ───────────────────────────────────────────────
if [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
  say "rsync → ${BACKUP_RSYNC_TARGET}"
  rsync -a --chmod=F600 "$ARCHIVE" "${OUT_DIR}/${NAME}.manifest.json" "${OUT_DIR}/${NAME}.sha256" "$BACKUP_RSYNC_TARGET/"
fi

say "wrote $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1)) — projects=$(python3 -c "import json;print(json.load(open('${OUT_DIR}/${NAME}.manifest.json'))['row_counts']['projects'])") mint_plans=$(python3 -c "import json;print(json.load(open('${OUT_DIR}/${NAME}.manifest.json'))['row_counts']['mint_plans'])")"
printf '%s\n' "$ARCHIVE"
