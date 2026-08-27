/**
 * Discovery cycle (PRD §7.1/§17 phase 2): resolve chain id → poll the three
 * feed types with pagination → normalize → persist transactionally with
 * provenance → refresh lifecycle → publish SSE invalidation → enqueue detail
 * refreshes for new/stale projects. Idempotent under at-least-once delivery:
 * all writes are upserts keyed by identity/alias.
 */
import { freshnessBucket, isAppError } from "@hoodmint/core";
import {
  ensureProvider,
  finishScanRun,
  getSetting,
  markProviderHealth,
  publishEvent,
  setSetting,
  startScanRun,
  upsertProjectFromSource,
} from "@hoodmint/db";
import { metrics } from "@hoodmint/observability";
import { normalizeDropRow, OpenSeaClient } from "@hoodmint/providers";
import { enqueueDetail, QUEUE_NAMES } from "@hoodmint/queues";
import type { WorkerContext } from "../context.ts";
import { resolveOpenSeaKey } from "../credentials.ts";

export interface DiscoveryOutcome {
  readonly feedType: string;
  readonly found: number;
  readonly created: number;
  readonly malformed: number;
  readonly ok: boolean;
  readonly errorCode?: string;
}

export async function runDiscoveryCycle(
  ctx: WorkerContext,
  feedType: "featured" | "upcoming" | "recently_minted",
): Promise<DiscoveryOutcome> {
  const { db, config, log } = ctx;
  const provider = await ensureProvider(db, "opensea");
  const scanRunId = await startScanRun(db, {
    providerId: provider.id,
    kind: `discovery:${feedType}`,
    correlationId: crypto.randomUUID(),
  });
  const started = Date.now();

  try {
    if (!provider.enabled) {
      await finishScanRun(db, scanRunId, { status: "success", counts: { skipped: 1 } });
      return { feedType, found: 0, created: 0, malformed: 0, ok: true, errorCode: "disabled" };
    }

    const key = await resolveOpenSeaKey(db, config.APP_ENCRYPTION_KEY, config.OPENSEA_API_KEY);
    const client = new OpenSeaClient({
      apiKey: key.apiKey,
      maxPages: config.OPENSEA_MAX_PAGES,
      hourlyLimit: config.OPENSEA_HOURLY_LIMIT,
      reservePercent: config.OPENSEA_RATE_RESERVE_PERCENT,
    });

    // Chain identifier resolution with cross-restart cache (PRD §7.1).
    let chainSlug = await getSetting<string>(db, "opensea_chain_slug");
    if (chainSlug === undefined) {
      chainSlug = await client.resolveChainIdentifier(config.OPENSEA_CHAIN_FALLBACK);
      await setSetting(db, "opensea_chain_slug", chainSlug);
    }
    const now = new Date();
    const result = await client.listDrops(feedType, chainSlug, { localChainFilter: true });

    let created = 0;
    for (const row of result.rows) {
      const draft = normalizeDropRow(row, {
        chainId: config.ROBINHOOD_CHAIN_ID,
        now,
        feedType,
      });
      const upserted = await upsertProjectFromSource(db, draft);
      if (upserted.created) {
        created += 1;
        // Fresh projects get a detail refresh immediately for full stages.
        await enqueueDetail(config.VALKEY_URL, {
          slug: row.collection_slug,
          freshnessBucket: "hot",
        }).catch(() => undefined);
      } else {
        const bucket = freshnessBucket(
          draft.stages.map((s) => ({
            label: s.label,
            kind: s.kind,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt?.toISOString() ?? null,
            paused: s.paused,
          })),
          now.toISOString(),
        );
        await enqueueDetail(config.VALKEY_URL, {
          slug: row.collection_slug,
          freshnessBucket: bucket,
        }).catch(() => undefined);
      }
    }

    await finishScanRun(db, scanRunId, {
      status: result.malformed > 0 ? "partial" : "success",
      counts: {
        found: result.rows.length,
        created,
        malformed: result.malformed,
        pages: result.pages,
      },
    });
    await markProviderHealth(db, "opensea", "healthy", { lastSuccessAt: now });
    metrics().inc("hoodmint_scans_total", {
      provider: "opensea",
      feed: feedType,
      outcome: "success",
    });
    metrics().inc(
      "hoodmint_scans_seconds_total",
      { provider: "opensea", feed: feedType },
      (Date.now() - started) / 1000,
    );
    metrics().set("hoodmint_rate_limit_remaining", client.rateLimit().remaining ?? -1, {
      provider: "opensea",
    });
    await publishEvent(db, {
      type: "scan.completed",
      providerKind: "opensea",
      at: now.toISOString(),
    });
    await publishEvent(db, { type: "projects.invalidated", at: now.toISOString() });

    return { feedType, found: result.rows.length, created, malformed: result.malformed, ok: true };
  } catch (error) {
    const errorCode = isAppError(error) ? error.category : "unknown";
    await finishScanRun(db, scanRunId, { status: "failed", errorCode });
    await markProviderHealth(db, "opensea", "down", { errorCode });
    metrics().inc("hoodmint_scans_total", {
      provider: "opensea",
      feed: feedType,
      outcome: "failure",
    });
    metrics().inc("hoodmint_provider_errors_total", { provider: "opensea", category: errorCode });
    log.error({ err: error, feedType, errCode: errorCode }, "discovery cycle failed");
    return { feedType, found: 0, created: 0, malformed: 0, ok: false, errorCode };
  }
}

/** Detail refresh (PRD §8.4 details queue): authoritative stage schedule. */
export async function runDetailRefresh(ctx: WorkerContext, slug: string): Promise<void> {
  const { db, config } = ctx;
  const key = await resolveOpenSeaKey(db, config.APP_ENCRYPTION_KEY, config.OPENSEA_API_KEY);
  const client = new OpenSeaClient({ apiKey: key.apiKey });
  const payload = await client.getDrop(slug);
  const { normalizeDropDetail } = await import("@hoodmint/providers");
  const draft = normalizeDropDetail(payload, {
    chainId: config.ROBINHOOD_CHAIN_ID,
    now: new Date(),
  });
  await upsertProjectFromSource(db, draft);
  await publishEvent(db, { type: "projects.invalidated", at: new Date().toISOString() });
}

export const DISCOVERY_QUEUE = QUEUE_NAMES.discovery;
