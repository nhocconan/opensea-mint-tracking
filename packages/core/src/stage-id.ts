/**
 * OpenSea returns the same stage uuid in two spellings depending on the
 * endpoint — dashed (`0b2af0cc-1800-4889-acbd-84e4647bac13`, drop detail)
 * and dashless (`0b2af0cc18004889acbd84e4647bac13`, list feeds/eligibility).
 * Stored as-is, one stage became two rows with diverging prices (found live
 * 2026-08-28: swoki showed a stale "FREE" row next to the real 0.00015 ETH
 * one). Canonical form everywhere: lowercase, no dashes.
 */
/**
 * OpenSea charges a per-token SeaDrop mint fee on Robinhood Chain even for
 * "free" (price 0) stages — captured live 2026-08-28: `/drops/{slug}/mint`
 * returned value 0.00008 ETH for a 0-priced public stage. Spend ceilings
 * must allow it or the fire is refused as over-ceiling. Allowance per token.
 */
export const OPENSEA_MINT_FEE_ALLOWANCE_WEI = 100_000_000_000_000n; // 0.0001 ETH

/** Stage price × quantity plus the OpenSea mint fee allowance, as a wei string. */
export function mintSpendCeilingWei(priceWei: string | null, quantity: number): string {
  const qty = BigInt(Math.max(1, Math.floor(quantity)));
  const price = priceWei !== null && /^[0-9]+$/.test(priceWei) ? BigInt(priceWei) : 0n;
  return ((price + OPENSEA_MINT_FEE_ALLOWANCE_WEI) * qty).toString(10);
}

export function normalizeStageId(raw: string): string {
  return raw.trim().toLowerCase().replaceAll("-", "");
}
