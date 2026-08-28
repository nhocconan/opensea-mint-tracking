/**
 * Signers, mint plans, and execution attempts (ADR 0004/0005). Phase 1 only:
 * the sole signer scheme this repository's callers may create today is
 * `browser_wallet` (the owner's own wallet, signing client-side — zero
 * server custody). `eip7702_safe_zodiac` / `custom_executor` rows may be
 * inserted for record-keeping but nothing in this codebase resolves a
 * session key for them yet (packages/signing throws NotImplemented).
 *
 * The armed→executing claim mirrors notification_outbox's
 * `for update skip locked` pattern (packages/db/repositories/outbox.ts) —
 * exactly-once dispatch under at-least-once worker semantics, never a
 * status check split across two queries.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Db, unwrapRows } from "../client.ts";
import {
  type DropStage,
  dropStages,
  type ExecutionAttempt,
  executionAttempts,
  type MintPlan,
  mintPlans,
  type Signer,
  signers,
} from "../schema.ts";

export interface CreateSignerInput {
  readonly chainId: number;
  readonly ownerAddress: string;
  readonly scheme: Signer["scheme"];
  readonly delegateContractAddress?: string;
  readonly sessionKeyCredentialId?: string;
  readonly onchainSpendCeilingWei?: string;
}

export async function createSigner(db: Db, input: CreateSignerInput): Promise<Signer> {
  const inserted = await db
    .insert(signers)
    .values({
      chainId: input.chainId,
      ownerAddress: input.ownerAddress.toLowerCase(),
      scheme: input.scheme,
      ...(input.delegateContractAddress !== undefined
        ? { delegateContractAddress: input.delegateContractAddress }
        : {}),
      ...(input.sessionKeyCredentialId !== undefined
        ? { sessionKeyCredentialId: input.sessionKeyCredentialId }
        : {}),
      ...(input.onchainSpendCeilingWei !== undefined
        ? { onchainSpendCeilingWei: input.onchainSpendCeilingWei }
        : {}),
      // browser_wallet needs no delegation ceremony: the owner IS the
      // signer, so it's immediately usable. Delegated schemes stay
      // 'pending' until Phase 2 activation is actually implemented.
      status: input.scheme === "browser_wallet" ? "active" : "pending",
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("createSigner: insert returned no row");
  }
  return row;
}

export async function listSigners(db: Db): Promise<Signer[]> {
  return db.select().from(signers).orderBy(desc(signers.createdAt));
}

export async function revokeSigner(db: Db, id: string): Promise<void> {
  await db
    .update(signers)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(eq(signers.id, id));
}

/**
 * ADR 0004 Phase 2: moves a delegated signer from 'pending' to 'active'.
 * The caller (an admin server action) must only call this once the
 * owner's own on-chain transactions (deploy, setOperator, setAllowlist —
 * each individually Ledger-signed via the owner's own browser wallet, per
 * ADR 0004's non-batched discipline) have actually been confirmed, not
 * merely submitted — this repository function has no way to verify that
 * itself, and trusts the caller. Never called automatically from a
 * discovery/refresh pass.
 */
export async function activateSigner(db: Db, id: string): Promise<void> {
  await db
    .update(signers)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(signers.id, id));
}

export async function getSigner(db: Db, id: string): Promise<Signer | undefined> {
  const [row] = await db.select().from(signers).where(eq(signers.id, id)).limit(1);
  return row;
}

/**
 * ADR 0004 Phase 2 onboarding: records the MintExecutor contract's address
 * once the owner's own deploy transaction has actually confirmed on-chain
 * (the caller verifies that — this function only writes the address down).
 * Kept separate from createSigner because the signer row is created
 * up-front (so a session key credential can be generated and shown to the
 * owner before they deploy), and the deployed address is only known
 * after.
 */
export async function setSignerDelegateContract(
  db: Db,
  id: string,
  delegateContractAddress: string,
): Promise<void> {
  await db
    .update(signers)
    .set({ delegateContractAddress: delegateContractAddress.toLowerCase(), updatedAt: new Date() })
    .where(eq(signers.id, id));
}

/** Sets the per-collection coarse on-chain ceiling once setAllowlist's own
 *  on-chain transaction (the real source of truth) has confirmed — this
 *  DB value must always mirror what was actually set on-chain, never
 *  drift ahead of it (ADR 0004 cap tiering: the coarse cap is a real,
 *  on-chain-enforced backstop, and canFireMintPlan's coarse-vs-precise
 *  check trusts this column as if it always matches). */
export async function setSignerOnchainCeiling(
  db: Db,
  id: string,
  onchainSpendCeilingWei: string,
): Promise<void> {
  await db
    .update(signers)
    .set({ onchainSpendCeilingWei, updatedAt: new Date() })
    .where(eq(signers.id, id));
}

/**
 * Looks up a single drop stage by id — used only to validate that a mint
 * plan's optional `stageId` actually belongs to the project it's being
 * created against (apps/web's `createMintPlanAction`) before it's ever
 * persisted. Not part of the hot loop.
 */
export async function getDropStage(db: Db, id: string): Promise<DropStage | undefined> {
  const [row] = await db.select().from(dropStages).where(eq(dropStages.id, id)).limit(1);
  return row;
}

export interface CreateMintPlanInput {
  readonly projectId: string;
  readonly walletId: string;
  readonly stageId?: string;
  readonly signerId?: string;
  readonly quantity?: number;
  readonly perPlanCeilingWei: string;
}

export async function createMintPlan(db: Db, input: CreateMintPlanInput): Promise<MintPlan> {
  const inserted = await db
    .insert(mintPlans)
    .values({
      projectId: input.projectId,
      walletId: input.walletId,
      ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
      ...(input.signerId !== undefined ? { signerId: input.signerId } : {}),
      quantity: input.quantity ?? 1,
      perPlanCeilingWei: input.perPlanCeilingWei,
      status: "draft",
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("createMintPlan: insert returned no row");
  }
  return row;
}

/**
 * Arm a draft plan: one collection, one signer, one ceiling, one time
 * window (ADR 0008) — the caller (a server action) must already have
 * enforced step-up re-authentication before calling this. Only a `draft`
 * plan may be armed; re-arming an expired/cancelled plan means creating a
 * fresh one, so the owner reviews the target again rather than silently
 * extending a stale window.
 */
export async function armMintPlan(
  db: Db,
  id: string,
  armedByUserId: string,
  windowMinutes: number,
): Promise<MintPlan | undefined> {
  const updated = await db
    .update(mintPlans)
    .set({
      status: "armed",
      armedAt: new Date(),
      armedUntil: new Date(Date.now() + windowMinutes * 60_000),
      armedByUserId,
      updatedAt: new Date(),
    })
    .where(and(eq(mintPlans.id, id), eq(mintPlans.status, "draft")))
    .returning();
  return updated[0];
}

export async function disarmMintPlan(db: Db, id: string): Promise<MintPlan | undefined> {
  const updated = await db
    .update(mintPlans)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(mintPlans.id, id), eq(mintPlans.status, "armed")))
    .returning();
  return updated[0];
}

/**
 * ADR 0009, item P4: persist a speculatively-built (or freshly-rebuilt)
 * OpenSea transaction against an armed plan. Plain `.update()`, not raw
 * SQL, so this is unaffected by the driver-shape bug found elsewhere this
 * session — no `.rows` involved.
 */
export async function cacheMintPlanTx(
  db: Db,
  id: string,
  tx: { to: string; data: string; valueWei: string; chainId: number },
): Promise<void> {
  await db
    .update(mintPlans)
    .set({ cachedTx: tx, cachedTxAt: new Date(), updatedAt: new Date() })
    .where(eq(mintPlans.id, id));
}

/**
 * Armed, still-in-window plans whose cached calldata is missing or older
 * than `ttlMs` — the pre-build worker pass's candidate list. Bounded by
 * `limit`; callers should treat this as "at most N speculative builds per
 * pass," not "build everything armed."
 */
export async function plansNeedingPreBuild(
  db: Db,
  now: Date,
  ttlMs: number,
  limit = 5,
): Promise<MintPlan[]> {
  const staleCutoff = new Date(now.getTime() - ttlMs);
  return db
    .select()
    .from(mintPlans)
    .where(
      and(
        eq(mintPlans.status, "armed"),
        sql`${mintPlans.armedUntil} > ${now.toISOString()}`,
        sql`(${mintPlans.cachedTxAt} is null or ${mintPlans.cachedTxAt} < ${staleCutoff.toISOString()})`,
      ),
    )
    .orderBy(mintPlans.armedUntil)
    .limit(limit);
}

export async function listMintPlans(db: Db, limit = 100): Promise<MintPlan[]> {
  return db.select().from(mintPlans).orderBy(desc(mintPlans.createdAt)).limit(limit);
}

/**
 * Delete a mint plan — DRAFT status ONLY. The `status = 'draft'` guard is in
 * the WHERE clause, not just the action layer, so an armed/executing/executed
 * plan can never be removed even if a stale UI or a race presents its id:
 * deleting an armed plan out from under the worker's execution loop would be
 * a correctness and audit hazard. Returns true only when a draft row matched.
 */
export async function deleteMintPlan(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(mintPlans)
    .where(and(eq(mintPlans.id, id), eq(mintPlans.status, "draft")))
    .returning({ id: mintPlans.id });
  return rows.length > 0;
}

/**
 * Armed, in-window plans that have a linked stage with a known start time —
 * the precision hot-loop's candidate list (packages/core/fire-schedule.ts).
 * Returns the stage start in epoch ms so the worker can compute the exact
 * clock-corrected fire instant without re-reading the stage row. Plans with
 * no stageId (or a stage since deleted) are excluded — they simply ride the
 * coarse 30s claim instead of precision firing. */
export async function armedPlansWithStageStart(
  db: Db,
  now: Date,
): Promise<{ id: string; stageStartMs: number }[]> {
  const rows = await db
    .select({ id: mintPlans.id, startsAt: dropStages.startsAt })
    .from(mintPlans)
    .innerJoin(dropStages, eq(mintPlans.stageId, dropStages.id))
    .where(and(eq(mintPlans.status, "armed"), sql`${mintPlans.armedUntil} > ${now.toISOString()}`));
  return rows.map((r) => ({ id: r.id, stageStartMs: r.startsAt.getTime() }));
}

/**
 * Atomically claim one due-to-fire plan (ADR 0005): status + window
 * checked together in the same statement that flips it to `executing`, so
 * a lagging/crashed disarm process can never leave a stale arm live. This
 * is the literal SQL mirror of `canFireMintPlan` (packages/core) for the
 * status+window half of that predicate; the caller still re-checks the
 * ceiling half (which needs the signer row) before proceeding.
 */
export async function claimArmedMintPlan(
  db: Db,
  now: Date,
  leaseMs = 15_000,
): Promise<MintPlan | undefined> {
  // Reclaim a plan that is `armed`, OR one stuck in `executing` whose lease
  // has expired (a worker crashed between claim and the terminal/reset
  // transition, or is deliberately re-firing across the compete burst).
  // Without the second clause a single non-broadcast pass (shadow mode —
  // the default! — or a "stage not open yet" simulation revert) would flip
  // armed→executing and strand the plan forever: never re-claimed, never
  // expired, mint silently missed. `executing` is a short lease, not a
  // terminal state. Found by code review 2026-08-23; the fire path resets
  // to `armed` after every non-terminal outcome (apps/worker/execution.ts),
  // and this lease is the crash-recovery backstop for that reset.
  const leaseCutoff = new Date(now.getTime() - leaseMs);
  const rows = await db.execute(sql`
    with due as (
      select id from mint_plans
       where armed_until > ${now.toISOString()}
         and (
           status = 'armed'
           or (status = 'executing' and updated_at < ${leaseCutoff.toISOString()})
         )
       order by armed_until asc
       limit 1
       for update skip locked
    )
    update mint_plans p
       set status = 'executing', updated_at = now()
      from due
     where p.id = due.id
    returning
      p.id,
      p.project_id as "projectId",
      p.stage_id as "stageId",
      p.signer_id as "signerId",
      p.wallet_id as "walletId",
      p.quantity,
      p.per_plan_ceiling_wei as "perPlanCeilingWei",
      p.status,
      p.armed_at as "armedAt",
      p.armed_until as "armedUntil",
      p.armed_by_user_id as "armedByUserId",
      p.cached_tx as "cachedTx",
      p.cached_tx_at as "cachedTxAt",
      p.created_at as "createdAt",
      p.updated_at as "updatedAt"
  `);
  // "returning p.*" would give raw snake_case column names and silently
  // produce a MintPlan with every camelCase field undefined (the exact
  // bug found in outbox.ts's claimDueAlerts via live integration testing,
  // 2026-08-22, and copied into this function from that same pattern) —
  // the explicit aliases above are what make this cast actually true.
  //
  // SEPARATE bug, found live 2026-08-22 (not caught by the fix above):
  // db.execute() on this postgres-js driver returns the row array
  // directly (Array.isArray === true, verified with a throwaway repro
  // script) — it has NO `.rows` property at all. `.rows ?? []` therefore
  // ALWAYS fell through to `[]`, so this function silently returned
  // `undefined` on every call regardless of whether a plan was actually
  // due — the mint-firing pipeline could never claim a plan, ever. Fixed
  // to the same `.rows ?? rows-as-array` defensive fallback already used
  // (and already correct) in outbox.ts's claimDueAlerts and ops.ts —
  // works whether the driver does or doesn't wrap results in `.rows`.
  //
  // THIRD lesson from this same function (ADR 0009, P4, 2026-08-22): this
  // explicit RETURNING column list is exactly why `cachedTx`/`cachedTxAt`
  // (added for P4) had to be added here by hand — a raw-SQL RETURNING
  // clause does not automatically pick up new schema columns the way a
  // typed `.returning()` would. Adding a column to `mint_plans` and
  // forgetting to add it here is a silent bug (the field is just always
  // undefined on a claimed plan), not a type error — caught here by
  // deliberately re-checking this exact function before relying on it,
  // precisely because the first two lessons above already happened here.
  return unwrapRows<MintPlan>(rows)[0];
}

/** Auto-expire plans whose window has passed without a terminal outcome.
 *  Sweeps both `armed` (never claimed) and `executing` (claimed but left
 *  mid-flight — e.g. a browser-sign the owner never completed, or a worker
 *  crash) so neither status can strand a plan past its window. */
export async function expireStaleMintPlans(db: Db, now: Date): Promise<number> {
  const updated = await db
    .update(mintPlans)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        inArray(mintPlans.status, ["armed", "executing"]),
        sql`${mintPlans.armedUntil} <= ${now.toISOString()}`,
      ),
    )
    .returning({ id: mintPlans.id });
  return updated.length;
}

/**
 * Return a claimed plan to `armed` so the next tick (or the precision
 * hot-loop) re-claims and retries it — the correct transition after any
 * NON-terminal fire outcome (shadow dry-run, a "stage not open yet"
 * simulation revert, a retryable broadcast failure). This is what turns a
 * single claim into the continuous compete burst on a FIFO chain. Only
 * resets a row still in `executing` and still within its window; a
 * concurrently-expired/disarmed plan is left alone. */
export async function releaseMintPlanToArmed(db: Db, id: string, now: Date): Promise<void> {
  await db
    .update(mintPlans)
    .set({ status: "armed", updatedAt: now })
    .where(
      and(
        eq(mintPlans.id, id),
        eq(mintPlans.status, "executing"),
        sql`${mintPlans.armedUntil} > ${now.toISOString()}`,
      ),
    );
}

/** Terminal success: a real transaction was broadcast (or the browser
 *  owner's signature was recorded). No more firing for this plan. */
export async function markMintPlanExecuted(db: Db, id: string): Promise<void> {
  await db
    .update(mintPlans)
    .set({ status: "executed", updatedAt: new Date() })
    .where(and(eq(mintPlans.id, id), eq(mintPlans.status, "executing")));
}

/** Terminal permanent failure (ceiling exceeded, unimplemented scheme,
 *  misconfigured signer) — never retry within the window. */
export async function failMintPlanExecution(db: Db, id: string): Promise<void> {
  await db
    .update(mintPlans)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(mintPlans.id, id), eq(mintPlans.status, "executing")));
}

export interface RecordExecutionAttemptInput {
  readonly planId: string;
  readonly status: ExecutionAttempt["status"];
  readonly simulationResult?: Record<string, unknown>;
  /** Set only alongside status='awaiting_signature' (ADR 0008 Phase 1). */
  readonly pendingTx?: { to: string; data: string; valueWei: string; chainId: number };
  readonly txHash?: string;
  readonly rpcEndpointId?: string;
  readonly errorCode?: string;
}

export async function recordExecutionAttempt(
  db: Db,
  input: RecordExecutionAttemptInput,
): Promise<ExecutionAttempt> {
  const inserted = await db
    .insert(executionAttempts)
    .values({
      planId: input.planId,
      status: input.status,
      ...(input.simulationResult !== undefined ? { simulationResult: input.simulationResult } : {}),
      ...(input.pendingTx !== undefined ? { pendingTx: input.pendingTx } : {}),
      ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
      ...(input.rpcEndpointId !== undefined ? { rpcEndpointId: input.rpcEndpointId } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("recordExecutionAttempt: insert returned no row");
  }
  return row;
}

export async function listExecutionAttempts(db: Db, limit = 100): Promise<ExecutionAttempt[]> {
  return db
    .select()
    .from(executionAttempts)
    .orderBy(desc(executionAttempts.attemptAt))
    .limit(limit);
}

/** Attempts genuinely waiting on the owner's own browser wallet right now. */
export async function listPendingSignatures(db: Db): Promise<ExecutionAttempt[]> {
  return db
    .select()
    .from(executionAttempts)
    .where(eq(executionAttempts.status, "awaiting_signature"))
    .orderBy(desc(executionAttempts.attemptAt));
}

/**
 * Records what the owner's browser wallet reported after they approved and
 * it broadcast — this function never signs or broadcasts anything itself,
 * it only writes down a result the wallet already produced. Only a row
 * still in `awaiting_signature` can transition, so a stale/duplicate report
 * can't silently overwrite a later, more current attempt.
 */
export async function markExecutionAttemptBroadcast(
  db: Db,
  attemptId: string,
  txHash: string,
): Promise<ExecutionAttempt | undefined> {
  const updated = await db
    .update(executionAttempts)
    .set({ status: "broadcast", txHash })
    .where(
      and(eq(executionAttempts.id, attemptId), eq(executionAttempts.status, "awaiting_signature")),
    )
    .returning();
  return updated[0];
}
