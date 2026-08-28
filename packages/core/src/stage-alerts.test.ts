import { describe, expect, it } from "vitest";
import { dueStageStartingWindows } from "./stage-alerts.ts";

const WINDOWS = [60, 15, 5]; // sorted desc, matches ALERT_STAGE_WINDOWS_MINUTES parsing

describe("dueStageStartingWindows", () => {
  it("matches no window when the stage has already started", () => {
    expect(dueStageStartingWindows(0, WINDOWS)).toEqual([]);
    expect(dueStageStartingWindows(-1, WINDOWS)).toEqual([]);
  });

  it("matches only the windows the stage has crossed", () => {
    // 45 minutes out: within the 60m window, not yet within 15m/5m.
    expect(dueStageStartingWindows(45 * 60_000, WINDOWS)).toEqual([60]);
  });

  it("matches every window the stage has already crossed at once", () => {
    // 3 minutes out: within all three configured windows.
    expect(dueStageStartingWindows(3 * 60_000, WINDOWS)).toEqual([60, 15, 5]);
  });

  it("is inclusive at the exact boundary", () => {
    expect(dueStageStartingWindows(60 * 60_000, WINDOWS)).toEqual([60]);
    expect(dueStageStartingWindows(15 * 60_000, WINDOWS)).toEqual([60, 15]);
  });

  it("excludes a window one millisecond past the boundary", () => {
    expect(dueStageStartingWindows(60 * 60_000 + 1, WINDOWS)).toEqual([]);
    expect(dueStageStartingWindows(15 * 60_000 + 1, WINDOWS)).toEqual([60]);
  });

  it("returns nothing when no windows are configured", () => {
    expect(dueStageStartingWindows(5 * 60_000, [])).toEqual([]);
  });
});
