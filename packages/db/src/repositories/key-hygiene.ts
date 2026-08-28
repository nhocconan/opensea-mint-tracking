/**
 * Managed-key hygiene (owner requirement, 2026-08-28): once a wallet's
 * signing key is revoked or the wallet is deleted, NOTHING derived from that
 * key may remain on the server — not the sealed blob (dropped with the
 * column/row), not pre-signed raw transactions (spend-capable artifacts on
 * plan rows), and not the key fingerprint that the import audit row used to
 * carry. Audit rows themselves stay (who did what, when) but are scrubbed
 * of any key-derived value.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { auditLogs } from "../schema.ts";

/**
 * Remove key-derived metadata from audit rows that reference this wallet
 * address (the `wallet.key_import` rows). Returns rows touched.
 */
export async function scrubKeyTracesForAddress(db: Db, address: string): Promise<number> {
  const rows = await db
    .update(auditLogs)
    .set({
      // Keep the action + address (public), drop the key fingerprint and any
      // other key-derived value; mark that scrubbing happened.
      metadata: sql`(coalesce(${auditLogs.metadata}, '{}'::jsonb) - 'fingerprint') || '{"key_scrubbed": true}'::jsonb`,
    })
    .where(
      and(
        eq(auditLogs.targetType, "wallet"),
        eq(auditLogs.targetId, address.toLowerCase()),
        sql`${auditLogs.metadata} ? 'fingerprint'`,
      ),
    )
    .returning({ id: auditLogs.id });
  return rows.length;
}

/**
 * Postgres keeps the OLD row version (still holding the ciphertext / raw tx)
 * as a dead tuple after an UPDATE/DELETE until vacuum reclaims it. Run a
 * plain VACUUM on the three key-bearing tables right after revoke/delete so
 * the dead copies are dropped promptly rather than on autovacuum's schedule.
 * Plain VACUUM (not FULL) takes no exclusive lock, so it is safe to run
 * from a request handler; it cannot run inside a transaction, so this must
 * be called on the pool, never inside `db.transaction`. Best-effort: the
 * caller's hygiene already succeeded when this runs, so a failure here is
 * reported, not thrown.
 */
export async function vacuumKeyTables(db: Db): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.execute(sql`vacuum wallets`);
    await db.execute(sql`vacuum mint_plans`);
    await db.execute(sql`vacuum audit_logs`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
