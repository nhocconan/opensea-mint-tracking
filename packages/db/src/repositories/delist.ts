/**
 * Delisted drops (found live 2026-08-28): OpenSea hides a collection on the
 * website but keeps it in the API — the reliable tell is that
 * `GET /api/v2/drops/{slug}` starts answering 404 for a project that used to
 * have a schedule. We keep the row (history, radar, signals) but take it out
 * of the live/next/calendar feeds: lifecycle → ENDED, future stages paused,
 * next_stage_start cleared.
 */
import { and, eq, sql } from "drizzle-orm";
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
      stages: sql<number>`(select count(*)::int from drop_stages ds where ds.project_id = ${projects.id})`,
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
