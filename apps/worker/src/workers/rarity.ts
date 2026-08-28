/**
 * Trait rarity ranking (feature-backlog.md §2, shipped 2026-08-22).
 * Admin-triggered (rarity queue, one job per click — see actions.ts), not a
 * scheduled pass: OpenSea Read-quota cost scales with collection size, and
 * unlike discovery/eligibility there is no freshness requirement forcing a
 * background cadence — the admin refreshes when they actually want to look
 * at rarity for a specific project.
 *
 * Progress/outcome is recorded via the same scan_runs mechanism discovery
 * already uses (kind: "rarity:<projectId>"), so a truncated/failed refresh
 * is visible on Admin → Overview exactly like a failed discovery cycle,
 * with no new UI surface required for that.
 */
import { computeRarityScores, isAppError } from "@hoodmint/core";
import {
  finishScanRun,
  projects as projectsTable,
  saveRaritySnapshot,
  startScanRun,
} from "@hoodmint/db";
import { OpenSeaClient } from "@hoodmint/providers";
import { eq } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { resolveOpenSeaKey } from "../credentials.ts";

export interface RarityRefreshOutcome {
  readonly ok: boolean;
  readonly totalTokens: number;
  readonly truncated: boolean;
  readonly errorCode?: string;
}

// Covers the classic PFP-collection ceiling (BAYC/Doodles/Azuki/CryptoPunks
// etc. are all ⩽10k) at the client's max page size (100/page) — 100 pages ×
// 100 = 10,000 tokens. A collection larger than this is reported truncated
// (see listCollectionNfts's own doc comment) rather than silently ranked
// from a partial, non-random-order prefix.
const RARITY_MAX_PAGES = 100;
// Only the top-N rarest are persisted (rarity_snapshots is a summary
// snapshot, not a per-token table — see the schema comment); 25 is enough
// to fill an admin panel without storing a full collection's traits twice.
const TOP_N = 25;

export async function runRarityRefresh(
  ctx: WorkerContext,
  projectId: string,
): Promise<RarityRefreshOutcome> {
  const { db, config, log } = ctx;
  const scanRunId = await startScanRun(db, {
    providerId: null,
    kind: `rarity:${projectId}`,
    correlationId: crypto.randomUUID(),
  });

  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (project === undefined || project.slug === null) {
      await finishScanRun(db, scanRunId, { status: "failed", errorCode: "no_opensea_slug" });
      return { ok: false, totalTokens: 0, truncated: false, errorCode: "no_opensea_slug" };
    }

    const key = await resolveOpenSeaKey(db, config.APP_ENCRYPTION_KEY, config.OPENSEA_API_KEY);
    const client = new OpenSeaClient({
      apiKey: key.apiKey,
      apiKeys: key.apiKeys,
      perMinuteLimit: config.OPENSEA_PER_MINUTE_LIMIT,
    });
    const page = await client.listCollectionNfts(project.slug, {
      maxPagesOverride: RARITY_MAX_PAGES,
    });

    if (page.truncated) {
      // Do NOT save a snapshot from partial data — see listCollectionNfts's
      // doc comment: a truncated fetch's trait frequencies don't reflect
      // the true collection, so a ranking computed from it would be
      // actively misleading for a tool whose purpose is real mint
      // decisions. Reporting "too large to rank" is strictly better than a
      // plausible-looking wrong ranking.
      await finishScanRun(db, scanRunId, {
        status: "failed",
        errorCode: "collection_too_large",
        counts: { fetched: page.rows.length, pages: page.pages },
      });
      log.warn(
        { projectId, slug: project.slug, fetched: page.rows.length, pages: page.pages },
        "rarity refresh truncated — collection larger than the fetch cap, ranking not computed",
      );
      return {
        ok: false,
        totalTokens: page.rows.length,
        truncated: true,
        errorCode: "collection_too_large",
      };
    }

    const ranked = computeRarityScores(
      page.rows.map((row) => ({
        tokenId: row.identifier,
        traits: row.traits.map((t) => ({ traitType: t.trait_type, value: String(t.value) })),
      })),
    );
    const byId = new Map(page.rows.map((row) => [row.identifier, row]));
    const topRarest = ranked.slice(0, TOP_N).map((token) => ({
      tokenId: token.tokenId,
      rarityScore: token.rarityScore,
      rank: token.rank,
      traits: token.traits.map((t) => ({ traitType: t.traitType, value: t.value })),
      imageUrl:
        byId.get(token.tokenId)?.display_image_url ?? byId.get(token.tokenId)?.image_url ?? null,
    }));

    await saveRaritySnapshot(db, projectId, { totalTokens: ranked.length, topRarest });
    await finishScanRun(db, scanRunId, {
      status: page.malformed > 0 ? "partial" : "success",
      counts: { totalTokens: ranked.length, malformed: page.malformed, pages: page.pages },
    });
    return { ok: true, totalTokens: ranked.length, truncated: false };
  } catch (error) {
    const errorCode = isAppError(error) ? error.category : "unknown";
    await finishScanRun(db, scanRunId, { status: "failed", errorCode });
    log.error({ err: error, projectId }, "rarity refresh failed");
    return { ok: false, totalTokens: 0, truncated: false, errorCode };
  }
}
