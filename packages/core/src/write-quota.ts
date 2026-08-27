/**
 * Rolling-hour write-quota guard for speculative OpenSea API calls (ADR
 * 0009, mint-race competitiveness, item P4). Pure state-transition logic
 * only — the caller owns persistence (packages/db's settings table) and
 * the actual HTTP call.
 *
 * This exists because P4's speculative pre-build calls the SAME
 * write-scoped OpenSea endpoint (`POST /drops/{slug}/mint`) the real,
 * due-to-fire build already calls unconditionally — and ADR 0004 documents
 * a 30-request/hour quota for that key type. An unbounded "pre-build,
 * rebuild on staleness" loop could burn that budget on builds that never
 * fire, starving the one call that actually matters. The fix: track a
 * rolling-hour count and stop attempting SPECULATIVE calls once usage
 * nears the ceiling — the real, due-to-fire build never consults this at
 * all and always proceeds regardless (packages/core intentionally has no
 * function that would let a caller block the real path with this).
 */

export interface WriteQuotaWindow {
  readonly windowStartMs: number;
  readonly count: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Roll the window forward if the hour has elapsed since it started,
 * otherwise return it unchanged. Call this before checking/recording a
 * call so the count always reflects the current rolling hour.
 */
export function currentWriteQuotaWindow(
  stored: WriteQuotaWindow | undefined,
  nowMs: number,
): WriteQuotaWindow {
  if (stored === undefined || nowMs - stored.windowStartMs >= HOUR_MS) {
    return { windowStartMs: nowMs, count: 0 };
  }
  return stored;
}

/**
 * Should a speculative (optional, not user-blocking) write call be
 * attempted right now? `capFraction` (default 0.8) leaves headroom for
 * the real due-to-fire build, which never checks this itself.
 */
export function shouldAttemptSpeculativeWrite(
  window: WriteQuotaWindow,
  maxPerHour: number,
  capFraction = 0.8,
): boolean {
  return window.count < Math.floor(maxPerHour * capFraction);
}

/** Record that a write call was made (speculative or real) against this window. */
export function recordWriteQuotaCall(window: WriteQuotaWindow): WriteQuotaWindow {
  return { windowStartMs: window.windowStartMs, count: window.count + 1 };
}
