import { describe, expect, it } from "vitest";
import { mintConcentrationSeverity } from "./concentration.ts";

describe("mintConcentrationSeverity", () => {
  it("returns 'none' below the minimum sample size, regardless of ratio", () => {
    expect(mintConcentrationSeverity(9, 1)).toBe("none");
  });

  it("returns 'none' for a healthy, broadly-distributed mint", () => {
    expect(mintConcentrationSeverity(100, 90)).toBe("none");
  });

  it("returns 'watch' at the 3x-per-wallet threshold", () => {
    expect(mintConcentrationSeverity(30, 10)).toBe("watch");
  });

  it("returns 'high' at the 5x-per-wallet threshold", () => {
    expect(mintConcentrationSeverity(50, 10)).toBe("high");
  });

  it("returns 'none' when there is no recipient data (0 or negative)", () => {
    expect(mintConcentrationSeverity(100, 0)).toBe("none");
  });

  it("is a pure function of its two inputs — same inputs, same output", () => {
    expect(mintConcentrationSeverity(40, 8)).toBe(mintConcentrationSeverity(40, 8));
  });
});
