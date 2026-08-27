/**
 * Precision fire scheduling for competitive FCFS/public mint execution
 * (ADR 0009 competitiveness; supersedes the 30s-poll trigger for
 * time-critical plans). On Robinhood Chain the mint race is NOT a gas
 * auction — single sequencer, strict FIFO, no public mempool, no
 * fee-based reordering — so winning reduces to a single thing: land your
 * transaction at the sequencer as close as possible to the instant the
 * stage opens, then keep re-submitting until one lands. This module is the
 * pure decision core for that: given the stage-open time in CHAIN clock
 * terms and the measured local↔chain offset (packages/core/clock-offset),
 * it says whether — right now — the worker should sleep, enter the tight
 * pre-fire busy loop, fire (and keep firing), or give up.
 *
 * Nothing here touches a timer, RPC, or key. It is a pure function of
 * timestamps so the exact race-window math is exhaustively unit-testable
 * without a clock — the worker (apps/worker) owns the actual setInterval /
 * busy-loop that consults this every tick.
 */

export interface FireScheduleInput {
  /** Stage open, in CHAIN-clock milliseconds (EVM stage start_time). */
  readonly stageStartChainMs: number;
  /**
   * Offset from clock-offset.ts's computeClockOffsetMs: local − chain.
   * Positive = local clock is ahead of chain. Used to convert the
   * chain-time stage open into a local wall-clock target.
   */
  readonly clockOffsetMs: number;
  readonly localNowMs: number;
  /**
   * How early (ms before the fire target) to leave "waiting" and enter the
   * tight busy-loop, so the actual broadcast isn't gated by a coarse poll
   * interval. E.g. 2000 = spin the last 2 seconds.
   */
  readonly hotWindowMs: number;
  /**
   * Fire this many ms BEFORE the stage's own open time, to absorb
   * submit→sequencer latency: a tx that arrives a hair early and reverts
   * ("stage not started") is retried by the continue window below, but a
   * tx that arrives late has already lost an FCFS. Bias early, retry
   * through open. Tune per measured round-trip to the chosen RPC.
   */
  readonly leadMs: number;
  /**
   * Keep re-firing up to this many ms AFTER stage open before giving up —
   * this is the "chạy liên tục để compete" burst: on a FIFO chain the
   * winning tx is whichever valid one the sequencer sees first, so a short
   * rapid burst around the open beats a single perfectly-timed shot that
   * might arrive one slot too early.
   */
  readonly continueForMs: number;
}

export type FirePhase =
  /** Too early — sleep this long before re-checking (coarse poll is fine). */
  | { readonly phase: "waiting"; readonly msUntilHotWindow: number }
  /** In the tight pre-fire window — busy-loop, pre-warm, do NOT fire yet. */
  | { readonly phase: "hot"; readonly msUntilFire: number }
  /** Fire NOW. Returned on every tick across the whole fire→continue
   *  window, so a per-tick executor naturally produces the retry burst. */
  | { readonly phase: "fire"; readonly msSinceFireTarget: number }
  /** Past the continue window without success — disarm, stop trying. */
  | { readonly phase: "expired" };

/**
 * Convert a chain-time instant to the local wall-clock instant that
 * corresponds to it. offset = local − chain ⇒ local = chain + offset.
 * Exported for the worker to log/telemetry the concrete local fire target.
 */
export function chainTimeToLocalMs(chainMs: number, clockOffsetMs: number): number {
  return chainMs + clockOffsetMs;
}

export function computeFirePhase(input: FireScheduleInput): FirePhase {
  const localStartMs = chainTimeToLocalMs(input.stageStartChainMs, input.clockOffsetMs);
  const fireAtLocalMs = localStartMs - input.leadMs;
  const hotAtLocalMs = fireAtLocalMs - input.hotWindowMs;
  const continueUntilLocalMs = localStartMs + input.continueForMs;
  const now = input.localNowMs;

  if (now < hotAtLocalMs) {
    return { phase: "waiting", msUntilHotWindow: hotAtLocalMs - now };
  }
  if (now < fireAtLocalMs) {
    return { phase: "hot", msUntilFire: fireAtLocalMs - now };
  }
  if (now <= continueUntilLocalMs) {
    return { phase: "fire", msSinceFireTarget: now - fireAtLocalMs };
  }
  return { phase: "expired" };
}
