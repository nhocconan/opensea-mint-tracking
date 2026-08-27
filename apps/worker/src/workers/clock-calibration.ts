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
    const localNowMs = Date.now();
    const block = await client.getBlock();
    const offsetMs = computeClockOffsetMs(localNowMs, Number(block.timestamp));
    await setSetting(db, CHAIN_CLOCK_OFFSET_SETTING_KEY, offsetMs);
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
