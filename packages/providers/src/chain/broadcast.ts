/**
 * Chain-state gathering + broadcast for the delegated (server-side) signing
 * path (ADR 0004 Phase 2, custom_executor). Mirrors simulate.ts/gas.ts's own
 * separation: this module never signs anything — packages/signing owns
 * that exclusively — it only reads what a signer needs to build a valid
 * transaction (nonce, current fee levels) and, separately, submits an
 * already-signed raw transaction. No key material ever passes through here.
 */
import { createPublicClient, http } from "viem";
import { DEFAULT_RPC_TIMEOUT_MS } from "./simulate.ts";

/**
 * Fee bump applied to every estimate this module returns (ADR 0009
 * competitiveness). The pre-signed blob carries a fee snapshot taken up to
 * MINT_PRESIGN_TTL_MS (90s) before the open; a base-fee rise at the open
 * makes that exact blob unincludable ("max fee per gas less than block base
 * fee", or accepted and never mined). EIP-1559 charges only base+tip, so an
 * over-stated `maxFeePerGas` costs nothing extra when the base fee did NOT
 * rise — it is a ceiling, not a price. Integer numerators keep this exact
 * bigint arithmetic (no floats, no Number(), per AGENTS.md money rules).
 *
 * Mirrors MINT_FEE_MAX_MULTIPLIER / MINT_FEE_PRIORITY_MULTIPLIER in
 * packages/config (same defaults); packages/providers does not depend on
 * @hoodmint/config, so a caller that wants the env values passes them in.
 */
/**
 * Budget for eth_sendRawTransaction specifically, distinct from the 800ms
 * read budget. A send is the one call whose local timeout is genuinely
 * dangerous: an abort does NOT cancel the request, so a transaction the
 * sequencer already accepted can look like a failure to us — and the caller
 * then re-signs at the next nonce and mints twice. Reads are safe to cut
 * short; sends are not.
 */
export const DEFAULT_BROADCAST_TIMEOUT_MS = 2_500;

export const DEFAULT_FEE_MAX_MULTIPLIER = 3n;
export const DEFAULT_FEE_PRIORITY_MULTIPLIER = 2n;

export interface FeeContextOptions {
  /** Integer multiplier on maxFeePerGas. Default DEFAULT_FEE_MAX_MULTIPLIER. */
  readonly maxFeeMultiplier?: number;
  /** Integer multiplier on maxPriorityFeePerGas. Default DEFAULT_FEE_PRIORITY_MULTIPLIER. */
  readonly priorityFeeMultiplier?: number;
  /** RPC budget (ms). Default DEFAULT_RPC_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

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
  options: FeeContextOptions = {},
): Promise<FeeContext> {
  const client = createPublicClient({
    transport: http(rpcUrl, {
      retryCount: 0,
      timeout: options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
    }),
  });
  const [nonce, fees] = await Promise.all([
    client.getTransactionCount({ address: operatorAddress as `0x${string}`, blockTag: "pending" }),
    client.estimateFeesPerGas(),
  ]);
  // The bump lives HERE so every signer path (pre-signed fast path, managed
  // key, delegated executor) and the funding pre-check all price the same
  // ceiling — a wallet must hold gas × maxFeePerGas, so understating it in
  // one place and signing with it in another would arm an underfunded plan.
  const maxFeeMultiplier = toMultiplier(options.maxFeeMultiplier, DEFAULT_FEE_MAX_MULTIPLIER);
  const priorityMultiplier = toMultiplier(
    options.priorityFeeMultiplier,
    DEFAULT_FEE_PRIORITY_MULTIPLIER,
  );
  return {
    nonce,
    maxFeePerGasWei: (fees.maxFeePerGas * maxFeeMultiplier).toString(10),
    maxPriorityFeePerGasWei: (fees.maxPriorityFeePerGas * priorityMultiplier).toString(10),
  };
}

/**
 * Integer multipliers only: a fractional override would force float math on
 * wei. A non-integer or non-positive override falls back to the default
 * rather than silently truncating money math.
 */
function toMultiplier(value: number | undefined, fallback: bigint): bigint {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    return fallback;
  }
  return BigInt(value);
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
  timeoutMs?: number,
): Promise<BroadcastResult> {
  // Tight budget, no retry: the caller races several endpoints with
  // Promise.any, which resolves on the FIRST fulfilment and only rejects if
  // EVERY endpoint fails — so a timeout here drops one slow endpoint out of
  // the race and still lets a slower-but-alive sibling win. viem's 10s
  // default plus a retry would instead hold the whole mint window open.
  const client = createPublicClient({
    transport: http(rpcUrl, { retryCount: 0, timeout: timeoutMs ?? DEFAULT_BROADCAST_TIMEOUT_MS }),
  });
  const txHash = await client.sendRawTransaction({
    serializedTransaction: rawTx as `0x02${string}`,
  });
  return { txHash };
}
