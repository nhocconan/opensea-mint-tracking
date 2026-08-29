# 0010 — Stage-scoped WL filter semantics

Date: 2026-08-29
Status: accepted

## Context

A project can have several mint phases and a tracked wallet can have a different eligibility
verdict for each phase. A project-level aggregate can therefore show a whitelist hit from an ended
phase beside the price and countdown for a different current or upcoming phase. The requested
"WL / Not WL" filter is also ambiguous when the exact phase is `UNKNOWN`, `AUTH_REQUIRED`, or has
never been checked.

## Decision

- Every decision-card wallet verdict and WL filter is scoped to the exact `{ projectId, stageId }`
  rendered by that card or calendar event.
- `WL hit` means at least one enabled tracked wallet has `ELIGIBLE_RESTRICTED` for that exact stage.
- The opposite filter is labeled `No WL hit`, not `Not eligible`. It means no tracked wallet has a
  proven WL hit for that exact stage and may therefore include explicit `UNKNOWN`, `AUTH_REQUIRED`,
  `INELIGIBLE_RESTRICTED`, or no-check states. The visible wallet chips retain those distinctions.
- `PUBLIC_ONLY` is never considered a WL hit.

## Consequences

The filter is safe for deciding which mint phase to inspect, but `No WL hit` is not a claim that a
wallet was conclusively rejected. Callers must provide a stage id; project-only aggregation is not
accepted by the decision-card repository API.
