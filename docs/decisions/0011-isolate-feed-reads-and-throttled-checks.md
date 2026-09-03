# 0011 — Isolate feed reads and throttled checks

Date: 2026-08-30
Status: accepted

## Context

Production feed requests calculated rolling quantity and distinct recipients directly from more
than six million `mint_events` rows. Several slow requests could occupy the complete six-connection
web pool. Independently, periodic worker tasks used `setInterval`, which allowed a slow provider or
database pass to overlap its next invocation. Eligibility invalidations could also cause every open
browser tab to refresh once per result.

Eligibility verdicts were already persisted by the worker, but feed rendering awaited their read.
That made a slow optional section indistinguishable from a provider check blocking the page.

## Decision

- The worker computes exact rolling one-hour activity into one `mint_activity_snapshots` row per
  active project. Feed requests read that row and expose its computation time.
- Missing snapshots render as `activity pending`; snapshots older than three minutes render as
  stale. Missing data is never presented as a fresh measured zero.
- Feed rows render independently from the persisted stage-scoped eligibility lookup. WL cells show
  a pending state and stream as the shared lookup resolves; no provider SDK is reachable from a
  page component.
- Periodic worker tasks use a completion-based scheduler. The next invocation is armed only after
  the current promise settles. Rate-limit and authentication failures honor the provider delay,
  with a five-minute minimum when no delay is supplied and up to ten percent jitter.
- Provider-error cleanup is best-effort. A parked credential is not resolved again from its own
  error handler, so handled authentication failures do not escape into BullMQ's short retries.
- Browser invalidations are coalesced to at most one refresh per five seconds. Hidden tabs become
  dirty and refresh once after returning to the foreground.

## Consequences

Feed request cost is bounded by normalized project/stage rows plus one snapshot row per project;
it no longer scales with raw mint-event history. Exact rolling distinct-recipient work remains
more expensive, but it is isolated to a non-overlapping worker pass and its freshness is visible.
During initial deployment, affected projects can briefly show pending activity until the first
worker pass completes. Existing eligibility verdicts remain visible while a throttled refresh is
parked.
