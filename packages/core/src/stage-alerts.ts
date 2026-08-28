/**
 * Stage-starting alert window selection (PRD §7.4): "Eligible stage starts
 * in configurable windows (default 60m, 15m, 5m)." Each configured window
 * is an independent threshold, so a stage first observed close to its start
 * (e.g. 3 minutes out) is due an alert for every window it has already
 * crossed, not only the smallest — the notification outbox's dedupe key
 * (one per stage + window) is what keeps each threshold firing at most
 * once, not this selection.
 */

/**
 * Window minutes (subset of `windowsMinutesDesc`, order preserved) whose
 * threshold a stage has already crossed: `0 < msUntilStartMs <= minutes *
 * 60_000`. A stage that has already started or has no known start
 * (`msUntilStartMs <= 0`) matches nothing.
 */
export function dueStageStartingWindows(
  msUntilStartMs: number,
  windowsMinutesDesc: readonly number[],
): number[] {
  if (msUntilStartMs <= 0) {
    return [];
  }
  return windowsMinutesDesc.filter((minutes) => msUntilStartMs <= minutes * 60_000);
}
