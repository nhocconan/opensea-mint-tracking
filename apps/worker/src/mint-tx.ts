/**
 * Single source of truth for building an OpenSea SeaDrop mint transaction
 * (finding #8, code review 2026-08-23). Both the speculative pre-build pass
 * (P4) and the claim-time execution pass need the identical
 * resolveOpenSeaKey → OpenSeaClient → openSeaSeaDropAdapter →
 * buildTransaction sequence; having each hand-roll its own copy meant the
 * pre-built (cached) calldata was only valid so long as the two copies
 * stayed byte-identical — any drift silently caches/broadcasts a
 * mismatched transaction on the exact mint-race hot path P4 optimizes.
 * This is that sequence, once.
 */
import { openSeaSeaDropAdapter } from "@hoodmint/execution";
import { OpenSeaClient } from "@hoodmint/providers";
import type { WorkerContext } from "./context.ts";
import { resolveOpenSeaKey } from "./credentials.ts";

export interface BuiltMintTx {
  readonly to: string;
  readonly data: string;
  readonly valueWei: string;
  readonly chainId: number;
}

/**
 * Build the ready-to-broadcast SeaDrop mint tx for a plan's target. The
 * caller resolves project/wallet (both already do, for other reasons) and
 * passes the pieces — this owns only the shared OpenSea round-trip so the
 * cached and claim-time builds can never diverge.
 */
export async function buildOpenSeaMintTx(
  ctx: WorkerContext,
  input: { slug: string; chainId: number; minter: string; quantity: number },
): Promise<BuiltMintTx> {
  const { db, config } = ctx;
  const key = await resolveOpenSeaKey(db, config.APP_ENCRYPTION_KEY, config.OPENSEA_API_KEY);
  const client = new OpenSeaClient({ apiKey: key.apiKey });
  const adapter = openSeaSeaDropAdapter(client, input.slug);
  const tx = await adapter.buildTransaction({
    chainId: input.chainId,
    minter: input.minter,
    quantity: input.quantity,
  });
  return { to: tx.to, data: tx.data, valueWei: tx.valueWei, chainId: tx.chainId };
}
