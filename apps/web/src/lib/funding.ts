/**
 * Server-only arm-time funding gate (2026-09-02). Before a managed-wallet
 * plan is armed, read the wallet's live native balance (and ERC-20 balance
 * on a token-priced stage) and refuse to arm when it cannot pay
 * price × qty + OpenSea fee + gas reserve. This is an operator action, not a
 * page render, so one RPC round-trip here is allowed (anti-pattern #3 is
 * about feed requests); the result is also persisted as the wallet's
 * balance snapshot so the admin column updates immediately.
 */
import type { AppConfig } from "@hoodmint/config";
import {
  assessMintFunding,
  type FundingVerdict,
  isNativeCurrency,
  mintSpendCeilingWei,
  rankRpcEndpoints,
} from "@hoodmint/core";
import {
  type Db,
  listRpcEndpoints,
  recordWalletBalance,
  wallets as walletsTable,
} from "@hoodmint/db";
import { fetchErc20Funding, fetchFeeContext, fetchNativeBalance } from "@hoodmint/providers";
import { eq, sql } from "drizzle-orm";

/**
 * Three outcomes, never two: the check RAN and passed (`ok`, `checked`), the
 * check RAN and failed (`!ok`), or the check DID NOT RUN (`ok` but
 * `!checked` — no RPC, unreadable ERC-20, browser-signed wallet). The caller
 * must never render "not checked" as "checked and fine": arming is still
 * allowed, but the operator has to see that nothing was verified.
 */
export type ArmFundingResult =
  | { readonly ok: true; readonly checked: true }
  | { readonly ok: true; readonly checked: false; readonly notCheckedReason: string }
  | { readonly ok: false; readonly checked: true; readonly message: string };

/** Same precedence as the worker's resolveBestRpcUrl: ranked registry
 *  endpoint that is not known-down, else the env RPC_URL. */
async function resolveRpcUrl(db: Db, config: AppConfig): Promise<string | undefined> {
  const endpoints = await listRpcEndpoints(db, config.ROBINHOOD_CHAIN_ID).catch(() => []);
  const best = rankRpcEndpoints(endpoints, config.ROBINHOOD_CHAIN_ID).find(
    (e) => e.healthStatus !== "down",
  );
  return best?.httpUrl ?? config.RPC_URL;
}

/**
 * Funding verdict for one plan about to be armed. Fails CLOSED only on a
 * proven shortfall; an RPC that cannot be reached still yields `ok` (the
 * operator may knowingly arm, and the presign pass re-checks 45s before
 * fire) but reports `checked: false` so the arm result can say the balance
 * was never read instead of implying it was read and was fine.
 */
export async function checkArmFunding(
  db: Db,
  config: AppConfig,
  plan: { walletId: string; quantity: number; perPlanCeilingWei: string },
  stage: { priceWei: string | null; currency: string | null } | undefined,
): Promise<ArmFundingResult & { readonly verdict?: FundingVerdict }> {
  const [wallet] = await db
    .select({
      address: walletsTable.address,
      // A boolean, never the sealed blob: this runs in the internet-facing
      // web process, which has no business holding wallet ciphertext in
      // request memory just to null-test it.
      hasKey: sql<boolean>`${walletsTable.encryptedSigningKey} is not null`,
    })
    .from(walletsTable)
    .where(eq(walletsTable.id, plan.walletId))
    .limit(1);
  if (wallet === undefined) {
    return { ok: true, checked: false, notCheckedReason: "wallet row not found" };
  }
  if (!wallet.hasKey) {
    // Browser-wallet plans are signed by a human who sees their own balance.
    return {
      ok: true,
      checked: false,
      notCheckedReason: "browser-signed wallet — balance not read server-side",
    };
  }
  const rpcUrl = await resolveRpcUrl(db, config);
  if (rpcUrl === undefined) {
    return { ok: true, checked: false, notCheckedReason: "no RPC endpoint configured" };
  }
  const quantity = Math.max(1, Math.floor(plan.quantity));
  const nativePriced = stage === undefined || isNativeCurrency(stage.currency);
  // Native value the mint will send: stage price × qty + OpenSea's SeaDrop
  // fee allowance (a "free" mint still pays ~0.00008 ETH per token). With no
  // stage (fire_at-only plan) the per-plan ceiling is the only bound known.
  const valueWei =
    stage === undefined
      ? BigInt(plan.perPlanCeilingWei)
      : BigInt(mintSpendCeilingWei(nativePriced ? stage.priceWei : null, quantity));
  try {
    const [nativeBalanceWei, fees] = await Promise.all([
      fetchNativeBalance(rpcUrl, wallet.address),
      fetchFeeContext(rpcUrl, wallet.address),
    ]);
    await recordWalletBalance(db, plan.walletId, nativeBalanceWei).catch(() => undefined);
    let erc20Unreadable = false;
    const erc20 =
      !nativePriced &&
      stage?.currency !== null &&
      stage?.currency !== undefined &&
      stage.priceWei !== null &&
      /^[0-9]+$/.test(stage.priceWei)
        ? await fetchErc20Funding(rpcUrl, stage.currency, wallet.address).then(
            (f) => ({
              balance: f.balance,
              required: BigInt(stage.priceWei as string) * BigInt(quantity),
              symbol: f.symbol,
              decimals: f.decimals,
            }),
            () => {
              // The stage is priced in a token and we could not read that
              // token's balance: the native verdict alone proves nothing
              // about whether this mint can be paid for.
              erc20Unreadable = true;
              return undefined;
            },
          )
        : undefined;
    const verdict = assessMintFunding({
      nativeBalanceWei,
      valueWei,
      gasLimit: BigInt(config.MINT_PRESIGN_GAS_LIMIT),
      maxFeePerGasWei: BigInt(fees.maxFeePerGasWei),
      ...(erc20 !== undefined ? { erc20 } : {}),
    });
    if (verdict.ok) {
      return erc20Unreadable
        ? {
            ok: true,
            checked: false,
            notCheckedReason: "ERC-20 balance unreadable on a token-priced phase",
            verdict,
          }
        : { ok: true, checked: true, verdict };
    }
    return { ok: false, checked: true, message: `Not armed — ${verdict.message}.`, verdict };
  } catch {
    // RPC unreachable: do not block the operator on a read failure; the
    // worker's presign gate re-checks with a fresh read before the open.
    // But the caller MUST surface that nothing was verified.
    return { ok: true, checked: false, notCheckedReason: "RPC unreachable" };
  }
}
