import { describe, expect, it } from "vitest";
import { computeRarityScores } from "./rarity.ts";

describe("computeRarityScores", () => {
  it("returns an empty array for no tokens", () => {
    expect(computeRarityScores([])).toEqual([]);
  });

  it("ranks a single unique trait value as rarest — hand-verified example", () => {
    // 4 tokens, one trait type: 3x "Background: A", 1x "Background: B".
    // Rarity Score for a value = total / count-with-that-value.
    // A: 4/3 ≈ 1.3333, B: 4/1 = 4 — token 4 (the lone B) must rank #1.
    const tokens = [
      { tokenId: "1", traits: [{ traitType: "Background", value: "A" }] },
      { tokenId: "2", traits: [{ traitType: "Background", value: "A" }] },
      { tokenId: "3", traits: [{ traitType: "Background", value: "A" }] },
      { tokenId: "4", traits: [{ traitType: "Background", value: "B" }] },
    ];
    const ranked = computeRarityScores(tokens);
    expect(ranked[0]?.tokenId).toBe("4");
    expect(ranked[0]?.rank).toBe(1);
    expect(ranked[0]?.rarityScore).toBeCloseTo(4, 5);
    // The three "A" tokens are exactly tied — stable sort preserves their
    // original relative order among the tie.
    expect(ranked.slice(1).map((t) => t.tokenId)).toEqual(["1", "2", "3"]);
    for (const t of ranked.slice(1)) {
      expect(t.rarityScore).toBeCloseTo(4 / 3, 5);
    }
    expect(ranked.map((t) => t.rank)).toEqual([1, 2, 3, 4]);
  });

  it("sums scores across multiple trait types on the same token — hand-verified example", () => {
    // 3 tokens, one trait type, asymmetric split: 2x Red, 1x Blue.
    const tokens = [
      { tokenId: "a", traits: [{ traitType: "Bg", value: "Red" }] },
      { tokenId: "b", traits: [{ traitType: "Bg", value: "Red" }] },
      { tokenId: "c", traits: [{ traitType: "Bg", value: "Blue" }] },
    ];
    const ranked = computeRarityScores(tokens);
    // Red: 3/2 = 1.5, Blue: 3/1 = 3.
    expect(ranked[0]?.tokenId).toBe("c");
    expect(ranked[0]?.rarityScore).toBeCloseTo(3, 5);
    expect(ranked[1]?.rarityScore).toBeCloseTo(1.5, 5);
    expect(ranked[2]?.rarityScore).toBeCloseTo(1.5, 5);
  });

  it("adds scores across two independent trait types — symmetric case both tokens tie", () => {
    // Token A: {Bg: Red, Eyes: Blue}; Token B: {Bg: Red, Eyes: Green}.
    // Bg=Red count=2 (both), Eyes=Blue count=1, Eyes=Green count=1.
    // A = 2/2 + 2/1 = 1 + 2 = 3; B = 2/2 + 2/1 = 1 + 2 = 3 — tied by symmetry.
    const tokens = [
      {
        tokenId: "A",
        traits: [
          { traitType: "Bg", value: "Red" },
          { traitType: "Eyes", value: "Blue" },
        ],
      },
      {
        tokenId: "B",
        traits: [
          { traitType: "Bg", value: "Red" },
          { traitType: "Eyes", value: "Green" },
        ],
      },
    ];
    const ranked = computeRarityScores(tokens);
    expect(ranked[0]?.rarityScore).toBeCloseTo(3, 5);
    expect(ranked[1]?.rarityScore).toBeCloseTo(3, 5);
  });

  it("gives a token with no traits a score of 0 (ranks last)", () => {
    const tokens = [
      { tokenId: "rare", traits: [{ traitType: "Bg", value: "Unique" }] },
      { tokenId: "bare", traits: [] },
    ];
    const ranked = computeRarityScores(tokens);
    expect(ranked.find((t) => t.tokenId === "bare")?.rarityScore).toBe(0);
    expect(ranked[ranked.length - 1]?.tokenId).toBe("bare");
  });

  it("assigns contiguous 1-based ranks with no gaps or duplicates", () => {
    const tokens = Array.from({ length: 10 }, (_, i) => ({
      tokenId: `t${i}`,
      traits: [{ traitType: "X", value: `v${i}` }], // every value unique — no ties
    }));
    const ranked = computeRarityScores(tokens);
    expect(ranked.map((t) => t.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("is a pure function — same input, same output", () => {
    const tokens = [
      { tokenId: "x", traits: [{ traitType: "A", value: "1" }] },
      { tokenId: "y", traits: [{ traitType: "A", value: "2" }] },
    ];
    expect(computeRarityScores(tokens)).toEqual(computeRarityScores(tokens));
  });
});
