/**
 * Chain-state gathering + broadcast for the delegated (server-side) signing
 * path (ADR 0004 Phase 2, custom_executor). Mirrors simulate.ts/gas.ts's own
 * separation: this module never signs anything — packages/signing owns
 * that exclusively — it only reads what a signer needs to build a valid
 * transaction (nonce, current fee levels) and, separately, submits an
 * already-signed raw transaction. No key material ever passes through here.
 */
import { createPublicClient, http } from "viem";

export interface FeeContext {
  readonly nonce: number;
  readonly maxFeePerGasWei: string;
  readonly maxPriorityFeePerGasWei: string;
}

/**
 * Everything packages/signing's `signExecutorTransaction` needs beyond the
 * mint calldata itself. Fetched fresh per attempt — never cached across
 * calls, since a stale nonce would simply fail to broadcast (safe) but a
 * stale fee estimate could under-price a time-sensitive mint-race
 * transaction (ADR 0009 competitiveness concern).
 */
export async function fetchFeeContext(
  rpcUrl: string,
  operatorAddress: string,
): Promise<FeeContext> {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1 }) });
  const [nonce, fees] = await Promise.all([
    client.getTransactionCount({ address: operatorAddress as `0x${string}`, blockTag: "pending" }),
    client.estimateFeesPerGas(),
  ]);
  return {
    nonce,
    maxFeePerGasWei: fees.maxFeePerGas.toString(10),
    maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas.toString(10),
  };
}

export interface BroadcastResult {
  readonly txHash: string;
}

/** Submit an already-signed raw transaction. Throws on RPC rejection (e.g.
 *  nonce-too-low from a lost race with another pending tx) — the caller
 *  records that as a failed execution attempt, same as any other broadcast
 *  failure; this module makes no retry decision of its own. */
export async function broadcastRawTransaction(
  rpcUrl: string,
  rawTx: string,
): Promise<BroadcastResult> {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1 }) });
  const txHash = await client.sendRawTransaction({
    serializedTransaction: rawTx as `0x02${string}`,
  });
  return { txHash };
}
