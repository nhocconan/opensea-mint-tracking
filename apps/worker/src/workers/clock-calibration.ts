/**
 * Clock calibration pass (ADR 0009, mint-race competitiveness, item P5):
 * periodically compare this worker's own clock against the chain's, so
 * "how close is stage start" scheduling decisions (P4's speculative
 * pre-build trigger, and any future stage-timing precision work) can
 * correct for drift instead of trusting the worker's raw OS clock.
 */
import { CHAIN_CLOCK_OFFSET_SETTING_KEY, computeClockOffsetMs } from "@hoodmint/core";
import { getSetting, setSetting } from "@hoodmint/db";
import { createPublicClient, http } from "viem";
import type { WorkerContext } from "../context.ts";
import { resolveBestRpcUrl } from "./rpc-health.ts";

/**
 * Settings-table key holding the epoch-ms instant the offset above was
 * measured, so a consumer can detect a stale calibration. Stored under its
 * OWN key rather than folding `{offsetMs, measuredAt}` into
 * CHAIN_CLOCK_OFFSET_SETTING_KEY: that key is read as a bare number by
 * apps/worker/src/workers/execution.ts, and changing its shape would break
 * that reader.
 */
export const CHAIN_CLOCK_OFFSET_MEASURED_AT_SETTING_KEY = "chain_clock_offset_measured_at_ms";

/** How many block probes one calibration pass takes (see MIN rationale). */
const CLOCK_SAMPLE_COUNT = 5;

export interface ClockCalibrationResult {
  readonly measured: boolean;
  readonly offsetMs?: number;
}

export async function runClockCalibration(ctx: WorkerContext): Promise<ClockCalibrationResult> {
  const { db, config, log } = ctx;
  const rpcUrl = await resolveBestRpcUrl(db, config.ROBINHOOD_CHAIN_ID, config.RPC_URL);
  if (!rpcUrl) {
    return { measured: false };
  }
  try {
    const client = createPublicClient({
      transport: http(rpcUrl, { retryCount: 1, timeout: 5_000 }),
    });
    // A single probe measures local drift PLUS the age of the latest block
    // PLUS EVM's 1-second timestamp truncation — all three push the offset
    // POSITIVE, so a one-shot reading is biased late and every fire derived
    // from it is targeted late by that bias. Both nuisance terms are
    // non-negative and vary between probes, so across k samples the MINIMUM
    // offset is the one taken closest to its block's real production time:
    // the least-stale, least-biased estimate. Sequential (not parallel) so
    // each sample gets a fresh `Date.now()`/`getBlock()` pair rather than
    // k readings of the same block at the same instant.
    let offsetMs: number | null = null;
    for (let i = 0; i < CLOCK_SAMPLE_COUNT; i += 1) {
      const localNowMs = Date.now();
      const block = await client.getBlock();
      const sample = computeClockOffsetMs(localNowMs, Number(block.timestamp));
      if (offsetMs === null || sample < offsetMs) {
        offsetMs = sample;
      }
    }
    if (offsetMs === null) {
      return { measured: false };
    }
    await setSetting(db, CHAIN_CLOCK_OFFSET_SETTING_KEY, offsetMs);
    await setSetting(db, CHAIN_CLOCK_OFFSET_MEASURED_AT_SETTING_KEY, Date.now());
    return { measured: true, offsetMs };
  } catch (error) {
    log.warn(
      { errorCode: error instanceof Error ? error.message.slice(0, 200) : "unknown" },
      "clock calibration probe failed",
    );
    return { measured: false };
  }
}

/**
 * Read the last-measured offset, defaulting to 0 (assume no drift) if
 * calibration hasn't run yet or the setting is somehow missing — never a
 * hard failure for a caller doing a scheduling estimate.
 */
export async function getChainClockOffsetMs(db: WorkerContext["db"]): Promise<number> {
  const stored = await getSetting<number>(db, CHAIN_CLOCK_OFFSET_SETTING_KEY);
  return stored ?? 0;
}
