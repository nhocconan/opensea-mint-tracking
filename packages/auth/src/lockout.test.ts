import { describe, expect, it } from "vitest";
import {
  initialLockoutState,
  isLocked,
  LOCKOUT_DECAY_MS,
  LOCKOUT_DURATIONS_MS,
  LOCKOUT_THRESHOLD,
  type LockoutState,
  recordFailure,
  recordSuccess,
} from "./lockout.ts";

const T0 = 1_700_000_000_000;

function failTimes(state: LockoutState, count: number, now: number): LockoutState {
  let next = state;
  for (let i = 0; i < count; i += 1) {
    next = recordFailure(next, now);
  }
  return next;
}

describe("lockout state machine (brute-force defense-in-depth)", () => {
  it("does not lock before the threshold", () => {
    const state = failTimes(initialLockoutState, LOCKOUT_THRESHOLD - 1, T0);
    expect(state.failures).toBe(LOCKOUT_THRESHOLD - 1);
    expect(isLocked(state, T0)).toBe(false);
  });

  it("locks for 1 minute at the first threshold breach", () => {
    const state = failTimes(initialLockoutState, LOCKOUT_THRESHOLD, T0);
    expect(state.level).toBe(1);
    expect(state.lockedUntil).toBe(T0 + LOCKOUT_DURATIONS_MS[0]);
    expect(isLocked(state, T0)).toBe(true);
  });

  it("escalates lock duration on repeated threshold breaches", () => {
    // Level 1 lock.
    let state = failTimes(initialLockoutState, LOCKOUT_THRESHOLD, T0);
    expect(state.lockedUntil).toBe(T0 + LOCKOUT_DURATIONS_MS[0]);

    // After it expires, another streak escalates to level 2 (5 min).
    const afterL1 = T0 + LOCKOUT_DURATIONS_MS[0];
    state = failTimes(state, LOCKOUT_THRESHOLD, afterL1);
    expect(state.level).toBe(2);
    expect(state.lockedUntil).toBe(afterL1 + LOCKOUT_DURATIONS_MS[1]);

    // Level 3 (15 min).
    const afterL2 = afterL1 + LOCKOUT_DURATIONS_MS[1];
    state = failTimes(state, LOCKOUT_THRESHOLD, afterL2);
    expect(state.level).toBe(3);
    expect(state.lockedUntil).toBe(afterL2 + LOCKOUT_DURATIONS_MS[2]);
  });

  it("caps escalation at the final ladder entry", () => {
    let state = initialLockoutState;
    let now = T0;
    // Drive well past the ladder length.
    for (let cycle = 0; cycle < LOCKOUT_DURATIONS_MS.length + 3; cycle += 1) {
      state = failTimes(state, LOCKOUT_THRESHOLD, now);
      now = state.lockedUntil; // jump to the moment the lock expires
    }
    const cap = LOCKOUT_DURATIONS_MS[LOCKOUT_DURATIONS_MS.length - 1] ?? 0;
    const priorExpiry = now - cap;
    expect(state.lockedUntil - priorExpiry).toBe(cap);
  });

  it("ignores attempts while locked (does not extend the window)", () => {
    const locked = failTimes(initialLockoutState, LOCKOUT_THRESHOLD, T0);
    const midLock = T0 + 10_000;
    const after = recordFailure(locked, midLock);
    expect(after).toEqual(locked);
    expect(after.lockedUntil).toBe(locked.lockedUntil);
  });

  it("isLocked boundary is exclusive at lockedUntil", () => {
    const locked = failTimes(initialLockoutState, LOCKOUT_THRESHOLD, T0);
    expect(isLocked(locked, locked.lockedUntil - 1)).toBe(true);
    expect(isLocked(locked, locked.lockedUntil)).toBe(false);
    expect(isLocked(locked, locked.lockedUntil + 1)).toBe(false);
  });

  it("resets fully on success", () => {
    const state = failTimes(initialLockoutState, LOCKOUT_THRESHOLD - 1, T0);
    expect(state.failures).toBeGreaterThan(0);
    const cleared = recordSuccess();
    expect(cleared).toEqual(initialLockoutState);
    expect(isLocked(cleared, T0)).toBe(false);
  });

  it("decays the streak after a long idle gap", () => {
    const state = failTimes(initialLockoutState, LOCKOUT_THRESHOLD - 1, T0);
    expect(state.failures).toBe(LOCKOUT_THRESHOLD - 1);
    // A single failure long after the streak counts as the first of a new one.
    const later = state.lastFailureAt + LOCKOUT_DECAY_MS + 1;
    const next = recordFailure(state, later);
    expect(next.failures).toBe(1);
    expect(isLocked(next, later)).toBe(false);
  });

  it("decays escalation level too, so a returning user starts at level 1 again", () => {
    // Reach a level-2 lock.
    let state = failTimes(initialLockoutState, LOCKOUT_THRESHOLD, T0);
    const afterL1 = T0 + LOCKOUT_DURATIONS_MS[0];
    state = failTimes(state, LOCKOUT_THRESHOLD, afterL1);
    expect(state.level).toBe(2);

    // Come back long after the lock lapsed: a fresh streak locks at level 1.
    const wayLater = state.lockedUntil + LOCKOUT_DECAY_MS + 1;
    const fresh = failTimes(state, LOCKOUT_THRESHOLD, wayLater);
    expect(fresh.level).toBe(1);
    expect(fresh.lockedUntil).toBe(wayLater + LOCKOUT_DURATIONS_MS[0]);
  });

  it("does not decay within the active window", () => {
    let state = failTimes(initialLockoutState, LOCKOUT_THRESHOLD - 1, T0);
    // Another failure just inside the decay window keeps accumulating.
    const soon = state.lastFailureAt + LOCKOUT_DECAY_MS - 1;
    state = recordFailure(state, soon);
    expect(state.level).toBe(1);
    expect(isLocked(state, soon)).toBe(true);
  });
});
