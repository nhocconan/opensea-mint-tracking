# HoodMint Radar — Product Requirements & Engineering Specification

**Status:** Implementation-ready handoff — v1 delivered and accepted (§18 met); scope below is frozen as-shipped, not retroactively edited  
**Target implementer:** Local Codex using GPT-5.6 Sol  
**Prepared:** 2026-08-16  
**Product owner:** Conan / Tien Le  
**Primary chain:** Robinhood Chain mainnet, chain ID `4663`  
**Tracked wallets:** none baked in — added at runtime in Admin → Wallets (optional `DEFAULT_WALLET_ADDRESS` dev prefill only)

> **v2 scope note (2026-08-21):** an opt-in, heavily-gated **Execution**
> capability (minting calendar, X sentiment signal, delegated-custody mint
> execution) is planned as a v2 addition — see
> [`docs/execution-architecture.md`](docs/execution-architecture.md) and
> ADRs 0003–0008. It is layered on top of this contract, not a replacement:
> every non-goal below still holds for the read-only surfaces this PRD
> describes, and v1's "no automated minting" non-goal is superseded only
> for the new, separately-authenticated Execution surface once it ships.

## 1. Executive summary

HoodMint Radar is a self-hosted discovery and allowlist monitoring product for NFT drops on Robinhood Chain. It continuously discovers OpenSea drops and on-chain mint activity, normalizes them into one trustworthy feed, checks one or more wallets for stage-level mint eligibility, and alerts before an allowlist opportunity expires.

The product must solve two separate problems without conflating them:

1. **Discovery:** find candidate collections that are upcoming, live, newly seen, or actively minting.
2. **Eligibility:** determine whether a specific authenticated wallet is eligible for a restricted stage, as distinct from a public mint that is open to everyone.

The application is read-only. It must never hold a wallet private key, sign a spend-bearing transaction, or broadcast a mint. An OpenSea PAT restricted to `read:eligibility` may be stored encrypted and exchanged for short-lived wallet JWTs.

## 2. Product goals

- Provide a fast, attractive web dashboard with **All**, **Live**, **Next**, **Latest**, **Eligible**, and **Watchlist** views.
- Discover OpenSea-hosted drops through the official Drops API and catch smaller/non-featured projects through Robinhood Chain mint logs.
- Show per-stage eligibility for configured wallets and label public-only stages clearly so they are never reported as whitelist wins.
- Deliver deduplicated Telegram and generic webhook alerts with enough context to act immediately.
- Let an administrator configure API credentials, wallets, sources, polling policies, RPC endpoints, and alert channels from the web UI.
- Start locally with one command using Docker Compose, with health checks and automatic database migrations.
- Preserve source provenance and raw evidence so every displayed claim is explainable.
- Stay comfortably within OpenSea's free-tier limit under normal use.

## 3. Non-goals for v1

- No automated minting, transaction signing, wallet custody, or private-key storage.
- No marketplace trading, floor-price sniping, rarity ranking, portfolio management, or financial recommendations.
- No claim that a custom Merkle allowlist can be enumerated from its root.
- No promise of exhaustive discovery for non-standard/eventless NFT contracts.
- No multi-chain UI in v1, although provider and schema boundaries must not hard-code Robinhood-specific assumptions.
- No public multi-tenant SaaS billing. v1 is a single deployment with multiple admin-created users and wallets.

## 4. Users and primary jobs

### Owner/admin

The owner wants to enter OpenSea credentials, register wallets, configure Telegram/webhooks, tune scan intervals, verify system health, and inspect audit history without editing environment variables after bootstrap.

### Degen/operator

The operator wants to open one dashboard and immediately answer: what is minting now, what starts next, what was just discovered, which wallets are eligible, how much time remains, and where the verified mint link is.

### Read-only viewer

A viewer can inspect feeds and project detail but cannot see secrets, change configuration, trigger privileged rescans, or manage users.

## 5. Information architecture and UX

### 5.1 Global shell

Desktop uses a compact left rail and a dense main canvas. Mobile uses a bottom navigation bar. The header contains global search, command palette (`⌘K`/`Ctrl+K`), chain health, last successful scan, quota remaining, and a live connection indicator.

Primary navigation:

- **Pulse:** operational overview, mint velocity, new collections, active alerts.
- **All:** every normalized project, filterable and sortable.
- **Live:** at least one active mint stage, not sold out or paused.
- **Next:** future stage ordered by nearest start time.
- **Latest:** newly discovered projects ordered by `firstSeenAt`.
- **Eligible:** restricted-stage hits grouped by wallet; public-only never appears as a hit.
- **Watchlist:** manually starred projects regardless of status.
- **Admin:** role-gated configuration and health area.

The selected tab, filters, sort, page size, and search term must live in URL query parameters so views are linkable and survive refresh.

### 5.2 Drop card/list row

Every result must show:

- Cover/avatar, collection name, verified OpenSea link, contract and copy button.
- Status chip: `LIVE`, `NEXT`, `NEW`, `ENDED`, `SOLD OUT`, `PAUSED`, or `UNKNOWN`.
- Source badges: OpenSea, SeaDrop on-chain, generic mint log, calendar/manual.
- Confidence: `verified`, `corroborated`, `single-source`, or `unverified`.
- Current/next stage label, stage type, price, max per wallet, start/end countdown in local time and UTC tooltip.
- Supply minted/max and percentage only when both values are verifiable. Never infer a cap.
- Mint velocity over 5m/1h and unique minters over 1h when on-chain data exists.
- Wallet eligibility chips: `WL`, `NOT WL`, `PUBLIC ONLY`, `AUTH NEEDED`, `UNKNOWN`, or `ERROR`.
- Watch button and direct mint link. The app does not produce a signing prompt.

Provide a dense table view and a visual card view. Default to dense table on desktop and cards on mobile.

### 5.3 Project detail

The detail page must contain:

- Hero summary and primary verified links.
- Stage timeline with exact boundaries and live countdown.
- Wallet-by-stage eligibility matrix.
- Supply and mint-velocity charts with accessible descriptions.
- Recent on-chain mint events with transaction/explorer links.
- Source evidence panel showing provenance, fetched time, freshness, and conflicts.
- Raw normalized JSON downloadable by an admin; secrets and auth headers must never be included.
- Scan history and error history.

### 5.4 Visual direction

The product should feel degen-native without becoming unreadable. Use an obsidian base (`#070908`), acid-lime primary, cyan information accents, restrained magenta for exceptional signals, and high-contrast neutral text. Use `Space Grotesk` or equivalent for display and `Geist Mono` for addresses, times, and metrics.

Use subtle grid/noise texture, live pulse dots, crisp 1px borders, compact number typography, and short motion (120–180ms). Avoid casino clichés, excessive gradients, permanent glow, bouncing elements, or low-contrast glassmorphism. Respect `prefers-reduced-motion`; all status must be communicated by text/icon as well as color. Minimum WCAG AA contrast and complete keyboard navigation are release requirements.

### 5.5 Empty, loading, stale, and failure states

- Skeletons must preserve layout and never replace the full page with a spinner.
- Empty feeds explain why and offer a relevant action such as “Run scan” or “Add wallet auth.”
- Data older than its source-specific freshness threshold must show `STALE` with the last successful timestamp.
- Partial provider failure must not blank the dashboard. Serve cached data, mark the failed source, and expose retry state.

## 6. Status semantics

All status computation belongs to the domain package and must have deterministic unit tests.

- `LIVE`: a stage satisfies `start <= now < end`, is not paused, and known remaining supply is greater than zero. Unknown supply does not block `LIVE`.
- `NEXT`: no live stage; at least one future stage exists. Order by earliest start.
- `LATEST`: presentation category based on `firstSeenAt`, not a lifecycle status.
- `SOLD_OUT`: max supply and minted supply are both verified and remaining equals zero.
- `ENDED`: all known stages ended and the drop is not sold out.
- `PAUSED`: the authoritative source explicitly reports paused.
- `UNKNOWN`: insufficient or conflicting data.

Eligibility states:

- `ELIGIBLE_RESTRICTED`: at least one non-public stage explicitly returns eligible.
- `INELIGIBLE_RESTRICTED`: restricted stages exist and authenticated API explicitly returns false for all.
- `PUBLIC_ONLY`: only public eligibility is present; not a whitelist win.
- `AUTH_REQUIRED`: eligibility could be checked but wallet auth is missing/expired.
- `UNKNOWN`: the provider cannot determine eligibility.
- `ERROR`: a check failed; display reason category, never secrets or raw headers.

## 7. Functional requirements

### 7.1 Discovery providers

Implement a provider interface with typed capabilities and independent health state.

**OpenSea Drops provider — required**

- Resolve the current OpenSea chain identifier from `GET /api/v2/chains` by matching chain ID `4663`; do not rely only on a hard-coded string.
- Poll `GET /api/v2/drops` for `featured`, `upcoming`, and `recently_minted`, with chain filter, cursor pagination, and a configurable maximum page count.
- Fetch `GET /api/v2/drops/{slug}` for new projects, stale detail, and stage-boundary refresh.
- Cache ETags or conditional-response metadata when available.
- Persist rate-limit response headers and expose remaining/reset in Admin.
- Honor `Retry-After`; use exponential backoff with full jitter for retryable failures.

**Robinhood on-chain provider — required before v1 release**

- Use an HTTP RPC for correctness and optional WebSocket RPC for low-latency hints.
- Track blocks with a durable checkpoint and adaptive `eth_getLogs` ranges.
- Decode ERC-721/1155 mint transfers and SeaDrop activity, including OpenSea SeaDrop at `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`.
- Treat WebSocket messages as hints; reconcile every event through HTTP RPC.
- Handle reorgs by retaining block hash, marking events unfinalized, and replaying a configurable safety window.
- Aggregate 5m/1h mint count and unique-recipient metrics.
- Never represent rolling-window activity as total supply.

**Calendar/manual providers — optional adapters**

- Calendar data may create a candidate but must be labelled unverified until corroborated.
- Admin can add a slug or contract manually and force discovery/detail refresh.
- Scrapers must be isolated adapters with fixture-based contract tests; DOM changes may not crash other providers.

### 7.2 Normalization and identity

Canonical identity is `(chainId, contractAddress)` when contract is known. Until then use a source-scoped external ID, merge later transactionally, preserve aliases, and never create duplicate user-visible projects. Every normalized field stores winning source, observed timestamp, and optional evidence reference.

Conflict policy: on-chain state wins for contract identity and observed mints; OpenSea wins for its own stage schedule/eligibility; explicit verified max supply wins over inferred values; the UI exposes unresolved conflicts instead of silently choosing an attractive number.

### 7.3 Eligibility engine

- Admin registers display-only wallet addresses separately from authentication credentials.
- An OpenSea PAT must be scoped only to `read:eligibility`, encrypted at rest, and exchanged server-side for a roughly 12-hour wallet JWT.
- Call `GET /api/v2/drops/{slug}/eligibility` per wallet/drop when applicable.
- Store normalized result plus a sanitized evidence payload and check timestamp.
- Never treat public eligibility as a restricted allowlist hit.
- Do not use `POST /mint` as the primary verdict. A `422` can represent ineligibility, insufficient balance, exhausted supply, or limit reached.
- Add an adapter boundary for future project-specific or simulation-based eligibility checks.

Use a quota-aware schedule rather than blindly checking every drop every five minutes:

- Stage more than 24h away: eligibility every 6h.
- Stage 1–24h away: every 30m.
- Stage less than 1h away or live: every 5m.
- Restricted eligible hit: alert immediately, then recheck at stage/config changes and every 30m while live.
- Ended/sold-out: stop recurring eligibility checks.

### 7.4 Alerts

Required channels: Telegram Bot API and generic HTTPS webhook compatible with Slack/Discord-style payloads. Channel adapters implement `validate`, `sendTest`, and `send`.

Alert events:

- Restricted eligibility newly becomes true.
- Eligible stage starts in configurable windows (default 60m, 15m, 5m).
- Watched project becomes live.
- Watched project is nearing sellout only when max and current supply are verified.
- Source/auth failure exceeds configurable duration.

Deduplication key must include tenant/deployment, wallet, project, stage identity, alert type, and threshold. Sending must use an outbox table and retry independently. Persist status, attempt count, sanitized response, and next retry. Never mark an alert sent before the provider acknowledges it.

### 7.5 Admin console

Routes under `/admin` require `admin` role. Required sections:

- **Overview:** provider status, queue depth, job failures, last scans, DB/RPC latency, OpenSea quota.
- **Sources:** enable/disable provider, polling intervals, page/range limits, RPC endpoints, test connection.
- **OpenSea:** enter/replace/revoke API key and wallet PAT, show masked fingerprint/expiry/scope, test API and eligibility access.
- **Wallets:** add address, label, enable/disable, assign auth credential, test one known slug.
- **Alerts:** Telegram/webhook configuration, severity filters, quiet hours, test delivery.
- **Users:** invite/create user, role change, disable session; bootstrap admin only in v1.
- **Audit log:** actor, action, target, timestamp, result, request correlation ID; never secret values.
- **System:** scan now, retry failed job, data retention, export sanitized diagnostics.

Secret fields are write-only after save. UI shows only last four characters or a one-way fingerprint. Test buttons return categorized success/failure without echoing secrets.

### 7.6 Authentication and roles

Use Better Auth with its admin and two-factor plugins, PostgreSQL persistence, secure HTTP-only cookies, and same-site protection. Bootstrap the first admin from `/setup` using a one-time token printed to server logs or generated by `make bootstrap`; disable public signup after initialization.

Roles: `admin`, `operator`, and `viewer`. Operators may manage watchlists, wallets, and run scans but not credentials/users. Viewers are read-only. All authorization must be enforced server-side; hiding a button is not authorization.

### 7.7 Search, filters, and exports

Search name, slug, and exact contract/address. Filters include status, source, confidence, price/free, eligibility, watched, and first-seen range. Sort by start time, latest seen, mint velocity, minted percentage, and name. Admin can export the current normalized result set as CSV or JSON without raw provider secrets.

## 8. Technical architecture

### 8.1 Stack baseline

Use stable releases available at implementation time and commit an exact lockfile. The verified baseline for this handoff is:

- Node.js 24 LTS, TypeScript strict mode, pnpm workspace (current stable major).
- Next.js 16.3 App Router and React 19.2.
- Tailwind CSS 4.3, shadcn/ui source-owned components, Radix primitives, Lucide icons, Recharts 3.
- PostgreSQL 18 and Drizzle ORM with generated, reviewed SQL migrations.
- Valkey 8-compatible Redis protocol and BullMQ for repeatable/delayed jobs.
- viem for EVM RPC, ABI decoding, checksums, and chain types.
- Better Auth for session auth, RBAC/admin, and 2FA.
- Zod at every external/config boundary.
- Pino structured logging and OpenTelemetry traces/metrics.
- Vitest for unit/contract tests and Playwright for end-to-end tests.
- Biome for formatting/linting plus `tsc --noEmit`; add ESLint only for rules Biome cannot express, especially React hooks if required by the selected Next release.

Do not swap core technologies merely because a newer library exists. Record any deviation in an ADR with operational benefit and migration cost.

### 8.2 Monorepo layout

```text
apps/
  web/                 Next.js UI, route handlers, SSE
  worker/              BullMQ workers and schedulers
packages/
  auth/                Better Auth config and authorization helpers
  config/              validated env/runtime settings
  core/                domain types, status/eligibility rules
  db/                  Drizzle schema, repositories, migrations
  providers/           OpenSea, Robinhood RPC, calendar/manual adapters
  queues/              job contracts, schedulers, idempotency
  notifications/       Telegram and webhook adapters
  observability/       logging, metrics, tracing
  ui/                  design tokens and shared components
infra/
  docker/              production Dockerfiles and entrypoints
scripts/               bootstrap, backup, fixtures, smoke tests
reference-python-mvp/  reference logic from this handoff; not production runtime
```

Enforce package boundaries. `apps/*` orchestrate; domain logic lives in `packages/core`; providers cannot import UI; web cannot call provider SDKs directly; workers operate through repositories and queue contracts.

### 8.3 Runtime topology

Docker Compose services:

- `web`: Next.js standalone production server.
- `worker`: ingestion, eligibility, and notification workers.
- `postgres`: durable source of truth.
- `valkey`: queue and short-lived cache only; no unique durable state.
- `migrate`: one-shot migration service that must succeed before web/worker become healthy.

Use multi-stage, non-root Docker images, read-only root filesystem where practical, `tini`/correct signal handling, explicit health checks, resource limits in example compose, and named volumes for PostgreSQL/Valkey. The application must also support external managed PostgreSQL/Redis/RPC via environment variables.

### 8.4 Job topology

Queues and deterministic job IDs:

- `discovery`: `discover:opensea:{type}:{window}` and provider-specific discovery.
- `details`: `detail:{provider}:{externalId}:{freshnessBucket}`.
- `chain-sync`: `chain:4663:{fromBlock}:{toBlock}`.
- `eligibility`: `eligibility:{walletId}:{dropId}:{stageVersion}`.
- `notifications`: outbox row ID.
- `maintenance`: retention, aggregation, credential refresh, stale checks.

Workers must be idempotent and safe under at-least-once delivery. Use DB unique constraints and transactions, not in-memory locks, as the final defense. BullMQ retries use exponential backoff with jitter; non-retryable auth/schema failures move directly to failed state with operator guidance.

### 8.5 Realtime updates

Use Server-Sent Events for dashboard invalidation/status updates. The client receives small typed events and refetches affected queries; do not stream entire project payloads. Fall back to 30-second polling when SSE disconnects. Do not add WebSockets unless a documented bidirectional requirement appears.

## 9. Data model

Use UUIDv7 or monotonic equivalent for application IDs, `timestamptz` for time, lowercase checksum-independent address columns plus separately formatted display address, and JSONB only for evidence/raw payloads—not as a substitute for relational fields.

Required tables:

- `users`, `sessions`, `accounts`, `two_factor` — Better Auth managed.
- `wallets(id, address, label, enabled, credentialId, createdAt, updatedAt)`.
- `credentials(id, type, name, ciphertext, keyVersion, fingerprint, expiresAt, metadata, createdBy, updatedAt)`.
- `providers(id, kind, enabled, config, healthStatus, lastSuccessAt, lastErrorCode)`; secret config is referenced by credential ID.
- `projects(id, chainId, contractAddress, name, slug, imageUrl, confidence, lifecycleStatus, firstSeenAt, lastSeenAt)`.
- `project_aliases(projectId, providerId, externalId)` with unique provider/external ID.
- `project_fields(projectId, field, valueJson, providerId, observedAt, evidenceId, isWinner)` for provenance/conflicts where needed.
- `drop_stages(id, projectId, providerStageId, version, label, type, priceWei, currency, maxPerWallet, startsAt, endsAt, paused, rawEvidenceId)`.
- `supply_snapshots(projectId, blockNumber, minted, maxSupply, observedAt, source, verified)`.
- `mint_events(chainId, txHash, logIndex, blockNumber, blockHash, projectId, recipient, quantity, finalized, observedAt)` with unique `(chainId, txHash, logIndex)`.
- `mint_aggregates(projectId, bucketStart, bucketSize, quantity, uniqueRecipients)`.
- `eligibility_checks(walletId, projectId, stageId, status, maxMintable, priceWei, checkedAt, expiresAt, evidenceId, errorCode)`.
- `watchlist_entries(userId, projectId, createdAt)`.
- `evidence(id, providerId, kind, fetchedAt, contentHash, sanitizedPayload)`.
- `alert_rules`, `alert_channels`, `notification_outbox`, `notification_attempts`.
- `scan_runs(id, providerId, kind, startedAt, finishedAt, status, counts, errorCode, correlationId)`.
- `chain_checkpoints(chainId, providerId, blockNumber, blockHash, updatedAt)`.
- `audit_logs(id, actorUserId, action, targetType, targetId, result, metadata, correlationId, createdAt)`.

Indexes must cover feed queries `(lifecycleStatus, nextStageStart)`, `(firstSeenAt desc)`, project contract lookup, pending outbox, due eligibility, and mint-event block ranges. Validate query plans with realistic seed volume.

## 10. HTTP/API contracts

Expose versioned JSON endpoints using Next route handlers and publish generated OpenAPI documentation.

Public/authenticated read routes:

```text
GET /api/v1/projects?view=all|live|next|latest|eligible|watchlist
GET /api/v1/projects/:id
GET /api/v1/projects/:id/stages
GET /api/v1/projects/:id/mints?window=1h
GET /api/v1/wallets/:id/eligibility
GET /api/v1/system/status
GET /api/v1/events                 SSE
```

Admin routes:

```text
GET|POST|PATCH /api/v1/admin/providers
POST           /api/v1/admin/providers/:id/test
GET|POST|PATCH /api/v1/admin/credentials
POST           /api/v1/admin/credentials/:id/test
GET|POST|PATCH /api/v1/admin/wallets
GET|POST|PATCH /api/v1/admin/alert-channels
POST           /api/v1/admin/alert-channels/:id/test
POST           /api/v1/admin/scans
GET            /api/v1/admin/scan-runs
GET            /api/v1/admin/audit-logs
```

Responses use a consistent envelope with `data`, optional `meta`, and RFC 9457 Problem Details for errors. Generate correlation IDs at ingress. Validate request and response schemas with Zod. Use cursor pagination, never unbounded offset scans.

## 11. Security and privacy

- Never request, accept, log, or store seed phrases/private keys.
- Encrypt API keys, PATs, bot tokens, webhook secrets, and RPC credentials using AES-256-GCM or libsodium authenticated encryption with `APP_ENCRYPTION_KEY`; store nonce/tag/key version.
- Support key rotation by decrypt-old/encrypt-new background migration.
- Keep secrets server-side; no secret may enter RSC props, browser bundles, SSE events, error trackers, or exports.
- Redact `Authorization`, cookies, API keys, wallet PAT/JWT, webhook URLs with embedded secrets, and response bodies that may contain credentials.
- Disable arbitrary webhook destinations by default. Require HTTPS, reject loopback/link-local/private IPs after DNS resolution, do not follow redirects, and enforce timeout/body limits to prevent SSRF.
- Apply CSP, HSTS in production, secure cookies, origin/CSRF protection, login rate limiting, and session revocation.
- Validate all external URLs and images. Proxy remote images or configure a strict allowlist; never pass arbitrary SVG through unsanitized.
- Record all credential/user/config changes in immutable audit logs without before/after secret values.
- Dependency installs must use a frozen lockfile. Configure pnpm build-script allowlisting and automated vulnerability/license checks.
- Containers run non-root; database and Valkey are not exposed publicly in production compose.

## 12. Reliability, quota, and cost

OpenSea's documented instant free tier allows 600 read requests/hour and 30 writes/hour; instant keys expire after seven days. Store `X-RateLimit-*`, stop before exhaustion using a configurable reserve (default 10%), and rotate managed instant keys before expiry. A persistent Developer Portal key is preferred for production.

Discovery makes three base list requests per cycle before pagination. Base usage:

| Interval | Cycles/day | Reads/day | Reads/month | Reads/hour |
|---|---:|---:|---:|---:|
| 5m | 288 | 864 | 25,920 | 36 |
| 10m | 144 | 432 | 12,960 | 18 |
| 20m | 72 | 216 | 6,480 | 9 |

With `N` eligibility candidates checked every cycle, estimate `(3 + N) × cycles`. For 20 candidates at 5m, that is 6,624 reads/day and 276/hour, still within the free tier before pagination/retries. The dynamic eligibility schedule in this PRD should use much less.

Set SLOs for a single-node deployment:

- 99% of successful OpenSea discovery cycles complete within 60 seconds.
- Live on-chain activity appears within 30 seconds when WebSocket is healthy, within 2 minutes via HTTP reconciliation.
- Eligible alert enqueued within 60 seconds of a successful eligibility verdict.
- Dashboard cached p95 under 500ms; uncached feed p95 under 1.5s on the reference machine.
- No lost durable alerts during web/worker restart.

## 13. Observability and operations

Use JSON logs with timestamp, level, service, event name, correlation ID, job ID, provider, duration, and categorized outcome. Do not log raw third-party payloads by default.

Expose `/health/live`, `/health/ready`, and Prometheus-compatible `/metrics`. Minimum metrics: scans total/duration/failures, provider freshness, rate-limit remaining, RPC lag, chain checkpoint, queue depth/age, job retries, eligibility verdicts, alert delivery, DB pool saturation, and SSE clients.

OpenTelemetry spans cover inbound request, queue enqueue/dequeue, provider call, DB transaction, and alert attempt. A sanitized diagnostics export contains versions, health, config flags, recent categorized errors, and quota—but no secrets or full wallet-auth evidence.

Back up PostgreSQL, not Valkey. Document restore and run a restore smoke test. Default retention: raw evidence 30 days, scan runs 90 days, mint events 180 days, aggregates/audit logs indefinitely unless admin changes policy.

## 14. Coding guidelines and standards

### TypeScript and domain design

- Enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, and `noImplicitOverride`.
- `any`, non-null assertions, and `@ts-ignore` are forbidden without a documented, narrowly scoped justification.
- External data starts as `unknown` and is parsed once through Zod. Never cast provider JSON to a domain type.
- Use branded types for chain ID, address, wei, project ID, stage ID, and UTC timestamp where confusion is costly.
- Domain functions are pure and time is injected. Tests must not depend on wall-clock time.
- Errors use typed categories (`AuthRequired`, `RateLimited`, `RetryableProvider`, `InvalidPayload`, `PermanentConfig`) and preserve safe causal context.
- Amounts use `bigint`/decimal strings; never JavaScript `number` for wei, supply, or block number.
- All stored times are UTC; locale/time-zone conversion happens at the UI boundary.

### React/Next.js

- React Server Components are the default. Add `"use client"` only to interactive islands.
- Do not fetch internal HTTP endpoints from Server Components; call the application service/repository directly.
- Keep mutations in validated server actions or route handlers with server-side authorization.
- Avoid global client state for server data. Use URL state and server rendering; use TanStack Query only where live client caching materially helps.
- Components must have loading, empty, stale, error, keyboard, reduced-motion, and mobile behavior.
- No raw hex address without copy affordance and explorer link.
- Images require fixed aspect ratio/fallback to avoid layout shift.

### Database and jobs

- Schema changes require a generated SQL migration committed with the code. Never use `drizzle-kit push` in production.
- Applied migrations are immutable. Destructive changes use expand/migrate/contract phases.
- Repository methods accept a transaction where atomicity matters.
- Every recurring/background job has an idempotency key, timeout, retry policy, and dead-letter/operator path.
- Persist the provider result before acknowledging a queue job.
- Avoid N+1 feed queries; assert query count in integration tests for core pages.

### Providers and networking

- Every external call has connect/overall timeout, abort signal, bounded body, categorized errors, rate-limit handling, and structured metrics.
- Retry only idempotent operations and retryable statuses; use exponential backoff with full jitter.
- Provider adapters return domain-neutral DTOs plus evidence; normalization makes business decisions.
- Contract fixtures are sanitized real responses and include malformed/partial/rate-limited cases.
- Do not scrape when an official API or on-chain source provides the same data.

### Style and repository hygiene

- Biome is authoritative formatting; no manual style debates in review.
- Naming: `camelCase` variables/functions, `PascalCase` components/types, `kebab-case` route folders, `SCREAMING_SNAKE_CASE` environment variables.
- Prefer named exports. Keep files focused; split at coherent boundaries rather than arbitrary line counts.
- Comments explain invariants and reasons, not syntax.
- Conventional Commits; each commit must build and have relevant tests.
- ADRs are required for core stack changes, new durable infrastructure, or security-sensitive behavior.

## 15. Test strategy and quality gates

### Required tests

- Unit tests for lifecycle status, eligibility classification, scheduling, quota math, dedupe keys, address normalization, and stage boundaries.
- Provider contract tests from fixtures for all success/error/pagination shapes.
- Integration tests with real PostgreSQL and Valkey containers for migrations, repositories, queues, idempotency, outbox, and reorg replay.
- Security tests for RBAC, secret redaction/encryption, CSRF, webhook SSRF, and disabled-user sessions.
- Playwright E2E for bootstrap, login, API/PAT configuration, wallet creation, feed filters, eligibility hit, test alert, and mobile navigation.
- Accessibility checks with axe plus manual keyboard/reduced-motion verification.
- A live smoke test gated by explicit environment variables; it must never run in normal CI or print credentials.

### Merge gates

```text
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:e2e
docker compose config --quiet
```

Target at least 90% branch coverage for `core`, credential encryption, quota scheduler, and notification dedupe; 80% global branch coverage. Coverage is not a substitute for boundary/error tests.

## 16. Docker-first developer experience

Required first-run flow:

```bash
cp .env.example .env
make bootstrap          # generates local secrets; never overwrites existing values
docker compose up --build
# open http://localhost:3000/setup
```

`/setup` creates the first admin via one-time bootstrap token, then walks through OpenSea key, read-only wallet PAT, wallet address, Telegram/webhook, and connection tests. The dashboard must be useful in discovery-only mode when wallet auth is omitted.

Required commands:

```text
make up / down / logs / ps
make test / lint / typecheck / verify
make migrate / migration name=...
make seed / reset-dev
make backup / restore file=...
make smoke
```

`.env.example` documents every variable, default, required scope, and whether restart is needed. No secret has an insecure production default. Compose health checks must prevent web/worker readiness before migrations and dependencies are ready.

## 17. Delivery plan

Implement vertical slices in this order; each phase must remain runnable:

1. **Foundation:** monorepo, Docker Compose, migrations, auth/bootstrap, design tokens, CI gates, health endpoints.
2. **OpenSea discovery:** chain resolution, three feed types, pagination, normalization, All/Live/Next/Latest UI, Admin source health.
3. **Wallet eligibility:** encrypted PAT, token exchange/refresh, wallet-stage matrix, Eligible feed, deduplicated Telegram/webhook outbox.
4. **On-chain radar:** checkpointed log sync, SeaDrop/generic mint decoding, reorg handling, velocity/unique-minter charts.
5. **Admin completion:** users/RBAC/2FA, audit, runtime policies, test actions, diagnostics export.
6. **Hardening:** accessibility, load/query-plan tests, backup/restore, threat review, docs, production compose.

Do not build all backend layers before showing UI. Phase 2 must provide an end-to-end feed using real OpenSea data; phase 3 must demonstrate one eligibility fixture and one authenticated live check when credentials are supplied.

## 18. Definition of done / acceptance criteria

v1 is done only when:

- A clean machine can reach `/setup` after the documented Docker commands.
- Admin can securely configure/test an OpenSea key, read-only PAT, wallet, RPC, and alert channel through the UI.
- All/Live/Next/Latest/Eligible/Watchlist views work on desktop and mobile with shareable filters.
- OpenSea discovery survives pagination, malformed rows, 429, expired instant key, and one provider outage.
- On-chain sync resumes after restart, deduplicates logs, and passes a simulated reorg test.
- Restricted eligible stages alert once per configured threshold; public-only stages never create whitelist-hit alerts.
- Credential values are encrypted in DB, masked in UI, absent from logs/browser/error responses, and covered by tests.
- RBAC is enforced server-side and audited.
- Feed claims expose freshness and provenance; stale/partial data is visibly labelled.
- CI quality gates pass and the production Docker image runs non-root.
- README includes architecture, quickstart, credential scopes, operating costs, backups, limitations, and troubleshooting.

## 19. Seed/demo data

Include deterministic seed data for at least: one live public drop, one upcoming signed presale with an eligible wallet, one ineligible signed presale, one public-only result, one sold-out drop, one stale provider, one conflicting-source record, and one alert retry. Demo mode must be visually identical to live mode but carry a persistent `DEMO DATA` banner.

Use `robindroids5000` as an optional manual smoke-test slug, not a permanent fixture assumption. The default wallet may be prefilled only in local development and must be configurable.

## 20. Source references verified for this handoff

- OpenSea API keys and free-tier limits: https://docs.opensea.io/reference/api-keys
- OpenSea Drops discovery: https://docs.opensea.io/reference/get_drops
- OpenSea authenticated eligibility: https://docs.opensea.io/reference/get_drop_eligibility
- OpenSea wallet authentication/PAT/JWT: https://docs.opensea.io/reference/auth
- OpenSea programmatic drop guide: https://docs.opensea.io/docs/mint-from-a-drop
- Robinhood Chain explorer/RPC context: https://docs.robinscan.io/
- SeaDrop reference implementation: https://github.com/ProjectOpenSea/seadrop
- Next.js 16.3 release: https://nextjs.org/blog/next-16-3
- React 19.2 release: https://react.dev/blog/2025/10/01/react-19-2
- Tailwind CSS 4.3 release: https://tailwindcss.com/blog/tailwindcss-v4-3
- PostgreSQL 18 release: https://www.postgresql.org/about/news/postgresql-18-released-3142/
- GPT-5.6 Sol official model page: https://developers.openai.com/api/docs/models/gpt-5.6-sol

## 21. Existing prototype

The handoff archive includes a small standard-library Python monitor (`monitor.py`, tests, Dockerfile). It demonstrates OpenSea discovery, API-key acquisition, PAT/JWT eligibility flow, SQLite deduplication, and Telegram/webhook delivery. Treat it as behavioral reference only; do not evolve it into the production architecture. During scaffold, move it unchanged to `reference-python-mvp/` and preserve its tests until equivalent TypeScript coverage exists.
