/**
 * Source confidence rules (PRD §5.2/§7.2).
 *
 * verified      authoritative source confirmed the field directly.
 * corroborated  two independent sources agree.
 * single-source one source only; plausible but unconfirmed.
 * unverified    manual/calendar input awaiting corroboration.
 */
export const CONFIDENCE_LEVELS = [
  "verified",
  "corroborated",
  "single-source",
  "unverified",
] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export function combineConfidence(levels: readonly Confidence[]): Confidence {
  if (levels.length === 0) {
    return "unverified";
  }
  const verified = levels.includes("verified");
  const corroboratingSources = levels.filter((l) => l !== "unverified").length;
  if (verified && corroboratingSources >= 2) {
    return "verified";
  }
  if (corroboratingSources >= 2) {
    return "corroborated";
  }
  if (corroboratingSources === 1) {
    return verified ? "verified" : "single-source";
  }
  return "unverified";
}

/**
 * Canonical identity (PRD §7.2): (chainId, contractAddress) once the contract
 * is known; before that, a source-scoped external id that merges later.
 */
export function projectIdentity(input: {
  chainId: number;
  contractAddress: string | null;
  providerId: string;
  externalId: string;
}): { kind: "contract"; key: string } | { kind: "external"; key: string } {
  if (input.contractAddress !== null) {
    return { kind: "contract", key: `${input.chainId}:${input.contractAddress.toLowerCase()}` };
  }
  return { kind: "external", key: `${input.providerId}:${input.externalId}` };
}
