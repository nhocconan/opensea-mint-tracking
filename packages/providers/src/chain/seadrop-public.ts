/**
 * Self-served mint calldata for SeaDrop PUBLIC stages.
 *
 * Verified on Robinhood Chain (4663) 2026-09-16 against the deployed SeaDrop
 * 1.0 at 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5:
 *
 *  - `mintPublic` needs no signature and no allowlist proof. An `eth_call`
 *    from an unrelated address succeeded on four live public drops.
 *  - `getPublicDrop(nft).startTime` is the gate the contract actually
 *    enforces (`block.timestamp >= startTime`), and it matched OpenSea's
 *    published schedule to the second on 6/6 collections sampled.
 *  - The `allowlist`-typed stages are NOT SeaDrop merkle allowlists
 *    (`getAllowListMerkleRoot` is zero on 40/40 collections); OpenSea
 *    implements them with `mintSigned`, whose 65-byte signature only
 *    0xfCe4b31128100915f2980BBC3a08894Ee5e8F8C3 can produce. Those stages
 *    therefore cannot be self-served and must keep going through OpenSea.
 *
 * So this module covers exactly the public half — where it removes the
 * OpenSea round trip, and with it OpenSea's own clock, from the fire path.
 */
import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";
import { SEADROP_ADDRESS, ZERO_ADDRESS } from "./seadrop.ts";
import { DEFAULT_RPC_TIMEOUT_MS } from "./simulate.ts";

export const SEADROP_PUBLIC_ABI = parseAbi([
  "function getPublicDrop(address nftContract) view returns ((uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
  "function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable",
]);

/** Lives on the NFT token contract, not on SeaDrop. */
export const SEADROP_TOKEN_ABI = parseAbi([
  "function getMintStats(address minter) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)",
]);

export interface PublicDrop {
  /** Wei per token. Zero for a free mint. */
  readonly mintPriceWei: bigint;
  /** Unix seconds; the contract gate is `block.timestamp >= startTime`. */
  readonly startTimeSec: number;
  readonly endTimeSec: number;
  /** CUMULATIVE across every stage — compare against getMintStats. */
  readonly maxTotalMintableByWallet: number;
  readonly feeBps: number;
  readonly restrictFeeRecipients: boolean;
}

export interface MintStats {
  readonly minterNumMinted: bigint;
  readonly currentTotalSupply: bigint;
  readonly maxSupply: bigint;
}

function client(rpcUrl: string, timeoutMs?: number) {
  return createPublicClient({
    transport: http(rpcUrl, { retryCount: 0, timeout: timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS }),
  });
}

export async function readPublicDrop(
  rpcUrl: string,
  nftContract: string,
  timeoutMs?: number,
): Promise<PublicDrop> {
  const raw = await client(rpcUrl, timeoutMs).readContract({
    address: SEADROP_ADDRESS as `0x${string}`,
    abi: SEADROP_PUBLIC_ABI,
    functionName: "getPublicDrop",
    args: [nftContract as `0x${string}`],
  });
  return {
    mintPriceWei: BigInt(raw.mintPrice),
    startTimeSec: Number(raw.startTime),
    endTimeSec: Number(raw.endTime),
    maxTotalMintableByWallet: Number(raw.maxTotalMintableByWallet),
    feeBps: Number(raw.feeBps),
    restrictFeeRecipients: raw.restrictFeeRecipients,
  };
}

/**
 * Read it, never hardcode it. Every collection sampled returned the same
 * single recipient, but `restrictFeeRecipients` is true everywhere, so a
 * wrong value reverts the mint.
 */
export async function readAllowedFeeRecipient(
  rpcUrl: string,
  nftContract: string,
  timeoutMs?: number,
): Promise<string | undefined> {
  const list = await client(rpcUrl, timeoutMs).readContract({
    address: SEADROP_ADDRESS as `0x${string}`,
    abi: SEADROP_PUBLIC_ABI,
    functionName: "getAllowedFeeRecipients",
    args: [nftContract as `0x${string}`],
  });
  return list[0];
}

export async function readMintStats(
  rpcUrl: string,
  nftContract: string,
  minter: string,
  timeoutMs?: number,
): Promise<MintStats> {
  const [minterNumMinted, currentTotalSupply, maxSupply] = await client(
    rpcUrl,
    timeoutMs,
  ).readContract({
    address: nftContract as `0x${string}`,
    abi: SEADROP_TOKEN_ABI,
    functionName: "getMintStats",
    args: [minter as `0x${string}`],
  });
  return { minterNumMinted, currentTotalSupply, maxSupply };
}

/**
 * The quantity this wallet may actually mint right now.
 *
 * `maxTotalMintableByWallet` is cumulative across every stage of the drop —
 * the contract checks `minterNumMinted + quantity > cap` — so a wallet that
 * already took one in an earlier phase has one fewer here. Also bounded by
 * what is left of the supply.
 */
export function mintableQuantity(input: {
  requested: number;
  drop: Pick<PublicDrop, "maxTotalMintableByWallet">;
  stats: Pick<MintStats, "minterNumMinted" | "currentTotalSupply" | "maxSupply">;
}): number {
  const perWalletLeft = input.drop.maxTotalMintableByWallet - Number(input.stats.minterNumMinted);
  const supplyLeft = Number(input.stats.maxSupply - input.stats.currentTotalSupply);
  return Math.max(0, Math.min(input.requested, perWalletLeft, supplyLeft));
}

export interface BuiltPublicMint {
  readonly to: string;
  readonly data: string;
  readonly valueWei: string;
}

/**
 * Pure: no network. Everything it needs was read at arm time, which is the
 * whole point — at the fire instant there is nothing left to fetch.
 */
export function buildMintPublicTx(input: {
  nftContract: string;
  feeRecipient: string;
  quantity: number;
  mintPriceWei: bigint;
  /** Defaults to the zero address, meaning "the payer is the minter". */
  minterIfNotPayer?: string;
}): BuiltPublicMint {
  const data = encodeFunctionData({
    abi: SEADROP_PUBLIC_ABI,
    functionName: "mintPublic",
    args: [
      input.nftContract as `0x${string}`,
      input.feeRecipient as `0x${string}`,
      (input.minterIfNotPayer ?? ZERO_ADDRESS) as `0x${string}`,
      BigInt(input.quantity),
    ],
  });
  return {
    to: SEADROP_ADDRESS,
    data,
    // The 10% fee is taken OUT of this amount, not added to it (verified on a
    // paid drop: value < price reverts IncorrectPayment, value == price
    // succeeds).
    valueWei: (input.mintPriceWei * BigInt(input.quantity)).toString(10),
  };
}
