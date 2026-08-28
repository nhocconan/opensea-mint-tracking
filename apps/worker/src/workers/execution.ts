/**
 * Mint-watch / execution dispatch loop (ADR 0005/0008 Phase 1, ADR 0004
 * Phase 2 as of the 2026-08-22 amendment).
 *
 * Every pass: expire stale arms (UX cleanup — the real safety mechanism is
 * the atomic claim below, per ADR 0005), then atomically claim at most one
 * due-to-fire plan and run it through the execution pipeline. In shadow
 * mode (LIVE_EXECUTION_ENABLED=false, the hard default) this only ever
 * simulates and logs "would have fired" — nothing is signed or broadcast.
 * In live mode, two signer schemes can actually proceed: `browser_wallet`
 * (owner signs client-side, unchanged from Phase 1) and `custom_executor`
 * (ADR 0004's Executor-contract fallback — the session key signs and this
 * worker broadcasts, no human in the loop). `eip7702_safe_zodiac` is still
 * refused by packages/signing — not buildable on real Ledger hardware
 * today, per that amendment.
 */
import {
  CHAIN_CLOCK_OFFSET_SETTING_KEY,
  coerceDate,
  computeFirePhase,
  decidePresign,
  isAppError,
  isStalePresignError,
} from "@hoodmint/core";
import {
  armedManagedPlansForPresign,
  armedPlansWithStageStart,
  claimArmedMintPlan,
  clearPresignedTx,
  expireStaleMintPlans,
  failMintPlanExecution,
  getCredentialSecret,
  getSetting,
  getWalletSigningKeySealed,
  markMintPlanExecuted,
  mintPlans as mintPlansTable,
  projects as projectsTable,
  publishEvent,
  recordExecutionAttempt,
  releaseMintPlanToArmed,
  savePresignedTx,
  signers as signersTable,
  wallets as walletsTable,
} from "@hoodmint/db";
import { runExecutionPipeline } from "@hoodmint/execution";
import { metrics } from "@hoodmint/observability";
import {
  broadcastRawTransaction,
  buildExecuteMintCalldata,
  fetchFeeContext,
  simulateTransaction,
} from "@hoodmint/providers";
import { openSecret, type SealedSecret } from "@hoodmint/secrets";
import { signExecutorTransaction, signManagedMintTransaction } from "@hoodmint/signing";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import type { WorkerContext } from "../context.ts";
import { buildOpenSeaMintTx } from "../mint-tx.ts";
import { CACHE_TTL_MS } from "./pre-build.ts";
import { resolveBestRpcUrl, resolveBroadcastRpcUrls } from "./rpc-health.ts";

export interface MintExecutionSummary {
  readonly expired: number;
  readonly claimed: boolean;
  readonly outcome?: string;
  /** Set when claimed — lets the coarse drain loop stop once it sees a
   *  plan re-claimed within the same tick (shadow mode re-arms plans after
   *  simulating, so "claimed something" alone would loop forever). */
  readonly planId?: string;
}

export interface HotLoopSummary {
  readonly candidates: number;
  readonly fired: boolean;
}

/**
 * Cap on concurrent fire passes per hot-loop tick (multi-wallet fan-out).
 * Each pass costs a handful of RPC round-trips; 8 keeps a large wallet
 * fleet competitive without stampeding the RPC endpoint at the open
 * instant. Plans beyond the cap are claimed on the next 200ms tick.
 */
const MAX_PARALLEL_FIRES = 8;

/**
 * Precision fire hot-loop (ADR 0009 competitiveness — the piece that turns
 * the tested `computeFirePhase` core into real timing). Runs on a fast
 * interval (MINT_HOT_LOOP_INTERVAL_MS, ~200ms) alongside the coarse 30s
 * `runMintExecutionPass`. For each armed plan whose linked stage has a
 * known start, it computes the clock-corrected fire phase; the moment ANY
 * plan enters the fire window it pumps `runMintExecutionPass` (which claims
 * + simulates + fires, and — with the finding-#1 lease fix — re-arms on a
 * non-terminal outcome so this keeps competing across the burst). Plans
 * without stage timing just ride the coarse pass. This is what makes an
 * FCFS fire at the open instant instead of up to 30s late.
 *
 * Cheap when idle: one indexed query returning armed-with-stage plans, a
 * pure phase computation each, and only a claim/fire when actually due.
 */
export async function runMintHotLoop(ctx: WorkerContext): Promise<HotLoopSummary> {
  const { db, config } = ctx;
  const now = Date.now();
  const candidates = await armedPlansWithStageStart(db, new Date(now));
  if (candidates.length === 0) {
    return { candidates: 0, fired: false };
  }
  const clockOffsetMs = (await getSetting<number>(db, CHAIN_CLOCK_OFFSET_SETTING_KEY)) ?? 0;
  // ADR 0009 fast path: keep managed-wallet plans PRE-SIGNED inside the
  // lead window so the fire instant is one sendRawTransaction. Runs on
  // every tick but is a cheap no-op outside the window / when fresh.
  await runPresignPass(ctx, now, clockOffsetMs).catch((error: unknown) => {
    ctx.log.warn({ err: error }, "presign pass failed (fire path still has full fallback)");
  });
  const dueCount = candidates.filter(
    (plan) =>
      computeFirePhase({
        stageStartChainMs: plan.stageStartMs,
        clockOffsetMs,
        localNowMs: now,
        hotWindowMs: config.MINT_FIRE_HOT_WINDOW_MS,
        leadMs: config.MINT_FIRE_LEAD_MS,
        continueForMs: config.MINT_FIRE_CONTINUE_MS,
      }).phase === "fire",
  ).length;
  if (dueCount === 0) {
    return { candidates: candidates.length, fired: false };
  }
  // Multi-wallet fan-out: pump one pass per due plan, in parallel, so N
  // wallets on the same drop all fire at the open instant instead of
  // serializing at one plan per 200ms tick. Safe because each pass claims
  // its own plan atomically (claimArmedMintPlan's FOR UPDATE SKIP LOCKED);
  // a pass that finds nothing left to claim is a cheap no-op. allSettled
  // isolates per-plan failures; across a burst the lease/release loop lets
  // plans be re-claimed on each tick until terminal/expired.
  await Promise.allSettled(
    Array.from({ length: Math.min(dueCount, MAX_PARALLEL_FIRES) }, () => runMintExecutionPass(ctx)),
  );
  return { candidates: candidates.length, fired: true };
}

/**
 * Pre-sign pass (ADR 0009 fast path). For every armed plan on a managed
 * wallet whose stage start is inside MINT_PRESIGN_LEAD_MS, build the exact
 * raw tx (cached calldata + this wallet's pending nonce + current fees +
 * signature) and store it on the plan row, so `runManagedFire` can broadcast
 * it with zero build/sign work at T-0. Re-signs on nonce advance or TTL.
 *
 * Deliberately does NOT simulate: eth_estimateGas reverts before a stage
 * opens ("stage not active"), so a pre-open simulation would always fail —
 * the blob uses MINT_PRESIGN_GAS_LIMIT. The plan's per-plan ceiling is still
 * enforced here (value ≤ ceiling) and LIVE_EXECUTION_ENABLED gates signing
 * entirely (shadow mode never signs anything).
 *
 * Key handling: the sealed key is fetched per plan, decrypted into a
 * function-scoped local, handed to the signing chokepoint, and dropped.
 */
async function runPresignPass(
  ctx: WorkerContext,
  localNowMs: number,
  clockOffsetMs: number,
): Promise<void> {
  const { db, config, log } = ctx;
  if (!config.LIVE_EXECUTION_ENABLED) {
    return;
  }
  const candidates = await armedManagedPlansForPresign(db, new Date(localNowMs));
  if (candidates.length === 0) {
    return;
  }
  const rpcUrl = await resolveBestRpcUrl(db, config.ROBINHOOD_CHAIN_ID, config.RPC_URL);
  if (!rpcUrl) {
    return;
  }
  for (const plan of candidates) {
    const presignedAtMs = plan.presignedAt === null ? null : coerceDate(plan.presignedAt).getTime();
    // First decision is nonce-agnostic (no RPC yet) — only pay for a nonce
    // read once we're inside the window.
    const pre = decidePresign({
      stageStartChainMs: plan.stageStartMs,
      clockOffsetMs,
      localNowMs,
      leadMs: config.MINT_PRESIGN_LEAD_MS,
      ttlMs: config.MINT_PRESIGN_TTL_MS,
      continueForMs: config.MINT_FIRE_CONTINUE_MS,
      presignedAtMs,
      presignedNonce: plan.presignedNonce,
    });
    if (pre.action === "wait" || pre.action === "expired") {
      continue;
    }
    // Need calldata; the pre-build pass normally has it cached. If not,
    // build it now (one OpenSea round-trip, well before the open).
    const cachedFresh =
      plan.cachedTx !== null &&
      plan.cachedTxAt !== null &&
      Date.now() - coerceDate(plan.cachedTxAt).getTime() < CACHE_TTL_MS;
    let tx = cachedFresh ? plan.cachedTx : null;
    try {
      const fees = await fetchFeeContext(rpcUrl, plan.walletAddress);
      const decision = decidePresign({
        stageStartChainMs: plan.stageStartMs,
        clockOffsetMs,
        localNowMs,
        leadMs: config.MINT_PRESIGN_LEAD_MS,
        ttlMs: config.MINT_PRESIGN_TTL_MS,
        continueForMs: config.MINT_FIRE_CONTINUE_MS,
        presignedAtMs,
        presignedNonce: plan.presignedNonce,
        currentNonce: fees.nonce,
      });
      if (decision.action !== "sign") {
        continue;
      }
      if (tx === null) {
        const [project] = await db
          .select()
          .from(projectsTable)
          .where(eq(projectsTable.id, (await claimlessPlanProject(db, plan.planId)) ?? ""));
        if (project === undefined || project.slug === null) {
          continue;
        }
        const built = await buildOpenSeaMintTx(ctx, {
          slug: project.slug,
          chainId: project.chainId,
          minter: plan.walletAddress,
          quantity: plan.quantity,
        });
        tx = { to: built.to, data: built.data, valueWei: built.valueWei, chainId: built.chainId };
      }
      // Ceiling policy (ADR 0004): never pre-sign a value above the plan cap.
      if (BigInt(tx.valueWei) > BigInt(plan.perPlanCeilingWei)) {
        log.warn({ planId: plan.planId }, "presign skipped: mint value exceeds per-plan ceiling");
        continue;
      }
      const sealed = await getWalletSigningKeySealed(db, plan.walletId);
      if (sealed === undefined) {
        continue;
      }
      const privateKeyHex = openSecret(
        JSON.parse(sealed) as SealedSecret,
        config.APP_ENCRYPTION_KEY,
      );
      const signed = await signManagedMintTransaction(
        {
          chainId: tx.chainId,
          to: tx.to,
          data: tx.data,
          valueWei: tx.valueWei,
          nonce: fees.nonce,
          maxFeePerGasWei: fees.maxFeePerGasWei,
          maxPriorityFeePerGasWei: fees.maxPriorityFeePerGasWei,
          gas: BigInt(config.MINT_PRESIGN_GAS_LIMIT),
        },
        privateKeyHex,
      );
      await savePresignedTx(db, plan.planId, {
        rawTx: signed.rawTx,
        nonce: fees.nonce,
        txHash: signed.txHash,
      });
      log.info(
        { planId: plan.planId, reason: decision.reason, nonce: fees.nonce },
        "pre-signed mint tx ready (fast path armed)",
      );
    } catch (error) {
      log.warn(
        { planId: plan.planId, err: error },
        "presign failed (fire path will build+sign at T-0 as fallback)",
      );
    }
  }
}

/** projectId for a plan without claiming it (presign is read-only on status). */
async function claimlessPlanProject(db: WorkerContext["db"], planId: string) {
  const [row] = await db
    .select({ projectId: mintPlansTable.projectId })
    .from(mintPlansTable)
    .where(eq(mintPlansTable.id, planId))
    .limit(1);
  return row?.projectId;
}

export async function runMintExecutionPass(ctx: WorkerContext): Promise<MintExecutionSummary> {
  const { db, config, log } = ctx;
  const now = new Date();
  const expired = await expireStaleMintPlans(db, now);

  const plan = await claimArmedMintPlan(db, now);
  if (plan === undefined) {
    return { expired, claimed: false };
  }

  const record = (
    status: "failed" | "simulated_ok" | "simulated_revert" | "broadcast" | "awaiting_signature",
    extra: {
      errorCode?: string;
      simulationResult?: Record<string, unknown>;
      pendingTx?: { to: string; data: string; valueWei: string; chainId: number };
      txHash?: string;
    } = {},
  ) =>
    recordExecutionAttempt(db, {
      planId: plan.id,
      status,
      ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
      ...(extra.simulationResult !== undefined ? { simulationResult: extra.simulationResult } : {}),
      ...(extra.pendingTx !== undefined ? { pendingTx: extra.pendingTx } : {}),
      ...(extra.txHash !== undefined ? { txHash: extra.txHash } : {}),
    });

  try {
    // ADR 0009, item P2: best-ranked registry endpoint over the legacy
    // single RPC_URL, same fallback-when-empty behavior as chain.ts.
    const rpcUrl = await resolveBestRpcUrl(db, config.ROBINHOOD_CHAIN_ID, config.RPC_URL);
    if (!rpcUrl) {
      await record("failed", { errorCode: "no_rpc_configured" });
      return { expired, claimed: true, outcome: "no_rpc_configured", planId: plan.id };
    }

    const [project] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, plan.projectId));
    const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, plan.walletId));
    if (project === undefined || wallet === undefined) {
      await record("failed", { errorCode: "missing_project_or_wallet" });
      return { expired, claimed: true, outcome: "missing_project_or_wallet", planId: plan.id };
    }
    if (project.slug === null) {
      // Phase 1 only ships the OpenSea adapter (ADR 0004 amendment); a
      // project with no OpenSea slug has no MintAdapter yet.
      await record("failed", { errorCode: "no_mint_adapter_for_project" });
      return { expired, claimed: true, outcome: "no_mint_adapter_for_project", planId: plan.id };
    }

    let signerId = "unregistered";
    let signerScheme:
      | "browser_wallet"
      | "eip7702_safe_zodiac"
      | "custom_executor"
      | "managed_wallet_key" = "browser_wallet";
    // No coarse on-chain ceiling exists for browser_wallet (no delegation to
    // cap in Phase 1) — default it to the plan's own ceiling so the
    // coarse-vs-precise check (ADR 0004) is a no-op until a real delegated
    // signer with a real onchainSpendCeilingWei exists.
    let signerCeilingWei = BigInt(plan.perPlanCeilingWei);
    let delegatedSignerRow: typeof signersTable.$inferSelect | undefined;
    if (plan.signerId !== null) {
      const [row] = await db.select().from(signersTable).where(eq(signersTable.id, plan.signerId));
      // A 'pending' (mid-onboarding) or 'revoked' delegated signer must
      // never be trusted as capable — treat the plan as if it had no
      // delegated signer at all (falls through to the browser_wallet
      // default above) rather than silently blocking it or, worse,
      // silently trusting an incomplete/revoked delegation.
      if (row !== undefined && row.status === "active") {
        signerId = row.id;
        signerScheme = row.scheme;
        if (row.onchainSpendCeilingWei !== null) {
          signerCeilingWei = BigInt(row.onchainSpendCeilingWei);
        }
        if (row.scheme === "custom_executor") {
          delegatedSignerRow = row;
        }
      }
    }

    // Managed-key custody (owner-authorized, 2026-08-28): when a plan carries
    // no active delegated (custom_executor) signer but its burner wallet has
    // an imported sealed signing key, the wallet's own EOA signs a direct
    // mint tx autonomously. An explicit active custom_executor signer above
    // still takes precedence. Still hard-gated downstream by
    // LIVE_EXECUTION_ENABLED (shadow mode simulates only).
    if (signerScheme === "browser_wallet" && wallet.encryptedSigningKey !== null) {
      signerScheme = "managed_wallet_key";
      signerId = `managed:${wallet.id}`;
    }

    // ADR 0009, item P4: prefer a fresh speculative pre-build over a fresh
    // OpenSea round-trip here — this is the actual latency win P4 buys.
    // cachedTxAt comes through claimArmedMintPlan's raw-SQL RETURNING, so
    // (like armedUntil above) it's a string at runtime despite the Date
    // type — coerceDate before any date math, same lesson as line ~121.
    const cachedAt = plan.cachedTxAt === null ? null : coerceDate(plan.cachedTxAt);
    const cacheIsFresh = cachedAt !== null && Date.now() - cachedAt.getTime() < CACHE_TTL_MS;
    const tx =
      cacheIsFresh && plan.cachedTx !== null
        ? {
            to: plan.cachedTx.to,
            data: plan.cachedTx.data,
            valueWei: plan.cachedTx.valueWei,
            chainId: plan.cachedTx.chainId,
            expectedFrom: wallet.address,
          }
        : await (async () => {
            // Shared build helper (finding #8) — identical to what the
            // pre-build pass caches, so cache-hit and cache-miss can't drift.
            const built = await buildOpenSeaMintTx(ctx, {
              slug: project.slug as string,
              chainId: project.chainId,
              minter: wallet.address,
              quantity: plan.quantity,
            });
            return { ...built, expectedFrom: wallet.address };
          })();

    const outcome = await runExecutionPipeline(
      {
        planId: plan.id,
        // The atomic claim above already proved status='armed' AND
        // armed_until > now() at the DB level (ADR 0005) — that IS the
        // status+window half of canFireMintPlan. We re-assert "armed"
        // here deliberately so the pipeline's own policy check still
        // covers the ceiling half (which the claim query doesn't check)
        // rather than skipping canFireMintPlan post-claim.
        planStatus: "armed",
        // claimArmedMintPlan's raw db.execute() result types this as Date,
        // but every timestamptz column in this codebase actually comes
        // back as a string at runtime (found live, 2026-08-22) —
        // coerceDate is what makes canFireMintPlan's armedUntil.getTime()
        // not throw.
        armedUntil: plan.armedUntil === null ? null : coerceDate(plan.armedUntil),
        signerCeilingWei,
        perPlanCeilingWei: BigInt(plan.perPlanCeilingWei),
        spentWei: 0n,
        signer: { id: signerId, scheme: signerScheme },
        recipientAddress: wallet.address,
        tx,
      },
      {
        rpcUrl,
        liveExecutionEnabled: config.LIVE_EXECUTION_ENABLED,
        simulate: simulateTransaction,
        now: () => new Date(),
      },
    );

    metrics().inc("hoodmint_execution_pipeline_total", { stage: outcome.stage });
    log.info({ planId: plan.id, stage: outcome.stage }, "mint execution pipeline outcome");

    if (outcome.stage === "blocked_simulation") {
      await record("simulated_revert", {
        errorCode: outcome.revertReason,
        simulationResult: { revertReason: outcome.revertReason },
      });
      // Retryable: the commonest reason is "stage not open yet" fired a hair
      // early. Release to armed so the next tick / precision hot-loop keeps
      // competing across the burst window; the expire sweep ends it if the
      // window closes first (finding #1 fix — never strand in 'executing').
      await releaseMintPlanToArmed(db, plan.id, new Date());
    } else if (outcome.stage === "shadow_would_fire") {
      await record("simulated_ok", {
        simulationResult: { gasEstimate: outcome.gasEstimate.toString(), shadow: true },
      });
      // Shadow mode must NEVER consume the arm — release so dry-runs keep
      // happening each tick until the window naturally expires.
      await releaseMintPlanToArmed(db, plan.id, new Date());
    } else if (
      outcome.stage === "blocked_policy" ||
      outcome.stage === "blocked_scheme_not_implemented"
    ) {
      const reason = outcome.stage === "blocked_policy" ? outcome.reason : outcome.error;
      await record("failed", { errorCode: reason.slice(0, 200) });
      // Permanent (ceiling exceeded / unimplemented scheme) — do not retry.
      await failMintPlanExecution(db, plan.id);
    } else if (outcome.stage === "ready_for_browser_signature") {
      // Still nothing signed or broadcast — this only writes down the
      // unsigned transaction so Admin → Execution can show the owner a
      // "sign with your wallet" prompt (ADR 0008 Phase 1). Deliberately
      // left in 'executing' (not released): the human is now the next
      // actor, recordBrowserSignatureAction marks it executed, and the
      // expire sweep reclaims it if they never sign — so the owner isn't
      // spammed a fresh prompt every tick.
      await record("awaiting_signature", {
        pendingTx: {
          to: outcome.signRequest.to,
          data: outcome.signRequest.data,
          valueWei: outcome.signRequest.valueWei,
          chainId: outcome.signRequest.chainId,
        },
      });
      // ADR 0009, item P3: push this the instant it happens rather than
      // waiting for the owner's next manual reload — AppShell's
      // useRadarEvents already subscribes every page, admin included.
      await publishEvent(db, {
        type: "execution.awaiting_signature",
        projectId: plan.projectId,
        at: new Date().toISOString(),
      });
    } else if (outcome.stage === "ready_for_delegated_signature") {
      if (signerScheme === "managed_wallet_key") {
        await runManagedFire(ctx, plan, outcome, wallet, rpcUrl, record);
      } else {
        await runDelegatedFire(ctx, plan, outcome, delegatedSignerRow, rpcUrl, record);
      }
    }

    return { expired, claimed: true, outcome: outcome.stage, planId: plan.id };
  } catch (error) {
    log.error({ err: error, planId: plan.id }, "mint execution pass failed");
    await record("failed", {
      errorCode: error instanceof Error ? error.message.slice(0, 200) : "unknown_error",
    });
    // A thrown error mid-pass (RPC blip, transient read failure) is usually
    // retryable — release to armed rather than stranding the plan in
    // 'executing' (finding #1). If it's genuinely broken it'll fail again
    // and the window will expire it.
    await releaseMintPlanToArmed(db, plan.id, new Date()).catch(() => {});
    return { expired, claimed: true, outcome: "error", planId: plan.id };
  }
}

/**
 * ADR 0004 Phase 2 delegated fire (no human in the loop). Extracted so the
 * main pass reads cleanly. Simulates the EXACT `executeMint` transaction it
 * will broadcast — same `from` (operator EOA), same `to` (Executor), same
 * calldata — before signing, which is the finding-#7 fix: the pipeline's
 * upstream simulation ran the inner mint call from the wallet, a different
 * msg.sender and gas profile than the real wrapped call, so it could pass
 * while the live tx reverts. A revert here is treated as retryable (release
 * to armed) so a fired-too-early attempt keeps competing across the burst.
 */
async function runDelegatedFire(
  ctx: WorkerContext,
  plan: { id: string; projectId: string },
  outcome: { tx: { chainId: number; to: string; data: string; valueWei: string } },
  delegatedSignerRow:
    | { id: string; delegateContractAddress: string | null; sessionKeyCredentialId: string | null }
    | undefined,
  rpcUrl: string,
  record: (
    status: "failed" | "simulated_ok" | "simulated_revert" | "broadcast" | "awaiting_signature",
    extra?: {
      errorCode?: string;
      simulationResult?: Record<string, unknown>;
      pendingTx?: { to: string; data: string; valueWei: string; chainId: number };
      txHash?: string;
    },
  ) => Promise<unknown>,
): Promise<void> {
  const { db, config, log } = ctx;
  if (
    delegatedSignerRow === undefined ||
    delegatedSignerRow.delegateContractAddress === null ||
    delegatedSignerRow.sessionKeyCredentialId === null
  ) {
    await record("failed", { errorCode: "delegated_signer_misconfigured" });
    await failMintPlanExecution(db, plan.id);
    return;
  }
  const executorAddress = delegatedSignerRow.delegateContractAddress;
  try {
    const sessionKeyHex = await getCredentialSecret(
      db,
      delegatedSignerRow.sessionKeyCredentialId,
      config.APP_ENCRYPTION_KEY,
    );
    if (sessionKeyHex === undefined) {
      await record("failed", { errorCode: "session_key_credential_missing" });
      await failMintPlanExecution(db, plan.id);
      return;
    }
    const operatorAccount = privateKeyToAccount(sessionKeyHex as `0x${string}`);

    // Simulate the REAL executeMint tx (from operator, to Executor) — same
    // bytes we'll broadcast (buildExecuteMintCalldata is deterministic and
    // matches signExecutorTransaction's own encoding). This is the
    // authoritative gate for the delegated path; the outer tx forwards 0
    // value (the Executor forwards the mint price from its own balance).
    const executeCalldata = buildExecuteMintCalldata(
      outcome.tx.to,
      outcome.tx.data,
      outcome.tx.valueWei,
    );
    const sim = await simulateTransaction({
      rpcUrl,
      from: operatorAccount.address,
      to: executorAddress,
      data: executeCalldata,
      valueWei: "0",
    });
    if (!sim.ok) {
      await record("simulated_revert", {
        errorCode: sim.revertReason,
        simulationResult: { revertReason: sim.revertReason, delegated: true },
      });
      // Retryable (e.g. stage-not-open, cap window) — keep competing.
      await releaseMintPlanToArmed(db, plan.id, new Date());
      return;
    }

    // Fresh nonce/fee for the operator right before signing (never reused —
    // a stale fee could under-price a time-sensitive tx, ADR 0009).
    const operatorFees = await fetchFeeContext(rpcUrl, operatorAccount.address);
    const signed = await signExecutorTransaction(
      {
        chainId: outcome.tx.chainId,
        executorAddress,
        target: outcome.tx.to,
        data: outcome.tx.data,
        valueWei: outcome.tx.valueWei,
        nonce: operatorFees.nonce,
        maxFeePerGasWei: operatorFees.maxFeePerGasWei,
        maxPriorityFeePerGasWei: operatorFees.maxPriorityFeePerGasWei,
        // Real gas estimate from simulating the actual wrapped call above,
        // +20% headroom — no longer a guess over the inner-call estimate.
        gas: (sim.gasEstimate * 120n) / 100n,
      },
      sessionKeyHex,
    );
    const broadcast = await broadcastRawTransaction(rpcUrl, signed.rawTx);
    await record("broadcast", { txHash: broadcast.txHash });
    // Terminal: our shot is in. On a FIFO sequencer the first accepted
    // valid tx is the one that counts; re-broadcasting after acceptance
    // risks a wasteful double-mint attempt.
    await markMintPlanExecuted(db, plan.id);
    log.info(
      { planId: plan.id, txHash: broadcast.txHash },
      "delegated (custom_executor) mint transaction broadcast",
    );
    await publishEvent(db, {
      type: "execution.broadcast",
      projectId: plan.projectId,
      at: new Date().toISOString(),
    });
  } catch (error) {
    const errorCode = isAppError(error)
      ? error.category
      : error instanceof Error
        ? error.message.slice(0, 200)
        : "unknown_delegated_signing_error";
    log.error({ err: error, planId: plan.id }, "delegated signing/broadcast failed");
    await record("failed", { errorCode });
    // Nonce race / transient RPC error is retryable within the window.
    await releaseMintPlanToArmed(db, plan.id, new Date());
  }
}

/**
 * Managed-key fire (owner-authorized custody, 2026-08-28). Unlike the
 * delegated path there is no Executor contract: the burner wallet's own EOA
 * key signs a DIRECT mint transaction (mint-to-self, standard FCFS). The
 * pipeline already simulated this exact tx from the wallet, but we
 * re-simulate right before signing (stage-not-open is the common early
 * revert) and re-fetch a fresh nonce/fee. The sealed key is decrypted into a
 * function-scoped local, handed straight to the signing chokepoint, and
 * never assigned to anything logged.
 */
async function runManagedFire(
  ctx: WorkerContext,
  plan: { id: string; projectId: string },
  outcome: { tx: { chainId: number; to: string; data: string; valueWei: string } },
  wallet: { id: string; address: string; encryptedSigningKey: string | null },
  rpcUrl: string,
  record: (
    status: "failed" | "simulated_ok" | "simulated_revert" | "broadcast" | "awaiting_signature",
    extra?: {
      errorCode?: string;
      simulationResult?: Record<string, unknown>;
      pendingTx?: { to: string; data: string; valueWei: string; chainId: number };
      txHash?: string;
    },
  ) => Promise<unknown>,
): Promise<void> {
  const { db, log } = ctx;
  if (wallet.encryptedSigningKey === null) {
    await record("failed", { errorCode: "managed_key_missing" });
    await failMintPlanExecution(db, plan.id);
    return;
  }
  // ── FAST PATH (ADR 0009): a pre-signed blob exists → ONE network call. ──
  // No build, no simulate, no nonce/fee fetch, no signing at T-0. If the RPC
  // rejects it as stale (nonce moved), fall through to the full path below
  // in this same pass so the burst isn't lost.
  const [fresh] = await db
    .select({
      presignedRawTx: mintPlansTable.presignedRawTx,
      presignedTxHash: mintPlansTable.presignedTxHash,
    })
    .from(mintPlansTable)
    .where(eq(mintPlansTable.id, plan.id))
    .limit(1);
  if (fresh?.presignedRawTx) {
    try {
      // Race-broadcast: fire the identical raw tx at every healthy RPC at
      // once; first acceptance wins, the rest are harmless duplicates.
      const urls = await resolveBroadcastRpcUrls(db, ctx.config.ROBINHOOD_CHAIN_ID, rpcUrl);
      const rawTx = fresh.presignedRawTx;
      const broadcast = await Promise.any(
        (urls.length > 0 ? urls : [rpcUrl]).map((url) => broadcastRawTransaction(url, rawTx)),
      ).catch((aggregate: unknown) => {
        // Promise.any rejects with an AggregateError; surface the first
        // real reason so stale-nonce detection below still works.
        const first = aggregate instanceof AggregateError ? aggregate.errors[0] : aggregate;
        throw first instanceof Error ? first : new Error(String(first));
      });
      await record("broadcast", { txHash: broadcast.txHash });
      await clearPresignedTx(db, plan.id);
      await markMintPlanExecuted(db, plan.id);
      log.info(
        { planId: plan.id, walletId: wallet.id, txHash: broadcast.txHash, fastPath: true },
        "managed-key mint broadcast (pre-signed fast path)",
      );
      await publishEvent(db, {
        type: "execution.broadcast",
        projectId: plan.projectId,
        at: new Date().toISOString(),
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await clearPresignedTx(db, plan.id);
      if (!isStalePresignError(message)) {
        // Real failure (e.g. insufficient funds, reverted): record + retry
        // within the window via the normal release path.
        await record("failed", { errorCode: message.slice(0, 200) });
        await releaseMintPlanToArmed(db, plan.id, new Date());
        return;
      }
      log.warn(
        { planId: plan.id },
        "pre-signed tx stale (nonce moved) — falling back to live sign",
      );
      // fall through to full path
    }
  }
  try {
    // Simulate the REAL direct mint tx from the burner wallet — same bytes,
    // same sender we broadcast. Authoritative gate for this path.
    const sim = await simulateTransaction({
      rpcUrl,
      from: wallet.address,
      to: outcome.tx.to,
      data: outcome.tx.data,
      valueWei: outcome.tx.valueWei,
    });
    if (!sim.ok) {
      await record("simulated_revert", {
        errorCode: sim.revertReason,
        simulationResult: { revertReason: sim.revertReason, managed: true },
      });
      await releaseMintPlanToArmed(db, plan.id, new Date());
      return;
    }

    // Fresh nonce/fee for THIS wallet right before signing (per-wallet nonce).
    const fees = await fetchFeeContext(rpcUrl, wallet.address);

    // Decrypt the sealed key into a function-scoped local, hand it straight to
    // the chokepoint, and never log it. `openSecret` throws on tamper/wrong key.
    const sealed = JSON.parse(wallet.encryptedSigningKey) as SealedSecret;
    const privateKeyHex = openSecret(sealed, ctx.config.APP_ENCRYPTION_KEY);
    const signed = await signManagedMintTransaction(
      {
        chainId: outcome.tx.chainId,
        to: outcome.tx.to,
        data: outcome.tx.data,
        valueWei: outcome.tx.valueWei,
        nonce: fees.nonce,
        maxFeePerGasWei: fees.maxFeePerGasWei,
        maxPriorityFeePerGasWei: fees.maxPriorityFeePerGasWei,
        gas: (sim.gasEstimate * 120n) / 100n,
      },
      privateKeyHex,
    );

    const broadcast = await broadcastRawTransaction(rpcUrl, signed.rawTx);
    await record("broadcast", { txHash: broadcast.txHash });
    await markMintPlanExecuted(db, plan.id);
    log.info(
      { planId: plan.id, walletId: wallet.id, txHash: broadcast.txHash },
      "managed-key mint transaction broadcast",
    );
    await publishEvent(db, {
      type: "execution.broadcast",
      projectId: plan.projectId,
      at: new Date().toISOString(),
    });
  } catch (error) {
    const errorCode = isAppError(error)
      ? error.category
      : error instanceof Error
        ? error.message.slice(0, 200)
        : "unknown_managed_signing_error";
    log.error({ err: error, planId: plan.id }, "managed-key signing/broadcast failed");
    await record("failed", { errorCode });
    await releaseMintPlanToArmed(db, plan.id, new Date());
  }
}
