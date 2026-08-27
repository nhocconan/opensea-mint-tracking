import { describe, expect, it } from "vitest";
import { canFireMintPlan, rankRpcEndpoints } from "./execution.ts";

describe("canFireMintPlan", () => {
  const now = new Date("2026-08-21T12:00:00Z");
  const base = {
    status: "armed" as const,
    armedUntil: new Date("2026-08-21T12:05:00Z"),
    signerCeilingWei: 1_000n,
    perPlanCeilingWei: 500n,
    spentWei: 0n,
  };

  it("allows a well-formed armed plan inside its window and under both caps", () => {
    expect(canFireMintPlan(base, now)).toEqual({ ok: true });
  });

  it("rejects a plan that is not armed", () => {
    expect(canFireMintPlan({ ...base, status: "draft" }, now).ok).toBe(false);
    expect(canFireMintPlan({ ...base, status: "executing" }, now).ok).toBe(false);
  });

  it("rejects a plan with no arm window", () => {
    expect(canFireMintPlan({ ...base, armedUntil: null }, now).ok).toBe(false);
  });

  it("rejects a stale/expired arm window even if status is still 'armed'", () => {
    const expired = { ...base, armedUntil: new Date("2026-08-21T11:59:59Z") };
    const result = canFireMintPlan(expired, now);
    expect(result).toEqual({ ok: false, reason: "arm window has expired" });
  });

  it("rejects a window that expires at exactly `now` (boundary is exclusive)", () => {
    const boundary = { ...base, armedUntil: now };
    expect(canFireMintPlan(boundary, now).ok).toBe(false);
  });

  it("rejects a per-plan ceiling above the signer's coarse on-chain ceiling", () => {
    const overCap = { ...base, perPlanCeilingWei: 2_000n };
    const result = canFireMintPlan(overCap, now);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/exceeds the signer's coarse/);
    }
  });

  it("rejects a non-positive per-plan ceiling", () => {
    expect(canFireMintPlan({ ...base, perPlanCeilingWei: 0n }, now).ok).toBe(false);
  });

  it("rejects a plan that has already spent its full per-plan ceiling", () => {
    const spent = { ...base, spentWei: 500n };
    expect(canFireMintPlan(spent, now).ok).toBe(false);
  });

  it("allows a plan that has partially spent but is still under its ceiling", () => {
    const partial = { ...base, spentWei: 499n };
    expect(canFireMintPlan(partial, now)).toEqual({ ok: true });
  });
});

describe("rankRpcEndpoints", () => {
  const chainId = 4663;

  it("filters to the requested chain and drops disabled endpoints", () => {
    const endpoints = [
      { id: "a", chainId, enabled: true, priority: 0, healthStatus: "healthy" as const },
      { id: "b", chainId: 1, enabled: true, priority: 0, healthStatus: "healthy" as const },
      { id: "c", chainId, enabled: false, priority: 0, healthStatus: "healthy" as const },
    ];
    expect(rankRpcEndpoints(endpoints, chainId).map((e) => e.id)).toEqual(["a"]);
  });

  it("ranks healthy before degraded before down, regardless of priority", () => {
    const endpoints = [
      { id: "down", chainId, enabled: true, priority: 0, healthStatus: "down" as const },
      { id: "degraded", chainId, enabled: true, priority: 0, healthStatus: "degraded" as const },
      { id: "healthy", chainId, enabled: true, priority: 5, healthStatus: "healthy" as const },
    ];
    expect(rankRpcEndpoints(endpoints, chainId).map((e) => e.id)).toEqual([
      "healthy",
      "degraded",
      "down",
    ]);
  });

  it("breaks health ties by lowest priority number, then by input order", () => {
    const endpoints = [
      { id: "p2", chainId, enabled: true, priority: 2, healthStatus: "healthy" as const },
      { id: "p0-first", chainId, enabled: true, priority: 0, healthStatus: "healthy" as const },
      { id: "p0-second", chainId, enabled: true, priority: 0, healthStatus: "healthy" as const },
    ];
    expect(rankRpcEndpoints(endpoints, chainId).map((e) => e.id)).toEqual([
      "p0-first",
      "p0-second",
      "p2",
    ]);
  });

  it("still returns a best-effort order when every endpoint is unhealthy, never an empty list", () => {
    const endpoints = [
      { id: "only", chainId, enabled: true, priority: 0, healthStatus: "down" as const },
    ];
    expect(rankRpcEndpoints(endpoints, chainId).map((e) => e.id)).toEqual(["only"]);
  });

  it("is generic — preserves extra fields (e.g. httpUrl) on the input, not just the RpcCandidate shape (ADR 0009, P2)", () => {
    const endpoints = [
      {
        id: "a",
        chainId,
        enabled: true,
        priority: 0,
        healthStatus: "healthy" as const,
        httpUrl: "https://rpc-a.example/",
      },
      {
        id: "b",
        chainId,
        enabled: true,
        priority: 1,
        healthStatus: "healthy" as const,
        httpUrl: "https://rpc-b.example/",
      },
    ];
    const ranked = rankRpcEndpoints(endpoints, chainId);
    // If this didn't type-check, the generic regressed back to the bare
    // RpcCandidate return type — this line is the actual regression guard,
    // not just the runtime assertion below.
    expect(ranked[0]?.httpUrl).toBe("https://rpc-a.example/");
    expect(ranked.map((e) => e.httpUrl)).toEqual([
      "https://rpc-a.example/",
      "https://rpc-b.example/",
    ]);
  });
});
