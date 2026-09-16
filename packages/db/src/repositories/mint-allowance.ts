/**
 * Per-wallet REMAINING mint allowance on a drop (2026-09-15).
 *
 * `drop_stages.max_per_wallet` is a CUMULATIVE cap across the whole SeaDrop
 * drop, not a per-phase allowance: ERC721SeaDrop checks
 * `minterNumMinted(minter) + quantity > maxTotalMintableByWallet` against the
 * wallet's total mints on the contract, so a wallet that already took 1 token
 * on a GTD phase has 1 — not 2 — left on a later "max 2" FCFS phase. Sizing a
 * plan against the raw cap therefore builds a transaction the contract
 * reverts.
 *
 * Ground truth used here, in order:
 *  1. `mint_events` — ABI-decoded transfer/mint logs written by the chain
 *     worker (`insertMintEvents`), summed per recipient for this project.
 *     This is the only source that also sees mints made OUTSIDE this tool
 *     (the OpenSea UI, another bot).
 *  2. `mint_plans` already broadcast for the same project+wallet
 *     (`executed` / `executing`). This exists purely to cover the window
 *     where (1) lags: the chain worker indexes on its own cadence, so a mint
 *     fired 30 seconds ago by this very console may not be in `mint_events`
 *     yet. A reverted broadcast is released back to `armed` by the worker's
 *     receipt check, so it does not linger here.
 *
 * The two describe the SAME mints, so the estimate is `max(...)`, never a
 * sum — and the caller keeps both numbers so the UI can say which part is
 * confirmed on-chain and which is only "broadcast, not yet indexed".
 *
 * This module is read-only apart from `setDraftMintPlanQuantity`, the
 * draft-only clamp the arm path applies before a plan is armed.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { eligibilityChecks, mintEvents, mintPlans, wallets } from "../schema.ts";

export interface WalletDropMintTotals {
  readonly walletId: string;
  readonly address: string;
  /** Summed `mint_events.quantity` for this project + wallet (indexer truth). */
  readonly confirmedQuantity: number;
  /** Summed quantity of this project's already-broadcast plans for the wallet. */
  readonly broadcastQuantity: number;
  /** `max(confirmed, broadcast)` — the count to charge against the cap. */
  readonly alreadyMinted: number;
}

/**
 * One round-trip for the WHOLE batch: every managed wallet's already-minted
 * total on one project, keyed by wallet id. The arm path memoises this per
 * project so a 50-plan batch stays a single query.
 */
export async function walletMintTotalsForProject(
  db: Db,
  projectId: string,
): Promise<Map<string, WalletDropMintTotals>> {
  // Addresses are stored lowercase-canonical (schema.ts header) and
  // `insertMintEvents` lowercases `recipient`; `lower()` here is belt and
  // braces against a hand-inserted wallet row, not a correctness crutch.
  const onchain = db
    .select({
      recipient: mintEvents.recipient,
      quantity: sql<number>`sum(${mintEvents.quantity})::int`.as("confirmed_quantity"),
    })
    .from(mintEvents)
    .where(eq(mintEvents.projectId, projectId))
    .groupBy(mintEvents.recipient)
    .as("onchain");

  const broadcast = db
    .select({
      walletId: mintPlans.walletId,
      quantity: sql<number>`sum(${mintPlans.quantity})::int`.as("broadcast_quantity"),
    })
    .from(mintPlans)
    .where(
      and(eq(mintPlans.projectId, projectId), inArray(mintPlans.status, ["executed", "executing"])),
    )
    .groupBy(mintPlans.walletId)
    .as("broadcast");

  const rows = await db
    .select({
      walletId: wallets.id,
      address: wallets.address,
      confirmedQuantity: sql<number>`coalesce(${onchain.quantity}, 0)::int`,
      broadcastQuantity: sql<number>`coalesce(${broadcast.quantity}, 0)::int`,
    })
    .from(wallets)
    .leftJoin(onchain, sql`${onchain.recipient} = lower(${wallets.address})`)
    .leftJoin(broadcast, eq(broadcast.walletId, wallets.id));

  return new Map(
    rows.map((row) => [
      row.walletId,
      {
        walletId: row.walletId,
        address: row.address,
        confirmedQuantity: row.confirmedQuantity,
        broadcastQuantity: row.broadcastQuantity,
        alreadyMinted: Math.max(row.confirmedQuantity, row.broadcastQuantity),
      },
    ]),
  );
}

/**
 * Clamp a DRAFT plan's quantity down to the wallet's remaining allowance.
 *
 * Draft-only by WHERE clause: an armed/executing plan is being read by the
 * worker's claim path and its quantity must never move under it. Returns the
 * stored quantity, or undefined when the row was no longer a draft.
 */
export async function setDraftMintPlanQuantity(
  db: Db,
  planId: string,
  quantity: number,
): Promise<number | undefined> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    return undefined;
  }
  const updated = await db
    .update(mintPlans)
    .set({ quantity, updatedAt: new Date() })
    .where(and(eq(mintPlans.id, planId), eq(mintPlans.status, "draft")))
    .returning({ quantity: mintPlans.quantity });
  return updated[0]?.quantity;
}

/**
 * The per-wallet cap the CONTRACT actually enforces, per stage.
 *
 * `drop_stages.max_per_wallet` comes from the `/drops` feed's
 * `max_per_wallet`, which on Robinhood Chain returns 1 for every stage of
 * every drop (423 rows on 2026-09-15) and is NOT the SeaDrop cap. The number
 * SeaDrop checks — `minterNumMinted + qty > maxTotalMintableByWallet` — is
 * OpenSea's `max_total_mintable_by_wallet`, which arrives on the eligibility
 * endpoint and is stored as `eligibility_checks.max_mintable`.
 *
 * Reading the wrong one made the console refuse a mint the operator was
 * entitled to: hoodminers FCFS is cap 2, the wallet had minted 1, and the
 * clamp computed 1 − 1 = 0 and blocked the plan outright.
 *
 * Per wallet on purpose — eligibility is answered per wallet, and a cap can
 * legitimately differ between them.
 */
export async function stageWalletCaps(db: Db, stageId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ walletId: eligibilityChecks.walletId, cap: eligibilityChecks.maxMintable })
    .from(eligibilityChecks)
    .where(eq(eligibilityChecks.stageId, stageId));
  const out = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.cap === "number" && row.cap > 0) {
      out.set(row.walletId, row.cap);
    }
  }
  return out;
}

/**
 * Authoritative per-stage cap for a whole project, for display.
 *
 * Same source and same reason as `stageWalletCaps`: OpenSea's
 * max_total_mintable_by_wallet, not the /drops feed's max_per_wallet. Takes
 * the max across wallets because the phase chip describes the PHASE; the
 * per-wallet remainder is computed separately.
 */
export async function stageCapsForProject(
  db: Db,
  projectId: string,
): Promise<{ stageId: string; cap: number }[]> {
  const rows = await db
    .select({ stageId: eligibilityChecks.stageId, cap: eligibilityChecks.maxMintable })
    .from(eligibilityChecks)
    .where(eq(eligibilityChecks.projectId, projectId));
  const best = new Map<string, number>();
  for (const row of rows) {
    if (row.stageId === null || typeof row.cap !== "number" || row.cap <= 0) {
      continue;
    }
    if (row.cap > (best.get(row.stageId) ?? 0)) {
      best.set(row.stageId, row.cap);
    }
  }
  return [...best].map(([stageId, cap]) => ({ stageId, cap }));
}
