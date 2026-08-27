/**
 * Clock calibration for stage-timing precision (ADR 0009, mint-race
 * competitiveness, item P5). Standard NTP-style offset tracking, not a
 * discovery unique to mint-bot tooling: the worker's own OS clock can
 * drift from the chain's clock by hundreds of milliseconds, and "when does
 * a stage open" scheduling decisions (eligibility alerts, P4's speculative
 * pre-build trigger) are only as precise as that offset is known.
 */

/** Settings-table key this offset is persisted under (packages/db). */
export const CHAIN_CLOCK_OFFSET_SETTING_KEY = "chain_clock_offset_ms";

/**
 * Positive result: the local clock is AHEAD of chain time (local thinks
 * it's later than the chain does). Negative: local is BEHIND. Chain block
 * timestamps are Unix seconds (EVM standard); localNowMs is milliseconds.
 */
export function computeClockOffsetMs(localNowMs: number, chainBlockTimestampSec: number): number {
  return localNowMs - chainBlockTimestampSec * 1000;
}

/**
 * Apply a stored offset to a local timestamp to estimate the corresponding
 * chain-clock time. `offsetMs` is exactly what computeClockOffsetMs
 * returns — subtracting it converts "local now" to "estimated chain now".
 */
export function toChainTimeMs(localNowMs: number, offsetMs: number): number {
  return localNowMs - offsetMs;
}
