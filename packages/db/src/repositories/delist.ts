/**
 * Delisted drops (found live 2026-08-28): OpenSea hides a collection on the
 * website but keeps it in the API — the reliable tell is that
 * `GET /api/v2/drops/{slug}` starts answering 404 for a project that used to
 * have a schedule. We keep the row (history, radar, signals) but take it out
 * of the live/next/calendar feeds: lifecycle → ENDED, future stages paused,
 * next_stage_start cleared.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { dropStages, projects } from "../schema.ts";

export async function markProjectDelisted(db: Db, projectId: string): Promise<void> {
  await db
    .update(dropStages)
    .set({ paused: true })
    .where(and(eq(dropStages.projectId, projectId), sql`${dropStages.startsAt} > now()`));
  await db
    .update(projects)
    .set({ lifecycleStatus: "ENDED", nextStageStart: null, lastSeenAt: new Date() })
    .where(eq(projects.id, projectId));
}

/** Project id + whether it ever had a schedule (i.e. was a drop). */
export async function projectBySlugWithStageCount(
  db: Db,
  slug: string,
): Promise<{ id: string; stages: number; lifecycle: string } | undefined> {
  const [row] = await db
    .select({
      id: projects.id,
      lifecycle: projects.lifecycleStatus,
      // `sql.raw('"projects"."id"')`, NOT `${projects.id}`: inside a select-list
      // subquery Drizzle renders the latter as an unqualified "id", which
      // resolves to ds.id and silently returns 0 (found live 2026-08-28 — it
      // hid every delisting).
      stages: sql<number>`(select count(*)::int from drop_stages ds where ds.project_id = ${sql.raw('"projects"."id"')})`,
    })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return row;
}

/** Slugs of LIVE/NEXT drops, for the periodic delisting/freshness re-check. */
export async function liveNextSlugs(db: Db, limit = 300): Promise<string[]> {
  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(
      and(sql`${projects.lifecycleStatus} in ('LIVE', 'NEXT')`, sql`${projects.slug} is not null`),
    )
    .orderBy(projects.nextStageStart)
    .limit(limit);
  return rows.map((r) => r.slug as string);
}

/** Record that `/drops/{slug}` was consulted for this slug (any answer). */
export async function markProjectDropChecked(db: Db, slug: string, at: Date): Promise<void> {
  await db.update(projects).set({ dropCheckedAt: at }).where(eq(projects.slug, slug));
}

/**
 * Recently discovered collections that still carry no stage schedule —
 * candidates for a periodic `/drops/{slug}` re-check. A collection swept
 * minutes after creation is usually asked about its drop BEFORE the creator
 * has published the SeaDrop stages; without this, it stays a stage-less
 * "collection" forever and never reaches the feeds (yolkies-nft, 2026-09-02).
 * Least-recently-checked first so a bounded batch rotates through the whole
 * window instead of re-asking the same newest slugs every pass.
 */
export async function stagelessRecentCollectionSlugs(
  db: Db,
  input: { firstSeenAfter: Date; limit: number },
): Promise<string[]> {
  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(
      and(
        sql`${projects.slug} is not null`,
        eq(projects.lifecycleStatus, "UNKNOWN"),
        sql`${projects.firstSeenAt} >= ${input.firstSeenAfter.toISOString()}`,
        sql`not exists (select 1 from drop_stages ds where ds.project_id = ${sql.raw('"projects"."id"')})`,
      ),
    )
    .orderBy(sql`${projects.dropCheckedAt} asc nulls first`, desc(projects.firstSeenAt))
    .limit(input.limit);
  return rows.map((r) => r.slug as string);
}
