/**
 * Pure scam/risk scoring from public-post text (ADR 0007). No I/O, no DB,
 * no X call — turns tweet text a caller already fetched into a bounded
 * risk score + the red-flag phrases that fired. Deliberately a transparent
 * keyword heuristic, NOT a claim of scam detection: it surfaces "the
 * chatter around this drop looks phishing-shaped" as an advisory the owner
 * weighs, never a block and never anything that touches
 * projects.confidence/lifecycleStatus (this package can't import
 * @hoodmint/db, the structural guarantee ADR 0007 requires).
 *
 * The red-flag set targets the specific shapes of NFT-mint phishing that
 * recur in replies under a real drop's mentions: fake "claim/airdrop"
 * bait, wallet-draining CTAs ("connect/verify wallet", "sync"), and
 * manufactured urgency ("mint is live NOW", "sold out soon"). Each phrase
 * is matched case-insensitively on word-ish boundaries so "claimant"
 * doesn't trip "claim".
 */
import type { SignalConfidence } from "@hoodmint/core";

export interface RiskSample {
  readonly text: string;
}

export interface RiskSignalInput {
  readonly samples: readonly RiskSample[];
}

export interface RiskSignalResult {
  readonly score: number;
  readonly confidence: SignalConfidence;
  /** Distinct red-flag phrases that fired, for the evidence trail / UI. */
  readonly flags: string[];
  /** Fraction of sampled posts containing ≥1 red flag (0–1). */
  readonly flaggedFraction: number;
}

const MIN_SAMPLES_FOR_SIGNAL = 5;

/**
 * Red-flag phrases, grouped by intent for readability. Kept intentionally
 * small and specific — a broad list would fire on ordinary hype ("mint")
 * and make the score meaningless. Matched as whole-ish tokens.
 */
const RED_FLAGS: readonly string[] = [
  // wallet-draining CTAs
  "connect wallet",
  "verify wallet",
  "sync wallet",
  "validate wallet",
  "connect your wallet",
  // fake claim / airdrop bait
  "claim your",
  "claim now",
  "free airdrop",
  "airdrop is live",
  "claim airdrop",
  "eligible for the airdrop",
  // manufactured urgency / classic phishing tells
  "mint is live now",
  "before it sells out",
  "only a few left",
  "gas error",
  "first come first serve", // in reply-spam context, not the drop's own copy
  "dm me",
  "dm to claim",
];

function countFlagsInText(lowerText: string): string[] {
  const hits: string[] = [];
  for (const flag of RED_FLAGS) {
    // Word-boundary-ish: the phrase must be delimited by non-letters (or
    // string ends) so "claimant" ≠ "claim". Phrases with spaces already
    // carry their own boundaries.
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i");
    if (re.test(lowerText)) {
      hits.push(flag);
    }
  }
  return hits;
}

export function computeRiskSignal(input: RiskSignalInput): RiskSignalResult {
  const flagSet = new Set<string>();
  let flaggedPosts = 0;
  for (const sample of input.samples) {
    const hits = countFlagsInText(sample.text.toLowerCase());
    if (hits.length > 0) {
      flaggedPosts += 1;
      for (const h of hits) {
        flagSet.add(h);
      }
    }
  }
  const flaggedFraction = input.samples.length > 0 ? flaggedPosts / input.samples.length : 0;

  // Score = fraction of phishing-shaped posts, scaled to 0–100. A small
  // amount of reply-spam is normal under any live drop, so the bottom of
  // the range is muted; a majority-phishing mention stream pins high.
  const score = Math.min(100, Math.round(flaggedFraction * 120));

  const confidence: SignalConfidence =
    input.samples.length < MIN_SAMPLES_FOR_SIGNAL ? "unverified" : "single-source";

  return { score, confidence, flags: [...flagSet].sort(), flaggedFraction };
}
