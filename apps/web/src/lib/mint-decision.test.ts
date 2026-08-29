import type { FeedRow } from "@hoodmint/db";
import { describe, expect, it } from "vitest";
import { decisionStage } from "./mint-presentation.ts";

const NOW = new Date("2026-08-29T12:00:00.000Z");

function row(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    chainId: 4663,
    contractAddress: null,
    name: "Test mint",
    slug: "test-mint",
    imageUrl: null,
    twitterUsername: null,
    projectUrl: null,
    discordUrl: null,
    safelistStatus: null,
    confidence: "verified",
    lifecycleStatus: "NEXT",
    nextStageStart: new Date("2026-08-30T12:00:00.000Z"),
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    minted: null,
    maxSupply: null,
    supplyVerified: false,
    velocity1h: 0,
    uniqueMinters1h: 0,
    stageId: null,
    stageLabel: null,
    stageKind: null,
    stagePriceWei: null,
    stageMaxPerWallet: null,
    stageStartsAt: null,
    stageEndsAt: null,
    nextStageId: "00000000-0000-4000-8000-000000000002",
    nextStageLabel: "Allowlist",
    nextStageKind: "allowlist",
    nextStagePriceWei: "10000000000000000",
    nextStageMaxPerWallet: 2,
    nextStageEndsAt: new Date("2026-08-30T13:00:00.000Z"),
    ...overrides,
  };
}

describe("decisionStage", () => {
  it("shows the complete next phase before mint opens", () => {
    expect(decisionStage(row())).toMatchObject({
      timing: "next",
      label: "Allowlist",
      kind: "allowlist",
      priceWei: "10000000000000000",
      maxPerWallet: 2,
    });
  });

  it("does not mix the next price into a live phase", () => {
    expect(
      decisionStage(
        row({
          stageId: "00000000-0000-4000-8000-000000000003",
          stageLabel: "Public",
          stageKind: "public",
          stagePriceWei: "0",
          stageMaxPerWallet: 5,
          stageStartsAt: new Date("2026-08-29T11:00:00.000Z"),
        }),
      ),
    ).toMatchObject({ timing: "live", label: "Public", priceWei: "0", maxPerWallet: 5 });
  });
});
