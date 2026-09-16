import { describe, expect, it } from "vitest";
import { currentStage, nextStage, relevantStage, type StageView } from "./stages.ts";

const NOW = "2026-09-15T04:00:00.000Z";

function stage(over: Partial<StageView> & { startsAt: string }): StageView {
  return {
    label: over.label ?? "stage",
    kind: over.kind ?? "allowlist",
    startsAt: over.startsAt,
    endsAt: over.endsAt ?? null,
    paused: over.paused ?? false,
  };
}

describe("stage selection", () => {
  // Regression, found live 2026-09-15: currentStage() filtered paused stages
  // but nextStage() did not, so a phase OpenSea had superseded (old row
  // paused by the detail scan) was still announced as the upcoming mint on
  // its stale starts_at.
  it("nextStage skips a superseded (paused) future stage", () => {
    const superseded = stage({
      label: "old public",
      startsAt: "2026-09-15T16:00:00.000Z",
      paused: true,
    });
    const reissued = stage({ label: "public", startsAt: "2026-09-15T16:00:00.000Z" });
    expect(nextStage([superseded], NOW)).toBeUndefined();
    expect(nextStage([superseded, reissued], NOW)?.label).toBe("public");
  });

  it("currentStage still skips a paused live stage", () => {
    const paused = stage({ startsAt: "2026-09-12T10:00:00.000Z", paused: true });
    expect(currentStage([paused], NOW)).toBeUndefined();
  });

  it("relevantStage prefers the live stage, then the earliest unpaused future one", () => {
    const live = stage({ label: "fcfs", startsAt: "2026-09-12T10:00:00.000Z" });
    const upcoming = stage({
      label: "public",
      kind: "public",
      startsAt: "2026-09-15T16:00:00.000Z",
    });
    expect(relevantStage([live, upcoming], NOW)?.label).toBe("fcfs");
    expect(relevantStage([upcoming], NOW)?.label).toBe("public");
  });
});
