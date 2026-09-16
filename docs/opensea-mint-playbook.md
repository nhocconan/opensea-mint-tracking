# OpenSea mint on Robinhood Chain — how it actually works, and what we got wrong

Living document. Written 2026-09-16 after two nights of live minting with real
money. Every claim here is either quoted from code, decoded from a real
transaction, or read from the chain — where something is inferred it says so.

Purpose: the next person (or the next model) should not have to re-learn any
of this, and must not repeat the mistakes in §5. All times GMT+7.

---

## 1. The chain and the contract

| Fact | Value | How we know |
|---|---|---|
| Chain id | 4663 | `eth_chainId` → `0x1237` |
| Block cadence | ~100 ms, **10 blocks per timestamp-second** | block numbers sharing one `ts` |
| SeaDrop | `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` | `to` of every mint tx we decoded |
| Variant | Stock **SeaDrop 1.0**, not a fork | 21,081-byte bytecode, PUSH4 scan |
| NFT contracts | EIP-1167 proxies → `0x09a26fc8fcef18192e267d7a6da9dfb4be81dd6a` | 45-byte runtime |

### Mint entrypoints

| Selector | Function | Self-servable? |
|---|---|---|
| `0x161ac21f` | `mintPublic(nft, feeRecipient, minterIfNotPayer, qty)` | **YES** — no signature, no proof |
| `0x4b61cd6f` | `mintSigned(…, MintParams, salt, signature)` | **NO** — see below |
| `0x4300a4e6` | `mintAllowList(…, proof)` | N/A — unused on this chain |
| `0x99eb900f` | `mintAllowedTokenHolder(…)` | not investigated |

**`mintSigned` cannot be self-served.** The 65-byte signature is EIP-712 signed
by `0xfCe4b31128100915f2980BBC3a08894Ee5e8F8C3`, the sole address returned by
`getSigners(nft)` on 40/40 collections sampled. We recovered exactly that
address from three real transactions, including a competitor's. Without
OpenSea's private key there is nothing to build.

**`mintAllowList` is dead here.** `getAllowListMerkleRoot(nft)` is zero on 40/40
collections. OpenSea implements its "allowlist" phases with `mintSigned`.

### The mapping that decides everything

```
drop_stages.type = 'public'     ⇒ mintPublic  ⇒ self-served, no OpenSea at fire time
drop_stages.type = 'allowlist'  ⇒ mintSigned  ⇒ OpenSea's signature, OpenSea's clock
```
Every phase OpenSea labels GTD / FCFS / WL / Team / Game App is `allowlist`.
Chain-wide split of upcoming stages: ~41 public vs ~18 allowlist.

### Contract rules that bite

- **`_checkActive` runs FIRST.** Firing one second early reverts `NotActive`
  and burns a nonce and gas — before any other check is even reached.
- **Exact payment.** `value` must equal `mintPrice × quantity`. Under- and
  over-paying both revert `IncorrectPayment`. The 10% fee is taken **out of**
  that amount, never added.
- **`maxTotalMintableByWallet` is CUMULATIVE across every stage.** The check is
  `minterNumMinted + quantity > cap`, where `minterNumMinted` is the wallet's
  total on the whole contract. A wallet that took 1 on GTD has 1 fewer
  everywhere else, forever.
- **`restrictFeeRecipients` is true on every collection observed.** Read
  `getAllowedFeeRecipients(nft)`; a guessed recipient reverts.
- `getMintStats(minter)` lives on the **NFT contract**, not on SeaDrop.

---

## 2. The hard ceiling on signed stages

OpenSea's `POST /api/v2/drops/{slug}/mint` **does not answer until OpenSea's own
clock flips the stage active**. Measured: **T+343 ms** and **T+405 ms**.

A competitor whose transaction landed in the 3rd block of the open second
(≈ T+0.2 s) was using **the same OpenSea path** — same `mintSigned` selector,
same signer, and their calldata even carried OpenSea's client tag `0x3d958fe2`.
They were not bypassing anything. They simply held the signature earlier.

**Therefore:** for an `allowlist` stage our floor is OpenSea's flip. No amount
of local tuning gets under it. Two FCFS drops sold out inside that window on
2026-09-16 and we never obtained a single piece of calldata.

**Open question, not yet settled:** does OpenSea issue the signature *before*
the stage's start time? If yes, pre-fetching and holding removes the ceiling
entirely. A 60-second `curl` loop before any scheduled allowlist stage settles
it. This is the single highest-value experiment outstanding.

For `public` stages the ceiling does not exist — see §3.

---

## 3. Current architecture of the fire path

```
hot loop (200 ms, completion-scheduled)
  └─ claim one plan atomically (FOR UPDATE SKIP LOCKED, 30 s lease)
       └─ IDEMPOTENCY GATE: resolve the plan's last broadcast hash on chain
       │    success → close the plan   reverted → re-fire   unresolved → hold 3 s
       ├─ prefetch fee+nonce  ─┐  (parallel, off the critical path)
       ├─ warm RPC sockets    ─┤
       └─ build calldata      ─┘
            ├─ type='public'    → read getPublicDrop / feeRecipient / getMintStats
            │                     build mintPublic locally, hold until the
            │                     CONTRACT's startTime, then send
            └─ type='allowlist' → burst-poll OpenSea /mint across mint keys
       └─ pipeline: policy check (ceiling vs tx value) → [sim skipped at nearFire]
       └─ sign → write-ahead the hash → race-broadcast → confirm receipt
```

### RPC routing
- **Mint path:** `ALCHEMY_ROBINHOOD_RPC` → `CHAINSTACK_ROBINHOOD_RPC` →
  `DRPC_ROBINHOOD_RPC` → registry/public. Sequential failover for reads,
  `Promise.any` race for broadcast.
- Order is set by `eth_getTransactionCount`, **not** `eth_chainId` — see §5.11.
- Only the Robinhood URL of each provider is configured. Base/ETH URLs are
  derived from it (`packages/core/src/rpc-derive.ts`). "Derivable" and "serves
  this chain" are separate questions; conflating them silently dropped
  Chainstack from Robinhood itself.
- **Background jobs:** registry only (public RPC). Premium endpoints are
  deliberately **not** in `rpc_endpoints` — see §5.6.

### OpenSea key pool
Split by purpose. `OPENSEA_SCAN_KEY_COUNT` keys go to scanning, the rest are
reserved for minting, and the two pools never overlap. Quota is tracked
**per key** (`quotaByKey`), and the mint's own calldata call may spend the
reserve floor that routine scanning may not.

### Key config and why

| Setting | Value | Reason |
|---|---|---|
| `MINT_FIRE_LEAD_MS` | 150 | One-way send latency only. 1000 caused guaranteed `NotActive` reverts on public stages. |
| `MINT_PRESIGN_ENABLED` | false | See §5.5 — it cannot work for signed stages and burns quota. |
| `MINT_FREE_STAGE_CEILING_WEI` | 200000000000000 (0.0002 ETH) | §5.9 |
| `OPENSEA_SCAN_KEY_COUNT` | 1 | Scan gets one key; minting keeps the rest. |
| `DEFAULT_RPC_TIMEOUT_MS` | 2500 | §5.1 |
| `MAX_ONCHAIN_REVERTS` | 3 | Bounds gas burn on a dead drop. |

---

## 4. Ground truth: which field to trust

| Question | WRONG source | RIGHT source |
|---|---|---|
| Per-wallet cap | `drop_stages.max_per_wallet` (from the `/drops` feed — **returns 1 for every stage of every drop**, 423 rows) | `eligibility_checks.max_mintable` (OpenSea's `max_total_mintable_by_wallet`) |
| Public stage start | `drop_stages.starts_at` (OpenSea's published schedule) | `getPublicDrop(nft).startTime` on chain |
| Already minted | plan rows alone | `mint_events`, corroborated by executed plans |
| Wallet eligibility | any aggregate across phases | exact `{projectId, stageId}` pair |

On 2026-09-16, 7 of 8 upcoming public drops had on-chain start == published
start to the second. The eighth, `waderz`, opened **1.5 hours earlier** on
chain than OpenSea advertised. Trust the contract.

---

## 5. Mistakes made, and the lesson from each

### 5.1 A short RPC timeout lost a race
Set `DEFAULT_RPC_TIMEOUT_MS = 800`. At the mint instant the public RPC is
saturated; `eth_getTransactionCount` exceeded 800 ms **twice in a row**, each
time killing a whole attempt. Cost: 2.5 seconds and the race.
**Lesson:** a short timeout does not make a slow endpoint fast — it converts a
slow success into a hard failure. Budget generously *and* take the call off the
critical path (fees and nonce are now prefetched during the burst).

### 5.2 Fixing one instance of a bug class and not its twin
`exceeds max per wallet` was correctly made non-terminal (OpenSea answers about
whichever stage IT considers active, and we poll before our stage opens). The
identical reasoning was **not** applied to `minted out`. Result: both FCFS
plans were killed 757 ms after their published start, on a verdict about the
previous phase, while supply remained.
**Lesson:** when a bug is about a *class* of provider answers, fix the class.

### 5.3 Patching data that an ingest job rewrites
Corrected `drop_stages.max_per_wallet` for 423 rows by SQL. The detail refresh
overwrote it within minutes, because the feed genuinely returns 1.
**Lesson:** if a value is wrong at the source, patching the table is theatre.
Change what the consumer reads.

### 5.4 Declaring a fix without verifying it
Announced the cap fix as done and did not re-check. The operator discovered it
had been reverted.
**Lesson:** a fix is not done until its effect has been observed. Re-read the
value, or prove the new code path no longer depends on the broken one.

### 5.5 Pre-signing that cannot work
The pre-sign design signs a complete transaction ~45 s early. For a signed
stage OpenSea will not issue the signature until the stage is active, so the
blob can only ever carry the **previous** phase's calldata — and the fast path
preferred it over fresh calldata. Worse, with no cache the pass re-asked
OpenSea on every 200 ms tick for the whole 45 s window (~75 write calls per
key) — the exact budget the burst needs at the open.
**Lesson:** a latency optimisation that cannot produce a valid artifact is not
an optimisation. Disabled by default.

### 5.6 Premium RPC in a shared registry
Put Alchemy in `rpc_endpoints` so the mint would use it. Background jobs use
the same registry and earned **11 × HTTP 429 in 10 minutes**, including one
three seconds into a live mint, and knocked out clock calibration.
**Lesson:** a scarce resource shared by a bulk consumer and a critical consumer
belongs to the critical one. Separate by construction, not by good behaviour.

### 5.7 Saving quota by going blind
Disabled public scanning to conserve OpenSea quota. That also silenced
`live-next-refresh`, the only job that re-reads a live drop's schedule. Three
hours later OpenSea moved a phase by an hour; the worker fired at the old time
and OpenSea answered "not eligible for the active drop stage" for twelve
seconds.
**Lesson:** never let a cost saving blind the system to the schedule of the
mint it is about to fire. `armed-plan-detail-refresh` now runs regardless.

### 5.8 Re-scanning what had not changed
`liveNextSlugs` returned every LIVE/NEXT project every run, ignoring
`projects.drop_checked_at`, which was already being stamped and never read —
the same 300 collections re-fetched four times an hour.
**Lesson:** before adding a key or raising a limit, check whether the budget is
being spent on new information at all.

### 5.9 A loose ceiling on a free mint is a blank cheque
Set a 0.005 ETH (~$12) per-plan ceiling on three free mints. Nothing re-reads
the price at the fire instant and SeaDrop demands exact payment, so a drop that
flips from free to paid spends whatever the ceiling allows.
**Lesson:** the ceiling is the only protection against a price change between
arming and firing. Free stages are now capped at `MINT_FREE_STAGE_CEILING_WEI`.

### 5.10 Asserting things about the competition without evidence
Claimed the winner "did not use OpenSea's API" and landed at "T+0.000". Both
were wrong: they used the same endpoint and landed at ≈T+0.2 s. The wrong
conclusion nearly sent a day of work in the wrong direction.
**Lesson:** decode the transaction before theorising about it.

### 5.11 Benchmarking the wrong method, then ordering by it

Provider order was chosen from `eth_chainId`: dRPC 66 ms, Chainstack 68 ms,
Alchemy 133 ms — so dRPC went first. The fire path does not call `eth_chainId`.
It calls `eth_getTransactionCount(…, "pending")`, and on that call the ranking
**reverses**: dRPC 528 ms, Chainstack 195 ms, Alchemy 130 ms. `eth_chainId` is
answered from memory and measures only the network hop; a pending nonce needs a
real state lookup. The cheap call put the slowest provider first, and that is
most of the 265.7 ms `fees_nonce` on the 2026-09-16 21:00 GTD.
**Lesson:** benchmark the method you depend on, at the concurrency you will
have. A number from an adjacent call is not evidence about this one.

### 5.12 A prefetch hidden behind something slow is just late

`fees_nonce` was 0.1 ms on 2026-09-15 23:00 and 265.7 ms on 2026-09-16 21:00 —
the prefetch looked fixed and then regressed with no code change. It never
worked. It only ever *appeared* to: on the 15th the OpenSea burst took 521 ms
and the prefetch finished inside that shadow; on the 16th the burst took 273 ms
and the prefetch became the tail. Seven awaited reads — including the
idempotency gate's own RPC round-trip — ran between the claim and the line that
started it. Now it starts immediately after the claim and overlaps all of them.
**Lesson:** a background task's latency is only hidden while something slower
runs in front of it. Measure where it *starts*, not just that it is `void`ed.

### 5.13 Dedupe keyed on a column nothing wrote

Two scan-freshness filters read `drop_checked_at`. `markProjectDropChecked` was
never called, so the column was always NULL and both filters passed everything —
the dedupe saved zero API calls while reading as if it worked.
**Lesson:** for any new "skip if already done" column, grep for its writer
before trusting the reader.

### 5.14 A refresh horizon narrower than the schedules it feeds

`refreshArmedPlanDetails` only refreshed plans firing within 6 h. Stages armed
the evening before never had their details fetched. Widened to 48 h with a
15-minute staleness guard.
**Lesson:** a horizon is a silent filter. State it in the name or the log.

### 5.15 Preflight that checked a different system than the one that fires

`preflight-mint.ts` reported "0 plans ready, 2 blocked" while the fire path was
perfectly healthy: preflight read the registry endpoints, the fire path uses
`mintRpcUrls`. A green/red check on the wrong list is worse than none.
**Lesson:** a preflight must call the same function the hot path calls.

---

## 6. Defects fixed in the fire path (2026-09-15/16)

Correctness:
- Broadcast-then-DB-failure re-armed the plan → second mint at nonce+1. Now a
  broadcast hash means the plan is never released.
- Stale-presign fallback re-signed over our own landed transaction. Now
  resolved against the chain first.
- "Executed" meant mempool acceptance. Now a receipt is required; a revert
  releases to keep competing, bounded by `MAX_ONCHAIN_REVERTS`.
- Per-plan ceiling never compared against the transaction value. Now it is.
- Cached calldata from an earlier phase could win at the next phase's fire
  instant. Now ignored at `nearFire`.
- No nonce allocator: two plans on one wallet took the same nonce. Now a
  per-wallet reservation **with a free list** — without the free list a failed
  sibling strands both plans behind a permanent gap.
- Every terminal failure was silent. Now `execution.failed` is published,
  including on arm-window expiry.
- Broadcast failure classification took `errors[0]` from `Promise.any` —
  whichever endpoint happened to be first. Now ranked by meaning.

Eligibility and caps:
- `/drops/{slug}/eligibility` takes no wallet address; it answers for the JWT's
  wallet. One PAT's verdict was written to **every** wallet, so a wallet with
  no allowlist spot displayed "WL". Now only the PAT's own wallet gets a real
  verdict (`OPENSEA_PAT_WALLET_ADDRESS`); everyone else is `AUTH_REQUIRED`.
- Stage-kind heuristic tested `public`/`open` **before** the restriction
  markers, so `fcfs_open` and friends classified as public and skipped the
  eligibility check entirely. Order reversed; ambiguous falls through to
  `unknown`, which is already treated as restricted.
- `nextStage()` did not filter `paused` while `currentStage()` did.

---

## 7. Operating checklist before a drop

0. Deploy with `docker compose -p hoodmint-radar-prod -f docker-compose.prod.yml`.
   A bare `docker compose` targets the *dev* project, tries to create a second
   network, and fails — it does not touch prod, but the error reads like an
   outage. Confirm with `docker ps` before believing anything is down.
1. `scripts/preflight-mint.ts <slug>` — exits non-zero if anything blocks.
2. Confirm the wallet has gas and a managed key (`has_key`).
3. For a `public` stage, compare `getPublicDrop().startTime` against
   `drop_stages.starts_at`. The contract wins.
4. Check the per-wallet remainder: `eligibility_checks.max_mintable` minus what
   `mint_events` says the wallet already minted **on this contract**.
5. Keep the per-plan ceiling tight. Free stage ⇒ ≤ 0.0002 ETH.
6. Arm through the UI — arming requires a passkey step-up on purpose. Never
   insert armed rows by SQL.

## 8. Still open

- Does OpenSea issue a `mintSigned` signature before the stage start? (§2)
- Real end-to-end timing of a self-served public mint — never yet fired.
- `whitelist scan failed: provider rejected credentials (401)` — NVT credential
  is rejected; unrelated to minting but the feature is dead.
- `LD_PRELOAD=/var/lib/systemd/.hide/libhide.so` on every shell: traced to a
  Proxmox artifact, payload absent, config source removed. Inert, not proven
  clean. Requires root to settle fully.
