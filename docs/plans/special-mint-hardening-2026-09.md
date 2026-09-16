# Special mint hardening — 2026-09-15

GOAL: the special-mint path fires an FCFS phase and a public phase correctly and
competitively tonight, on native and (if possible) USDG pricing. Verified change,
not a rewrite. No commit, no push, no deploy without the operator.

## Confirmed by the lead's own reading (not taken from an agent report)
- No `eth_getTransactionReceipt` on the fire path -> "executed" == mempool accepted.
- No `approve(` in packages/ or apps/ -> USDG mint cannot pay.
- `spentWei: 0n` hardcoded (worker execution.ts:564) + `canFireMintPlan` takes no tx
  value -> the per-plan ceiling is decorative on the live fire path.
- presign.ts:43 subtracts the clock offset; fire-schedule.ts:71 adds it.
- pipeline.ts:89 simulation is unconditional -> a sim RTT precedes the presigned blob.
- execution.ts:513 `cacheIsFresh` computed before :518 `nearFire` -> a fresh FCFS-phase
  calldata blob wins at the public phase's fire instant.

## SHIPPED (lead, this session)
- normalizer.ts stageTypeToKind: restriction markers now tested before public/open;
  "fcfs" added; "wl" matched as a token. Ambiguous -> "unknown" (already restricted).
  Root cause of "FCFS shown as public mint" reported live by the operator.
- stages.ts nextStage: now filters `paused`, matching currentStage.
- Regression tests: providers 129/129, core 175/175 green.
- Stored rows self-correct: `current.type !== stage.kind` is inside materialChange
  (projects.ts:243), so the next detail scan rewrites drop_stages.type.

## LANES — all landed, full gate green (typecheck 0, all tests pass)
- A (lead): worker execution.ts, db repositories/execution.ts, core/execution.ts,
  execution/pipeline.ts -- double-mint on broadcast-then-DB-failure; double-mint via
  stale-presign fallback; receipt confirmation; ceiling vs tx value; ignore cached
  calldata when nearFire; per-wallet nonce allocation; unanchored /exceeds/ terminal
  classifier; publishEvent on failed/expired.
- B: presign.ts, clock-calibration.ts, providers/chain/{simulate,broadcast,fees}
  -- offset sign, fee bump + fee-too-low re-sign, RPC timeout budget, calibration bias.
- C: web funding.ts, special-mint actions, special-mints pages, core/funding.ts
  -- fail-open funding gate, arm window vs fire instant, eligibility on arm,
  maxPerWallet, paused stage, past fire time, staleness labels.
- F: scripts/preflight-mint.ts -- single "am I ready to mint" read-only verdict table.
- G: scripts/approve-erc20.ts -- manual one-time USDG approve, dry-run by default.

## ASSUMPTIONS TAKEN (all reversible)
- Scope is harden-and-verify, not a rewrite: a rewrite hours before a live mint is the
  higher risk. Stated to the operator at kickoff.
- ERC-20 approve stays a manual operator-run script tonight; automating it inside the
  fire path conflicts with lane A and cannot be verified in time.
- Ambiguous stage types fail closed to restricted. Over-restricting costs a redundant
  eligibility check; under-restricting presents a whitelist phase as a public mint.

## ACCEPTANCE
corepack pnpm typecheck / test; biome check per lane.
`pnpm lint` also runs an audit script needing `rg`, absent on this host -> biome direct.

## NEEDS OPERATOR
1. Deploy decision. Prod is running and current with main; the fix only reaches the
   radar after a rebuild + the next detail scan.
2. Confirm rare-friends-genesis stage_type/starts_at via psql (classifier blocks the
   agent from prod reads).
3. Run scripts/approve-erc20.ts --execute if tonight's mint is USDG-priced.

trust: money-path hardening under deadline - run 1 of this class - clean pending gate


## GATE RESULT (2026-09-15)
- `corepack pnpm typecheck` -> exit 0
- `corepack pnpm -r run test` -> every package passed, exit 0 (worker 26, core 175, providers 129)
- `corepack pnpm exec biome check .` -> 10 files still error; ALL pre-existing, verified by
  `comm` against `git status` to have zero overlap with this run's changed files.
- `pnpm lint` not run: its audit script needs `rg`, absent on this host.

## SHIPPED — lane A (lead)
F1 a broadcast tx is never released back to `armed` (both fast and live paths) -- the
   post-broadcast bookkeeping failure used to re-arm and double-mint at nonce+1.
F2 stale-presign fallback now asks the chain whether OUR OWN tx already landed before
   re-signing (txAlreadyLanded), instead of guessing from "nonce too low".
F3 receipt confirmation on both paths: `executed` only on a real receipt; a revert
   releases to keep competing; "unknown" consumes the arm rather than risking a re-fire.
F4 canFireMintPlan gained txValueWei -- the per-plan ceiling now caps what is broadcast.
F5 a cached calldata blob can no longer win at the fire instant (wrong-phase calldata).
F6 per-wallet nonce reservation shared by the presign pass and the live sign; decidePresign
   re-signs only when the CHAIN moved past us, not when a sibling reservation is ahead.
F8 isTerminalMintBuildError no longer matches a bare /exceeds/ from an unrelated live phase.
F15 execution.failed event published on every terminal failure (was entirely silent).
+ claim SQL refuses a plan whose stage was superseded (paused) between arm and fire.
+ Admin -> Execution arm now says "FUNDING NOT VERIFIED" instead of a clean "Armed".

trust: money-path hardening under deadline - run 1 of this class - gate clean, deploy pending

## ROUND 2 — adversarial verifier found 3 BLOCKERs in the lead's own round-1 work
Root cause of all of them: the fire path had NO idempotency key. The broadcast tx hash was
written to execution_attempts and never read back, so after any interruption the worker
guessed from an error string.
- Idempotency gate after every claim: latestBroadcastAttempt -> resolveTxOutcome.
  success -> close the plan; reverted -> re-fire; unresolved -> hold 3s (PRIOR_BROADCAST_GRACE_MS).
- resolveTxOutcome replaced the boolean txAlreadyLanded, which ignored receipt.status and so
  reported a REVERTED transaction as a completed mint.
- releaseNonce when a presigned blob is discarded unmined -- otherwise the live re-sign took
  nonce+1 and stranded the wallet behind a permanent gap at the nonce the chain still expects.
- Broadcast budget split from the read budget (2500ms vs 800ms): an abort does not cancel the
  request, so a send the sequencer accepted looked like a failure and was re-fired.
- expireStaleMintPlans now publishes execution.failed (was the commonest silent death).
- Ceiling regression tests added WITH a negative control: disabling the branch fails 2 tests.

## ROUND 2 — multi-drop racing (3 collections at once)
- Hot-loop fan-out DETACHED. It used to `await Promise.allSettled(...)` and the scheduler only
  re-arms after a tick settles, so one plan inside a 12s signature burst blinded the loop for
  3x the continue window and the other collections missed their windows silently.
- Claim ordered by fire target, not armed_until (which is unrelated to urgency).
- isTerminalMintBuildError split: whole-drop terminals only. isPerWalletLimitError is never
  terminal -- inside the burst it no longer stops polling (before the target phase opens,
  OpenSea answers about whichever phase is ACTIVE), and the caller descends quantity to the
  wallet's real remainder. This is the exit-founders GTD case: 1 already minted, cap 2 -> 1 left.
- Arm-time clamp from mint_events (agent lane): plans are created/armed at the remainder
  instead of being refused.

## ROUND 2 — security, ahead of the operator pasting an Xverse key
Audit verdict GO WITH CONDITIONS. Envelope custody verified on the RUNNING stack: web holds
only WALLET_KEY_PUBLIC_KEY, the private half is bind-mounted read-only into the worker, and the
public half derived from it matches. TLS enforced at Traefik. No key material in git history.
Fixed here: decrypt+sign wrapped so no exception text (persisted to error_code and rendered in
the admin UI) can carry key material; web no longer pulls the sealed blob to null-test it.

## FINAL GATE
typecheck exit 0 - 496 tests pass across 14 packages, 0 failures - biome clean on every file
this run touched (10 pre-existing failures elsewhere, zero overlap, verified with comm).

trust: money-path hardening under deadline - run 1 of this class - gate clean, NOT deployed

## ROUND 3 — drop night: quota triage (2026-09-15, deploy #2 already live)
- OpenSea quota was reserve-reached and STAYED reached after the operator added a
  second key. Cause: `OpenSeaClient.quota` was a single shared state overwritten from
  whichever response came back last, regardless of which key sent it — so one spent
  key's `x-ratelimit-remaining: 0` shut the gate for every key. Now tracked per key
  (`quotaByKey`), the gate asks "is there ANY key with budget", and pacing only ever
  picks from keys that still have budget.
- `buildDropMintTransaction` marked priority: it may spend the reserve floor. That floor
  exists to protect exactly this call, and previously nothing could spend it — so at the
  fire instant the mint could not build calldata at all. `reserve-reached` (voluntary
  floor) is now distinct from `exhausted` (key genuinely empty).
- `resolveSpecialMintTargetAction` now ALWAYS enqueues a hot detail refresh. It used to
  re-ask OpenSea only for an UNKNOWN project with zero stages, so a project that already
  held stages returned stale DB rows — which is why the operator kept resolving to a
  12/9 phase. The message now states the phases are what is stored, not what is live.
- PUBLIC_SCAN_ENABLED=false: gates collection-discovery, discovery-schedule,
  live-next-refresh, sentiment and nvt-discord-scan. Still running: the details QUEUE
  worker (so on-demand resolves are served), every mint job (prebuild, presign, execution,
  hot loop), chain sync, rpc-health, clock calibration, wallet balances, eligibility,
  stage alerts, supply sweep (RPC, not OpenSea).
- DISCOVERY_INTERVAL_SECONDS / COLLECTION_DISCOVERY_INTERVAL_SECONDS = 1800 (verified live:
  worker logged "discoveryInterval":1800).

## STILL UNRESOLVED
The only rare-friends record the worker has touched is slug `rare-friends-genesis1`
(trailing 1), which OpenSea 404s and which is now marked delisted. OpenSea's own public
page for `rare-friends-genesis` publishes NO phase schedule at all (fetched directly).
So the 12/9 the operator sees is stored data of unknown provenance, and the 15/9 23:00
public mint time is not something OpenSea exposes — it must be set with the manual
`fire_at` override. Settle with psql before arming.
