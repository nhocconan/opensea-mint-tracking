import { and, desc, eq, gte, ilike, or, sql } from "drizzle-orm";
import { type Db, unwrapRows } from "../client.ts";
import { auditLogs, bootstrapTokens, chainCheckpoints, scanRuns, settings } from "../schema.ts";

/* ── Scan runs ────────────────────────────────────────────────────────────── */

export async function startScanRun(
  db: Db,
  input: { providerId: string | null; kind: string; correlationId: string },
): Promise<string> {
  const rows = await db
    .insert(scanRuns)
    .values({
      providerId: input.providerId,
      kind: input.kind,
      startedAt: new Date(),
      status: "running",
      correlationId: input.correlationId,
    })
    .returning({ id: scanRuns.id });
  return rows[0]?.id as string;
}

export async function finishScanRun(
  db: Db,
  id: string,
  patch: {
    status: "success" | "partial" | "failed";
    counts?: Record<string, number>;
    errorCode?: string;
  },
): Promise<void> {
  await db
    .update(scanRuns)
    .set({
      finishedAt: new Date(),
      status: patch.status,
      ...(patch.counts !== undefined ? { counts: patch.counts } : {}),
      ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
    })
    .where(eq(scanRuns.id, id));
}

export async function recentScanRuns(
  db: Db,
  limit = 20,
): Promise<(typeof scanRuns.$inferSelect)[]> {
  return db.select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(limit);
}

/* ── Chain checkpoints ────────────────────────────────────────────────────── */

export interface Checkpoint {
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

export async function getCheckpoint(
  db: Db,
  chainId: number,
  providerId: string,
): Promise<Checkpoint | undefined> {
  const rows = await db
    .select()
    .from(chainCheckpoints)
    .where(and(eq(chainCheckpoints.chainId, chainId), eq(chainCheckpoints.providerId, providerId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? undefined : { blockNumber: row.blockNumber, blockHash: row.blockHash };
}

export async function saveCheckpoint(
  db: Db,
  chainId: number,
  providerId: string,
  checkpoint: Checkpoint,
): Promise<void> {
  await db
    .insert(chainCheckpoints)
    .values({
      chainId,
      providerId,
      blockNumber: checkpoint.blockNumber,
      blockHash: checkpoint.blockHash,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [chainCheckpoints.chainId, chainCheckpoints.providerId],
      set: {
        blockNumber: checkpoint.blockNumber,
        blockHash: checkpoint.blockHash,
        updatedAt: new Date(),
      },
    });
}

export async function markEventsFinalized(db: Db, throughBlock: bigint): Promise<number> {
  const rows = await db.execute(sql`
    update mint_events set finalized = true
     where finalized = false and block_number <= ${throughBlock}
    returning id
  `);
  return unwrapRows(rows).length;
}

export async function unfinalizeFromBlock(db: Db, fromBlock: bigint): Promise<number> {
  const rows = await db.execute(sql`
    update mint_events set finalized = false
     where block_number >= ${fromBlock}
    returning id
  `);
  return unwrapRows(rows).length;
}

/* ── Audit log ────────────────────────────────────────────────────────────── */

export interface AuditInput {
  readonly actorUserId: string | null;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly result: "success" | "failure";
  readonly metadata?: Record<string, unknown>;
  readonly correlationId?: string;
}

/** Metadata must already be redacted by the caller (PRD §11). */
export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  await db.insert(auditLogs).values({
    actorUserId: input.actorUserId,
    action: input.action,
    ...(input.targetType !== undefined ? { targetType: input.targetType } : {}),
    ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
    result: input.result,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });
}

export async function recentAuditLogs(
  db: Db,
  limit = 50,
): Promise<(typeof auditLogs.$inferSelect)[]> {
  return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
}

export interface ListAuditOptions {
  readonly limit?: number;
  readonly offset?: number;
  /** Case-insensitive substring on actor id, action, target type, or target id. */
  readonly search?: string;
}

function auditFilters(options: ListAuditOptions) {
  const search = options.search?.trim();
  if (search === undefined || search === "") {
    return undefined;
  }
  const term = `%${search}%`;
  return or(
    ilike(auditLogs.actorUserId, term),
    ilike(auditLogs.action, term),
    ilike(auditLogs.targetType, term),
    ilike(auditLogs.targetId, term),
  );
}

/** Paginated + searchable audit log (admin list-quality pass). */
export async function listAuditLogs(
  db: Db,
  options: ListAuditOptions = {},
): Promise<(typeof auditLogs.$inferSelect)[]> {
  const base = db
    .select()
    .from(auditLogs)
    .where(auditFilters(options))
    .orderBy(desc(auditLogs.createdAt))
    .limit(options.limit ?? 50);
  return options.offset !== undefined ? base.offset(options.offset) : base;
}

export async function countAuditLogs(db: Db, options: ListAuditOptions = {}): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(auditFilters(options));
  return rows[0]?.count ?? 0;
}

/* ── Settings ─────────────────────────────────────────────────────────────── */

export async function getSetting<T>(db: Db, key: string): Promise<T | undefined> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return rows[0]?.value as T | undefined;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/* ── Bootstrap tokens (PRD §7.6) ──────────────────────────────────────────── */

export async function insertBootstrapToken(
  db: Db,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await db.insert(bootstrapTokens).values({ tokenHash, expiresAt });
}

/** Returns true exactly once: consume is atomic. */
export async function consumeBootstrapToken(db: Db, tokenHash: string): Promise<boolean> {
  const rows = await db.execute(sql`
    update bootstrap_tokens set used_at = now()
     where token_hash = ${tokenHash}
       and used_at is null
       and expires_at > now()
    returning id
  `);
  return unwrapRows(rows).length > 0;
}

export async function auditCountToday(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(gte(auditLogs.createdAt, sql`now() - interval '24 hours'`));
  return rows[0]?.count ?? 0;
}
