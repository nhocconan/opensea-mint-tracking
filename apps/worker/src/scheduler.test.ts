import { AppError } from "@hoodmint/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  delayAfterFailure,
  runProviderJob,
  scheduleNonOverlappingTask,
  startupDelay,
} from "./scheduler.ts";

afterEach(() => vi.useRealTimers());

describe("non-overlapping worker scheduler", () => {
  it("does not start another pass while the previous promise is pending", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = scheduleNonOverlappingTask({
      intervalMs: 1_000,
      initialDelayMs: 0,
      name: "eligibility",
      task,
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it("honors Retry-After with jitter instead of the normal cadence", () => {
    const error = new AppError("RateLimited", "throttled", { retryAfterSeconds: 600 });
    expect(delayAfterFailure(60_000, error, () => 0)).toBe(600_000);
    expect(delayAfterFailure(60_000, error, () => 0.5)).toBe(630_000);
  });

  it("spreads startup within the smaller of five seconds and one interval", () => {
    expect(startupDelay("eligibility", 60_000)).toBeLessThan(5_000);
    expect(startupDelay("mint-hot-loop", 250)).toBeLessThan(250);
  });

  it("parks provider backpressure instead of entering a short queue retry loop", async () => {
    const onPark = vi.fn();
    const error = new AppError("RateLimited", "throttled", { retryAfterSeconds: 600 });

    await expect(
      runProviderJob({
        task: () => Promise.reject(error),
        onPark,
        random: () => 0,
      }),
    ).resolves.toBeUndefined();
    expect(onPark).toHaveBeenCalledWith(error, 600_000);
  });

  it("leaves unexpected queue failures to BullMQ's bounded retry policy", async () => {
    const error = new Error("connection reset");
    await expect(
      runProviderJob({ task: () => Promise.reject(error), onPark: vi.fn() }),
    ).rejects.toBe(error);
  });
});
