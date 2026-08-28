/**
 * Pre-sign scheduling (ADR 0009 fast path, owner-authorized managed-key
 * custody). The competitive win on a FIFO sequencer is doing ZERO work at
 * the fire instant except one `sendRawTransaction`: the raw tx (calldata +
 * nonce + fees + signature) must already exist. These pure helpers decide
 * WHEN to (re)sign so the blob is fresh but not churned.
 *
 * Invariants:
 * - Sign inside a lead window before the clock-corrected stage open, never
 *   earlier (nonce/fee drift) and not so late the RPC round-trips race the
 *   open.
 * - Re-sign when the blob is older than `ttlMs` (fees/nonce may have moved)
 *   or when the wallet's pending nonce advanced past what was signed.
 */

export interface PresignDecisionInput {
  /** Stage open instant on chain-corrected time, ms epoch. */
  readonly stageStartChainMs: number;
  /** local-now + clockOffset == chain-now (see clock-offset.ts). */
  readonly clockOffsetMs: number;
  readonly localNowMs: number;
  /** How long before open to have a signed blob ready. */
  readonly leadMs: number;
  /** Max age of a signed blob before it's re-signed. */
  readonly ttlMs: number;
  /** When the current blob was signed, or null if none. */
  readonly presignedAtMs: number | null;
  /** Nonce the blob was signed with, or null if none. */
  readonly presignedNonce: number | null;
  /** The wallet's current pending nonce, if known this tick. */
  readonly currentNonce?: number | null;
  /** Grace after open during which a blob is still worth keeping (burst). */
  readonly continueForMs: number;
}

export type PresignDecision =
  | { readonly action: "wait"; readonly msUntilWindow: number }
  | { readonly action: "sign"; readonly reason: "none" | "stale" | "nonce_advanced" }
  | { readonly action: "keep" }
  | { readonly action: "expired" };

export function decidePresign(input: PresignDecisionInput): PresignDecision {
  const localStartMs = input.stageStartChainMs - input.clockOffsetMs;
  const windowOpensAt = localStartMs - input.leadMs;
  const now = input.localNowMs;

  if (now > localStartMs + input.continueForMs) {
    return { action: "expired" };
  }
  if (now < windowOpensAt) {
    return { action: "wait", msUntilWindow: windowOpensAt - now };
  }
  if (input.presignedAtMs === null || input.presignedNonce === null) {
    return { action: "sign", reason: "none" };
  }
  if (
    input.currentNonce !== undefined &&
    input.currentNonce !== null &&
    input.currentNonce !== input.presignedNonce
  ) {
    return { action: "sign", reason: "nonce_advanced" };
  }
  if (now - input.presignedAtMs > input.ttlMs) {
    return { action: "sign", reason: "stale" };
  }
  return { action: "keep" };
}

/**
 * Classify an RPC rejection of a pre-signed broadcast. A nonce/replacement
 * error means the blob is dead (wallet sent something else) — fall back to
 * the full build+sign path immediately. Anything else is a real failure.
 */
export function isStalePresignError(message: string): boolean {
  return /nonce too low|nonce is too low|already known|replacement transaction underpriced|invalid nonce|nonce.*expected/i.test(
    message,
  );
}
