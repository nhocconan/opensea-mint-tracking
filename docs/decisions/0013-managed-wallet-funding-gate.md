# 0013 — Managed-wallet funding gate and terminal "cannot pay" outcomes

Date: 2026-09-02. Status: accepted (shipped with the same change).

## Context

Chill Guys special mint, 2026-08-30 21:00 GMT+7: the plan ended `EXPIRED`
with `provider returned 422: Insufficient balance to mint`. Nothing read the
wallet's balance before the fire instant; OpenSea's 422 at `/drops/{slug}/mint`
was the first and only signal, it surfaced at arm-time pre-build and at the
presign pass as `log.warn` only, and at fire the pass treated it as retryable
and re-claimed the plan every tick until `armed_until`.

Separately, `https://opensea.io/collection/yolkies-nft/overview` parsed fine
and `/drops/yolkies-nft` is a live SeaDrop (0.011 ETH, public stage to
2026-09-04), yet the app never showed it: the collection was swept before
its schedule existed, the 404 was logged at debug level, and no path ever
asked OpenSea again.

## Decision

1. **Arm-time gate (web action).** `checkArmFunding` reads the wallet's live
   native balance and fees and refuses to arm when balance <
   `price × qty + OPENSEA_MINT_FEE_ALLOWANCE + MINT_PRESIGN_GAS_LIMIT × maxFeePerGas`.
   ERC-20-priced stages (`drop_stages.currency` not native) also require the
   token balance. RPC read failure does not block arming (presign re-checks).
2. **Presign gate (worker).** Same assessment ~45 s before the open with the
   real `/mint` value; failure writes a `failed` attempt row
   (`insufficient_funds: … top up X ETH`) every 15 s while the plan stays
   `armed`, so a top-up before the open still fires. Allowance towards the
   SeaDrop contract (`tx.to`) is checked here for ERC-20 stages.
3. **Terminal at fire.** `insufficient balance|funds` (OpenSea 422 or RPC) and
   OpenSea's own 4xx refusals (`max per wallet`, `already minted`, `exceeds`)
   mark the plan `failed` immediately instead of retrying to expiry.
4. **Balance snapshot.** `wallets.native_balance_wei` / `balance_checked_at`,
   refreshed every 60 s by the worker for enabled managed wallets, shown on
   Admin → Wallets and in the Special-mints wallet picker. Pages never call
   an RPC (anti-pattern #3).
5. **Stage-less collections are re-checked, never frozen.** The chain-wide
   sweep sees a collection minutes after creation, usually before its SeaDrop
   schedule is published; `/drops/{slug}` then 404s and nothing asked again
   (yolkies-nft: swept 2026-09-01, minting on OpenSea 2026-09-02, invisible
   in the app). Now `projects.drop_checked_at` records every `/drops` answer,
   a 15-minute `stageless-recheck` task re-asks up to 120 least-recently
   checked stage-less collections from the last 3 days, the worker logs
   "collection promoted to drop" when stages appear, and the Special-mints
   resolver re-fetches a known-but-stage-less project instead of returning an
   empty phase picker. A `settings["opensea_not_a_drop:<slug>"]` marker
   (30 min) only changes the resolver's wording; it never blocks a fetch.

## Consequences

- Gas is reserved at the full `maxFeePerGas × MINT_PRESIGN_GAS_LIMIT`; a
  wallet funded only for the exact mint price is refused on purpose.
- ERC-20 approval is still a manual step from the wallet; the gate reports
  it, it does not sign an `approve`.
- Not proven live: the ERC-20 path (no USDG-priced drop was available to
  test) and whether OpenSea's 422 refers to the native coin or the stage
  currency — both are checked, so either shortfall is caught.
