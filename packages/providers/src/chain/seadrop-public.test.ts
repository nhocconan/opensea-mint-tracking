import { describe, expect, it } from "vitest";
import { buildMintPublicTx, mintableQuantity } from "./seadrop-public.ts";

const stats = (minted: number, total: number, max: number) => ({
  minterNumMinted: BigInt(minted),
  currentTotalSupply: BigInt(total),
  maxSupply: BigInt(max),
});

describe("mintableQuantity", () => {
  // maxTotalMintableByWallet is CUMULATIVE across every stage: SeaDrop checks
  // `minterNumMinted + quantity > cap`. A wallet that already took one in an
  // earlier phase has one fewer here — the exact arithmetic that blocked a
  // legitimate mint on 2026-09-16 when it was read from the wrong field.
  it("subtracts what the wallet already minted on this drop", () => {
    expect(
      mintableQuantity({
        requested: 2,
        drop: { maxTotalMintableByWallet: 2 },
        stats: stats(1, 100, 5000),
      }),
    ).toBe(1);
  });

  it("clamps to the remaining supply", () => {
    expect(
      mintableQuantity({
        requested: 5,
        drop: { maxTotalMintableByWallet: 20 },
        stats: stats(0, 4998, 5000),
      }),
    ).toBe(2);
  });

  it("returns 0 when the wallet is out of allowance", () => {
    expect(
      mintableQuantity({
        requested: 1,
        drop: { maxTotalMintableByWallet: 1 },
        stats: stats(1, 10, 5000),
      }),
    ).toBe(0);
  });

  it("returns 0 when the drop is sold out", () => {
    expect(
      mintableQuantity({
        requested: 1,
        drop: { maxTotalMintableByWallet: 20 },
        stats: stats(0, 5000, 5000),
      }),
    ).toBe(0);
  });

  it("never exceeds what was requested", () => {
    expect(
      mintableQuantity({
        requested: 1,
        drop: { maxTotalMintableByWallet: 50 },
        stats: stats(0, 0, 10000),
      }),
    ).toBe(1);
  });
});

describe("buildMintPublicTx", () => {
  const nft = "0x008c9d90f61a88178db5d7ae638aab81ef864e8b";
  const fee = "0x0000a26b00c1F0DF003000390027140000fAa719";

  it("encodes the mintPublic selector", () => {
    const tx = buildMintPublicTx({
      nftContract: nft,
      feeRecipient: fee,
      quantity: 1,
      mintPriceWei: 0n,
    });
    // 0x161ac21f = mintPublic(address,address,address,uint256), confirmed
    // against the deployed SeaDrop 1.0 on chain 4663.
    expect(tx.data.slice(0, 10)).toBe("0x161ac21f");
    expect(tx.to.toLowerCase()).toBe("0x00005ea00ac477b1030ce78506496e8c2de24bf5");
  });

  it("pays price × quantity — the fee is taken OUT of it, never added", () => {
    const tx = buildMintPublicTx({
      nftContract: nft,
      feeRecipient: fee,
      quantity: 2,
      mintPriceWei: 1_000_000_000_000_000n,
    });
    expect(tx.valueWei).toBe("2000000000000000");
  });

  it("sends zero value for a free mint", () => {
    const tx = buildMintPublicTx({
      nftContract: nft,
      feeRecipient: fee,
      quantity: 3,
      mintPriceWei: 0n,
    });
    expect(tx.valueWei).toBe("0");
  });
});
