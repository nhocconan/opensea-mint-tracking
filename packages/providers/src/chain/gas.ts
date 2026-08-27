/**
 * Gas price / RPC latency snapshot (feature backlog: "Gas / RPC health
 * widget"). Robinhood Chain (4663) is a ~5-week-old single-sequencer L2
 * with no existing gas-tracker coverage (Blocknative et al. don't cover
 * it) — a latency/gas spike right before a competitive mint window is
 * exactly the readiness signal a personal assistant should surface. This
 * is a read — never a transaction, never a spend decision on its own.
 */
import { createPublicClient, http } from "viem";

export interface GasSnapshot {
  readonly gasPriceWei: bigint;
  readonly latencyMs: number;
}

export async function getGasSnapshot(rpcUrl: string): Promise<GasSnapshot> {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 5_000 }) });
  const start = Date.now();
  const gasPriceWei = await client.getGasPrice();
  return { gasPriceWei, latencyMs: Date.now() - start };
}

export type LatencyClass = "fast" | "normal" | "slow";

const FAST_MS = 300;
const SLOW_MS = 1500;

/** Pure threshold classifier — no network, fully testable. */
export function classifyLatency(latencyMs: number): LatencyClass {
  if (latencyMs <= FAST_MS) {
    return "fast";
  }
  if (latencyMs >= SLOW_MS) {
    return "slow";
  }
  return "normal";
}
