import { describe, expect, it } from "vitest";
import { computeRiskSignal } from "./risk.ts";

describe("computeRiskSignal", () => {
  it("scores 0 with no red flags", () => {
    const r = computeRiskSignal({
      samples: [
        { text: "Really excited for this drop, art looks clean" },
        { text: "gm, minting my favorite collection today" },
        { text: "floor is holding up nicely" },
        { text: "the roadmap actually makes sense" },
        { text: "good luck everyone on the public" },
      ],
    });
    expect(r.score).toBe(0);
    expect(r.flags).toEqual([]);
    expect(r.flaggedFraction).toBe(0);
  });

  it("flags wallet-draining CTAs and manufactured urgency", () => {
    const r = computeRiskSignal({
      samples: [
        { text: "Claim now before it sells out!! connect wallet here 👉 evil.link" },
        { text: "normal excited post about the mint" },
        { text: "verify wallet to receive your free airdrop" },
        { text: "another normal post" },
        { text: "gas error? sync wallet to fix and claim your spot" },
      ],
    });
    expect(r.score).toBeGreaterThan(0);
    expect(r.flaggedFraction).toBeCloseTo(3 / 5, 5);
    // Distinct flags surfaced for the evidence trail.
    expect(r.flags).toContain("connect wallet");
    expect(r.flags).toContain("free airdrop");
    expect(r.flags).toContain("sync wallet");
  });

  it("does not trip on substrings (claimant ≠ claim now)", () => {
    const r = computeRiskSignal({
      samples: [
        { text: "the claimant list was published yesterday" },
        { text: "disclaimer: not financial advice" },
        { text: "reclaimed some gas today" },
        { text: "wallets are ready" },
        { text: "syncing my thoughts on the art" },
      ],
    });
    expect(r.flags).toEqual([]);
    expect(r.score).toBe(0);
  });

  it("pins high when the mention stream is majority phishing-shaped", () => {
    const phishing = { text: "connect wallet and claim now, mint is live now" };
    const r = computeRiskSignal({ samples: Array.from({ length: 10 }, () => phishing) });
    expect(r.flaggedFraction).toBe(1);
    expect(r.score).toBe(100);
  });

  it("is unverified below the minimum sample size", () => {
    const r = computeRiskSignal({ samples: [{ text: "connect wallet to claim now" }] });
    expect(r.confidence).toBe("unverified");
  });

  it("is single-source at/above the minimum sample size", () => {
    const r = computeRiskSignal({
      samples: Array.from({ length: 5 }, () => ({ text: "just a normal post" })),
    });
    expect(r.confidence).toBe("single-source");
  });

  it("counts a post with multiple flags once toward the fraction, but surfaces both flags", () => {
    const r = computeRiskSignal({
      samples: [
        { text: "connect wallet and claim now right here" },
        { text: "normal" },
        { text: "normal" },
        { text: "normal" },
        { text: "normal" },
      ],
    });
    expect(r.flaggedFraction).toBeCloseTo(1 / 5, 5);
    expect(r.flags).toContain("connect wallet");
    expect(r.flags).toContain("claim now");
  });
});
