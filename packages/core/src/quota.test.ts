import { describe, expect, it } from "vitest";
import {
  allowedRequests,
  discoveryBaseReads,
  estimatedHourlyReads,
  parseRateLimitHeaders,
} from "./quota.ts";

describe("allowedRequests", () => {
  it("blocks when remaining hits the configured reserve", () => {
    const decision = allowedRequests({
      limitPerHour: 600,
      remaining: 59,
      resetAtEpochSeconds: null,
      reservePercent: 10,
    });
    expect(decision.blocked).toBe(true);
    expect(decision.allowed).toBe(0);
    expect(decision.reason).toBe("reserve-reached");
  });

  it("allows spend above the reserve", () => {
    const decision = allowedRequests({
      limitPerHour: 600,
      remaining: 120,
      resetAtEpochSeconds: null,
      reservePercent: 10,
    });
    expect(decision.blocked).toBe(false);
    expect(decision.allowed).toBe(120);
  });

  it("unknown remaining falls back to a per-window budget instead of unlimited", () => {
    const decision = allowedRequests({
      limitPerHour: 600,
      remaining: null,
      resetAtEpochSeconds: null,
      reservePercent: 10,
    });
    expect(decision.blocked).toBe(false);
    // 600 × 0.9 per hour → 15/min-equivalent windows sized by default 3600s.
    expect(decision.allowed).toBe(540);
    expect(decision.reason).toBe("unknown-remaining-assume-budget");
  });

  it("caps a 300s discovery window to its share of the hour", () => {
    const decision = allowedRequests(
      { limitPerHour: 600, remaining: 590, resetAtEpochSeconds: null, reservePercent: 10 },
      { windowSeconds: 300 },
    );
    expect(decision.allowed).toBe(45);
  });

  it("treats zero remaining as blocked", () => {
    expect(
      allowedRequests({
        limitPerHour: 600,
        remaining: 0,
        resetAtEpochSeconds: null,
        reservePercent: 10,
      }).blocked,
    ).toBe(true);
  });
});

describe("PRD §12 quota table parity", () => {
  it("base discovery reads equal feed types before pagination", () => {
    expect(discoveryBaseReads(["featured", "upcoming", "recently_minted"])).toBe(3);
  });

  it("5m interval with 20 candidates stays inside the free tier", () => {
    const reads = estimatedHourlyReads({ intervalSeconds: 300, eligibilityCandidates: 20 });
    expect(reads).toBe(276);
    expect(reads).toBeLessThan(600);
  });

  it("5m discovery-only uses 36 reads/hour", () => {
    expect(estimatedHourlyReads({ intervalSeconds: 300, eligibilityCandidates: 0 })).toBe(36);
  });
});

describe("parseRateLimitHeaders", () => {
  it("reads standard X-RateLimit headers", () => {
    const parsed = parseRateLimitHeaders({
      "x-ratelimit-remaining": "123",
      "x-ratelimit-limit": "600",
      "x-ratelimit-reset": "1799999999",
    });
    expect(parsed).toEqual({ remaining: 123, limit: 600, resetAtEpochSeconds: 1799999999 });
  });

  it("handles duration-style reset-after values", () => {
    const before = Math.floor(Date.now() / 1000);
    const parsed = parseRateLimitHeaders({ "x-ratelimit-reset-after": "42s" });
    expect(parsed.resetAtEpochSeconds).toBeGreaterThanOrEqual(before + 42);
    expect(parsed.remaining).toBeNull();
  });

  it("returns nulls for garbage and missing values", () => {
    const parsed = parseRateLimitHeaders({ "x-ratelimit-remaining": "soon" });
    expect(parsed.remaining).toBeNull();
    expect(parseRateLimitHeaders({})).toEqual({
      remaining: null,
      limit: null,
      resetAtEpochSeconds: null,
    });
  });
});
