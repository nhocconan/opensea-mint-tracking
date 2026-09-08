/**
 * UI-boundary formatting (PRD §14): all stored times are UTC; locale
 * conversion happens only here. Wei display truncates to 4 significant
 * decimals; addresses are shown short with copy affordance elsewhere.
 */
import {
  coerceDate,
  DEFAULT_TIMEZONE,
  formatDateTimeGmt7,
  formatUnitsShort,
  formatWei,
  getDayKey,
  type Wei,
} from "@hoodmint/core";

/** Re-exported for call sites already importing from here — see @hoodmint/core's coerceDate for why this exists. */
export const toDate = coerceDate;
export { DEFAULT_TIMEZONE, formatDateTimeGmt7, getDayKey };

/**
 * Standard UI display formatter for all system dates.
 * Defaults to the operator's wall clock (Asia/Ho_Chi_Minh, GMT+7).
 */
export const formatDateTime = formatDateTimeGmt7;

export function formatDateTimeUtc(iso: string | Date | null): string {
  if (iso === null) {
    return "—";
  }
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDateTimeLocal(
  iso: string | Date | null,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (iso === null) {
    return "—";
  }
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatTimeGmt7(
  iso: string | Date | null,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (iso === null) {
    return "--:--";
  }
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
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

/**
 * Wallet native balance snapshot for admin tables: "0.0123 ETH · 2m ago",
 * "—" when never read. Display only.
 */
export function formatBalance(
  wei: string | null,
  checkedAt: string | Date | null,
  now: number = Date.now(),
): string {
  if (wei === null || !/^[0-9]+$/.test(wei)) {
    return "—";
  }
  const eth = `${formatUnitsShort(BigInt(wei))} ETH`;
  if (checkedAt === null) {
    return eth;
  }
  const ageMs = now - (checkedAt instanceof Date ? checkedAt : new Date(checkedAt)).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return eth;
  }
  const minutes = Math.floor(ageMs / 60_000);
  const age =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes}m ago`
        : `${Math.floor(minutes / 60)}h ago`;
  return `${eth} · ${age}`;
}
