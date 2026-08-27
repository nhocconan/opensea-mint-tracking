# 0001 — Local host ports 3950+ and first-class light theme

Date: 2026-08-16
Status: superseded-in-part (port numbers → [0002](0002-local-dev-ports-3960.md); light/dark stands)

## Context

PRD §16 documents first-run as `http://localhost:3000` and compose historically
published Postgres `5432` and Valkey `6379`. PRD §5.4 specifies a dark-only
obsidian visual. The current implementation objective requires:

- every host-published local service port in the contiguous sequence starting
  at **3950**;
- a real light theme plus dark, with persistence.

## Decision

- Local/dev **host** ports: web `3950`, Postgres `3951`, Valkey `3952`,
  worker health `3953`. Internal container ports (`5432`, `6379`) stay
  unpublished to the host except via those mappings.
- `APP_URL` / `PORT` defaults become `http://localhost:3950` / `3950`.
  Production compose still overrides `DATABASE_URL` / `VALKEY_URL` to the
  Docker DNS names. PRD §16 `:3000` remains a valid override, not the default.
- Dark remains the **default** theme. Light is a second token map applied
  through `applyTheme` + `data-theme`.

## Consequences

- Operators running another stack on 3000/5432/6379 can start HoodMint
  without collisions.
- Docs, smoke, e2e, and `start-dev.sh` must agree on 3950-series origins.
- Light-mode accent hexes are darker than the PRD lime so text-on-paper
  stays WCAG AA; the dark map keeps the specified `#070908` / `#b8ff2e`.
