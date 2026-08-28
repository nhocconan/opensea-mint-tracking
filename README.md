# HoodMint Radar

Self-hosted NFT drop discovery and allowlist eligibility radar for **Robinhood Chain** (chain id `4663`).

HoodMint Radar continuously discovers OpenSea drops and on-chain mint activity, normalizes them into one trustworthy feed with full provenance, checks your wallets for stage-level allowlist eligibility, and alerts before an opportunity expires.

**Discovery, eligibility-checking, and sentiment/signal evaluation are always read-only** — no code path there ever holds a private key. An OpenSea PAT restricted to `read:eligibility` may be stored encrypted (AES-256-GCM) and exchanged server-side for a short-lived wallet JWT. A public mint is never reported as a whitelist win.

> **Execution is a separate, opt-in, admin-only capability** (ADR 0003): a minting calendar, crypto-Twitter/X risk signal, and — behind heavy gating — delegated mint execution. Its Phase 1 backend and WebAuthn-gated arm/disarm flow have landed in **shadow mode by default** (`LIVE_EXECUTION_ENABLED=false`); arming a mint plan requires registering a passkey and re-verifying with it (Admin → Execution), not merely being signed in. Two signer paths are implemented: your own browser wallet (client-side `eth_sendTransaction` prompt in Admin → Execution) and — once an executor signer is onboarded through the Executor wizard — a delegated `custom_executor` path in which the worker signs with an AES-256-GCM-encrypted session key and broadcasts autonomously via the MintExecutor contract. That means an armed plan with an active executor signer and `LIVE_EXECUTION_ENABLED=true` **can** broadcast without a human at the fire instant, and the encrypted session key **is** spend-capable within its on-chain ceiling. Your hardware wallet is never an automated signer, in any phase. See [`docs/execution-architecture.md`](docs/execution-architecture.md) and [ADR 0003](docs/decisions/0003-scope-the-read-only-invariant-to-per-surface-not-per-app.md).

> **Operator guide (Admin CP):** [`docs/admin-guide.md`](docs/admin-guide.md) — first login, OpenSea key, tracking + managed minting wallets, X/Grok signals, arming & live execution. Also in-app at **Admin → Guide** (`/admin/guide`).

> Implementation handoff docs: [`PRD.md`](PRD.md) (acceptance contract) · [`DESIGN.md`](DESIGN.md) · [`AGENTS.md`](AGENTS.md) · [`HANDOFF_PROMPT.md`](HANDOFF_PROMPT.md) · [`docs/execution-architecture.md`](docs/execution-architecture.md) (execution roadmap). The original Python prototype is preserved under [`reference-python-mvp/`](reference-python-mvp/).

## Architecture

```text
apps/
  web/        Next.js 16.3 App Router — feeds (All/Live/Next/Latest/Eligible/Watchlist),
              Minting Calendar, project detail with provenance, admin console
              (incl. Execution, ADR 0003–0008), /setup bootstrap, versioned
              JSON API (§10), SSE invalidation, /health + /metrics
  worker/     BullMQ discovery scheduler + detail refresh; eligibility engine,
              on-chain radar (checkpointed eth_getLogs + reorg replay),
              mint-watch/execution loop (shadow mode by default, ADR 0005/0008),
              notification outbox dispatcher, maintenance (retention, key rotation)
packages/
  config/     Zod-validated environment (single boundary for process.env)
  core/       Pure domain: lifecycle status, eligibility classification,
              quota math, scheduling, dedupe keys, branded types (bigint wei),
              mint-plan firing policy + RPC-pool ranking (ADR 0005/0006)
  secrets/    AES-256-GCM seal/open, fingerprints, redaction
  signing/    The sole signing chokepoint (ADR 0004/0005) — only browser-wallet
              client-side signing is implemented; every delegated scheme throws
  execution/  Mint-execution pipeline: simulate → policy check → sign hand-off
              (ADR 0005), OpenSea's own mint API as the adapter (ADR 0004)
  db/         Drizzle schema (27+ tables, PRD §9 + ADR 0004/0006/0007), repositories,
              generated SQL migrations
  providers/  OpenSea Drops client (chain resolution, pagination, ETag, quota
              guard, PAT exchange, instant keys, official mint API) + viem
              on-chain radar + eth_call/estimateGas pre-flight simulation
  queues/     BullMQ queue contracts with deterministic job ids (PRD §8.4)
  notifications/ Telegram + webhook adapters, SSRF guard, outbox dispatcher
  observability/ pino structured logs, Prometheus registry, correlation ids, OTel spans
  auth/       Better Auth (admin + 2FA plugins), RBAC matrix, bootstrap tokens
infra/docker/ Multi-stage non-root app image (web/worker/migrate from one image)
scripts/      bootstrap, seed (PRD §19 demo dataset), smoke, backup/restore, integration tests
```

Runtime topology (compose): `web` + `worker` + `postgres:18` + `valkey:8` + one-shot `migrate`. Valkey holds queues/cache only — all durable state lives in PostgreSQL, which is also the only thing that needs backups (`make backup` / `make restore`).

Realtime: workers NOTIFY a Postgres channel; the web process fans it out to browsers over SSE (`/api/v1/events`). Clients refetch affected views; a 30s polling fallback covers disconnects.

## Quickstart

Local host ports start at **3960** (web `3960`, Postgres `3961`, Valkey `3962`, worker health `3963`) so this stack does not collide with other dev environments. PRD §16's `:3000` remains a valid override via `APP_URL` / `PORT`. Visual system: [`DESIGN.md`](DESIGN.md) (dark default + light theme).

```bash
scripts/start-dev.sh    # env-setup + stores + migrate + web + worker
make token              # prints a one-time /setup token (30 min, single use)
# open http://localhost:3960/setup → create the first admin
scripts/stop-dev.sh     # stop all HoodMint dev processes and Compose services (volumes stay intact)
```

If `.env` is missing or secrets are empty, `start-dev` / `start-prod` run a six-step setup and print [`docs/ops-setup.md`](docs/ops-setup.md). You can also run it alone: `scripts/env-setup.sh --mode=dev` (or `--mode=prod`).

Production posture (Docker, unpublished Postgres/Valkey):

```bash
scripts/start-prod.sh   # env-setup --mode=prod + compose.yaml + compose.prod.yaml
# open http://localhost:3960/setup
scripts/stop-prod.sh
```

Public deploy: set `APP_URL=https://your-domain` in `.env` before `start-prod`. http is allowed only for localhost.

`/setup` closes itself once an admin exists; public signup stays disabled. The wizard continues in **Admin → OpenSea** (API key / PAT), **Admin → Wallets**, and **Admin → Alerts** (Telegram/webhook with test delivery). The dashboard is fully useful in discovery-only mode without wallet auth.

Demo data (PRD §19): `make seed` inserts a live public drop, an eligible presale, an ineligible presale, a public-only result, a sold-out drop, a stale provider, a conflicting-source record, and an alert retry — under a persistent `DEMO DATA` banner (toggle in Admin → System).

## Commands

```text
scripts/start-dev.sh / scripts/stop-dev.sh
scripts/start-prod.sh / scripts/stop-prod.sh
scripts/env-setup.sh --mode=dev|prod
make start-dev / stop-dev / start-prod / stop-prod
make up / down / logs / ps
make test / lint / typecheck / verify
make migrate / migration name=...
make seed / reset-dev
make backup / restore file=...
make smoke               # clean-start Docker smoke test
make token               # one-time /setup bootstrap token
```

Merge gates (PRD §15): `pnpm install --frozen-lockfile && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm test:e2e && docker compose config --quiet`.

## Credentials & scopes

| Credential | Where | Scope / notes |
|---|---|---|
| OpenSea API key | Admin → OpenSea (encrypted) | read-only lists/details; Developer Portal key preferred; free instant key auto-created/rotated when absent |
| OpenSea wallet PAT | Admin → OpenSea (encrypted) | **must be scoped to `read:eligibility` only**; exchanged server-side for a ~12h JWT, kept in worker memory |
| Telegram bot token | Admin → Alerts (encrypted) | bot API send-only |
| Webhook URL | Admin → Alerts (encrypted) | HTTPS only; private/loopback IPs rejected after DNS resolution; redirects never followed |

Secrets are AES-256-GCM encrypted with `APP_ENCRYPTION_KEY` (key version stored for rotation), write-only after save, displayed as a one-way fingerprint, redacted from logs/errors/exports, and covered by tests. The app never asks for seed phrases or private keys.

## Operating costs (OpenSea free tier)

Discovery makes 3 list calls per cycle before pagination. At the default 5-minute interval that is **36 reads/hour**; with 20 eligibility candidates on the naive schedule it would be 276/hour — the PRD's dynamic schedule (6h when >24h out, 30m inside 24h, 5m inside 1h/live) uses far less. The provider stops before exhaustion with a configurable 10% reserve and rotates free 7-day instant keys automatically. See PRD §12 for the full table.

## Backups & retention

- `make backup` → `backups/hoodmint-<ts>.sql.gz` (PostgreSQL only; Valkey is disposable by design).
- `make restore file=…` + restart app services; restore path is smoke-tested via the integration harness.
- Default retention: evidence 30d, scan runs 90d, mint events 180d, aggregates/audit indefinite (maintenance worker enforces; policy documented in Admin → System).

## Limitations

- OpenSea's drop feed is curated; the on-chain radar catches non-featured contracts but eventless/non-standard NFTs may be invisible (PRD §3).
- Custom Merkle allowlists cannot be reversed from their root; non-OpenSea presales need a project-specific adapter or live simulation.
- Public-stage eligibility is never treated as a whitelist result; public-only drops are labelled `PUBLIC ONLY`.
- Rolling-window mint velocity is never displayed as total supply; caps are only shown when verified.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/health/ready` 503 | `make migrate`, check `docker compose logs postgres` |
| Provider `down` in Admin | Check quota reserve/key expiry in Admin → OpenSea; instant keys rotate within 24h of expiry |
| No eligibility verdicts | Add a wallet (Admin → Wallets) and a `read:eligibility` PAT (Admin → OpenSea) |
| Alerts not arriving | Admin → Alerts → Test; check outbox attempts in Admin → System |
| `compose config` env error | `make bootstrap` (creates `.env`) |

## Reference

Stack: Next.js 16.3 · React 19.2 · Tailwind 4.3 · PostgreSQL 18 · Drizzle · Valkey 8 + BullMQ · viem · Better Auth · Zod · Pino/OTel · Vitest/Playwright · Biome. Exact pins live in the committed lockfile.
