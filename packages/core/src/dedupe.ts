/**
 * Deduplication keys (PRD §7.4). The key must include tenant/deployment,
 * wallet, project, stage identity, alert type, and threshold so the same
 * opportunity can legitimately re-alert at a different threshold, but never
 * twice for the same one. Components are length-prefixed to make the key
 * collision-free without hashing ambiguity.
 */
export type AlertType =
  | "restricted_eligible"
  | "stage_starting"
  | "watched_live"
  | "watched_nearing_sellout"
  | "source_failure";

export interface AlertKeyParts {
  readonly deploymentId: string;
  readonly walletId: string;
  readonly projectId: string;
  readonly stageId: string;
  readonly alertType: AlertType;
  /** Threshold in minutes (windows) or 0 for non-threshold alerts. */
  readonly thresholdMinutes: number;
}

export function alertDedupeKey(parts: AlertKeyParts): string {
  const components: readonly string[] = [
    parts.deploymentId,
    parts.walletId,
    parts.projectId,
    parts.stageId,
    parts.alertType,
    String(parts.thresholdMinutes),
  ];
  return components.map((c) => `${c.length}:${c}`).join("|");
}

/** Deterministic job IDs (PRD §8.4). */
export const jobId = {
  discovery: (provider: string, dropType: string, windowStart: number): string =>
    `discover:${provider}:${dropType}:${windowStart}`,
  detail: (provider: string, externalId: string, bucket: string): string =>
    `detail:${provider}:${externalId}:${bucket}`,
  chainSync: (chainId: number, fromBlock: bigint, toBlock: bigint): string =>
    `chain:${chainId}:${fromBlock.toString(10)}:${toBlock.toString(10)}`,
  eligibility: (walletId: string, dropId: string, stageVersion: number): string =>
    `eligibility:${walletId}:${dropId}:${stageVersion}`,
  notification: (outboxRowId: string): string => `notify:${outboxRowId}`,
  /**
   * Rarity refresh (feature-backlog.md §2): admin-triggered, not scheduled,
   * so unlike the other job kinds this deliberately includes a timestamp —
   * an operator clicking "Refresh" twice in quick succession should collapse
   * onto one job (rounded to the minute, same bucketing scanNowAction/
   * enqueueMaintenance already use), but a refresh a day later must run again
   * rather than being silently deduped against a stale completed job id.
   */
  rarity: (projectId: string, triggeredAtMs: number): string =>
    `rarity:${projectId}:${Math.floor(triggeredAtMs / 60_000)}`,
} as const;
