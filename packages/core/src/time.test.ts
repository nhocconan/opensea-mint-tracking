import { describe, expect, it } from "vitest";
import { coerceDate } from "./time.ts";

describe("coerceDate", () => {
  it("parses a string timestamp into a Date", () => {
    const result = coerceDate("2026-08-22T00:00:00.000Z");
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe("2026-08-22T00:00:00.000Z");
  });

  it("passes an existing Date through unchanged", () => {
    const original = new Date("2026-08-22T00:00:00.000Z");
    expect(coerceDate(original)).toBe(original);
  });

  it("handles a Postgres-style timestamptz string (space separator, offset)", () => {
    // Exactly the shape a raw db.execute() result returns (found live,
    // 2026-08-22): "2026-08-21 22:49:27.414993+00", not ISO 8601.
    const result = coerceDate("2026-08-21 22:49:27.414993+00");
    expect(result).toBeInstanceOf(Date);
    expect(Number.isNaN(result.getTime())).toBe(false);
  });
});
