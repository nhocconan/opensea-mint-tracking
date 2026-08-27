# Host-published local ports — contiguous sequence from 3960.
# Sourced by start-dev.sh / stop-dev.sh. Internal container ports stay 5432/6379.
# shellcheck shell=bash

HOODMINT_WEB_PORT=3960
HOODMINT_PG_PORT=3961
HOODMINT_VALKEY_PORT=3962
HOODMINT_WORKER_HEALTH_PORT=3963
