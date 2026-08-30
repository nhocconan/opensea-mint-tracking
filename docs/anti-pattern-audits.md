# Anti-pattern audit index

| Concern | Rule | Mechanical audit | Gate |
| --- | --- | --- | --- |
| Stage-scoped WL truth | AGENTS.md §1 | Review-only; enforced by typed `{ projectId, stageId }` repository API and integration fixtures | typecheck + integration |
| Dedicated DB client cleanup | AGENTS.md §2 | Review-only; listener owns cleanup in `subscribeEvents` | integration + production connection probe |
| Snapshot-only reads and non-overlapping jobs | AGENTS.md §3 | `scripts/audit/read-path-boundaries.sh` | `pnpm lint` |
| Provider catch paths do not re-resolve credentials | AGENTS.md §4 | `scripts/audit/read-path-boundaries.sh` | `pnpm lint` |
| Theme maps and selector blocks stay paired | AGENTS.md §5 | `packages/ui/src/theme.test.ts` | `pnpm test` |
| Provider backpressure never enters short queue retry loops | AGENTS.md §6 | `apps/worker/src/scheduler.test.ts` + details processor wrapper | unit + production log probe |
