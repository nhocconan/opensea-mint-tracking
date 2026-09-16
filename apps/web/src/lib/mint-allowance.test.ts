import { describe, expect, it } from "vitest";
import { describeAllowance, remainingAllowance } from "./mint-allowance.ts";

describe("remainingAllowance (cumulative per-wallet cap)", () => {
  it("measures the request against what is LEFT, not the raw cap", () => {
    // The live case: 1 already taken on the GTD phase, FCFS shows max 2.
    const allowance = remainingAllowance({ maxPerWallet: 2, alreadyMinted: 1, requested: 1 });
    expect(allowance).toMatchObject({
      remaining: 1,
      effective: 1,
      clamped: false,
      exhausted: false,
    });
  });

  it("clamps an over-request down to the remainder instead of refusing", () => {
    const allowance = remainingAllowance({ maxPerWallet: 3, alreadyMinted: 1, requested: 3 });
    expect(allowance.remaining).toBe(2);
    expect(allowance.effective).toBe(2);
    expect(allowance.clamped).toBe(true);
    expect(allowance.exhausted).toBe(false);
  });

  it("marks a wallet with nothing left as exhausted", () => {
    const allowance = remainingAllowance({ maxPerWallet: 2, alreadyMinted: 2, requested: 1 });
    expect(allowance.remaining).toBe(0);
    expect(allowance.effective).toBe(0);
    expect(allowance.exhausted).toBe(true);
  });

  it("never returns a negative remainder when the wallet somehow over-minted", () => {
    const allowance = remainingAllowance({ maxPerWallet: 2, alreadyMinted: 5, requested: 2 });
    expect(allowance.remaining).toBe(0);
    expect(allowance.effective).toBe(0);
    expect(allowance.exhausted).toBe(true);
  });

  it("invents no cap when max_per_wallet is null or unknown", () => {
    for (const maxPerWallet of [null, undefined, 0, Number.NaN]) {
      const allowance = remainingAllowance({ maxPerWallet, alreadyMinted: 4, requested: 7 });
      expect(allowance.capKnown).toBe(false);
      expect(allowance.remaining).toBeNull();
      expect(allowance.effective).toBe(7);
      expect(allowance.clamped).toBe(false);
      expect(allowance.exhausted).toBe(false);
    }
  });

  it("treats a missing already-minted count as zero, not as unknown", () => {
    const allowance = remainingAllowance({ maxPerWallet: 2, alreadyMinted: null, requested: 5 });
    expect(allowance.alreadyMinted).toBe(0);
    expect(allowance.remaining).toBe(2);
    expect(allowance.effective).toBe(2);
  });

  it("floors fractional input and never goes below a quantity of 1 requested", () => {
    const allowance = remainingAllowance({ maxPerWallet: 5, alreadyMinted: 1.9, requested: 2.7 });
    expect(allowance.alreadyMinted).toBe(1);
    expect(allowance.requested).toBe(2);
    expect(allowance.effective).toBe(2);
    expect(remainingAllowance({ maxPerWallet: 5, alreadyMinted: 0, requested: 0 }).requested).toBe(
      1,
    );
  });
});

describe("describeAllowance", () => {
  it("states requested / already minted / remaining / what was done", () => {
    const allowance = remainingAllowance({ maxPerWallet: 3, alreadyMinted: 1, requested: 3 });
    expect(describeAllowance(allowance, "armed")).toBe(
      "3 requested, 1 already minted on this drop (cap 3 per wallet, cumulative across every phase), 2 remaining — armed 2.",
    );
  });

  it("says why an exhausted wallet is refused", () => {
    const allowance = remainingAllowance({ maxPerWallet: 2, alreadyMinted: 2, requested: 1 });
    expect(describeAllowance(allowance, "armed")).toContain("0 remaining");
  });

  it("says plainly that an unknown cap clamped nothing", () => {
    const allowance = remainingAllowance({ maxPerWallet: null, alreadyMinted: 0, requested: 2 });
    expect(describeAllowance(allowance, "armed")).toContain("no per-wallet cap");
  });
});
