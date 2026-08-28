import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { wallets } from "../schema.ts";

/**
 * Wallet rows for display. Deliberately projects explicit columns and NEVER
 * the `encrypted_signing_key` blob — a managed key must not reach a
 * client-facing payload. `hasSigningKey` + fingerprint are the safe signals
 * the admin UI shows. The worker reads the blob via its own `select *`.
 */
export async function listWallets(db: Db, options: { enabledOnly?: boolean } = {}) {
  const conditions = options.enabledOnly === true ? and(eq(wallets.enabled, true)) : undefined;
  return db
    .select({
      id: wallets.id,
      address: wallets.address,
      label: wallets.label,
      enabled: wallets.enabled,
      credentialId: wallets.credentialId,
      hasSigningKey: sql<boolean>`${wallets.encryptedSigningKey} is not null`,
      signingKeyFingerprint: wallets.signingKeyFingerprint,
      signingKeyAddedAt: wallets.signingKeyAddedAt,
      createdAt: wallets.createdAt,
      updatedAt: wallets.updatedAt,
    })
    .from(wallets)
    .orderBy(wallets.createdAt)
    .where(conditions);
}

/** Seal + attach a managed signing key to a wallet (import). */
export async function setWalletSigningKey(
  db: Db,
  walletId: string,
  sealedJson: string,
  fingerprint: string,
): Promise<boolean> {
  const rows = await db
    .update(wallets)
    .set({
      encryptedSigningKey: sealedJson,
      signingKeyFingerprint: fingerprint,
      signingKeyAddedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, walletId))
    .returning({ id: wallets.id });
  return rows.length > 0;
}

/** Remove a managed signing key (revoke). */
export async function clearWalletSigningKey(db: Db, walletId: string): Promise<boolean> {
  const rows = await db
    .update(wallets)
    .set({
      encryptedSigningKey: null,
      signingKeyFingerprint: null,
      signingKeyAddedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, walletId))
    .returning({ id: wallets.id });
  return rows.length > 0;
}

/** The sealed blob only, for the worker to decrypt at fire time. */
export async function getWalletSigningKeySealed(
  db: Db,
  walletId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ sealed: wallets.encryptedSigningKey })
    .from(wallets)
    .where(eq(wallets.id, walletId))
    .limit(1);
  return row?.sealed ?? undefined;
}

export async function createWallet(
  db: Db,
  input: { address: string; label?: string; credentialId?: string },
): Promise<typeof wallets.$inferSelect | undefined> {
  const rows = await db
    .insert(wallets)
    .values({
      address: input.address.toLowerCase(),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.credentialId !== undefined ? { credentialId: input.credentialId } : {}),
    })
    .onConflictDoUpdate({
      target: wallets.address,
      set: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.credentialId !== undefined ? { credentialId: input.credentialId } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0];
}

export async function updateWallet(
  db: Db,
  id: string,
  patch: Partial<Pick<typeof wallets.$inferInsert, "label" | "enabled" | "credentialId">>,
): Promise<typeof wallets.$inferSelect | undefined> {
  const rows = await db
    .update(wallets)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(wallets.id, id))
    .returning();
  return rows[0];
}

export async function deleteWallet(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(wallets).where(eq(wallets.id, id)).returning({ id: wallets.id });
  return rows.length > 0;
}
