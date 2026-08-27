/**
 * Wei discipline (PRD §14): quantities cross boundaries as decimal strings or
 * bigint; JS numbers are only allowed for derived, bounded display math after
 * conversion at the UI edge.
 */
import { asWei, type Wei } from "./brands.ts";

const DECIMAL = /^[0-9]+$/;

export function isWeiString(value: string): boolean {
  return DECIMAL.test(value);
}

/** Accepts decimal strings, bigint, or "0x" hex; rejects floats and negatives. */
export function toWei(value: string | bigint): Wei {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new RangeError("wei must be non-negative");
    }
    return asWei(value.toString(10));
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    return asWei(BigInt(trimmed).toString(10));
  }
  if (!DECIMAL.test(trimmed)) {
    throw new RangeError(`invalid wei value: ${value}`);
  }
  return asWei(trimmed);
}

export function weiToBigInt(value: Wei): bigint {
  return BigInt(value);
}

/**
 * Whole-token display string with fixed decimals, truncating excess precision
 * (display only — never used for accounting).
 */
export function formatWei(value: Wei, decimals = 18): string {
  const raw = weiToBigInt(value)
    .toString(10)
    .padStart(decimals + 1, "0");
  const whole = raw.slice(0, raw.length - decimals) || "0";
  const fraction = decimals > 0 ? raw.slice(-decimals).replace(/0+$/, "") : "";
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
