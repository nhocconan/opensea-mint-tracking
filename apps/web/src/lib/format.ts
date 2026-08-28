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

/**
 * The operator's own wall clock (Asia/Ho_Chi_Minh, a fixed UTC+07:00 with no
 * DST). Storage stays UTC everywhere (PRD §14); this is a display-only
 * projection, always rendered alongside the UTC value so a mint time can
 * never be read ambiguously. `hourCycle: "h23"` and `formatToParts` pin the
 * output shape across ICU versions instead of trusting a locale's default
 * ordering or a 24:00 midnight rendering.
 */
export function formatDateTimeGmt7(iso: string | Date | null): string {
  if (iso === null) {
    return "—";
  }
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${at("year")}-${at("month")}-${at("day")} ${at("hour")}:${at("minute")} GMT+7`;
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
  // null = price not known (no active stage yet / not a drop) — NOT free.
  // Rendering unknown as "FREE" showed paid drops as free (found live
  // 2026-08-28: Stackman, 0.001 ETH, displayed FREE before its stage opened).
  if (wei === null) {
    return "—";
  }
  if (wei === "0") {
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
