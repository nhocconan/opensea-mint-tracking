/**
 * Auto-mint planner (owner ask 2026-08-28): turn a funded burner wallet into
 * an autonomous free-mint sniper. Every pass: load the policy, find stages
 * that match it (free / public / within lookahead / not scam-flagged /
 * quality-gated), and for each policy wallet create + ARM a mint plan. The
 * existing machinery does the rest — pre-sign inside the lead window, race-
 * broadcast at the open instant (managed_wallet_key fast path).
 *
 * Safety: only MANAGED wallets the operator listed; per-plan ceiling from the
 * policy; daily executed cap per wallet; max 2 attempts per (wallet, stage);
 * LIVE_EXECUTION_ENABLED still gates any signing/broadcast; every decision is
 * audited. The planner never signs or broadcasts itself.
 */
import {
  AUTO_MINT_POLICY_SETTING_KEY,
  type AutoMintPolicy,
  decideAutoMint,
  parseAutoMintPolicy,
} from "@hoodmint/core";
import {
  armMintPlan,
  attemptsForStage,
  autoMintCandidateStages,
  blockingPlanExists,
  createMintPlan,
  executedLast24h,
  getSetting,
  managedWalletsAmong,
  recordAudit,
} from "@hoodmint/db";
import type { WorkerContext } from "../context.ts";

const MAX_ATTEMPTS_PER_STAGE = 2;

export interface AutoMintSummary {
  readonly enabled: boolean;
  readonly candidates: number;
  readonly planned: number;
  readonly skipped: number;
}

export async function loadAutoMintPolicy(db: WorkerContext["db"]): Promise<AutoMintPolicy | null> {
  const raw = await getSetting<unknown>(db, AUTO_MINT_POLICY_SETTING_KEY);
  return raw === undefined ? null : parseAutoMintPolicy(raw);
}

export async function runAutoMintPlanner(ctx: WorkerContext): Promise<AutoMintSummary> {
  const { db, log } = ctx;
  const policy = await loadAutoMintPolicy(db);
  if (policy === null || !policy.enabled || policy.ownerUserId === null) {
    return { enabled: false, candidates: 0, planned: 0, skipped: 0 };
  }
  const wallets = await managedWalletsAmong(db, policy.walletIds);
  if (wallets.length === 0) {
    return { enabled: true, candidates: 0, planned: 0, skipped: 0 };
  }
  const nowMs = Date.now();
  const stages = await autoMintCandidateStages(db, policy.lookaheadHours);
  let planned = 0;
  let skipped = 0;

  for (const wallet of wallets) {
    const executedToday = await executedLast24h(db, wallet.id);
    let budget = policy.maxPerWalletPerDay - executedToday;
    for (const s of stages) {
      if (budget <= 0) {
        break;
      }
      const decision = decideAutoMint(
        policy,
        {
          projectId: s.projectId,
          projectName: s.projectName,
          stageId: s.stageId,
          stageKind: s.stageKind,
          priceWei: s.priceWei,
          startsAtMs: s.startsAt.getTime(),
          endsAtMs: s.endsAt?.getTime() ?? null,
          paused: s.paused,
          riskScore: s.riskScore,
          hypeScore: s.hypeScore,
          curated: s.curated,
          uniqueMinters1h: s.uniqueMinters1h,
        },
        nowMs,
      );
      if (!decision.plan) {
        skipped += 1;
        continue;
      }
      if (await blockingPlanExists(db, wallet.id, s.stageId)) {
        continue;
      }
      if ((await attemptsForStage(db, wallet.id, s.stageId)) >= MAX_ATTEMPTS_PER_STAGE) {
        skipped += 1;
        continue;
      }
      const plan = await createMintPlan(db, {
        projectId: s.projectId,
        walletId: wallet.id,
        stageId: s.stageId,
        quantity: policy.quantity,
        perPlanCeilingWei: decision.ceilingWei,
      });
      const armed = await armMintPlan(db, plan.id, policy.ownerUserId, decision.armMinutes);
      await recordAudit(db, {
        actorUserId: policy.ownerUserId,
        action: "automint.plan_armed",
        targetType: "mint_plan",
        targetId: plan.id,
        result: armed !== undefined ? "success" : "failure",
        metadata: {
          projectId: s.projectId,
          projectName: s.projectName,
          stageId: s.stageId,
          walletId: wallet.id,
          priceWei: s.priceWei ?? "0",
          riskScore: s.riskScore,
          hypeScore: s.hypeScore,
          curated: s.curated,
          armMinutes: decision.armMinutes,
        },
      });
      planned += 1;
      budget -= 1;
      log.info(
        { planId: plan.id, project: s.projectName, walletId: wallet.id, arm: decision.armMinutes },
        "auto-mint: plan created + armed",
      );
    }
  }
  return { enabled: true, candidates: stages.length, planned, skipped };
}
