#!/usr/bin/env bash
# HoodMint Radar — restore a backup made by scripts/backup.sh.
#
#   scripts/restore.sh <archive> [--yes] [--dry-run] [--container NAME]
#                      [--no-safety] [--no-stop] [--config] [--jobs N]
#
# Default target is the postgres service of the running prod/dev compose;
# --container restores into ANY postgres container instead (e.g. a scratch
# one for a rehearsal — the test in scripts/backup-restore-test.sh does
# exactly that), leaving production untouched.
#
# Safety rails, in order:
#   1. sha256 of the archive is checked against <name>.sha256 when present;
#      the decrypted bundle's SHA256SUMS is always checked.
#   2. --dry-run stops after printing the manifest + the dump's table list.
#   3. A SAFETY backup of the current target DB is taken first (skip with
#      --no-safety — only sensible for scratch targets).
#   4. Prompts for confirmation unless --yes (you type the DB name).
#   5. web + worker are stopped for the duration (skip with --no-stop for a
#      scratch target) so nothing writes mid-restore.
#   6. pg_restore --clean --if-exists --no-owner -j N into the target, then
#      every row count in the manifest is compared with the restored DB —
#      any mismatch is reported and the script exits non-zero.
#   7. --config extracts .env / compose / secrets to restored-config/<name>/
#      (never over the live files) so you can diff and copy deliberately.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

ARCHIVE="${1:?usage: scripts/restore.sh <archive> [--yes] [--dry-run] [--container NAME] [--no-safety] [--no-stop] [--config] [--jobs N]}"
shift
YES=0; DRY=0; TARGET_CID=""; SAFETY=1; STOP=1; CONFIG=0; JOBS=4
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    --container) TARGET_CID="$2"; shift ;;
    --no-safety) SAFETY=0 ;;
    --no-stop) STOP=0 ;;
    --config) CONFIG=1 ;;
    --jobs) JOBS="$2"; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[36m[restore]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[restore]\033[0m %s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || { err "missing tool: $1"; exit 1; }; }
need docker; need zstd; need sha256sum; need tar; need python3

[ -f "$ARCHIVE" ] || { err "no such file: $ARCHIVE"; exit 2; }
ARCHIVE="$(readlink -f "$ARCHIVE")"
OUT_DIR="$(dirname "$ARCHIVE")"
NAME="$(basename "$ARCHIVE")"; NAME="${NAME%.tar.zst*}"
ENCRYPTED=0; case "$ARCHIVE" in *.gpg) ENCRYPTED=1; need gpg ;; esac

# ── 1. Integrity ────────────────────────────────────────────────────────────
if [ -f "${OUT_DIR}/${NAME}.sha256" ]; then
  ( cd "$OUT_DIR" && sha256sum --quiet -c "${NAME}.sha256" ) && say "archive sha256 OK"
else
  say "no ${NAME}.sha256 beside the archive — skipping outer checksum"
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hoodmint-restore.XXXX")"
trap 'rm -rf "$WORK"' EXIT
if [ "$ENCRYPTED" = 1 ]; then
  PASS_FILE="${BACKUP_PASSPHRASE_FILE:-$OUT_DIR/.passphrase}"
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    PASS_FILE="$WORK/.pass"; umask 077; printf '%s' "$BACKUP_PASSPHRASE" > "$PASS_FILE"
  fi
  [ -f "$PASS_FILE" ] || { err "passphrase file not found: ${PASS_FILE} (set BACKUP_PASSPHRASE or BACKUP_PASSPHRASE_FILE)"; exit 1; }
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASS_FILE" -d "$ARCHIVE" \
    | zstd -d -q | tar -C "$WORK" -xf -
else
  zstd -d -q -c "$ARCHIVE" | tar -C "$WORK" -xf -
fi
( cd "$WORK" && sha256sum --quiet -c SHA256SUMS ) && say "bundle checksums OK"
[ -f "$WORK/manifest.json" ] || { err "manifest.json missing — not a backup.sh archive"; exit 1; }
man() { python3 -c "import json,sys; m=json.load(open('$WORK/manifest.json')); v=m$1; print(json.dumps(v) if isinstance(v,(dict,list)) else v)"; }
say "backup ${NAME}: created $(man "['created_at']") on $(man "['host']") commit $(man "['git_commit']") pg $(man "['postgres_version']") size $(man "['db_size_bytes']") B"
say "row counts in backup: $(man "['row_counts']")"

# ── 2. Target ───────────────────────────────────────────────────────────────
COMPOSE_FILE=""
if [ -z "$TARGET_CID" ]; then
  for f in docker-compose.prod.yml compose.prod.yaml compose.yaml docker-compose.yml; do
    if [ -f "$f" ] && docker compose -f "$f" ps -q postgres 2>/dev/null | grep -q .; then
      COMPOSE_FILE="$f"; break
    fi
  done
  [ -n "$COMPOSE_FILE" ] || { err "no running postgres service found; use --container NAME"; exit 1; }
  TARGET_CID="$(docker compose -f "$COMPOSE_FILE" ps -q postgres)"
fi
docker inspect "$TARGET_CID" >/dev/null 2>&1 || { err "container not found: $TARGET_CID"; exit 1; }
PG_USER="${POSTGRES_USER:-hoodmint}"
PG_DB="${POSTGRES_DB:-hoodmint}"
PG_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$TARGET_CID")"
psqlx() { docker exec -i "$TARGET_CID" psql -U "$PG_USER" -d "$PG_DB" -tAq -v ON_ERROR_STOP=1 "$@"; }
psqlx -c 'select 1' >/dev/null || { err "cannot connect to ${PG_DB} in ${TARGET_CID}"; exit 1; }

# Decompress once (the parallel restore needs a file anyway). pg_restore
# --list reads only the TOC header and closes stdin, so feed it a file, not
# a pipe — a pipe ends the script with SIGPIPE (141) under pipefail.
zstd -d -q -c "$WORK/db/hoodmint.dump.zst" > "$WORK/db/hoodmint.dump"
TOC="$(docker run --rm -i "$PG_IMAGE" pg_restore --list < "$WORK/db/hoodmint.dump")"
say "dump contains $(printf '%s\n' "$TOC" | grep -c 'TABLE DATA') tables"
if [ "$DRY" = 1 ]; then
  printf '%s\n' "$TOC" | grep 'TABLE DATA' | awk '{print "  " $NF}' | head -60
  say "--dry-run: nothing restored"
  exit 0
fi

# ── 3. Confirm ──────────────────────────────────────────────────────────────
TARGET_DESC="$(docker inspect --format '{{.Name}}' "$TARGET_CID" | sed 's#^/##')"
say "TARGET: database '${PG_DB}' in container '${TARGET_DESC}' — existing data will be REPLACED"
if [ "$YES" = 0 ]; then
  read -r -p "type the database name (${PG_DB}) to continue: " answer
  [ "$answer" = "$PG_DB" ] || { err "aborted"; exit 3; }
fi

# ── 4. Safety backup of the current target ──────────────────────────────────
if [ "$SAFETY" = 1 ]; then
  SAFE="${OUT_DIR}/pre-restore-${TARGET_DESC}-$(date -u +%Y%m%dT%H%M%SZ).dump.zst"
  say "safety dump of current target → $(basename "$SAFE")"
  docker exec "$TARGET_CID" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc -Z 0 --no-owner --no-privileges | zstd -T0 -q -3 -o "$SAFE"
  chmod 600 "$SAFE"
fi

# ── 5. Quiesce writers ──────────────────────────────────────────────────────
STOPPED=0
if [ "$STOP" = 1 ] && [ -n "$COMPOSE_FILE" ]; then
  say "stopping web + worker (${COMPOSE_FILE})"
  docker compose -f "$COMPOSE_FILE" stop web worker >/dev/null 2>&1 || true
  STOPPED=1
fi
restart_services() {
  if [ "$STOPPED" = 1 ]; then
    say "starting web + worker"
    docker compose -f "$COMPOSE_FILE" start web worker >/dev/null 2>&1 || docker compose -f "$COMPOSE_FILE" up -d web worker
  fi
}
trap 'restart_services; rm -rf "$WORK"' EXIT

# ── 6. Restore ──────────────────────────────────────────────────────────────
say "pg_restore --clean --if-exists -j${JOBS} into ${TARGET_DESC}:${PG_DB}"
psqlx -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='${PG_DB}' and pid<>pg_backend_pid()" >/dev/null || true
docker cp "$WORK/db/hoodmint.dump" "$TARGET_CID:/tmp/hoodmint.dump"
# Parallel restore needs a file (not stdin). --clean on an empty DB emits
# harmless "does not exist" notices under --if-exists; real errors still fail.
docker exec "$TARGET_CID" pg_restore -U "$PG_USER" -d "$PG_DB" --clean --if-exists --no-owner --no-privileges \
  --exit-on-error -j "$JOBS" /tmp/hoodmint.dump
docker exec "$TARGET_CID" rm -f /tmp/hoodmint.dump
psqlx -c 'analyze' >/dev/null

# ── 7. Verify row counts against the manifest ───────────────────────────────
MISMATCH=0
while IFS=$'\t' read -r table expected; do
  q="$table"; [ "$q" = "user" ] && q='"user"'
  actual="$(psqlx -c "select count(*) from ${q}" 2>/dev/null || echo null)"
  if [ "$actual" != "$expected" ]; then
    err "row count mismatch: ${table} expected ${expected} got ${actual}"; MISMATCH=1
  fi
done < <(python3 -c "import json; m=json.load(open('$WORK/manifest.json'))['row_counts']; [print(f'{k}\t{v}') for k,v in m.items() if v is not None]")
[ "$MISMATCH" = 0 ] || { err "restore finished but verification FAILED"; exit 4; }
say "verified: every manifest row count matches the restored database"

# ── 8. Config files (never in place) ────────────────────────────────────────
if [ "$CONFIG" = 1 ]; then
  if [ -d "$WORK/config" ]; then
    DEST="${ROOT}/restored-config/${NAME}"
    mkdir -p "$DEST"; chmod 700 "${ROOT}/restored-config" "$DEST"
    cp -a "$WORK/config/." "$DEST/"
    say "config extracted to ${DEST}/ — diff and copy into place yourself (.env, compose, secrets/)"
  else
    say "archive has no config section (plain backup)"
  fi
fi

say "restore of ${NAME} complete"
