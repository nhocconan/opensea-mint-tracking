import { describe, expect, it } from "vitest";
import {
  eligibilityRetryDelayMs,
  freshnessBucket,
  nextEligibilityDueAt,
  SCHEDULE_INTERVALS,
} from "./schedule.ts";
import type { StageView } from "./stages.ts";

const NOW = "2026-08-16T12:00:00.000Z";
const HOUR = 60 * 60 * 1000;

function stage(offsetHours: number, durationHours = 1): StageView {
  const start = new Date(Date.parse(NOW) + offsetHours * HOUR);
  const end = new Date(start.getTime() + durationHours * HOUR);
  return {
    label: "Allowlist",
    kind: "allowlist",
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    paused: false,
  };
}

describe("eligibilityRetryDelayMs", () => {
  it("stops checking ended and sold-out projects", () => {
    expect(
      eligibilityRetryDelayMs({
        stages: [stage(-3)],
        lifecycle: "ENDED",
        isoNow: NOW,
        currentlyEligible: false,
      }),
    ).toBeNull();
    expect(
      eligibilityRetryDelayMs({
        stages: [stage(0)],
        lifecycle: "SOLD_OUT",
        isoNow: NOW,
        currentlyEligible: false,
      }),
    ).toBeNull();
  });

  it("stage more than 24h away → 6h", () => {
    expect(
      eligibilityRetryDelayMs({
        stages: [stage(30)],
        lifecycle: "NEXT",
        isoNow: NOW,
        currentlyEligible: false,
      }),
    ).toBe(SCHEDULE_INTERVALS.far);
  });

  it("stage 1–24h away → 30m", () => {
    expect(
      eligibilityRetryDelayMs({
        stages: [stage(2)],
        lifecycle: "NEXT",
        isoNow: NOW,
        currentlyEligible: false,
      }),
    ).toBe(SCHEDULE_INTERVALS.near);
    expect(
      eligibilityRetryDelayMs({
        stages: [stage(24)],
        lifecycle: "NEXT",
        isoNow: NOW,
        currentlyEligible: false,
      }),
    ).toBe(SCHEDULE_INTERVALS.near);
  });

  it("stage less than 1h away → 5m", () => {
    expect(
      eligibilityRetryDelayMs({
        stages: [stage(0.5)],
        lifecycle: "NEXT",
        isoNow: NOW,
        currentlyEligible: false,
      }),
    ).toBe(SCHEDULE_INTERVALS.imminent);
  });

  it("live and not yet eligible → 5m", () => {
    expect(
      eligibilityRetryDelayMs({
        stages: [stage(0)],
        lifecycle: "LIVE",
        isoNow: NOW,
        currentlyEligible: false,
      }),
    ).toBe(SCHEDULE_INTERVALS.imminent);
  });

  it("live restricted hit → 30m recheck (PRD §7.3)", () => {
    expect(
      eligibilityRetryDelayMs({
        stages: [stage(0)],
        lifecycle: "LIVE",
        isoNow: NOW,
        currentlyEligible: true,
      }),
    ).toBe(SCHEDULE_INTERVALS.near);
  });

  it("nextEligibilityDueAt is absolute ISO time", () => {
    const due = nextEligibilityDueAt({
      stages: [stage(0.5)],
      lifecycle: "NEXT",
      isoNow: NOW,
      currentlyEligible: false,
    });
    expect(due).toBe("2026-08-16T12:05:00.000Z");
  });
});

describe("freshnessBucket", () => {
  it("live stage → hot", () => {
    expect(freshnessBucket([stage(0)], NOW)).toBe("hot");
  });
  it("future stage within 24h → warm", () => {
    expect(freshnessBucket([stage(5)], NOW)).toBe("warm");
  });
  it("far-future or ended → cold", () => {
    expect(freshnessBucket([stage(48)], NOW)).toBe("cold");
    expect(freshnessBucket([stage(-10)], NOW)).toBe("cold");
  });
});
