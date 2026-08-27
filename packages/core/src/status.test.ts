import { describe, expect, it } from "vitest";
import type { StageView } from "./stages.ts";
import { computeLifecycle, mintedPercentage, remainingSupply, type SupplyFacts } from "./status.ts";

const NOW = "2026-08-16T12:00:00.000Z";

function stage(overrides: Partial<StageView> = {}): StageView {
  return {
    label: "Public",
    kind: "public",
    startsAt: "2026-08-16T11:00:00.000Z",
    endsAt: "2026-08-16T13:00:00.000Z",
    paused: false,
    ...overrides,
  };
}

const UNKNOWN_SUPPLY: SupplyFacts = { minted: null, maxSupply: null, verified: false };
const VERIFIED_OPEN: SupplyFacts = { minted: 10n, maxSupply: 100n, verified: true };
const VERIFIED_FULL: SupplyFacts = { minted: 100n, maxSupply: 100n, verified: true };

describe("computeLifecycle", () => {
  it("LIVE when a stage is within [start, end) and not paused", () => {
    expect(
      computeLifecycle({ stages: [stage()], isoNow: NOW, paused: null, supply: UNKNOWN_SUPPLY }),
    ).toBe("LIVE");
  });

  it("LIVE when start == now (half-open boundary inclusive start)", () => {
    expect(
      computeLifecycle({
        stages: [stage({ startsAt: NOW })],
        isoNow: NOW,
        paused: null,
        supply: UNKNOWN_SUPPLY,
      }),
    ).toBe("LIVE");
  });

  it("not LIVE when now == end (exclusive end)", () => {
    expect(
      computeLifecycle({
        stages: [stage({ endsAt: NOW })],
        isoNow: NOW,
        paused: null,
        supply: UNKNOWN_SUPPLY,
      }),
    ).toBe("ENDED");
  });

  it("unknown supply does not block LIVE (PRD §6)", () => {
    expect(
      computeLifecycle({
        stages: [stage()],
        isoNow: NOW,
        paused: null,
        supply: { minted: null, maxSupply: null, verified: true },
      }),
    ).toBe("LIVE");
  });

  it("SOLD_OUT only when both minted and max are verified and remaining is zero", () => {
    expect(
      computeLifecycle({ stages: [stage()], isoNow: NOW, paused: null, supply: VERIFIED_FULL }),
    ).toBe("SOLD_OUT");
    // Unverified full supply must never claim SOLD_OUT.
    expect(
      computeLifecycle({
        stages: [stage()],
        isoNow: NOW,
        paused: null,
        supply: { minted: 100n, maxSupply: 100n, verified: false },
      }),
    ).toBe("LIVE");
  });

  it("NEXT when no live stage but a future stage exists", () => {
    expect(
      computeLifecycle({
        stages: [
          stage({ startsAt: "2026-08-16T14:00:00.000Z", endsAt: "2026-08-16T15:00:00.000Z" }),
        ],
        isoNow: NOW,
        paused: null,
        supply: UNKNOWN_SUPPLY,
      }),
    ).toBe("NEXT");
  });

  it("ENDED when all known stages ended and not sold out", () => {
    expect(
      computeLifecycle({
        stages: [
          stage({ startsAt: "2026-08-16T09:00:00.000Z", endsAt: "2026-08-16T10:00:00.000Z" }),
        ],
        isoNow: NOW,
        paused: null,
        supply: VERIFIED_OPEN,
      }),
    ).toBe("ENDED");
  });

  it("PAUSED when the authoritative source reports paused during a live window", () => {
    expect(
      computeLifecycle({ stages: [stage()], isoNow: NOW, paused: true, supply: UNKNOWN_SUPPLY }),
    ).toBe("PAUSED");
  });

  it("PAUSED stage flag also pauses without a global flag", () => {
    expect(
      computeLifecycle({
        stages: [stage({ paused: true })],
        isoNow: NOW,
        paused: null,
        supply: UNKNOWN_SUPPLY,
      }),
    ).toBe("PAUSED");
  });

  it("UNKNOWN with no stages and no explicit pause", () => {
    expect(
      computeLifecycle({ stages: [], isoNow: NOW, paused: null, supply: UNKNOWN_SUPPLY }),
    ).toBe("UNKNOWN");
  });

  it("UNKNOWN when a stage has no end and has not started (indeterminate)", () => {
    expect(
      computeLifecycle({
        stages: [stage({ startsAt: "2026-08-16T09:00:00.000Z", endsAt: null })],
        isoNow: NOW,
        paused: null,
        supply: UNKNOWN_SUPPLY,
      }),
    ).toBe("LIVE");
  });

  it("prefers SOLD_OUT over NEXT when a future stage exists but supply is verified full", () => {
    expect(
      computeLifecycle({
        stages: [
          stage({ startsAt: "2026-08-16T14:00:00.000Z", endsAt: "2026-08-16T15:00:00.000Z" }),
        ],
        isoNow: NOW,
        paused: null,
        supply: VERIFIED_FULL,
      }),
    ).toBe("SOLD_OUT");
  });
});

describe("supply math", () => {
  it("remainingSupply requires verified both sides", () => {
    expect(remainingSupply(VERIFIED_OPEN)).toEqual({ known: true, remaining: 90n });
    expect(remainingSupply(UNKNOWN_SUPPLY).known).toBe(false);
    expect(remainingSupply({ minted: 10n, maxSupply: 100n, verified: false }).known).toBe(false);
  });

  it("mintedPercentage floors to basis points and nulls on missing data", () => {
    expect(mintedPercentage(VERIFIED_OPEN)).toBe(10);
    expect(mintedPercentage({ minted: 1n, maxSupply: 3n, verified: true })).toBe(33.33);
    expect(mintedPercentage({ minted: 10n, maxSupply: 0n, verified: true })).toBeNull();
    expect(mintedPercentage(UNKNOWN_SUPPLY)).toBeNull();
  });
});
