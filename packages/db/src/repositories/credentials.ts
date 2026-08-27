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
  | "delegated_session_key";

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
