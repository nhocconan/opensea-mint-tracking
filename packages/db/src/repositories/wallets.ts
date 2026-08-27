import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { wallets } from "../schema.ts";

export async function listWallets(db: Db, options: { enabledOnly?: boolean } = {}) {
  const conditions = options.enabledOnly === true ? and(eq(wallets.enabled, true)) : undefined;
  return db.select().from(wallets).orderBy(wallets.createdAt).where(conditions);
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
