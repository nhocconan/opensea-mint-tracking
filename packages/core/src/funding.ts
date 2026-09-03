/**
 * Pure funding checks for a managed-wallet mint (2026-09-02, after the
 * Chill Guys special mint expired on OpenSea's `422 Insufficient balance to
 * mint`): decide BEFORE arming / pre-signing whether a wallet can actually
 * pay for the mint, so the operator hears "top up" hours early instead of
 * an EXPIRED row after the drop. Framework-free so the web arm action, the
 * worker presign pass and the tests all share one definition of "enough".
 */

/** Placeholder addresses OpenSea/SeaDrop use for the chain's native coin. */
const NATIVE_CURRENCY_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

/** True when a stage's `currency` means "pay in the native coin" (null, zero
 *  address, or the 0xeeee… convention). Anything else is an ERC-20. */
export function isNativeCurrency(currency: string | null | undefined): boolean {
  if (currency === null || currency === undefined || currency.trim() === "") {
    return true;
  }
  return NATIVE_CURRENCY_ADDRESSES.has(currency.trim().toLowerCase());
}

export interface FundingInput {
  /** Wallet's native balance (wei). */
  readonly nativeBalanceWei: bigint;
  /** Native value the mint tx sends (price × qty + OpenSea fee), wei. */
  readonly valueWei: bigint;
  /** Gas limit the tx will carry. */
  readonly gasLimit: bigint;
  /** maxFeePerGas the tx will carry (wei). */
  readonly maxFeePerGasWei: bigint;
  /** Set when the stage is priced in an ERC-20 (USDG on Robinhood Chain). */
  readonly erc20?: {
    readonly balance: bigint;
    readonly required: bigint;
    /** Omit when the spender is not known yet (before OpenSea's `/mint`
     *  answer names the SeaDrop contract). */
    readonly allowance?: bigint | undefined;
    readonly symbol?: string | undefined;
    readonly decimals?: number | undefined;
  };
}

export type FundingVerdict =
  | { readonly ok: true; readonly gasReserveWei: bigint; readonly requiredNativeWei: bigint }
  | {
      readonly ok: false;
      readonly reason: "insufficient_native" | "insufficient_erc20" | "erc20_allowance";
      readonly requiredNativeWei: bigint;
      readonly shortfallWei: bigint;
      /** Operator-facing sentence (no secrets, safe for attempt rows/UI). */
      readonly message: string;
    };

/** Whole-token display with up to 6 decimals, truncating — display only. */
export function formatUnitsShort(value: bigint, decimals = 18, maxFraction = 6): string {
  const negative = value < 0n;
  const raw = (negative ? -value : value).toString(10).padStart(decimals + 1, "0");
  const whole = raw.slice(0, raw.length - decimals) || "0";
  const fraction = raw
    .slice(raw.length - decimals)
    .slice(0, maxFraction)
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

/**
 * Can this wallet pay `value + gasLimit × maxFeePerGas` in native coin (and
 * the ERC-20 price, when the stage is token-priced)? Gas is reserved at the
 * full max fee: the fast path signs with a fixed gas limit and never gets to
 * refund a shortfall, so anything less would still be refused by the RPC as
 * "insufficient funds for gas * price + value".
 */
export function assessMintFunding(input: FundingInput): FundingVerdict {
  const gasReserveWei = input.gasLimit * input.maxFeePerGasWei;
  const requiredNativeWei = input.valueWei + gasReserveWei;
  if (input.nativeBalanceWei < requiredNativeWei) {
    const shortfallWei = requiredNativeWei - input.nativeBalanceWei;
    return {
      ok: false,
      reason: "insufficient_native",
      requiredNativeWei,
      shortfallWei,
      message: `insufficient_funds: wallet holds ${formatUnitsShort(input.nativeBalanceWei)} ETH, needs ${formatUnitsShort(requiredNativeWei)} ETH (mint ${formatUnitsShort(input.valueWei)} + gas reserve ${formatUnitsShort(gasReserveWei)}) — top up ${formatUnitsShort(shortfallWei)} ETH`,
    };
  }
  const erc20 = input.erc20;
  if (erc20 !== undefined) {
    const symbol = erc20.symbol ?? "token";
    const decimals = erc20.decimals ?? 18;
    if (erc20.balance < erc20.required) {
      const shortfall = erc20.required - erc20.balance;
      return {
        ok: false,
        reason: "insufficient_erc20",
        requiredNativeWei,
        shortfallWei: shortfall,
        message: `insufficient_funds: wallet holds ${formatUnitsShort(erc20.balance, decimals)} ${symbol}, mint price needs ${formatUnitsShort(erc20.required, decimals)} ${symbol} — top up ${formatUnitsShort(shortfall, decimals)} ${symbol}`,
      };
    }
    if (erc20.allowance !== undefined && erc20.allowance < erc20.required) {
      return {
        ok: false,
        reason: "erc20_allowance",
        requiredNativeWei,
        shortfallWei: erc20.required - erc20.allowance,
        message: `erc20_allowance: the mint contract may spend ${formatUnitsShort(erc20.allowance, decimals)} ${symbol} but the price is ${formatUnitsShort(erc20.required, decimals)} ${symbol} — approve the SeaDrop contract from this wallet first`,
      };
    }
  }
  return { ok: true, gasReserveWei, requiredNativeWei };
}

/**
 * Provider/RPC answers that mean "this wallet cannot pay" — terminal for the
 * current fire (retrying every 200 ms only burns OpenSea quota until the
 * window expires, which is exactly what happened on 2026-08-30). Matches
 * OpenSea's `Insufficient balance to mint` 422 and viem/geth's
 * `insufficient funds for gas * price + value`.
 */
export function isInsufficientFundsError(message: string): boolean {
  return /insufficient (balance|funds)/i.test(message);
}
