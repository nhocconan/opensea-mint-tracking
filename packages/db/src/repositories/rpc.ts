/**
 * Custom RPC endpoint registry (ADR 0006): admin-configurable per chain,
 * replacing the single boot-time RPC_URL with a rankable pool. Read-only
 * with respect to chain state — this repository only manages *where* the
 * app reads from; see packages/core's `rankRpcEndpoints` for the pure
 * selection policy this data feeds.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type RpcEndpoint, rpcEndpoints } from "../schema.ts";

export interface UpsertRpcEndpointInput {
  readonly chainId: number;
  readonly label: string;
  readonly httpUrl: string;
  readonly wsUrl?: string;
  readonly priority?: number;
  readonly credentialId?: string;
}

export async function listRpcEndpoints(db: Db, chainId?: number): Promise<RpcEndpoint[]> {
  const query = db.select().from(rpcEndpoints);
  if (chainId !== undefined) {
    return query.where(eq(rpcEndpoints.chainId, chainId));
  }
  return query;
}

/**
 * Distinct chain ids that have at least one ENABLED RPC endpoint —
 * the set of chains the on-chain radar should sync (multi-network). The
 * worker unions this with the default Robinhood chain so the legacy
 * single-RPC_URL path keeps working even with an empty registry. */
export async function distinctEnabledRpcChainIds(db: Db): Promise<number[]> {
  const rows = await db
    .selectDistinct({ chainId: rpcEndpoints.chainId })
    .from(rpcEndpoints)
    .where(eq(rpcEndpoints.enabled, true));
  return rows.map((r) => r.chainId);
}

export async function createRpcEndpoint(
  db: Db,
  input: UpsertRpcEndpointInput,
): Promise<RpcEndpoint> {
  const inserted = await db
    .insert(rpcEndpoints)
    .values({
      chainId: input.chainId,
      label: input.label,
      httpUrl: input.httpUrl,
      priority: input.priority ?? 0,
      ...(input.wsUrl !== undefined ? { wsUrl: input.wsUrl } : {}),
      ...(input.credentialId !== undefined ? { credentialId: input.credentialId } : {}),
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("createRpcEndpoint: insert returned no row");
  }
  return row;
}

export async function setRpcEndpointEnabled(db: Db, id: string, enabled: boolean): Promise<void> {
  await db
    .update(rpcEndpoints)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(rpcEndpoints.id, id));
}

export async function recordRpcEndpointHealth(
  db: Db,
  id: string,
  health: RpcEndpoint["healthStatus"],
  options: { lastSuccessAt?: Date; errorCode?: string | null } = {},
): Promise<void> {
  await db
    .update(rpcEndpoints)
    .set({
      healthStatus: health,
      updatedAt: new Date(),
      ...(options.lastSuccessAt !== undefined ? { lastSuccessAt: options.lastSuccessAt } : {}),
      ...(options.errorCode !== undefined ? { lastErrorCode: options.errorCode } : {}),
    })
    .where(eq(rpcEndpoints.id, id));
}

export async function deleteRpcEndpoint(db: Db, id: string, chainId: number): Promise<void> {
  await db
    .delete(rpcEndpoints)
    .where(and(eq(rpcEndpoints.id, id), eq(rpcEndpoints.chainId, chainId)));
}
