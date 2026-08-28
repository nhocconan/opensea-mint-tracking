import type { EligibilityState } from "@hoodmint/core";
import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { dropStages, eligibilityChecks, projects, wallets } from "../schema.ts";

export interface EligibilityUpsert {
  readonly walletId: string;
  readonly projectId: string;
  readonly stageId: string;
  readonly status: EligibilityState;
  readonly maxMintable?: number | undefined;
  readonly priceWei?: string | undefined;
  readonly evidenceId?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly checkedAt: Date;
  readonly nextDueAt: Date | null;
}

/**
 * Make every AUTH_REQUIRED check due immediately — called right after an
 * OpenSea wallet PAT is saved so the next eligibility pass (≤60s) re-runs the
 * verdicts that were degraded to "AUTH NEEDED" for lack of a PAT, instead of
 * making the operator wait out the 30-minute AUTH_REQUIRED backoff. Returns
 * how many rows were reset.
 */
export async function markAuthRequiredChecksDue(db: Db): Promise<number> {
  const rows = await db
    .update(eligibilityChecks)
    // ERROR rows from a transient rate-limit are not real verdicts either —
    // demote them back to AUTH_REQUIRED so the recheck resolves them instead
    // of leaving "ERROR" chips for the 30-minute backoff.
    .set({ nextDueAt: new Date(), status: "AUTH_REQUIRED", errorCode: null })
    .where(
      or(
        eq(eligibilityChecks.status, "AUTH_REQUIRED"),
        and(eq(eligibilityChecks.status, "ERROR"), eq(eligibilityChecks.errorCode, "RateLimited")),
      ),
    )
    .returning({ id: eligibilityChecks.walletId });
  return rows.length;
}

export async function upsertEligibilityCheck(db: Db, input: EligibilityUpsert): Promise<void> {
  await db
    .insert(eligibilityChecks)
    .values({
      walletId: input.walletId,
      projectId: input.projectId,
      stageId: input.stageId,
      status: input.status,
      ...(input.maxMintable !== undefined ? { maxMintable: input.maxMintable } : {}),
      ...(input.priceWei !== undefined ? { priceWei: input.priceWei } : {}),
      ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      checkedAt: input.checkedAt,
      nextDueAt: input.nextDueAt,
    })
    .onConflictDoUpdate({
      target: [eligibilityChecks.walletId, eligibilityChecks.projectId, eligibilityChecks.stageId],
      set: {
        status: input.status,
        ...(input.maxMintable !== undefined ? { maxMintable: input.maxMintable } : {}),
        ...(input.priceWei !== undefined ? { priceWei: input.priceWei } : {}),
        ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        checkedAt: input.checkedAt,
        nextDueAt: input.nextDueAt,
      },
    });
}

export interface WalletProjectEligibility {
  readonly walletId: string;
  readonly walletAddress: string;
  readonly walletLabel: string | null;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectSlug: string | null;
  readonly stageId: string;
  readonly stageLabel: string;
  readonly stageType: string;
  readonly stageStartsAt: Date;
  readonly stageEndsAt: Date | null;
  readonly stagePriceWei: string | null;
  readonly maxMintable: number | null;
  readonly status: EligibilityState;
  readonly checkedAt: Date;
  readonly errorCode: string | null;
}

const ELIGIBLE_RANK: Record<EligibilityState, number> = {
  ELIGIBLE_RESTRICTED: 0,
  ERROR: 1,
  AUTH_REQUIRED: 2,
  INELIGIBLE_RESTRICTED: 3,
  UNKNOWN: 4,
  PUBLIC_ONLY: 5,
};

export async function eligibilityForWallet(
  db: Db,
  walletId: string,
): Promise<WalletProjectEligibility[]> {
  return db
    .select({
      walletId: eligibilityChecks.walletId,
      walletAddress: wallets.address,
      walletLabel: wallets.label,
      projectId: eligibilityChecks.projectId,
      projectName: projects.name,
      projectSlug: projects.slug,
      stageId: dropStages.id,
      stageLabel: dropStages.label,
      stageType: dropStages.type,
      stageStartsAt: dropStages.startsAt,
      stageEndsAt: dropStages.endsAt,
      stagePriceWei: dropStages.priceWei,
      maxMintable: eligibilityChecks.maxMintable,
      status: eligibilityChecks.status,
      checkedAt: eligibilityChecks.checkedAt,
      errorCode: eligibilityChecks.errorCode,
    })
    .from(eligibilityChecks)
    .innerJoin(wallets, eq(wallets.id, eligibilityChecks.walletId))
    .innerJoin(projects, eq(projects.id, eligibilityChecks.projectId))
    .innerJoin(dropStages, eq(dropStages.id, eligibilityChecks.stageId))
    .where(eq(eligibilityChecks.walletId, walletId))
    .orderBy(asc(dropStages.startsAt));
}

export async function eligibilityForProject(
  db: Db,
  projectId: string,
): Promise<WalletProjectEligibility[]> {
  return db
    .select({
      walletId: eligibilityChecks.walletId,
      walletAddress: wallets.address,
      walletLabel: wallets.label,
      projectId: eligibilityChecks.projectId,
      projectName: projects.name,
      projectSlug: projects.slug,
      stageId: dropStages.id,
      stageLabel: dropStages.label,
      stageType: dropStages.type,
      stageStartsAt: dropStages.startsAt,
      stageEndsAt: dropStages.endsAt,
      stagePriceWei: dropStages.priceWei,
      maxMintable: eligibilityChecks.maxMintable,
      status: eligibilityChecks.status,
      checkedAt: eligibilityChecks.checkedAt,
      errorCode: eligibilityChecks.errorCode,
    })
    .from(eligibilityChecks)
    .innerJoin(wallets, eq(wallets.id, eligibilityChecks.walletId))
    .innerJoin(projects, eq(projects.id, eligibilityChecks.projectId))
    .innerJoin(dropStages, eq(dropStages.id, eligibilityChecks.stageId))
    .where(eq(eligibilityChecks.projectId, projectId))
    .orderBy(asc(wallets.address), asc(dropStages.startsAt));
}

/**
 * Feed-level chips across ALL enabled wallets: best status per project.
 *
 * `projectIds`, when given, scopes the scan to just those projects instead
 * of every eligibility row in the system — pass the current page's project
 * ids from any call site that only renders a bounded page (the feed views,
 * the `/api/v1/projects` export). Omit it only where the caller genuinely
 * needs a whole-database aggregate (the Pulse dashboard's system-wide
 * "eligible right now" count) — that is the one caller intentionally left
 * unscoped. An empty `projectIds` array short-circuits to an empty map
 * without touching the database, same as `walletChipsForProjects` below.
 *
 * Found via live load testing 2026-08-22 (`/all`: 216 req/s vs.
 * `/rss/live`: 1,290 req/s — see docs/execution-architecture.md's seventh
 * pass): the unscoped full join was the bottleneck on every feed page load.
 */
export async function bestEligibilityByProject(
  db: Db,
  projectIds?: readonly string[],
): Promise<Map<string, EligibilityState>> {
  if (projectIds !== undefined && projectIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      projectId: eligibilityChecks.projectId,
      status: eligibilityChecks.status,
    })
    .from(eligibilityChecks)
    .innerJoin(wallets, eq(wallets.id, eligibilityChecks.walletId))
    .where(
      projectIds === undefined
        ? eq(wallets.enabled, true)
        : and(eq(wallets.enabled, true), inArray(eligibilityChecks.projectId, projectIds)),
    );
  const best = new Map<string, EligibilityState>();
  for (const row of rows) {
    const current = best.get(row.projectId);
    if (current === undefined || ELIGIBLE_RANK[row.status] < ELIGIBLE_RANK[current]) {
      best.set(row.projectId, row.status);
    }
  }
  return best;
}

/** Feed-level wallet chips: best (most alarming) status per project. */
export async function walletChipsForProjects(
  db: Db,
  walletIds: readonly string[],
): Promise<Map<string, EligibilityState>> {
  if (walletIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      projectId: eligibilityChecks.projectId,
      walletId: eligibilityChecks.walletId,
      status: eligibilityChecks.status,
    })
    .from(eligibilityChecks)
    .where(inArray(eligibilityChecks.walletId, walletIds));
  const best = new Map<string, EligibilityState>();
  for (const row of rows) {
    const key = `${row.walletId}:${row.projectId}`;
    const current = best.get(key);
    if (current === undefined || ELIGIBLE_RANK[row.status] < ELIGIBLE_RANK[current]) {
      best.set(key, row.status);
    }
  }
  return best;
}

export interface DueCheck {
  readonly walletId: string;
  readonly walletAddress: string;
  readonly credentialId: string | null;
  readonly projectId: string;
  readonly projectSlug: string | null;
  readonly stageId: string;
  readonly stageLabel: string;
  readonly stageKind: string;
  readonly stageStartsAt: Date;
  readonly currentlyEligible: boolean;
  /** Prior persisted verdict — so a transient rate-limit can preserve a
   *  resolved chip instead of overwriting it with ERROR. */
  readonly currentStatus: EligibilityState;
  readonly lifecycle: string;
}

/** Checks whose nextDueAt has passed, bounded per cycle (quota-aware). */
export async function dueEligibilityChecks(db: Db, now: Date, limit: number): Promise<DueCheck[]> {
  const rows = await db
    .select({
      walletId: wallets.id,
      walletAddress: wallets.address,
      credentialId: wallets.credentialId,
      projectId: projects.id,
      projectSlug: projects.slug,
      stageId: dropStages.id,
      stageLabel: dropStages.label,
      stageKind: dropStages.type,
      stageStartsAt: dropStages.startsAt,
      currentStatus: eligibilityChecks.status,
      lifecycle: projects.lifecycleStatus,
    })
    .from(eligibilityChecks)
    .innerJoin(wallets, eq(wallets.id, eligibilityChecks.walletId))
    .innerJoin(projects, eq(projects.id, eligibilityChecks.projectId))
    .innerJoin(dropStages, eq(dropStages.id, eligibilityChecks.stageId))
    .where(
      and(
        eq(wallets.enabled, true),
        lte(eligibilityChecks.nextDueAt, now),
        or(isNotNull(eligibilityChecks.nextDueAt), sql`true`),
      ),
    )
    .orderBy(asc(eligibilityChecks.nextDueAt))
    .limit(limit);
  return rows.map((row) => ({
    walletId: row.walletId,
    walletAddress: row.walletAddress,
    credentialId: row.credentialId,
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    stageId: row.stageId,
    stageLabel: row.stageLabel,
    stageKind: row.stageKind,
    stageStartsAt: row.stageStartsAt,
    currentlyEligible: row.currentStatus === "ELIGIBLE_RESTRICTED",
    currentStatus: row.currentStatus as EligibilityState,
    lifecycle: row.lifecycle,
  }));
}
