import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type ProviderRow, providers } from "../schema.ts";

export type ProviderKind =
  | "opensea"
  | "robinhood_rpc"
  | "calendar"
  | "manual"
  /** Per-chain RPC provider for the multi-network on-chain radar — one
   *  registry row (and thus one checkpoint namespace) per non-default
   *  chain, e.g. "rpc_8453" for Base. The default Robinhood chain keeps
   *  the legacy "robinhood_rpc" kind for continuity. */
  | `rpc_${number}`;

/** Idempotently ensure a provider registry row exists and return it. */
export async function ensureProvider(
  db: Db,
  kind: ProviderKind,
  defaults: { config?: Record<string, unknown> } = {},
): Promise<ProviderRow> {
  const existing = await db.select().from(providers).where(eq(providers.kind, kind)).limit(1);
  const found = existing[0];
  if (found) {
    return found;
  }
  const inserted = await db
    .insert(providers)
    .values({ kind, config: defaults.config ?? {} })
    .onConflictDoUpdate({ target: providers.kind, set: { updatedAt: new Date() } })
    .returning();
  return inserted[0] as ProviderRow;
}

export async function listProviders(db: Db): Promise<ProviderRow[]> {
  return db.select().from(providers).orderBy(providers.kind);
}

export async function updateProvider(
  db: Db,
  id: string,
  patch: Partial<Pick<ProviderRow, "enabled" | "config">>,
): Promise<ProviderRow | undefined> {
  const updated = await db
    .update(providers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(providers.id, id))
    .returning();
  return updated[0];
}

export async function markProviderHealth(
  db: Db,
  kind: ProviderKind,
  health: ProviderRow["healthStatus"],
  options: { lastSuccessAt?: Date; errorCode?: string | null } = {},
): Promise<void> {
  await db
    .update(providers)
    .set({
      healthStatus: health,
      updatedAt: new Date(),
      ...(options.lastSuccessAt !== undefined ? { lastSuccessAt: options.lastSuccessAt } : {}),
      ...(options.errorCode !== undefined ? { lastErrorCode: options.errorCode } : {}),
    })
    .where(eq(providers.kind, kind));
}
