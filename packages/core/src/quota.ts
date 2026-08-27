/**
 * OpenSea quota math (PRD §12). Free instant tier: 600 reads/hour.
 * The provider must stop before exhaustion, holding a configurable reserve
 * (default 10%). All arithmetic is integer-safe for realistic values.
 */
export interface QuotaState {
  readonly limitPerHour: number;
  readonly remaining: number | null;
  /** Unix epoch seconds when the window resets, if the provider reported it. */
  readonly resetAtEpochSeconds: number | null;
  readonly reservePercent: number;
}

export interface QuotaDecision {
  readonly allowed: number;
  readonly blocked: boolean;
  readonly reason:
    | "ok"
    | "unknown-remaining-assume-budget"
    | "reserve-reached"
    | "window-reset-in-past";
}

/**
 * Requests still allowed under the reserve policy. When the provider has not
 * reported `remaining` we assume a conservative share of the hourly budget
 * per scheduling window so a fresh/rotated key is never overspent.
 */
export function allowedRequests(
  quota: QuotaState,
  options: { windowSeconds?: number } = {},
): QuotaDecision {
  const reserveFraction = quota.reservePercent / 100;
  const effectiveLimit = Math.floor(quota.limitPerHour * (1 - reserveFraction));
  const windowSeconds = options.windowSeconds ?? 3600;
  const perWindow = Math.max(1, Math.floor((effectiveLimit * windowSeconds) / 3600));

  if (quota.remaining === null) {
    return {
      allowed: perWindow,
      blocked: false,
      reason: "unknown-remaining-assume-budget",
    };
  }
  if (quota.remaining <= 0) {
    return { allowed: 0, blocked: true, reason: "reserve-reached" };
  }
  if (quota.remaining <= Math.floor(quota.limitPerHour * reserveFraction)) {
    return { allowed: 0, blocked: true, reason: "reserve-reached" };
  }
  return {
    allowed: Math.min(quota.remaining, perWindow),
    blocked: false,
    reason: "ok",
  };
}

/** Discovery budget for one cycle before pagination (PRD §12 table). */
export function discoveryBaseReads(dropFeedTypes: readonly string[]): number {
  return dropFeedTypes.length;
}

/**
 * Estimated hourly consumption for planning/alerts: (3 + N) × cycles/hour.
 */
export function estimatedHourlyReads(options: {
  intervalSeconds: number;
  eligibilityCandidates: number;
  baseListCalls?: number;
}): number {
  const base = options.baseListCalls ?? 3;
  const cyclesPerHour = 3600 / options.intervalSeconds;
  return Math.round((base + options.eligibilityCandidates) * cyclesPerHour);
}

/** Parse `X-RateLimit-Remaining`-style headers defensively. */
export function parseRateLimitHeaders(headers: Record<string, string | undefined>): {
  remaining: number | null;
  limit: number | null;
  resetAtEpochSeconds: number | null;
} {
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = headers[name];
      if (value !== undefined && value.trim() !== "") {
        return value.trim();
      }
    }
    return undefined;
  };

  const remainingRaw = pick("x-ratelimit-remaining", "x-ratelimit-remaining-requests");
  const limitRaw = pick("x-ratelimit-limit", "x-ratelimit-limit-requests");
  const resetRaw = pick(
    "x-ratelimit-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-after",
  );

  const toInt = (raw: string | undefined): number | null => {
    if (raw === undefined) {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? null : parsed;
  };
  const resetParsed = toInt(resetRaw);
  const resetIsDuration = resetRaw?.trim().match(/^[0-9.]+s$/) !== null;

  return {
    remaining: toInt(remainingRaw),
    limit: toInt(limitRaw),
    resetAtEpochSeconds:
      resetParsed === null
        ? null
        : resetIsDuration
          ? Math.floor(Date.now() / 1000) + Math.ceil(Number.parseFloat(resetRaw ?? "0"))
          : resetParsed,
  };
}
