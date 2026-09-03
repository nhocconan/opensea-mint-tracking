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
import { eq } from "drizzle-orm";

export type ArmFundingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

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
 * proven shortfall; an RPC that cannot be reached yields `ok` with the
 * reason logged by the caller (the presign pass re-checks 45s before fire).
 */
export async function checkArmFunding(
  db: Db,
  config: AppConfig,
  plan: { walletId: string; quantity: number; perPlanCeilingWei: string },
  stage: { priceWei: string | null; currency: string | null } | undefined,
): Promise<ArmFundingResult & { readonly verdict?: FundingVerdict }> {
  const [wallet] = await db
    .select({ address: walletsTable.address, hasKey: walletsTable.encryptedSigningKey })
    .from(walletsTable)
    .where(eq(walletsTable.id, plan.walletId))
    .limit(1);
  if (wallet === undefined || wallet.hasKey === null) {
    // Browser-wallet plans are signed by a human who sees their own balance.
    return { ok: true };
  }
  const rpcUrl = await resolveRpcUrl(db, config);
  if (rpcUrl === undefined) {
    return { ok: true };
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
            () => undefined,
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
      return { ok: true, verdict };
    }
    return { ok: false, message: `Not armed — ${verdict.message}.`, verdict };
  } catch {
    // RPC unreachable: do not block the operator on a read failure; the
    // worker's presign gate re-checks with a fresh read before the open.
    return { ok: true };
  }
}
