import { describeConfig, safeLoadEnv } from "@hoodmint/config";
import { listProviders, pendingOutboxDepth, recentScanRuns } from "@hoodmint/db";
import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { envelope, problemFromError } from "@/lib/api.ts";
import { container } from "@/lib/container.ts";
import { getSessionUser } from "@/lib/session.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/system/status — header health snapshot: chain, last scan,
 * quota, outbox depth. Sanitized; no secrets (PRD §13 diagnostics rules).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
  try {
    const user = await getSessionUser();
    const { db, config } = container();

    const [providers, scans, outbox, dbLatency] = await Promise.all([
      listProviders(db).catch(() => []),
      recentScanRuns(db, 3).catch(() => []),
      pendingOutboxDepth(db).catch(() => -1),
      (async () => {
        const started = Date.now();
        await db.execute(sql`select 1`);
        return Date.now() - started;
      })().catch(() => -1),
    ]);

    const env = safeLoadEnv();
    return envelope({
      service: "hoodmint-radar",
      authed: user !== null,
      role: user?.role ?? null,
      config: env.ok ? describeConfig(env.config) : { invalid: env.issues },
      database: { latencyMs: dbLatency },
      providers: providers.map((p) => ({
        kind: p.kind,
        enabled: p.enabled,
        health: p.healthStatus,
        lastSuccessAt: p.lastSuccessAt,
        lastErrorCode: p.lastErrorCode,
      })),
      lastScans: scans.map((s) => ({
        kind: s.kind,
        status: s.status,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
      })),
      outboxPending: outbox,
      demoMode: config.DEMO_MODE,
    });
  } catch (error) {
    return problemFromError(error, correlationId);
  }
}
