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
