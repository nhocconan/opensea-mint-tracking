/**
 * Speculative calldata pre-build (ADR 0009, mint-race competitiveness,
 * item P4): today, `runMintExecutionPass` calls OpenSea's
 * `buildTransaction()` only *after* claiming a due-to-fire plan, stacking
 * that round-trip directly on the critical path between "plan claimed" and
 * "owner sees a sign prompt." This pass runs separately, ahead of that
 * claim, and caches the result on the plan row (`cacheMintPlanTx`) so the
 * claim-time build can be skipped on the common path.
 *
 * Two things this deliberately does NOT do, both intentional:
 * - It never triggers at a *predicted stage-open time* — this codebase's
 *   execution pass polls on a fixed interval with no stage-time
 *   prediction (confirmed by reading `apps/worker/src/index.ts` before
 *   writing this), so "pre-build at T-30s before stage start" (the
 *   original ADR 0009 working draft's framing) doesn't fit the real
 *   architecture. Building at ARM time — a real, known trigger this
 *   system already has — is the correct fit instead: the owner arms a
 *   plan when they intend to fire it soon, so by the time the very next
 *   `runMintExecutionPass` poll claims it, calldata is often already
 *   cached.
 * - It never blocks or delays the real, due-to-fire build in
 *   `runMintExecutionPass` — that path is unconditional and always wins,
 *   by construction (this file never touches it; `execution.ts` decides
 *   independently whether to trust a cache or rebuild).
 */

import {
  currentWriteQuotaWindow,
  recordWriteQuotaCall,
  shouldAttemptSpeculativeWrite,
  type WriteQuotaWindow,
} from "@hoodmint/core";
import {
  cacheMintPlanTx,
  type Db,
  getSetting,
  plansNeedingPreBuild,
  projects as projectsTable,
  setSetting,
  wallets as walletsTable,
} from "@hoodmint/db";
import { eq } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { buildOpenSeaMintTx } from "../mint-tx.ts";

export interface PreBuildSummary {
  readonly candidates: number;
  readonly built: number;
  readonly skippedQuota: number;
  readonly failed: number;
}

// ADR 0004's own documented instant-key write quota — see
// docs/decisions/0009-mint-race-competitive-execution-recommendations.md
// §2 (P4) for why this must be respected, not just the real per-call rate
// limit OpenSea itself enforces server-side.
const OPENSEA_WRITE_QUOTA_PER_HOUR = 30;
const WRITE_QUOTA_SETTING_KEY = "opensea_write_quota_window";
// Cached calldata older than this is treated as stale and rebuilt fresh at
// claim time instead of trusted — a drop's price/proof/stage can change,
// and this pass has no way to know that happened without asking again.
// Exported so execution.ts's claim-time consumer checks the exact same
// threshold this pass uses to decide what still counts as fresh.
export const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadQuotaWindow(db: Db): Promise<WriteQuotaWindow> {
  const stored = await getSetting<WriteQuotaWindow>(db, WRITE_QUOTA_SETTING_KEY);
  return currentWriteQuotaWindow(stored, Date.now());
}

export async function runSpeculativePreBuild(ctx: WorkerContext): Promise<PreBuildSummary> {
  const { db, log } = ctx;
  const candidates = await plansNeedingPreBuild(db, new Date(), CACHE_TTL_MS);
  if (candidates.length === 0) {
    return { candidates: 0, built: 0, skippedQuota: 0, failed: 0 };
  }

  let quotaWindow = await loadQuotaWindow(db);
  let built = 0;
  let skippedQuota = 0;
  let failed = 0;

  for (const plan of candidates) {
    // Re-check per plan, not just once up front: this loop can process
    // several candidates in one pass, and each successful build advances
    // the window — a later candidate in the same pass must see that.
    if (!shouldAttemptSpeculativeWrite(quotaWindow, OPENSEA_WRITE_QUOTA_PER_HOUR)) {
      skippedQuota += 1;
      continue;
    }
    try {
      const [project] = await db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.id, plan.projectId));
      const [wallet] = await db
        .select()
        .from(walletsTable)
        .where(eq(walletsTable.id, plan.walletId));
      if (project === undefined || wallet === undefined || project.slug === null) {
        // Same "no adapter for this project" case execution.ts already
        // handles at claim time — nothing to pre-build, not a failure.
        continue;
      }

      // Shared build helper (finding #8) — the exact sequence the claim-time
      // execution pass uses, so the calldata cached here can't drift from
      // what would be rebuilt at fire time.
      const tx = await buildOpenSeaMintTx(ctx, {
        slug: project.slug,
        chainId: project.chainId,
        minter: wallet.address,
        quantity: plan.quantity,
      });

      quotaWindow = recordWriteQuotaCall(quotaWindow);
      await setSetting(db, WRITE_QUOTA_SETTING_KEY, quotaWindow);
      await cacheMintPlanTx(db, plan.id, {
        to: tx.to,
        data: tx.data,
        valueWei: tx.valueWei,
        chainId: tx.chainId,
      });
      built += 1;
    } catch (error) {
      failed += 1;
      log.warn(
        {
          planId: plan.id,
          errorCode: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        },
        "speculative pre-build failed (non-fatal — claim-time build still runs as fallback)",
      );
    }
  }

  return { candidates: candidates.length, built, skippedQuota, failed };
}
