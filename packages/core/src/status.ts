/**
 * Lifecycle status computation (PRD §6) — pure and deterministic.
 *
 * LIVE      a stage satisfies start <= now < end, not paused, and known
 *           remaining supply > 0. Unknown supply never blocks LIVE.
 * NEXT      no live stage; at least one future stage. Ordered by earliest start.
 * SOLD_OUT  max and minted both verified and remaining == 0.
 * ENDED     all known stages ended and not sold out.
 * PAUSED    authoritative source explicitly reports paused.
 * UNKNOWN   insufficient or conflicting data.
 */
import type { StageView } from "./stages.ts";
import { isStageLive, windowedStages } from "./stages.ts";
import { parseUtc } from "./time.ts";

export const LIFECYCLE_STATUSES = [
  "LIVE",
  "NEXT",
  "ENDED",
  "SOLD_OUT",
  "PAUSED",
  "UNKNOWN",
] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export interface SupplyFacts {
  readonly minted: bigint | null;
  readonly maxSupply: bigint | null;
  /** Both minted and max must be independently verified for SOLD_OUT. */
  readonly verified: boolean;
}

export interface StatusInput {
  readonly stages: readonly StageView[];
  readonly isoNow: string;
  /** Authoritative paused flag from the winning source, if reported. */
  readonly paused: boolean | null;
  readonly supply: SupplyFacts;
}

export function computeLifecycle(input: StatusInput): LifecycleStatus {
  const { stages, isoNow, paused, supply } = input;

  if (stages.length === 0 && paused !== true) {
    return "UNKNOWN";
  }

  // SOLD_OUT requires both sides verified; never inferred from a cap guess.
  if (
    supply.verified &&
    supply.minted !== null &&
    supply.maxSupply !== null &&
    supply.minted >= supply.maxSupply
  ) {
    return "SOLD_OUT";
  }

  const liveStage = stages.find((stage) => isStageLive(stage, isoNow));
  if (liveStage !== undefined) {
    if (liveStage.paused || paused === true) {
      return "PAUSED";
    }
    if (
      supply.verified &&
      supply.minted !== null &&
      supply.maxSupply !== null &&
      supply.minted >= supply.maxSupply
    ) {
      return "SOLD_OUT";
    }
    return "LIVE";
  }

  // No live stage: an explicit paused report wins over NEXT/ENDED while a
  // future stage still exists.
  const hasFutureStage = windowedStages(stages, isoNow).some((w) => w.msUntilStart > 0);
  if (paused === true) {
    return hasFutureStage ? "PAUSED" : "ENDED";
  }

  if (hasFutureStage) {
    return "NEXT";
  }

  const allEnded = stages.every(
    (stage) =>
      stage.endsAt !== null && parseUtc(stage.endsAt).getTime() <= parseUtc(isoNow).getTime(),
  );
  return allEnded ? "ENDED" : "UNKNOWN";
}

/**
 * Remaining supply only when derivable without inference (PRD §5.2:
 * "Never infer a cap").
 */
export function remainingSupply(
  supply: SupplyFacts,
): { remaining: bigint; known: true } | { known: false } {
  if (supply.verified && supply.minted !== null && supply.maxSupply !== null) {
    return { known: true, remaining: supply.maxSupply - supply.minted };
  }
  return { known: false };
}

/**
 * Minted percentage basis for sorting/UI; null unless both values verified.
 */
export function mintedPercentage(supply: SupplyFacts): number | null {
  if (
    !supply.verified ||
    supply.minted === null ||
    supply.maxSupply === null ||
    supply.maxSupply === 0n
  ) {
    return null;
  }
  return Number((supply.minted * 10_000n) / supply.maxSupply) / 100;
}
