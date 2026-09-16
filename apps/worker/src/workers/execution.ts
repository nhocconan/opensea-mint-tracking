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
  assessMintFunding,
  CHAIN_CLOCK_OFFSET_SETTING_KEY,
  chainTimeToLocalMs,
  coerceDate,
  computeFirePhase,
  decidePresign,
  isAppError,
  isInsufficientFundsError,
  isNativeCurrency,
  isStalePresignError,
} from "@hoodmint/core";
import {
  armedManagedPlansForPresign,
  armedPlansWithStageStart,
  claimArmedMintPlan,
  clearPresignedTx,
  countRevertedAttempts,
  dropStages as dropStagesTable,
  expireStaleMintPlans,
  failMintPlanExecution,
  getCredentialSecret,
  getSetting,
  getWalletSigningKeySealed,
  latestBroadcastAttempt,
  markMintPlanExecuted,
  mintPlans as mintPlansTable,
  projects as projectsTable,
  publishEvent,
  recordExecutionAttempt,
  recordWalletBalance,
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
  fetchErc20Funding,
  fetchFeeContext,
  fetchNativeBalance,
  simulateTransaction,
} from "@hoodmint/providers";
import { openWalletKey } from "@hoodmint/secrets";
import { signExecutorTransaction, signManagedMintTransaction } from "@hoodmint/signing";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import type { WorkerContext } from "../context.ts";
import { pickBroadcastError, resolveTxOutcome, waitForMintReceipt } from "../mint-receipt.ts";
import { mintRpcUrls, redactRpc, warmRpcConnections, withRpcFailover } from "../mint-rpc.ts";
import {
  buildOpenSeaMintTx,
  burstBuildOpenSeaMintTx,
  isPerWalletLimitError,
  isTerminalMintBuildError,
  mintedOutIsTerminal,
} from "../mint-tx.ts";
import { releaseNonce, reserveNonce } from "../nonce-allocator.ts";
import { buildSelfServedPublicMint, type SelfServedTx } from "../seadrop-public-mint.ts";
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
 * Passes started by the hot loop and not yet settled. The fan-out is
 * detached (see runMintHotLoop), so concurrency has to be bounded across
 * ticks rather than by awaiting within one — otherwise a 200ms cadence over
 * a 12s signature burst would pile up passes without limit.
 */
let inFlightPasses = 0;

/**
 * How long an unresolved prior broadcast blocks a re-fire. Long enough for a
 * transaction to appear on a ~100ms-block chain (so we do not double-mint),
 * short enough that a genuinely dropped transaction still leaves time to
 * compete inside the arm window.
 */
const PRIOR_BROADCAST_GRACE_MS = 3_000;

/**
 * How many on-chain reverts a plan may burn before it is given up on.
 *
 * Each revert is a real transaction and real gas. While supply lasts a revert
 * usually means "fired a hair early", and competing again is correct. Once a
 * drop is minted out — or this wallet's allowance is spent — every further
 * attempt reverts identically and simply costs money. Three is enough to ride
 * out an early fire and few enough that a dead drop cannot drain the wallet.
 */
const MAX_ONCHAIN_REVERTS = 3;

/**
 * How long a claimed self-served plan may sit waiting for the contract's own
 * open. Bounded well under the 30s claim lease: past this the plan is handed
 * back and the 200ms hot loop brings it round again.
 */
const SELF_SERVED_MAX_HOLD_MS = 15_000;

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
/** ± window around the fire target inside which a pass is "the race". */
const FIRE_BURST_WINDOW_MS = 20_000;

/**
 * Presign funding gate back-off: an underfunded plan is re-checked (two RPC
 * reads + one attempt row) at most this often, not every 200 ms tick, since
 * nothing gets pre-signed for it and `decidePresign` would otherwise say
 * "sign" on every tick of the lead window.
 */
const UNDERFUNDED_RECHECK_MS = 15_000;
const underfundedRecheckAt = new Map<string, number>();

/**
 * True when now is within ±window of the plan's fire target —
 * coalesce(fire_at, stage start). A plan with neither is never "near".
 */
/** The instant this plan is aiming at: operator override, else stage start. */
async function fireTargetMs(
  db: WorkerContext["db"],
  plan: { fireAt: Date | string | null; stageId: string | null },
): Promise<number | null> {
  if (plan.fireAt !== null) {
    return coerceDate(plan.fireAt).getTime();
  }
  if (plan.stageId === null) {
    return null;
  }
  const [stage] = await db
    .select({ startsAt: dropStagesTable.startsAt })
    .from(dropStagesTable)
    .where(eq(dropStagesTable.id, plan.stageId))
    .limit(1);
  return stage === undefined ? null : coerceDate(stage.startsAt).getTime();
}

async function isNearFireInstant(
  db: WorkerContext["db"],
  plan: { fireAt: Date | string | null; stageId: string | null },
  windowMs: number,
): Promise<boolean> {
  const targetMs = await fireTargetMs(db, plan);
  return targetMs !== null && Math.abs(Date.now() - targetMs) <= windowMs;
}

/** OpenSea's `/drops/{slug}/mint` 422 body when supply is exhausted. */
export function isMintedOutError(message: string): boolean {
  return /fully minted out|minted out|sold out/i.test(message);
}

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
  // DETACHED. This was awaited, and it issues a fee+nonce RPC round-trip per
  // managed candidate per tick — 40-300ms of dead time in front of the fire
  // decision, on every one of the five ticks per second through the whole
  // 45s pre-sign window. The fire path has a complete build+sign fallback, so
  // nothing about correctness depends on this finishing before the decision.
  if (config.MINT_PRESIGN_ENABLED) {
    void runPresignPass(ctx, now, clockOffsetMs).catch((error: unknown) => {
      ctx.log.warn({ err: error }, "presign pass failed (fire path still has full fallback)");
    });
  }
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
  // Multi-drop / multi-wallet fan-out: pump one pass per due plan so N
  // wallets across N DIFFERENT collections all fire at their own open
  // instant. Safe because each pass claims its own plan atomically
  // (claimArmedMintPlan's FOR UPDATE SKIP LOCKED); a pass that finds nothing
  // left to claim is a cheap no-op.
  //
  // DETACHED on purpose. This used to `await Promise.allSettled(...)`, and
  // the scheduler only re-arms the 200ms tick once the previous tick
  // settles — so one plan sitting in burstBuildOpenSeaMintTx (up to
  // MINT_SIGNATURE_BURST_MS, 12s) blinded the loop for 3× the whole
  // continue window. Racing three collections at once, that means the two
  // that are not blocking silently miss their windows: by the time the
  // burst returns, computeFirePhase reads `expired` for all of them.
  // Detaching keeps the cadence alive; MAX_PARALLEL_FIRES still bounds
  // total concurrency, counted across ticks rather than within one.
  const slots = Math.min(dueCount, MAX_PARALLEL_FIRES - inFlightPasses);
  for (let i = 0; i < slots; i += 1) {
    inFlightPasses += 1;
    void runMintExecutionPass(ctx)
      .catch((error: unknown) => {
        ctx.log.error({ err: error }, "mint execution pass failed");
      })
      .finally(() => {
        inFlightPasses -= 1;
      });
  }
  return { candidates: candidates.length, fired: slots > 0 };
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
    if ((underfundedRecheckAt.get(plan.planId) ?? 0) > localNowMs) {
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
      // Funding gate (2026-09-02): can this wallet actually pay value + gas
      // (and the ERC-20 price on a token-priced stage)? Learned the hard way
      // on 2026-08-30 — OpenSea's "Insufficient balance to mint" only ever
      // surfaced at T-0 and the plan sat retrying until it EXPIRED. Here it
      // becomes a visible attempt row ~45s early while the plan stays armed,
      // so a top-up before the open still fires.
      const funding = await assessPresignFunding(
        rpcUrl,
        plan,
        tx,
        fees.maxFeePerGasWei,
        config,
        db,
      );
      if (!funding.ok) {
        underfundedRecheckAt.set(plan.planId, localNowMs + UNDERFUNDED_RECHECK_MS);
        log.warn(
          { planId: plan.planId, reason: funding.reason },
          "presign skipped: wallet underfunded",
        );
        await recordExecutionAttempt(db, {
          planId: plan.planId,
          status: "failed",
          errorCode: funding.message.slice(0, 200),
        });
        continue;
      }
      underfundedRecheckAt.delete(plan.planId);
      const sealed = await getWalletSigningKeySealed(db, plan.walletId);
      if (sealed === undefined) {
        continue;
      }
      const privateKeyHex = openWalletKey(sealed, {
        masterKeyB64: config.APP_ENCRYPTION_KEY,
        walletPrivateKeyB64: config.WALLET_KEY_PRIVATE_KEY,
      });
      // Two plans on ONE wallet (an FCFS plan and a public plan) are pre-signed
      // in the same loop while neither has broadcast, so an unreserved
      // `fees.nonce` hands both the same pending nonce: both blobs are signed
      // at N, one is accepted at the open and the other is rejected as a
      // duplicate. Reserve so siblings get N, N+1, …
      const presignNonce = reserveNonce(plan.walletAddress, fees.nonce);
      const signed = await signManagedMintTransaction(
        {
          chainId: tx.chainId,
          to: tx.to,
          data: tx.data,
          valueWei: tx.valueWei,
          nonce: presignNonce,
          maxFeePerGasWei: fees.maxFeePerGasWei,
          maxPriorityFeePerGasWei: fees.maxPriorityFeePerGasWei,
          gas: BigInt(config.MINT_PRESIGN_GAS_LIMIT),
        },
        privateKeyHex,
      );
      await savePresignedTx(db, plan.planId, {
        rawTx: signed.rawTx,
        nonce: presignNonce,
        txHash: signed.txHash,
      });
      log.info(
        { planId: plan.planId, reason: decision.reason, nonce: presignNonce },
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

/**
 * Fresh funding read for one presign candidate: native balance (persisted
 * as the wallet's snapshot too) and, when the stage is priced in an ERC-20,
 * the token balance + allowance towards the SeaDrop contract (`tx.to`).
 */
async function assessPresignFunding(
  rpcUrl: string,
  plan: {
    walletId: string;
    walletAddress: string;
    quantity: number;
    stagePriceWei: string | null;
    stageCurrency: string | null;
  },
  tx: { to: string; valueWei: string },
  maxFeePerGasWei: string,
  config: WorkerContext["config"],
  db?: WorkerContext["db"],
): Promise<ReturnType<typeof assessMintFunding>> {
  const nativeBalanceWei = await fetchNativeBalance(rpcUrl, plan.walletAddress);
  if (db !== undefined) {
    await recordWalletBalance(db, plan.walletId, nativeBalanceWei).catch(() => undefined);
  }
  const erc20 =
    !isNativeCurrency(plan.stageCurrency) &&
    plan.stageCurrency !== null &&
    plan.stagePriceWei !== null &&
    /^[0-9]+$/.test(plan.stagePriceWei)
      ? await fetchErc20Funding(rpcUrl, plan.stageCurrency, plan.walletAddress, tx.to).then(
          (f) => ({
            balance: f.balance,
            required: BigInt(plan.stagePriceWei as string) * BigInt(Math.max(1, plan.quantity)),
            allowance: f.allowance,
            symbol: f.symbol,
            decimals: f.decimals,
          }),
          () => undefined,
        )
      : undefined;
  return assessMintFunding({
    nativeBalanceWei,
    valueWei: BigInt(tx.valueWei),
    gasLimit: BigInt(config.MINT_PRESIGN_GAS_LIMIT),
    maxFeePerGasWei: BigInt(maxFeePerGasWei),
    ...(erc20 !== undefined ? { erc20 } : {}),
  });
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

  // Pass the configured lead so the claim's own tolerance cannot silently
  // cap it, and a lease long enough to outlive a full signature burst.
  const plan = await claimArmedMintPlan(db, now, 30_000, config.MINT_FIRE_LEAD_MS);
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
    // The fire path gets its OWN endpoint list: premium providers reserved
    // for minting first, registry/public behind them as failover. Background
    // jobs keep using the registry alone, so nothing they do can spend the
    // budget this path needs (2026-09-15 22:00: chain-sync's eth_getLogs
    // earned a 429 from Alchemy three seconds into a live mint).
    const registryUrls = await resolveBroadcastRpcUrls(
      db,
      config.ROBINHOOD_CHAIN_ID,
      config.RPC_URL,
    );
    const fireUrls = mintRpcUrls(config, registryUrls);
    const rpcUrl = fireUrls[0];
    if (!rpcUrl) {
      await record("failed", { errorCode: "no_rpc_configured" });
      return { expired, claimed: true, outcome: "no_rpc_configured", planId: plan.id };
    }
    // Hop-by-hop timing. Tonight's real fire is the only way to learn where
    // the milliseconds actually go on this chain and this provider, and a
    // race is lost in the hops nobody measured.
    const t0 = performance.now();
    const marks: Array<[string, number]> = [];
    const mark = (name: string) => {
      marks.push([name, Math.round((performance.now() - t0) * 10) / 10]);
    };
    mark("claimed");

    // The wallet read is hoisted here for its address; its guards stay at
    // their original position below so a missing row cannot pre-empt the
    // idempotency gate.
    const [project] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, plan.projectId));
    const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, plan.walletId));

    // PREFETCH, STARTED FIRST. Measured on the 2026-09-15 21:00 GTD: the burst waits
    // 230-1200ms for OpenSea to flip, and only THEN did the fire path ask the
    // RPC for nonce+fees — at the one moment every other bot on the chain is
    // hammering the same endpoint. `eth_getTransactionCount` exceeded its
    // 800ms budget TWICE in a row and killed two whole attempts, costing 2.5
    // seconds and the race. The RPC does not need to be asked at the fire
    // instant at all: start it here, in parallel with the burst, so the nonce
    // is already in hand the moment calldata arrives.
    //
    // Starting it "in parallel with the burst" was not enough. On the
    // 2026-09-16 21:00 GTD the burst returned in 273ms and fees_nonce still
    // cost 265.7ms, because SEVEN awaited reads — the idempotency gate's own
    // RPC round-trip among them — ran between the claim and this point. A
    // prefetch hidden behind something slow is not fast, it is just late. It
    // now starts before all of them and overlaps every one.
    let feesPrefetch: Promise<Awaited<ReturnType<typeof fetchFeeContext>>> | null = null;

    // Are we AT the fire instant (operator fire_at, else stage open)? Then
    // this pass is the race: burst-poll OpenSea for the signature instead of
    // one paced call, and skip simulation downstream. Outside that window
    // (coarse 30s re-tries, hopeless plans) stay cheap and paced.
    const nearFire = await isNearFireInstant(db, plan, FIRE_BURST_WINDOW_MS);
    // `wallet.encryptedSigningKey !== null` is the same condition that makes
    // signerScheme managed_wallet_key further down, minus the signers read we
    // have deliberately not done yet. It is a superset: an active
    // custom_executor signer makes this one read wasted, a far cheaper
    // mistake than paying for the nonce on the critical path.
    if (nearFire && wallet?.encryptedSigningKey != null) {
      // Warm every broadcast socket while the burst waits on OpenSea. Costs
      // one trivial read per endpoint and removes a TCP+TLS handshake from
      // the send at T.
      void warmRpcConnections(fireUrls);
      // Generous budget: this runs off the critical path, and a saturated RPC
      // at the open is slow, not broken. Swallow the rejection here so an
      // unsettled promise cannot crash the pass; the consumer re-fetches.
      // Failover across every fire endpoint: a read that fails on one
      // provider must not cost the mint, which is exactly what a single
      // saturated endpoint did at 21:00.
      feesPrefetch = withRpcFailover(
        fireUrls,
        (url) => fetchFeeContext(url, wallet.address, { timeoutMs: 4_000 }),
        (url, error) =>
          log.warn(
            { planId: plan.id, rpc: redactRpc(url), err: error },
            "fee/nonce prefetch failed on this endpoint — trying the next",
          ),
      );
      feesPrefetch.catch(() => undefined);
    }

    // IDEMPOTENCY GATE. A claim is not proof that nothing was sent: this pass
    // may be a re-claim after the lease expired because the previous worker
    // was killed between sendRawTransaction returning and the status write,
    // or because its local broadcast timed out on a request the sequencer had
    // already accepted. In both cases the hash is sitting in
    // execution_attempts and was, until now, never read back — so the worker
    // signed a second transaction at the next nonce and the wallet minted and
    // paid twice. Ask the chain before doing anything else.
    const priorBroadcast = await latestBroadcastAttempt(db, plan.id);
    if (priorBroadcast !== undefined) {
      const priorOutcome = await resolveTxOutcome(rpcUrl, priorBroadcast.txHash);
      if (priorOutcome === "success") {
        log.info(
          { planId: plan.id, txHash: priorBroadcast.txHash },
          "plan already has a MINED transaction — completing it instead of firing again",
        );
        await markMintPlanExecuted(db, plan.id);
        return { expired, claimed: true, outcome: "already_broadcast", planId: plan.id };
      }
      if (priorOutcome === "unknown") {
        // Still in flight, or an unreadable endpoint. Broadcasting now could
        // double-mint, so give it a bounded grace and let a later tick decide.
        // Past the grace, assume it was genuinely dropped and re-fire.
        const ageMs = Date.now() - priorBroadcast.attemptAt.getTime();
        if (ageMs < PRIOR_BROADCAST_GRACE_MS) {
          log.warn(
            { planId: plan.id, txHash: priorBroadcast.txHash, ageMs },
            "a prior broadcast for this plan is unresolved — holding rather than risking a second mint",
          );
          await releaseMintPlanToArmed(db, plan.id, new Date());
          return { expired, claimed: true, outcome: "awaiting_prior_broadcast", planId: plan.id };
        }
      }
      // "reverted", or an unresolved broadcast older than the grace: that
      // transaction did not mint, so firing again is correct.
    }

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
    // ── SELF-SERVED PUBLIC MINT ──────────────────────────────────────────
    // A `public` stage is `mintPublic` on SeaDrop: no signature, no allowlist
    // proof, nothing OpenSea has to grant us. Verified on chain 4663 —
    // `eth_call` of mintPublic from an unrelated address succeeds on live
    // public drops, and `getPublicDrop().startTime` matched OpenSea's
    // published schedule to the second on every collection sampled.
    //
    // That matters because OpenSea's /mint does not answer until OPENSEA's
    // clock flips (measured T+343ms and T+405ms), and two FCFS drops sold out
    // inside that window. Building the calldata ourselves removes OpenSea —
    // and OpenSea's clock — from the public path entirely.
    //
    // `allowlist` stages are NOT SeaDrop merkle allowlists here (merkle root
    // is zero chain-wide); OpenSea implements them with `mintSigned`, whose
    // signature only its own signer can produce. Those must keep using the
    // burst.
    const selfServed = await buildSelfServedPublicMint({
      rpcUrls: fireUrls,
      stageId: plan.stageId,
      db,
      contractAddress: project.contractAddress,
      minter: wallet.address,
      quantity: plan.quantity,
      chainId: project.chainId,
      // SeaDrop credits msg.sender. Under custom_executor the payer is the
      // Executor contract, so the NFT would land there instead of the wallet.
      ...(signerScheme === "custom_executor" ? { minterIfNotPayer: wallet.address } : {}),
    });

    if (selfServed.kind === "sold_out") {
      log.warn({ planId: plan.id }, "public drop is sold out on-chain — plan failed (terminal)");
      await record("failed", { errorCode: "minted_out: on-chain supply exhausted" });
      await failPlanAndNotify(db, plan);
      return { expired, claimed: true, outcome: "minted_out", planId: plan.id };
    }
    if (selfServed.kind === "allowance_exhausted") {
      log.warn(
        { planId: plan.id },
        "wallet has no per-wallet allowance left on this drop — plan failed (terminal)",
      );
      await record("failed", { errorCode: "allowance_exhausted: on-chain getMintStats" });
      await failPlanAndNotify(db, plan);
      return { expired, claimed: true, outcome: "allowance_exhausted", planId: plan.id };
    }
    if (selfServed.kind === "read_failed") {
      // Do not hide it: falling through to OpenSea still works, but a silent
      // RPC failure here is a misconfiguration the operator should see.
      log.warn(
        { planId: plan.id, err: selfServed.message },
        "self-served public read failed on every endpoint — falling back to OpenSea",
      );
      await record("failed", {
        errorCode: `self_served_read_failed: ${selfServed.message}`.slice(0, 200),
      });
    }

    let selfServedTx: SelfServedTx | undefined;
    let selfServedHoldUntilMs: number | null = null;
    let selfServedOnChainStartMs: number | null = null;
    if (selfServed.kind === "built") {
      if (selfServed.quantity < selfServed.requestedQuantity) {
        log.warn(
          {
            planId: plan.id,
            requested: selfServed.requestedQuantity,
            using: selfServed.quantity,
          },
          "public mint quantity clamped by the on-chain per-wallet cap / remaining supply",
        );
        await record("failed", {
          errorCode: `quantity_clamped: requested=${selfServed.requestedQuantity} using=${selfServed.quantity}`,
        });
      }
      // THE CONTRACT'S clock, not OpenSea's. `_checkActive` runs first and
      // reverts NotActive before anything else, so firing against a stale
      // published time burns gas and — with the revert cap — can terminally
      // fail a plan at its own open. updatePublicDrop can move this window at
      // any time, so the on-chain value always wins.
      const clockOffsetMs = (await getSetting<number>(db, CHAIN_CLOCK_OFFSET_SETTING_KEY)) ?? 0;
      const openLocalMs = chainTimeToLocalMs(selfServed.onChainStartMs, clockOffsetMs);
      const closeLocalMs = chainTimeToLocalMs(selfServed.onChainEndMs, clockOffsetMs);
      const publishedMs = await fireTargetMs(db, plan);
      if (publishedMs !== null && Math.abs(openLocalMs - publishedMs) > 1_000) {
        log.warn(
          {
            planId: plan.id,
            onChain: new Date(openLocalMs).toISOString(),
            openSea: new Date(publishedMs).toISOString(),
          },
          "on-chain public start disagrees with OpenSea's published time — trusting the chain",
        );
      }
      if (Date.now() > closeLocalMs) {
        await record("failed", { errorCode: "public_window_closed" });
        await failPlanAndNotify(db, plan);
        return { expired, claimed: true, outcome: "public_window_closed", planId: plan.id };
      }
      const sendAtMs = openLocalMs - config.MINT_FIRE_LEAD_MS;
      const waitMs = sendAtMs - Date.now();
      if (waitMs > SELF_SERVED_MAX_HOLD_MS) {
        // Too early to hold inside the claim lease — give the plan back and
        // let the 200ms hot loop bring us round again.
        await releaseMintPlanToArmed(db, plan.id, new Date());
        return { expired, claimed: true, outcome: "self_served_not_open", planId: plan.id };
      }
      selfServedTx = selfServed.tx;
      selfServedHoldUntilMs = waitMs > 0 ? sendAtMs : null;
      selfServedOnChainStartMs = selfServed.onChainStartMs;
    }

    const cachedAt = plan.cachedTxAt === null ? null : coerceDate(plan.cachedTxAt);
    // A cached blob is only safe OUTSIDE the fire instant. runSpeculativePreBuild
    // has no stage-timing filter, so while an EARLIER phase is live (an FCFS
    // phase running hours before the public phase) OpenSea returns valid
    // calldata for THAT phase and we cache it. At the public phase's fire
    // instant that blob is still < CACHE_TTL_MS old, so it would win here and
    // we would broadcast the earlier phase's price and — for signed_presale
    // stages — a server signature that is not valid for the phase being
    // minted: a guaranteed revert at the one instant that matters. At the fire
    // instant always re-ask OpenSea; that is what burstBuildOpenSeaMintTx is for.
    const cacheIsFresh =
      !nearFire && cachedAt !== null && Date.now() - cachedAt.getTime() < CACHE_TTL_MS;
    const tx =
      selfServedTx !== undefined
        ? selfServedTx
        : cacheIsFresh && plan.cachedTx !== null
          ? {
              to: plan.cachedTx.to,
              data: plan.cachedTx.data,
              valueWei: plan.cachedTx.valueWei,
              chainId: plan.cachedTx.chainId,
              expectedFrom: wallet.address,
            }
          : await (async () => {
              const target = {
                slug: project.slug as string,
                chainId: project.chainId,
                minter: wallet.address,
                quantity: plan.quantity,
              };
              // Shared build helper (finding #8) — identical to what the
              // pre-build pass caches, so cache-hit and cache-miss can't drift.
              //
              // Descend on a per-wallet-limit refusal. max_per_wallet is
              // CUMULATIVE across phases, so a wallet holding 1 from a GTD
              // phase is refused at 2 on the FCFS phase but would be allowed
              // at 1. The arm-time clamp already sizes most of this from
              // mint_events, but a mint made in another tool seconds earlier is
              // not indexed yet — this is the backstop that still gets the
              // operator the tokens they are entitled to instead of failing
              // the plan outright.
              let built: Awaited<ReturnType<typeof buildOpenSeaMintTx>> | undefined;
              let lastLimitError: unknown;
              for (let qty = plan.quantity; qty >= 1; qty -= 1) {
                try {
                  built = nearFire
                    ? await burstBuildOpenSeaMintTx(
                        ctx,
                        { ...target, quantity: qty },
                        {
                          maxMs: config.MINT_SIGNATURE_BURST_MS,
                          cadenceMs: config.MINT_SIGNATURE_BURST_CADENCE_MS,
                        },
                      )
                    : await buildOpenSeaMintTx(ctx, { ...target, quantity: qty });
                  if (qty !== plan.quantity) {
                    log.warn(
                      { planId: plan.id, requested: plan.quantity, using: qty },
                      "OpenSea refused the requested quantity for this wallet — rebuilt at the remaining allowance",
                    );
                  }
                  break;
                } catch (error: unknown) {
                  const message = error instanceof Error ? error.message : String(error);
                  if (!isPerWalletLimitError(message) || qty === 1) {
                    throw error;
                  }
                  lastLimitError = error;
                }
              }
              if (built === undefined) {
                throw lastLimitError instanceof Error
                  ? lastLimitError
                  : new Error("mint build failed at every quantity");
              }
              return { ...built, expectedFrom: wallet.address };
            })();

    mark("calldata_ready");
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
        // At the fire instant this eth_call+estimateGas is a whole RPC
        // round-trip spent re-proving what the burst's 200 just told us, on a
        // stage that has been open for about one round-trip. It is also the
        // gate that made an early attempt impossible (it reverts until the
        // stage opens). Off only for the managed-key path at nearFire, where
        // a revert costs gas on an L2 and nothing else; every other signer
        // scheme keeps the authoritative simulation.
        simulate:
          nearFire && config.MINT_FIRE_SKIP_SIMULATION && signerScheme === "managed_wallet_key"
            ? async () => ({
                ok: true as const,
                gasEstimate: BigInt(config.MINT_PRESIGN_GAS_LIMIT),
              })
            : simulateTransaction,
        now: () => new Date(),
      },
    );

    mark("pipeline_done");
    metrics().inc("hoodmint_execution_pipeline_total", { stage: outcome.stage });
    log.info(
      {
        planId: plan.id,
        stage: outcome.stage,
        nearFire,
        // ms since claim, per hop. Read this after a real fire to see which
        // hop owns the latency before touching the fire path again.
        timingMs: Object.fromEntries(marks),
      },
      "mint execution pipeline outcome",
    );

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
      await failPlanAndNotify(db, plan);
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
        await runManagedFire(ctx, plan, outcome, wallet, rpcUrl, record, {
          nearFire,
          feesPrefetch,
          fireUrls,
          holdUntilMs: selfServedHoldUntilMs,
          onChainStartMs: selfServedOnChainStartMs,
        });
      } else {
        await runDelegatedFire(ctx, plan, outcome, delegatedSignerRow, rpcUrl, record);
      }
    }

    return { expired, claimed: true, outcome: outcome.stage, planId: plan.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    if (isMintedOutError(message)) {
      // OpenSea's /mint takes no stage argument: it answers about whichever
      // stage IT considers active. We deliberately start polling BEFORE our
      // own stage opens, so a "minted out" arriving early is very often a
      // statement about the PREVIOUS phase, whose allocation is naturally
      // spent by then — not about ours, which has not started.
      //
      // Killing the plan on that answer is how both FCFS phases were lost on
      // 2026-09-16: each died 757ms after its published start, before a
      // single piece of calldata had been obtained. Exactly the same mistake
      // as treating "exceeds max per wallet" as terminal, which this file
      // already fixed — the reasoning was simply never carried across.
      //
      // So: terminal only once OUR stage is genuinely open. Before that,
      // release and keep competing.
      const targetMs = await fireTargetMs(db, plan);
      const stageOpen = mintedOutIsTerminal({ nowMs: Date.now(), fireTargetMs: targetMs });
      // Keep OpenSea's own words. Overwriting them with a fixed string made
      // this failure undiagnosable after the fact.
      const rawErr = `minted_out: ${message}`.slice(0, 200);
      if (!stageOpen) {
        log.warn(
          { planId: plan.id, msUntilStage: targetMs === null ? null : targetMs - Date.now() },
          "provider reported minted-out BEFORE our stage opened — about another phase, releasing to keep competing",
        );
        await record("failed", { errorCode: `minted_out_pre_open: ${message}`.slice(0, 200) });
        await releaseMintPlanToArmed(db, plan.id, new Date());
        return { expired, claimed: true, outcome: "minted_out_pre_open", planId: plan.id };
      }
      log.warn(
        { planId: plan.id, providerMessage: message },
        "drop fully minted out — plan failed (terminal)",
      );
      await record("failed", { errorCode: rawErr });
      await failPlanAndNotify(db, plan);
      return { expired, claimed: true, outcome: "minted_out", planId: plan.id };
    }
    if (isInsufficientFundsError(message)) {
      // The wallet cannot pay (Chill Guys 2026-08-30: OpenSea 422
      // "Insufficient balance to mint" retried every tick until EXPIRED).
      // Terminal for this plan — the funding gate at arm/presign time is
      // where a top-up still helps; at T-0 retrying only burns quota.
      log.warn({ planId: plan.id }, "wallet underfunded at fire — plan failed (terminal)");
      await record("failed", { errorCode: `insufficient_funds: ${message}`.slice(0, 200) });
      await failPlanAndNotify(db, plan);
      return { expired, claimed: true, outcome: "insufficient_funds", planId: plan.id };
    }
    // Descended all the way to one token and OpenSea still says the wallet is
    // over its per-wallet limit: the allowance really is spent. Retrying only
    // burns write quota the other plans need.
    if (/provider returned 4\d\d/.test(message) && isPerWalletLimitError(message)) {
      log.warn(
        { planId: plan.id },
        "wallet allowance exhausted on this drop (refused even at quantity 1) — plan failed (terminal)",
      );
      await record("failed", { errorCode: `allowance_exhausted: ${message}`.slice(0, 200) });
      await failPlanAndNotify(db, plan);
      return { expired, claimed: true, outcome: "allowance_exhausted", planId: plan.id };
    }
    if (/provider returned 4\d\d/.test(message) && isTerminalMintBuildError(message)) {
      // OpenSea's own 4xx verdict about the DROP (minted out / sold out /
      // insufficient balance) — it will answer the same way on every retry
      // inside this window. A per-wallet-limit answer is deliberately NOT in
      // this set: the build loop above has already descended to quantity 1,
      // so reaching here with one means the allowance is genuinely gone, and
      // it falls through to the non-terminal release path where the arm
      // window bounds the retries.
      log.warn(
        { planId: plan.id },
        "OpenSea refused the mint for this wallet — plan failed (terminal)",
      );
      await record("failed", { errorCode: `refused: ${message}`.slice(0, 200) });
      await failPlanAndNotify(db, plan);
      return { expired, claimed: true, outcome: "refused", planId: plan.id };
    }
    log.error({ err: error, planId: plan.id }, "mint execution pass failed");
    await record("failed", { errorCode: message.slice(0, 200) });
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
    await failPlanAndNotify(db, plan);
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
      await failPlanAndNotify(db, plan);
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
/**
 * Terminal failure + tell somebody.
 *
 * Every failMintPlanExecution call site used to be silent: publishEvent fired
 * only for awaiting_signature and broadcast, so a plan that died mid-window
 * (minted out, insufficient funds, OpenSea refusal, misconfigured signer)
 * flipped to `failed`, wrote an execution_attempts row, and reached nobody.
 * The operator was watching Discord and found out after the drop.
 */
async function failPlanAndNotify(
  db: Parameters<typeof failMintPlanExecution>[0],
  plan: { id: string; projectId: string },
): Promise<void> {
  await failMintPlanExecution(db, plan.id);
  await publishEvent(db, {
    type: "execution.failed",
    projectId: plan.projectId,
    at: new Date().toISOString(),
  });
}

/**
 * Open a sealed wallet key and sign, with every failure flattened to a fixed
 * string. Nothing that happens between the decrypt and the signature may
 * reach a caller's error handler, because the fire path persists exception
 * text into execution_attempts.error_code and the admin UI renders it.
 */
async function signWithManagedKeySealed(
  tx: Parameters<typeof signManagedMintTransaction>[0],
  encryptedSigningKey: string,
  config: WorkerContext["config"],
): Promise<Awaited<ReturnType<typeof signManagedMintTransaction>>> {
  try {
    const privateKeyHex = openWalletKey(encryptedSigningKey, {
      masterKeyB64: config.APP_ENCRYPTION_KEY,
      walletPrivateKeyB64: config.WALLET_KEY_PRIVATE_KEY,
    });
    return await signManagedMintTransaction(tx, privateKeyHex);
  } catch {
    throw new Error("managed_key_sign_failed: could not open or sign with the sealed wallet key");
  }
}

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
  mode: {
    nearFire: boolean;
    /** Fee+nonce already in flight since before the burst (see runMintExecutionPass). */
    feesPrefetch?: Promise<Awaited<ReturnType<typeof fetchFeeContext>>> | null;
    /** Mint-only endpoint list, premium first (see mint-rpc.ts). */
    fireUrls?: readonly string[];
    /**
     * Local instant to hold the SIGNED transaction until, for a self-served
     * public mint. SeaDrop's `_checkActive` runs before every other check, so
     * arriving one second early is a guaranteed revert; signing first and
     * waking to a single sendRawTransaction is the fastest legal arrival.
     */
    holdUntilMs?: number | null;
    /** The contract's own start, for classifying an early revert. */
    onChainStartMs?: number | null;
  } = { nearFire: false },
): Promise<void> {
  const { db, log } = ctx;
  if (wallet.encryptedSigningKey === null) {
    await record("failed", { errorCode: "managed_key_missing" });
    await failPlanAndNotify(db, plan);
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
      presignedNonce: mintPlansTable.presignedNonce,
    })
    .from(mintPlansTable)
    .where(eq(mintPlansTable.id, plan.id))
    .limit(1);
  // A blob signed before this instant can only carry an EARLIER phase's
  // calldata (and, for a signed stage, a signature that is not valid for the
  // phase being minted). At the fire instant the fresh burst calldata is the
  // only trustworthy one, so the fast path is off there — including for a
  // leftover blob written before pre-signing was disabled.
  if (!mode.nearFire && fresh?.presignedRawTx) {
    // Set the moment a hash exists. Everything after that point is
    // bookkeeping, and bookkeeping must never re-arm a plan whose
    // transaction is already on the wire (see the catch below).
    let broadcastTxHash: string | null = null;
    try {
      // Race-broadcast: fire the identical raw tx at every healthy RPC at
      // once; first acceptance wins, the rest are harmless duplicates.
      const urls = await resolveBroadcastRpcUrls(db, ctx.config.ROBINHOOD_CHAIN_ID, rpcUrl);
      const rawTx = fresh.presignedRawTx;
      const broadcast = await Promise.any(
        (urls.length > 0 ? urls : [rpcUrl]).map((url) => broadcastRawTransaction(url, rawTx)),
      ).catch((aggregate: unknown) => {
        // Promise.any rejects with an AggregateError; pick the most
        // meaningful reason rather than whichever endpoint happened to be
        // first in the array, so stale-nonce and insufficient-funds
        // detection below cannot be masked by a slow proxy's transport error.
        throw pickBroadcastError(aggregate);
      });
      broadcastTxHash = broadcast.txHash;
      await record("broadcast", { txHash: broadcast.txHash });
      await clearPresignedTx(db, plan.id);
      // Mempool acceptance is not a mint. Ask the chain what actually
      // happened before consuming the arm: a revert here still leaves time
      // in the window to compete.
      const confirmed = await waitForMintReceipt(rpcUrl, broadcast.txHash);
      if (confirmed === "reverted") {
        await record("failed", { errorCode: "reverted_onchain" });
        const reverts = await countRevertedAttempts(db, plan.id);
        if (reverts >= MAX_ONCHAIN_REVERTS) {
          log.warn(
            { planId: plan.id, txHash: broadcast.txHash, reverts },
            "mint reverted on-chain too many times — stopping, every further attempt is gas for nothing",
          );
          await failPlanAndNotify(db, plan);
          return;
        }
        log.warn(
          { planId: plan.id, txHash: broadcast.txHash, fastPath: true, reverts },
          "pre-signed mint reverted on-chain — releasing to keep competing in the window",
        );
        await releaseMintPlanToArmed(db, plan.id, new Date());
        return;
      }
      if (confirmed === "unknown") {
        // Still in flight. Consume the arm anyway: re-arming a plan whose
        // transaction may yet mine is exactly how a wallet mints twice.
        log.warn(
          { planId: plan.id, txHash: broadcast.txHash },
          "mint broadcast not confirmed within the receipt budget — treating as in-flight, not retrying",
        );
      }
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
      // A transaction is already on the wire. Whatever failed after that was
      // bookkeeping, not the mint. Releasing the plan back to `armed` here
      // would let the next 200ms tick sign and broadcast a SECOND mint at
      // nonce+1 — two NFTs, two payments. Never release once a hash exists.
      if (broadcastTxHash !== null) {
        log.error(
          { err: error, planId: plan.id, txHash: broadcastTxHash },
          "mint broadcast succeeded but post-broadcast bookkeeping failed — marking executed, not releasing",
        );
        await clearPresignedTx(db, plan.id).catch(() => undefined);
        await markMintPlanExecuted(db, plan.id).catch(() => undefined);
        return;
      }
      await clearPresignedTx(db, plan.id);
      if (!isStalePresignError(message)) {
        await record("failed", { errorCode: message.slice(0, 200) });
        if (isInsufficientFundsError(message)) {
          // The RPC says the wallet cannot pay gas × price + value —
          // terminal, a retry cannot change the balance.
          await failPlanAndNotify(db, plan);
          return;
        }
        // Other real failure (reverted, RPC hiccup): retry within the
        // window via the normal release path.
        await releaseMintPlanToArmed(db, plan.id, new Date());
        return;
      }
      // "nonce too low" / "already known" is ambiguous: either the wallet
      // sent something else and our blob is dead, or OUR OWN pre-signed
      // transaction already landed. Re-signing in the second case mints a
      // second NFT at nonce+1 and pays twice, so resolve it against the
      // chain instead of guessing from the error string.
      if (fresh.presignedTxHash !== null) {
        const landed = await resolveTxOutcome(rpcUrl, fresh.presignedTxHash);
        if (landed === "success") {
          log.info(
            { planId: plan.id, txHash: fresh.presignedTxHash },
            "pre-signed tx rejected as stale because it had ALREADY MINED — marking executed, not re-signing",
          );
          await record("broadcast", { txHash: fresh.presignedTxHash });
          await markMintPlanExecuted(db, plan.id);
          return;
        }
        if (landed === "reverted") {
          // It landed and reverted: the nonce IS consumed, so the chain has
          // moved on and re-signing at the next nonce is correct. Do not
          // release the reservation here.
          log.warn(
            { planId: plan.id, txHash: fresh.presignedTxHash },
            "pre-signed tx landed but reverted — re-signing at the next nonce",
          );
        }
      }
      // The blob is being discarded without ever having been mined, so the
      // nonce it reserved at pre-sign time is NOT consumed. Releasing it is
      // what stops the live re-sign from taking nonce+1 and stranding the
      // wallet behind a permanent gap at the nonce the chain still expects.
      if (fresh.presignedNonce !== null) {
        releaseNonce(wallet.address, fresh.presignedNonce);
      }
      log.warn(
        { planId: plan.id },
        "pre-signed tx stale (nonce moved) — falling back to live sign",
      );
      // fall through to full path
    }
  }
  // Nothing measured the post-calldata half of the race until now: sign,
  // broadcast and receipt all happen after the pipeline's last mark.
  const fireT0 = performance.now();
  const fireMarks: Array<[string, number]> = [];
  const fireMark = (name: string) => {
    fireMarks.push([name, Math.round((performance.now() - fireT0) * 10) / 10]);
  };

  // Same rule as the fast path: once this holds a hash, the catch below must
  // not re-arm the plan.
  let liveBroadcastTxHash: string | null = null;
  /** Set as soon as a transaction is SIGNED — before it goes near the wire. */
  let liveSignedTxHash: string | null = null;
  let signingNonce: number | null = null;
  try {
    // At the fire instant every RPC round-trip is a lost block (100ms
    // blocks, FIFO sequencer): fetch nonce/fees IN PARALLEL with the
    // simulation, and skip the simulation entirely when configured — the
    // sequencer is the judge and a revert costs only gas. Off the fire
    // instant keep the authoritative eth_call gate.
    const skipSim = mode.nearFire && ctx.config.MINT_FIRE_SKIP_SIMULATION;
    const [sim, fees] = await Promise.all([
      skipSim
        ? Promise.resolve({
            ok: true as const,
            gasEstimate: BigInt(ctx.config.MINT_PRESIGN_GAS_LIMIT),
          })
        : simulateTransaction({
            rpcUrl,
            from: wallet.address,
            to: outcome.tx.to,
            data: outcome.tx.data,
            valueWei: outcome.tx.valueWei,
          }),
      // Fresh nonce/fee for THIS wallet right before signing (per-wallet nonce).
      // Prefetched during the burst when we have it. Falling back to a fresh
      // fetch with a budget that tolerates a saturated RPC — an 800ms read
      // timeout here is what lost the 21:00 GTD.
      (mode.feesPrefetch ?? Promise.reject(new Error("no prefetch"))).catch(() =>
        withRpcFailover(mode.fireUrls ?? [rpcUrl], (url) =>
          fetchFeeContext(url, wallet.address, { timeoutMs: 4_000 }),
        ),
      ),
    ]);
    if (!sim.ok) {
      await record("simulated_revert", {
        errorCode: sim.revertReason,
        simulationResult: { revertReason: sim.revertReason, managed: true },
      });
      await releaseMintPlanToArmed(db, plan.id, new Date());
      return;
    }

    // Decrypt the sealed key into a function-scoped local, hand it straight to
    // the chokepoint, and never log it. `openWalletKey` handles both the
    // worker-only envelope and a legacy symmetric blob; throws on tamper.
    // Decrypt + sign inside their OWN try/catch that rethrows a FIXED string.
    // The outer catch persists `error.message.slice(0, 200)` into
    // execution_attempts.error_code, which the admin UI renders — so any
    // exception raised while key material is in scope is a leak surface.
    // viem/@noble do not echo a key body today, but nothing pins that, and
    // one dependency bump is all it takes. scripts/approve-erc20.ts already
    // guards this shape; the fire path did not.
    fireMark("fees_nonce");
    signingNonce = reserveNonce(wallet.address, fees.nonce);
    const signed = await signWithManagedKeySealed(
      {
        chainId: outcome.tx.chainId,
        to: outcome.tx.to,
        data: outcome.tx.data,
        valueWei: outcome.tx.valueWei,
        // Same reservation as the presign pass: a sibling plan on this wallet
        // may already hold the RPC's pending nonce.
        nonce: signingNonce,
        maxFeePerGasWei: fees.maxFeePerGasWei,
        maxPriorityFeePerGasWei: fees.maxPriorityFeePerGasWei,
        gas: (sim.gasEstimate * 120n) / 100n,
      },
      wallet.encryptedSigningKey,
      ctx.config,
    );

    // WRITE-AHEAD. The hash is keccak256(rawTx), computed locally at signing
    // with no round-trip, so it costs nothing to record the INTENT before the
    // wire call. It closes the last double-mint hole: if every endpoint
    // rejects — one having timed out locally AFTER the sequencer accepted,
    // the rest answering "already known" — the old code recorded no hash at
    // all, the next tick's idempotency gate found nothing to check, and the
    // wallet signed again at the next nonce and paid twice.
    fireMark("signed");
    if (mode.holdUntilMs !== null && mode.holdUntilMs !== undefined) {
      const waitMs = mode.holdUntilMs - Date.now();
      if (waitMs > 0) {
        // Everything is done: fees, nonce, key, calldata, signature. The only
        // work left after this sleep is one sendRawTransaction.
        await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 15_000)));
        fireMark("held_for_open");
      }
    }
    liveSignedTxHash = signed.txHash;
    await record("broadcast", { txHash: signed.txHash });

    // Race-broadcast to every healthy RPC (same as the pre-signed fast path):
    // first acceptance wins, duplicates are harmless on a FIFO sequencer.
    const urls =
      mode.fireUrls !== undefined && mode.fireUrls.length > 0
        ? [...mode.fireUrls]
        : await resolveBroadcastRpcUrls(db, ctx.config.ROBINHOOD_CHAIN_ID, rpcUrl);
    const rawTx = signed.rawTx;
    const broadcast = await Promise.any(
      (urls.length > 0 ? urls : [rpcUrl]).map((url) => broadcastRawTransaction(url, rawTx)),
    ).catch((aggregate: unknown) => {
      throw pickBroadcastError(aggregate);
    });
    liveBroadcastTxHash = broadcast.txHash;
    fireMark("broadcast_accepted");
    // Same rule as the fast path: the chain, not the mempool, decides whether
    // this was a mint.
    const confirmedLive = await waitForMintReceipt(rpcUrl, broadcast.txHash);
    if (confirmedLive === "reverted") {
      // A revert BEFORE the contract's own start is NotActive — a timing
      // artefact, not evidence that the drop is dead. Record it under a
      // different code so the sold-out cap never counts it.
      const early =
        mode.onChainStartMs !== null &&
        mode.onChainStartMs !== undefined &&
        Date.now() < mode.onChainStartMs + 1_000;
      await record("failed", { errorCode: early ? "reverted_early" : "reverted_onchain" });
      const reverts = await countRevertedAttempts(db, plan.id);
      if (reverts >= MAX_ONCHAIN_REVERTS) {
        log.warn(
          { planId: plan.id, txHash: broadcast.txHash, reverts },
          "mint reverted on-chain too many times — stopping, every further attempt is gas for nothing",
        );
        await failPlanAndNotify(db, plan);
        return;
      }
      log.warn(
        { planId: plan.id, txHash: broadcast.txHash, reverts },
        "mint reverted on-chain — releasing to keep competing in the window",
      );
      await releaseMintPlanToArmed(db, plan.id, new Date());
      return;
    }
    if (confirmedLive === "unknown") {
      log.warn(
        { planId: plan.id, txHash: broadcast.txHash },
        "mint broadcast not confirmed within the receipt budget — treating as in-flight, not retrying",
      );
    }
    await markMintPlanExecuted(db, plan.id);
    fireMark("receipt");
    log.info(
      {
        planId: plan.id,
        walletId: wallet.id,
        txHash: broadcast.txHash,
        nearFire: mode.nearFire,
        urlsRaced: urls.length > 0 ? urls.length : 1,
        fireTimingMs: Object.fromEntries(fireMarks),
      },
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
    if (liveBroadcastTxHash !== null) {
      log.error(
        { err: error, planId: plan.id, txHash: liveBroadcastTxHash },
        "mint broadcast succeeded but post-broadcast bookkeeping failed — marking executed, not releasing",
      );
      await markMintPlanExecuted(db, plan.id).catch(() => undefined);
      return;
    }
    // A signed transaction may have reached the sequencer even though every
    // endpoint reported failure. Ask the chain before deciding it did not.
    if (liveSignedTxHash !== null) {
      const landed = await resolveTxOutcome(rpcUrl, liveSignedTxHash);
      if (landed === "success") {
        log.info(
          { planId: plan.id, txHash: liveSignedTxHash },
          "broadcast reported failure but the transaction MINED — completing, not retrying",
        );
        await markMintPlanExecuted(db, plan.id).catch(() => undefined);
        return;
      }
      if (landed === "unknown") {
        // In flight or unreadable. Do not release the nonce and do not
        // re-arm here; the idempotency gate re-checks this hash on the next
        // claim and only re-fires once it is genuinely absent.
        log.warn(
          { planId: plan.id, txHash: liveSignedTxHash },
          "broadcast failed but the signed tx may be in flight — holding for the idempotency gate",
        );
        await releaseMintPlanToArmed(db, plan.id, new Date());
        return;
      }
    }
    // Nothing reached the wire, so the reserved nonce was never consumed —
    // give it back, or the next signer skips it and opens a gap that strands
    // the wallet.
    if (signingNonce !== null) {
      releaseNonce(wallet.address, signingNonce);
    }
    log.error({ err: error, planId: plan.id }, "managed-key signing/broadcast failed");
    await record("failed", { errorCode });
    if (error instanceof Error && isInsufficientFundsError(error.message)) {
      await failPlanAndNotify(db, plan);
      return;
    }
    await releaseMintPlanToArmed(db, plan.id, new Date());
  }
}
