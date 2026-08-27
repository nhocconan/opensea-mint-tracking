/**
 * Sentiment/risk signal scan (ADR 0007). Reads public X mentions of the
 * LIVE/NEXT drops, scores hype + phishing-risk, and writes advisory-only
 * `signals` rows — NEVER touches projects.confidence / lifecycleStatus /
 * eligibility (packages/signals can't even import @hoodmint/db; this worker
 * only calls insertSignal, which exposes nothing that writes those tables).
 *
 * HARD-GATED, off by default: does nothing unless the operator both set
 * X_SIGNALS_ENABLED=true AND supplied X_API_BEARER_TOKEN. X's free tier was
 * retired Feb 2026 (verified against docs.x.com), so this endpoint is
 * metered pay-per-use — the scan is bounded to a small number of projects
 * per pass, one API call each, to keep spend predictable.
 */

import { isAppError } from "@hoodmint/core";
import {
  finishScanRun,
  insertSignal,
  latestSignal,
  projectsForSentimentScan,
  startScanRun,
} from "@hoodmint/db";
import { XClient } from "@hoodmint/providers";
import { scanProjectSignals } from "@hoodmint/signals";
import type { WorkerContext } from "../context.ts";

export interface SentimentScanSummary {
  readonly enabled: boolean;
  readonly scanned: number;
  readonly signalsWritten: number;
  readonly failed: number;
}

/** How many projects to scan per pass — one metered X call each. */
const MAX_PROJECTS_PER_PASS = 5;

export async function runSentimentScan(ctx: WorkerContext): Promise<SentimentScanSummary> {
  const { db, config, log } = ctx;
  if (!config.X_SIGNALS_ENABLED || config.X_API_BEARER_TOKEN === undefined) {
    return { enabled: false, scanned: 0, signalsWritten: 0, failed: 0 };
  }

  const scanRunId = await startScanRun(db, {
    providerId: null,
    kind: "sentiment",
    correlationId: crypto.randomUUID(),
  });

  const client = new XClient({ bearerToken: config.X_API_BEARER_TOKEN });
  const candidates = await projectsForSentimentScan(db, MAX_PROJECTS_PER_PASS);
  let scanned = 0;
  let signalsWritten = 0;
  let failed = 0;

  for (const project of candidates) {
    // Query by slug when we have it (tighter), else the project name. Both
    // are collection identifiers, not user handles — app-only search of
    // public posts (ADR 0007), never a private timeline.
    const subject = project.slug ?? project.name;
    const query = project.slug ?? `"${project.name}"`;
    try {
      // Rolling baseline: the previous hype scan's tweet count for this
      // subject (stored in evidence), and since_id to only pull posts newer
      // than last time — both make "how much louder than usual" meaningful
      // and cut API cost.
      const prev = await latestSignal(db, subject, "x_mentions", "hype");
      const baselineAvgMentions =
        typeof prev?.evidence?.tweetCount === "number" ? prev.evidence.tweetCount : 0;
      const sinceId =
        typeof prev?.evidence?.newestId === "string" ? prev.evidence.newestId : undefined;

      const result = await scanProjectSignals({
        client,
        query,
        baselineAvgMentions,
        ...(sinceId !== undefined ? { sinceId } : {}),
      });
      scanned += 1;

      const observedAt = new Date();
      await insertSignal(db, {
        projectId: project.id,
        subject,
        source: "x_mentions",
        kind: "hype",
        score: result.hype.score,
        confidence: result.hype.confidence,
        evidence: {
          tweetCount: result.tweetCount,
          velocityRatio: result.hype.velocityRatio,
          newestId: result.newestId,
        },
        observedAt,
      });
      signalsWritten += 1;

      await insertSignal(db, {
        projectId: project.id,
        subject,
        source: "x_mentions",
        kind: "risk",
        score: result.risk.score,
        confidence: result.risk.confidence,
        evidence: {
          tweetCount: result.tweetCount,
          flaggedFraction: result.risk.flaggedFraction,
          flags: result.risk.flags,
        },
        observedAt,
      });
      signalsWritten += 1;
    } catch (error) {
      failed += 1;
      log.warn(
        {
          projectId: project.id,
          errorCode: isAppError(error) ? error.category : "unknown",
        },
        "sentiment scan failed for project (non-fatal)",
      );
    }
  }

  await finishScanRun(db, scanRunId, {
    status: failed > 0 ? "partial" : "success",
    counts: { scanned, signalsWritten, failed },
  });
  return { enabled: true, scanned, signalsWritten, failed };
}
