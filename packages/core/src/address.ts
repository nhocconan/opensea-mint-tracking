/**
 * Address hygiene (PRD §9/§14): storage form is lowercase hex; checksummed
 * display is produced only at the UI boundary with viem.
 */
import { type Address, asAddress } from "./brands.ts";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isValidEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value.trim());
}

/** Lowercase canonical storage form; throws on malformed input. */
export function normalizeAddress(value: string): Address {
  const trimmed = value.trim();
  if (!isValidEvmAddress(trimmed)) {
    throw new RangeError(`invalid EVM address: ${value}`);
  }
  return asAddress(trimmed.toLowerCase());
}

export function tryNormalizeAddress(value: string): Address | undefined {
  try {
    return normalizeAddress(value);
  } catch {
    return undefined;
  }
}

/** 0x1234…9abc form for dense tables; full address available via copy button. */
export function formatShortAddress(value: string): string {
  const normalized = tryNormalizeAddress(value);
  if (!normalized) {
    return value;
  }
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
}
