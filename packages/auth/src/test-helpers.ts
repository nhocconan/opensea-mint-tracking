/**
 * Pure helpers shared by auth flows; kept free of Better Auth imports so
 * they are unit-testable without a server.
 */
import { createHash } from "node:crypto";
import { fingerprint } from "@hoodmint/secrets";

/** Correlation-safe redaction of emails for audit metadata. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (local === undefined || domain === undefined) {
    return fingerprint(email);
  }
  const head = local.slice(0, 1);
  return `${head}${"•".repeat(Math.max(local.length - 1, 2))}@${domain}`;
}

/** Deterministic avatar color for a wallet address chip (UI hint only). */
export function addressHue(address: string): number {
  const hash = createHash("sha256").update(address.toLowerCase()).digest();
  return hash[0] as number;
}
