# Feature backlog — 2026 competitive gap analysis

Date: 2026-08-22 · Status: proposed backlog; six items shipped same day (below: three quick wins, the Discord embed channel, whale/holder-concentration analysis, and Web Push), two entries corrected after a follow-up investigation found their original "already fetched/already sitting in the DB" premise was false (see the ⚠️ notes), rest not yet scheduled

This backlog compares HoodMint Radar against what best-in-class NFT
mint-tracking / trading-assistant products ship in 2026 — Mintify (modular
NFT trading terminal, AI-driven "MintAI" discovery), Drops Bot and the
NFTGo Discord bot (wallet/whale alerts across 20+ chains), Rarity Sniper
(trait rarity ranking across ~2,000 collections), Blocknative's gas
prediction platform, rug-pull/contract-risk scanners (ChainAware, De.Fi
Scanner, GoPlus/Token Sniffer), whale/holder-concentration tools
(Nansen NFT God Mode, HolderCount), cross-marketplace/portfolio trackers
(NFTBank, NFTfolio, Zapper), and self-hosted push infrastructure
(ntfy/Gotify, Web Push). Sources are listed at the bottom.

Before drafting this list, `README.md`, `PRD.md`,
`docs/execution-architecture.md`, `docs/gap-analysis.md`, and ADRs
0003–0008 were read in full, along with the current `packages/core`,
`packages/providers`, `packages/notifications`, `packages/db` schema, and
`apps/web` route tree, to avoid proposing anything already shipped
(status chips, source/confidence badges, mint-velocity/unique-minter
charts, stage countdowns, Telegram + generic webhook alerts, SSE,
watchlist, admin RBAC/audit, CSV/JSON export *promised* by PRD §7.7 but
not yet built — see Quick win #7 below).

**Guardrails carried over from the existing architecture, not re-derived
here:**

- The read-only invariant for every non-Execution surface is absolute
  (README, PRD §3, ADR 0003). Nothing below adds a signing key, a spend
  path, or a new credential type that can move funds.
- The Execution roadmap (minting calendar, X sentiment signal, delegated
  mint execution) is **already decided** in ADRs 0003–0008 and
  `docs/execution-architecture.md`. Nothing here re-opens that design;
  where a long-term item is adjacent to it, it is scoped as *additional
  to*, not a *revision of*, that architecture.
- Everything in sections 1–2 fits the existing package boundaries
  (`packages/core` for pure logic, `packages/db` for schema/repositories,
  `packages/providers` for new read-only external adapters,
  `apps/web` for UI) with no new trust surface.

---

## 1. Quick wins — small, safe, read-only, no new custody/security surface

| Feature | Description | Why it matters for *this* product | Size |
|---|---|---|---|
| Deployer repeat-offender flag | ⚠️ **Corrected 2026-08-22, verified by direct code investigation**: this entry's original premise — "data already sitting in `projects`/`mint_events`" — is **false**. Grepped the full schema and `packages/providers/src/chain` (the on-chain radar): no `deployer` column exists anywhere, and `ChainRadar` only decodes `Transfer` log recipients (the *minter*, not the deployer) — it never calls `eth_getTransactionReceipt`/traces the contract-creation tx to capture `tx.from`. Building this actually requires a **new on-chain RPC call** (fetch the creation tx's sender when a contract address is first observed) **and a new schema column** (`projects.deployerAddress` or a `project_fields` entry) before the pure classifier + query described here can be written at all. Re-sized L, not S. | Nobody else can give you this signal — it's built from *your* multi-month watch history, not a generic third-party blocklist. Still true once the missing data-capture step is built. | L (was S) |
| Verified-source badge | One cached call per newly discovered contract to Robinscan's Blockscout-compatible `/smart-contracts/{address}` endpoint; store `sourceVerified` on `project_fields`. New adapter follows the exact pattern of the existing OpenSea client in `packages/providers`. | Unverified/obfuscated bytecode is a top rug indicator; surfacing it right next to the eligibility chip catches it at the exact moment you're deciding whether to spend gas. | S |
| Royalty / creator-fee display | ⚠️ **Corrected 2026-08-22, verified by direct code investigation**: this entry's original premise — "the field is fetched and currently discarded" — is **false**. Grepped `packages/providers/src/opensea` for `royalt`/`fee_basis`/`basis_points`/`creator_fee`/`seller_fee`: zero hits, in the schema, the client, and every committed OpenSea fixture used as the contract-test source of truth. No fee field is fetched, parsed, or dropped anywhere — there is nothing to "surface." Building this needs (1) confirming OpenSea's `/api/v2/drops/{slug}` response actually carries a fee field at all (unverified — every fixture in this repo lacks one), (2) adding it to `dropRowSchema`/`stageSchema` if so, and (3) a new storage spot (`projectFields` with `field: "royaltyBps"` fits the existing provenance pattern with zero migration, or a dedicated column). Re-sized M and gated on an unverified external-API assumption, not S. | Royalty burden changes flip economics directly — still true if OpenSea's API actually returns this data; unconfirmed. | M (was S) |
| ✅ Bot-mint concentration chip | Shipped 2026-08-22: `mintConcentrationSeverity` (`packages/core/src/concentration.ts`, 6 tests) + a `watch`/`concentrated` badge on the feed table's velocity cell. | A live mint dominated by a handful of wallets is a classic sniper/bot pattern — the raw numbers are already collected and currently thrown away. | S |
| Personal wallet mint-history digest | Aggregate `eligibility_checks` + `mint_events` for your own registered wallets into a "my mints this month" panel, reusing existing repositories. | Lets the owner audit their own participation and spend pattern with zero new external dependency — pure read of data already in Postgres. | S |
| ✅ RSS export of Live/Next/Latest/All | Shipped 2026-08-22: `apps/web/src/app/rss/[view]/route.ts`, same `queryFeed` as `/api/v1/projects`, HTTP-cached. Watchlist/Eligible deliberately excluded — they need per-user auth a feed reader can't satisfy with a session cookie; would need its own per-user token scheme, scoped out rather than half-built. | Self-hosted-first workflow: read your own radar from any feed reader/phone widget without opening the dashboard or trusting a third-party Discord/Telegram bot. | S |
| Known-scam-bytecode hash flag | Compare a new contract's runtime bytecode keccak (already computable from data the viem-based on-chain radar reads) against a small curated static list of known copy-paste rug templates. | Cheap, zero-latency defense-in-depth alongside the deployer-history and verified-source checks above — catches verbatim clones that recur across chains. | S |

## 2. Medium — meaningful new read-only capabilities

| Feature | Description | Why it matters for *this* product | Size |
|---|---|---|---|
| ✅ Whale / holder-concentration analysis | Shipped 2026-08-22: `computeHolderConcentration`/`deriveHolderConcentration`/`holderConcentrationSeverity` (`packages/core/src/holders.ts`, 15 tests, including a regression test for a real bug caught in review before it shipped — see execution-architecture.md's tenth pass) + a new `holder_snapshots` table (migration `0004_holder_snapshots.sql`) refreshed from the same touched-project loop that already recomputes `mint_aggregates` in `apps/worker/src/workers/chain.ts` — no new schedule. Concentration bar + top-5 holder table + severity chip on project detail (`apps/web/src/app/projects/[id]/page.tsx`). Live-verified against a real Postgres: seeded a whale minting across two separate transactions to prove the `SUM(quantity) GROUP BY recipient` aggregation sums rather than overwrites (2 new integration tests, 10/10 in the suite). | For a young Robinhood Chain drop, concentrated early-minter supply is the single best predictor of an immediate post-mint dump — this answers "flip or hold" from data the radar already ingests, no third-party API needed. | M |
| ✅ Gas / RPC health widget | Shipped 2026-08-22: `getGasSnapshot`/`classifyLatency` (`packages/providers/src/chain/gas.ts`, 3 tests) polling live gas price + latency per enabled RPC endpoint, shown as a column on Admin → Execution's RPC endpoints table (bounded to 10 endpoints, `Promise.allSettled` so a dead endpoint never blocks the page). | Robinhood Chain (4663) is a ~5-week-old single-sequencer L2 with no existing gas tracker coverage; a latency/gas spike right before a competitive mint window is exactly the readiness signal a personal assistant should surface, which generic Ethereum gas trackers (Blocknative etc.) don't cover for this chain at all. | S |
| ✅ Trait rarity ranking | Shipped 2026-08-22, scoped down from the original per-token/browsing-UI framing after code investigation found no per-token table or NFT-browsing UI exists anywhere: this ships a snapshot-based, admin-triggered top-25-rarest view instead (same shape as the holder-concentration snapshot above), not a full per-token store. `computeRarityScores` ("Rarity Score" = sum of 1/trait-frequency; deliberately not OpenRarity's entropy method — no reference implementation to check a from-scratch port against) in `packages/core/src/rarity.ts` (7 tests). `listCollectionNfts` on the OpenSea client (`GET /api/v2/collection/{slug}/nfts`, verified live against current docs) feeds a new `rarity_snapshots` table (migration `0006_rarity_snapshots.sql`) via a dedicated BullMQ `rarity` queue/worker, admin-triggered from a "Refresh rarity" button on project detail (`scans:run` RBAC, same tier as "Run scan now") rather than a scheduled pass — OpenSea Read-quota cost scales with collection size and there's no freshness SLA forcing a background cadence. Bounded to 10,000 tokens (100 pages × 100/page, covers the classic 10k-PFP-collection ceiling); a larger collection is reported "too large to rank" via the existing `scan_runs` outcome log rather than silently ranked from a truncated, non-random-order prefix — trait frequency computed from a partial fetch would be mathematically wrong, and for a tool whose purpose is real mint decisions that's worse than no ranking at all. 2 new provider tests (pagination + truncation detection) and 2 new DB integration tests (jsonb round-trip + upsert), live-verified against real Postgres. | Rarity Sniper-style tools don't yet index a 5-week-old chain; the radar already visits every drop's metadata on its own schedule and can be first to rank rarity on chain 4663. | M |
| Cross-marketplace secondary price comparison | New read-only provider adapter (e.g. an order-aggregation API) pulling best current listing/offer across marketplaces post-mint; shown as "floor vs. mint price" delta. Requires a new external provider credential, still read-only, no signing. | Turns the radar from "did I get in" into "was it worth it" — the natural next question after a mint, without leaving the dashboard. | M |
| ✅ Discord-native rich-embed alert channel | Shipped 2026-08-22: `createDiscordAdapter` (`packages/notifications/src/channels.ts`) — same SSRF-guarded outbound-only HTTPS POST as the generic webhook, plus a Discord-webhook-URL-shape check for a clearer validation error; `renderAlertEmbed` (`packages/notifications/src/render.ts`) builds a structured embed (title, color per alert type, stage/price/wallet/countdown fields, footer, defensively truncated to Discord's documented per-field limits) from the same `AlertRenderInput` the existing flat-text renderer uses; wired into `dispatch.ts` with a runtime shape guard on the untyped jsonb payload (falls back to a plain embed for any pre-feature outbox row); admin form added to `/admin/alerts` alongside Telegram/webhook. 6 new tests (21/21 in the package, was 15). | The existing generic webhook is "Discord-compatible" but plain-text; a dedicated adapter gets the rich, glanceable embed most degen Discord servers actually use. | M |
| ✅ Web Push notifications | Shipped 2026-08-22: `createWebPushAdapter` (`packages/notifications/src/channels.ts`, via the `web-push` npm library — RFC 8291 payload encryption is not something to hand-roll) with the same `assertSafeWebhookUrl` SSRF guard the webhook/Discord adapters use, plus a dependency-injection seam (`SendPushLike`) since `web-push` drives Node's `https` directly with no fetch hook of its own — 5 new tests, all against stubbed sends, none against a real device. Each browser subscription is its own `alert_channels` row (`kind: "web_push"`, no new table), unlike Telegram/Discord/webhook's one-shared-destination model. `apps/web/public/sw.js` (push + notificationclick handlers) and a client `PushSubscribeSection` (`/admin/alerts`) drive the browser's own `PushManager.subscribe()` — the subscription is captured from the browser, never typed by an admin. `pnpm vapid-keys` (`scripts/vapid-keys.ts`) generates the one-time server keypair. Live-verified: real DB round-trip of a `web_push` channel row, the admin page rendering it correctly, and the "Test" action completing cleanly server-side (200, no server error) against a fake endpoint. **Honest gap**: the actual client-side subscribe flow (a real browser granting notification permission and calling `PushManager.subscribe()`) was not exercised live — clicking it in an automated session risks the same class of hang a JS `alert()`/`confirm()` dialog does, so this needs a human, on a real device, to complete the first real end-to-end test. | Lowest-friction "buzz my phone the instant a restricted stage opens" channel for a single-owner self-hosted app — no bot setup, no third-party chat account, works even if Telegram is down. | M |
| ✅ CSV/JSON export of any feed view | Shipped 2026-08-22: `apps/web/src/app/api/v1/exports/[view]/route.ts` — the exact PRD §7.7 promise, `exports:read` RBAC (existed since v1, never checked anywhere until now, confirmed by grep), bounded to 1000 rows with an `x-export-truncated` header rather than a silent cap, linked from every feed page's header for operator+ users. | Closes a documented-but-unshipped gap and gives a portable audit/recordkeeping trail without any new provider or trust surface. | S |

## 3. Long-term / needs its own ADR

These touch money movement, a new trust surface, or multi-tenant concerns.
None of these re-open or duplicate the already-decided Execution
architecture (ADRs 0003–0008); each is scoped as an *addition beyond* that
settled design, and should not be started without its own decision
record.

| Feature | Description | Why it needs a fresh ADR (not a revision of 0003–0008) | Size |
|---|---|---|---|
| Secondary-market limit orders / floor-sweep execution | Placing buy/sell orders on OpenSea/other marketplaces, not just minting. | ADRs 0004–0008 scope "Execution" specifically to firing one capped mint transaction per armed plan. General trading is unbounded price exposure (no fixed mint price ceiling) — a different risk class needing its own spend-ceiling and custody reasoning. | L |
| AI/agent-directed autonomous trading (Mintify "MintAI"-style) | An LLM-driven decision loop that decides *when* to spend, not just executes a plan a human armed. | Removes the human-arms-it gate that ADR 0008's whole safety model is built on — a categorically different trust surface, not a bigger version of the same one. | L |
| Automated pre-drop gas/funds top-up (auto-bridge/auto-transfer into the execution wallet) | Moving funds into the execution wallet ahead of a known mint time without a manual step. | Money movement outside the mint transaction itself, plus a new external bridging dependency — outside the custody model the existing ADRs size around a single capped mint. | M–L |
| Multi-tenant / shared-team deployment | Multiple owners, per-user billing or quota on one deployment. | Explicit PRD §3 non-goal ("no public multi-tenant SaaS billing... single deployment with multiple admin-created users and wallets"). Revisiting it changes the tenancy, billing, and RBAC model end to end. | L |
| Wallet-level wash-trading / market-maker accusation analytics | Flagging specific on-chain identities as manipulative based on trade-pattern heuristics. | Read-only, but publishing an accusation against a named wallet is a reputational/legal trust surface (false positives, defamation exposure) the "explain every displayed claim with provenance" bar wasn't built to carry — needs its own evidentiary-standard and disclaimer policy before it ships. | M |
| Native mobile companion app with biometric "arm" trigger | A phone app UI for the already-decided Execution arm/step-up flow. | ADR 0008 sizes the step-up factor around WebAuthn/hardware-key in a browser; a mobile app introduces a distinct signing/auth surface (device keychain, push-token spoofing) not covered by that ADR. | L |

---

## Sources consulted

- [Mintify — Alchemy dapp listing](https://www.alchemy.com/dapps/mintify) · [Mintify MintAI launch](https://www.businesswire.com/news/home/20250320866302/en/Mintify-Introduces-AI-Powered-Trading-With-MintAI)
- [Drops Bot (Telegram) review — DropsTab](https://dropstab.com/research/product/drops-bot-the-crypto-price-alerts-bot-for-telegram)
- [NFTGo Discord bot docs](https://docs.nftgo.io/docs/nftgo-discord-bot-1)
- [Rarity Sniper feature overview — SoftwareSuggest](https://www.softwaresuggest.com/rarity-sniper)
- [ChainAware — best Web3 rug-pull detection tools 2026](https://chainaware.ai/blog/best-web3-rug-pull-detection-tools-2026/)
- [DEXTools — 12-point rug-pull detection checklist](https://www.dextools.io/tutorials/how-to-spot-a-rug-pull-2026-checklist)
- [Blocknative Gas Platform docs](https://docs.blocknative.com/gas-prediction/gas-platform)
- [Nansen — how to find and track NFT whales](https://www.nansen.ai/guides/how-to-find-and-track-nft-whales)
- [HolderCount — NFT holder intelligence](https://holdercount.com/)
- [NFT portfolio tracker landscape — nftuniverse.com.au](https://nftuniverse.com.au/best-nft-portfolio-trackers/) · [NFTfolio](https://apps.apple.com/app/id1620704592)
- [Self-hosted push notification comparison (ntfy/Gotify) — Pi Stack](https://www.pistack.xyz/posts/2026-05-01-self-hosted-web-push-notification-server-comparison/)

## Repo docs read to avoid duplicates

`README.md`, `PRD.md`, `docs/execution-architecture.md`,
`docs/gap-analysis.md`, `docs/decisions/0001`–`0008`, plus
`packages/core/src`, `packages/providers/src`,
`packages/notifications/src/channels.ts`, `packages/db/src/schema.ts`,
and the `apps/web/src/app` route tree.
