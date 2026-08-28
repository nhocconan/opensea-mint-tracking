/**
 * Credential repository — secrets are sealed before they touch the database
 * and are only decrypted server-side through an explicit call (PRD §11).
 * Listing returns masked views; plaintext never leaves this module's caller
 * (worker/admin actions), never the UI.
 */

import { fingerprint, openSecret, sealSecret } from "@hoodmint/secrets";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { credentials } from "../schema.ts";

export type CredentialType =
  | "opensea_api_key"
  | "opensea_pat"
  | "opensea_instant_key"
  | "telegram_bot"
  | "webhook"
  | "discord_webhook"
  /** ADR 0004 Phase 2: a hot session-key private key for the custom
   *  Executor contract's `operator` role — distinct type from every other
   *  credential above because packages/signing (the one place a
   *  spend-capable key is ever decrypted, per this file's own header
   *  comment) gates on this exact type string before treating a
   *  credential row as key material rather than an API token. */
  | "delegated_session_key"
  /** xAI (Grok) hype/risk signals (ADR 0007). Distinct types because they
   *  are resolved in priority order by the worker and revoked
   *  independently by the operator:
   *  - `xai_user_token`: sealed JSON `{access_token, refresh_token,
   *    expires_at, scopes}` from the RFC 8628 device-code grant — this is
   *    the operator's X Premium+/SuperGrok subscription. Rotated in place
   *    on refresh (xAI issues a NEW refresh token every time).
   *  - `xai_api_key`: a plain console.x.ai API key, the alternative to the
   *    subscription grant (separate xAI billing).
   *  - `xai_oauth_client`: OPTIONAL sealed JSON `{client_id, endpoints?}`
   *    overriding the built-in public Grok-CLI client and endpoints.
   *    Absent = defaults, which is all a subscriber needs. Non-secret
   *    `client_id` is mirrored into `metadata.clientId` for display.
   *  - `xai_device_pending`: sealed JSON `{device_code, interval,
   *    expires_at}` for an in-flight device grant. The device_code is
   *    bearer-equivalent — whoever holds it can complete the grant — so it
   *    is sealed like any other secret and never returned to a browser.
   *    Short-lived; deleted when the poll resolves. */
  | "xai_user_token"
  | "xai_api_key"
  | "xai_oauth_client"
  | "xai_device_pending";

export interface CreateCredentialInput {
  readonly type: CredentialType;
  readonly name: string;
  readonly secret: string;
  readonly masterKey: string;
  readonly metadata?: Record<string, unknown>;
  readonly expiresAt?: Date;
  readonly createdBy?: string;
}

export interface CredentialView {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly expiresAt: Date | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export async function createCredential(
  db: Db,
  input: CreateCredentialInput,
): Promise<CredentialView> {
  const sealed = sealSecret(input.secret, input.masterKey);
  const rows = await db
    .insert(credentials)
    .values({
      type: input.type,
      name: input.name,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      fingerprint: fingerprint(input.secret),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("credential insert returned no row");
  }
  return toView(row);
}

/** Server-only plaintext access for workers and admin test actions. */
export async function getCredentialSecret(
  db: Db,
  id: string,
  masterKey: string,
): Promise<string | undefined> {
  const rows = await db.select().from(credentials).where(eq(credentials.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return openSecret(
    { ciphertext: row.ciphertext, keyVersion: row.keyVersion, algorithm: "aes-256-gcm" },
    masterKey,
  );
}

export interface UpdateCredentialSecretInput {
  readonly secret: string;
  readonly masterKey: string;
  readonly metadata?: Record<string, unknown>;
  readonly expiresAt?: Date | null;
}

/**
 * Re-seal a credential's secret in place. One UPDATE, so a rotated OAuth
 * refresh token and its new expiry/metadata land atomically — a crash can
 * never leave the row holding an already-invalidated refresh token beside a
 * fresh expiry. Returns undefined when the row was revoked concurrently.
 */
export async function updateCredentialSecret(
  db: Db,
  id: string,
  input: UpdateCredentialSecretInput,
): Promise<CredentialView | undefined> {
  const sealed = sealSecret(input.secret, input.masterKey);
  const rows = await db
    .update(credentials)
    .set({
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      fingerprint: fingerprint(input.secret),
      updatedAt: new Date(),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    })
    .where(eq(credentials.id, id))
    .returning();
  const row = rows[0];
  return row === undefined ? undefined : toView(row);
}

/**
 * Merge non-secret operational state (health, last error code, connection
 * timestamps) into a credential's metadata. Never touches the ciphertext,
 * and callers must never put a secret value in here — metadata is returned
 * by `listCredentials` and rendered in the admin UI.
 */
export async function updateCredentialMetadata(
  db: Db,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const rows = await db.select().from(credentials).where(eq(credentials.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    return;
  }
  await db
    .update(credentials)
    .set({ metadata: { ...(row.metadata ?? {}), ...patch }, updatedAt: new Date() })
    .where(eq(credentials.id, id));
}

export async function findCredentialByType(
  db: Db,
  type: CredentialType,
): Promise<CredentialView | undefined> {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.type, type))
    .orderBy(desc(credentials.createdAt))
    .limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toView(row);
}

export async function listCredentials(db: Db): Promise<CredentialView[]> {
  const rows = await db.select().from(credentials).orderBy(desc(credentials.createdAt));
  return rows.map(toView);
}

export async function revokeCredential(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(credentials)
    .where(eq(credentials.id, id))
    .returning({ id: credentials.id });
  return rows.length > 0;
}

function toView(row: typeof credentials.$inferSelect): CredentialView {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    fingerprint: row.fingerprint,
    expiresAt: row.expiresAt,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
  };
}
