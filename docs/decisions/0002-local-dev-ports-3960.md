# 0002 — Local host ports start at 3960

Date: 2026-08-17
Status: accepted
Supersedes: 0001 (port numbers only; light/dark decision stands)

## Context

ADR 0001 published local services on 3950–3953. On this machine 3952/3953
are already bound by another stack (`chatbot-center`). The operator asked
to start the HoodMint sequence at **3960**.

## Decision

- Local/dev **host** ports: web `3960`, Postgres `3961`, Valkey `3962`,
  worker health `3963`.
- Scripts live at `scripts/start-dev.sh` and `scripts/stop-dev.sh`.
  Shared constants: `scripts/dev-ports.sh`.
- Internal container ports stay `5432` / `6379`. Compose still overrides
  `DATABASE_URL` / `VALKEY_URL` to Docker DNS names.

## Consequences

- `.env.example`, config defaults, smoke, e2e, README, and Makefile must
  agree on 3960-series origins.
- `scripts/start-dev.sh` rewrites stale 3950-series host URLs in `.env`.
