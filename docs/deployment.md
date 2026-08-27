# Production deployment — HoodMint Radar

Two separate concerns: **how** to run it (Docker + Traefik), and **where**
to run it (co-location — the single biggest FCFS-competitiveness lever).

## Where: sequencer proximity is the mint-race edge

Robinhood Chain (chain id 4663) is an **Arbitrum Orbit L2 with a single
sequencer, strict FIFO ordering, no public mempool, and no fee-based
reordering** (confirmed against Robinhood's own chain docs + Arbitrum Orbit
architecture, this session). Consequence for competitive minting:

> There is **no gas-priority auction to win**. The sequencer orders
> transactions first-come-first-served as *it* receives them. Winning a
> contested FCFS / public mint is therefore a pure **latency race to the
> sequencer** — whoever's valid transaction reaches it first, wins. Code
> can pre-build, pre-sign, and fire at the exact clock-corrected open
> instant (this repo does — see `packages/core/fire-schedule.ts`), but it
> cannot beat physics: a competitor whose host is 20 ms network-closer to
> the sequencer beats an otherwise-identical setup every time.

### Sequencer / RPC location — what to measure

- **Established this session (treat as a strong hint, not gospel):** the
  Robinhood Chain sequencer and its public RPC (`rpc.mainnet.chain.robinhood.com`)
  resolve into **AWS `us-east-2` (Ohio)**. Robinhood Chain is built on the
  Arbitrum platform, and Arbitrum Orbit sequencers for US-operated chains
  are commonly hosted in AWS us-east-1/us-east-2.
- **Do not trust the region label — measure it.** Region names don't
  capture the last-mile path. From each candidate host you're considering,
  run, against the **write/submit** endpoint you'll actually use:

  ```bash
  # raw TCP/handshake latency to the RPC host
  ping -c 20 rpc.mainnet.chain.robinhood.com
  # full JSON-RPC round-trip (what actually matters for tx submit)
  for i in $(seq 1 20); do
    curl -s -o /dev/null -w "%{time_total}\n" \
      -X POST https://rpc.mainnet.chain.robinhood.com \
      -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
  done | sort -n
  ```

  Pick the host with the lowest **p50 and p99 JSON-RPC round-trip**, not the
  lowest ping — p99 is what bites you at the exact contended moment.
- Once chosen, set `MINT_FIRE_LEAD_MS` (in `.env.prod`) to just above your
  measured p50 round-trip: the worker fires that many ms *before* stage
  open so the tx lands right as the stage flips, and `MINT_FIRE_CONTINUE_MS`
  keeps re-firing through the open to cover jitter. See
  `packages/core/fire-schedule.ts` for the exact model.
- If you can, put the app in the **same AWS region (and ideally same AZ)**
  as the sequencer. A cheap always-on instance there will out-compete a
  beefier box on another continent for FCFS every time.

> **Action for the operator:** you said you'll slot in a nearby server
> yourself — target **AWS us-east-2 (Ohio)** first, verify with the
> round-trip measurement above before committing, then set
> `MINT_FIRE_LEAD_MS` from the measured number.

## How: Docker + Traefik

Production runs from a **single self-contained compose file** (not the
`compose.prod-posture.yaml` overlay — that one is only for local
prod-posture smoke-testing without TLS). All committed as `*.sample`; the
real files are gitignored so a `git pull` can never clobber your prod config.

```bash
# on the prod host, first time only:
cp compose.prod.yaml.sample compose.prod.yaml         # gitignored
cp .env.prod.sample        .env.prod                  # gitignored — fill in real values
mkdir -p traefik && touch traefik/acme.json && chmod 600 traefik/acme.json

# bring it up (Traefik terminates TLS via Let's Encrypt, routes to web):
docker compose -f compose.prod.yaml --env-file .env.prod up --build -d
```

`.env.prod` must set at minimum: `APP_DOMAIN`, `ACME_EMAIL`,
`POSTGRES_PASSWORD`, `APP_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `APP_URL`
(= `https://${APP_DOMAIN}`). See `.env.prod.sample` for the full list and
generation commands.

### What's gitignored on prod (never overwritten)

`compose.prod.yaml`, `.env.prod`, `traefik/acme.json`, `traefik/*.local.*`,
`letsencrypt/`. Edit these freely on the box; pulls and agent edits leave
them alone. If git still tracks the old overlay name, run
`git rm --cached compose.prod.yaml` once (it was renamed to
`compose.prod-posture.yaml`).

### Ports

Traefik owns `:80`/`:443`. Postgres and Valkey publish **no** host ports in
prod (internal network only). The web/worker health endpoints are internal.
