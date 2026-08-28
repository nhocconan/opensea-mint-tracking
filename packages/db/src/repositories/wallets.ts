import { and, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { wallets } from "../schema.ts";

export interface ListWalletsOptions {
  readonly enabledOnly?: boolean;
  /** Case-insensitive substring match on address OR label. */
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

function walletFilters(options: ListWalletsOptions) {
  const clauses = [];
  if (options.enabledOnly === true) {
    clauses.push(eq(wallets.enabled, true));
  }
  const search = options.search?.trim();
  if (search !== undefined && search !== "") {
    const term = `%${search}%`;
    clauses.push(or(ilike(wallets.address, term), ilike(wallets.label, term)));
  }
  return clauses.length === 0 ? undefined : and(...clauses);
}

/**
 * Wallet rows for display. Deliberately projects explicit columns and NEVER
 * the `encrypted_signing_key` blob — a managed key must not reach a
 * client-facing payload. `hasSigningKey` + fingerprint are the safe signals
 * the admin UI shows. The worker reads the blob via its own `select *`.
 *
 * Optional `search`/`limit`/`offset` back the admin list's server-side
 * pagination + search; omitted, behavior is unchanged for the worker and
 * eligibility callers that just want every enabled wallet.
 */
export async function listWallets(db: Db, options: ListWalletsOptions = {}) {
  const base = db
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
    .where(walletFilters(options));
  const limited = options.limit !== undefined ? base.limit(options.limit) : base;
  return options.offset !== undefined ? limited.offset(options.offset) : limited;
}

/** Total wallets matching the same filters — for pagination page counts. */
export async function countWallets(db: Db, options: ListWalletsOptions = {}): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(wallets)
    .where(walletFilters(options));
  return rows[0]?.count ?? 0;
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
