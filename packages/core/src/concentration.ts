/**
 * Bot-mint concentration signal (feature backlog, quick win #4): the
 * on-chain radar already collects rolling-window mint quantity and unique
 * recipient counts (`mint_aggregates`) — this turns those two numbers into
 * a severity a UI can flag without inventing a new data source. A live
 * mint dominated by a handful of wallets is a classic sniper/bot pattern;
 * this is advisory only, never a block, and never conflated with
 * eligibility or lifecycle status (same separation principle as ADR 0007's
 * signal confidence vs. project confidence).
 */

export const CONCENTRATION_SEVERITIES = ["none", "watch", "high"] as const;
export type ConcentrationSeverity = (typeof CONCENTRATION_SEVERITIES)[number];

/** Below this quantity there isn't enough signal to say anything meaningful. */
const MIN_SAMPLE_QUANTITY = 10;
const WATCH_AVG_PER_WALLET = 3;
const HIGH_AVG_PER_WALLET = 5;

/**
 * Pure threshold classifier — no I/O, fully deterministic. `quantity` and
 * `uniqueRecipients` are the same rolling-window numbers already shown by
 * `formatVelocity` (apps/web/src/lib/format.ts); this just adds a
 * threshold judgment on top of numbers already computed and stored.
 */
export function mintConcentrationSeverity(
  quantity: number,
  uniqueRecipients: number,
): ConcentrationSeverity {
  if (quantity < MIN_SAMPLE_QUANTITY || uniqueRecipients <= 0) {
    return "none";
  }
  const avgPerWallet = quantity / uniqueRecipients;
  if (avgPerWallet >= HIGH_AVG_PER_WALLET) {
    return "high";
  }
  if (avgPerWallet >= WATCH_AVG_PER_WALLET) {
    return "watch";
  }
  return "none";
}
