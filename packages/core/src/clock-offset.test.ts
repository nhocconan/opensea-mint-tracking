import { describe, expect, it } from "vitest";
import { computeClockOffsetMs, toChainTimeMs } from "./clock-offset.ts";

describe("computeClockOffsetMs", () => {
  it("returns 0 when local and chain clocks agree exactly", () => {
    const chainSec = 1_755_800_000;
    expect(computeClockOffsetMs(chainSec * 1000, chainSec)).toBe(0);
  });

  it("returns a positive offset when the local clock is ahead of chain time", () => {
    const chainSec = 1_755_800_000;
    const localMs = chainSec * 1000 + 750; // local thinks it's 750ms later
    expect(computeClockOffsetMs(localMs, chainSec)).toBe(750);
  });

  it("returns a negative offset when the local clock is behind chain time", () => {
    const chainSec = 1_755_800_000;
    const localMs = chainSec * 1000 - 300;
    expect(computeClockOffsetMs(localMs, chainSec)).toBe(-300);
  });
});

describe("toChainTimeMs", () => {
  it("round-trips with computeClockOffsetMs: applying the offset back recovers the original chain estimate", () => {
    const chainSec = 1_755_800_000;
    const localMs = chainSec * 1000 + 500;
    const offset = computeClockOffsetMs(localMs, chainSec);
    expect(toChainTimeMs(localMs, offset)).toBe(chainSec * 1000);
  });

  it("is a no-op with a zero offset", () => {
    expect(toChainTimeMs(1_755_800_000_000, 0)).toBe(1_755_800_000_000);
  });
});
