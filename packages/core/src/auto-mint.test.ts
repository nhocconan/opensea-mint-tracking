import { describe, expect, it } from "vitest";
import { type AutoMintCandidate, decideAutoMint, parseAutoMintPolicy } from "./auto-mint.ts";

const NOW = 1_000_000_000;
const policy = parseAutoMintPolicy({ enabled: true, walletIds: [], ownerUserId: "u1" });

describe("parseAutoMintPolicy", () => {
  it("defaults + clamps malformed input and never throws", () => {
    const p = parseAutoMintPolicy({
      maxRiskScore: 999,
      quantity: "3",
      walletIds: ["nope", "01a04741-6889-7e7f-91c6-6b8314f3b774"],
      maxPriceWei: "abc",
    });
    expect(p.enabled).toBe(false);
    expect(p.maxRiskScore).toBe(100);
    expect(p.quantity).toBe(3);
    expect(p.walletIds).toEqual(["01a04741-6889-7e7f-91c6-6b8314f3b774"]);
    expect(p.maxPriceWei).toBe("0");
    expect(parseAutoMintPolicy(null).requireCuratedListing).toBe(true);
  });
});
const base: AutoMintCandidate = {
  projectId: "p1",
  projectName: "Free Frogs",
  stageId: "s1",
  stageKind: "public",
  priceWei: "0",
  startsAtMs: NOW + 60_000,
  endsAtMs: NOW + 3_600_000,
  paused: false,
  riskScore: null,
  hypeScore: null,
  curated: true,
  uniqueMinters1h: 0,
};

describe("decideAutoMint", () => {
  it("plans a free public stage with the OpenSea fee allowance as ceiling and arms until stage end", () => {
    const d = decideAutoMint(policy, base, NOW);
    expect(d).toEqual({ plan: true, ceilingWei: "100000000000000", armMinutes: 60 });
  });

  it("refuses when the policy is disabled", () => {
    expect(decideAutoMint({ ...policy, enabled: false }, base, NOW).plan).toBe(false);
  });

  it("refuses paid stages when maxPriceWei is 0 (free only)", () => {
    const d = decideAutoMint(policy, { ...base, priceWei: "1000000000000000" }, NOW);
    expect(d.plan).toBe(false);
  });

  it("allows a paid stage under the configured max and uses the price as ceiling", () => {
    const p = { ...policy, maxPriceWei: "2000000000000000" };
    const d = decideAutoMint(p, { ...base, priceWei: "1000000000000000" }, NOW);
    expect(d).toEqual({ plan: true, ceilingWei: "1100000000000000", armMinutes: 60 });
  });

  it("refuses non-public stages in publicOnly mode, allows them otherwise", () => {
    expect(decideAutoMint(policy, { ...base, stageKind: "allowlist" }, NOW).plan).toBe(false);
    expect(
      decideAutoMint({ ...policy, publicOnly: false }, { ...base, stageKind: "allowlist" }, NOW)
        .plan,
    ).toBe(true);
  });

  it("gates on the Grok risk score", () => {
    expect(decideAutoMint(policy, { ...base, riskScore: 85 }, NOW).plan).toBe(false);
    expect(decideAutoMint(policy, { ...base, riskScore: 10 }, NOW).plan).toBe(true);
  });

  it("strict mode skips drops with no risk signal yet", () => {
    const strict = { ...policy, requireRiskSignal: true };
    expect(decideAutoMint(strict, base, NOW).plan).toBe(false);
    expect(decideAutoMint(strict, { ...base, riskScore: 5 }, NOW).plan).toBe(true);
  });

  it("skips paused, ended, and beyond-lookahead stages", () => {
    expect(decideAutoMint(policy, { ...base, paused: true }, NOW).plan).toBe(false);
    expect(decideAutoMint(policy, { ...base, endsAtMs: NOW - 1 }, NOW).plan).toBe(false);
    expect(decideAutoMint(policy, { ...base, startsAtMs: NOW + 48 * 3_600_000 }, NOW).plan).toBe(
      false,
    );
  });

  it("quality gates: curated listing, hype floor, live demand", () => {
    expect(decideAutoMint(policy, { ...base, curated: false }, NOW).plan).toBe(false);
    expect(
      decideAutoMint({ ...policy, requireCuratedListing: false }, { ...base, curated: false }, NOW)
        .plan,
    ).toBe(true);
    const hype = { ...policy, minHypeScore: 30 };
    expect(decideAutoMint(hype, { ...base, hypeScore: 10 }, NOW).plan).toBe(false);
    expect(decideAutoMint(hype, { ...base, hypeScore: 50 }, NOW).plan).toBe(true);
    // no hype signal is NOT blocked by the hype floor
    expect(decideAutoMint(hype, { ...base, hypeScore: null }, NOW).plan).toBe(true);
    const demand = { ...policy, minUniqueMintersLive: 25 };
    // Open 30 min: past the demand grace window, so demand gates apply.
    const live = { ...base, startsAtMs: NOW - 30 * 60_000 };
    // Open 1 min with nobody yet: that is the moment to fire, not a dead drop.
    expect(decideAutoMint(demand, { ...base, startsAtMs: NOW - 60_000 }, NOW).plan).toBe(true);
    // Open 5 hours, 0 minters in the last hour: dead drop even with no min set.
    expect(
      decideAutoMint(
        { ...demand, minUniqueMintersLive: 0 },
        { ...base, startsAtMs: NOW - 5 * 3_600_000, uniqueMinters1h: 0 },
        NOW,
      ),
    ).toMatchObject({ plan: false, reason: expect.stringContaining("dead drop") });
    expect(decideAutoMint(demand, { ...live, uniqueMinters1h: 3 }, NOW).plan).toBe(false);
    expect(decideAutoMint(demand, { ...live, uniqueMinters1h: 40 }, NOW).plan).toBe(true);
    // demand gate only applies once live
    expect(decideAutoMint(demand, { ...base, uniqueMinters1h: 0 }, NOW).plan).toBe(true);
  });

  it("caps the arm window at 24h when a stage has no end", () => {
    const d = decideAutoMint(policy, { ...base, endsAtMs: null }, NOW);
    expect(d).toEqual({ plan: true, ceilingWei: "100000000000000", armMinutes: 24 * 60 });
  });
});
