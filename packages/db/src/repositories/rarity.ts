/**
 * Trait rarity ranking (feature-backlog.md §2, shipped 2026-08-22). This
 * repo layer is pure DB read/write — it never touches OpenSea itself. The
 * fetch-collection + computeRarityScores orchestration lives in the caller
 * (an admin-triggered worker job) because packages/db intentionally has no
 * dependency on @hoodmint/providers (see packages/db/package.json — the
 * on-chain/off-chain provider boundary is enforced at the package graph
 * level, not just by convention).
 */
import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { raritySnapshots } from "../schema.ts";

export interface RarestToken {
  readonly tokenId: string;
  readonly rarityScore: number;
  readonly rank: number;
  readonly traits: { traitType: string; value: string }[];
  readonly imageUrl: string | null;
}

export interface RaritySnapshot {
  readonly totalTokens: number;
  readonly topRarest: readonly RarestToken[];
  readonly computedAt: Date;
}

/** Upsert the single current snapshot — same one-row-per-project shape as holderSnapshots. */
export async function saveRaritySnapshot(
  db: Db,
  projectId: string,
  snapshot: { totalTokens: number; topRarest: readonly RarestToken[] },
): Promise<void> {
  const topRarest = [...snapshot.topRarest];
  await db
    .insert(raritySnapshots)
    .values({
      projectId,
      totalTokens: snapshot.totalTokens,
      topRarest,
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: raritySnapshots.projectId,
      set: {
        totalTokens: snapshot.totalTokens,
        topRarest,
        computedAt: new Date(),
      },
    });
}

/** Read the current snapshot. Returns null if rarity has never been computed for this project. */
export async function getRaritySnapshot(db: Db, projectId: string): Promise<RaritySnapshot | null> {
  const [row] = await db
    .select()
    .from(raritySnapshots)
    .where(eq(raritySnapshots.projectId, projectId))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  return {
    totalTokens: row.totalTokens,
    topRarest: row.topRarest,
    computedAt: row.computedAt,
  };
}
