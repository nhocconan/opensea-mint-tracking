/**
 * MintAdapters (ADR 0005): each knows how to turn "mint N of this project"
 * into a {to, data, valueWei} the pipeline can simulate and, eventually,
 * hand to a signer. This module never signs or broadcasts anything.
 */
import type { OpenSeaClient } from "@hoodmint/providers";
import type { PreparedTransaction } from "@hoodmint/signing";

export interface BuildTransactionInput {
  readonly chainId: number;
  readonly minter: string;
  readonly quantity: number;
}

export interface MintAdapter {
  readonly kind: "opensea_seadrop";
  buildTransaction(input: BuildTransactionInput): Promise<PreparedTransaction>;
}

/**
 * ADR 0004 amendment: prefer OpenSea's own mint API over hand-rolled
 * SeaDrop calldata for OpenSea-hosted drops. OpenSea computes calldata
 * server-side, already accounting for the correct stage/proof — this
 * adapter never constructs SeaDrop calldata itself.
 */
export function openSeaSeaDropAdapter(client: OpenSeaClient, collectionSlug: string): MintAdapter {
  return {
    kind: "opensea_seadrop",
    async buildTransaction(input: BuildTransactionInput): Promise<PreparedTransaction> {
      const tx = await client.buildDropMintTransaction(collectionSlug, {
        minter: input.minter,
        quantity: input.quantity,
      });
      return {
        chainId: input.chainId,
        to: tx.target,
        data: tx.calldata,
        valueWei: tx.valueWei,
        expectedFrom: input.minter,
      };
    },
  };
}
