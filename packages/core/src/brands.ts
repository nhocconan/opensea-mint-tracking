/**
 * Branded nominal types for values whose confusion would be a data-truth bug
 * (PRD §14): mixing a chain id with a block number, or a wei amount with a
 * token count, must be a compile error, not a silent rounding surprise.
 */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ChainId = Brand<number, "ChainId">;
export type BlockNumber = Brand<bigint, "BlockNumber">;
/** Decimal string of wei; never a JS number (PRD §14). */
export type Wei = Brand<string, "Wei">;
export type Address = Brand<string, "Address">;
export type ProjectId = Brand<string, "ProjectId">;
export type StageId = Brand<string, "StageId">;
/** UTC ISO-8601 timestamp string, always Z-suffixed. */
export type UtcTimestamp = Brand<string, "UtcTimestamp">;

export const asChainId = (value: number): ChainId => value as ChainId;
export const asBlockNumber = (value: bigint): BlockNumber => value as BlockNumber;
export const asWei = (value: string): Wei => value as Wei;
export const asAddress = (value: string): Address => value as Address;
export const asProjectId = (value: string): ProjectId => value as ProjectId;
export const asStageId = (value: string): StageId => value as StageId;
export const asUtcTimestamp = (value: string): UtcTimestamp => value as UtcTimestamp;
