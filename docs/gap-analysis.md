# Gap analysis — repository vs PRD (2026-08-16)

Baseline inspection before TypeScript implementation, per `AGENTS.md`.
Status legend: ❌ absent · 🟡 partial (Python prototype only) · ✅ done.

## PRD §8 — Technical architecture

| Requirement | Status | Evidence |
|---|---|---|
| Node 24 LTS / TS strict / pnpm workspace | ❌ | No `package.json`, no `pnpm-workspace.yaml`, no `tsconfig` |
| Next.js 16.3 App Router, React 19.2 | ❌ | No `apps/web` |
| Tailwind 4.3, shadcn-style owned components, Radix, Lucide, Recharts | ❌ | No UI package |
| PostgreSQL 18 + Drizzle + generated migrations | ❌ | Prototype uses SQLite |
| Valkey + BullMQ | ❌ | No queue |
| viem RPC provider | ❌ | No on-chain component |
| Better Auth (RBAC, 2FA) | ❌ | No auth |
| Zod boundaries, Pino, OTel, Vitest/Playwright, Biome | ❌ | None |
| Monorepo layout §8.2 + package boundaries | ❌ | Flat Python files |
| Docker topology web/worker/postgres/valkey/migrate | 🟡 | `compose.yaml` runs the single Python watcher |
| Job topology with deterministic IDs §8.4 | ❌ | None |
| SSE realtime §8.5 | ❌ | None |

## PRD §14 — Coding guidelines

- ❌ No TypeScript at all: no `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, branded types, typed error categories, injected time, bigint wei discipline.
- 🟡 Python prototype demonstrates some behavioral invariants (Retry-After handling, alert dedupe) but none of the TS standards.
- ❌ No Biome/format/lint gates, no conventional structure.

## PRD §15 — Test strategy and quality gates

- 🟡 Only `test_monitor.py` (2 unittest cases: eligible-stage extraction, alert dedupe) — preserved in `reference-python-mvp/`.
- ❌ No unit tests for lifecycle status, eligibility classification, scheduling, quota math, dedupe keys, address normalization, stage boundaries.
- ❌ No provider contract fixture tests, no PG/Valkey integration tests, no security tests, no Playwright/axe, no live-smoke gating, no merge-gate script wiring.

## PRD §16 — Docker-first developer experience

- ❌ No `make bootstrap` / `Makefile`; `.env.example` covers only Python-era variables without scope/restart docs.
- ❌ No `/setup` first-admin flow, no walk-through wizard, no discovery-only mode product.
- 🟡 `docker compose up --build` works but only for the prototype watcher.

## PRD §18 — Definition of done

None of the twelve acceptance criteria are currently met: no `/setup`, no admin console, no feed views, no provider resilience proof, no on-chain sync, no alerting pipeline, no encrypted credentials, no RBAC/audit, no provenance labels, no CI gates, no product README.

## Immediate plan (vertical slice order per PRD §17)

1. Foundation: workspace, strict TS, config/core/db packages, compose topology, Makefile, health endpoints, auth bootstrap.
2. OpenSea discovery with fixtures → All/Live/Next/Latest views + provider health.
3. Eligibility: encrypted PAT, JWT exchange, wallet-stage matrix, Eligible feed, deduped outbox alerts.
4. On-chain radar via viem with checkpoints/reorg replay + aggregates.
5. Admin completion + RBAC + audit.
6. Hardening, seed/demo data, README, smoke test.
