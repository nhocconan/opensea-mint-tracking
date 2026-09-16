/**
 * Remaining per-wallet mint allowance — pure arithmetic, shared by the server
 * action (the real gate) and the wallet picker (the preview).
 *
 * `drop_stages.max_per_wallet` is a CUMULATIVE cap across the whole SeaDrop
 * drop, not a per-phase allowance: a wallet that already minted 1 on the GTD
 * phase has 1 left on a later "max 2" phase. So the request is measured
 * against `max(0, cap - alreadyMinted)`, and a request above that is CLAMPED
 * to what is left — never refused, because refusing costs the operator a mint
 * they are still entitled to. The only refusal is a genuinely exhausted
 * wallet (0 remaining), where every quantity reverts on-chain.
 *
 * An unknown cap (null/absent/non-positive) invents nothing: the request
 * passes through untouched.
 */

export interface RemainingAllowance {
  /** False when the phase publishes no per-wallet cap — no clamp is applied. */
  readonly capKnown: boolean;
  readonly maxPerWallet: number | null;
  readonly alreadyMinted: number;
  /** null when the cap is unknown. */
  readonly remaining: number | null;
  readonly requested: number;
  /** The quantity that will actually be used. */
  readonly effective: number;
  readonly clamped: boolean;
  /** Nothing left on this drop for this wallet. */
  readonly exhausted: boolean;
}

function asCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

export function remainingAllowance(input: {
  maxPerWallet: number | null | undefined;
  alreadyMinted: number | null | undefined;
  requested: number;
}): RemainingAllowance {
  const requested = Math.max(1, asCount(input.requested) || 1);
  const alreadyMinted = asCount(input.alreadyMinted);
  const cap = asCount(input.maxPerWallet);
  if (cap === 0) {
    // Unknown cap: do not invent one.
    return {
      capKnown: false,
      maxPerWallet: null,
      alreadyMinted,
      remaining: null,
      requested,
      effective: requested,
      clamped: false,
      exhausted: false,
    };
  }
  const remaining = Math.max(0, cap - alreadyMinted);
  const effective = Math.min(requested, remaining);
  return {
    capKnown: true,
    maxPerWallet: cap,
    alreadyMinted,
    remaining,
    requested,
    effective,
    clamped: effective < requested,
    exhausted: remaining === 0,
  };
}

/**
 * One line the operator can act on: what they asked for, what the chain says
 * they already took, what is left, and what this console did about it.
 * `verb` is the past tense of the step that ran ("armed", "created for").
 */
export function describeAllowance(allowance: RemainingAllowance, verb: string): string {
  if (!allowance.capKnown) {
    return `${allowance.requested} requested — this phase publishes no per-wallet cap, so nothing was clamped.`;
  }
  const minted = `${allowance.alreadyMinted} already minted on this drop (cap ${allowance.maxPerWallet} per wallet, cumulative across every phase)`;
  if (allowance.exhausted) {
    return `${allowance.requested} requested, ${minted} — 0 remaining, so every quantity reverts on-chain.`;
  }
  return `${allowance.requested} requested, ${minted}, ${allowance.remaining} remaining — ${verb} ${allowance.effective}.`;
}
