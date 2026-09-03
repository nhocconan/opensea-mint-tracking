/**
 * "This slug is an OpenSea collection but not an OpenSea Drop" — the worker
 * learns it when `/drops/{slug}` 404s for a slug it holds no schedule for,
 * and Admin → Special mints reads it so the operator gets a real answer
 * instead of "fetching, retry in 30s" forever (yolkies-nft, 2026-09-02).
 * Stored in `settings` under this key; the TTL is applied by the reader, and
 * the reader still re-fetches — the marker only changes the wording.
 */
export function notADropSettingKey(slug: string): string {
  return `opensea_not_a_drop:${slug.trim().toLowerCase()}`;
}

/** Short on purpose: a creator can publish the SeaDrop schedule minutes
 *  after the collection appears, so "not a drop" is only ever a recent
 *  observation, never a verdict. */
export const NOT_A_DROP_TTL_MS = 30 * 60 * 1000;

export interface NotADropMarker {
  readonly at: string;
}

/** Marker value that clears a previous "not a drop" observation. */
export const NOT_A_DROP_CLEARED: NotADropMarker = { at: "" };

/** True when the marker exists and is younger than the TTL. */
export function isNotADropMarkerFresh(marker: unknown, nowMs: number): boolean {
  if (marker === null || typeof marker !== "object") {
    return false;
  }
  const at = (marker as { at?: unknown }).at;
  if (typeof at !== "string") {
    return false;
  }
  const atMs = new Date(at).getTime();
  return Number.isFinite(atMs) && nowMs - atMs < NOT_A_DROP_TTL_MS;
}
