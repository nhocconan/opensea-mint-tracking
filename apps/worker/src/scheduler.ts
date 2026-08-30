import { isAppError } from "@hoodmint/core";

export interface ScheduledTaskOptions {
  readonly intervalMs: number;
  readonly name: string;
  readonly task: () => Promise<unknown>;
  readonly onError: (error: unknown) => void;
  readonly random?: () => number;
  readonly initialDelayMs?: number;
}

/** Provider backoff wins over normal cadence and gets jitter across replicas. */
export function delayAfterFailure(
  intervalMs: number,
  error: unknown,
  random: () => number = Math.random,
): number {
  if (
    !isAppError(error) ||
    (error.category !== "RateLimited" && error.category !== "AuthRequired")
  ) {
    return intervalMs;
  }
  const providerDelayMs = (error.retryAfterSeconds ?? 5 * 60) * 1000;
  const base = Math.max(intervalMs, providerDelayMs);
  return base + Math.floor(base * 0.1 * random());
}

/** Stable startup spread prevents every periodic job firing on the same tick. */
export function startupDelay(name: string, intervalMs: number): number {
  const window = Math.min(intervalMs, 5_000);
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return window === 0 ? 0 : hash % window;
}

/**
 * Completion-based scheduler: the next pass is armed only after the current
 * promise settles, so slow/throttled work can never overlap itself.
 */
export function scheduleNonOverlappingTask(options: ScheduledTaskOptions): () => void {
  const random = options.random ?? Math.random;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number): void => {
    if (!stopped) {
      timer = setTimeout(() => void run(), delayMs);
    }
  };
  const run = async (): Promise<void> => {
    let nextDelay = options.intervalMs;
    try {
      await options.task();
    } catch (error) {
      options.onError(error);
      nextDelay = delayAfterFailure(options.intervalMs, error, random);
    } finally {
      schedule(nextDelay);
    }
  };

  schedule(options.initialDelayMs ?? startupDelay(options.name, options.intervalMs));
  return () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}
