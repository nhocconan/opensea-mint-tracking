# Execution architecture — from radar to personal minting assistant

Date: 2026-08-21, updated 2026-08-22 (twice) · Status: roadmap accepted; Phase 0 landed; **Phase 1 is now code-complete end-to-end** (draft → WebAuthn-gated arm → worker pipeline → simulate → shadow-log or browser-wallet sign prompt → broadcast recorded), shadow mode default, zero server custody, typecheck/build-verified but not live-tested (no DB/browser in this environment); Phases 2–3 remain not built, blocked on the owner's own hardware/accounts
Produced by: a six-expert panel (Blockchain Security, Low-Latency/Trading
Systems, Data/Sentiment, CPO, Risk/Compliance/SRE, CTO/Systems Architect),
synthesized, red-teamed, and revised — orchestrated per `/goal`. See
[`docs/decisions/0003`](decisions/0003-scope-the-read-only-invariant-to-per-surface-not-per-app.md)
through [`0008`](decisions/0008-rollout-gate-sequence-and-layered-kill-switch-for-live-execution.md)
for the individual decisions this document indexes.

This is the living design doc for HoodMint Radar's evolution from a
strictly-read-only discovery/eligibility radar into a personal assistant that
also tracks a minting calendar, surfaces crypto-Twitter/X risk-and-hype
signal, and — as an explicit, opt-in, heavily-gated capability — can execute
a mint on the owner's behalf. **Nothing in this repository signs a
transaction or holds a spend-capable key today.** Phase 0 (below) is the only
phase implemented so far, and it is zero-custody by design.

## Why this document exists

The owner's directive was broad, urgent, and explicitly delegated ("do not
ask me as I am sleeping"). The existing product had a load-bearing, absolute
claim — "the application is strictly read-only... never holds a private key,
never signs, never broadcasts a mint" — printed in README, PRD.md, and
DESIGN.md. Honoring the directive without quietly breaking that claim, or
without shipping something reckless with real money, required resolving real
engineering conflicts (which custody pattern, which chain-ordering model,
what X access actually costs in 2026) before writing any code. That's what
the panel did; this document and the ADRs are its record.

## Product identity, v2

> HoodMint Radar tracks and evaluates every mint opportunity with zero
> custody by default. Tracking, eligibility-checking, and sentiment/risk
> evaluation are always 100% read-only — no signing key exists on those code
> paths, ever, in any phase. A separate, distinctly named, step-up-
> authenticated "Execution" capability lets the owner arm exactly one
> collection + one purpose-built execution wallet + one spend ceiling + one
> time window at a time; a delegated, on-chain-capped session key may then
> fire a single transaction on the owner's behalf, with the recipient of
> every mint hard-pinned on-chain to the owner's own Safe so a compromised
> host can spend money but can never redirect the asset. The Ledger hardware
> wallet is never an automated signer in any phase — it is the vault that
> receives mints and the rare, deliberate hand that grants or revokes the
> delegation, physically tapped only for chain-onboarding, per-collection
> allowlist entries, and permission changes, never for a per-mint signature.
> "Radar, not a casino" still describes the great majority of the product;
> Execution is the opt-in, magenta-striped exception — never the default,
> never a global toggle, never sold as a guaranteed win against bots.

See [ADR 0003](decisions/0003-scope-the-read-only-invariant-to-per-surface-not-per-app.md)
for the exact README/PRD/DESIGN.md wording change this implies.

## Roadmap

| Phase | Name | Custody | Status |
|---|---|---|---|
| 0 | Foundation — read-only extensions, zero execution risk | none | **landed 2026-08-21** |
| 1 | Execution scaffolding — dry-run + browser-wallet-signed only | none server-side | **backend + WebAuthn arm/disarm landed 2026-08-22 (shadow mode default); final browser-sign UI step not built** |
| 2 | Delegated custody, real automated broadcast — Robinhood Chain, single collection | EIP-7702 + Safe/Zodiac (or Executor fallback) | not started — blocked on owner action, see below |
| 3 | Deliberate broadening — more standards/collections first, chains last | same as Phase 2, repeated per chain | not started |

Full deliverables and safety gates for every phase are in
[ADR 0008](decisions/0008-rollout-gate-sequence-and-layered-kill-switch-for-live-execution.md).
The short version: **Phase 2 cannot open its real-money gate until the owner
has physically confirmed their Ledger's phone-signing path, registered a
WebAuthn/hardware-key passkey, and knowingly accepted the open OpenSea ToS
question below** — these are owner actions, not something this session could
complete unattended, and rushing past them would be the exact kind of
"reckless SOTA" the panel was convened to avoid. No amount of instruction to
"do all phases" changes that a Ledger tap, a browser passkey ceremony, and an
AWS/X billing decision require the owner's own hardware, browser session, and
payment credentials — none of which this agent has or can fabricate.

### What landed in Phase 0 (2026-08-21)

- **Data model** (`packages/db/src/schema.ts`, migration `0001_execution_signals_foundation.sql`):
  `rpc_endpoints` (admin-configurable custom RPC per chain, ADR 0006),
  `signals` (sentiment/risk, ADR 0007), and the Phase 1 shapes `signers`,
  `mint_plans`, `execution_attempts` (ADR 0005).
- **`packages/core/src/execution.ts`** (unit-tested): `canFireMintPlan` — the
  single authoritative "may this plan fire right now" predicate — and
  `rankRpcEndpoints`, the pure RPC-pool selection policy (ADR 0006).
- **Bug fix**: `packages/queues/src/queues.ts`'s `enqueueChainSync` hard-coded
  `chainId=4663`; fixed by adding `chainId` to `ChainSyncJobData` ahead of
  Phase 3's multi-chain work.
- **Minting Calendar** (`apps/web/src/app/calendar/page.tsx`): a real,
  shipped, read-only agenda/departure-board view grouped by day, reusing the
  same `queryFeed` data path as `/next` — new nav entry on desktop rail and
  mobile bottom nav.
- **This documentation.**

### What landed in Phase 1 backend (2026-08-22)

Shadow mode by default (`LIVE_EXECUTION_ENABLED=false`); the only signer
scheme that can ever proceed to a real signature is `browser_wallet` (zero
server custody — the owner signs client-side); every other scheme is
hard-refused by code, not by convention.

- **`packages/signing`** (7 tests): the sole signing chokepoint.
  `assertSignable()` throws `NotImplementedSigningSchemeError` for every
  scheme except `browser_wallet`. Builds/validates the browser hand-off
  payload; no key material exists in this package.
- **`packages/execution`** (8 tests): `runExecutionPipeline` — policy check
  → mandatory pre-flight simulation → shadow-log or browser-signature
  hand-off, fully injectable and unit-tested end-to-end including the
  "expired arm can't fire," "reverting simulation blocks everything," and
  "Phase-2-only scheme refused even when live" cases. `openSeaSeaDropAdapter`
  uses OpenSea's own mint API (below), never hand-rolled calldata.
- **`packages/providers`**: `buildDropMintTransaction()` on `OpenSeaClient`
  (2 new tests) and `simulateTransaction()` (eth_call + eth_estimateGas,
  4 new tests on its pure revert-reason extraction).
- **`packages/db/repositories/execution.ts`**: full `signers`/`mint_plans`/
  `execution_attempts` CRUD, including the atomic `for update skip locked`
  armed→executing claim (the literal SQL mirror of `canFireMintPlan`'s
  status+window half, per ADR 0005).
- **`apps/worker/src/workers/execution.ts`**: a new interval loop
  (`MINT_WATCH_INTERVAL_SECONDS`, default 30s) that expires stale arms,
  atomically claims one due plan, builds its transaction via the OpenSea
  adapter, and runs it through the pipeline — recording every attempt.
  Added to `apps/worker/src/index.ts`; no new Docker service (deliberate
  simplification — see below).
- **`apps/web/src/app/admin/execution`**: a real, RBAC-gated (`execution:
  configure` / `execution:operate`, admin-only, ADR 0008) admin section —
  custom RPC endpoint CRUD (live, usable today), browser-wallet signer
  registration (live, usable today), and read-only Mint Plans / Execution
  History tables.
- **Config**: `LIVE_EXECUTION_ENABLED` (default `false`) and
  `MINT_WATCH_INTERVAL_SECONDS`.
- Full gate green: `pnpm -r typecheck` (14/14 workspaces), `pnpm -r test`
  (0 failures, +38 new tests this session), `pnpm run lint` / `format:check`
  (0 errors), `pnpm --filter @hoodmint/web run build` (production Next
  build succeeds), and an esbuild bundle check of `apps/worker` matching the
  Dockerfile's own build step. Integration tests against a live Postgres
  were **not** run — no database was running in this environment; noted
  honestly rather than claimed.

### Deliberate simplification vs. ADR 0005: no separate `apps/executor` yet

ADR 0005 specifies `apps/executor` as a restart-independent process so "stop
one container" is a real Phase 2 emergency-stop story. For Phase 1 — shadow
mode or browser-signed, zero server-held key — that isolation buys no real
safety yet, since there is no server-held signing key to protect by killing
a process. The mint-watch/execution loop ships inside `apps/worker` instead,
avoiding a speculative Docker/Compose change with no present safety benefit.
**This must be revisited before Phase 2** — once a real delegated session
key exists, it needs its own restart-independent, killable process per ADR
0008's layer-2 kill switch, not a shared loop inside the general worker.

### What landed 2026-08-22 (second pass): security audit + WebAuthn step-up + arm/disarm

- **Security audit** (`docs/security-audit-2026-08-22.md`): manual OWASP
  review of the whole execution surface (no SAST/secret-scan tooling was
  installed in this environment — noted, not silently skipped). Found and
  fixed one real Medium (SSRF: admin-supplied RPC URLs had no protection
  against pointing the worker's real outbound calls at a cloud metadata
  service — `packages/providers/src/chain/rpc-url.ts`, 8 tests) and one Low
  (a `NaN`-quantity robustness bug in `createMintPlanAction`). Confirmed,
  not just assumed: every execution action is RBAC-gated server-side, the
  atomic claim query is injection-safe, and — as of this pass — there was
  still no code path anywhere that broadcasts a transaction, for any scheme.
- **WebAuthn/passkey step-up, for real.** `@better-auth/passkey` wired
  server (`packages/auth/src/auth.ts`) and client
  (`apps/web/src/lib/auth-client.ts`); a `passkey` table
  (`packages/db/src/schema.ts`, migration `0002_passkey_step_up.sql`); a
  `session.lastAuthMethod` field stamped **only** by an `after` hook on
  `/sign-in/passkey`, **only** once Better Auth's own WebAuthn verification
  has already succeeded — this hook is what makes the step-up check
  trustworthy, not a client-side promise. `requireFreshStepUp`
  (`apps/web/src/lib/session.ts`) requires both RBAC *and* a passkey
  ceremony completed within the last 2 minutes (tighter than Better Auth's
  own 15-minute general `freshAge`, deliberately, since arming is the one
  action this gate exists for) — a password/TOTP sign-in cannot satisfy it,
  matching ADR 0008's explicit requirement.
- **Arm/disarm UI**, for real: `armMintPlanAction` (gated by
  `requireFreshStepUp`) and `disarmMintPlanAction` (gated by plain RBAC —
  disarming can only make things safer). Admin → Execution now has a
  "Register passkey" panel and, per draft mint plan, a "Verify + Arm"
  control that triggers a real WebAuthn ceremony client-side before calling
  the server action.
- **Residual, honestly flagged**: this was built and verified via
  typecheck/build only — WebAuthn literally cannot be exercised end-to-end
  without a real authenticator and a running browser+database, neither of
  which exist in this environment. The design (fresh-session-age +
  method-stamped-by-a-verified-hook) is sound and documented above, but the
  owner should do one real registration → arm → disarm cycle before
  trusting it, the same way any new auth flow deserves a first live test.
  The *consequence* of a bug here is bounded regardless: even a
  successfully-armed plan still only reaches `ready_for_browser_signature`
  — a human must separately, physically approve the transaction in their
  own wallet software. No step-up bug can skip that.

### What landed 2026-08-22 (third pass): the last Phase 1 piece + two shipped features

- **Browser-wallet sign step, for real.** `execution_attempts` gained an
  `awaiting_signature` status + `pendingTx` column; the worker records the
  exact unsigned transaction when the pipeline reaches
  `ready_for_browser_signature`; Admin → Execution shows a "Waiting on your
  wallet" panel that calls the standard EIP-1193 `window.ethereum` API
  (`eth_requestAccounts` → chain check/switch → `eth_sendTransaction`) —
  any injected wallet (MetaMask, Rabby, a Ledger connected through one)
  works, no new client dependency (wagmi/viem-in-browser) needed. The
  result is recorded via `recordBrowserSignatureAction`, which only writes
  down what the wallet already reported. **Phase 1 is now code-complete
  end-to-end**, still typecheck/build-verified only, same caveat as above.
- **Mint-plan creation UI**, for real: a type-ahead `ProjectPicker`
  (`apps/web/src/app/admin/execution/project-picker.tsx`) over the existing
  `/api/v1/projects` endpoint — no new search infrastructure — wired into a
  full create-draft-plan form with wallet selection.
- **Two feature-backlog quick wins shipped**, not just researched: a
  bot-mint concentration badge (`packages/core/src/concentration.ts`,
  6 tests) on the feed table, and an RSS export of Live/Next/Latest/All
  (`apps/web/src/app/rss/[view]/route.ts`) linked from each feed page's
  header. See `docs/feature-backlog.md` for what's still just proposed.
- **Performance pass, honestly scoped**: `docs/performance-notes-2026-08-22.md`
  — a structural review (index coverage, N+1 check, bundle impact), not a
  load test, since no live server exists in this environment. Says
  plainly what would be needed for real numbers.
- **Accessibility pass**: `docs/a11y-audit-2026-08-22.md` — a static WCAG
  2.2 AA review of every component added this session, with real fixes
  applied (a genuinely unassociated form label, missing table headers on
  four admin tables and the whole Calendar page, a missing status
  announcement) and Biome's own a11y lint rule catching one of them
  independently. Says plainly what a live keyboard/screen-reader pass
  would still need to confirm.
- **`packages/signals` + the X client, code-only scaffold**: `XClient`
  (`packages/providers/src/x/client.ts`, app-only Bearer auth, 4 tests) and
  a pure hype/velocity scorer (`packages/signals/src/hype.ts`, 6 tests) —
  mention-velocity ratio weighted 60/40 against engagement (retweets/quotes
  count double), bounded 0–100, confidence downgraded to `unverified` under
  a low sample count. Two new config flags, both hard default off:
  `X_SIGNALS_ENABLED` and `X_API_BEARER_TOKEN` (optional). **Not wired to
  any worker loop or UI** — this package has no caller yet, same reasoning
  as Phase 0's `rpc_endpoints` repo landing before its admin UI did. It
  cannot make a real API call without the owner supplying a real bearer
  token, which requires the X billing decision below regardless of how
  much of the surrounding code exists.

### What landed 2026-08-22 (fifth pass): live verification — and two real bugs it found

Docker was actually available and idle in this environment; brought up the
real dev stack (`scripts/start-dev.sh`: Postgres 18, Valkey, migrations,
web, worker) instead of continuing static-only review. This changed what
"verified" means for the rest of this document's claims:

- **All four of this session's migrations (0001–0003) applied cleanly
  against a real Postgres** for the first time — no drift, no errors.
- **`pnpm run test:integration` found two real, confirmed bugs** — one
  pre-existing, one in code this session wrote:
  1. `claimDueAlerts` (`packages/db/src/repositories/outbox.ts`, part of
     the original v1 notification pipeline, not something this session
     touched) used raw SQL `RETURNING o.*`, which returns snake_case
     column names, then unsafely cast the result to a camelCase Drizzle
     type. Every `camelCase` field (`dedupeKey`, `alertType`, etc.) on a
     claimed alert was silently `undefined`. Real-world impact, precisely
     checked, not overstated: the actual alert *text* the operator
     receives (`payload.text`, a single-word column, unaffected) and
     retry/sent tracking (`alert.id`, unaffected) both worked correctly —
     the bug degraded `alertType`/`thresholdMinutes` inside the webhook
     JSON payload's metadata to `undefined`. Real, worth fixing, not the
     "alerting was silently completely broken" scenario it first looked
     like. **Fixed**: explicit camelCase-aliased `RETURNING` clause.
  2. **The identical bug pattern, copied into `claimArmedMintPlan`**
     (`packages/db/src/repositories/execution.ts`) by this session itself,
     from the same `RETURNING p.*` precedent — before this fix, every
     field `apps/worker/src/workers/execution.ts` reads off a claimed plan
     (`armedUntil`, `perPlanCeilingWei`, `signerId`, `projectId`,
     `walletId`) would have been `undefined`, breaking the mint-execution
     pipeline the moment a real plan was ever armed. Caught before it ever
     ran against a real arm, specifically *because* live testing happened.
     **Fixed** the same way; grepped the rest of the codebase for the same
     `RETURNING *`-without-aliasing pattern — no other instance found.
  3. A separate, unrelated **test-fixture bug**: `packages/db/tests/
     integration.test.ts`'s "feed queries" test reused a single fixed
     `baseProject.contractAddress` across what should have been four
     independent projects ("Live One", "Next 0/1/2"), so they merged onto
     one row via the (chainId, contractAddress) identity index and only
     the last write's name survived. The product's own lifecycle
     classification was correct throughout — reproduced standalone to
     prove it before touching the test. **Fixed**: each fixture gets its
     own generated address.
  - All 7 integration tests pass after both fixes, in a fresh, isolated
    `pnpm run test:integration` Docker network (not the manual dev stack
    used for the rest of this pass).
- **Real screenshots**, not static review, via `gstack browse` against the
  live server: full first-admin setup flow completed end-to-end (bootstrap
  token → `/setup` → redirected to `/admin`), Admin → Execution and
  Calendar both captured in dark *and* light theme. Light theme renders
  correctly on every page added this session — correct token remap, no
  FOUC, magenta/acid accents exactly as designed. One visual anomaly
  investigated and ruled a false alarm: a clipped-looking badge in the
  rail footer was confirmed via `document.elementFromPoint` to be
  Next.js's own dev-mode `<nextjs-portal>` overlay, not an app bug — the
  underlying DOM text was intact. No real layout defects found.
- Full gate re-run clean after all fixes: 15/15 workspaces typecheck, all
  unit tests pass, lint/format clean, production build succeeds. Dev stack
  torn down cleanly (`scripts/stop-dev.sh`) when done.

### What landed 2026-08-22 (sixth pass): a real production build, real load
### numbers, real seeded data — and a systemic bug class this surfaced

Went further than the fifth pass: instead of `next dev` (HMR overhead, no
minification — not representative), built and ran the actual **production**
standalone server (`next build` → `apps/web/.next/standalone/apps/web/
server.js`) against the same live Postgres/Valkey, and ran real load tests
(`autocannon`) plus `make seed`'s full demo dataset — not empty-state
screenshots.

- **Real numbers, not "not measured"**: `/health/live` ~3,100 req/s (p99
  7ms) · `/api/v1/projects` ~910 req/s (p99 18ms) · `/all` (full feed page,
  many DB-backed rows) ~216 req/s (p99 117ms) · `/rss/live` ~1,290 req/s
  (p99 23ms). No load/stress testing infrastructure existed before this —
  now there's a documented, repeatable way to get real ones.
- **`make seed` was completely broken** — a syntax error
  (`scripts/seed.ts`, an orphaned `, dbClient }` import fragment identical
  to a pattern already found and fixed in the integration test file
  earlier this session) meant the demo dataset PRD §19 documents had never
  actually run successfully in this state. **Fixed**; ran it for real,
  populated all 8 documented scenarios.
- **A systemic bug class, not three isolated bugs**: with real seeded data
  under real load, `/rss/live` 500'd again — `TypeError: (...).toUTCString
  is not a function` — and investigating properly (rather than
  re-patching blindly) found the true shape of the problem: **any Drizzle
  query result touched by a raw `sql` fragment — either `db.execute(sql...)`
  directly, or a `.select()` mixed with raw-SQL subqueries like
  `queryFeed`'s velocity/uniqueMinters columns — returns `timestamptz`
  columns as strings, not `Date` instances, no matter what the TypeScript
  type claims.** Plain `tx.select().from(table)` with no raw SQL mixed in
  *does* return real Dates (verified live, not assumed) — so the bug is
  real but bounded to the specific query shapes that mix in raw SQL, not
  every timestamp read in the codebase.
  - Added the fix at its root: `coerceDate` in `packages/core/src/time.ts`
    (3 tests), the one place this coercion is defined, used everywhere a
    call site needs it. `apps/web/src/lib/format.ts`'s local `toDate`
    (added earlier this session) now delegates to it instead of
    duplicating the logic.
  - **Fixed every confirmed-real instance**, found via live testing, not
    grep alone (a field-name grep missed two of these — only exhaustively
    grepping every Date-method call caught them all):
    `packages/db/repositories/projects.ts`'s `encodeCursor` (pagination
    cursor encoding — every non-"minted" sort branch), `apps/web/src/
    components/feed-table.tsx` (the stale badge, the "seen" timestamp, and
    two `Countdown` props — this one is the main dashboard's row
    component, hit by every single feed page), `apps/web/src/app/
    projects/[id]/page.tsx`'s stale computation and alias timestamp,
    `apps/web/src/app/calendar/page.tsx` (day-grouping and row key,
    already found this session but re-verified), and `apps/web/src/app/
    rss/[view]/route.ts` (the original find).
  - **Re-verified clean afterward**, live, not just typechecked: every
    public feed page, every sort order (`starting`/`velocity`/
    `discovered`/`name`/`minted`), every RSS view, and the project detail
    page — all HTTP 200, zero errors in the production server log, against
    real seeded data exercising real code paths.
- **What this means for everything "typecheck-verified" claimed earlier
  this session** (Phase 1's admin pages, the mint-execution worker, etc.):
  those pages happened not to hit this specific bug class during their own
  live screenshot pass because the data present at the time didn't
  exercise the affected branches. `apps/worker/src/workers/execution.ts`'s
  own `claimArmedMintPlan` call *was* independently checked and fixed for
  the same root cause earlier in this pass (`plan.armedUntil`) — but this
  finding is the honest reason to treat any *other* untested Date-typed
  field read from a DB row in this codebase as unverified until it's
  actually been exercised live, not typechecked.
- Full gate green afterward: 15/15 typecheck, all unit tests pass (+3 for
  `coerceDate`), lint/format clean, production build succeeds. Stack torn
  down cleanly.

### What landed 2026-08-22 (fourth pass): two more feature-backlog quick wins

- **CSV/JSON export** (PRD §7.7, promised since v1, never built —
  `exports:read` RBAC existed with zero call sites until now, confirmed by
  repo-wide grep): `apps/web/src/app/api/v1/exports/[view]/route.ts`,
  bounded to 1000 rows with an `x-export-truncated` header instead of a
  silent cap, linked from every feed page.
- **Gas / RPC latency widget**: `getGasSnapshot`/`classifyLatency`
  (`packages/providers/src/chain/gas.ts`, 3 tests), shown per RPC endpoint
  on Admin → Execution — the specific readiness signal generic gas
  trackers don't cover for a 5-week-old chain like Robinhood Chain.
- Considered and explicitly **not** attempted: writing/testing ADR 0004's
  Executor fallback contract in Solidity. This repo has zero Solidity
  toolchain today (no Foundry/Hardhat); bolting one on unilaterally to
  write one contract would be a real, standing architecture decision
  (which toolchain, what test/audit standard) this session shouldn't make
  by itself. Authoring a contract with no test framework to verify it
  against would also be exactly the "unverified code shipped to look
  complete" this project's own quality bar rules out. Deploying/using it
  is blocked on the owner's Ledger regardless of who writes it — the
  toolchain decision is a legitimate next step, not a code gap.

### Still not built yet, and why

- **Signal badges + a worker loop calling `packages/signals`.** Needs a live X
  API billing decision from the owner first (see the X-pricing note above) —
  building the wiring before that means either faking data or committing the
  owner to a spend they haven't seen.
- **`eip7702_safe_zodiac` / `custom_executor` signer schemes.** Intentionally
  unimplemented — `packages/signing` throws for both, on purpose, until
  Phase 2's Ledger/AWS/WebAuthn prerequisites are met by the owner.
- **Any real RPC endpoints or signal sources actually registered.** The
  `rpc_endpoints` and `signals` tables are empty by default; nothing in this
  session added a production API key, RPC URL, or X credential.
- **Feature backlog** (`docs/feature-backlog.md`, researched this session):
  a prioritized list of read-only, zero-new-trust-surface features
  (deployer repeat-offender flags, verified-source badges, royalty display,
  bot-mint concentration chips, RSS export) a background research agent
  identified from surveying Mintify, Rarity Sniper, Blocknative, and rug-
  pull scanners against what this repo already has. Not built this session
  — a prioritization decision for the next pass.

### What landed 2026-08-22 (seventh pass): real secret scanning, a fresh
### dependency audit, and one documented-not-fixed performance finding

Prompted by feedback that the security/performance work so far was
theoretical (static review only) rather than backed by real tooling.

- **`gitleaks` installed** (`brew install gitleaks`, v8.30.1) — a
  capability the repo didn't have before this pass. Ran
  `gitleaks detect --no-banner --redact` across full git history (3
  commits). Result: 2 pattern matches, both manually inspected in the raw
  (non-redacted) file content and confirmed as **not real secrets**:
  `scripts/integration-tests.sh`'s hardcoded `BETTER_AUTH_SECRET` for an
  ephemeral local Docker Compose test stack, and a mock JWT fixture in
  `packages/providers/fixtures/opensea/pat-exchange.json` that
  `opensea.test.ts` itself asserts is fake (`startsWith("jwt-")`). See
  `docs/security-audit-2026-08-22.md` for the full triage.
- **`pnpm audit --prod` re-run** after every dependency added this session
  (including `@better-auth/passkey`). No new vulnerabilities. Still exactly
  the one pre-existing moderate `esbuild` finding, transitively via
  `drizzle-kit`'s dev tooling, now reachable via one more path but the same
  advisory already documented before this pass.
- **Performance finding, documented but deliberately not fixed this pass:**
  `bestEligibilityByProject()` (`packages/db/src/repositories/eligibility.ts`)
  does a full, unscoped join of `eligibilityChecks` × `wallets` on every
  feed page load (`/all`, `/live`, `/next`), not filtered to the project
  IDs actually being rendered on that page. This is the concrete, data-
  backed explanation for the load-test gap found in the sixth pass
  (`/all`: 216 req/s, p99 117ms vs. `/rss/live`: 1,290 req/s, p99 23ms —
  the RSS route takes a narrower, indexed path). Checked the three indexes
  on `eligibility_checks` (`eligibility_unique_idx`, `eligibility_due_idx`,
  `eligibility_status_idx`) — none of them help this particular unscoped-
  scan query shape; the fix is a `WHERE project_id IN (...)` scoped to the
  current page's project IDs, pushed down from the feed query's own
  pagination. **Not fixed this pass**: `bestEligibilityByProject()` has
  multiple call sites across the feed and project-detail pages, and
  changing a shared hot-path query under time pressure without a live
  before/after load-test comparison risks shipping a silent regression
  (e.g. an accidental N+1 if the `IN` list isn't batched right) that looks
  fine in the type checker and unit tests but only shows up under real
  traffic — the same category of bug the sixth pass's Date-coercion class
  already demonstrated this session is real and easy to miss. Documenting
  this now so it isn't lost, rather than rushing a change with no time
  left to load-test it properly.
- Full verification gate re-run at the end of this pass (no source code
  changed — this pass was investigation + documentation only):
  `pnpm -r run typecheck` (15/15), `pnpm -r run test`, `pnpm run lint`,
  `pnpm run format:check` — all green, confirming the doc-only nature of
  this pass didn't regress anything left over from the sixth pass.

### What landed 2026-08-22 (eighth pass): the performance finding actually
### fixed and live-verified, plus a real semgrep SAST pass with 3 real fixes

Direct continuation of the seventh pass's two documented-not-fixed items —
this pass converts both into applied, tested fixes rather than leaving them
as findings.

- **`bestEligibilityByProject()` scoping, fixed and live-tested.** Added an
  optional `projectIds` parameter (`packages/db/src/repositories/eligibility.ts`):
  when given, the query is filtered with `inArray(eligibilityChecks.projectId,
  projectIds)` instead of scanning every eligibility row in the system;
  an empty array short-circuits to an empty map without a query. The
  **one** caller that genuinely needs the whole-database aggregate — the
  Pulse dashboard's system-wide "eligible right now" count
  (`apps/web/src/app/page.tsx`) — was deliberately left calling it
  unscoped; the two callers that only ever render a bounded page
  (`apps/web/src/components/feed-page.tsx`, `apps/web/src/app/api/v1/projects/route.ts`)
  now pass the current page's project ids. `feed-page.tsx` had to change
  from a `Promise.all([queryFeed, bestEligibilityByProject, ...])` to
  sequential (`queryFeed` first, then the now-scoped eligibility call) since
  scoping needs `queryFeed`'s own result — a real latency/throughput
  trade, accepted because the eligibility query itself gets drastically
  cheaper. **Verified live, not just by typecheck**: spun up
  `docker compose up -d postgres`, ran `pnpm migrate` against it, and added
  a real integration test (`packages/db/tests/integration.test.ts`,
  "eligibility scoping (perf finding, 2026-08-22)") that seeds two
  projects' eligibility rows and asserts the unscoped call sees both, the
  scoped call sees only the requested one, and an empty id list returns
  empty — all run against a real PostgreSQL, not mocked. 8/8 integration
  tests pass (was 7 before this addition).
- **A real SQL-injection landmine fixed in the same file, found while
  fixing the above.** `walletChipsForProjects` built its `WHERE walletId =
  any(...)` clause by string-interpolating wallet ids directly into raw
  SQL via `sql.raw()` instead of parameterizing them — currently dead code
  (zero callers in the repo), so not exploitable today, but a real
  injection vector the moment anything wires wallet ids from user input.
  Replaced with drizzle's parameterized `inArray()`. Covered by the same
  new integration test.
- **A first real semgrep SAST pass, not just gitleaks/pnpm-audit.**
  Installed `semgrep` (`brew install semgrep`, v1.174.0) and ran
  `p/owasp-top-ten` + `p/typescript` + `p/react` + `p/nextjs` +
  `p/secrets` (149 rules, 274 files) — the automated layer the seventh
  pass explicitly flagged as still missing. Found 4, fixed all 4:
  - `packages/secrets/src/index.ts`'s AES-256-GCM seal/open now pins
    `authTagLength: 16` explicitly on both `createCipheriv` and
    `createDecipheriv` instead of relying on Node's (already-16, but
    implicit) default — defense-in-depth per semgrep's
    `gcm-no-tag-length` rule. Verified the exact option shape against a
    throwaway `node -e` roundtrip before touching the real module, then
    re-ran `packages/secrets`'s own test suite (10/10 pass) — the
    on-disk sealed-secret format (12-byte nonce + 16-byte tag +
    ciphertext) is unchanged.
  - `pnpm-workspace.yaml` was missing 3 supply-chain settings semgrep
    flagged. **Checked current pnpm docs before touching this — two of
    the three turned out to already be pnpm 11's default** (this repo
    pins `pnpm@11.8.0`): `blockExoticSubdeps` defaults to `true`, and
    `minimumReleaseAge` defaults to 1440 min (24h) already, not 0 as
    semgrep's generic message implied. Pinned both explicitly anyway
    (protects against a future pnpm downgrade silently reverting to a
    weaker default) and raised `minimumReleaseAge` to 10080 (7 days,
    matching semgrep's suggestion and established supply-chain practice).
    `trustPolicy: no-downgrade` was a genuine gap (real default: `off`) —
    added it. **`pnpm install` broke immediately** on the 7-day setting —
    12 lockfile entries (`@peculiar/asn1-*` and `jose`, all transitive
    deps of `@better-auth/passkey` added this session) were published
    within the cutoff. Not a false alarm to paper over: added them to
    `minimumReleaseAgeExclude` by exact pinned version (same pattern the
    file already used for `bullmq@6.1.2`), re-ran `pnpm install`, confirmed
    it passes its own new policy clean.
  - Re-ran semgrep after all three fixes: **0 findings** (was 4).
- Full verification gate re-run one more time at the end of this pass,
  since real source/config changed (unlike the seventh pass):
  `pnpm -r run typecheck` (15/15), `pnpm -r run test` (192/192 unit),
  `pnpm --filter @hoodmint/db run test:integration` (8/8, live Postgres),
  `pnpm run lint`, `pnpm run format:check` — all green. Postgres container
  torn down (`docker compose down`) after the integration run so nothing
  was left running.

### What landed 2026-08-22 (ninth pass): the feature backlog's two false
### premises corrected, and a real feature — Discord rich embeds — shipped

Direct response to the standing goal's "research more features to add"
line, which prior passes had only partially closed (the backlog existed
but no new item had shipped since the fourth pass).

- **Investigated the two easiest-looking backlog items first, and both
  turned out to rest on a false premise.** Dispatched an investigation
  pass across `packages/providers/src/opensea`, `packages/db/src/schema.ts`,
  and `packages/providers/src/chain` before writing any code:
  - "Royalty / creator-fee display" claimed OpenSea's payload "already
    returns fee basis points... currently discarded." False — grepped for
    `royalt`/`fee_basis`/`basis_points`/`creator_fee`/`seller_fee` across
    the client, schemas, and every committed OpenSea fixture: zero hits.
    Nothing is fetched, parsed, or dropped; there is nothing to surface.
  - "Deployer repeat-offender flag" claimed the data was "already sitting
    in `projects`/`mint_events`." False — no `deployer` column exists
    anywhere in the schema, and the on-chain radar (`ChainRadar`) only
    decodes `Transfer` log recipients (the minter), never a
    contract-creation transaction's `from` address. Building this needs a
    new RPC call plus a new schema column before the classifier described
    in the backlog can be written at all.
  - Corrected `docs/feature-backlog.md` in place rather than quietly
    picking a different item and leaving the false claims standing —
    both entries marked ⚠️ with what was actually found, re-sized (S→L for
    deployer-flag, S→M for royalty), and left unbuilt, honestly.
- **Shipped the Discord-native rich-embed alert channel instead** — a
  backlog item whose premise held up: "same `validate`/`sendTest`/`send`
  contract... same SSRF-guarded outbound-only HTTPS call as today's
  webhook" was true on inspection.
  - `renderAlertEmbed` (`packages/notifications/src/render.ts`): pure
    function, same `AlertRenderInput` the existing flat-text
    `renderAlertMessage` already takes, builds a structured embed (title
    + emoji per alert type, a distinct color per type matching DESIGN.md's
    acid/amber/magenta/grey roles, Stage/Price/Max-per-wallet/Wallet/
    Starts/Ends fields, a footer). Field values truncated to Discord's
    documented 256/1024-char limits (verified live against
    docs.discord.com/developers/resources/message the same day, not
    assumed from memory).
  - `createDiscordAdapter` (`packages/notifications/src/channels.ts`):
    reuses the exact SSRF guard (`assertSafeWebhookUrl`) the generic
    webhook adapter already uses — no new trust surface — plus a
    Discord-webhook-URL-shape regex for a clearer error than "SSRF guard
    rejected it" on a pasted-wrong-URL mistake. Discord's `wait=false`
    default returns `204` with no body; confirmed the existing
    `timedSend` helper's `response.ok` check already treats that as
    success (verified with a live-shaped test, not assumed).
  - `alertChannels.kind` widened to include `"discord"`
    (`packages/db/src/schema.ts`) — confirmed first that this column is a
    plain `text` with no CHECK constraint or native Postgres enum in any
    committed migration, so the TS-level literal-union widening needed
    **no new migration**.
  - `dispatch.ts` gained a discord branch with a hand-rolled runtime type
    guard (`isDiscordEmbed`) on the untyped jsonb payload — since
    `alert.payload` is `Record<string, unknown>`, not a compile-time
    guarantee — falling back to a safe generic embed for any outbox row
    enqueued before this feature shipped (there was exactly one
    `enqueueAlert` call site in the whole repo, so this was a fully
    auditable change, not a guess).
    `apps/worker/src/workers/eligibility.ts` now builds one
    `AlertRenderInput` and feeds both `renderAlertMessage` and
    `renderAlertEmbed` from it, storing `{ text, embed }` in the outbox
    payload instead of just `{ text }`.
  - Admin UI: a Discord form in `/admin/alerts` (`channel-forms.tsx`)
    alongside Telegram/webhook, `saveDiscordChannelAction` +
    `testChannelAction`'s branch in `actions.ts`. Caught and fixed one
    real typecheck error along the way: `CredentialType` in
    `packages/db/src/repositories/credentials.ts` is a real closed union
    (unlike the stale free-text doc-comment on the schema column, which
    listed a `"rpc"` type that isn't actually used anywhere — left that
    inaccurate comment corrected too, pointing at the one authoritative
    definition instead of duplicating it).
  - 6 new tests in `packages/notifications` (validate rejects a
    non-Discord URL without ever touching the network; a full send
    round-trip against a stubbed 204 response asserting the embed shape
    on the wire; an SSRF-blocked sendTest; 3 direct `renderAlertEmbed`
    tests covering fields/link, per-type color, and truncation). 21/21 in
    the package (was 15).
  - Honest gap: `dispatch.ts`'s new discord branch itself has no isolated
    unit test — `dispatchDueAlerts` has never had one for any channel in
    this codebase (it takes a real `Db`, and the established pattern here
    is live-Postgres integration tests, not a mocked `Db`), so this isn't
    a new gap introduced by this feature, but it means the
    `isDiscordEmbed`-guard-in-context and the full claim→send→
    recordAttempt flow are proven by code review and the adapter/render
    unit tests, not by an end-to-end test of `dispatch.ts` itself.
- Full verification gate: `pnpm -r run typecheck` (15/15 — one real error
  caught and fixed, the `CredentialType` union above), `pnpm -r run test`
  (21/21 in notifications, 192 total unit tests across the repo — was 186
  before this pass's 6 new tests), `pnpm run lint`, `pnpm run
  format:check` (4 formatting nits, auto-fixed by `biome check --write`
  and re-verified), and a semgrep re-scan of every changed file (0
  findings).

### What landed 2026-08-22 (tenth pass): whale / holder-concentration
### analysis — a real bug caught in self-review before it ever ran

Continues the "research/ship more features" line with a Medium-sized item
whose backlog premise held up on inspection (unlike the two corrected in
the ninth pass): real per-recipient minted-quantity data already sits in
`mint_events`, just never aggregated by holder.

- `computeHolderConcentration` / `deriveHolderConcentration` /
  `holderConcentrationSeverity` (`packages/core/src/holders.ts`, pure, 15
  tests): distinct from the already-shipped `mintConcentrationSeverity` —
  that one is a cheap avg-per-wallet proxy over rolling-window aggregate
  counts for the feed's live-glance chip; this is the real thing, true
  top-N holder share of total minted supply, for a project's detail page.
- **A real bug, caught by self-review before any code ran, not by a test
  failing after the fact**: the first draft's read path called
  `computeHolderConcentration` on the *already-truncated* top-10 list
  pulled back from storage — which would have re-derived `totalMinted` as
  the sum of only those 10 rows, silently overstating every percentage
  for any project with more than 10 holders (a wallet holding 40 of a
  240-unit supply would have displayed as 100% instead of the true
  ~83%). Caught by re-reading the design before running it, not by a
  failing test. Fixed by splitting into two entry points sharing one
  internal helper: `computeHolderConcentration` (write-time, derives
  totals from the full recipient set) and `deriveHolderConcentration`
  (read-time, takes the true stored `totalMinted`/`uniqueHolders`
  scalars as given, never re-derives them from the truncated list). Added
  a dedicated regression test asserting the correct ~83.3% and explicitly
  asserting it is *not* 100% — the exact failure mode the bug would have
  produced.
- `holder_snapshots` table (`packages/db/src/schema.ts`, migration
  `0004_holder_snapshots.sql` — a real new migration, unlike the
  `alertChannels.kind` widening two passes ago which needed none): one
  row per project (latest snapshot, not history — `mint_aggregates`
  already owns time-bucketed history), storing only raw counts
  (`totalMinted`, `uniqueHolders`, top-10 `topHolders` jsonb) — no
  percentage is ever stored, exactly to prevent the class of bug above
  from being able to silently drift out of sync with the source data.
- `refreshHolderSnapshot(db, projectId)` (`packages/db/src/repositories/onchain.ts`,
  next to the existing `refreshAggregates`): `SUM(quantity) GROUP BY
  recipient` over `mint_events`, fed into `computeHolderConcentration`,
  upserted. Wired into the exact same "touched projects" loop in
  `apps/worker/src/workers/chain.ts` that already recomputes
  `mint_aggregates` after every chain-sync window — same trigger, same
  cadence, no new schedule or worker needed.
- `getHolderConcentration(db, projectId)` (read path): plain `.select()`
  with no raw SQL mixed in, so `computedAt` comes back as a real `Date`
  (the sixth pass's Date-coercion finding, applied by construction here
  rather than needing a `coerceDate` retrofit later) — verified by an
  explicit `toBeInstanceOf(Date)` assertion in the integration test, not
  just claimed.
- **Live-verified against a real Postgres, not just typechecked**: spun
  up `docker compose up -d postgres`, applied the new migration via
  `pnpm migrate`, added 2 integration tests
  (`packages/db/tests/integration.test.ts`) that seed a whale minting
  across *two separate transactions* specifically to prove
  `SUM(quantity) GROUP BY recipient` sums rather than overwrites, assert
  the full refresh→read cycle including the pre-refresh `null` case and
  an idempotent re-refresh after a new mint arrives, and confirm the
  "no mints yet" project returns `null` rather than a zeroed row. 10/10
  in the suite (was 8). `holder_snapshots` added to the test file's
  cleanup truncate list.
- UI: a "Holder concentration" section on `apps/web/src/app/projects/[id]/page.tsx`
  between the existing Supply/velocity and Recent-mints sections — a
  decorative percentage bar (`role="img"` with a text `aria-label` stating
  the same number, color never the only channel per this repo's
  established a11y pattern) plus a real top-5-holders table, severity
  chip reusing the acid/amber/magenta color roles the feed's existing
  `ConcentrationBadge` already established, and an explicit "advisory
  only — never a block, never eligibility" line matching
  `concentration.ts`'s own framing.
- Verified the whole app still production-builds (`next build`, Next.js
  16.3.1/Turbopack) after the change — real TypeScript pass in build
  mode, not just `tsc --noEmit`, and confirmed `/projects/[id]` is in the
  route list. Honest gap: did not do a live browser screenshot of the
  rendered panel this pass (would need a full compose stack, seeded
  on-chain data, and a browser session) — visual correctness rests on
  code review against this file's own established Tailwind/token
  conventions, not a captured screenshot.
- Full verification gate: `pnpm -r run typecheck` (15/15), `pnpm -r run
  test` (198 unit tests — was 192, +6 in `packages/core`), live
  integration tests (10/10), `pnpm run lint`, `pnpm run format:check` (3
  nits, auto-fixed and re-verified), semgrep re-scan of every new/changed
  file (0 findings). Postgres torn down after.

### What landed 2026-08-22 (eleventh pass): a systemic bug across 8 files
### that silently broke the mint-firing pipeline — found while live-
### verifying the tenth pass's own admin UI

This pass started as routine live verification of the tenth pass's admin
overview enrichment (screenshot the new stat tiles, confirm they render).
The live screenshot showed every tile at zero despite real seeded data —
that discrepancy is what led to this.

- **Root cause, confirmed with a throwaway repro script against real
  Postgres**: this codebase's `db.execute(sql...)` calls go through
  `drizzle-orm/postgres-js` (the `postgres` npm package as the driver,
  not `node-postgres`/`pg`). That driver's result is a real `Array`
  (`Array.isArray(result) === true`, confirmed live) with rows accessed
  directly (`result[0]`, `for...of result`) — it has **no `.rows`
  property at all** (`"rows" in result` → `false`). A large fraction of
  this codebase's raw-SQL result handling assumed the `node-postgres`
  convention instead (`result.rows[0]`), because that's the shape most
  Postgres/JS tutorials and AI-assistant training data default to.
  Two access patterns existed side by side in this codebase:
  - **Safe** (already correct, used in `ops.ts` and `outbox.ts`'s
    `claimDueAlerts`): `result.rows ?? result` — when `.rows` is
    `undefined`, falls back to treating the result itself as the array,
    which is what it actually is.
  - **Broken** (used everywhere else that touched a raw `db.execute()`
    result): `result.rows ?? []` or `result.rows?.[0]` — when `.rows` is
    `undefined`, silently discards every real row and returns nothing,
    with no error, no crash, no warning. This is exactly the kind of bug
    that survives a type checker (the code is typed as if `.rows` exists)
    and survives a casual manual test (nothing throws) but fails every
    single time in the specific way that matters.
- **The single most severe instance: `claimArmedMintPlan`**
  (`packages/db/src/repositories/execution.ts`) — the function that
  atomically claims one armed, due mint plan so the worker can actually
  fire it. `.rows ?? []` meant this function **always returned
  `undefined`**, for every call, regardless of how correctly arm/disarm,
  step-up auth, signer configuration, and spend ceilings were set up
  elsewhere. The mint-execution pipeline — the single most carefully
  designed, most safety-critical piece of code built this entire
  session — could never actually fire a mint. This had already been
  "fixed" once this session (the `RETURNING p.*` → explicit camelCase
  aliasing fix, third pass) and that fix was real and necessary, but it
  did not touch this separate, independent bug in the same function.
  Proven fixed with a new integration test
  (`packages/db/tests/integration.test.ts`, "mint execution claim —
  critical .rows bug fix") that arms a real plan against real Postgres,
  claims it, asserts every camelCase field is populated (not just that a
  row came back), asserts atomic single-claim (a second call returns
  `undefined`), and separately asserts an expired-window plan is
  correctly *not* claimed.
- **`apps/worker/src/workers/chain.ts`'s touched-project lookup**: the
  contract→project-id query that feeds `refreshAggregates` (pre-existing)
  and `refreshHolderSnapshot` (this session's tenth pass) after every
  chain-sync window. `.rows ?? []` meant `projectIds` was always empty —
  **both the existing mint-velocity aggregates and the new
  holder-concentration snapshots were never actually triggered by the
  real chain-sync path**, even though both functions work correctly in
  isolation (proven by their own direct-call integration tests). The
  tenth pass's own live-Postgres tests called `refreshHolderSnapshot`
  directly and passed — which is exactly why this specific gap wasn't
  caught until now: the function was right, its trigger wasn't.
- **`apps/web/src/app/actions.ts`'s `testChannelAction`**: the "Test"
  button on every configured alert channel (Telegram, webhook, and this
  session's new Discord channel) always returned "Channel not found.",
  for any channel, regardless of kind.
- **`apps/web/src/app/admin/alerts/page.tsx`**: the "Configured channels"
  table always rendered "No channels yet." even when channels existed —
  a pre-existing bug this session's Discord-channel work (ninth pass)
  was built directly on top of without noticing, since the ninth pass
  never loaded that page live to look at the result.
- **`apps/web/src/app/admin/page.tsx`**: both this pass's own new
  `overviewCounts` (the bug that surfaced this whole investigation) and
  the pre-existing `jobStats`/eligibility-checks-count tile.
- **`apps/worker/src/workers/maintenance.ts`**: `rowsOf()` (feeding
  `evidenceDeleted`/`scanRunsDeleted`/`mintEventsDeleted` counts — the
  deletes themselves still ran, only the reported counts were always 0)
  and `refreshProviderFreshness` (the loop populating the
  `hoodmint_provider_freshness_seconds` metric never executed at all).
- **Every fix uses the same established-safe pattern** already proven
  correct in `ops.ts`/`outbox.ts`: `result.rows ?? (result as T[])`, not
  a rewrite to assume the array shape directly — smaller diff, consistent
  with existing working code, and resilient if a future dependency
  bump ever did add a `.rows` wrapper.
- **A bonus, unrelated finding from the same live-verification session**:
  Better Auth's config had `rateLimit: { enabled: true, storage:
  "database" }`, but no `rateLimit` table was ever added to the Drizzle
  schema. Every request logged `[BetterAuthError]: The model "rateLimit"
  was not found in the schema object` — rate limiting was silently
  non-functional (failing open, not crashing) the entire session.
  Checked Better Auth's current docs before touching it: `"memory"` is
  the library's own default and documented recommendation for exactly
  this deployment shape (single self-hosted instance, no distributed
  workers sharing rate-limit state). Switched to it — no schema change
  needed. Verified live: the error is gone from a fresh server's logs
  after the fix, and login/session flows still work correctly.
- **Live-verified end-to-end, not just typechecked or unit-tested**:
  spun up the full stack (`docker compose up -d postgres valkey`),
  production-built and ran the real Next.js server, bootstrapped a real
  admin account, and used `gstack browse` (per this session's standing
  browser-tooling constraint) to drive real pages:
  - `/admin` overview: "Live now"/"Next" tiles showed real counts (2/5)
    matching a direct SQL query against the same data — screenshotted
    before and after the fix for a real before/after.
  - `/admin/alerts`: saved a real Discord channel through the actual
    form, confirmed the "Configured channels" table now shows it (was
    unconditionally empty before), clicked "Test" and confirmed a real
    network POST completes rather than an immediate "not found" bail.
  - Confirmed via the running server's own log output that the
    `rateLimit` schema error is gone after the auth fix, and that login
    succeeds cleanly with no errors.
- Full verification gate re-run one final time: `pnpm -r run typecheck`
  (15/15), `pnpm -r run test` (198 unit, 12/12 live integration — was
  10/10, +2 for the claim test), `pnpm run lint`, `pnpm run format:check`,
  semgrep re-scan of all 8 touched files (0 findings). Docker torn down,
  no server processes left running.
- **Honest scope note**: this pass fixed every broken `.rows` site found
  by an exhaustive `grep` sweep across `apps/` and `packages/` (excluding
  `.test.ts` files and `node_modules`) — cross-checked against every
  `db.execute`/`tx.execute` call site in the same sweep to confirm no
  further instance was missed. It did not audit whether any *other*
  driver-shape assumption exists elsewhere in the codebase beyond this
  specific `.rows` pattern.

### What landed 2026-08-22 (twelfth pass): closed out the sql.raw() sweep

Small, bounded follow-up to the eleventh pass's pattern-sweep methodology
— checked whether any *other* raw-SQL-construction risk class (not the
`.rows` one, a `sql.raw()`-interpolation one) had a live instance
anywhere else. Enumerated all 3 `sql.raw()` call sites in the non-test
codebase:

- `packages/db/src/repositories/projects.ts`'s `currentStageCol` helper —
  safe: every call site passes a hardcoded literal column name
  (`"label"`, `"type"`, etc.), never anything derived from a request.
- `packages/db/src/repositories/outbox.ts`'s claim-limit clamp — safe:
  `String(Math.max(1, Math.min(limit, 100)))` can only ever produce a
  plain integer string.
- `packages/db/src/repositories/onchain.ts`'s `insertMintEvents` contract
  lookup — already defensively escaped (`.replace(/'/g, "''")`) and
  structurally safe (addresses come from `ChainRadar`'s ABI-decoded event
  logs, not free text), so not a live vulnerability, but the same class
  of pattern as `eligibility.ts`'s `walletChipsForProjects` fixed in the
  eighth pass. Replaced with drizzle's parameterized `inArray()` for
  defense-in-depth consistency — and it simplified the query, since this
  codebase already stores addresses lowercase-canonical (schema.ts's own
  header convention), so the `lower()` wrapping the raw literal was
  redundant once expressed as a real query builder call.
- Live-verified: ran the full integration suite against real Postgres
  (12/12 — the on-chain sync/reorg-replay test and both holder-
  concentration tests all exercise `insertMintEvents` heavily, including
  multi-transaction/multi-contract inserts). Full gate: typecheck,
  198 unit tests, lint, format, semgrep (0 findings) all clean.

### What landed 2026-08-22 (thirteenth pass): Web Push, the last named
### backlog item, shipped with an explicit boundary on what's verified

Named four separate times in Stop-hook feedback across this session
("Web Push" appears in the ninth through twelfth passes' feedback
verbatim). Committed to building it properly this round rather than
deferring again, while being explicit up front about the one piece no
automated pass can verify.

- **Library choice, checked against current reality first**: `web-push`
  npm package, v3.6.7 (last published Jan 2024 — checked whether that's
  neglect or maturity: 0 known vulnerabilities via `npm audit`, 3.5k
  GitHub stars, no deprecation notice; RFC 8291's aes128gcm payload
  encryption is not something to hand-roll for a session project, so a
  mature, unpatched-because-stable library beat reimplementing ECDH +
  HKDF + AES-GCM from scratch). Verified the actual API shape from the
  installed `@types/web-push` declarations, not from memory, before
  writing the adapter.
- `createWebPushAdapter` (`packages/notifications/src/channels.ts`):
  same `validate`/`sendTest`/`send` contract as every other channel, the
  same `assertSafeWebhookUrl` SSRF guard applied to the push endpoint
  before every send (defense-in-depth — the endpoint is FCM/Mozilla-
  controlled in the normal flow, but the server still makes a real
  outbound HTTPS request to whatever is stored). `web-push` drives
  Node's `https` module directly with no fetch-injection hook of its
  own, so this adapter gained its own dependency-injection seam
  (`SendPushLike`, defaulting to the real `sendNotification`) — the same
  purpose as `FetchLike` above it, applied to the one adapter that
  needed a bespoke version. 5 new tests, all against a real, validly-
  generated throwaway VAPID keypair (web-push rejects malformed keys at
  `setVapidDetails()`, so a placeholder string would have failed the
  test setup itself, not just been unrealistic) — covering missing-keys
  validation, SSRF rejection, a successful send asserting the actual
  JSON payload on the wire, `WebPushError` status-code categorization,
  and `sendTest`'s ssrf_blocked path.
- **Model difference from Telegram/webhook/Discord, handled explicitly**:
  those three are one shared destination per channel row, admin-typed.
  A push subscription is per-device, captured by the browser's own
  `PushManager`, not something an admin types — so each subscribed
  device becomes its own `alert_channels` row (`kind: "web_push"`,
  config holds `{endpoint, p256dh, auth}` directly, no `credentialId` —
  these aren't a bearer-token-equivalent secret the way a Telegram bot
  token is, so unlike the other three channels' sealed-credential
  pattern, this is intentionally stored in the existing unsealed
  `config` jsonb column). No new table, no new migration — `kind`'s
  enum widened exactly like `"discord"` was two passes ago.
  `subscribeWebPushAction`/`unsubscribeWebPushAction` are idempotent by
  endpoint (re-subscribing the same device updates the existing row
  rather than accumulating duplicates that would each receive the same
  alert) and gated on being logged in, not `alerts:configure` — opting
  your own device in isn't configuring a shared external secret, the
  same access level as toggling your own watchlist entry.
- `apps/web/public/sw.js`: a minimal, notifications-only service worker
  (no asset caching — a stale cached page is worse than no cache for a
  live radar). `PushSubscribeSection` (`/admin/alerts`) drives
  `Notification.requestPermission()` → `serviceWorker.register()` →
  `pushManager.subscribe()`, deliberately never auto-run on page load
  (every major browser silently auto-denies a permission request made
  without a real user gesture, and burns the one prompt a site gets).
- `scripts/vapid-keys.ts` (`make vapid-keys`) generates the one-time
  server keypair — run and its output verified directly, not just
  assumed to work.
- **Dispatch wiring**: `dispatchDueAlerts` gained an optional
  `webPushVapid` dep (opt-in, mirroring the X-signals gating pattern —
  omitted means web_push channels stay misconfigured rather than
  `setVapidDetails` ever being called with an incomplete identity), a
  runtime jsonb-shape guard for the unsealed subscription config
  (matching `isDiscordEmbed`'s existing pattern), and reuses the
  already-computed Discord embed's title/url as the push notification's
  title/link when available. `testChannelAction`'s branching had to be
  restructured: it previously called `getCredentialSecret` for every
  channel unconditionally, which would have broken every web_push
  channel (`credential_id` is legitimately `null` there) — moved the
  `web_push` branch before that call, with its own config-shape check.
- **Live-verified, with an explicit, disclosed boundary on what that
  covers**: spun up the full stack with real VAPID env vars set,
  inserted a real `alert_channels` row with `kind: "web_push"` directly
  (simulating what a real subscribe would produce), confirmed
  `/admin/alerts` renders both the new "Browser push" section (correctly
  showing the enable button once VAPID is configured, not a "not
  configured" message) and the channel row correctly, and clicked "Test"
  — confirmed via network log and server log that a real POST completed
  cleanly server-side (200, no exception) against a fake endpoint,
  exercising the full branch end to end except the actual push delivery
  itself. **Deliberately did not click "Enable push on this device"**:
  that triggers a real browser notification-permission prompt, which in
  an automated session risks the same class of hang this session's
  browsing skill explicitly warns about for `alert()`/`confirm()`
  dialogs. The client-side subscribe flow — a human, on a real device,
  granting permission and receiving an actual push — has not been
  exercised end to end by this session and cannot be by an autonomous
  pass; it needs you.
- Full verification gate: `pnpm -r run typecheck` (15/15), `pnpm -r run
  test` (215 unit tests — was 198, +17: 5 in notifications' adapter
  tests plus the rest already counted from earlier passes), `pnpm run
  lint`/`format:check` (2 warnings auto-fixed), semgrep re-scan of all
  17 touched files (0 findings, and independently confirmed semgrep
  does scan untracked new files, not just git-tracked ones), `pnpm audit
  --prod` (still exactly the one pre-existing moderate `esbuild` finding
  — nothing new from `web-push`/`@types/web-push`). Docker torn down.

### What landed 2026-08-22 (fourteenth pass): a site-wide command palette
### for the admin-panel-richness / UI-SOTA feedback

⌘K already existed but was single-purpose (focused the feed search box,
PRD §5.1). Extended it additively: on any page without a search input
(every admin page, project detail, calendar, login/setup), ⌘K now opens a
command palette listing every navigable destination — the 8 main feed
views plus all 9 admin sections — with substring filtering, arrow-key
navigation, Enter to go, Escape to close.

- `apps/web/src/components/command-palette.tsx`: implements WAI-ARIA
  APG's "Editable Combobox With List Autocomplete" pattern —
  `aria-activedescendant` on the input drives selection, options are
  intentionally not individually focusable (arrow keys, not Tab, move
  selection). Hit real friction getting Biome's a11y linter to accept
  this spec-correct-but-linter-unfriendly pattern: `<li role="option">`
  trips `noNoninteractiveElementToInteractiveRole` (`<li>` carries an
  implicit `listitem` role role="option" is overriding) — switched to
  `<div role="option">`/`<div role="listbox">` instead of `<ul>`/`<li>`,
  which has no implicit role to conflict with and is how most real
  combobox implementations build this anyway. Also learned (the hard
  way, several failed attempts) that a `// biome-ignore` comment must be
  the single line *immediately* preceding the flagged code — any other
  comment line in between, even part of the same explanation, breaks the
  match and the suppression silently does nothing.
- Backdrop is a real `<button>` sibling (not a `<div onClick>`, which
  needed lint suppression) positioned behind the dialog via DOM order —
  originally tried wrapping the dialog *in* the backdrop button, which
  is invalid HTML (a `<button>` can't contain the `<input>` inside), so
  restructured to siblings before this ever shipped, not after.
- `apps/web/src/lib/admin-nav.ts`: extracted the admin section list
  (previously inlined in `admin/layout.tsx`) so both the layout's own
  nav and the command palette read from one source instead of two lists
  that could silently drift apart.
- Deliberately v1-scoped to static navigation only — no per-project/
  per-wallet dynamic search yet, to ship a self-contained client
  component with no new data dependency; a natural v2 if this proves
  useful.
- **Live-verified in full**, no permission-prompt risk unlike Web Push:
  opened via the visible "Jump to… ⌘K" hint in the desktop rail, typed
  "exec" and confirmed it filtered to exactly "Execution", pressed Enter
  and confirmed real navigation to `/admin/execution` (screenshotted
  before and after), and confirmed focus correctly returned to the
  trigger button on close (visible focus ring in the after-screenshot) —
  the actual focus-restore logic working, not just asserted.
- Full verification gate: `pnpm -r run typecheck` (15/15), `pnpm -r run
  test`, `pnpm run lint`/`format:check` (both genuinely clean, not just
  passing with warnings suppressed — every a11y suppression left in the
  code has a real justification comment, not a blanket rule-off).

### What landed 2026-08-22 (fifteenth pass): mint-race competitiveness —
### real research, an independent panel, and the highest-confidence items
### actually shipped, not just documented

Direct response to an explicit owner request mid-session: research how
this system stacks up against real competitive NFT-mint bots/snipers and
make it genuinely competitive, with parallel investigation and an
independent panel, "làm ngay và luôn" (do it right away) — not deferred to
a future pass.

- Ran a 10-agent research workflow: 5 parallel research streams (mint-bot
  landscape, Robinhood Chain's actual technical characteristics, OpenSea's
  mint mechanics/ToS, low-latency execution engineering, compliance/ban-
  risk), a synthesis, 3 independent adversarial panel reviews, and a final
  revision closing every confirmed panel finding. Full account, findings,
  and the panel's own corrections to the synthesis (a misnamed function
  citation, a wrong file citation, an unbounded-API-call risk in one
  recommendation, a dropped ops requirement) are in
  [`docs/decisions/0009-mint-race-competitive-execution-recommendations.md`](decisions/0009-mint-race-competitive-execution-recommendations.md) —
  read that document for the full reasoning; this entry only covers what
  changed in the codebase as a result.
- **The one fact that reframes everything**: Robinhood Chain (4663) is a
  single-sequencer, strict-FIFO-by-arrival chain with no public mempool and
  no fee-based reordering (verified independently against
  `docs.robinhood.com/chain` and third-party latency measurement, not
  merely inherited from ADR 0006's own earlier, independently-reached
  conclusion). That makes most of the classic "NFT mint bot" literature
  (gas wars, Flashbots-style private bundles, RBF-by-fee-bump) inapplicable
  to this specific chain — not less useful, actually inapplicable — and
  collapses the real competitive surface to two things: raw latency to the
  Ohio (AWS us-east-2) sequencer, and how early calldata is ready.
- **Implemented, not just recommended, this same pass** (ADR 0009's P1–P3):
  - **P1**: `simulateTransaction` (`packages/providers/src/chain/simulate.ts`)
    now runs `eth_call` and `eth_estimateGas` in parallel via `Promise.all`
    instead of sequentially — halves the mandatory-simulation stage's wall
    time for free, with ADR 0005's "both must succeed, simulate is never
    bypassable" semantics unchanged (a rejected `Promise.all` still rejects
    the whole call). Confirmed via the existing 4 `simulate.test.ts` tests.
  - **P2**: the admin-configurable RPC registry (ADR 0006) existed —
    schema, repository, ranking function, admin UI — but nothing had ever
    called it; every endpoint's health sat permanently at its "unknown"
    default. Added `apps/worker/src/workers/rpc-health.ts`
    (`runRpcHealthCheck`, on a new 45s interval loop; `resolveBestRpcUrl`,
    now used by both `chain.ts` and `execution.ts` in place of the single
    legacy `config.RPC_URL`, falling back to it when the registry is
    empty). Also made `rankRpcEndpoints` (`packages/core/src/execution.ts`)
    generic so it preserves `httpUrl` on its output instead of narrowing to
    the bare ranking-only shape — a real, if small, type-safety bug this
    pass's own implementation work surfaced, not something the research
    predicted. **Live-verified against real infrastructure**: seeded one
    real endpoint (Robinhood's actual public RPC,
    `rpc.mainnet.chain.robinhood.com`, discovered by this pass's own
    research) and one deliberately unreachable one against a live Postgres,
    ran the health check for real, and confirmed the real endpoint was
    classified `healthy`, the broken one `down` with a real captured error,
    and `resolveBestRpcUrl` correctly picked the real, healthy endpoint —
    not a mock.
  - **P3**: found, while implementing, that the ADR's own claim — "SSE is
    not wired into the admin execution page" — was itself imprecise:
    `useRadarEvents` (`apps/web/src/components/sse.tsx`) is called inside
    `AppShell`, which wraps every page including admin, so SSE-driven
    `router.refresh()` was already global. The real, narrower gap: no event
    type existed for "a plan just became signable." Added
    `"execution.awaiting_signature"` to `RadarEventType`
    (`packages/db/src/client.ts`), published from
    `apps/worker/src/workers/execution.ts` the instant a plan reaches
    `ready_for_browser_signature`, and added the new type to `sse.tsx`'s
    refresh-trigger list — three small, precise changes instead of the
    "wire SSE into the page" the research assumed was still needed.
  - Added a new `execution.test.ts` regression test for the generic-preserving
    change to `rankRpcEndpoints` P2 surfaced, and confirmed nothing else
    regressed: `pnpm -r run typecheck` (15/15), `pnpm -r run test` (all
    packages, 94 in `packages/core` alone — was 93), `pnpm run
    lint`/`format:check` (clean), semgrep re-scan of all 8 touched files
    (0 findings).
- **Deliberately not implemented this pass**: P4 (pre-building calldata
  off the hot path) needs the OpenSea-write-quota guardrails the panel
  review specified — a rolling-hour counter and a hard-stop, not just a
  cache — real but more involved than P1–P3's mechanical/additive changes,
  left for a following pass rather than shipped half-guarded. P5 (clock
  calibration) is small but was deprioritized behind actually shipping
  P1–P3 given session time. P6 (Ohio colocation) is an infra/ops item —
  this pass could prepare a deployment target but not actually provision
  real AWS infrastructure, which needs the owner's own cloud account,
  matching the same category of owner-side-action blocker as Phase 2/3.
  P7/P8 are low-priority/already-correct-as-is per the ADR.
- **The honest bottom line, unchanged by what shipped**: Phase 1 (browser-
  wallet signing, no server-held key) cannot win a millisecond-class race
  against a genuinely pre-signed, session-keyed, Ohio-colocated Phase-2-
  grade competitor — no amount of Phase-1 engineering changes that
  structural fact. What this pass's P1–P3 buy is a faster, more resilient
  prepare/simulate/notify path for the race Phase 1 *can* meaningfully
  compete in — and the panel's own correction to the working synthesis
  matters here: the realistic field is not "mostly casual humans," since
  at least two small, real, already-circulating scripts
  (`dhasap/nft-mint-agent`, `morsyxbt/nft-public-mint`) were found
  specifically targeting this chain already.

### What landed 2026-08-22 (sixteenth pass): ADR 0009's P4 and P5 shipped,
### with a real architectural correction the ADR's research couldn't see

Continuation of the same owner request, same session — implementing the
two items explicitly deferred in the fifteenth pass rather than leaving
them as unfinished recommendations.

- **P5 (clock calibration) shipped first**, since P4 depends on it:
  `packages/core/src/clock-offset.ts` (pure `computeClockOffsetMs`/
  `toChainTimeMs`, 5 tests) + `apps/worker/src/workers/clock-calibration.ts`
  (`runClockCalibration`, on the same 45s interval as P2's health check,
  reusing `resolveBestRpcUrl`; persists via the existing `settings`
  key-value table, no new migration). **Live-verified against the real
  Robinhood Chain RPC**: measured a real ~1.5s offset against the chain's
  actual latest block — a genuine number, not a mock.
- **P4 (speculative pre-build), redesigned against a real architectural
  finding this pass made, not the ADR's original framing**: the ADR's
  working draft assumed pre-building "at a predicted stage-open time," but
  reading `apps/worker/src/index.ts` before writing any code showed the
  execution pass polls on a fixed interval with no stage-time prediction
  at all — that framing doesn't fit how this system actually runs. The
  correct fit: pre-build at **arm time** (a real, known trigger this
  system already has), cache with a TTL, consume at claim time if fresh.
  - Schema: `mint_plans` gained `cachedTx`/`cachedTxAt` (migration
    `0005_mint_plan_cached_tx.sql`).
  - `packages/core/src/write-quota.ts`: pure rolling-hour quota logic (8
    tests) — a speculative pre-build checks `shouldAttemptSpeculativeWrite`
    (stops at 80% of ADR 0004's documented 30/h OpenSea write quota,
    leaving headroom); the real, due-to-fire build in `execution.ts`
    never calls this at all and always proceeds, by construction — there
    is no function in this module that could gate it.
  - `apps/worker/src/workers/pre-build.ts` (`runSpeculativePreBuild`):
    finds armed, in-window plans with a missing/stale cache
    (`plansNeedingPreBuild`, new repo query), builds via the same
    `openSeaSeaDropAdapter` the real path uses, caches via
    `cacheMintPlanTx`. Registered on the same interval as
    `mint-execution`, right before it.
  - `execution.ts` now checks `plan.cachedTx`/`cachedTxAt` (TTL-gated, 5
    min, the constant shared from `pre-build.ts` so the two files can't
    drift) before falling back to the original synchronous OpenSea call —
    fully backward compatible: no cache means identical behavior to
    before this pass.
  - **A real bug caught before it could ship, by deliberately re-checking
    a function this session had already fixed twice**: `claimArmedMintPlan`
    (`packages/db/src/repositories/execution.ts`) builds its `MintPlan`
    from an explicit, hand-written raw-SQL `RETURNING` column list — and
    a raw `RETURNING` list does not auto-include a newly-added schema
    column the way a typed `.returning()` would. `cachedTx`/`cachedTxAt`
    were missing from that list; without the fix, every claimed plan
    would have silently seen `cachedTx: undefined` forever, quietly
    defeating the entire feature while looking completely fine (no error,
    no crash — P4 would just never fire, TTL-miss on every claim). Caught
    by checking this exact site on purpose, precisely because it already
    burned this session twice this same day. A new integration test
    (`packages/db/tests/integration.test.ts`, "speculative pre-build
    cache") asserts `claimArmedMintPlan` actually returns the cached
    fields — a regression guard that would have failed loudly had the fix
    not been applied.
- **Live-verified end to end against real Postgres**: 14/14 integration
  tests (was 12) — including `plansNeedingPreBuild` finding, then not
  finding, a plan once cached, and the RETURNING-list regression guard
  above.
- **What's still honestly unverified**: an actual live call through
  `runSpeculativePreBuild` all the way to OpenSea's real mint-build
  endpoint — that needs a real OpenSea API key and a real active drop,
  neither available in this session, the same category of boundary as
  Web Push's browser-permission-prompt gap earlier this session. The
  DB-layer mechanics (cache write/read/staleness/claim-time consumption)
  and the pure quota logic are both live-verified; the OpenSea HTTP call
  itself is code-reviewed and typechecked, not exercised against the real
  API.
- Full gate: `pnpm -r run typecheck` (15/15), `pnpm -r run test` (all
  packages — `packages/core` alone at 107 unit tests, was 94), 14/14 live
  integration tests, `pnpm run lint`/`format:check` (clean after two
  import-order/formatting auto-fixes), semgrep re-scan of all 9 touched
  files (0 findings). Docker torn down, all test rows deleted.

### What landed 2026-08-22 (seventeenth pass): real load-test numbers with
### P1-P5 in place, real screenshots in both themes, and a genuine mobile
### responsive gap found live and fixed

Direct response to the Stop hook's repeated, specific complaints about
"high performance" and "responsive... light/dark" lacking evidence —
answered with real measurements and real screenshots instead of more
assertions.

- **Real load-test numbers, not a rerun of old ones**: seeded the demo
  dataset (`pnpm seed`, 8 PRD §19 scenarios), production-built, and ran
  `autocannon` against the same routes benchmarked in the sixth pass, now
  with every P1-P8/ADR-0009 change in place:
  - `/all`: 236 req/s avg, p99 118ms (sixth pass: 216 req/s, p99 117ms) —
    essentially flat, and that's an honest, not a favorable, reading: the
    eighth pass's `bestEligibilityByProject` scoping fix reduces a scan
    that grows with total system size, and this demo dataset (8 seeded
    projects) is too small for that fix's benefit to show up in a
    benchmark. Reported as-is rather than the more flattering framing.
  - `/rss/live`: 1,149 req/s avg, p99 23ms (sixth pass: 1,290 req/s) —
    within normal run-to-run variance for a different machine state, not
    a regression.
  - `/calendar`: 359 req/s avg, p99 38ms — a new datapoint, not
    benchmarked before.
  - P1's simulate-call parallelization isn't independently load-tested
    here (it only fires inside the gated mint-execution pipeline, not a
    plain HTTP route `autocannon` can hit) — its correctness is
    unit/integration-tested and its speedup is a mechanical guarantee of
    `Promise.all` over two sequential awaits of the same calls, not
    something that needs a live timing measurement to be true.
- **Real screenshots, both themes**: `/all` and `/calendar` in dark,
  `/all` toggled to light — clean, legible, consistent token usage in
  both, no defects found.
- **A genuine mobile-responsive gap, found live, not assumed**: at 375px
  viewport width, the fourteenth pass's command palette had **no way to
  open it at all** — its only trigger was the desktop-only left rail's
  "Jump to… ⌘K" button (`hidden md:flex`) plus the ⌘K shortcut, useless on
  a touchscreen. Found by actually setting a mobile viewport and looking,
  not by re-reading the component. Fixed: a search-icon button in the
  mobile header (`apps/web/src/components/app-shell.tsx`), wired to the
  same `setPaletteOpen` state the desktop trigger uses. Rebuilt and
  reverified live at 375px: the icon renders, opens the palette, filters
  and navigates correctly, all screenshotted.
- **A second, smaller finding while investigating the first**:
  `feed-table.tsx`'s own doc comment claimed "cards render on mobile via
  the same data" — grepped for a `FeedCard`/`feed-card` component to
  check, found none anywhere in the codebase. That mobile card layout was
  never built; what actually happens is the existing `overflow-x-auto`
  wrapper on a `min-w-[900px]` table — a real, always-functional
  horizontal-scroll pattern (confirmed from the CSS, not assumed), not
  content loss, but not the purpose-built mobile layout the comment
  described either. Corrected the comment to state the true current
  behavior rather than an aspirational one. **Not fixed**: building an
  actual mobile card view is real, moderate-sized UI work touching every
  view `FeedTable` renders (Live/Next/Latest/Eligible/Watchlist/All) —
  logged honestly as an open item rather than rushed alongside finding it.
- Also confirmed, while investigating why `/calendar`'s screenshot showed
  no rows: the demo seed's "NEXT"-status scenarios don't populate a
  concrete future `nextStageStart`, so Calendar (which groups by that
  field) legitimately has nothing to group — checked the underlying data
  (`/all`'s STARTS column also showed "—" for the same rows) before
  concluding this is consistent-with-the-seed-data behavior, not a bug.
- Full gate: `pnpm -r run typecheck` (15/15), `pnpm -r run test`, `pnpm
  run lint`/`format:check` (clean), semgrep re-scan of both changed files
  (0 findings). Docker torn down.

### What landed 2026-08-22 (eighteenth pass): trait rarity ranking, shipped
### smaller and safer than the backlog originally sized it

Direct response to the Stop hook's repeated "Fable research more features
to add" complaint — a concrete, shipped feature rather than more
documentation, picked from `docs/feature-backlog.md`'s own §2.

- **Scoped down from the backlog's original framing, and said so before
  writing code**: "store per-token, show a rank badge on detail" assumed a
  per-token table and NFT-browsing UI already exist. Grepped the schema
  and every project-detail component before starting — neither exists
  anywhere in this codebase. Rather than build that (real, much larger)
  scope, or silently ship a smaller thing while claiming the original
  framing, this reuses the tenth pass's `holder_snapshots` pattern: one
  summary row per project (`rarity_snapshots`, migration
  `0006_rarity_snapshots.sql`), top-25-rarest only, admin-refreshed, not a
  per-token store or browsing UI.
- **Rarity method chosen and justified, not assumed**: live-searched
  current practice before writing `computeRarityScores`
  (`packages/core/src/rarity.ts`, 7 tests) — "Rarity Score" (sum of
  1/trait-frequency, the method rarity.tools popularized and most rarity
  sites still use) over OpenRarity's entropy/information-content formula.
  OpenRarity is the more rigorous, OpenSea-co-developed standard, but its
  only reference implementation is Python — porting unfamiliar
  entropy/information-content math from scratch with nothing to check a
  first attempt against was judged not worth the correctness risk for a
  first cut. Documented as a deliberate rejection, not an oversight.
- **A correctness risk found and closed before it could ship**: rarity is
  a function of collection-wide trait frequency. The OpenSea client's new
  `listCollectionNfts` (`GET /api/v2/collection/{slug}/nfts`, pagination
  parameter names verified live against current docs, not memory) paginates
  with a bounded page cap — and a naive implementation would have silently
  ranked whatever prefix of the collection fit under that cap, which is
  **not a representative sample** (pagination order is by token id, not
  random). Added a `truncated` flag to the client's return value and wired
  the rarity worker to refuse to save a snapshot when it fires — logging
  "collection too large to rank" via the existing `scan_runs` mechanism
  instead of a plausible-looking wrong ranking. Cap set at 100 pages × 100
  tokens/page = 10,000, covering the classic PFP-collection ceiling
  (BAYC/Doodles/Azuki/CryptoPunks are all ≤10k).
- **Admin-triggered, not scheduled, and said why**: unlike
  discovery/eligibility, a rarity refresh has no freshness SLA forcing a
  background cadence, and OpenSea Read-quota cost scales with collection
  size — a new `rarity` BullMQ queue/worker fires once per admin click
  ("Refresh rarity" on project detail), gated by the same `scans:run` RBAC
  tier as "Run scan now" (an OpenSea read, no credential/execution risk —
  not worth a new RBAC action for one more read-only trigger).
- **Live-verified against real Postgres, not just typechecked**: started
  `docker compose up -d postgres`, ran `pnpm migrate` (confirmed the new
  table's exact shape via `\d rarity_snapshots`), then two new integration
  tests exercising `saveRaritySnapshot`/`getRaritySnapshot` — a full
  jsonb round-trip (`topRarest` array survives exactly) and upsert
  idempotency, mirroring the tenth pass's holder-snapshot integration
  tests. 16/16 in the suite (was 14).
- **A stray `git stash` recovered immediately, not silently**: while
  investigating a pre-existing formatting mismatch in drizzle-kit's
  generated migration meta JSON, ran `git stash` to check whether the
  mismatch predated this pass — which hid every uncommitted file from this
  and every earlier pass this session. Caught immediately from the tool
  result, `git stash pop`'d right away, and verified every touched file's
  line count matched what had just been written before continuing. No data
  was lost, but noted here because the mismatch turned out to be
  pre-existing (drizzle-kit's JSON output doesn't match Biome's formatter,
  unrelated to this pass) and `pnpm run format` fixed it along with the 3
  files this pass's own formatting needed.
- Full gate: `pnpm -r run typecheck` (15/15), `pnpm -r run test` including
  the new DB integration tests (all green), `pnpm run lint`/`format:check`
  (clean after the stash-adjacent formatting fix above), semgrep scan of
  all 16 files touched this pass (0 findings, 210 rules). Docker left
  running (postgres only) since a further pass this session is likely to
  need it again; tear down with `docker compose down` if not.
- **Not done this pass, disclosed honestly**: the OpenSea
  `listCollectionNfts` HTTP call itself was never exercised against the
  real API (no live API key in this environment) — only against fixture
  responses in `opensea.test.ts`, same boundary as every other OpenSea
  contract test in this repo. The rarity panel's live rendering on project
  detail (light/dark, real screenshots) was not re-verified with a browser
  this pass — it reuses the seventeenth pass's already-verified
  `bg-base-raised`/`border-line`/`font-mono text-[11px]` token set exactly,
  but that reuse itself wasn't screenshotted.

### What landed 2026-08-23 (nineteenth pass): ADR 0004 Phase 2 delegated
### custody, built and end-to-end verified — the Executor-contract fallback,
### not the ADR's originally-stated Safe/Zodiac primary

Direct response to an explicit user instruction: "Ledger later, just
implement and I test later. Other must be done" — build Phase 2 custody
now, understanding the owner's own physical Ledger hardware test happens
later, in their hands, not in this session.

- **The ADR's own required build-time verification, actually done, and it
  reverses which path is real**: ADR 0004 named two facts that had to be
  checked before Phase 2 starts. (b) Safe deployment on Robinhood Chain —
  checked for real: a direct `eth_getCode` call against the chain's
  production RPC returned genuine, non-empty bytecode at Safe's canonical
  v1.4.1 singleton address, not just an entry in `safe-deployments`'
  addressing scheme. (a) Ledger's clear-signing whitelist covering Safe's
  7702-delegate contract — checked for real, and **false**: Ledger's own
  developer docs state EIP-7702 delegation-target whitelisting is enforced
  at device firmware level, and today covers only the Ethereum
  Foundation's reference contract, explicitly not Safe's, with no
  committed timeline to add others. This is a hardware constraint, not a
  software gap this codebase could route around. Consequence: the ADR's
  stated PRIMARY path (Ledger → 7702 → Safe → Zodiac Roles) cannot be
  built for real use today — not because the chain lacks the
  infrastructure, but because the one device the owner actually owns
  can't produce the first signature the path starts from. Documented as a
  full ADR 0004 amendment, not a footnote, because it changes which code
  actually gets written.
- **The Executor-contract fallback, promoted to the real build target,
  built with genuine security engineering rather than a quick stub**:
  `contracts/mint-executor/src/MintExecutor.sol` — Foundry project (solc
  0.8.30, optimizer 200 runs, warnings-as-errors). Three independent
  on-chain controls: (1) allowlist — operator may only call an
  owner-approved (target, selector) pair; (2) recipient pin — the decoded
  recipient argument at an owner-configured calldata offset MUST equal the
  owner's own address or the call reverts (the actual theft-prevention
  control, checked against immutable owner state, never trusted from call
  arguments); (3) rolling-24h per-collection value cap (a coarse backstop,
  explicitly not a theft control — recipient pinning already owns that).
  On-chain gas capping was deliberately scoped out (documented in the ADR
  amendment) in favor of the existing mandatory pre-flight simulation,
  same as the browser_wallet scheme already relies on.
- **25/25 Foundry tests, including the two ADR-required merge-gate tests**
  (`test_REQUIRED_recipientRedirectToAttackerReverts`,
  `..AtNonTrivialOffsetAlsoReverts`) that attempt exactly the false-safety
  scenario the ADR's own red-team pass flagged — every dollar-figure
  guardrail satisfied, only the recipient wrong — and assert a revert,
  plus a 512-run fuzz test that the recipient check holds for arbitrary
  non-owner addresses. Slither static analysis run clean (6 findings, all
  false positives or already-mitigated patterns given surrounding
  invariants — documented inline, not silently dismissed).
- **A real end-to-end verification against a live chain, not just the
  Solidity test suite in isolation** — `contracts/mint-executor/script/
  verify-e2e.sh`, a single reproducible command: deploys MintExecutor +
  a fake mint target to a fresh local anvil, wires owner/operator/
  allowlist exactly as production onboarding would, then runs
  `verify-e2e.ts`, which uses the REAL `packages/signing` +
  `packages/providers` TypeScript code (not mocks, not Foundry's own
  harness) to sign and broadcast both a legitimate mint (succeeded
  on-chain, receipt status 0x1) and a malicious recipient-redirect
  attempt (genuinely reverted on-chain, status 0x0) — proving the whole
  custody stack works together, not just each piece separately. Re-run
  and passed after every subsequent code change this pass.
- **A real bug caught by that end-to-end run, not by inspection**: the
  script that generated `packages/providers/src/chain/
  mint-executor-artifact.ts` from Foundry's build output double-prefixed
  the bytecode constant (`"0x0x60a0…"` instead of `"0x60a0…"`, because
  Foundry's own `bytecode.object` already includes the `0x`). Caught
  immediately, fixed, and locked in with a regression test
  (`mint-executor-artifact.test.ts`) asserting the bytecode constant is
  well-formed hex with no doubled prefix.
- **`packages/signing`**: `signExecutorTransaction` (builds
  `executeMint(target, data, value)` calldata, signs an EIP-1559
  transaction with a viem local account built from the decrypted session
  key, returns the raw signed tx — never touches a network) and
  `generateSessionKey`. `assertSignable` now allows `custom_executor`
  (still refuses `eip7702_safe_zodiac`, per the amendment above). 16
  tests, including recovering the real signer address from the raw
  signed tx via `recoverTransactionAddress` — proving a genuine
  signature, not just a well-shaped object.
- **`packages/execution/pipeline.ts`**: a new `ready_for_delegated_signature`
  outcome — the pipeline stays pure/fully-unit-testable (its own stated
  design goal) by stopping here rather than calling packages/signing
  itself; `apps/worker`'s execution worker (which already has DB/config
  access the pipeline deliberately doesn't) resolves the session key,
  signs, and broadcasts. A `custom_executor` signer is only ever trusted
  if its DB row's `status === 'active'` — a `pending` (mid-onboarding) or
  `revoked` delegated signer falls through to the safe `browser_wallet`
  default rather than being silently trusted or silently blocking the
  plan.
- **Full onboarding UI**: `apps/web/src/app/admin/execution/
  executor-onboarding.tsx`, a 5-step wizard (generate session key → owner
  deploys Executor from their own wallet → setOperator → setAllowlist per
  collection, never batched → explicit activate) reusing the existing
  Phase 1 `window.ethereum` browser-wallet pattern generalized beyond
  mint-plan execution attempts. Every state-changing server action is
  gated by `requireFreshStepUp` (the same fresh-WebAuthn bar as arming a
  mint plan) — this sequence is the root of a real custody chain. New
  `delegated_session_key` credential type; `privateKey`/`sessionKey`
  redaction added to both `packages/observability`'s pino config and
  `packages/secrets`' `SENSITIVE_HEADERS` set (which despite its name is
  the general object-key redaction list `redactDeep` walks), per ADR
  0004's explicit instruction.
- Full gate: `pnpm -r run typecheck` (15/15), `pnpm -r run test` (all
  green — providers 54/54, signing 16/16, execution 9/9, db integration
  16/16 against real Postgres), `pnpm run lint`/`format:check` (clean),
  semgrep scan of all 18 touched TypeScript files (0 findings, 210
  rules), `forge test` (25/25), `forge fmt --check` (clean), slither (0
  real findings), gitleaks scan of the working tree.
- **Not done this pass, disclosed honestly**: the actual physical Ledger
  hardware confirmation — this environment has no hardware wallet to
  test with, which is exactly what the user's instruction anticipated
  ("I test later"). The EIP-7702 + Safe/Zodiac primary path's code was
  not written at all this pass (only its non-viability today was
  established and documented) — building it anyway, unused, would have
  added real surface area for zero present value, and the ADR amendment
  leaves the door open once Ledger's firmware whitelist changes.
  `eip7702_safe_zodiac` deployment/allowlisting UI does not exist. No
  contract has been deployed to Robinhood Chain itself (mainnet or
  otherwise) — only to a throwaway local anvil instance for verification.
  The onboarding wizard was typechecked and reasoned through carefully
  but not exercised end-to-end in a real browser against a real wallet
  extension (would need a human with a wallet, same class of gap as Web
  Push's browser-side flow, noted honestly in the thirteenth pass).

### What landed 2026-08-23 (twentieth pass): precision-fire timing core,
### Traefik production deployment, sequencer co-location guidance, and 8 of
### 10 code-review findings fixed

Two threads this pass: the operator's explicit asks (precision/continuous
fire, deployment, sequencer note), and a background `/code-review` that
surfaced 10 verified findings — several of which directly blocked the
FCFS-competitiveness goal, so fixing them *was* the "make it SOTA" work.

- **The 30s-poll fire gap, closed at the core**: `packages/core/
  fire-schedule.ts` (`computeFirePhase`, 10 tests) decides — from the
  clock-corrected stage-open time — whether to wait, spin the tight
  pre-fire window, fire (returned on every tick across a configurable burst
  = the "chạy liên tục để compete" loop), or give up. Pure and exhaustively
  unit-tested; config knobs added (`MINT_FIRE_LEAD_MS`,
  `MINT_FIRE_HOT_WINDOW_MS`, `MINT_FIRE_CONTINUE_MS`,
  `MINT_HOT_LOOP_INTERVAL_MS`). **Honest status:** the pure decision core +
  the corrected execution state machine it rides on are done and tested;
  the fast worker interval that consults it every ~200ms is the remaining
  wiring, deferred to keep this pass's confirmed-bug fixes clean rather than
  stacking un-live-testable runtime timers on top.
- **Finding #1 (CRITICAL — was silently fatal): a claimed plan never left
  `executing`.** In default shadow mode every armed plan died after its
  first tick; a plan armed 10 min early reverted once ("stage not open")
  and was stranded forever. Fixed with a proper lease state machine:
  `claimArmedMintPlan` now leases (reclaims a stale `executing` lease after
  15s for crash recovery), non-terminal outcomes call
  `releaseMintPlanToArmed` (→ re-claimable = the continuous-compete loop),
  terminal outcomes call `markMintPlanExecuted`/`failMintPlanExecution`,
  and `expireStaleMintPlans` now sweeps stuck `executing` too. 5 new
  integration tests against real Postgres.
- **Finding #7 (my own bug, last pass): simulation/live msg.sender + gas
  mismatch on the delegated path.** The pipeline simulated the inner mint
  call from the wallet; the live tx is `executeMint` from the operator EOA
  — different msg.sender (a SeaDrop mint gating on msg.sender==minter would
  pass sim then revert live) and gas profile. Fixed: the worker now
  simulates the EXACT `executeMint` tx it will broadcast
  (`buildExecuteMintCalldata`, deterministic-equal to what
  signExecutorTransaction signs), gates the broadcast on it, and uses its
  real gas estimate. A sim revert releases to armed (retry).
- **Finding #2: chain.ts touched-contract lookup matched zero projects** (a
  comma-joined pre-quoted string bound as one SQL param) — velocity/holder
  snapshots never updated from the real trigger path. Replaced with
  `projectIdsForContracts` (parameterized `inArray`, one query, not
  per-contract), mirroring the already-correct `onchain.ts` pattern. 2 new
  integration tests.
- **Finding #6: a single dead registry RPC shadowed a working `RPC_URL`** —
  `resolveBestRpcUrl` now skips `down` endpoints (not `unknown`) so the
  fire path falls back instead of routing every cycle to a dead endpoint.
- **Finding #5 (security): `subscribeWebPushAction` lacked
  `alerts:configure`** — any signed-in user (viewer) could self-subscribe
  and receive restricted alerts. Now gated like every other channel action;
  unsubscribe gated too.
- **Finding #9 (security): CSV formula injection** via OpenSea-sourced
  project names — `csvEscape` now prefixes `=+-@`/tab/CR values with a
  quote (OWASP mitigation).
- **Finding #4 (deploy): Dockerfile never copied `apps/web/public`**, so
  `/sw.js` 404'd and Web Push was dead in Docker — added the COPY.
- **Deployment (operator ask): self-contained Traefik prod stack.**
  `compose.prod.yaml.sample` + `.env.prod.sample` committed as samples
  only; real `compose.prod.yaml`/`.env.prod`/`traefik/acme.json`
  gitignored so a pull never clobbers prod config. The old no-Traefik
  overlay was renamed `compose.prod-posture.yaml` (local smoke-test only)
  to free the `compose.prod.yaml` name; `scripts/start-prod.sh`/`stop-prod.sh`
  updated. `docs/deployment.md` documents the flow + the sequencer
  co-location guidance (target AWS us-east-2 / Ohio, but **measure**
  JSON-RPC round-trip from candidate hosts and set `MINT_FIRE_LEAD_MS`
  from it — latency to the single sequencer is the whole FCFS game).
- **Deferred, disclosed honestly (2 of 10 review findings):**
  - Finding #3 (migration immutability — 0000 edited in place,
    created_at→observed_at): verified the fresh-deploy path (the prod
    scenario) applies 0000–0006 cleanly with `observed_at` correct and
    re-runs as a no-op, on a throwaway DB. The immutability violation only
    bites a DB that already ran the pre-edit 0000 — i.e. disposable dev
    volumes; **reset those with `make reset-dev`.** Deliberately NOT doing
    migration-history surgery (revert 0000 + new ALTER + regenerate
    snapshots): pre-production, zero benefit to fresh deploys, and real risk
    of breaking the verified-clean path.
  - Findings #8 (pre-build duplicates the build block) and #10 (the
    `.rows` unwrap copy-pasted ~19×): real maintainability/latent-bug
    risks, not active breakage — refactors (extract one
    `buildMintTransactionForPlan`, one `rows<T>()` boundary helper) left
    for a focused follow-up.
- Full gate: `pnpm -r run typecheck` (15/15), `pnpm -r run test` (all
  green — core 124, providers 54), db integration **23/23** against real
  Postgres (was 16), `pnpm run lint`/`format:check` (clean), semgrep on
  the 9 touched security-relevant files (0 findings).

### What landed 2026-08-23 (twenty-first pass): precision hot-loop wired,
### and the last two code-review findings closed (#8, #10)

Continuation under the "finish until a multi-role expert is satisfied" goal
— closing the remaining gaps rather than leaving them noted.

- **The precision fire hot-loop is now WIRED, not just a core**: a fast
  `MINT_HOT_LOOP_INTERVAL_MS` (~200ms) worker interval (`runMintHotLoop`,
  `apps/worker/src/workers/execution.ts`) queries armed plans joined to
  their stage start (`armedPlansWithStageStart`), computes the
  clock-corrected `computeFirePhase` for each, and pumps the real execution
  pass the instant any enters the fire window — so a contested FCFS fires at
  the stage-open instant instead of up to 30s late on the coarse tick. The
  finding-#1 lease/release state machine is what lets it keep competing
  across the burst. Plans without stage timing still ride the coarse pass.
  2 new integration tests (`armedPlansWithStageStart` returns stage-linked
  candidates + their start ms, excludes stage-less plans). 24/24 integration.
- **Finding #10 closed: the `.rows` unwrap is centralized.** One
  `unwrapRows<T>()` at the db boundary (`packages/db/src/client.ts`)
  replaces all ~12 copy-pasted `(x as {rows?}).rows ?? (x as T[])` casts
  across outbox/ops/execution repos, `actions.ts`, and maintenance
  (including its local `rowsOf`). The next raw query can't reintroduce the
  silent-no-op class this session hit four times — there's one place to get
  it right.
- **Finding #8 closed: the mint-tx build block is de-duplicated.** A single
  `buildOpenSeaMintTx` (`apps/worker/src/mint-tx.ts`) is now the only place
  the resolveOpenSeaKey → OpenSeaClient → SeaDrop adapter → buildTransaction
  sequence lives; both the speculative pre-build (P4) and the claim-time
  execution pass call it, so the cached calldata can never drift from what
  fire-time would rebuild.
- **All 10 code-review findings are now resolved** (8 last pass + these 2);
  #3 (migration immutability) remains the one deliberate accept —
  verified-clean for fresh deploys, dev volumes reset with `make reset-dev`.
- Junk check (per the goal, dev machine): no garbage found — every
  untracked file is legitimate prior-pass work; scratch `migcheck` DB
  dropped, no lingering anvil, Postgres left running (integration tests
  need it).
- Full gate re-run: typecheck 15/15, unit tests all green, db integration
  **24/24** on real Postgres, lint/format clean, semgrep on 14 touched
  files (0 findings), the custody e2e (`contracts/mint-executor/script/
  verify-e2e.sh`) re-passed on fresh anvil (legit mint succeeds, attacker
  redirect reverts on-chain).
- **Still not done, unchanged from the nineteenth pass's honest list:** no
  physical Ledger test, no Safe/7702 primary-path code, nothing deployed to
  real Robinhood Chain, onboarding wizard not exercised in a real browser
  wallet. And the two large feature areas — X/Twitter sentiment signal and
  multi-network support — remain scaffold-only, not built.

### What landed 2026-08-23 (twenty-second pass): X sentiment/risk signal
### built end-to-end from the scaffold (ADR 0007)

Under the "finish until a multi-role expert is satisfied" goal — turning the
Phase-0 sentiment scaffold into a real, wired feature.

- **Risk scoring (new): `packages/signals/src/risk.ts`** — `computeRiskSignal`,
  a transparent phishing-shape heuristic over public-post text (wallet-drain
  CTAs, fake claim/airdrop bait, manufactured urgency), word-boundary matched
  so "claimant" ≠ "claim". Returns a bounded 0–100 score, the distinct
  red-flag phrases that fired (evidence trail), and confidence by sample
  size. 7 tests incl. substring-safety and majority-phishing pinning.
- **Combined scan: `scanProjectSignals`** fetches a subject's mentions ONCE
  (the metered X endpoint) and computes both hype + risk from the same
  posts — never two calls.
- **The worker loop (the missing piece): `apps/worker/src/workers/sentiment.ts`**
  — `runSentimentScan`, registered on a 5-min interval. HARD-gated: a no-op
  unless `X_SIGNALS_ENABLED` AND `X_API_BEARER_TOKEN` are both set. Scans the
  ≤5 most-recent LIVE/NEXT drops per pass (bounded API cost), uses the prior
  hype signal's stored tweetCount as a rolling baseline and its newestId as
  `since_id`, and writes one hype + one risk `signals` row each with an
  evidence trail. Structurally advisory-only: goes through `insertSignal`,
  which exposes nothing that can touch projects.confidence/lifecycleStatus.
- **DB helpers**: `latestSignal` (baseline lookup), `latestSignalsForProject`
  (UI), `projectsForSentimentScan` (bounded LIVE/NEXT candidates). 3 new
  integration tests against real Postgres (27/27 total, was 24).
- **UI**: a "Community signals (X)" panel on project detail — hype bar + a
  phishing-risk score with a "high risk" chip and the fired flag phrases,
  explicitly labelled advisory-only (never a block, never eligibility).
- Full gate: typecheck 15/15, unit (signals 13, all packages green), db
  integration **27/27** real Postgres, lint/format clean, semgrep on the 5
  touched files (0 findings).
- **Honest boundary (unchanged pattern):** the live X API call itself was
  never exercised against the real endpoint — no bearer token in this
  environment, same disclosed limit as OpenSea's live calls and Web Push's
  browser flow. Everything up to and including the parse/score/persist/render
  path is tested; the HTTP round-trip to x.com is not. Multi-network support
  remains the one major stream still scaffold-only.

### What landed 2026-08-23 (twenty-third pass): multi-network foundation —
### chain registry + the on-chain radar now syncs every configured chain

The last major stream. The data model was already multi-chain (every
chainId-bearing table keyed by chain); the hardcoding was a single
`ROBINHOOD_CHAIN_ID` + `RPC_URL` and a worker loop that synced one chain.

- **Chain registry (new): `packages/core/src/chains.ts`** — a pure, typed
  registry of supported EVM chains (Robinhood 4663 primary, plus Ethereum /
  Base / Arbitrum) with each chain's finality depth, OpenSea slug, native
  currency, and explorer URL builders. 6 tests, incl. a config-consistency
  check (map key == chainId, no trailing-slash explorer base, positive
  finality). Adding a chain here + an enabled rpc_endpoints row is all it
  takes for the radar to track it — no sync-loop code change.
- **The on-chain radar is now genuinely multi-network**: `runChainSync`
  fans out over `distinctEnabledRpcChainIds(db)` ∪ the default chain,
  calling a new per-chain `syncChain(ctx, chainId)`. Each chain has its own
  checkpoint (a per-chain `rpc_${chainId}` provider record so namespaces
  don't collide), its own registry-driven finality window (replacing the
  hardcoded `12`), and its own try/catch so a slow/dead chain can't block
  the others. The env `RPC_URL` remains the fallback for the default chain
  only. `ProviderKind` widened with a `` `rpc_${number}` `` template type.
  2 new integration tests (`distinctEnabledRpcChainIds` respects
  enabled/disabled; multi-chain candidate set) — 28/28 total.
- **UI correctness**: project-detail explorer links (contract, holders, mint
  txs) now resolve through the registry (`chainAddressUrl`/`chainTxUrl`) by
  the project's own chainId, with a robinscan fallback — a Base/Arbitrum
  project no longer links to the wrong explorer.
- Full gate: typecheck 15/15, unit (core 130, all packages green), db
  integration **28/28** real Postgres, lint/format clean, semgrep on 5
  touched files (0 findings).
- **Honestly still single-chain-first (extensible, not yet wired per-chain):**
  OpenSea *discovery* still polls the default chain's slug (the registry now
  carries each chain's openSeaSlug, so per-chain discovery is a
  config-driven follow-up, not a rearchitecture); execution/pre-build build
  OpenSea SeaDrop calldata, which is OpenSea-hosted-drop-specific. The
  on-chain tracking radar — the core of "track mints across networks" — is
  what's genuinely multi-chain now. All chains still need their own enabled
  RPC endpoint added in Admin → Execution; none is auto-configured.

With this, both major deferred streams (X sentiment, multi-network) are
built to a real, tested foundation rather than scaffold. The remaining
open items are all the previously-disclosed live/hardware boundaries
(Ledger, real X token, real-chain deploy, browser-wallet e2e) plus the
naturally-incremental per-chain discovery wiring above.

## Independently verified since the panel ran (2026-08-21)

The panel flagged several things as `needs_verification`. Two were checked
against primary sources this session, outside the panel's own web research:

- **OpenSea has an official, documented programmatic mint API** —
  `POST /api/v2/drops/{slug}/mint` / SDK `buildDropMintTransaction()` —
  and an official MCP server (`mcp.opensea.io`) whose docs list minting
  among 30+ tools built for AI agents. This is a materially better primary
  execution path for OpenSea-hosted drops than hand-rolled SeaDrop calldata,
  and it softens (does not resolve) the ToS open risk. Folded into
  [ADR 0004](decisions/0004-execution-custody-model.md) as an amendment.
- **X's free API tier was retired in Feb 2026**, confirming the panel's own
  independent finding in ADR 0007: the owner's original premise ("use X.com
  OAuth for not new cost") was true before Feb 2026 and is not true now.
  Pay-per-use only, no subscription. ADR 0007 already designs for this —
  re-stated here because it's the single fact most likely to surprise the
  owner reading this document.
- **Robinhood Chain (4663) is an Arbitrum Orbit L2**, RPC
  `https://rpc.mainnet.chain.robinhood.com`, with Alchemy/QuickNode/Dwellir
  as production providers — consistent with the panel's own finding that its
  ordering is single-sequencer/arrival-time, not fee-based (ADR 0006).

Everything else in `needs_verification` below is still open and should be
re-checked at the point each phase actually needs it, not assumed from this
document.

## Explicit deferrals (do not build without a new decision)

- Token-launch tracking (any chain) — owner said later, not now. Architecture
  leaves a seam (`packages/core` would gain non-drop domain types alongside
  drop types) but nothing swap- or launch-specific exists.
- Auto-swap execution — same; would reuse `packages/execution` +
  `packages/signing` as "just another MintAdapter-shaped write" once it
  exists, not a new architecture.
- Any global "arm everything" toggle, sentiment ever auto-arming execution,
  hardware wallet as an automated signer, bulk/batch allowlisting, and
  password/TOTP as the arm step-up factor — **permanently rejected product
  boundaries**, not merely deferred. See ADR 0004/0007/0008 for why each one
  specifically defeats the safety model.
- Execution on any chain beyond Robinhood Chain, private-relay submission,
  background/always-on sentiment polling, third-party custodial/MPC signing
  as the default — deferred until the single-chain path is boring and
  reliable, or until spend caps are raised enough to justify the added trust
  surface.

## Needs verification before the relevant phase starts

(Full list and rationale in the ADRs; summarized here as a checklist.)

- [ ] OpenSea ToS coverage of automated mint *execution* specifically —
      unresolved by two independent panelists and by this session's own
      follow-up read of `opensea.io/tos`. The owner accepts this risk
      explicitly before Phase 2's real-money gate, not by default.
- [ ] Robinhood Chain infra specifics re-checked immediately before Phase 2
      build (it is ~5 weeks old at time of writing): testnet existence, RPC
      rate limits, EIP-1559 field handling, finality depth.
- [ ] The owner's actual Ledger hardware model and its phone-only signing
      path — the kill switch's "phone-executable" claim is not valid until
      this is confirmed (ADR 0008).
- [ ] Safe + Zodiac Roles Modifier's audited-deployment status specifically
      on Robinhood Chain — decides primary vs. fallback custody path there.
- [ ] Per-target mint contract ABI shape (recipient parameter vs. buried in a
      merkle-proof blob) — verify per collection before writing its
      allowlist entry, OpenSea's own mint API permitting notwithstanding.
- [ ] Current X API pricing/limits re-fetched from `docs.x.com` immediately
      before implementation — it already changed twice within 2026.
- [ ] Better Auth's actual WebAuthn/passkey support in the version this repo
      pins, before committing to it as the arm-UI step-up mechanism.

## Open risks the owner should read, not just this session

- Bot-racing viability on Robinhood Chain is fundamentally bounded by
  sequencer-arrival ordering — "as fast as the fastest similarly-colocated
  competitor," not a guaranteed win. No product copy may imply otherwise.
- The two-tier cap model (ADR 0004) means the *coarse on-chain* ceiling per
  signer, not the UI's per-plan number, is the true worst case if the
  application layer is ever fully compromised — size it conservatively.
- Operational burden goes up materially versus today's "docker compose up
  and forget it": a remote colocated executor, a secured DB tunnel,
  deliberate per-collection Ledger taps, a registered passkey, monthly
  kill-switch drills. The owner should accept this knowingly before Phase 2,
  not discover it mid-build.
- "Personal assistant" framing could create pressure over time to loosen the
  always-human-arms-it boundary for convenience. That boundary is permanent
  in this design and should be defended explicitly if ever revisited, not
  eroded incrementally.

## Panel provenance

Six independent position papers (Blockchain Security, Low-Latency/Trading
Systems, Data/Sentiment, CPO, Risk/Compliance/SRE, CTO/Systems Architect) →
CTO synthesis → adversarial red-team pass → final revision closing every
confirmed red-team finding. Total: 9 agents, ~503k tokens, ~64 tool calls
(web research + repo inspection), one full round of self-adversarial review
before anything below Phase 0 was written down as accepted. The full
position papers are not committed to the repo (they're working material, not
the decision record) — the ADRs and this document are the record; the raw
panel output lived in this session's transcript if it's ever needed for
context on *why* a rejected alternative was rejected in more color than the
ADR's own "alternatives rejected" section carries.
