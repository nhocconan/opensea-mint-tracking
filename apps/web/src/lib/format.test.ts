import { describe, expect, it } from "vitest";
import {
  formatDateTimeGmt7,
  formatDateTimeUtc,
  formatPrice,
  formatSupply,
  formatVelocity,
  shortAddress,
} from "./format.ts";

describe("UI-boundary formatting (PRD §14: UTC storage, locale at edge)", () => {
  it("formats UTC timestamps stably", () => {
    expect(formatDateTimeUtc("2026-08-16T12:34:56.000Z")).toBe("2026-08-16 12:34 UTC");
    expect(formatDateTimeUtc(null)).toBe("—");
  });

  it("renders the operator's GMT+7 wall clock alongside UTC", () => {
    expect(formatDateTimeGmt7("2026-08-16T12:34:56.000Z")).toBe("2026-08-16 19:34 GMT+7");
    // Crosses midnight forward: 17:00 UTC is 00:00 the next day in GMT+7.
    expect(formatDateTimeGmt7("2026-08-16T17:00:00.000Z")).toBe("2026-08-17 00:00 GMT+7");
    expect(formatDateTimeGmt7(new Date("2026-12-31T23:00:00.000Z"))).toBe("2027-01-01 06:00 GMT+7");
    expect(formatDateTimeGmt7(null)).toBe("—");
    expect(formatDateTimeGmt7("not a date")).toBe("—");
  });

  it("price display: free vs wei-derived", () => {
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice("0")).toBe("FREE");
    expect(formatPrice("4200000000000000")).toBe("0.0042 ETH");
  });

  it("supply never infers a cap", () => {
    expect(formatSupply("1200", null, false)).toContain("no verified cap");
    expect(formatSupply("90", "100", true)).toBe("90/100 (90%)");
    expect(formatSupply(null, null, false)).toBe("—");
  });

  it("velocity line includes mints and unique wallets", () => {
    expect(formatVelocity(12, 7)).toBe("12 mints · 7 wallets (1h)");
    expect(formatVelocity(0, 0)).toBe("—");
  });

  it("address short form keeps head and tail", () => {
    expect(shortAddress("0xabcdef0123456789abcdef0123456789abcdef01")).toBe("0xabcd…ef01");
  });
});
