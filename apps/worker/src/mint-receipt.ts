/**
 * Post-broadcast truth for the mint fire path.
 *
 * Until now the worker treated an RPC's acceptance of a raw transaction as a
 * completed mint: `record("broadcast")` then `markMintPlanExecuted`. Mempool
 * acceptance only proves the transaction is well-formed and the nonce, fee
 * and balance are plausible — it proves nothing about whether it MINED, let
 * alone whether it reverted. A reverted mint was therefore recorded as a
 * success, the arm was consumed, and the operator was told they had the NFT.
 *
 * This module owns the two chain reads that close that gap. It never signs
 * and never broadcasts.
 */
import { createPublicClient, http } from "viem";

/** RPC budget per receipt poll. Deliberately short: this runs inside the
 *  fire window, where a hung endpoint costs the mint. */
const RECEIPT_RPC_TIMEOUT_MS = 800;

function client(rpcUrl: string) {
  return createPublicClient({
    transport: http(rpcUrl, { retryCount: 0, timeout: RECEIPT_RPC_TIMEOUT_MS }),
  });
}

export type ReceiptOutcome = "success" | "reverted" | "unknown";

/**
 * Poll for the receipt of a just-broadcast transaction.
 *
 * Returns "unknown" — never a guess — when the deadline passes with no
 * receipt. The caller must treat "unknown" as "still in flight", NOT as a
 * failure: re-arming a plan whose transaction may yet mine is how a wallet
 * mints twice.
 *
 * Robinhood Chain produces ~100ms blocks, so a few hundred ms of polling is
 * normally enough to see a receipt without meaningfully costing the window.
 */
export async function waitForMintReceipt(
  rpcUrl: string,
  txHash: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ReceiptOutcome> {
  const deadline = Date.now() + (opts.timeoutMs ?? 2_000);
  const pollMs = opts.pollMs ?? 120;
  const rpc = client(rpcUrl);
  for (;;) {
    try {
      const receipt = await rpc.getTransactionReceipt({ hash: txHash as `0x${string}` });
      if (receipt !== null && receipt !== undefined) {
        return receipt.status === "success" ? "success" : "reverted";
      }
    } catch {
      // viem throws TransactionReceiptNotFoundError until it is mined, and a
      // transport error is equally non-terminal here. Both mean "not yet".
    }
    if (Date.now() >= deadline) {
      return "unknown";
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Did a transaction we previously signed already make it onto the chain?
 *
 * Asked before re-signing after a stale-nonce rejection. "nonce too low" and
 * "already known" are indistinguishable between "the wallet sent something
 * else, our blob is dead" and "our OWN pre-signed transaction already
 * landed". Re-signing in the second case mints a second NFT at nonce+1 and
 * pays twice, so the ambiguity has to be resolved against the chain rather
 * than guessed from the error string.
 */
export async function resolveTxOutcome(rpcUrl: string, txHash: string): Promise<ReceiptOutcome> {
  try {
    const receipt = await client(rpcUrl).getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });
    if (receipt === null || receipt === undefined) {
      return "unknown";
    }
    // A landed transaction is NOT automatically a mint. An earlier version of
    // this function returned a bare boolean, so a transaction that landed and
    // REVERTED (a blob broadcast a hair early against a stage that had not
    // opened) was reported as "already minted" and the plan was marked
    // executed with the arm consumed and nothing in the wallet.
    return receipt.status === "success" ? "success" : "reverted";
  } catch {
    // Not found, or the endpoint is unreachable. "unknown" keeps the caller
    // on its cautious branch rather than asserting either outcome.
    return "unknown";
  }
}

/**
 * Pick the most meaningful rejection out of a `Promise.any` AggregateError.
 *
 * The broadcast races several endpoints, so `errors[0]` is simply whichever
 * URL sat first in the array — typically a slow proxy's transport error. The
 * caller classifies terminal-vs-retryable-vs-stale from this message, so
 * taking the arbitrary one silently mis-routes the decision: a masked
 * "nonce too low" turns into a spurious hard failure, and a masked
 * "insufficient funds" turns into an endless retry.
 */
export function pickBroadcastError(aggregate: unknown): Error {
  const errors =
    aggregate instanceof AggregateError
      ? aggregate.errors
      : aggregate === undefined
        ? []
        : [aggregate];
  const asErrors = errors.map((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  if (asErrors.length === 0) {
    return aggregate instanceof Error ? aggregate : new Error(String(aggregate));
  }
  // Most specific and most consequential first. Insufficient funds is
  // terminal (a retry cannot change the balance); a nonce/fee answer means
  // the blob is dead but the mint is still winnable; a revert reason is the
  // chain's own verdict. Anything else is transport noise.
  const priority: readonly RegExp[] = [
    /insufficient funds|insufficient balance/i,
    /nonce too low|nonce is too low|already known|replacement transaction underpriced|invalid nonce|nonce.*expected/i,
    /max fee per gas less than block base fee|fee cap less than block base fee|cannot be lower than the block base fee|transaction underpriced/i,
    /revert|execution reverted/i,
  ];
  for (const pattern of priority) {
    const hit = asErrors.find((e) => pattern.test(e.message));
    if (hit !== undefined) {
      return hit;
    }
  }
  return asErrors[0] as Error;
}
