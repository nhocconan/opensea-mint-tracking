/**
 * Quota-aware eligibility scheduling (PRD §7.3):
 *   stage > 24h away      → recheck every 6h
 *   stage 1–24h away      → every 30m
 *   stage < 1h away or live → every 5m
 *   restricted hit live   → every 30m while live
 *   ended/sold-out        → stop recurring checks
 */

import type { StageView } from "./stages.ts";
import { relevantStage, windowedStages } from "./stages.ts";
import type { LifecycleStatus } from "./status.ts";
import { parseUtc } from "./time.ts";

export const SCHEDULE_INTERVALS = {
  far: 6 * 60 * 60 * 1000,
  near: 30 * 60 * 1000,
  imminent: 5 * 60 * 1000,
} as const;

export interface ScheduleInput {
  readonly stages: readonly StageView[];
  readonly lifecycle: LifecycleStatus;
  readonly isoNow: string;
  readonly currentlyEligible: boolean;
}

/** Milliseconds to wait before the next eligibility check; null = stop. */
export function eligibilityRetryDelayMs(input: ScheduleInput): number | null {
  const { stages, lifecycle, isoNow, currentlyEligible } = input;

  if (lifecycle === "ENDED" || lifecycle === "SOLD_OUT") {
    return null;
  }

  const stage = relevantStage(stages, isoNow);
  if (stage === undefined) {
    return lifecycle === "UNKNOWN" ? SCHEDULE_INTERVALS.near : null;
  }

  const now = parseUtc(isoNow).getTime();
  const start = parseUtc(stage.startsAt).getTime();
  const end = stage.endsAt === null ? Number.POSITIVE_INFINITY : parseUtc(stage.endsAt).getTime();
  const live = start <= now && now < end;

  if (live) {
    return currentlyEligible ? SCHEDULE_INTERVALS.near : SCHEDULE_INTERVALS.imminent;
  }
  const msUntilStart = start - now;
  if (msUntilStart > 24 * 60 * 60 * 1000) {
    return SCHEDULE_INTERVALS.far;
  }
  if (msUntilStart > 60 * 60 * 1000) {
    return SCHEDULE_INTERVALS.near;
  }
  return SCHEDULE_INTERVALS.imminent;
}

/** ISO timestamp when the next eligibility check becomes due, if ever. */
export function nextEligibilityDueAt(input: ScheduleInput): string | null {
  const delay = eligibilityRetryDelayMs(input);
  if (delay === null) {
    return null;
  }
  return new Date(parseUtc(input.isoNow).getTime() + delay).toISOString();
}

/**
 * Freshness buckets for detail jobs (PRD §8.4 `freshnessBucket`):
 * live/imminent rows refresh fast, far-future rows slowly.
 */
export type FreshnessBucket = "hot" | "warm" | "cold";

export function freshnessBucket(stages: readonly StageView[], isoNow: string): FreshnessBucket {
  const windows = windowedStages(stages, isoNow);
  const now = parseUtc(isoNow).getTime();
  const live = windows.some(
    (w) => w.msUntilStart <= 0 && (w.msUntilEnd === null || w.msUntilEnd > 0),
  );
  if (live) {
    return "hot";
  }
  const nearest = windows.find((w) => w.msUntilStart > 0);
  if (nearest === undefined) {
    return "cold";
  }
  return now + nearest.msUntilStart - now < 24 * 60 * 60 * 1000 ? "warm" : "cold";
}

export const FRESHNESS_INTERVALS: Readonly<Record<FreshnessBucket, number>> = {
  hot: 5 * 60 * 1000,
  warm: 30 * 60 * 1000,
  cold: 6 * 60 * 60 * 1000,
};
