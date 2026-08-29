#!/usr/bin/env bash
# End-to-end rehearsal of scripts/backup.sh + scripts/restore.sh against a
# THROWAWAY postgres container — production is only read (pg_dump).
#
#   scripts/backup-restore-test.sh [--keep-archive]
#
# 1. takes a real encrypted backup of the running DB (with verification)
# 2. starts a scratch postgres of the same image on a private network
# 3. restores the backup into it (--container, --no-safety, --no-stop, --yes)
# 4. restore.sh compares every manifest row count with the scratch DB
# 5. spot-checks a few business invariants (a project + its stages, the
#    latest mint plan) and that a tampered archive is REJECTED
# 6. removes the scratch container (and the test archive unless --keep-archive)
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP=0; [ "${1:-}" = "--keep-archive" ] && KEEP=1
say() { printf '\033[35m[br-test]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[br-test] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

SCRATCH="hoodmint-restore-test-$$"
cleanup() {
  docker rm -f "$SCRATCH" >/dev/null 2>&1 || true
  if [ "$KEEP" = 0 ] && [ -n "${ARCHIVE:-}" ]; then
    base="${ARCHIVE%.tar.zst*}"; rm -f "$ARCHIVE" "${base}.manifest.json" "${base}.sha256"
  fi
  rm -f "${TAMPERED:-}"
}
trap cleanup EXIT

say "1/6 backup (encrypted, verified)"
ARCHIVE="$(scripts/backup.sh --label brtest --keep-min 1000 | tail -1)"
[ -f "$ARCHIVE" ] || fail "backup.sh did not produce an archive"
MANIFEST="${ARCHIVE%.tar.zst*}.manifest.json"
IMAGE="$(python3 -c "import json;print(json.load(open('$MANIFEST'))['postgres_image'])")"

say "2/6 scratch postgres (${IMAGE})"
docker run -d --name "$SCRATCH" -e POSTGRES_USER=hoodmint -e POSTGRES_PASSWORD=scratch -e POSTGRES_DB=hoodmint \
  --tmpfs /var/lib/postgresql "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$SCRATCH" pg_isready -U hoodmint -d hoodmint >/dev/null 2>&1 && break; sleep 1
done
docker exec "$SCRATCH" pg_isready -U hoodmint -d hoodmint >/dev/null || fail "scratch postgres never became ready"

say "3/6 + 4/6 restore into scratch (row counts verified by restore.sh)"
scripts/restore.sh "$ARCHIVE" --container "$SCRATCH" --no-safety --no-stop --yes --jobs 4

say "5/6 spot checks"
sq() { docker exec -i "$SCRATCH" psql -U hoodmint -d hoodmint -tAq -c "$1"; }
pq() { docker compose -f docker-compose.prod.yml exec -T postgres psql -U hoodmint -d hoodmint -tAq -c "$1"; }
CHECKS=(
  "select count(*) from projects where lifecycle_status in ('LIVE','NEXT')"
  "select count(*) from drop_stages where not paused"
  "select coalesce(max(created_at)::text,'') from mint_plans"
  "select count(*) from wallets where encrypted_signing_key is not null"
  "select max(id)::text from drizzle.__drizzle_migrations"
)
for q in "${CHECKS[@]}"; do
  a="$(sq "$q")"; b="$(pq "$q")"
  [ "$a" = "$b" ] || fail "spot check differs — '${q}': scratch='${a}' prod='${b}'"
done
# A sealed key survives byte-for-byte (the worker must still be able to open it)
a="$(sq "select coalesce(md5(string_agg(encrypted_signing_key, ',' order by id)),'') from wallets where encrypted_signing_key is not null")"
b="$(pq "select coalesce(md5(string_agg(encrypted_signing_key, ',' order by id)),'') from wallets where encrypted_signing_key is not null")"
[ "$a" = "$b" ] || fail "sealed wallet keys differ after restore"
say "spot checks OK (lifecycle counts, stages, latest plan, sealed keys, migration head)"

say "6/6 tamper test — a modified archive must be rejected"
TAMPERED="${ARCHIVE%.tar.zst.gpg}-tampered.tar.zst.gpg"
cp "$ARCHIVE" "$TAMPERED"
printf '\x00' | dd of="$TAMPERED" bs=1 seek=100 conv=notrunc status=none
if scripts/restore.sh "$TAMPERED" --container "$SCRATCH" --no-safety --no-stop --yes --dry-run >/dev/null 2>&1; then
  fail "tampered archive was accepted"
fi
say "tampered archive rejected as expected"

say "ALL GOOD — backup/restore rehearsal passed against $(basename "$ARCHIVE")"
