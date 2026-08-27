import { describe, expect, it } from "vitest";
import {
  classifyEligibility,
  type EligibilityCheckResult,
  eligibilityChip,
  restrictedHitStages,
} from "./eligibility.ts";

function restricted(eligible: boolean, label = "Allowlist"): EligibilityCheckResult {
  return { stageLabel: label, stageKind: "allowlist", outcome: { kind: "restricted", eligible } };
}

function pub(label = "Public"): EligibilityCheckResult {
  return { stageLabel: label, stageKind: "public", outcome: { kind: "public" } };
}

function error(reason = "RateLimited"): EligibilityCheckResult {
  return {
    stageLabel: "Allowlist",
    stageKind: "allowlist",
    outcome: { kind: "error", reasonCategory: reason },
  };
}

describe("classifyEligibility", () => {
  it("ELIGIBLE_RESTRICTED when a restricted stage explicitly returns eligible", () => {
    expect(classifyEligibility({ checks: [restricted(true)], authAvailable: true })).toBe(
      "ELIGIBLE_RESTRICTED",
    );
  });

  it("public eligible stages are NEVER whitelist hits (core PRD invariant)", () => {
    expect(classifyEligibility({ checks: [pub()], authAvailable: true })).toBe("PUBLIC_ONLY");
    expect(classifyEligibility({ checks: [pub(), pub("Public 2")], authAvailable: true })).toBe(
      "PUBLIC_ONLY",
    );
  });

  it("INELIGIBLE_RESTRICTED when restricted stages exist and all return false", () => {
    expect(
      classifyEligibility({
        checks: [restricted(false), restricted(false, "Presale")],
        authAvailable: true,
      }),
    ).toBe("INELIGIBLE_RESTRICTED");
  });

  it("mixed public + explicit restricted eligible → still ELIGIBLE_RESTRICTED", () => {
    expect(classifyEligibility({ checks: [pub(), restricted(true)], authAvailable: true })).toBe(
      "ELIGIBLE_RESTRICTED",
    );
  });

  it("AUTH_REQUIRED when auth is missing and restricted stages exist", () => {
    expect(classifyEligibility({ checks: [restricted(true)], authAvailable: false })).toBe(
      "AUTH_REQUIRED",
    );
  });

  it("UNKNOWN when auth missing and only public stages are known", () => {
    expect(classifyEligibility({ checks: [pub()], authAvailable: false })).toBe("UNKNOWN");
  });

  it("ERROR surfaces when restricted checks fail without a clean verdict", () => {
    expect(classifyEligibility({ checks: [error()], authAvailable: true })).toBe("ERROR");
    expect(classifyEligibility({ checks: [restricted(false), error()], authAvailable: true })).toBe(
      "ERROR",
    );
  });

  it("eligible restricted beats concurrent errors", () => {
    expect(classifyEligibility({ checks: [error(), restricted(true)], authAvailable: true })).toBe(
      "ELIGIBLE_RESTRICTED",
    );
  });

  it("restrictedHitStages returns only explicit eligible restricted stages", () => {
    const checks = [pub(), restricted(true), restricted(false, "Presale")];
    const hits = restrictedHitStages(checks);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.stageLabel).toBe("Allowlist");
  });

  it("chip labels match PRD §5.2 vocabulary", () => {
    expect(eligibilityChip("ELIGIBLE_RESTRICTED")).toBe("WL");
    expect(eligibilityChip("PUBLIC_ONLY")).toBe("PUBLIC ONLY");
    expect(eligibilityChip("AUTH_REQUIRED")).toBe("AUTH NEEDED");
  });
});
