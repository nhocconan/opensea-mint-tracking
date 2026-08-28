/**
 * Eligibility engine (PRD §7.3): quota-aware schedule, authenticated checks,
 * per-stage verdicts, and restricted-hit alerting through the deduped outbox.
 * PUBLIC_ONLY never creates a whitelist alert (core classification guards it).
 */

import {
  alertDedupeKey,
  classifyEligibility,
  coerceDate,
  type EligibilityCheckResult,
  eligibilityRetryDelayMs,
  isAppError,
} from "@hoodmint/core";
import {
  dropStages,
  dueEligibilityChecks,
  eligibilityChecks,
  enqueueAlert,
  listWallets,
  projects as projectsTable,
  publishEvent,
  upsertEligibilityCheck,
} from "@hoodmint/db";
import {
  type AlertRenderInput,
  renderAlertEmbed,
  renderAlertMessage,
} from "@hoodmint/notifications";
import { metrics } from "@hoodmint/observability";
import { OpenSeaClient } from "@hoodmint/providers";
import { and, eq } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { getWalletJwt, resolveOpenSeaKey } from "../credentials.ts";

export interface EligibilitySummary {
  checked: number;
  eligible: number;
  authMissing: boolean;
}

/**
 * One scheduling pass: claim due checks (bounded per cycle for quota), run
 * authenticated checks per wallet, persist verdicts with next-due times, and
 * enqueue alerts for newly-true restricted eligibility.
 */
export async function runEligibilityPass(
  ctx: WorkerContext,
  limit = 15,
): Promise<EligibilitySummary> {
  const { db, config, log } = ctx;
  const due = await dueEligibilityChecks(db, new Date(), limit);
  if (due.length === 0) {
    return { checked: 0, eligible: 0, authMissing: false };
  }

  const key = await resolveOpenSeaKey(db, config.APP_ENCRYPTION_KEY, config.OPENSEA_API_KEY);
  const clientFactory = (): OpenSeaClient => new OpenSeaClient({ apiKey: key.apiKey });
  const jwt = await getWalletJwt(
    db,
    config.APP_ENCRYPTION_KEY,
    config.OPENSEA_WALLET_PAT,
    clientFactory,
  );
  if (jwt === null) {
    // Degrade verdicts to AUTH_REQUIRED instead of claiming ineligibility.
    for (const check of due) {
      await upsertEligibilityCheck(db, {
        walletId: check.walletId,
        projectId: check.projectId,
        stageId: check.stageId,
        status: "AUTH_REQUIRED",
        checkedAt: new Date(),
        nextDueAt: addMs(new Date(), 30 * 60 * 1000),
      });
    }
    return { checked: 0, eligible: 0, authMissing: true };
  }

  const client = clientFactory();
  const walletRows = await listWallets(db);
  const walletById = new Map(walletRows.map((w) => [w.id, w]));
  let eligibleCount = 0;

  // Group by project to reuse one eligibility call per project+wallet pair.
  const byPair = new Map<string, typeof due>();
  for (const check of due) {
    const pairKey = `${check.walletId}:${check.projectId}`;
    const list = byPair.get(pairKey) ?? [];
    list.push(check);
    byPair.set(pairKey, list);
  }

  for (const [pairKey, checks] of byPair) {
    const first = checks[0];
    if (first === undefined || first.projectSlug === null) {
      continue;
    }
    try {
      const parsed = await client.getEligibility(first.projectSlug, jwt);
      const stageRows = await db
        .select()
        .from(dropStages)
        .where(eq(dropStages.projectId, first.projectId));
      const stagesByUuid = new Map(
        stageRows.map((stage) => [
          stage.providerStageId,
          {
            label: stage.label,
            kind: stage.type,
            startsAt: stage.startsAt.toISOString(),
            endsAt: stage.endsAt?.toISOString() ?? null,
            paused: stage.paused,
          },
        ]),
      );

      const results: EligibilityCheckResult[] = [];
      for (const stage of parsed.stages) {
        const known = stagesByUuid.get(stage.stage_uuid);
        if (known === undefined) {
          results.push({
            stageLabel: stage.stage_uuid.slice(0, 8),
            stageKind: "unknown",
            outcome: { kind: "unknown" },
          });
          continue;
        }
        const isRestricted = known.kind !== "public";
        results.push({
          stageLabel: known.label,
          stageKind: known.kind,
          outcome: isRestricted
            ? { kind: "restricted", eligible: stage.is_eligible }
            : { kind: "public" },
        });
      }
      const verdict = classifyEligibility({ checks: results, authAvailable: true });

      const stageById = new Map(stageRows.map((s) => [s.providerStageId, s]));
      for (const stage of parsed.stages) {
        const stageRow = stageById.get(stage.stage_uuid);
        if (stageRow === undefined) {
          continue;
        }
        const stageVerdict =
          stageRow.type === "public"
            ? "PUBLIC_ONLY"
            : stage.is_eligible
              ? "ELIGIBLE_RESTRICTED"
              : "INELIGIBLE_RESTRICTED";
        await upsertEligibilityCheck(db, {
          walletId: first.walletId,
          projectId: first.projectId,
          stageId: stageRow.id,
          status: stageVerdict,
          maxMintable: stage.max_total_mintable_by_wallet ?? undefined,
          ...(stage.price !== undefined && stage.price !== null ? { priceWei: stage.price } : {}),
          checkedAt: new Date(),
          nextDueAt: addMs(new Date(), retryDelayMs(first, verdict)),
        });
        metrics().inc("hoodmint_eligibility_verdicts_total", { status: stageVerdict });

        // Restricted hit → deduped alert through the outbox (PRD §7.4).
        if (stageRow.type !== "public" && stage.is_eligible) {
          eligibleCount += 1;
          const wallet = walletById.get(first.walletId);
          const dedupeKey = alertDedupeKey({
            deploymentId: "default",
            walletId: first.walletId,
            projectId: first.projectId,
            stageId: stageRow.id,
            alertType: "restricted_eligible",
            thresholdMinutes: 0,
          });
          const renderInput: AlertRenderInput = {
            alertType: "restricted_eligible",
            thresholdMinutes: 0,
            projectName: first.projectSlug,
            projectSlug: first.projectSlug,
            openseaUrl: null,
            stageLabel: stageRow.label,
            stagePriceDisplay: stage.price ?? null,
            maxPerWallet: stage.max_total_mintable_by_wallet ?? stageRow.maxPerWallet ?? null,
            walletLabel: wallet?.label ?? null,
            walletAddress: wallet?.address ?? "",
            startsAtIso: stageRow.startsAt.toISOString(),
            endsAtIso: stageRow.endsAt?.toISOString() ?? null,
          };
          const nowIso = new Date().toISOString();
          const text = renderAlertMessage(renderInput, nowIso);
          // Precomputed here (not at dispatch time) so every channel
          // adapter — including any added later — can stay a dumb
          // forwarder of whatever the enqueuing worker already rendered.
          const embed = renderAlertEmbed(renderInput, nowIso);
          await enqueueAlert(db, {
            dedupeKey,
            alertType: "restricted_eligible",
            walletId: first.walletId,
            projectId: first.projectId,
            stageId: stageRow.id,
            thresholdMinutes: 0,
            payload: { text, embed },
          });
        }
      }
      await publishEvent(db, {
        type: "eligibility.updated",
        projectId: first.projectId,
        at: new Date().toISOString(),
      });
    } catch (error) {
      const errorCode = isAppError(error) ? error.category : "unknown";
      log.warn({ errCode: errorCode, pairKey }, "eligibility check failed");
      metrics().inc("hoodmint_provider_errors_total", {
        provider: "opensea-eligibility",
        category: errorCode,
      });
      if (errorCode === "RateLimited") {
        // A 429 is transient quota exhaustion, NOT a real verdict error —
        // never overwrite a resolved chip (or leave a scary "ERROR") because
        // the free-tier quota ran out mid-cycle. Preserve any real verdict,
        // demote unresolved ones to AUTH_REQUIRED (retryable "AUTH NEEDED"),
        // schedule a short retry, and STOP the pass so we don't hammer the
        // 429 for every remaining pair this cycle.
        for (const check of checks) {
          const resolved =
            check.currentStatus === "ELIGIBLE_RESTRICTED" ||
            check.currentStatus === "INELIGIBLE_RESTRICTED" ||
            check.currentStatus === "PUBLIC_ONLY";
          await upsertEligibilityCheck(db, {
            walletId: check.walletId,
            projectId: check.projectId,
            stageId: check.stageId,
            status: resolved ? check.currentStatus : "AUTH_REQUIRED",
            checkedAt: new Date(),
            nextDueAt: addMs(new Date(), 5 * 60 * 1000),
          });
        }
        break;
      }
      for (const check of checks) {
        await upsertEligibilityCheck(db, {
          walletId: check.walletId,
          projectId: check.projectId,
          stageId: check.stageId,
          status: "ERROR",
          errorCode,
          checkedAt: new Date(),
          nextDueAt: addMs(new Date(), 30 * 60 * 1000),
        });
      }
    }
  }

  return { checked: byPair.size, eligible: eligibleCount, authMissing: false };
}

function retryDelayMs(
  check: { stageStartsAt: Date; currentlyEligible: boolean; lifecycle: string },
  verdict: string,
): number {
  const delay = eligibilityRetryDelayMs({
    stages: [
      {
        label: "stage",
        kind: "allowlist",
        // check.stageStartsAt is typed Date but is a string at runtime —
        // every Drizzle timestamp column is (found live, 2026-08-22).
        startsAt: coerceDate(check.stageStartsAt).toISOString(),
        endsAt: null,
        paused: false,
      },
    ],
    lifecycle:
      check.lifecycle === "LIVE" || check.lifecycle === "NEXT" || check.lifecycle === "UNKNOWN"
        ? check.lifecycle
        : "UNKNOWN",
    isoNow: new Date().toISOString(),
    currentlyEligible: verdict === "ELIGIBLE_RESTRICTED" || check.currentlyEligible,
  });
  return delay ?? 30 * 60 * 1000;
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

/**
 * Seed initial check rows so the scheduler has something to schedule:
 * enabled wallets × recent projects without any check yet.
 */
export async function ensureEligibilityRows(ctx: WorkerContext): Promise<number> {
  const { db, config } = ctx;
  const walletRows = await listWallets(db, { enabledOnly: true });
  if (walletRows.length === 0) {
    return 0;
  }
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const candidates = await db
    .select({ id: projectsTable.id, slug: projectsTable.slug })
    .from(projectsTable)
    .where(and(eq(projectsTable.lifecycleStatus, "NEXT")))
    .limit(200);
  let created = 0;
  for (const project of candidates) {
    if (project.slug === null) {
      continue;
    }
    const stages = await db.select().from(dropStages).where(eq(dropStages.projectId, project.id));
    const hasRestricted = stages.some((s) => s.type !== "public");
    if (!hasRestricted) {
      continue;
    }
    for (const wallet of walletRows) {
      for (const stage of stages.filter((s) => s.type !== "public")) {
        const existing = await db
          .select({ id: eligibilityChecks.id })
          .from(eligibilityChecks)
          .where(
            and(
              eq(eligibilityChecks.walletId, wallet.id),
              eq(eligibilityChecks.projectId, project.id),
              eq(eligibilityChecks.stageId, stage.id),
            ),
          )
          .limit(1);
        if (existing.length === 0) {
          await db
            .insert(eligibilityChecks)
            .values({
              walletId: wallet.id,
              projectId: project.id,
              stageId: stage.id,
              status: "UNKNOWN",
              checkedAt: cutoff,
              nextDueAt: new Date(),
            })
            .onConflictDoNothing();
          created += 1;
        }
      }
    }
  }
  void config;
  return created;
}
