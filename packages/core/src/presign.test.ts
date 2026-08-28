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

  it("applies the clock offset (chain ahead of local → earlier local window)", () => {
    // chain-now = local-now + 10s, so local start is 10s earlier than chain start.
    const d = decidePresign({ ...base, clockOffsetMs: 10_000, localNowMs: 1_000_000 - 50_000 });
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
  it("does not classify unrelated failures as stale", () => {
    expect(isStalePresignError("insufficient funds for gas * price + value")).toBe(false);
    expect(isStalePresignError("execution reverted: stage not active")).toBe(false);
  });
});
