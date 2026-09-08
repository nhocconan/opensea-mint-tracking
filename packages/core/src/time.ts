/**
 * Time is injected everywhere (PRD §14): domain functions receive a Clock, so
 * tests never depend on wall-clock time and scheduling is deterministic.
 */
import type { UtcTimestamp } from "./brands.ts";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Fixed clock for tests. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(initial: Date) {
    this.current = initial;
  }

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(next: Date): void {
    this.current = next;
  }
}

export function toUtcIso(date: Date): UtcTimestamp {
  return date.toISOString() as UtcTimestamp;
}

export function parseUtc(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`invalid timestamp: ${value}`);
  }
  return parsed;
}

export function millisecondsBetween(a: Date, b: Date): number {
  return a.getTime() - b.getTime();
}

/**
 * Every raw `db.execute(sql...)` result in this codebase returns
 * `timestamptz` columns as strings, not `Date` instances — Drizzle's own
 * `.select()` query builder does too (found live, not by typecheck, via a
 * production-mode load test throwing `.getTime is not a function` on a
 * claimed mint plan's `armedUntil`, and `.toUTCString is not a function`
 * in the RSS route, 2026-08-22). Any field a repository or raw query
 * *types* as `Date` needs this before a `Date` method is called on it.
 */
export function coerceDate(value: string | Date): Date {
  return typeof value === "string" ? new Date(value) : value;
}

export const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";

/**
 * Wall-clock formatting in GMT+7 (Asia/Ho_Chi_Minh, UTC+07:00).
 * Storage stays UTC; display projects to GMT+7.
 */
export function formatDateTimeGmt7(value: string | Date | null): string {
  if (value === null) {
    return "—";
  }
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${at("year")}-${at("month")}-${at("day")} ${at("hour")}:${at("minute")} GMT+7`;
}

/**
 * Returns YYYY-MM-DD bucket in the target timezone (default Asia/Ho_Chi_Minh).
 */
export function getDayKey(
  date: Date | string | number,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${at("year")}-${at("month")}-${at("day")}`;
}
