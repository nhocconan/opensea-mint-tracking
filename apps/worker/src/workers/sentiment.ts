/**
 * Sentiment/risk signal scan (ADR 0007, revised 2026-08-28). Asks xAI's
 * Grok — with its server-side `x_search` tool — to read public X chatter
 * about the LIVE/NEXT drops and return a hype + phishing-risk read, then
 * writes advisory-only `signals` rows. It NEVER touches
 * projects.confidence / lifecycleStatus / eligibility: the only DB writer
 * used here is insertSignal, which exposes nothing that writes those
 * tables.
 *
 * HARD-GATED, off by default: does nothing unless the operator set
 * X_SIGNALS_ENABLED=true AND a usable xAI credential resolves — their X
 * Premium+/SuperGrok subscription (device-code OAuth), a stored
 * console.x.ai API key, or the XAI_API_KEY env fallback, in that order
 * (see ../credentials.ts). Grok's answer is untrusted model output derived
 * from attacker-controllable posts, so it crosses a Zod boundary and is
 * clamped before it reaches the database; an unparseable answer records a
 * low-confidence empty signal rather than throwing.
 *
 * Cost stays bounded the same way it always did: one request per project,
 * only for projects nearing mint, capped per pass.
 */

import { isAppError } from "@hoodmint/core";
import { finishScanRun, insertSignal, projectsForSentimentScan, startScanRun } from "@hoodmint/db";
import { XaiClient } from "@hoodmint/providers";
import type { WorkerContext } from "../context.ts";
import { resolveXaiToken, type XaiTokenSource } from "../credentials.ts";

export interface SentimentScanSummary {
  readonly enabled: boolean;
  readonly scanned: number;
  readonly signalsWritten: number;
  readonly failed: number;
  /** Which credential answered — never the token itself. */
  readonly tokenSource?: XaiTokenSource;
}

/** How many projects to scan per pass — one metered Grok call each. */
const MAX_PROJECTS_PER_PASS = 5;

export async function runSentimentScan(ctx: WorkerContext): Promise<SentimentScanSummary> {
  const { db, config, log } = ctx;
  if (!config.X_SIGNALS_ENABLED) {
    return { enabled: false, scanned: 0, signalsWritten: 0, failed: 0 };
  }
  const tokenDeps = {
    db,
    masterKey: config.APP_ENCRYPTION_KEY,
    envApiKey: config.XAI_API_KEY,
    log,
  };
  // Resolves — and, when inside the 1-hour refresh skew, refreshes and
  // re-seals — the credential before any metered call is made. Null means
  // signals are enabled but no xAI credential is configured at all.
  const resolved = await resolveXaiToken(tokenDeps);
  if (resolved === null) {
    return { enabled: false, scanned: 0, signalsWritten: 0, failed: 0 };
  }

  const scanRunId = await startScanRun(db, {
    providerId: null,
    kind: "sentiment",
    correlationId: crypto.randomUUID(),
  });

  const client = new XaiClient({
    model: config.XAI_MODEL,
    // Re-resolved per request so a subscription token that crosses its
    // refresh skew mid-pass is rotated rather than sent expired; falls back
    // to the token this pass started with if the lookup itself fails.
    tokenProvider: async () => {
      const current = await resolveXaiToken(tokenDeps).catch(() => null);
      return current?.token ?? resolved.token;
    },
  });

  const candidates = await projectsForSentimentScan(db, MAX_PROJECTS_PER_PASS);
  let scanned = 0;
  let signalsWritten = 0;
  let failed = 0;

  for (const project of candidates) {
    // Subject keys the signal history: slug when we have it (tighter), else
    // the project name. Both are collection identifiers, never a handle.
    const subject = project.slug ?? project.name;
    try {
      const result = await client.scanSentiment({
        name: project.name,
        slug: project.slug,
      });
      scanned += 1;

      const observedAt = new Date();
      // A model answer we could not parse is still a completed scan: record
      // it as an explicitly unverified zero rather than silently skipping,
      // so the UI can show "we looked and learned nothing".
      const parsed = result.signal;
      const confidence = parsed === null ? "unverified" : "single-source";
      const sources = parsed === null ? result.citations : parsed.sources;

      await insertSignal(db, {
        projectId: project.id,
        subject,
        source: "grok_x_search",
        kind: "hype",
        score: parsed?.hype_score ?? 0,
        confidence,
        evidence: {
          model: result.model,
          parsed: parsed !== null,
          summary: parsed?.summary ?? "",
          notablePosts: parsed?.notable_posts ?? [],
          citations: result.citations,
          sources,
        },
        observedAt,
      });
      signalsWritten += 1;

      await insertSignal(db, {
        projectId: project.id,
        subject,
        source: "grok_x_search",
        kind: "risk",
        score: parsed?.risk_score ?? 0,
        confidence,
        evidence: {
          model: result.model,
          parsed: parsed !== null,
          phishingFlags: parsed?.phishing_flags ?? [],
          summary: parsed?.summary ?? "",
          citations: result.citations,
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
  return { enabled: true, scanned, signalsWritten, failed, tokenSource: resolved.source };
}
