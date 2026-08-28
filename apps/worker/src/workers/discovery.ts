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
import { normalizeCollectionRow, normalizeDropRow, OpenSeaClient } from "@hoodmint/providers";
import {
  enqueueDetail,
  enqueueDiscovery,
  QUEUE_NAMES,
  scheduledDiscoveryJobs,
} from "@hoodmint/queues";
import type { WorkerContext } from "../context.ts";
import { invalidateInstantKeyOnAuthFailure, resolveOpenSeaKey } from "../credentials.ts";

/**
 * Discovery scheduler (PRD §8.4): enqueues one deterministic-id discovery
 * job per feed type ("featured", "upcoming", "recently_minted") every
 * `DISCOVERY_INTERVAL_SECONDS`. Registered as an `every(...)` interval loop
 * in the worker entrypoint (like eligibility/chain-sync/rpc-health) rather
 * than a BullMQ repeatable job — that loop already runs one pass at
 * startup, so a fresh install populates immediately without any extra
 * scheduling primitive.
 */
export async function scheduleDiscovery(ctx: WorkerContext): Promise<void> {
  const { config } = ctx;
  const jobs = scheduledDiscoveryJobs(Date.now(), config.DISCOVERY_INTERVAL_SECONDS * 1000);
  for (const job of jobs) {
    await enqueueDiscovery(config.VALKEY_URL, job);
  }
}

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
      apiKeys: key.apiKeys,
      perMinuteLimit: config.OPENSEA_PER_MINUTE_LIMIT,
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
    if (errorCode === "AuthRequired") {
      // A dead free instant key never rotates on its own (its expires_at is
      // still in the future) — drop it so the next cycle bootstraps a fresh one.
      const rotated = await invalidateInstantKeyOnAuthFailure(
        db,
        await resolveOpenSeaKey(db, config.APP_ENCRYPTION_KEY, config.OPENSEA_API_KEY),
      ).catch(() => false);
      if (rotated) {
        log.warn(
          { feedType },
          "OpenSea instant key rejected (401) — revoked; re-provisioning next cycle",
        );
      }
    }
    return { feedType, found: 0, created: 0, malformed: 0, ok: false, errorCode };
  }
}

/**
 * Chain-wide collection discovery (finds ALL Robinhood Chain collections, not
 * just the curated `/drops` feed). Resolves the chain slug (shared cross-
 * restart cache with `runDiscoveryCycle`), sweeps `GET /api/v2/collections`
 * newest-first, upserts each row as a project via `upsertProjectFromSource`,
 * and enqueues a hot detail refresh so `runDetailRefresh` fills in
 * stages/eligibility for the ones that ARE SeaDrop drops. Idempotent: upserts
 * are keyed by contract/alias, detail jobs by deterministic id. Bounded per
 * pass by `COLLECTION_DISCOVERY_MAX_PAGES` (page count) and
 * `COLLECTION_DISCOVERY_MAX_TOTAL` (row ceiling) so it can never create tens
 * of thousands of jobs — or exhaust the free OpenSea quota — in one tick.
 */
export async function runCollectionDiscovery(ctx: WorkerContext): Promise<DiscoveryOutcome> {
  const { db, config, log } = ctx;
  const feedType = "collections";
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
      apiKeys: key.apiKeys,
      perMinuteLimit: config.OPENSEA_PER_MINUTE_LIMIT,
      maxPages: config.COLLECTION_DISCOVERY_MAX_PAGES,
      hourlyLimit: config.OPENSEA_HOURLY_LIMIT,
      reservePercent: config.OPENSEA_RATE_RESERVE_PERCENT,
    });

    let chainSlug = await getSetting<string>(db, "opensea_chain_slug");
    if (chainSlug === undefined) {
      chainSlug = await client.resolveChainIdentifier(config.OPENSEA_CHAIN_FALLBACK);
      await setSetting(db, "opensea_chain_slug", chainSlug);
    }
    const now = new Date();
    const result = await client.listCollections(chainSlug, {
      maxPages: config.COLLECTION_DISCOVERY_MAX_PAGES,
    });
    // Hard per-pass ceiling on top of the page cap (newest first, so the cap
    // keeps the freshest collections).
    const rows = result.rows.slice(0, config.COLLECTION_DISCOVERY_MAX_TOTAL);

    let created = 0;
    for (const row of rows) {
      const draft = normalizeCollectionRow(row, { chainId: config.ROBINHOOD_CHAIN_ID, now });
      const upserted = await upsertProjectFromSource(db, draft);
      if (upserted.created) {
        created += 1;
        // Detail refresh ONLY for newly discovered collections: it's what
        // promotes the ones that are drops to a full schedule. Re-enqueuing
        // all ~400 swept rows every pass was the single biggest source of
        // OpenSea 429s (each detail job is a getDrop call). Existing drops
        // are refreshed on the freshness-bucket cadence by the /drops
        // discovery cycle instead.
        await enqueueDetail(config.VALKEY_URL, { slug: row.slug, freshnessBucket: "hot" }).catch(
          () => undefined,
        );
      }
    }

    await finishScanRun(db, scanRunId, {
      status: result.malformed > 0 ? "partial" : "success",
      counts: {
        found: rows.length,
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

    return { feedType, found: rows.length, created, malformed: result.malformed, ok: true };
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
    log.error({ err: error, feedType, errCode: errorCode }, "collection discovery failed");
    if (errorCode === "AuthRequired") {
      await invalidateInstantKeyOnAuthFailure(
        db,
        await resolveOpenSeaKey(db, config.APP_ENCRYPTION_KEY, config.OPENSEA_API_KEY),
      ).catch(() => false);
    }
    return { feedType, found: 0, created: 0, malformed: 0, ok: false, errorCode };
  }
}

/** Detail refresh (PRD §8.4 details queue): authoritative stage schedule. */
export async function runDetailRefresh(ctx: WorkerContext, slug: string): Promise<void> {
  const { db, config, log } = ctx;
  const key = await resolveOpenSeaKey(db, config.APP_ENCRYPTION_KEY, config.OPENSEA_API_KEY);
  const client = new OpenSeaClient({
    apiKey: key.apiKey,
    apiKeys: key.apiKeys,
    perMinuteLimit: config.OPENSEA_PER_MINUTE_LIMIT,
  });
  let payload: unknown;
  try {
    payload = await client.getDrop(slug);
  } catch (error) {
    // A collection discovered via the chain-wide sweep may not be a SeaDrop
    // drop at all — `/drops/{slug}` then 404s. That is expected, not a
    // failure: leave the collection as a discovered project with no stages
    // rather than crashing the details pass (which would retry the job).
    if (isAppError(error) && error.category === "NotFound") {
      log.debug({ slug }, "detail refresh: slug is not a drop (404), leaving as collection");
      return;
    }
    throw error;
  }
  const { normalizeDropDetail } = await import("@hoodmint/providers");
  const draft = normalizeDropDetail(payload, {
    chainId: config.ROBINHOOD_CHAIN_ID,
    now: new Date(),
  });
  await upsertProjectFromSource(db, draft);
  await publishEvent(db, { type: "projects.invalidated", at: new Date().toISOString() });
}

export const DISCOVERY_QUEUE = QUEUE_NAMES.discovery;
