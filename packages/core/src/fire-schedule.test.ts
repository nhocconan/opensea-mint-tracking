import { describe, expect, it } from "vitest";
import { chainTimeToLocalMs, computeFirePhase, type FireScheduleInput } from "./fire-schedule.ts";

// Stage opens at chain-time T. Local clock is 500ms AHEAD of chain
// (offset = local − chain = +500), so the same instant in local time is
// T + 500. Base config: spin the last 2s, fire 200ms early, keep trying
// 5s past open.
const T_CHAIN = 1_000_000_000_000;
const base: Omit<FireScheduleInput, "localNowMs"> = {
  stageStartChainMs: T_CHAIN,
  clockOffsetMs: 500,
  hotWindowMs: 2000,
  leadMs: 200,
  continueForMs: 5000,
};
// Derived local landmarks (hand-computed):
const LOCAL_START = T_CHAIN + 500; // chain open in local terms
const FIRE_AT = LOCAL_START - 200; // 200ms lead
const HOT_AT = FIRE_AT - 2000; // 2s hot window
const CONTINUE_UNTIL = LOCAL_START + 5000;

describe("chainTimeToLocalMs", () => {
  it("adds the offset: local = chain + (local − chain)", () => {
    expect(chainTimeToLocalMs(T_CHAIN, 500)).toBe(T_CHAIN + 500);
    expect(chainTimeToLocalMs(T_CHAIN, -300)).toBe(T_CHAIN - 300);
  });
});

describe("computeFirePhase", () => {
  it("waits, and reports the true ms until the hot window, while still early", () => {
    const now = HOT_AT - 10_000;
    const phase = computeFirePhase({ ...base, localNowMs: now });
    expect(phase.phase).toBe("waiting");
    if (phase.phase === "waiting") {
      expect(phase.msUntilHotWindow).toBe(10_000);
    }
  });

  it("enters the hot busy-loop exactly at the hot-window boundary", () => {
    const phase = computeFirePhase({ ...base, localNowMs: HOT_AT });
    expect(phase.phase).toBe("hot");
    if (phase.phase === "hot") {
      expect(phase.msUntilFire).toBe(2000); // = FIRE_AT − HOT_AT
    }
  });

  it("is still 'hot' (not firing) one ms before the fire target", () => {
    const phase = computeFirePhase({ ...base, localNowMs: FIRE_AT - 1 });
    expect(phase.phase).toBe("hot");
    if (phase.phase === "hot") {
      expect(phase.msUntilFire).toBe(1);
    }
  });

  it("fires exactly at the fire target (lead time before chain open)", () => {
    const phase = computeFirePhase({ ...base, localNowMs: FIRE_AT });
    expect(phase.phase).toBe("fire");
    if (phase.phase === "fire") {
      expect(phase.msSinceFireTarget).toBe(0);
    }
  });

  it("keeps returning 'fire' across the whole burst window (continuous compete)", () => {
    // at the stage's actual open
    expect(computeFirePhase({ ...base, localNowMs: LOCAL_START }).phase).toBe("fire");
    // mid-burst
    expect(computeFirePhase({ ...base, localNowMs: LOCAL_START + 2500 }).phase).toBe("fire");
    // last ms of the continue window
    expect(computeFirePhase({ ...base, localNowMs: CONTINUE_UNTIL }).phase).toBe("fire");
  });

  it("expires one ms after the continue window closes", () => {
    expect(computeFirePhase({ ...base, localNowMs: CONTINUE_UNTIL + 1 }).phase).toBe("expired");
  });

  it("a local clock BEHIND chain (negative offset) shifts the whole schedule earlier in local terms", () => {
    // offset −1000: local is 1s behind chain, so chain-open maps to
    // T − 1000 in local time. Fire target = T − 1000 − 200.
    const behind = { ...base, clockOffsetMs: -1000 };
    const fireAt = T_CHAIN - 1000 - 200;
    expect(computeFirePhase({ ...behind, localNowMs: fireAt }).phase).toBe("fire");
    expect(computeFirePhase({ ...behind, localNowMs: fireAt - 1 }).phase).toBe("hot");
  });

  it("a zero-length continue window fires only at the exact target instant", () => {
    const noContinue = { ...base, continueForMs: 0, leadMs: 0 };
    // continueUntil == LOCAL_START, fireAt == LOCAL_START (no lead)
    expect(computeFirePhase({ ...noContinue, localNowMs: LOCAL_START }).phase).toBe("fire");
    expect(computeFirePhase({ ...noContinue, localNowMs: LOCAL_START + 1 }).phase).toBe("expired");
  });

  it("larger lead time fires earlier without moving the give-up point", () => {
    const bigLead = { ...base, leadMs: 1000 };
    const fireAt = LOCAL_START - 1000;
    expect(computeFirePhase({ ...bigLead, localNowMs: fireAt }).phase).toBe("fire");
    // give-up still anchored to stage open + continueFor, unchanged by lead
    expect(computeFirePhase({ ...bigLead, localNowMs: CONTINUE_UNTIL }).phase).toBe("fire");
    expect(computeFirePhase({ ...bigLead, localNowMs: CONTINUE_UNTIL + 1 }).phase).toBe("expired");
  });
});
