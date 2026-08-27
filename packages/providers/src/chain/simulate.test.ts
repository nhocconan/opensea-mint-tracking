import { describe, expect, it } from "vitest";
import { extractRevertReason } from "./simulate.ts";

describe("extractRevertReason", () => {
  it("prefers viem's shortMessage when present", () => {
    const error = new Error("long raw RPC error with stack trace noise") as Error & {
      shortMessage: string;
    };
    error.shortMessage = "execution reverted: stage not started";
    expect(extractRevertReason(error)).toBe("execution reverted: stage not started");
  });

  it("falls back to the plain message when no shortMessage exists", () => {
    expect(extractRevertReason(new Error("network timeout"))).toBe("network timeout");
  });

  it("handles a non-Error thrown value without crashing", () => {
    expect(extractRevertReason("weird string throw")).toBe("simulation failed: unknown error");
  });

  it("truncates very long messages to a bounded length", () => {
    const huge = new Error("x".repeat(1000));
    expect(extractRevertReason(huge).length).toBeLessThanOrEqual(300);
  });
});
