/**
 * Stage-starting alerts (PRD §7.4): "Eligible stage starts in configurable
 * windows (default 60m, 15m, 5m)." Unlike restricted_eligible, this is not
 * wallet-scoped — it fires once per (stage, window) regardless of which
 * wallet(s) are eligible for it, so its dedupe key leaves `walletId` empty
 * (see alertDedupeKey's length-prefixed encoding, which keeps that from
 * ever colliding with a real wallet-scoped key).
 */
import {
  type AlertType,
  alertDedupeKey,
  dueStageStartingWindows,
  formatWei,
  toWei,
} from "@hoodmint/core";
import { enqueueAlert, type UpcomingStage, upcomingDropStages } from "@hoodmint/db";
import {
  type AlertRenderInput,
  renderAlertEmbed,
  renderAlertMessage,
} from "@hoodmint/notifications";
import type { WorkerContext } from "../context.ts";

const STAGE_STARTING: AlertType = "stage_starting";

export interface StageStartingSummary {
  readonly candidates: number;
  readonly enqueued: number;
}

function formatStagePrice(priceWei: string | null): string | null {
  if (priceWei === null) {
    return null;
  }
  if (priceWei === "0") {
    return "FREE";
  }
  try {
    return `${formatWei(toWei(priceWei), 18).slice(0, 8)} ETH`;
  } catch {
    return null;
  }
}

async function enqueueStageStarting(
  ctx: WorkerContext,
  stage: UpcomingStage,
  thresholdMinutes: number,
  nowIso: string,
): Promise<boolean> {
  const { db } = ctx;
  const dedupeKey = alertDedupeKey({
    deploymentId: "default",
    walletId: "",
    projectId: stage.projectId,
    stageId: stage.stageId,
    alertType: STAGE_STARTING,
    thresholdMinutes,
  });
  const renderInput: AlertRenderInput = {
    alertType: STAGE_STARTING,
    thresholdMinutes,
    projectName: stage.projectName,
    projectSlug: stage.projectSlug,
    openseaUrl: null,
    stageLabel: stage.stageLabel,
    stagePriceDisplay: formatStagePrice(stage.stagePriceWei),
    maxPerWallet: stage.stageMaxPerWallet,
    walletLabel: null,
    walletAddress: "",
    startsAtIso: stage.startsAt.toISOString(),
    endsAtIso: stage.endsAt?.toISOString() ?? null,
  };
  const text = renderAlertMessage(renderInput, nowIso);
  // Precomputed here (not at dispatch time), same as the restricted_eligible
  // flow, so every channel adapter stays a dumb forwarder of already-rendered
  // content.
  const embed = renderAlertEmbed(renderInput, nowIso);
  return enqueueAlert(db, {
    dedupeKey,
    alertType: STAGE_STARTING,
    projectId: stage.projectId,
    stageId: stage.stageId,
    thresholdMinutes,
    payload: { text, embed },
  });
}

/**
 * One scheduling pass: find stages opening within the largest configured
 * window, then enqueue one deduped alert per (stage, window) they've
 * already crossed.
 */
export async function runStageStartingPass(ctx: WorkerContext): Promise<StageStartingSummary> {
  const { db, config } = ctx;
  const windows = config.ALERT_STAGE_WINDOWS_MINUTES;
  const maxWindowMinutes = windows[0];
  if (maxWindowMinutes === undefined) {
    return { candidates: 0, enqueued: 0 };
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const stages = await upcomingDropStages(db, now, maxWindowMinutes);

  let enqueued = 0;
  for (const stage of stages) {
    const msUntilStart = stage.startsAt.getTime() - now.getTime();
    for (const thresholdMinutes of dueStageStartingWindows(msUntilStart, windows)) {
      const created = await enqueueStageStarting(ctx, stage, thresholdMinutes, nowIso);
      if (created) {
        enqueued += 1;
      }
    }
  }
  return { candidates: stages.length, enqueued };
}
