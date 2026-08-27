# Performance notes (2026-08-22)

No Postgres/Valkey/dev server was running in this environment, so this is a
**static/structural review**, not a load test — flagging that plainly
rather than presenting it as more than it is. If you want real numbers,
`make start-dev` + `k6`/`autocannon` against `/api/v1/projects` and
`/rss/live` is the natural next step; nothing here substitutes for that.

## What was checked and is fine

- **New tables are indexed on their actual query paths**, not just
  primary-keyed: `execution_attempts_status_idx` covers
  `listPendingSignatures`'s `status = 'awaiting_signature'` filter;
  `mint_plans_status_idx` (status, armed_until) covers both
  `claimArmedMintPlan`'s atomic claim and `expireStaleMintPlans`;
  `rpc_endpoints_chain_idx` (chain_id, enabled, priority) matches
  `rankRpcEndpoints`'s exact access pattern; `signals_project_idx` /
  `signals_subject_idx` cover the two ways signals get looked up.
- **No N+1s introduced this session**: every new admin page fetch
  (`/admin/execution`) is a flat `Promise.all` of independent single
  queries, not a loop issuing one query per row. The mint-execution
  worker loop fetches project/wallet/signer as three single-row lookups
  per claimed plan (at most one plan per pass), not a batch scan.
- **RSS feed ships with real HTTP caching**: `cache-control: public,
  max-age=60, stale-while-revalidate=300` — a feed reader polling every
  few minutes won't hit Postgres on every request.
- **Bundle impact of this session's additions is small**: `@better-auth/
  passkey`'s client plugin is only imported from files under
  `admin/execution/*` and the login form — Next's App Router code-splits
  per route by default, so public feed pages (`/`, `/live`, `/next`, the
  new `/calendar`) don't pull in the passkey/WebAuthn client code at all.
  Total `.next/static/chunks` after this session's build: 744K.

## What was NOT done, honestly

- **No load/stress test.** No live server to point `k6`/`autocannon` at.
- **No query plan verification (`EXPLAIN ANALYZE`).** Index *presence* was
  checked against actual `WHERE`/`ORDER BY` clauses; index *selectivity*
  under real data volume was not — that needs a populated database.
- **No new caching layer beyond the RSS route's HTTP headers.** The
  `/api/v1/projects` feed intentionally isn't cached (it's SSE-invalidated
  live data — caching it would mean the dashboard shows stale results
  after its own real-time-update mechanism fires, which would be a
  regression, not an optimization).
- **No profiling of the mint-watch worker loop's interval cost** under
  many concurrent armed plans — `claimArmedMintPlan` claims exactly one
  plan per pass by design (ADR 0005 exactly-once dispatch), so throughput
  under load is bounded by `MINT_WATCH_INTERVAL_SECONDS`, not a query
  bottleneck, but this is reasoning from the design, not a measurement.

## Recommendation, if you want the load-tested version

1. `make start-dev`, `make seed` for demo data at realistic-ish volume.
2. `k6 run` against `/api/v1/projects?view=live`, `/rss/live`, and
   `/admin/execution` with a logged-in session.
3. `EXPLAIN ANALYZE` the `queryFeed` query and `claimArmedMintPlan`'s CTE
   under a seeded dataset an order of magnitude larger than the demo set.

None of this is scheduled — it's a next step, not a promise this session
completed.
