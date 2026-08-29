import type { StageKind } from "@hoodmint/core";
import type { FeedRow } from "@hoodmint/db";

export interface DecisionStage {
  readonly id: string | null;
  readonly label: string | null;
  readonly kind: StageKind | null;
  readonly priceWei: string | null;
  readonly maxPerWallet: number | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly timing: "live" | "next" | "unknown";
}

/** Select one internally consistent phase for a feed card/row. */
export function decisionStage(row: FeedRow): DecisionStage {
  if (row.stageLabel !== null || row.stageStartsAt !== null) {
    return {
      id: row.stageId,
      label: row.stageLabel,
      kind: row.stageKind,
      priceWei: row.stagePriceWei,
      maxPerWallet: row.stageMaxPerWallet,
      startsAt: row.stageStartsAt,
      endsAt: row.stageEndsAt,
      timing: "live",
    };
  }
  if (row.nextStageLabel !== null || row.nextStageStart !== null) {
    return {
      id: row.nextStageId,
      label: row.nextStageLabel,
      kind: row.nextStageKind,
      priceWei: row.nextStagePriceWei,
      maxPerWallet: row.nextStageMaxPerWallet,
      startsAt: row.nextStageStart,
      endsAt: row.nextStageEndsAt,
      timing: "next",
    };
  }
  return {
    id: null,
    label: null,
    kind: null,
    priceWei: null,
    maxPerWallet: null,
    startsAt: null,
    endsAt: null,
    timing: "unknown",
  };
}
