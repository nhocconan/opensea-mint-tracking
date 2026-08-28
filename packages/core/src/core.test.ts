import { describe, expect, it } from "vitest";
import { formatShortAddress, normalizeAddress, tryNormalizeAddress } from "./address.ts";
import { combineConfidence, projectIdentity } from "./confidence.ts";
import { alertDedupeKey, jobId } from "./dedupe.ts";
import { AppError, safeErrorMessage } from "./errors.ts";
import { FixedClock, parseUtc, toUtcIso } from "./time.ts";
import { formatWei, toWei } from "./wei.ts";

describe("alertDedupeKey", () => {
  const base = {
    deploymentId: "deploy-1",
    walletId: "w1",
    projectId: "p1",
    stageId: "s1",
    alertType: "restricted_eligible" as const,
    thresholdMinutes: 0,
  };

  it("is stable for identical parts", () => {
    expect(alertDedupeKey(base)).toBe(alertDedupeKey({ ...base }));
  });

  it("separates wallets, stages, alert types, and thresholds", () => {
    const key = alertDedupeKey(base);
    expect(alertDedupeKey({ ...base, walletId: "w2" })).not.toBe(key);
    expect(alertDedupeKey({ ...base, stageId: "s2" })).not.toBe(key);
    expect(alertDedupeKey({ ...base, alertType: "watched_live" })).not.toBe(key);
    expect(alertDedupeKey({ ...base, thresholdMinutes: 15 })).not.toBe(key);
  });

  it("is collision-free for ambiguous component boundaries (length prefixing)", () => {
    const a = alertDedupeKey({ ...base, walletId: "ab", projectId: "c" });
    const b = alertDedupeKey({ ...base, walletId: "a", projectId: "bc" });
    expect(a).not.toBe(b);
  });

  it("is stable for stage_starting keys (not wallet-scoped, walletId left empty) and separates thresholds/stages", () => {
    const stageStarting = {
      deploymentId: "default",
      walletId: "",
      projectId: "p1",
      stageId: "s1",
      alertType: "stage_starting" as const,
      thresholdMinutes: 60,
    };
    expect(alertDedupeKey(stageStarting)).toBe(alertDedupeKey({ ...stageStarting }));
    expect(alertDedupeKey({ ...stageStarting, thresholdMinutes: 15 })).not.toBe(
      alertDedupeKey(stageStarting),
    );
    expect(alertDedupeKey({ ...stageStarting, stageId: "s2" })).not.toBe(
      alertDedupeKey(stageStarting),
    );
    // Must never collide with a wallet-scoped restricted_eligible key for
    // the same project/stage — different alertType is enough on its own.
    expect(alertDedupeKey({ ...base, thresholdMinutes: 60 })).not.toBe(
      alertDedupeKey(stageStarting),
    );
  });
});

describe("jobId determinism (PRD §8.4)", () => {
  it("matches the PRD patterns", () => {
    expect(jobId.discovery("opensea", "upcoming", 123)).toBe("discover.opensea.upcoming.123");
    expect(jobId.detail("opensea", "robindroids5000", "hot")).toBe(
      "detail.opensea.robindroids5000.hot",
    );
    expect(jobId.chainSync(4663, 100n, 200n)).toBe("chain.4663.100.200");
    expect(jobId.eligibility("w1", "d1", 3)).toBe("eligibility.w1.d1.3");
    expect(jobId.notification("0192abc")).toBe("notify.0192abc");
  });

  it("never emits ':' — BullMQ rejects custom job ids containing it", () => {
    const samples = [
      jobId.discovery("opensea", "upcoming", 123),
      jobId.detail("opensea", "slug", "hot"),
      jobId.chainSync(4663, 100n, 200n),
      jobId.eligibility("w1", "d1", 3),
      jobId.notification("0192abc"),
      jobId.rarity("p1", 1_700_000_000_000),
    ];
    for (const id of samples) {
      expect(id).not.toContain(":");
    }
  });
});

describe("address normalization", () => {
  it("lowercases valid addresses", () => {
    expect(normalizeAddress("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
  });

  it("rejects malformed addresses", () => {
    expect(() => normalizeAddress("0x1234")).toThrow(RangeError);
    expect(() => normalizeAddress("0xZZcdEf0123456789aBcDeF0123456789AbCdEf01")).toThrow(
      RangeError,
    );
    expect(tryNormalizeAddress("nope")).toBeUndefined();
  });

  it("short form keeps head and tail", () => {
    expect(formatShortAddress("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01")).toBe("0xabcd…ef01");
    expect(formatShortAddress("not-an-address")).toBe("not-an-address");
  });
});

describe("wei discipline", () => {
  it("accepts decimal strings, hex, and bigint; rejects floats and negatives", () => {
    expect(toWei("1000000000000000000")).toBe("1000000000000000000");
    expect(toWei("0xde0b6b3a7640000")).toBe("1000000000000000000");
    expect(toWei(18n)).toBe("18");
    expect(() => toWei("1.5")).toThrow(RangeError);
    expect(() => toWei(-1n)).toThrow(RangeError);
  });

  it("formats whole/fraction display strings", () => {
    expect(formatWei(toWei("1000000000000000000"))).toBe("1");
    expect(formatWei(toWei("1500000000000000000"))).toBe("1.5");
    expect(formatWei(toWei("1"), 18)).toBe("0.000000000000000001");
  });
});

describe("confidence and identity", () => {
  it("combines confidence levels per PRD §7.2", () => {
    expect(combineConfidence(["verified", "single-source"])).toBe("verified");
    expect(combineConfidence(["single-source", "single-source"])).toBe("corroborated");
    expect(combineConfidence(["single-source"])).toBe("single-source");
    expect(combineConfidence(["unverified"])).toBe("unverified");
    expect(combineConfidence([])).toBe("unverified");
  });

  it("identity prefers (chainId, contract) and falls back to source-scoped ids", () => {
    expect(
      projectIdentity({
        chainId: 4663,
        contractAddress: "0xAbC0000000000000000000000000000000000001",
        providerId: "opensea",
        externalId: "slug",
      }),
    ).toEqual({ kind: "contract", key: "4663:0xabc0000000000000000000000000000000000001" });
    expect(
      projectIdentity({
        chainId: 4663,
        contractAddress: null,
        providerId: "opensea",
        externalId: "slug",
      }),
    ).toEqual({ kind: "external", key: "opensea:slug" });
  });
});

describe("injected time", () => {
  it("FixedClock advances deterministically", () => {
    const clock = new FixedClock(new Date("2026-08-16T00:00:00Z"));
    expect(toUtcIso(clock.now())).toBe("2026-08-16T00:00:00.000Z");
    clock.advance(90_000);
    expect(toUtcIso(clock.now())).toBe("2026-08-16T00:01:30.000Z");
    expect(() => parseUtc("not-a-date")).toThrow(RangeError);
  });
});

describe("typed errors", () => {
  it("carries category, retryability, and HTTP status defaults", () => {
    const err = new AppError("RateLimited", "provider rate limited", { retryAfterSeconds: 30 });
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterSeconds).toBe(30);
    expect(new AppError("PermanentConfig", "bad webhook").retryable).toBe(false);
  });

  it("safeErrorMessage strips query strings that could carry keys", () => {
    expect(safeErrorMessage(new Error("GET https://x.io/api?key=abc failed"))).not.toContain("abc");
    expect(safeErrorMessage("boom", "fallback")).toBe("fallback");
  });
});
