import { afterEach, describe, expect, it } from "vitest";
import {
  acquire,
  penalize,
  pickKey,
  refill,
  resetRateLimiterForTests,
  waitMsForToken,
} from "./rate-limiter.ts";

afterEach(() => resetRateLimiterForTests());

describe("token bucket timing (pure)", () => {
  it("refills proportionally to elapsed time and caps at capacity", () => {
    const bucket = {
      tokens: 0,
      capacity: 60,
      refillPerMs: 60 / 60_000,
      lastRefillMs: 0,
      waiters: 0,
    };
    refill(bucket, 30_000);
    expect(bucket.tokens).toBeCloseTo(30, 5);
    refill(bucket, 10 * 60_000);
    expect(bucket.tokens).toBe(60);
  });

  it("reports zero wait when a token is available and the exact wait otherwise", () => {
    const bucket = {
      tokens: 1,
      capacity: 60,
      refillPerMs: 60 / 60_000,
      lastRefillMs: 0,
      waiters: 0,
    };
    expect(waitMsForToken(bucket, 0)).toBe(0);
    bucket.tokens = 0;
    // 1 token/second at 60/min → ~1000ms for one token.
    expect(waitMsForToken(bucket, 0)).toBe(1000);
  });
});

describe("pickKey", () => {
  it("balances across keys by picking the one with the most tokens", async () => {
    await acquire("k1", 60);
    await acquire("k1", 60);
    expect(pickKey(["k1", "k2"], 60)).toBe("k2");
  });

  it("returns the only key when given one", () => {
    expect(pickKey(["solo"], 60)).toBe("solo");
  });
});

describe("acquire + penalize", () => {
  it("consumes one token per acquire without waiting while budget remains", async () => {
    const start = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await acquire("fast", 600);
    }
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("penalize pushes the bucket negative so the next acquire must wait", () => {
    penalize("p", 2, 60);
    const bucket = {
      tokens: -2,
      capacity: 60,
      refillPerMs: 60 / 60_000,
      lastRefillMs: Date.now(),
      waiters: 0,
    };
    expect(waitMsForToken(bucket, Date.now())).toBeGreaterThan(1500);
  });
});
