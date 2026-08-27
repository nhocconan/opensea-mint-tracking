/**
 * Connects XClient's raw tweets to the pure hype scorer (ADR 0007). Still
 * no DB write here — this package stays structurally incapable of touching
 * projects.confidence/lifecycleStatus or eligibilityChecks.status; the
 * caller (a future worker loop, not wired up yet — see
 * docs/execution-architecture.md) is responsible for calling
 * packages/db's `insertSignal` with this result.
 */
import type { ParsedTweet, XClient } from "@hoodmint/providers";
import { computeHypeSignal, type HypeSignalResult, type MentionSample } from "./hype.ts";
import { computeRiskSignal, type RiskSignalResult } from "./risk.ts";

export interface ScanMentionsInput {
  readonly client: XClient;
  readonly query: string;
  readonly baselineAvgMentions: number;
  readonly sinceId?: string;
}

export interface ScanMentionsResult extends HypeSignalResult {
  readonly tweetCount: number;
  readonly newestId: string | null;
}

function toSample(tweet: ParsedTweet): MentionSample {
  return {
    likeCount: tweet.public_metrics?.like_count ?? 0,
    retweetCount: tweet.public_metrics?.retweet_count ?? 0,
    replyCount: tweet.public_metrics?.reply_count ?? 0,
    quoteCount: tweet.public_metrics?.quote_count ?? 0,
  };
}

export async function scanMentions(input: ScanMentionsInput): Promise<ScanMentionsResult> {
  const { tweets, newestId } = await input.client.searchRecentMentions(input.query, input.sinceId);
  const hype = computeHypeSignal({
    currentWindowMentions: tweets.length,
    baselineAvgMentions: input.baselineAvgMentions,
    samples: tweets.map(toSample),
  });
  return { ...hype, tweetCount: tweets.length, newestId };
}

export interface ScanSignalsResult {
  readonly hype: HypeSignalResult;
  readonly risk: RiskSignalResult;
  readonly tweetCount: number;
  readonly newestId: string | null;
}

/**
 * Fetch a subject's recent public mentions ONCE and compute both the hype
 * and risk reads from the same posts — deliberately a single X API call
 * (the metered endpoint, ADR 0007) feeding both scorers, never two. The
 * worker persists each as its own `signals` row (kind hype / risk).
 */
export async function scanProjectSignals(input: ScanMentionsInput): Promise<ScanSignalsResult> {
  const { tweets, newestId } = await input.client.searchRecentMentions(input.query, input.sinceId);
  const hype = computeHypeSignal({
    currentWindowMentions: tweets.length,
    baselineAvgMentions: input.baselineAvgMentions,
    samples: tweets.map(toSample),
  });
  const risk = computeRiskSignal({ samples: tweets.map((t) => ({ text: t.text })) });
  return { hype, risk, tweetCount: tweets.length, newestId };
}
