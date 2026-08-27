#!/usr/bin/env bash
# Docker clean-start smoke test (PRD §15/§18): build, boot, wait for health,
# probe endpoints, optionally seed, and report.
set -uo pipefail
cd "$(dirname "$0")/.."

KEEP="${KEEP:-0}"
FAILURES=0

say()  { printf '\033[36m[smoke]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[smoke] FAIL:\033[0m %s\n' "$*"; FAILURES=$((FAILURES+1)); }
pass() { printf '\033[32m[smoke] ok:\033[0m %s\n' "$*"; }

cleanup() {
  if [ "$KEEP" != "1" ]; then
    say "tearing stack down"
    docker compose down -v --remove-orphans >/dev/null 2>&1
  else
    say "KEEP=1 — stack left running"
  fi
}
trap cleanup EXIT

say "validating compose config"
docker compose config --quiet || { fail "docker compose config"; exit 1; }
pass "docker compose config --quiet"

say "clean build + start (volumes removed)"
docker compose down -v --remove-orphans >/dev/null 2>&1
if ! docker compose up --build -d >/tmp/hoodmint-smoke-up.log 2>&1; then
  fail "docker compose up --build (see /tmp/hoodmint-smoke-up.log)"
  tail -30 /tmp/hoodmint-smoke-up.log
  exit 1
fi
pass "docker compose up --build -d"

say "waiting for web /health/ready (max 180s)"
ready=1
for _ in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3960/health/ready || true)
  [ "$code" = "200" ] && { ready=0; break; }
  sleep 2
done
[ "$ready" = "0" ] && pass "web /health/ready = 200" || fail "web /health/ready never became 200"

code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3960/health/live || true)
[ "$code" = "200" ] && pass "web /health/live = 200" || fail "web /health/live = $code"

body=$(curl -s http://localhost:3960/api/v1/system/status || true)
echo "$body" | grep -q '"service":"hoodmint-radar"' && pass "GET /api/v1/system/status envelope" || fail "system/status body: $body"

code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3960/setup || true)
[ "$code" = "200" ] && pass "/setup reachable" || fail "/setup = $code"

code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3960/api/v1/projects || true)
[ "$code" = "200" ] && pass "GET /api/v1/projects = 200" || fail "/api/v1/projects = $code"

worker_healthy=$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null | grep worker || true)
echo "$worker_healthy" | grep -q healthy && pass "worker container healthy" || fail "worker health: $worker_healthy"

migrate_status=$(docker compose ps -a --format '{{.Name}} {{.State}}' | grep migrate || true)
echo "$migrate_status" | grep -q exited && pass "migrate one-shot exited" || fail "migrate state: $migrate_status"

say "running non-root image check"
web_user=$(docker compose exec -T web id -u 2>/dev/null | tr -d '\r\n' || true)
[ "$web_user" = "10001" ] && pass "web runs as uid 10001 (non-root)" || fail "web uid: '$web_user'"

say "migrating + seeding demo dataset"
if pnpm migrate >/dev/null 2>&1 && pnpm seed >/dev/null 2>&1; then
  seeded=$(curl -s 'http://localhost:3960/api/v1/projects?view=all&limit=10' || true)
  count=$(echo "$seeded" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("data", [])))' 2>/dev/null || echo 0)
  [ "${count:-0}" -ge 5 ] && pass "seed produced $count projects in feed API" || fail "seed feed count: $count"
  demo=$(curl -s http://localhost:3960/ | grep -c 'DEMO DATA' || true)
  [ "${demo:-0}" -ge 1 ] && pass "DEMO DATA banner visible on home" || fail "demo banner missing"
else
  fail "seed command failed (migrate/seed)"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32m[smoke] ALL CHECKS PASSED\033[0m\n'
  exit 0
fi
printf '\033[31m[smoke] %d failure(s)\033[0m\n' "$FAILURES"
exit 1
