# Robinhood Mint Watch

> **Implementation handoff:** Read [`PRD.md`](PRD.md), [`AGENTS.md`](AGENTS.md), and [`HANDOFF_PROMPT.md`](HANDOFF_PROMPT.md). The Python code in this folder is a behavioral prototype to be moved into `reference-python-mvp/`; the production target is the TypeScript/Docker architecture specified in the PRD.

Monitor OpenSea drops on Robinhood Chain and alert when the configured wallet is eligible for a mint stage. There is no default wallet — set `WALLET_ADDRESS` in the environment.

The service uses only Python's standard library, stores state in SQLite, deduplicates alerts, honors `Retry-After`, and automatically creates/rotates OpenSea's free 7-day instant API key. It never signs or broadcasts mint transactions.

## Cost and request volume

OpenSea instant API keys cost $0 and allow 600 read requests/hour. A discovery cycle makes three list calls: `featured`, `upcoming`, and `recently_minted`. Eligibility adds one read per candidate collection.

| Interval | Cycles/day | Discovery reads/day | Reads/month | Sustained reads/hour |
|---|---:|---:|---:|---:|
| 5 min | 288 | 864 | 25,920 | 36 |
| 10 min | 144 | 432 | 12,960 | 18 |
| 20 min | 72 | 216 | 6,480 | 9 |
| 30 min | 48 | 144 | 4,320 | 6 |
| 60 min | 24 | 72 | 2,160 | 3 |

For `N` candidate drops checked each cycle, use `(3 + N) × cycles`. At 5 minutes with 20 candidates, usage is 6,624/day or 276/hour—still under the free limit. Network retries are not included.

## Setup

Copy the environment template:

```bash
cp .env.example .env
```

Discovery works without supplying an API key; the service obtains a free key and stores it in `.state/` with mode `0600`. For production, create a longer-lived key in OpenSea Settings → Developer and set `OPENSEA_API_KEY`.

Whitelist checking requires wallet-scoped OpenSea authentication. Create a PAT restricted to `read:eligibility` and set `OPENSEA_WALLET_PAT`; do not put a private key in `.env`. A PAT is exchanged for a short-lived wallet JWT automatically.

For an immediate discovery-only smoke test:

```bash
python3 monitor.py --once --verbose
```

For a continuous five-minute monitor:

```bash
python3 monitor.py --interval 5
```

Or run it with Docker:

```bash
docker compose up -d --build
docker compose logs -f watcher
```

Set `TELEGRAM_BOT_TOKEN` plus `TELEGRAM_CHAT_ID`, or `ALERT_WEBHOOK_URL`, to receive alerts. Without either, hits are printed to stdout.

## Important limitations

OpenSea's drop feed is curated and may not include every custom mint contract. This MVP covers OpenSea drops and SeaDrop eligibility; an on-chain collector should be added next to discover non-featured contracts from Robinhood Chain mint events. Custom Merkle roots cannot be reversed into wallet lists, so non-OpenSea presales need a project-specific adapter or a live transaction simulation.

The `robinhood` chain identifier is used by default. If OpenSea changes its chain enum, the monitor retries discovery without server-side chain filtering and filters identifiable Robinhood results locally.
