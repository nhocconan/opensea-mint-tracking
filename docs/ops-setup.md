# Operator setup — start-dev and start-prod

Local host ports start at **3960** (web `3960`, Postgres `3961`, Valkey `3962`,
worker health `3963`). Internal container ports stay `5432` / `6379`.

## 1. Prerequisites

1. Docker Desktop (or Engine + Compose v2) — running.
2. `openssl` (secret generation).
3. Node 24 + pnpm 11 only required for `scripts/start-dev.sh` local Next.
   `scripts/start-prod.sh` is Docker-only.

## 2. Environment file

```bash
cp .env.example .env
scripts/env-setup.sh --mode=dev    # or --mode=prod
```

`env-setup` walks six steps and **never overwrites a non-empty secret**:

1. Docker + openssl
2. Create `.env` from `.env.example` if missing
3. Generate `APP_ENCRYPTION_KEY` (32-byte base64) and `BETTER_AUTH_SECRET` (≥32)
4. Write 3960-series `APP_URL` / `PORT` / `DATABASE_URL` / `VALKEY_URL`
5. Set `APP_ENV` (`development` or `production`)
6. Report optional `OPENSEA_API_KEY` / `RPC_URL` (Admin UI can set these later)

Doctor without writes:

```bash
scripts/env-setup.sh --mode=prod --check-only
```

### Production `APP_URL`

- Local production smoke: `APP_URL=http://localhost:3960` is allowed.
- Public deploy: `APP_URL=https://your-domain` (http is rejected except localhost).
- Compose overrides `DATABASE_URL` / `VALKEY_URL` inside containers to
  `postgres://…@postgres:5432/…` and `redis://valkey:6379/0`.

## 3. Start

```bash
scripts/start-dev.sh     # local Next + stores. Stop: scripts/stop-dev.sh
scripts/start-prod.sh    # Docker prod overlay. Stop: scripts/stop-prod.sh
make token               # one-time /setup bootstrap token
# open http://localhost:3960/setup
```

Both starters run `env-setup` first. If a step fails they print this guide
and exit non-zero.

## 4. After /setup

In **Admin → OpenSea / Wallets / Alerts** (not in `.env` if you can avoid it):

- OpenSea Developer Portal key, or let the worker rotate a free instant key
- Wallet PAT scoped to `read:eligibility` only
- Display-only wallet address
- Telegram bot token or HTTPS webhook

The app never asks for a seed phrase or private key.

## 5. Health

- `GET /health/live` — process up
- `GET /health/ready` — dependencies
- `GET /setup` — first-admin form or “already completed”

PostgreSQL connections carry `application_name` values `hoodmint-web`, `hoodmint-worker`, and
`hoodmint-events`. The default single-process production budget is 6 web pool connections, 8
worker pool connections, and 1 dedicated LISTEN connection. Diagnose unexpected growth with
`pg_stat_activity`; do not raise `max_connections` before identifying the client name and state.

If the UI reports `max connections reached`, capture `application_name`, `state`, query age, and
the active query text from `pg_stat_activity`. A full web pool usually means requests are holding
connections on an expensive read, not that the pool itself is too small. Feed requests must read
`mint_activity_snapshots`; raw `mint_events` aggregation belongs to the worker. Periodic jobs must
use the non-overlapping scheduler, and provider `429` responses must park work for `Retry-After`
instead of creating more concurrent retries.
