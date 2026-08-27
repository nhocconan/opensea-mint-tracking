/**
 * Pure hype/velocity scoring (ADR 0007). No I/O, no X API call, no DB —
 * this only turns numbers a caller already has (from packages/providers'
 * XClient, or any future source) into a bounded score and confidence.
 * Advisory only: nothing in this package writes to projects.confidence or
 * lifecycleStatus (see packages/db/repositories/signals.ts's own
 * enforcement — this package doesn't even import @hoodmint/db, so it
 * structurally cannot).
 */
import type { SignalConfidence } from "@hoodmint/core";

export interface MentionSample {
  readonly likeCount: number;
  readonly retweetCount: number;
  readonly replyCount: number;
  readonly quoteCount: number;
}

export interface HypeSignalInput {
  readonly currentWindowMentions: number;
  /** Average mentions per equivalent window, historically — 0 if unknown. */
  readonly baselineAvgMentions: number;
  readonly samples: readonly MentionSample[];
}

export interface HypeSignalResult {
  readonly score: number;
  readonly confidence: SignalConfidence;
  readonly velocityRatio: number;
}

const MIN_SAMPLES_FOR_SIGNAL = 5;
/** No baseline to compare against yet — treat as this many times "normal" rather than an undefined ratio. */
const NO_BASELINE_RATIO = 10;

/**
 * 60% mention-velocity (how much louder than the historical baseline),
 * 40% engagement-weighted reach (retweets/quotes count double — they
 * spread beyond the original audience, likes/replies don't). Both
 * components are bounded to 0–100 before combining so one outlier post
 * can't dominate the score.
 */
export function computeHypeSignal(input: HypeSignalInput): HypeSignalResult {
  const velocityRatio =
    input.baselineAvgMentions > 0
      ? input.currentWindowMentions / input.baselineAvgMentions
      : input.currentWindowMentions > 0
        ? NO_BASELINE_RATIO
        : 0;

  const engagementSum = input.samples.reduce(
    (sum, s) => sum + s.likeCount + s.retweetCount * 2 + s.quoteCount * 2 + s.replyCount,
    0,
  );
  const avgEngagementPerMention =
    input.samples.length > 0 ? engagementSum / input.samples.length : 0;

  const velocityComponent = Math.min(100, velocityRatio * 20);
  const engagementComponent = Math.min(100, avgEngagementPerMention * 2);
  const score = Math.round(velocityComponent * 0.6 + engagementComponent * 0.4);

  const confidence: SignalConfidence =
    input.samples.length < MIN_SAMPLES_FOR_SIGNAL ? "unverified" : "single-source";

  return { score, confidence, velocityRatio };
}
