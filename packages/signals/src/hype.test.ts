import { describe, expect, it } from "vitest";
import { computeHypeSignal, type MentionSample } from "./hype.ts";

const sample = (overrides: Partial<MentionSample> = {}): MentionSample => ({
  likeCount: 0,
  retweetCount: 0,
  replyCount: 0,
  quoteCount: 0,
  ...overrides,
});

describe("computeHypeSignal", () => {
  it("scores zero with no mentions and no baseline", () => {
    const result = computeHypeSignal({
      currentWindowMentions: 0,
      baselineAvgMentions: 0,
      samples: [],
    });
    expect(result.score).toBe(0);
    expect(result.velocityRatio).toBe(0);
  });

  it("marks low-sample results 'unverified', not a false-confident single-source read", () => {
    const result = computeHypeSignal({
      currentWindowMentions: 3,
      baselineAvgMentions: 1,
      samples: [sample(), sample()],
    });
    expect(result.confidence).toBe("unverified");
  });

  it("marks a real sample size 'single-source'", () => {
    const result = computeHypeSignal({
      currentWindowMentions: 20,
      baselineAvgMentions: 5,
      samples: Array.from({ length: 8 }, () => sample()),
    });
    expect(result.confidence).toBe("single-source");
  });

  it("weights retweets/quotes double relative to likes/replies", () => {
    const retweetHeavy = computeHypeSignal({
      currentWindowMentions: 10,
      baselineAvgMentions: 10,
      samples: [sample({ retweetCount: 10 })],
    });
    const likeHeavy = computeHypeSignal({
      currentWindowMentions: 10,
      baselineAvgMentions: 10,
      samples: [sample({ likeCount: 10 })],
    });
    expect(retweetHeavy.score).toBeGreaterThan(likeHeavy.score);
  });

  it("never exceeds 100 even under an extreme velocity spike and viral engagement", () => {
    const result = computeHypeSignal({
      currentWindowMentions: 100_000,
      baselineAvgMentions: 1,
      samples: Array.from({ length: 20 }, () => sample({ retweetCount: 100_000 })),
    });
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("treats a mention count with zero historical baseline as a fixed high (not infinite) ratio", () => {
    const result = computeHypeSignal({
      currentWindowMentions: 50,
      baselineAvgMentions: 0,
      samples: [],
    });
    expect(Number.isFinite(result.velocityRatio)).toBe(true);
    expect(result.velocityRatio).toBeGreaterThan(0);
  });
});
