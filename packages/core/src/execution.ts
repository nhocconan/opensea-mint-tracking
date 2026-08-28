/**
 * Execution domain types and pure policy logic (ADR 0004/0005/0006/0007).
 *
 * Phase status: data-model and policy foundation only. Nothing in this
 * repository imports {@link canFireMintPlan} from a live signing path yet —
 * see docs/execution-architecture.md. This file exists so the exactly-once
 * firing predicate has ONE authoritative, unit-tested definition that the
 * eventual atomic DB WHERE-clause (packages/db, ADR 0005) and any UI
 * preview must both agree with, rather than three independent guesses.
 */

export const MINT_PLAN_STATUSES = [
  "draft",
  "armed",
  "executing",
  "executed",
  "expired",
  "cancelled",
  "failed",
] as const;
export type MintPlanStatus = (typeof MINT_PLAN_STATUSES)[number];

export const EXECUTION_ATTEMPT_STATUSES = [
  "simulating",
  "simulated_ok",
  "simulated_revert",
  "awaiting_signature",
  "broadcast",
  "provisional_success",
  "confirmed",
  "failed",
] as const;
export type ExecutionAttemptStatus = (typeof EXECUTION_ATTEMPT_STATUSES)[number];

/** browser_wallet = Phase 1 (zero server custody). The other two are Phase 2 (ADR 0004). */
export const SIGNER_SCHEMES = [
  "browser_wallet",
  "eip7702_safe_zodiac",
  "custom_executor",
  // Owner-authorized managed-key custody: the worker signs a direct mint tx
  // with a burner wallet's AES-256-GCM-sealed EOA key (no Executor contract),
  // for autonomous multi-wallet minting. Still hard-gated by
  // LIVE_EXECUTION_ENABLED + WebAuthn step-up on import.
  "managed_wallet_key",
] as const;
export type SignerScheme = (typeof SIGNER_SCHEMES)[number];

export const SIGNAL_KINDS = ["hype", "risk"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * Deliberately distinct from {@link Confidence} (packages/core/confidence.ts,
 * ADR 0007): that rates identity/schedule facts, this rates trust in a
 * hype/risk read. A loud Twitter mob must never be able to raise a
 * project's own confidence — keeping the enums separate makes that
 * conflation a type error, not just a code-review convention.
 */
export const SIGNAL_CONFIDENCE_LEVELS = [
  "corroborated",
  "single-source",
  "unverified",
  "stale",
] as const;
export type SignalConfidence = (typeof SIGNAL_CONFIDENCE_LEVELS)[number];

export interface MintPlanFireCheck {
  readonly status: MintPlanStatus;
  readonly armedUntil: Date | null;
  /** Coarse, on-chain-enforced backstop for the signer this plan uses (wei). */
  readonly signerCeilingWei: bigint;
  /** Precise per-arm ceiling the owner set for this specific plan (wei). */
  readonly perPlanCeilingWei: bigint;
  /** Sum already spent by prior attempts on this plan (wei); 0n if none. */
  readonly spentWei: bigint;
}

export type MintPlanFireDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The single authoritative "may this plan fire right now" predicate
 * (ADR 0005). Every real-money code path must reduce to exactly this
 * check, evaluated atomically (status + window + ceiling together, in one
 * DB WHERE clause) — never split across a status check here and a
 * best-effort disarm job elsewhere, and never re-derived independently.
 */
export function canFireMintPlan(input: MintPlanFireCheck, now: Date): MintPlanFireDecision {
  if (input.status !== "armed") {
    return { ok: false, reason: `plan status is '${input.status}', not 'armed'` };
  }
  if (input.armedUntil === null) {
    return { ok: false, reason: "plan has no arm window set" };
  }
  if (input.armedUntil.getTime() <= now.getTime()) {
    return { ok: false, reason: "arm window has expired" };
  }
  if (input.perPlanCeilingWei <= 0n) {
    return { ok: false, reason: "per-plan ceiling must be positive" };
  }
  if (input.perPlanCeilingWei > input.signerCeilingWei) {
    return {
      ok: false,
      reason:
        "per-plan ceiling exceeds the signer's coarse on-chain ceiling (ADR 0004 cap tiering)",
    };
  }
  if (input.spentWei >= input.perPlanCeilingWei) {
    return { ok: false, reason: "per-plan spend ceiling already reached" };
  }
  return { ok: true };
}

export interface RpcCandidate {
  readonly id: string;
  readonly chainId: number;
  readonly enabled: boolean;
  readonly priority: number;
  readonly healthStatus: "healthy" | "degraded" | "down" | "unknown";
}

const HEALTH_RANK: Record<RpcCandidate["healthStatus"], number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  down: 3,
};

/**
 * Pure ranking for the RpcPool abstraction (ADR 0006): enabled endpoints for
 * the chain, healthiest first, then lowest priority number, stable by input
 * order otherwise. `down` endpoints sort last but are not dropped, so a
 * chain with only unhealthy endpoints still returns a best-effort order
 * instead of an empty list.
 *
 * Generic over `T`, not fixed to `RpcCandidate`, so a caller can pass the
 * full DB row shape (which has `httpUrl`/`wsUrl` — fields this ranking
 * logic doesn't need to read) and get the same full shape back, still
 * correctly typed, instead of losing those fields to the bare
 * `RpcCandidate` return type (ADR 0009, item P2 — this is what makes
 * `rankRpcEndpoints(...)[0].httpUrl` type-check at the call site).
 */
export function rankRpcEndpoints<T extends RpcCandidate>(
  endpoints: readonly T[],
  chainId: number,
): T[] {
  return endpoints
    .filter((e) => e.chainId === chainId && e.enabled)
    .map((e, index) => ({ e, index }))
    .sort((a, b) => {
      const health = HEALTH_RANK[a.e.healthStatus] - HEALTH_RANK[b.e.healthStatus];
      if (health !== 0) {
        return health;
      }
      const priority = a.e.priority - b.e.priority;
      if (priority !== 0) {
        return priority;
      }
      return a.index - b.index;
    })
    .map(({ e }) => e);
}
