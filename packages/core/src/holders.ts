/**
 * Whale / holder-concentration analysis (feature-backlog.md §2, shipped
 * 2026-08-22). Distinct from concentration.ts's `mintConcentrationSeverity`:
 * that's a cheap avg-per-wallet proxy over rolling-window aggregate counts
 * (already shipped, meant for the feed's live-glance chip); this is the
 * real thing — actual top-N holder share of total minted supply, computed
 * from per-recipient mint totals, meant for a project's detail page. A
 * concentrated early-minter supply is the single best predictor of an
 * immediate post-mint dump for a young collection (Nansen NFT God Mode /
 * HolderCount sell exactly this signal as a standalone product).
 *
 * Pure, no I/O: takes already-summed-by-recipient rows (one row per unique
 * minting wallet, its total quantity) so the repository layer owns the
 * SQL GROUP BY and this stays trivially unit-testable.
 */

export interface RecipientQuantity {
  readonly recipient: string;
  readonly quantity: number;
}

export interface HolderShare {
  readonly recipient: string;
  readonly quantity: number;
  /** 0-100, one decimal place. */
  readonly sharePct: number;
}

export interface HolderConcentration {
  readonly totalMinted: number;
  readonly uniqueHolders: number;
  /** Top 10 by quantity, descending. */
  readonly topHolders: readonly HolderShare[];
  readonly top5SharePct: number;
  readonly top10SharePct: number;
}

const TOP_N = 10;

function sharePct(quantity: number, totalMinted: number): number {
  if (totalMinted <= 0) {
    return 0;
  }
  return Math.round((quantity / totalMinted) * 1000) / 10;
}

/**
 * Shared by both entry points below: given the TRUE total/unique-holder
 * counts (from the full recipient set, not just the top N) and an
 * already-sorted-descending top-N slice, derive every percentage. Kept
 * separate from computeHolderConcentration so the read path
 * (deriveHolderConcentration) can't accidentally re-derive totalMinted by
 * summing only the top N it has on hand, which would silently undercount.
 */
function buildConcentration(
  totalMinted: number,
  uniqueHolders: number,
  topN: readonly RecipientQuantity[],
): HolderConcentration {
  const top5Sum = topN.slice(0, 5).reduce((sum, r) => sum + r.quantity, 0);
  const top10Sum = topN.slice(0, TOP_N).reduce((sum, r) => sum + r.quantity, 0);
  return {
    totalMinted,
    uniqueHolders,
    topHolders: topN
      .slice(0, TOP_N)
      .map((r) => ({ ...r, sharePct: sharePct(r.quantity, totalMinted) })),
    top5SharePct: sharePct(top5Sum, totalMinted),
    top10SharePct: sharePct(top10Sum, totalMinted),
  };
}

/**
 * Write-time entry point: pass every recipient's summed quantity (one row
 * per unique minting wallet) — totalMinted/uniqueHolders are derived from
 * the full set here, which is why this must not be called with an
 * already-truncated list (use deriveHolderConcentration for that).
 */
export function computeHolderConcentration(
  recipientQuantities: readonly RecipientQuantity[],
): HolderConcentration {
  const totalMinted = recipientQuantities.reduce((sum, r) => sum + r.quantity, 0);
  const sorted = [...recipientQuantities].sort((a, b) => b.quantity - a.quantity);
  return buildConcentration(totalMinted, recipientQuantities.length, sorted);
}

/**
 * Read-time entry point: rehydrate percentages from a stored snapshot that
 * only ever kept the top N (plus the true totalMinted/uniqueHolders
 * scalars computed once at write time) — see holder_snapshots in
 * packages/db/src/schema.ts. `topHolders` must already be sorted
 * descending and already be the top N (as computeHolderConcentration
 * produces and the repository stores it); this does not re-sort or
 * re-derive the totals.
 */
export function deriveHolderConcentration(snapshot: {
  readonly totalMinted: number;
  readonly uniqueHolders: number;
  readonly topHolders: readonly RecipientQuantity[];
}): HolderConcentration {
  return buildConcentration(snapshot.totalMinted, snapshot.uniqueHolders, snapshot.topHolders);
}

export const HOLDER_CONCENTRATION_SEVERITIES = ["none", "watch", "high"] as const;
export type HolderConcentrationSeverity = (typeof HOLDER_CONCENTRATION_SEVERITIES)[number];

/**
 * Threshold judgment on the top-10 share of total minted supply — same
 * advisory-only framing as concentration.ts's mintConcentrationSeverity
 * (never a block, never conflated with eligibility/lifecycle). A separate
 * function, not a reuse of mintConcentrationSeverity, because the input
 * shape is genuinely different: that one is a rolling-window avg-per-wallet
 * proxy, this is the true top-10-of-total-supply share.
 */
export function holderConcentrationSeverity(
  top10SharePct: number,
  totalMinted: number,
): HolderConcentrationSeverity {
  if (totalMinted < 10) {
    return "none"; // not enough sample to say anything meaningful
  }
  if (top10SharePct >= 50) {
    return "high";
  }
  if (top10SharePct >= 25) {
    return "watch";
  }
  return "none";
}
