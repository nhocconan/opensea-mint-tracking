/**
 * Pre-flight transaction simulation (ADR 0005): a mandatory, non-bypassable
 * stage of the execution pipeline, in every phase, permanently — a
 * reverting or failed simulation blocks progression to policy-check/signing
 * unconditionally. This module never signs or broadcasts anything; it only
 * asks the chain "would this call succeed right now."
 */
import { type Address, createPublicClient, http } from "viem";

export interface SimulateTransactionInput {
  readonly rpcUrl: string;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly valueWei: string;
}

export type SimulationResult =
  | { readonly ok: true; readonly gasEstimate: bigint }
  | { readonly ok: false; readonly revertReason: string };

/** Best-effort revert reason extraction across viem's error shapes. */
export function extractRevertReason(error: unknown): string {
  if (error instanceof Error) {
    const withShortMessage = error as Error & { shortMessage?: string };
    return (withShortMessage.shortMessage ?? error.message).slice(0, 300);
  }
  return "simulation failed: unknown error";
}

/**
 * eth_call (would it revert) + eth_estimateGas (what would it cost), against
 * *current* chain state — never trust a cached/scheduled stage window alone.
 * Both must succeed for `ok: true`; either failing is treated as a blocked
 * plan, per ADR 0005's non-bypassable simulation gate.
 */
export async function simulateTransaction(
  input: SimulateTransactionInput,
): Promise<SimulationResult> {
  const client = createPublicClient({ transport: http(input.rpcUrl, { retryCount: 1 }) });
  const call = {
    account: input.from as Address,
    to: input.to as Address,
    data: input.data as `0x${string}`,
    value: BigInt(input.valueWei),
  };
  try {
    // ADR 0009 (mint-race competitiveness), item P1: eth_call and
    // eth_estimateGas are independent reads against the same chain state
    // — running them in parallel halves this stage's wall time for free.
    // Promise.all still rejects (and this still returns ok:false) if
    // EITHER call fails, so ADR 0005's "both must succeed" / "simulate is
    // never bypassable" semantics are unchanged.
    const [, gasEstimate] = await Promise.all([client.call(call), client.estimateGas(call)]);
    return { ok: true, gasEstimate };
  } catch (error) {
    return { ok: false, revertReason: extractRevertReason(error) };
  }
}
