/**
 * Build a SeaDrop `mintPublic` transaction without asking OpenSea.
 *
 * Returns a discriminated result rather than `undefined`-on-everything: a
 * sold-out drop and an unreadable RPC are not the same event, and collapsing
 * them sent both down the 12-second OpenSea burst at the one instant that
 * matters, letting the verdict depend on OpenSea's error string.
 */
import { isNativeCurrency } from "@hoodmint/core";
import type { Db } from "@hoodmint/db";
import { dropStages as dropStagesTable } from "@hoodmint/db";
import {
  buildMintPublicTx,
  mintableQuantity,
  readAllowedFeeRecipient,
  readMintStats,
  readPublicDrop,
} from "@hoodmint/providers";
import { eq } from "drizzle-orm";
import { withRpcFailover } from "./mint-rpc.ts";

export interface SelfServedTx {
  readonly to: string;
  readonly data: string;
  readonly valueWei: string;
  readonly chainId: number;
  readonly expectedFrom: string;
}

export type SelfServedResult =
  | {
      kind: "built";
      tx: SelfServedTx;
      /** The gate the CONTRACT enforces: block.timestamp >= this. */
      onChainStartMs: number;
      onChainEndMs: number;
      requestedQuantity: number;
      quantity: number;
    }
  /** Not a self-servable stage — fall back silently, nothing is wrong. */
  | { kind: "not_self_servable" }
  | { kind: "sold_out" }
  | { kind: "allowance_exhausted" }
  | { kind: "read_failed"; message: string };

export async function buildSelfServedPublicMint(input: {
  rpcUrls: readonly string[];
  stageId: string | null;
  db: Db;
  contractAddress: string | null;
  minter: string;
  quantity: number;
  chainId: number;
  /** SeaDrop credits msg.sender unless told otherwise; an Executor contract
   *  is the payer but not the intended holder. */
  minterIfNotPayer?: string;
}): Promise<SelfServedResult> {
  if (input.stageId === null || input.contractAddress === null) {
    return { kind: "not_self_servable" };
  }
  const [stage] = await input.db
    .select({ type: dropStagesTable.type, currency: dropStagesTable.currency })
    .from(dropStagesTable)
    .where(eq(dropStagesTable.id, input.stageId))
    .limit(1);
  if (stage?.type !== "public") {
    // A signed stage: only OpenSea's signer can produce the 65-byte signature.
    return { kind: "not_self_servable" };
  }
  if (!isNativeCurrency(stage.currency)) {
    // SeaDrop 1.0's mintPublic is native-only and demands EXACT payment, so a
    // token-priced stage cannot be served here at all.
    return { kind: "not_self_servable" };
  }
  const nft = input.contractAddress;
  try {
    const [drop, feeRecipient, stats] = await Promise.all([
      withRpcFailover(input.rpcUrls, (url) => readPublicDrop(url, nft, 4_000)),
      withRpcFailover(input.rpcUrls, (url) => readAllowedFeeRecipient(url, nft, 4_000)),
      withRpcFailover(input.rpcUrls, (url) => readMintStats(url, nft, input.minter, 4_000)),
    ]);
    if (feeRecipient === undefined) {
      // restrictFeeRecipients is true on every collection observed, so a
      // guessed recipient reverts FeeRecipientNotAllowed.
      return { kind: "not_self_servable" };
    }
    if (stats.currentTotalSupply >= stats.maxSupply) {
      return { kind: "sold_out" };
    }
    const quantity = mintableQuantity({ requested: input.quantity, drop, stats });
    if (quantity < 1) {
      return { kind: "allowance_exhausted" };
    }
    const built = buildMintPublicTx({
      nftContract: nft,
      feeRecipient,
      quantity,
      mintPriceWei: drop.mintPriceWei,
      ...(input.minterIfNotPayer !== undefined ? { minterIfNotPayer: input.minterIfNotPayer } : {}),
    });
    return {
      kind: "built",
      tx: { ...built, chainId: input.chainId, expectedFrom: input.minter },
      onChainStartMs: drop.startTimeSec * 1000,
      onChainEndMs: drop.endTimeSec * 1000,
      requestedQuantity: input.quantity,
      quantity,
    };
  } catch (error) {
    return {
      kind: "read_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
