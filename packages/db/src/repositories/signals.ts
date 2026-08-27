/**
 * Sentiment/risk signals (ADR 0007): advisory-only, provenance-tracked, and
 * structurally forbidden from writing to projects.confidence,
 * projects.lifecycleStatus, or eligibilityChecks.status — this repository
 * exposes no function that touches those tables, which is the actual
 * enforcement mechanism, not just a comment. Nothing in this repository is
 * wired to a live source yet; packages/signals (X OAuth adapter) is Phase 0
 * scaffolding, not shipped.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.ts";
import { projects, type Signal, signals } from "../schema.ts";

export interface InsertSignalInput {
  readonly projectId?: string;
  readonly subject: string;
  readonly source: string;
  readonly kind: Signal["kind"];
  readonly score: number;
  readonly confidence: Signal["confidence"];
  readonly evidence?: Record<string, unknown>;
  readonly observedAt: Date;
}

export async function insertSignal(db: Db, input: InsertSignalInput): Promise<Signal> {
  const inserted = await db
    .insert(signals)
    .values({
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      subject: input.subject,
      source: input.source,
      kind: input.kind,
      score: input.score,
      confidence: input.confidence,
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      observedAt: input.observedAt,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("insertSignal: insert returned no row");
  }
  return row;
}

export async function listSignalsForProject(
  db: Db,
  projectId: string,
  limit = 50,
): Promise<Signal[]> {
  return db
    .select()
    .from(signals)
    .where(eq(signals.projectId, projectId))
    .orderBy(desc(signals.observedAt))
    .limit(limit);
}

/**
 * The most recent signal for a subject+source+kind — used by the sentiment
 * worker for the rolling mention baseline (the prior hype scan's tweet
 * count, stored in evidence) and to bound the search with `since_id`. */
export async function latestSignal(
  db: Db,
  subject: string,
  source: string,
  kind: Signal["kind"],
): Promise<Signal | undefined> {
  const [row] = await db
    .select()
    .from(signals)
    .where(and(eq(signals.subject, subject), eq(signals.source, source), eq(signals.kind, kind)))
    .orderBy(desc(signals.observedAt))
    .limit(1);
  return row;
}

/**
 * Latest hype + risk signal per project, for the feed/detail UI — one row
 * per (project, kind), newest first. Kept small; the UI shows a compact
 * badge, not a history. */
export async function latestSignalsForProject(
  db: Db,
  projectId: string,
): Promise<{ hype?: Signal; risk?: Signal }> {
  const rows = await listSignalsForProject(db, projectId, 20);
  const hype = rows.find((r) => r.kind === "hype");
  const risk = rows.find((r) => r.kind === "risk");
  return {
    ...(hype !== undefined ? { hype } : {}),
    ...(risk !== undefined ? { risk } : {}),
  };
}

/**
 * Projects worth scanning for sentiment right now: LIVE or NEXT lifecycle,
 * with a name or slug to query X by. Bounded — the sentiment worker caps
 * how many it scans per pass to control the metered X API cost (ADR 0007).
 * Ordered by most-recently-seen so the active drops get scanned first. */
export async function projectsForSentimentScan(
  db: Db,
  limit: number,
): Promise<{ id: string; name: string; slug: string | null }[]> {
  return db
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.lifecycleStatus, ["LIVE", "NEXT"]))
    .orderBy(desc(projects.lastSeenAt))
    .limit(limit);
}
