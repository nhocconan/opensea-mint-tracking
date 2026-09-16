/**
 * Pre-flight transaction simulation (ADR 0005): a mandatory, non-bypassable
 * stage of the execution pipeline, in every phase, permanently — a
 * reverting or failed simulation blocks progression to policy-check/signing
 * unconditionally. This module never signs or broadcasts anything; it only
 * asks the chain "would this call succeed right now."
 */
import { type Address, createPublicClient, http } from "viem";

/**
 * RPC budget for the fire path (ADR 0009 competitiveness). viem's default is
 * a 10s timeout, and with `retryCount: 1` a single hung endpoint can block
 * for ~20s — the fire "continue window" is only MINT_FIRE_CONTINUE_MS (4s),
 * so one unhealthy RPC would eat the entire mint window. 800ms, no retry:
 * losing a slow endpoint fast is strictly better than waiting for it, and
 * the broadcast path races several endpoints anyway.
 *
 * NOT read from @hoodmint/config here: packages/providers does not depend on
 * @hoodmint/config (adding that dependency would mean editing package.json
 * and would pull env parsing into a package imported by apps/web). The
 * matching env var MINT_RPC_TIMEOUT_MS exists in packages/config with the
 * same default, for a caller that wants to override via `timeoutMs`.
 */
/**
 * Default read budget. Was 800ms; raised after the 2026-09-15 21:00 GTD,
 * where `eth_getTransactionCount` exceeded 800ms TWICE at the open — the
 * public Robinhood RPC is saturated at exactly the instant every bot on the
 * chain is minting. A short budget does not make a slow endpoint fast; it
 * converts a slow success into a hard failure and forfeits the attempt.
 * The fire path no longer has a read on its critical path anyway (fees and
 * nonce are prefetched during the signature burst), so a longer budget costs
 * latency nowhere and buys resilience where it was losing races.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 2_500;

export interface SimulateTransactionInput {
  readonly rpcUrl: string;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly valueWei: string;
  /** Override the RPC budget (ms). Defaults to DEFAULT_RPC_TIMEOUT_MS. */
  readonly timeoutMs?: number;
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
  const client = createPublicClient({
    transport: http(input.rpcUrl, {
      retryCount: 0,
      timeout: input.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
    }),
  });
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
