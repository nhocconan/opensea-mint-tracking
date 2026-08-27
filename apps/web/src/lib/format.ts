/**
 * UI-boundary formatting (PRD §14): all stored times are UTC; locale
 * conversion happens only here. Wei display truncates to 4 significant
 * decimals; addresses are shown short with copy affordance elsewhere.
 */
import { coerceDate, formatWei, type Wei } from "@hoodmint/core";

/** Re-exported for call sites already importing from here — see @hoodmint/core's coerceDate for why this exists. */
export const toDate = coerceDate;

export function formatDateTimeUtc(iso: string | Date | null): string {
  if (iso === null) {
    return "—";
  }
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDateTimeLocal(iso: string | Date | null): string {
  if (iso === null) {
    return "—";
  }
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatPrice(wei: string | null): string {
  if (wei === null || wei === "0") {
    return "FREE";
  }
  const formatted = formatWei(wei as Wei, 18);
  const trimmed = formatted.slice(0, 8);
  return `${trimmed} ETH`;
}

export function formatSupply(minted: string | null, max: string | null, verified: boolean): string {
  if (minted === null) {
    return "—";
  }
  const mintedNum = Number(BigInt(minted));
  if (max === null || !verified) {
    return `${mintedNum.toLocaleString()} minted (no verified cap)`;
  }
  const maxNum = Number(BigInt(max));
  const pct = maxNum === 0 ? 0 : Math.floor((mintedNum / maxNum) * 100);
  return `${mintedNum.toLocaleString()}/${maxNum.toLocaleString()} (${pct}%)`;
}

export function formatVelocity(quantity: number, unique: number): string {
  if (quantity === 0) {
    return "—";
  }
  return `${quantity} mints · ${unique} wallets (1h)`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
