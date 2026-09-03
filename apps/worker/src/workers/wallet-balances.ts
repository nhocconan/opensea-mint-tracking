/**
 * Managed-wallet funding snapshot (2026-09-02). Once a minute, read the
 * native balance of every enabled managed wallet and persist it on the
 * wallet row, so Admin → Wallets / Special mints can show "can this wallet
 * pay?" as a snapshot read (anti-pattern #3: page renders never call
 * providers). The arm action and the presign pass do their own fresh read
 * — this is the always-on operator view, not the gate.
 */
import { managedWalletAddresses, recordWalletBalance } from "@hoodmint/db";
import { fetchNativeBalances } from "@hoodmint/providers";
import type { WorkerContext } from "../context.ts";
import { resolveBestRpcUrl } from "./rpc-health.ts";

export interface WalletBalanceSummary {
  readonly wallets: number;
  readonly updated: number;
  readonly failed: number;
}

export async function refreshWalletBalances(ctx: WorkerContext): Promise<WalletBalanceSummary> {
  const { db, config, log } = ctx;
  const wallets = await managedWalletAddresses(db);
  if (wallets.length === 0) {
    return { wallets: 0, updated: 0, failed: 0 };
  }
  const rpcUrl = await resolveBestRpcUrl(db, config.ROBINHOOD_CHAIN_ID, config.RPC_URL);
  if (!rpcUrl) {
    log.warn("wallet balance refresh skipped: no RPC configured");
    return { wallets: wallets.length, updated: 0, failed: wallets.length };
  }
  const balances = await fetchNativeBalances(
    rpcUrl,
    wallets.map((w) => w.address),
  );
  const now = new Date();
  let updated = 0;
  let failed = 0;
  for (const wallet of wallets) {
    const balance = balances.get(wallet.address);
    if (balance === null || balance === undefined) {
      failed += 1;
      continue;
    }
    await recordWalletBalance(db, wallet.id, balance, now);
    updated += 1;
  }
  if (failed > 0) {
    log.warn({ failed, total: wallets.length }, "wallet balance refresh: some reads failed");
  }
  return { wallets: wallets.length, updated, failed };
}
