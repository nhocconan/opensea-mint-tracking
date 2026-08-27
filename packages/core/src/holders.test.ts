import { describe, expect, it } from "vitest";
import {
  computeHolderConcentration,
  deriveHolderConcentration,
  holderConcentrationSeverity,
} from "./holders.ts";

describe("computeHolderConcentration", () => {
  it("returns all-zero for no mints", () => {
    const result = computeHolderConcentration([]);
    expect(result.totalMinted).toBe(0);
    expect(result.uniqueHolders).toBe(0);
    expect(result.topHolders).toEqual([]);
    expect(result.top5SharePct).toBe(0);
    expect(result.top10SharePct).toBe(0);
  });

  it("computes a healthy, broadly-distributed mint (low concentration)", () => {
    // 20 wallets, 5 each = 100 total, perfectly even — top5 should be 25%.
    const rows = Array.from({ length: 20 }, (_, i) => ({ recipient: `0xw${i}`, quantity: 5 }));
    const result = computeHolderConcentration(rows);
    expect(result.totalMinted).toBe(100);
    expect(result.uniqueHolders).toBe(20);
    expect(result.top5SharePct).toBe(25);
    expect(result.top10SharePct).toBe(50);
  });

  it("flags a whale-dominated mint (high concentration)", () => {
    const rows = [
      { recipient: "0xwhale", quantity: 400 },
      ...Array.from({ length: 30 }, (_, i) => ({ recipient: `0xw${i}`, quantity: 20 })),
    ];
    // total = 400 + 30*20 = 1000; one wallet alone holds 40%.
    const result = computeHolderConcentration(rows);
    expect(result.totalMinted).toBe(1000);
    expect(result.topHolders[0]?.recipient).toBe("0xwhale");
    expect(result.topHolders[0]?.sharePct).toBe(40);
    expect(result.top5SharePct).toBeGreaterThan(40); // whale + 4 more @20 each
  });

  it("returns at most the top 10 holders, sorted descending by quantity", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      recipient: `0xw${i}`,
      quantity: i + 1, // 1..25, so #25 (quantity 25) is the biggest
    }));
    const result = computeHolderConcentration(rows);
    expect(result.topHolders).toHaveLength(10);
    expect(result.topHolders[0]?.quantity).toBe(25);
    expect(result.topHolders[9]?.quantity).toBe(16);
    const quantities = result.topHolders.map((h) => h.quantity);
    expect(quantities).toEqual([...quantities].sort((a, b) => b - a));
  });

  it("handles a single-wallet mint as 100% concentration without dividing by zero", () => {
    const result = computeHolderConcentration([{ recipient: "0xsolo", quantity: 42 }]);
    expect(result.top5SharePct).toBe(100);
    expect(result.top10SharePct).toBe(100);
    expect(result.topHolders[0]?.sharePct).toBe(100);
  });

  it("is a pure function of its input — same input, same output", () => {
    const rows = [
      { recipient: "0xa", quantity: 3 },
      { recipient: "0xb", quantity: 7 },
    ];
    expect(computeHolderConcentration(rows)).toEqual(computeHolderConcentration(rows));
  });
});

describe("deriveHolderConcentration", () => {
  it("matches computeHolderConcentration when the full set has <=10 holders", () => {
    const rows = [
      { recipient: "0xa", quantity: 40 },
      { recipient: "0xb", quantity: 30 },
      { recipient: "0xc", quantity: 30 },
    ];
    const full = computeHolderConcentration(rows);
    const derived = deriveHolderConcentration({
      totalMinted: full.totalMinted,
      uniqueHolders: full.uniqueHolders,
      topHolders: full.topHolders,
    });
    expect(derived).toEqual(full);
  });

  it("uses the stored totalMinted, not the sum of the truncated top-10 list — the bug this guards against", () => {
    // 50 holders total; only the top 10 survive into the stored snapshot.
    // A naive re-sum of just those 10 would treat their sum as the whole
    // supply and wildly overstate every share percentage.
    const allRows = Array.from({ length: 50 }, (_, i) => ({
      recipient: `0xw${i}`,
      quantity: i < 10 ? 20 : 1, // top 10 hold 200 of a 240 total supply
    }));
    const full = computeHolderConcentration(allRows);
    expect(full.totalMinted).toBe(240); // 10*20 + 40*1
    expect(full.uniqueHolders).toBe(50);

    // Simulate what the repository actually persists: only the top 10 rows,
    // plus the true scalars.
    const snapshot = {
      totalMinted: full.totalMinted,
      uniqueHolders: full.uniqueHolders,
      topHolders: full.topHolders.map((h) => ({ recipient: h.recipient, quantity: h.quantity })),
    };
    const derived = deriveHolderConcentration(snapshot);
    expect(derived.totalMinted).toBe(240);
    expect(derived.uniqueHolders).toBe(50);
    // Correct: 200/240 ≈ 83.3%. A buggy re-sum-of-top-10 implementation
    // would report 100% here (200/200) — this is exactly what's wrong.
    expect(derived.top10SharePct).toBeCloseTo(83.3, 1);
    expect(derived.top10SharePct).not.toBe(100);
  });
});

describe("holderConcentrationSeverity", () => {
  it("returns 'none' below the minimum sample size, regardless of share", () => {
    expect(holderConcentrationSeverity(90, 9)).toBe("none");
  });

  it("returns 'none' for a broadly distributed supply", () => {
    expect(holderConcentrationSeverity(15, 1000)).toBe("none");
  });

  it("returns 'watch' at the 25% top-10-share threshold", () => {
    expect(holderConcentrationSeverity(25, 1000)).toBe("watch");
  });

  it("returns 'high' at the 50% top-10-share threshold", () => {
    expect(holderConcentrationSeverity(50, 1000)).toBe("high");
  });
});
