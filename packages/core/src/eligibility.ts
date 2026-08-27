/**
 * Eligibility classification (PRD §6/§7.3).
 *
 * The single most important invariant in this product: a public stage that is
 * open to everyone must NEVER be reported as a whitelist hit. ELIGIBLE_RESTRICTED
 * requires an explicitly restricted stage with an explicit eligible=true from
 * an authenticated provider check.
 */
import type { StageKind } from "./stages.ts";
import { isRestrictedStage } from "./stages.ts";

export const ELIGIBILITY_STATES = [
  "ELIGIBLE_RESTRICTED",
  "INELIGIBLE_RESTRICTED",
  "PUBLIC_ONLY",
  "AUTH_REQUIRED",
  "UNKNOWN",
  "ERROR",
] as const;

export type EligibilityState = (typeof ELIGIBILITY_STATES)[number];

export type StageEligibilityOutcome =
  | { kind: "restricted"; eligible: boolean }
  | { kind: "public" }
  | { kind: "unknown" }
  | { kind: "error"; reasonCategory: string };

export interface EligibilityCheckResult {
  readonly stageLabel: string;
  readonly stageKind: StageKind;
  readonly outcome: StageEligibilityOutcome;
}

export interface EligibilityInput {
  readonly checks: readonly EligibilityCheckResult[];
  /**
   * false when wallet auth is missing/expired, so verdicts degrade to
   * AUTH_REQUIRED instead of claiming ineligibility.
   */
  readonly authAvailable: boolean;
}

export function classifyEligibility(input: EligibilityInput): EligibilityState {
  const { checks, authAvailable } = input;

  if (!authAvailable) {
    const hasRestricted = checks.some((c) => isRestrictedStage(c.stageKind));
    return hasRestricted ? "AUTH_REQUIRED" : "UNKNOWN";
  }

  let sawRestricted = false;
  let sawEligibleRestricted = false;
  let sawPublic = false;
  let sawError = false;

  for (const check of checks) {
    switch (check.outcome.kind) {
      case "error": {
        sawError = true;
        break;
      }
      case "public": {
        sawPublic = true;
        break;
      }
      case "unknown": {
        break;
      }
      case "restricted": {
        sawRestricted = true;
        if (check.outcome.eligible) {
          sawEligibleRestricted = true;
        }
      }
    }
  }

  if (sawEligibleRestricted) {
    return "ELIGIBLE_RESTRICTED";
  }
  if (sawError && !sawRestricted) {
    return "ERROR";
  }
  if (sawRestricted && !sawError) {
    return "INELIGIBLE_RESTRICTED";
  }
  if (sawRestricted && sawError) {
    // Some restricted checks errored; we cannot claim a clean verdict.
    return "ERROR";
  }
  if (sawPublic) {
    return "PUBLIC_ONLY";
  }
  return "UNKNOWN";
}

/** Stages backing a whitelist hit — used for alerts and the Eligible view. */
export function restrictedHitStages(
  checks: readonly EligibilityCheckResult[],
): EligibilityCheckResult[] {
  return checks.filter(
    (c) => c.outcome.kind === "restricted" && c.outcome.eligible && isRestrictedStage(c.stageKind),
  );
}

/** Display chip per PRD §5.2. */
export function eligibilityChip(state: EligibilityState): string {
  switch (state) {
    case "ELIGIBLE_RESTRICTED":
      return "WL";
    case "INELIGIBLE_RESTRICTED":
      return "NOT WL";
    case "PUBLIC_ONLY":
      return "PUBLIC ONLY";
    case "AUTH_REQUIRED":
      return "AUTH NEEDED";
    case "ERROR":
      return "ERROR";
    case "UNKNOWN":
      return "UNKNOWN";
  }
}
