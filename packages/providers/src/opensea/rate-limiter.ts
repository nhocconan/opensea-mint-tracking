/**
 * Process-wide OpenSea request pacing (2026-08-28). OpenSea's self-serve
 * Developer keys allow ~120 requests/min per key; the worker runs many
 * independent loops (discovery, collection sweep, detail refresh ×2,
 * eligibility, rarity, pre-build) that each know nothing about the others'
 * spend, so together they blew past the limit — 238 of the first 736
 * requests on the operator's key were 429s. This token bucket is shared by
 * every OpenSeaClient in the process and keyed per API key, so:
 *   - one key never exceeds its per-minute budget (we pace at ~85% of it),
 *   - several keys are load-balanced (each request takes the key with the
 *     most tokens left) → N keys ≈ N× throughput,
 *   - callers just `await acquire(key)`; they never see a 429 from pacing.
 * Pure timing logic is exposed for tests.
 */

const DEFAULT_PER_MINUTE = 100;

interface Bucket {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  lastRefillMs: number;
  waiters: number;
}

const buckets = new Map<string, Bucket>();

function bucketFor(key: string, perMinute: number): Bucket {
  let bucket = buckets.get(key);
  if (bucket === undefined || bucket.capacity !== perMinute) {
    bucket = {
      tokens: perMinute,
      capacity: perMinute,
      refillPerMs: perMinute / 60_000,
      lastRefillMs: Date.now(),
      waiters: 0,
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

export function refill(bucket: Bucket, nowMs: number): void {
  const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
  bucket.lastRefillMs = nowMs;
}

/** Ms to wait before one token is available (0 if now). Pure. */
export function waitMsForToken(bucket: Bucket, nowMs: number): number {
  refill(bucket, nowMs);
  if (bucket.tokens >= 1) {
    return 0;
  }
  return Math.ceil((1 - bucket.tokens) / bucket.refillPerMs);
}

/**
 * Pick the key with the most tokens available right now — this is what
 * turns N keys into N× throughput without any coordination between loops.
 */
export function pickKey(keys: readonly string[], perMinute: number, nowMs = Date.now()): string {
  let best = keys[0] as string;
  let bestTokens = Number.NEGATIVE_INFINITY;
  for (const key of keys) {
    const bucket = bucketFor(key, perMinute);
    refill(bucket, nowMs);
    // Penalise keys that already have callers queued on them.
    const effective = bucket.tokens - bucket.waiters;
    if (effective > bestTokens) {
      bestTokens = effective;
      best = key;
    }
  }
  return best;
}

/** Block until this key may make one more request. */
export async function acquire(key: string, perMinute = DEFAULT_PER_MINUTE): Promise<void> {
  const bucket = bucketFor(key, perMinute);
  bucket.waiters += 1;
  try {
    for (;;) {
      const wait = waitMsForToken(bucket, Date.now());
      if (wait === 0) {
        bucket.tokens -= 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  } finally {
    bucket.waiters -= 1;
  }
}

/**
 * Upstream told us we're over budget despite pacing (shared key elsewhere,
 * or the limit is lower than configured): drain this key's bucket so the
 * next callers back off for `retryAfterSeconds` instead of piling on.
 */
export function penalize(
  key: string,
  retryAfterSeconds: number,
  perMinute = DEFAULT_PER_MINUTE,
): void {
  const bucket = bucketFor(key, perMinute);
  bucket.tokens = Math.min(bucket.tokens, -retryAfterSeconds * 1000 * bucket.refillPerMs);
  bucket.lastRefillMs = Date.now();
}

/** Test hook. */
export function resetRateLimiterForTests(): void {
  buckets.clear();
}
