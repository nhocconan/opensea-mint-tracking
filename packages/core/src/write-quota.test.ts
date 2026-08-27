import { describe, expect, it } from "vitest";
import {
  currentWriteQuotaWindow,
  recordWriteQuotaCall,
  shouldAttemptSpeculativeWrite,
} from "./write-quota.ts";

describe("currentWriteQuotaWindow", () => {
  it("starts a fresh window when nothing is stored yet", () => {
    const now = 1_000_000;
    expect(currentWriteQuotaWindow(undefined, now)).toEqual({ windowStartMs: now, count: 0 });
  });

  it("keeps the existing window when still inside the hour", () => {
    const stored = { windowStartMs: 0, count: 12 };
    const result = currentWriteQuotaWindow(stored, 30 * 60 * 1000); // 30 min later
    expect(result).toEqual(stored);
  });

  it("rolls to a fresh window once a full hour has elapsed", () => {
    const stored = { windowStartMs: 0, count: 29 };
    const result = currentWriteQuotaWindow(stored, 60 * 60 * 1000); // exactly 1h later
    expect(result).toEqual({ windowStartMs: 60 * 60 * 1000, count: 0 });
  });
});

describe("shouldAttemptSpeculativeWrite", () => {
  it("allows a speculative call well under the cap", () => {
    expect(shouldAttemptSpeculativeWrite({ windowStartMs: 0, count: 5 }, 30)).toBe(true);
  });

  it("blocks once the 80% cap (default) is reached, leaving headroom for the real build", () => {
    // floor(30 * 0.8) = 24
    expect(shouldAttemptSpeculativeWrite({ windowStartMs: 0, count: 24 }, 30)).toBe(false);
    expect(shouldAttemptSpeculativeWrite({ windowStartMs: 0, count: 23 }, 30)).toBe(true);
  });

  it("respects a custom cap fraction", () => {
    expect(shouldAttemptSpeculativeWrite({ windowStartMs: 0, count: 14 }, 30, 0.5)).toBe(true);
    expect(shouldAttemptSpeculativeWrite({ windowStartMs: 0, count: 15 }, 30, 0.5)).toBe(false);
  });
});

describe("recordWriteQuotaCall", () => {
  it("increments the count without touching windowStartMs", () => {
    const window = { windowStartMs: 500, count: 3 };
    expect(recordWriteQuotaCall(window)).toEqual({ windowStartMs: 500, count: 4 });
  });

  it("real-build call volume is never gated by shouldAttemptSpeculativeWrite — there is no function combining them", () => {
    // Documents the intentional design: recordWriteQuotaCall has no
    // "isSpeculative" branch or guard parameter. A caller for the real,
    // due-to-fire build simply never calls shouldAttemptSpeculativeWrite
    // at all — it always proceeds and only records afterward.
    const afterManySpeculativeBlocks = { windowStartMs: 0, count: 24 };
    expect(shouldAttemptSpeculativeWrite(afterManySpeculativeBlocks, 30)).toBe(false);
    expect(recordWriteQuotaCall(afterManySpeculativeBlocks)).toEqual({
      windowStartMs: 0,
      count: 25,
    });
  });
});
