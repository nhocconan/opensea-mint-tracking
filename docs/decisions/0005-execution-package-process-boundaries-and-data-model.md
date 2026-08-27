# 0005 — Execution package/process boundaries and data model

Date: 2026-08-21
Status: accepted
Produced by: multi-agent expert panel (CTO/CPO orchestration, `/goal`) — see
[`docs/execution-architecture.md`](../execution-architecture.md) for the full
roadmap this ADR is one piece of, and the panel's underlying position papers.

## Context

The CPO, Risk/SRE, and CTO lanes each sketched slightly different package names and table shapes for execution (packages/execution vs. a bare mint-execution queue; various table names). The CTO lane's proposal is the most concretely grounded — it was written after reading the actual schema.ts, queues.ts, chain/rpc.ts, secrets, and config files in this repo — and reuses existing durable patterns (the notificationOutbox/notificationAttempts one-plan-many-attempts shape, its unique-dedupe-key and FOR UPDATE SKIP LOCKED discipline) rather than inventing new ones. A red-team pass on the first version of this ADR found the atomic firing transition as originally specified ('status=armed → executing') did not explicitly include the arm's time-window expiry in the same atomic check, and that mandatory pre-flight simulation was described only as a Phase-1 checklist bullet rather than a permanent, non-bypassable stage of the pipeline itself — both gaps could let a stale or unsimulated plan fire under conditions (a since-changed stage, a since-reverting call) the owner never intended.

## Decision

Adopt the CTO lane's boundaries as the base architecture: packages/execution (orchestrates plan → per-contract MintAdapter → pure policy check from packages/core → packages/signing → broadcast via extended providers/chain → writes executionAttempts; the only package allowed to import packages/signing); packages/signing (the sole signer abstraction and decrypt chokepoint per ADR 0004); packages/core extended with pure MintPlan/ExecutionPolicy/gas-strategy types; a new top-level process apps/executor running only the mintWatch and execution BullMQ queues (queue name 'mint-execution' per the Risk/SRE lane's naming), deployed and restart-independent from apps/worker so 'stop one container' is a real emergency-stop story. New tables: rpcEndpoints, signers (the 7702/Roles delegate registration, FK to wallets rather than overloading wallets' existing single meaning of 'address tracked for eligibility'), mintPlans (carrying its own per-plan spend ceiling and armed_until per ADR 0004's cap tiering), executionAttempts (mirrors notificationOutbox/notificationAttempts exactly).

Exactly-once firing is a single atomic conditional UPDATE whose WHERE clause checks status='armed' AND armed_until > now() AND spend-to-date < the plan's own per-plan ceiling, flipping to 'executing' only if all three hold, evaluated together — not status alone, and never split across a separate 'auto-disarm' background job. A lagging or crashed disarm process can therefore never leave a stale, expired arm live to fire against a since-changed mint stage; the window and ceiling checks live in the same query that prevents double-dispatch, not in application memory or a second job's responsibility.

The pipeline itself is fixed, in code, as: plan → MintAdapter → mandatory pre-flight simulation (eth_call/callStatic against current chain state) → packages/core policy check (window + per-plan ceiling) → packages/signing → broadcast → executionAttempts, in that order, as a non-bypassable sequence inside packages/execution — not a Phase-1-only checklist item that could quietly stop applying once Phase 2 moves from logging a would-fire decision to real signing. A reverting or failed simulation blocks progression to the policy-check/signing stages unconditionally, in every phase, permanently.

## Consequences

Signing stays structurally impossible to reach except through one auditable, mockable chokepoint, mirroring why packages/secrets is already split out today. A concrete pre-existing bug surfaced while reviewing this area must be fixed before rpcEndpoints/multi-chain work lands: packages/queues/src/queues.ts's enqueueChainSync hardcodes jobIdFor.chainSync(4663, …) even though ChainSyncJobData will need to carry chainId once a second chain exists. Because window/ceiling/status are now one atomic condition, an integration test asserting 'an expired-but-not-yet-disarmed plan cannot transition to executing' is a required test alongside the recipient-redirect test from ADR 0004, and both must be exercised by the Phase 2 rehearsal gate (ADR 0008), not just unit-tested in isolation.

## Alternatives rejected

A fully separate execution microservice/repo — rejected; duplicates credentials/secrets/observability/auth plumbing that already exists for a single-operator, single-deploy-target product with no team boundary to justify the split. Signing logic inlined into a worker instead of its own package — rejected; the one place a mistake is irreversible should not be one copy-paste away from a looser check. Handling window expiry via a separate scheduled disarm job as the primary safety mechanism — rejected; a job can lag, crash, or be delayed by BullMQ retry backoff, and the atomic DB condition is strictly stronger at zero extra cost, so the job (if kept at all) becomes a UX-only convenience that closes the UI state promptly, never the thing actually preventing a stale fire.
