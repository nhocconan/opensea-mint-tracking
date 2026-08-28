/**
 * Brute-force lockout state machine (defense-in-depth behind Better Auth's
 * per-path `rateLimit.customRules`). PURE and unit-testable: no clocks, no I/O,
 * no module state — the caller supplies `now` (epoch ms) and owns persistence.
 *
 * State lives in memory only, matching the deliberate `rateLimit.storage:
 * "memory"` decision for this single-instance deploy (see auth.ts): counters
 * reset on restart, which is an acceptable tradeoff and needs no DB table.
 *
 * Escalation: every {@link LOCKOUT_THRESHOLD} consecutive failures locks the
 * identifier for progressively longer, walking {@link LOCKOUT_DURATIONS_MS}
 * and capping at its last entry. A success clears everything; a long idle gap
 * (> {@link LOCKOUT_DECAY_MS}) decays the counters back to a clean slate so an
 * old, abandoned streak never punishes a legitimate returning user.
 */

/** Consecutive failures within the active window that trigger a lock. */
export const LOCKOUT_THRESHOLD = 5;

/**
 * Escalating lock durations (ms) indexed by escalation level - 1. The first
 * lock lasts 1 min; repeat offenders climb to 5, 15, then 60 min, which is the
 * cap for every level beyond the ladder's length.
 */
export const LOCKOUT_DURATIONS_MS = [
  60_000, // level 1: 1 minute
  5 * 60_000, // level 2: 5 minutes
  15 * 60_000, // level 3: 15 minutes
  60 * 60_000, // level 4+: 60 minutes (cap)
] as const;

/**
 * Idle gap after which an identifier's failure streak and escalation level
 * decay to zero. Keeps the in-memory footprint bounded and forgives users who
 * simply fat-fingered a password hours ago.
 */
export const LOCKOUT_DECAY_MS = 60 * 60_000; // 1 hour

export interface LockoutState {
  /** Consecutive failures accrued at the current level since the last lock/reset. */
  readonly failures: number;
  /** Escalation level: 0 = never locked, N = locked N times. */
  readonly level: number;
  /** Epoch ms until which the identifier is locked; 0 = not locked. */
  readonly lockedUntil: number;
  /** Epoch ms of the most recent recorded failure; 0 = none. */
  readonly lastFailureAt: number;
}

export const initialLockoutState: LockoutState = {
  failures: 0,
  level: 0,
  lockedUntil: 0,
  lastFailureAt: 0,
};

/** True while `now` is before the stored `lockedUntil` boundary (exclusive). */
export function isLocked(state: LockoutState, now: number): boolean {
  return now < state.lockedUntil;
}

function lockDurationForLevel(level: number): number {
  const index = Math.min(Math.max(level, 1), LOCKOUT_DURATIONS_MS.length) - 1;
  return LOCKOUT_DURATIONS_MS[index] ?? LOCKOUT_DURATIONS_MS[LOCKOUT_DURATIONS_MS.length - 1] ?? 0;
}

/**
 * Records one failed attempt. While an active lock stands, attempts neither
 * count nor extend it (so an attacker can't keep the lock "warm" indefinitely
 * against the victim). After an idle gap the counters decay first. When the
 * threshold is reached the level escalates and a fresh lock window opens.
 */
export function recordFailure(state: LockoutState, now: number): LockoutState {
  if (isLocked(state, now)) {
    return state;
  }
  const decayed =
    state.lastFailureAt !== 0 && now - state.lastFailureAt > LOCKOUT_DECAY_MS
      ? { failures: 0, level: 0 }
      : { failures: state.failures, level: state.level };
  const failures = decayed.failures + 1;
  if (failures >= LOCKOUT_THRESHOLD) {
    const level = decayed.level + 1;
    return {
      failures: 0,
      level,
      lockedUntil: now + lockDurationForLevel(level),
      lastFailureAt: now,
    };
  }
  return {
    failures,
    level: decayed.level,
    lockedUntil: 0,
    lastFailureAt: now,
  };
}

/** Clears all lockout state after a genuine success. */
export function recordSuccess(): LockoutState {
  return initialLockoutState;
}
