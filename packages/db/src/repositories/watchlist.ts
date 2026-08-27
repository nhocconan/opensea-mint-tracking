import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { watchlistEntries } from "../schema.ts";

export async function isWatched(db: Db, userId: string, projectId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: watchlistEntries.userId })
    .from(watchlistEntries)
    .where(and(eq(watchlistEntries.userId, userId), eq(watchlistEntries.projectId, projectId)))
    .limit(1);
  return rows.length > 0;
}

export async function watchedProjectIds(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ projectId: watchlistEntries.projectId })
    .from(watchlistEntries)
    .where(eq(watchlistEntries.userId, userId));
  return new Set(rows.map((r) => r.projectId));
}

export async function toggleWatch(db: Db, userId: string, projectId: string): Promise<boolean> {
  const existing = await db
    .select({ userId: watchlistEntries.userId })
    .from(watchlistEntries)
    .where(and(eq(watchlistEntries.userId, userId), eq(watchlistEntries.projectId, projectId)))
    .limit(1);
  if (existing.length > 0) {
    await db
      .delete(watchlistEntries)
      .where(and(eq(watchlistEntries.userId, userId), eq(watchlistEntries.projectId, projectId)));
    return false;
  }
  await db.insert(watchlistEntries).values({ userId, projectId }).onConflictDoNothing();
  return true;
}

/** All watchers of a project — used for watched-live / nearing-sellout alerts. */
export async function watchersOfProject(db: Db, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: watchlistEntries.userId })
    .from(watchlistEntries)
    .where(eq(watchlistEntries.projectId, projectId));
  return rows.map((r) => r.userId);
}
