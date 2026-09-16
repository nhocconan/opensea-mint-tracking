import { describe, expect, it } from "vitest";
import { decidePresign, isStalePresignError } from "./presign.ts";

const base = {
  stageStartChainMs: 1_000_000,
  clockOffsetMs: 0,
  leadMs: 45_000,
  ttlMs: 90_000,
  continueForMs: 4_000,
  presignedAtMs: null,
  presignedNonce: null,
} as const;

describe("decidePresign", () => {
  it("waits until the lead window opens", () => {
    const d = decidePresign({ ...base, localNowMs: 1_000_000 - 60_000 });
    expect(d).toEqual({ action: "wait", msUntilWindow: 15_000 });
  });

  it("signs when inside the window with no blob", () => {
    const d = decidePresign({ ...base, localNowMs: 1_000_000 - 40_000 });
    expect(d).toEqual({ action: "sign", reason: "none" });
  });

  it("keeps a fresh blob whose nonce still matches", () => {
    const d = decidePresign({
      ...base,
      localNowMs: 1_000_000 - 30_000,
      presignedAtMs: 1_000_000 - 40_000,
      presignedNonce: 7,
      currentNonce: 7,
    });
    expect(d).toEqual({ action: "keep" });
  });

  it("re-signs when the wallet's pending nonce advanced", () => {
    const d = decidePresign({
      ...base,
      localNowMs: 1_000_000 - 30_000,
      presignedAtMs: 1_000_000 - 40_000,
      presignedNonce: 7,
      currentNonce: 8,
    });
    expect(d).toEqual({ action: "sign", reason: "nonce_advanced" });
  });

  it("re-signs a stale blob past ttl", () => {
    const d = decidePresign({
      ...base,
      localNowMs: 1_000_000 - 1_000,
      presignedAtMs: 1_000_000 - 100_000,
      presignedNonce: 7,
      currentNonce: 7,
    });
    expect(d).toEqual({ action: "sign", reason: "stale" });
  });

  // clock-offset.ts convention: offset = local − chain ⇒ local = chain + offset
  // (identical to fire-schedule.ts's chainTimeToLocalMs). Each case below is
  // chosen to land on the opposite side of the window from the old, inverted
  // `stageStartChainMs - clockOffsetMs` implementation.
  it("local clock ahead of chain (+10s) pushes the local window later", () => {
    // local start = 1_000_000 + 10_000 = 1_010_000; window opens at 965_000.
    // Old inverted impl put the window at 945_000 and would have said "sign".
    const d = decidePresign({ ...base, clockOffsetMs: 10_000, localNowMs: 950_000 });
    expect(d).toEqual({ action: "wait", msUntilWindow: 15_000 });
  });

  it("local clock behind chain (−10s) pulls the local window earlier", () => {
    // local start = 1_000_000 − 10_000 = 990_000; window opens at 945_000.
    // Old inverted impl put the window at 965_000 and would have said "wait".
    const d = decidePresign({ ...base, clockOffsetMs: -10_000, localNowMs: 950_000 });
    expect(d).toEqual({ action: "sign", reason: "none" });
  });

  it("does not expire before the clock-corrected open (+10s offset)", () => {
    // local start 1_010_000, continue window to 1_014_000 — still signable.
    // Old inverted impl expired at 994_000, i.e. before the fire window opened.
    const d = decidePresign({ ...base, clockOffsetMs: 10_000, localNowMs: 1_012_000 });
    expect(d).toEqual({ action: "sign", reason: "none" });
  });

  it("expires after open + continue window", () => {
    const d = decidePresign({ ...base, localNowMs: 1_000_000 + 5_000 });
    expect(d).toEqual({ action: "expired" });
  });
});

describe("isStalePresignError", () => {
  it("classifies nonce/replacement rejections as stale", () => {
    for (const m of [
      "nonce too low: next nonce 9, tx nonce 8",
      "replacement transaction underpriced",
      "already known",
      "invalid nonce; got 8, expected 9",
    ]) {
      expect(isStalePresignError(m)).toBe(true);
    }
  });
  it("classifies fee-too-low rejections as stale (re-sign, not hard fail)", () => {
    for (const m of [
      "max fee per gas less than block base fee: address 0xabc, maxFeePerGas: 1000000, baseFee: 2500000",
      "err: fee cap less than block base fee",
      "The fee cap (`maxFeePerGas` = 0.001 gwei) cannot be lower than the block base fee.",
      "transaction underpriced",
    ]) {
      expect(isStalePresignError(m)).toBe(true);
    }
  });
  it("does not classify unrelated failures as stale", () => {
    expect(isStalePresignError("insufficient funds for gas * price + value")).toBe(false);
    expect(isStalePresignError("execution reverted: stage not active")).toBe(false);
  });
});
