/**
 * Notification outbox (PRD §7.4): alerts are enqueued idempotently by dedupe
 * key, dispatched by the worker, retried independently of discovery, and only
 * marked sent after the provider acknowledges. Delivery attempts are recorded
 * with sanitized responses.
 */

import type { AlertType } from "@hoodmint/core";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { type Db, unwrapRows } from "../client.ts";
import { alertChannels, notificationAttempts, notificationOutbox } from "../schema.ts";

/**
 * Toggle a channel's `enabled` flag (admin alert-channel CRUD). A disabled
 * channel is skipped by the outbox dispatcher's `enabled = true` filter, so
 * this is the pause switch that doesn't destroy the (encrypted) credential.
 * Returns true when a row matched.
 */
export async function setAlertChannelEnabled(
  db: Db,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await db
    .update(alertChannels)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(alertChannels.id, id))
    .returning({ id: alertChannels.id });
  return rows.length > 0;
}

/**
 * Delete an alert channel row. The linked credential (bot token / webhook
 * URL) is left to the credential lifecycle — callers that own the secret
 * revoke it separately; a `web_push` channel keeps its subscription inline
 * in `config`, which goes with the row. Returns the deleted channel's kind +
 * credentialId so the action layer can audit and clean up.
 */
export async function deleteAlertChannel(
  db: Db,
  id: string,
): Promise<{ kind: string; credentialId: string | null } | undefined> {
  const rows = await db
    .delete(alertChannels)
    .where(eq(alertChannels.id, id))
    .returning({ kind: alertChannels.kind, credentialId: alertChannels.credentialId });
  return rows[0];
}

export interface EnqueueAlertInput {
  readonly dedupeKey: string;
  readonly alertType: AlertType;
  readonly walletId?: string;
  readonly projectId?: string;
  readonly stageId?: string;
  readonly thresholdMinutes: number;
  readonly payload: Record<string, unknown>;
}

/** Idempotent enqueue; returns true when a new row was created. */
export async function enqueueAlert(db: Db, input: EnqueueAlertInput): Promise<boolean> {
  const rows = await db
    .insert(notificationOutbox)
    .values({
      dedupeKey: input.dedupeKey,
      alertType: input.alertType,
      ...(input.walletId !== undefined ? { walletId: input.walletId } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
      thresholdMinutes: input.thresholdMinutes,
      payload: input.payload,
      status: "pending",
      nextAttemptAt: new Date(),
    })
    .onConflictDoNothing({ target: notificationOutbox.dedupeKey })
    .returning({ id: notificationOutbox.id });
  return rows.length > 0;
}

export type ClaimedAlert = typeof notificationOutbox.$inferSelect & {
  channels: {
    id: string;
    kind: string;
    credentialId: string | null;
    config: Record<string, unknown>;
  }[];
};

/** Atomically claim due pending rows (at-least-once, safe under concurrency). */
export async function claimDueAlerts(db: Db, now: Date, limit: number): Promise<ClaimedAlert[]> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      with due as (
        select id from notification_outbox
         where status = 'pending' and next_attempt_at <= ${now.toISOString()}
         order by next_attempt_at asc
         limit ${sql.raw(String(Math.max(1, Math.min(limit, 100))))}
         for update skip locked
      )
      update notification_outbox o
         set status = 'inflight', attempts = o.attempts + 1
        from due
       where o.id = due.id
      returning
        o.id,
        o.dedupe_key as "dedupeKey",
        o.alert_type as "alertType",
        o.wallet_id as "walletId",
        o.project_id as "projectId",
        o.stage_id as "stageId",
        o.threshold_minutes as "thresholdMinutes",
        o.payload,
        o.status,
        o.attempts,
        o.next_attempt_at as "nextAttemptAt",
        o.last_error_code as "lastErrorCode",
        o.sanitized_response as "sanitizedResponse",
        o.created_at as "createdAt",
        o.sent_at as "sentAt"
    `);
    // db.execute returns raw driver rows with whatever column names the
    // query names them — plain "returning o.*" would give snake_case and
    // silently produce objects with every camelCase field `undefined`
    // (found via live integration testing, 2026-08-22). The explicit
    // aliases above are what make this cast actually true.
    const alerts = unwrapRows<typeof notificationOutbox.$inferSelect>(rows);
    if (alerts.length === 0) {
      return [];
    }
    const channels = await tx.select().from(alertChannels).where(eq(alertChannels.enabled, true));
    return alerts.map((alert) => ({
      ...alert,
      channels: channels.map((c) => ({
        id: c.id,
        kind: c.kind,
        credentialId: c.credentialId,
        config: c.config ?? {},
      })),
    }));
  });
}

export async function recordAttempt(
  db: Db,
  input: {
    outboxId: string;
    channelKind: string;
    status: "success" | "failure";
    latencyMs: number;
    errorCode?: string;
    sanitizedResponse?: string;
  },
): Promise<void> {
  await db.insert(notificationAttempts).values({
    outboxId: input.outboxId,
    channelKind: input.channelKind,
    status: input.status,
    attemptAt: new Date(),
    latencyMs: input.latencyMs,
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.sanitizedResponse !== undefined
      ? { sanitizedResponse: input.sanitizedResponse }
      : {}),
  });
}

/** Full-jitter exponential backoff; dead after maxAttempts. */
export function nextRetryDelayMs(attempts: number): number {
  const base = Math.min(60_000 * 2 ** (attempts - 1), 6 * 60 * 60_000);
  return Math.floor(Math.random() * base);
}

export async function markAlertSent(
  db: Db,
  id: string,
  sanitizedResponse: string | undefined,
): Promise<void> {
  await db
    .update(notificationOutbox)
    .set({
      status: "sent",
      sentAt: new Date(),
      ...(sanitizedResponse !== undefined ? { sanitizedResponse } : {}),
      lastErrorCode: null,
    })
    .where(eq(notificationOutbox.id, id));
}

export async function markAlertFailed(
  db: Db,
  id: string,
  errorCode: string,
  sanitizedResponse: string | undefined,
  maxAttempts = 6,
): Promise<void> {
  const rows = await db
    .select({ attempts: notificationOutbox.attempts })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.id, id));
  const attempts = rows[0]?.attempts ?? 0;
  const dead = attempts >= maxAttempts;
  await db
    .update(notificationOutbox)
    .set({
      status: dead ? "dead" : "pending",
      nextAttemptAt: dead ? new Date(0) : new Date(Date.now() + nextRetryDelayMs(attempts)),
      lastErrorCode: errorCode,
      ...(sanitizedResponse !== undefined ? { sanitizedResponse } : {}),
    })
    .where(eq(notificationOutbox.id, id));
}

export async function pendingOutboxDepth(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notificationOutbox)
    .where(
      and(
        sql`${notificationOutbox.status} in ('pending', 'inflight')`,
        lte(notificationOutbox.nextAttemptAt, sql`now() + interval '1 hour'`),
      ),
    );
  return rows[0]?.count ?? 0;
}

export async function listOutbox(
  db: Db,
  limit = 50,
): Promise<(typeof notificationOutbox.$inferSelect)[]> {
  return db
    .select()
    .from(notificationOutbox)
    .orderBy(sql`${notificationOutbox.status} = 'pending' desc`, asc(notificationOutbox.createdAt))
    .limit(limit);
}
