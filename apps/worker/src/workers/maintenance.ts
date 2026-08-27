/**
 * Maintenance pass (PRD §8.4/§13): retention per policy, stale marking,
 * instant-key rotation, quota logging. Everything here is idempotent and safe
 * to run at-least-once.
 */

import { markProviderHealth, unwrapRows } from "@hoodmint/db";
import { metrics } from "@hoodmint/observability";
import { sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { resolveOpenSeaKey } from "../credentials.ts";

export interface MaintenanceSummary {
  evidenceDeleted: number;
  scanRunsDeleted: number;
  mintEventsDeleted: number;
  instantKeyRotated: boolean;
}

// Local rowsOf replaced by the centralized unwrapRows (finding #10) — see
// its doc comment for why the naive `.rows ?? []` silently reported every
// retention count as 0.
const rowsOf = (result: unknown): { id: string }[] => unwrapRows<{ id: string }>(result);

export async function runMaintenance(ctx: WorkerContext): Promise<MaintenanceSummary> {
  const { db, config, log } = ctx;

  const evidence = await db.execute(
    sql`delete from evidence where fetched_at < now() - interval '30 days' returning id`,
  );
  const scanRuns = await db.execute(
    sql`delete from scan_runs where started_at < now() - interval '90 days' returning id`,
  );
  const mintEvents = await db.execute(
    sql`delete from mint_events where observed_at < now() - interval '180 days' returning id`,
  );

  // Stale marking: discovery healthy in the last 3 cycles stays 'healthy';
  // older than 2h without success degrades.
  await db.execute(
    sql`update providers set health_status = 'degraded'
         where kind = 'opensea'
           and (last_success_at is null or last_success_at < now() - interval '2 hours')
           and health_status = 'healthy'`,
  );

  // Instant key rotation: resolveOpenSeaKey rotates when <24h remain.
  let rotated = false;
  try {
    const key = await resolveOpenSeaKey(db, config.APP_ENCRYPTION_KEY, config.OPENSEA_API_KEY);
    rotated = key.instant;
  } catch {
    log.warn("instant key rotation check failed (non-fatal)");
  }

  metrics().inc("hoodmint_scans_total", {
    provider: "maintenance",
    feed: "hourly",
    outcome: "success",
  });
  return {
    evidenceDeleted: rowsOf(evidence).length,
    scanRunsDeleted: rowsOf(scanRuns).length,
    mintEventsDeleted: rowsOf(mintEvents).length,
    instantKeyRotated: rotated,
  };
}

/** Periodic provider health pings used by /metrics freshness gauges. */
export async function refreshProviderFreshness(ctx: WorkerContext): Promise<void> {
  const { db } = ctx;
  const rows = await db.execute(
    sql`select kind, extract(epoch from (now() - last_success_at)) as age from providers where last_success_at is not null`,
  );
  // Centralized unwrap (finding #10) — the naive `.rows ?? []` meant this
  // loop silently never ran, so hoodmint_provider_freshness_seconds was
  // never set.
  const freshnessRows = unwrapRows<{ kind: string; age: string }>(rows);
  for (const row of freshnessRows) {
    metrics().set("hoodmint_provider_freshness_seconds", Math.floor(Number(row.age)), {
      provider: row.kind,
    });
  }
  void markProviderHealth;
}
