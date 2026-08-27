import { describe, expect, it, vi } from "vitest";
import {
  type ExecutionPipelineDeps,
  type ExecutionPipelineInput,
  runExecutionPipeline,
} from "./pipeline.ts";

const NOW = new Date("2026-08-22T12:00:00Z");

const baseInput: ExecutionPipelineInput = {
  planId: "plan-1",
  planStatus: "armed",
  armedUntil: new Date("2026-08-22T12:05:00Z"),
  signerCeilingWei: 1_000n,
  perPlanCeilingWei: 500n,
  spentWei: 0n,
  signer: { id: "signer-1", scheme: "browser_wallet" },
  recipientAddress: "0xowner",
  tx: { chainId: 4663, to: "0xtarget", data: "0xdead", valueWei: "100", expectedFrom: "0xowner" },
};

function deps(overrides: Partial<ExecutionPipelineDeps> = {}): ExecutionPipelineDeps {
  return {
    rpcUrl: "http://127.0.0.1:8545",
    liveExecutionEnabled: false,
    simulate: vi.fn().mockResolvedValue({ ok: true, gasEstimate: 21_000n }),
    now: () => NOW,
    ...overrides,
  };
}

describe("runExecutionPipeline", () => {
  it("blocks on policy before ever calling simulate, for a non-armed plan", async () => {
    const simulate = vi.fn();
    const outcome = await runExecutionPipeline(
      { ...baseInput, planStatus: "draft" },
      deps({ simulate }),
    );
    expect(outcome.stage).toBe("blocked_policy");
    expect(simulate).not.toHaveBeenCalled();
  });

  it("blocks on policy for an expired arm window, even though status is still 'armed'", async () => {
    const outcome = await runExecutionPipeline(
      { ...baseInput, armedUntil: new Date("2026-08-22T11:59:00Z") },
      deps(),
    );
    expect(outcome).toMatchObject({ stage: "blocked_policy" });
  });

  it("calls simulate with the recipient as `from` and the adapter's tx fields", async () => {
    const simulate = vi.fn().mockResolvedValue({ ok: true, gasEstimate: 21_000n });
    await runExecutionPipeline(baseInput, deps({ simulate }));
    expect(simulate).toHaveBeenCalledWith({
      rpcUrl: "http://127.0.0.1:8545",
      from: "0xowner",
      to: "0xtarget",
      data: "0xdead",
      valueWei: "100",
    });
  });

  it("blocks on a reverting simulation and never reaches the shadow/live stages", async () => {
    const simulate = vi.fn().mockResolvedValue({ ok: false, revertReason: "stage not started" });
    const outcome = await runExecutionPipeline(baseInput, deps({ simulate }));
    expect(outcome).toEqual({ stage: "blocked_simulation", revertReason: "stage not started" });
  });

  it("defaults to shadow mode: a valid, in-window, simulated-ok plan still never reaches signing when LIVE_EXECUTION_ENABLED is false", async () => {
    const outcome = await runExecutionPipeline(baseInput, deps({ liveExecutionEnabled: false }));
    expect(outcome).toEqual({ stage: "shadow_would_fire", gasEstimate: 21_000n });
  });

  it("hands off to browser signing when live and the signer is browser_wallet", async () => {
    const outcome = await runExecutionPipeline(baseInput, deps({ liveExecutionEnabled: true }));
    expect(outcome).toEqual({
      stage: "ready_for_browser_signature",
      signRequest: {
        planId: "plan-1",
        chainId: 4663,
        to: "0xtarget",
        data: "0xdead",
        valueWei: "100",
      },
    });
  });

  it("blocks a Phase-2-only signer scheme even when live and everything else checks out", async () => {
    const outcome = await runExecutionPipeline(
      { ...baseInput, signer: { id: "signer-2", scheme: "eip7702_safe_zodiac" } },
      deps({ liveExecutionEnabled: true }),
    );
    expect(outcome.stage).toBe("blocked_scheme_not_implemented");
  });

  it("still runs simulation and would report shadow_would_fire for custom_executor while live execution is off", async () => {
    // Shadow mode never even reaches the signer check — it's a pipeline-order guarantee.
    const outcome = await runExecutionPipeline(
      { ...baseInput, signer: { id: "signer-2", scheme: "custom_executor" } },
      deps({ liveExecutionEnabled: false }),
    );
    expect(outcome.stage).toBe("shadow_would_fire");
  });

  it("hands off to delegated (server-side) signing when live and the signer is custom_executor — never the browser path", async () => {
    const outcome = await runExecutionPipeline(
      { ...baseInput, signer: { id: "signer-2", scheme: "custom_executor" } },
      deps({ liveExecutionEnabled: true }),
    );
    expect(outcome).toEqual({
      stage: "ready_for_delegated_signature",
      signer: { id: "signer-2", scheme: "custom_executor" },
      tx: baseInput.tx,
      gasEstimate: 21_000n,
    });
  });
});
