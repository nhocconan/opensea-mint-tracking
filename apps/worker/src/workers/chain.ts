/**
 * On-chain radar loop (PRD §7.1): checkpointed eth_getLogs sync with reorg
 * replay, mint-event dedupe, aggregate maintenance, and SSE invalidation.
 * HTTP RPC is the source of truth; a future WS hint path only enqueues
 * reconciliation.
 */
import { finalityDepthFor } from "@hoodmint/core";
import {
  distinctEnabledRpcChainIds,
  ensureProvider,
  getCheckpoint,
  insertMintEvents,
  markEventsFinalized,
  markProviderHealth,
  type ProviderKind,
  projectIdsForContracts,
  publishEvent,
  refreshAggregates,
  refreshHolderSnapshot,
  saveCheckpoint,
  unfinalizeFromBlock,
} from "@hoodmint/db";
import { metrics } from "@hoodmint/observability";
import { ChainRadar } from "@hoodmint/providers";
import type { WorkerContext } from "../context.ts";
import { resolveBestRpcUrl } from "./rpc-health.ts";

export interface ChainSyncSummary {
  synced: boolean;
  fromBlock: string | null;
  toBlock: string | null;
  events: number;
  reorg: boolean;
}

/**
 * Multi-network on-chain sync: syncs every chain that has ≥1 enabled RPC
 * endpoint in the registry, unioned with the default Robinhood chain (so
 * the legacy single-RPC_URL path always works even with an empty registry).
 * Each chain has its own checkpoint (keyed by chainId+provider) and its own
 * finality window from the chain registry — a slow/dead chain can't block
 * the others (each is caught independently). Returns the aggregate.
 */
export async function runChainSync(ctx: WorkerContext): Promise<ChainSyncSummary> {
  const { db, config } = ctx;
  const registryChains = await distinctEnabledRpcChainIds(db);
  const chainIds = [...new Set([config.ROBINHOOD_CHAIN_ID, ...registryChains])];

  let anySynced = false;
  let totalEvents = 0;
  let anyReorg = false;
  let lastFrom: string | null = null;
  let lastTo: string | null = null;

  for (const chainId of chainIds) {
    const summary = await syncChain(ctx, chainId);
    anySynced = anySynced || summary.synced;
    totalEvents += summary.events;
    anyReorg = anyReorg || summary.reorg;
    if (summary.toBlock !== null) {
      lastFrom = summary.fromBlock;
      lastTo = summary.toBlock;
    }
  }

  return {
    synced: anySynced,
    fromBlock: lastFrom,
    toBlock: lastTo,
    events: totalEvents,
    reorg: anyReorg,
  };
}

/** Sync one chain from its checkpoint. Extracted so runChainSync can fan
 *  out over the registry; all per-chain facts (finality window, provider
 *  record, env RPC fallback applicability) are derived from chainId here. */
export async function syncChain(ctx: WorkerContext, chainId: number): Promise<ChainSyncSummary> {
  const { db, config, log } = ctx;
  const empty: ChainSyncSummary = {
    synced: false,
    fromBlock: null,
    toBlock: null,
    events: 0,
    reorg: false,
  };
  // The env RPC_URL is the fallback only for the default chain; other chains
  // must come from the registry (no single global RPC serves every chain).
  const envFallback = chainId === config.ROBINHOOD_CHAIN_ID ? config.RPC_URL : undefined;
  const rpcUrl = await resolveBestRpcUrl(db, chainId, envFallback);
  if (!rpcUrl) {
    return empty;
  }
  // One rpc provider record per chain so checkpoints don't collide.
  const providerKind: ProviderKind =
    chainId === config.ROBINHOOD_CHAIN_ID ? "robinhood_rpc" : `rpc_${chainId}`;
  const provider = await ensureProvider(db, providerKind);
  if (!provider.enabled) {
    return empty;
  }
  const finalityWindow = BigInt(finalityDepthFor(chainId));

  const radar = new ChainRadar({
    rpcUrl,
    chainId,
    initialRange: config.CHAIN_SYNC_INITIAL_RANGE,
  });
  const checkpoint = await getCheckpoint(db, chainId, provider.id);

  try {
    const result = await radar.syncFromCheckpoint(checkpoint, new Date());

    if (result.reorgDetected && checkpoint !== undefined) {
      const rewindFrom =
        checkpoint.blockNumber > finalityWindow ? checkpoint.blockNumber - finalityWindow : 0n;
      const unfinalized = await unfinalizeFromBlock(db, rewindFrom);
      log.warn(
        { chainId, unfinalized, from: result.fromBlock.toString() },
        "chain reorg detected; replaying window",
      );
    }

    const inserted = await insertMintEvents(db, result.events);
    const safeHead = result.toBlock > finalityWindow ? result.toBlock - finalityWindow : 0n;
    const finalized = await markEventsFinalized(db, safeHead);

    const touched = [...new Set(result.events.map((e) => e.contractAddress.toLowerCase()))];
    const projectIds = await projectIdsForContracts(db, touched);
    for (const projectId of projectIds) {
      await refreshAggregates(db, projectId);
      await refreshHolderSnapshot(db, projectId);
    }

    await saveCheckpoint(db, chainId, provider.id, {
      blockNumber: result.toBlock,
      blockHash: await radar.blockHash(result.toBlock),
    });
    await markProviderHealth(db, providerKind, "healthy", { lastSuccessAt: new Date() });
    metrics().set("hoodmint_chain_checkpoint", Number(result.toBlock), { chain: String(chainId) });
    metrics().set("hoodmint_rpc_lag_blocks", Number(result.lag), { chain: String(chainId) });
    await publishEvent(db, { type: "projects.invalidated", at: new Date().toISOString() });

    if (inserted > 0 || finalized > 0) {
      log.info(
        {
          chainId,
          inserted,
          finalized,
          to: result.toBlock.toString(),
          reorg: result.reorgDetected,
        },
        "chain sync window",
      );
    }
    return {
      synced: true,
      fromBlock: result.fromBlock.toString(),
      toBlock: result.toBlock.toString(),
      events: inserted,
      reorg: result.reorgDetected,
    };
  } catch (error) {
    await markProviderHealth(db, providerKind, "down", {
      errorCode: error instanceof Error ? "rpc_error" : "unknown",
    });
    log.error({ err: error, chainId }, "chain sync failed");
    return empty;
  }
}
