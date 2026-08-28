import { describe, expect, it } from "vitest";
import { formatDateTimeGmt7 } from "./format.ts";
import {
  GMT7_OFFSET_MINUTES,
  gmt7LocalToUtc,
  parseMintTarget,
  utcToGmt7LocalInput,
} from "./mint-target.ts";

describe("parseMintTarget (URL / slug / contract)", () => {
  it("extracts the slug from an OpenSea collection URL", () => {
    expect(parseMintTarget("https://opensea.io/collection/stackman-genesis")).toEqual({
      kind: "slug",
      slug: "stackman-genesis",
    });
  });

  it("tolerates a language prefix, trailing path, query and whitespace", () => {
    expect(parseMintTarget("  https://opensea.io/en/collection/Stackman-Genesis/overview?a=1  ")
      ).toEqual({ kind: "slug", slug: "stackman-genesis" });
  });

  it("recognises a contract address used as the collection segment", () => {
    // The owner's own example URL.
    expect(
      parseMintTarget(
        "https://opensea.io/collection/0xc21159f412c294ca2c38f2a9ecaaccf9d93ec929/overview",
      ),
    ).toEqual({ kind: "contract", address: "0xc21159f412c294ca2c38f2a9ecaaccf9d93ec929" });
  });

  it("accepts a bare slug and a bare contract address, lowercasing both", () => {
    expect(parseMintTarget("some-drop")).toEqual({ kind: "slug", slug: "some-drop" });
    expect(parseMintTarget("0xC21159F412C294CA2C38F2A9ECAACCF9D93EC929")).toEqual({
      kind: "contract",
      address: "0xc21159f412c294ca2c38f2a9ecaaccf9d93ec929",
    });
  });

  it("falls back to the address in a non-collection OpenSea URL", () => {
    expect(
      parseMintTarget("https://opensea.io/item/ethereum/0xc21159f412c294ca2c38f2a9ecaaccf9d93ec929/7"),
    ).toEqual({ kind: "contract", address: "0xc21159f412c294ca2c38f2a9ecaaccf9d93ec929" });
  });

  it("fails closed rather than guessing", () => {
    expect(parseMintTarget("")).toBeNull();
    expect(parseMintTarget("   ")).toBeNull();
    // 39 hex digits — a truncated address is not a slug either.
    expect(parseMintTarget("0xc21159f412c294ca2c38f2a9ecaaccf9d93ec92")).toBeNull();
    expect(parseMintTarget("-leading-dash")).toBeNull();
    expect(parseMintTarget("has space")).toBeNull();
    expect(parseMintTarget("https://example.com/collection/foo")).toBeNull();
    expect(parseMintTarget("a")).toBeNull();
  });
});

describe("GMT+7 ↔ UTC conversion", () => {
  it("interprets a datetime-local value as GMT+7, not the server's zone", () => {
    // 20:30 in Ho Chi Minh City is 13:30 UTC the same day.
    expect(gmt7LocalToUtc("2026-09-01T20:30")?.toISOString()).toBe("2026-09-01T13:30:00.000Z");
  });

  it("rolls back across midnight and the year boundary", () => {
    expect(gmt7LocalToUtc("2026-09-02T03:15")?.toISOString()).toBe("2026-09-01T20:15:00.000Z");
    expect(gmt7LocalToUtc("2027-01-01T06:00")?.toISOString()).toBe("2026-12-31T23:00:00.000Z");
    expect(gmt7LocalToUtc("2026-09-01T00:00")?.toISOString()).toBe("2026-08-31T17:00:00.000Z");
  });

  it("accepts optional seconds", () => {
    expect(gmt7LocalToUtc("2026-09-01T20:30:45")?.toISOString()).toBe("2026-09-01T13:30:45.000Z");
  });

  it("rejects malformed and non-existent times", () => {
    expect(gmt7LocalToUtc("")).toBeNull();
    expect(gmt7LocalToUtc("2026-09-01")).toBeNull();
    expect(gmt7LocalToUtc("2026-09-01 20:30")).toBeNull();
    expect(gmt7LocalToUtc("2026-02-30T10:00")).toBeNull();
    expect(gmt7LocalToUtc("2026-13-01T10:00")).toBeNull();
    expect(gmt7LocalToUtc("2026-09-01T25:00")).toBeNull();
  });

  it("round-trips UTC → datetime-local → UTC", () => {
    const utc = "2026-09-01T13:30:00.000Z";
    const local = utcToGmt7LocalInput(utc);
    expect(local).toBe("2026-09-01T20:30");
    expect(gmt7LocalToUtc(local)?.toISOString()).toBe(utc);
  });

  it("agrees with the Intl-based GMT+7 display formatter", () => {
    // The conversion uses a fixed +07:00 constant; the display formatter goes
    // through Intl with timeZone "Asia/Ho_Chi_Minh". This pins the two
    // together, so an ICU offset change could not silently desync them.
    for (const iso of [
      "2026-09-01T13:30:00.000Z",
      "2026-12-31T23:00:00.000Z",
      "2026-08-31T17:00:00.000Z",
      "2027-06-15T04:05:00.000Z",
    ]) {
      const local = utcToGmt7LocalInput(iso);
      const expected = `${local.replace("T", " ")} GMT+7`;
      expect(formatDateTimeGmt7(iso)).toBe(expected);
      expect(gmt7LocalToUtc(local)?.toISOString()).toBe(iso);
    }
    expect(GMT7_OFFSET_MINUTES).toBe(420);
  });
});
