#!/usr/bin/env bash
# CARV verifier liveness watchdog.
#
# `restart: always` only reacts to the process DYING. A verifier that wedges
# — stops advancing the chain cursor while the process stays up — keeps
# reporting "Up" forever and silently stops earning. The real liveness signal
# is the chain-query line the worker emits every ~5s:
#
#   {"caller":"worker/chain.go:322", ... "msg":"chain [arbitrum] query: start block N, end block M"}
#
# Absence of that line for WINDOW means wedged, not idle.
#
# journald on this host runs Storage=none, so every decision is also appended
# to LOG_FILE — otherwise a 3am restart would leave no trace at all.
set -uo pipefail

CONTAINER="${CARVNODE_CONTAINER:-carv-carvnode-1}"
COMPOSE_FILE="${CARVNODE_COMPOSE:-/home/carv/docker-compose.yml}"
PROJECT="${CARVNODE_PROJECT:-carv}"
WINDOW_SECS="${CARVNODE_WINDOW_SECS:-600}"
PATTERN='chain \['
DRY_RUN="${CARVNODE_DRY_RUN:-0}"
PAUSE_FILE="${CARVNODE_PAUSE_FILE:-/run/carvnode-watchdog.pause}"
LOG_FILE="${CARVNODE_LOG_FILE:-/var/log/carvnode-watchdog.log}"
LOG_MAX_BYTES="${CARVNODE_LOG_MAX_BYTES:-1048576}"

# Self-capping: no logrotate dependency, and the disk is already 87% full.
log() {
  local line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
  echo "$line"
  if { [ -w "$LOG_FILE" ] || [ -w "$(dirname "$LOG_FILE")" ]; } 2>/dev/null; then
    echo "$line" >> "$LOG_FILE" 2>/dev/null || return 0
    local size
    size=$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$size" -gt "$LOG_MAX_BYTES" ]; then
      tail -n 2000 "$LOG_FILE" > "${LOG_FILE}.tmp" 2>/dev/null \
        && mv "${LOG_FILE}.tmp" "$LOG_FILE" 2>/dev/null
    fi
  fi
}

act() {
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN: would run: $*"
  else
    "$@"
  fi
}

# Escape hatch: `sudo touch /run/carvnode-watchdog.pause` stops the watchdog
# fighting an operator during maintenance. Cleared automatically on reboot.
if [ -e "$PAUSE_FILE" ]; then
  log "paused by ${PAUSE_FILE} -> no action"
  exit 0
fi

state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)" || state="missing"

# Covers the gap `restart: always` cannot: a container left in `created` by an
# interrupted `docker compose up`, or removed entirely.
if [ "$state" != "running" ]; then
  log "carvnode NOT RUNNING (state=${state}) -> compose up"
  act docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d
  exit 0
fi

# Do not fight a container that is still booting: it has not had time to emit.
started="$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER")"
age=$(( $(date +%s) - $(date -d "$started" +%s) ))
if [ "$age" -lt "$WINDOW_SECS" ]; then
  log "carvnode started ${age}s ago (< ${WINDOW_SECS}s grace) -> no stall verdict yet"
  exit 0
fi

lines="$(docker logs --since "${WINDOW_SECS}s" "$CONTAINER" 2>&1 | grep -c "$PATTERN")"
if [ "${lines:-0}" -lt 1 ]; then
  log "carvnode STALLED: 0 chain-query lines in last ${WINDOW_SECS}s -> restarting"
  docker logs --tail 20 "$CONTAINER" 2>&1 | tail -20 >&2
  act docker restart -t 30 "$CONTAINER"
  log "carvnode restart issued"
  exit 0
fi

log "carvnode healthy: ${lines} chain-query lines in last ${WINDOW_SECS}s"
