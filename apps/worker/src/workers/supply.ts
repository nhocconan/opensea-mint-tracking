/**
 * On-chain supply sweep: reads ERC-721 `totalSupply()` / `maxSupply()` for
 * every LIVE/NEXT drop with a contract and records a VERIFIED snapshot, so
 * `recomputeLifecycles` can flip sold-out drops to SOLD_OUT.
 *
 * Why: OpenSea keeps a drop "live" (and its later phases scheduled) after the
 * supply is gone. Seen live 2026-08-28: crypto2punk2robinhood at 5000/5000
 * under /live, and Goat Street's "WL FCFS" phase armed while the Treasury +
 * GTD phases had already taken every token — OpenSea's mint endpoint just
 * answered "Drop is fully minted out" at the open instant. The chain is the
 * only source that cannot lie about this.
 *
 * Cheap: two `eth_call`s per project over a few concurrent lanes. Contracts that expose no `maxSupply()` get an
 * unverified minted-only snapshot (never SOLD_OUT from a guess).
 */
import { recomputeLifecycles, recordChainSupply, supplySweepTargets } from "@hoodmint/db";
import { createPublicClient, http, parseAbi } from "viem";
import type { WorkerContext } from "../context.ts";
import { resolveBestRpcUrl } from "./rpc-health.ts";

const SUPPLY_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
]);

const MAX_PROJECTS_PER_PASS = 300;

export interface SupplySweepSummary {
  readonly scanned: number;
  readonly recorded: number;
  readonly soldOut: number;
  readonly relabelled: number;
}

export async function runSupplySweep(ctx: WorkerContext): Promise<SupplySweepSummary> {
  const { db, config, log } = ctx;
  const rpcUrl = await resolveBestRpcUrl(db, config.ROBINHOOD_CHAIN_ID, config.RPC_URL);
  if (rpcUrl === undefined) {
    log.warn("supply sweep skipped: no RPC endpoint available");
    return { scanned: 0, recorded: 0, soldOut: 0, relabelled: 0 };
  }
  const targets = await supplySweepTargets(db, MAX_PROJECTS_PER_PASS);
  if (targets.length === 0) {
    return { scanned: 0, recorded: 0, soldOut: 0, relabelled: 0 };
  }
  const client = createPublicClient({
    // No JSON-RPC batching: the public Robinhood RPC answers multi-item
    // batches with an opaque error under load (every read failed on the
    // first pass); a few plain lanes are fast enough.
    transport: http(rpcUrl, { timeout: 15_000 }),
  });
  const blockNumber = await client.getBlockNumber().catch(() => null);
  const now = new Date();
  let recorded = 0;
  let soldOut = 0;
  let failed = 0;
  let sampleError: string | null = null;

  const readOne = async (target: (typeof targets)[number]): Promise<void> => {
    const address = target.contractAddress as `0x${string}`;
    try {
      const minted = await client.readContract({
        address,
        abi: SUPPLY_ABI,
        functionName: "totalSupply",
      });
      // Contracts without maxSupply() (or with a revert) → unverified,
      // minted-only snapshot; SOLD_OUT is never inferred from a guess.
      const maxSupply = await client
        .readContract({ address, abi: SUPPLY_ABI, functionName: "maxSupply" })
        .catch(() => null);
      await recordChainSupply(db, target.id, { minted, maxSupply, blockNumber }, now);
      recorded += 1;
      if (maxSupply !== null && maxSupply > 0n && minted >= maxSupply) {
        soldOut += 1;
        log.info(
          { slug: target.slug, minted: minted.toString(), maxSupply: maxSupply.toString() },
          "supply sweep: drop is sold out on-chain",
        );
      }
    } catch (error) {
      failed += 1;
      sampleError ??=
        error instanceof Error ? (error.message.split("\n")[0]?.slice(0, 160) ?? "") : "";
    }
  };
  // Bounded concurrency: a public RPC rate-limits a 300-way burst (the
  // first pass lost most reads that way); a handful of lanes keeps the
  // whole sweep under ~10s without tripping it.
  const lanes = 6;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (cursor < targets.length) {
        const target = targets[cursor];
        cursor += 1;
        if (target !== undefined) {
          await readOne(target);
        }
      }
    }),
  );
  const relabelled = await recomputeLifecycles(db);
  log.info(
    { scanned: targets.length, recorded, failed, soldOut, relabelled, sampleError },
    "supply sweep complete",
  );
  return { scanned: targets.length, recorded, soldOut, relabelled };
}
