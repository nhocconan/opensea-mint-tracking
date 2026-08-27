/**
 * SeaDrop & mint-event signatures (PRD §7.1).
 *
 * OpenSea's SeaDrop implementation on every EVM network it deploys to lives
 * at 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5; generic ERC-721/1155 mints
 * are recognized by zero-address senders.
 */
export const SEADROP_ADDRESS = "0x00005ea00ac477b1030ce78506496e8c2de24bf5";

/** ERC-721 Transfer(address,address,uint256) */
export const ERC721_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** ERC-1155 TransferSingle(address,address,address,uint256,uint256) */
export const ERC1155_TRANSFER_SINGLE_TOPIC =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

/** ERC-1155 TransferBatch(address,address,address,uint256[],uint256[]) */
export const ERC1155_TRANSFER_BATCH_TOPIC =
  "0x4a39dc06d4c0dbc64b70b58deeb0eb1e6b49e6f3a6f0a3ba54a5eb02d7b630f6";

export const MINT_TOPICS = [
  ERC721_TRANSFER_TOPIC,
  ERC1155_TRANSFER_SINGLE_TOPIC,
  ERC1155_TRANSFER_BATCH_TOPIC,
] as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A mint is a Transfer whose `from` is the zero address or SeaDrop itself. */
export function isMintTransfer(from: string): boolean {
  return from.toLowerCase() === ZERO_ADDRESS || from.toLowerCase() === SEADROP_ADDRESS;
}
