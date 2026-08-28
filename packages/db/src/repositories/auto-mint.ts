/**
 * Auto-mint planner data access (packages/core/auto-mint.ts decides; this
 * file only reads candidates/state and never arms anything itself).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { dropStages, mintPlans, projects, signals, wallets } from "../schema.ts";

/** Qualified outer-row reference for select-list subqueries (see note in the query). */
const PID = sql.raw('"projects"."id"');

export interface AutoMintStageRow {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectSlug: string;
  readonly stageId: string;
  readonly stageKind: string;
  readonly priceWei: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly paused: boolean;
  readonly riskScore: number | null;
  readonly hypeScore: number | null;
  readonly curated: boolean;
  readonly uniqueMinters1h: number;
}

/**
 * Stages on LIVE/NEXT drops that are open now or open within `lookaheadHours`
 * and not ended, with the project's latest Grok risk score. Price filtering
 * is left to the pure decision fn (it needs bigint compare).
 */
export async function autoMintCandidateStages(
  db: Db,
  lookaheadHours: number,
  limit = 300,
): Promise<AutoMintStageRow[]> {
  const rows = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      projectSlug: projects.slug,
      stageId: dropStages.id,
      stageKind: dropStages.type,
      priceWei: dropStages.priceWei,
      startsAt: dropStages.startsAt,
      endsAt: dropStages.endsAt,
      paused: dropStages.paused,
      // NOTE: correlated subselects in a select list must reference the outer
      // row via sql.raw('"projects"."id"') — `${projects.id}` renders as a bare
      // "id" here and would resolve to the subquery's own table (found live
      // 2026-08-28), which would make every candidate look un-curated / unscanned.
      riskScore: sql<number | null>`
        (select s.score from signals s
          where s.project_id = ${PID} and s.kind = 'risk'
          order by s.observed_at desc limit 1)`,
      hypeScore: sql<number | null>`
        (select s.score from signals s
          where s.project_id = ${PID} and s.kind = 'hype'
          order by s.observed_at desc limit 1)`,
      // Listed by OpenSea's own curated /drops feeds (featured / upcoming /
      // recently_minted) — vs. only found by the chain-wide collection sweep.
      curated: sql<boolean>`
        exists (select 1 from evidence e
          where e.project_id = ${PID} and e.kind like 'drops:%')`,
      uniqueMinters1h: sql<number>`
        coalesce((select count(distinct m.recipient)::int from mint_events m
          where m.project_id = ${PID}
            and m.observed_at > now() - interval '1 hour'), 0)`,
    })
    .from(dropStages)
    .innerJoin(projects, eq(projects.id, dropStages.projectId))
    .where(
      and(
        inArray(projects.lifecycleStatus, ["LIVE", "NEXT"]),
        sql`${projects.slug} is not null`,
        eq(dropStages.paused, false),
        sql`(${dropStages.endsAt} is null or ${dropStages.endsAt} > now())`,
        sql`${dropStages.startsAt} < now() + make_interval(hours => ${lookaheadHours})`,
      ),
    )
    .orderBy(dropStages.startsAt)
    .limit(limit);
  return rows.map((r) => ({ ...r, projectSlug: r.projectSlug as string }));
}

/** Managed (has a sealed signing key), enabled wallets among the given ids. */
export async function managedWalletsAmong(db: Db, walletIds: readonly string[]) {
  if (walletIds.length === 0) {
    return [];
  }
  return db
    .select({ id: wallets.id, address: wallets.address, label: wallets.label })
    .from(wallets)
    .where(
      and(
        inArray(wallets.id, [...walletIds]),
        eq(wallets.enabled, true),
        sql`${wallets.encryptedSigningKey} is not null`,
      ),
    );
}

/**
 * Whether this wallet already has a plan for this stage that should block a
 * new one: any non-terminal plan, or one that already executed. Expired /
 * cancelled / failed plans don't block (the planner may retry, bounded by
 * `attemptsForStage`).
 */
export async function blockingPlanExists(
  db: Db,
  walletId: string,
  stageId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: mintPlans.id })
    .from(mintPlans)
    .where(
      and(
        eq(mintPlans.walletId, walletId),
        eq(mintPlans.stageId, stageId),
        inArray(mintPlans.status, ["draft", "armed", "executing", "executed"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function attemptsForStage(db: Db, walletId: string, stageId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mintPlans)
    .where(and(eq(mintPlans.walletId, walletId), eq(mintPlans.stageId, stageId)));
  return rows[0]?.count ?? 0;
}

/** Executed auto-mints on this wallet in the rolling 24h (daily cap). */
export async function executedLast24h(db: Db, walletId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mintPlans)
    .where(
      and(
        eq(mintPlans.walletId, walletId),
        eq(mintPlans.status, "executed"),
        sql`${mintPlans.updatedAt} > now() - interval '24 hours'`,
      ),
    );
  return rows[0]?.count ?? 0;
}

/** Latest risk score for a project (for UI / decision explanations). */
export async function latestRiskScore(db: Db, projectId: string): Promise<number | null> {
  const [row] = await db
    .select({ score: signals.score })
    .from(signals)
    .where(and(eq(signals.projectId, projectId), eq(signals.kind, "risk")))
    .orderBy(desc(signals.observedAt))
    .limit(1);
  return row?.score ?? null;
}
