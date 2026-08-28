/**
 * RPC endpoint health-check pass (ADR 0009, mint-race competitiveness,
 * item P2): the admin-configurable RPC registry (ADR 0006 —
 * `packages/db/src/repositories/rpc.ts`, `packages/core/src/execution.ts`'s
 * `rankRpcEndpoints`) and its admin UI already existed, but nothing ever
 * called `recordRpcEndpointHealth`, so every endpoint's `healthStatus` sat
 * permanently at its "unknown" default and `rankRpcEndpoints` had nothing
 * real to rank on. This closes that gap: periodically probe every enabled
 * endpoint's gas price + latency (the same `getGasSnapshot` the admin UI
 * already displays) and persist a health classification, so the hot-path
 * RPC selection in `chain.ts`/`execution.ts` has real data to rank by.
 */
import { rankRpcEndpoints } from "@hoodmint/core";
import { type Db, listRpcEndpoints, recordRpcEndpointHealth } from "@hoodmint/db";
import { classifyLatency, getGasSnapshot } from "@hoodmint/providers";
import type { WorkerContext } from "../context.ts";

export interface RpcHealthSummary {
  readonly checked: number;
  readonly healthy: number;
  readonly degraded: number;
  readonly down: number;
}

// classifyLatency's own "fast"/"normal"/"slow" is a display-only class for
// the admin gas widget, not a healthStatus value — down here means the
// probe itself failed (endpoint unreachable/erroring), not merely slow;
// "slow but responding" still counts as degraded, not down, since a slow
// endpoint can still be a usable last resort.
function toHealthStatus(latencyMs: number): "healthy" | "degraded" {
  return classifyLatency(latencyMs) === "slow" ? "degraded" : "healthy";
}

export async function runRpcHealthCheck(ctx: WorkerContext): Promise<RpcHealthSummary> {
  const { db, log } = ctx;
  const endpoints = await listRpcEndpoints(db);
  const enabled = endpoints.filter((e) => e.enabled);

  let healthy = 0;
  let degraded = 0;
  let down = 0;

  // Sequential, not Promise.all: this is a periodic background pass (not
  // on the mint-firing hot path — P1/P2's actual latency win is in the
  // *consumers* of this data, not this checker itself), and sequential
  // keeps failing/slow endpoints from delaying the probe of healthy ones
  // sharing the same event loop tick.
  for (const endpoint of enabled) {
    try {
      const snapshot = await getGasSnapshot(endpoint.httpUrl);
      const status = toHealthStatus(snapshot.latencyMs);
      await recordRpcEndpointHealth(db, endpoint.id, status, { lastSuccessAt: new Date() });
      if (status === "healthy") {
        healthy += 1;
      } else {
        degraded += 1;
      }
    } catch (error) {
      down += 1;
      const errorCode = error instanceof Error ? error.message.slice(0, 200) : "probe_failed";
      await recordRpcEndpointHealth(db, endpoint.id, "down", { errorCode });
      log.warn({ endpointId: endpoint.id, errorCode }, "rpc health probe failed");
    }
  }

  return { checked: enabled.length, healthy, degraded, down };
}

/**
 * The actual hot-path consumer of the health data above (ADR 0009, P2):
 * pick the best-ranked enabled endpoint for this chain, falling back to
 * the legacy single `RPC_URL` env var when the registry is empty (fresh
 * install, nothing configured yet) — never a hard failure just because no
 * admin has added a custom endpoint.
 */
/**
 * Every non-down endpoint for the chain (ranked best-first) plus the env
 * fallback, deduped, capped — for RACE BROADCAST of a pre-signed mint tx
 * (ADR 0009): the same raw tx is sent to all of them at once and the first
 * acceptance wins. Duplicates are harmless (same tx hash; a FIFO sequencer
 * dedupes), and it removes any single RPC's queueing/latency from the
 * critical path — the contested-mint edge a premium endpoint buys.
 */
export async function resolveBroadcastRpcUrls(
  db: Db,
  chainId: number,
  fallback: string | undefined,
  max = 4,
): Promise<string[]> {
  const endpoints = await listRpcEndpoints(db, chainId);
  const ranked = rankRpcEndpoints(endpoints, chainId).filter((e) => e.healthStatus !== "down");
  const urls: string[] = [];
  for (const e of ranked) {
    if (!urls.includes(e.httpUrl)) {
      urls.push(e.httpUrl);
    }
  }
  if (fallback !== undefined && fallback !== "" && !urls.includes(fallback)) {
    urls.push(fallback);
  }
  return urls.slice(0, max);
}

export async function resolveBestRpcUrl(
  db: Db,
  chainId: number,
  fallback: string | undefined,
): Promise<string | undefined> {
  const endpoints = await listRpcEndpoints(db, chainId);
  const ranked = rankRpcEndpoints(endpoints, chainId);
  // Skip known-DOWN endpoints — a single dead registry endpoint must never
  // shadow a working env RPC_URL (finding #6, code review 2026-08-23):
  // routing chain-sync / clock-calibration / the fire path to a dead
  // endpoint every cycle, including at fire time, is worse than the plain
  // fallback. "unknown" (never yet probed) is deliberately NOT skipped —
  // it may be perfectly fine, and skipping it would sideline a
  // freshly-added endpoint before its first health probe lands.
  const best = ranked.find((e) => e.healthStatus !== "down");
  return best?.httpUrl ?? fallback;
}
