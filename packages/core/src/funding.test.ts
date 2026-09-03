import { describe, expect, it } from "vitest";
import {
  assessMintFunding,
  formatUnitsShort,
  isInsufficientFundsError,
  isNativeCurrency,
} from "./funding.ts";

const ETH = 1_000_000_000_000_000_000n;

describe("isNativeCurrency", () => {
  it("treats null, empty, zero address and 0xeeee… as native", () => {
    expect(isNativeCurrency(null)).toBe(true);
    expect(isNativeCurrency(undefined)).toBe(true);
    expect(isNativeCurrency("")).toBe(true);
    expect(isNativeCurrency("0x0000000000000000000000000000000000000000")).toBe(true);
    expect(isNativeCurrency(`0x${"E".repeat(40)}`)).toBe(true);
  });
  it("treats a real token address as ERC-20", () => {
    expect(isNativeCurrency("0x5fc5360d0400a0fd4f2af552add042d716f1d168")).toBe(false);
  });
});

describe("assessMintFunding", () => {
  const base = {
    valueWei: ETH / 1000n, // 0.001 ETH
    gasLimit: 300_000n,
    maxFeePerGasWei: 1_000_000_000n, // 1 gwei → 0.0003 ETH reserve
  };

  it("passes when balance covers value + gas reserve", () => {
    const verdict = assessMintFunding({ ...base, nativeBalanceWei: ETH / 100n });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.gasReserveWei).toBe(300_000_000_000_000n);
      expect(verdict.requiredNativeWei).toBe(1_300_000_000_000_000n);
    }
  });

  it("fails on an exact shortfall of one wei, reporting the top-up amount", () => {
    const required = 1_300_000_000_000_000n;
    const verdict = assessMintFunding({ ...base, nativeBalanceWei: required - 1n });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("insufficient_native");
      expect(verdict.shortfallWei).toBe(1n);
      expect(verdict.message).toMatch(/^insufficient_funds: /);
      expect(verdict.message).toContain("needs 0.0013 ETH");
    }
  });

  it("passes at exactly the required amount", () => {
    expect(assessMintFunding({ ...base, nativeBalanceWei: 1_300_000_000_000_000n }).ok).toBe(true);
  });

  it("reserves gas even for a free mint", () => {
    const verdict = assessMintFunding({ ...base, valueWei: 0n, nativeBalanceWei: 0n });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.requiredNativeWei).toBe(300_000_000_000_000n);
    }
  });

  it("fails on ERC-20 balance shortfall with token units", () => {
    const verdict = assessMintFunding({
      ...base,
      nativeBalanceWei: ETH,
      erc20: { balance: 4_000_000n, required: 5_000_000n, symbol: "USDG", decimals: 6 },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("insufficient_erc20");
      expect(verdict.message).toContain("holds 4 USDG");
      expect(verdict.message).toContain("needs 5 USDG");
    }
  });

  it("fails on a missing ERC-20 allowance only when the spender is known", () => {
    const funded = {
      ...base,
      nativeBalanceWei: ETH,
      erc20: { balance: 10_000_000n, required: 5_000_000n, symbol: "USDG", decimals: 6 },
    };
    expect(assessMintFunding(funded).ok).toBe(true);
    const verdict = assessMintFunding({
      ...funded,
      erc20: { ...funded.erc20, allowance: 0n },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("erc20_allowance");
    }
  });
});

describe("formatUnitsShort", () => {
  it("truncates to six decimals and trims zeros", () => {
    expect(formatUnitsShort(1_234_567_890_000_000_000n)).toBe("1.234567");
    expect(formatUnitsShort(ETH)).toBe("1");
    expect(formatUnitsShort(0n)).toBe("0");
    expect(formatUnitsShort(80_000_000_000_000n)).toBe("0.00008");
    expect(formatUnitsShort(1_500_000n, 6)).toBe("1.5");
  });
});

describe("isInsufficientFundsError", () => {
  it("matches OpenSea's 422 body and the RPC insufficient-funds rejection", () => {
    expect(
      isInsufficientFundsError(
        'provider returned 422: { "errors" : [ "Insufficient balance to mint" ] }',
      ),
    ).toBe(true);
    expect(isInsufficientFundsError("insufficient funds for gas * price + value")).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isInsufficientFundsError("nonce too low")).toBe(false);
    expect(isInsufficientFundsError("drop is fully minted out")).toBe(false);
  });
});
