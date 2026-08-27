/**
 * Robinhood Chain on-chain radar (PRD §7.1):
 * - HTTP RPC is the source of truth; WebSocket (when configured) only hints.
 * - Durable checkpoint with block hash; a hash mismatch at the checkpoint
 *   means a reorg — events in the safety window are unfinalized and replayed.
 * - Adaptive eth_getLogs ranges grow/shrink by response size and errors.
 * - Mint transfers decoded from ERC-721/1155 and SeaDrop activity; rolling
 *   windows feed aggregates, never total supply.
 */
import { createHash } from "node:crypto";
import { AppError } from "@hoodmint/core";
import type { MintEventInsert } from "@hoodmint/db";
import { createPublicClient, decodeAbiParameters, http, type Log, type PublicClient } from "viem";
import {
  ERC721_TRANSFER_TOPIC,
  ERC1155_TRANSFER_BATCH_TOPIC,
  ERC1155_TRANSFER_SINGLE_TOPIC,
  isMintTransfer,
  MINT_TOPICS,
} from "./seadrop.ts";

export interface ChainRadarOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly initialRange?: number;
  readonly maxRange?: number;
  readonly minRange?: number;
  readonly reorgSafetyBlocks?: number;
}

export interface SyncResult {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly events: MintEventInsert[];
  readonly reorgDetected: boolean;
  readonly rangeUsed: number;
  readonly lag: bigint;
}

export interface CheckpointState {
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

export class ChainRadar {
  private readonly client: PublicClient;
  private readonly chainId: number;
  private range: number;
  private readonly maxRange: number;
  private readonly minRange: number;
  private readonly reorgSafetyBlocks: number;

  constructor(options: ChainRadarOptions) {
    this.client = createPublicClient({
      transport: http(options.rpcUrl, { retryCount: 2 }),
      batch: { multicall: false },
    });
    this.chainId = options.chainId;
    this.range = options.initialRange ?? 5000;
    this.maxRange = options.maxRange ?? 20_000;
    this.minRange = options.minRange ?? 100;
    this.reorgSafetyBlocks = options.reorgSafetyBlocks ?? 12;
  }

  async headBlockNumber(): Promise<bigint> {
    const block = await this.client.getBlockNumber();
    return block;
  }

  async blockHash(number: bigint): Promise<string> {
    const block = await this.client.getBlock({ blockNumber: number });
    if (block === null) {
      throw new AppError("RetryableProvider", `block ${number} not available`);
    }
    return block.hash;
  }

  /**
   * Sync one window from the checkpoint. Reorg check first: if the stored
   * checkpoint hash no longer matches the chain, rewind to the safety window
   * and replay (returned events re-insert idempotently upstream).
   */
  async syncFromCheckpoint(
    checkpoint: CheckpointState | undefined,
    now: Date,
  ): Promise<SyncResult> {
    const head = await this.headBlockNumber();
    let reorgDetected = false;
    let from: bigint;

    if (checkpoint === undefined || checkpoint.blockNumber === 0n) {
      from = head > BigInt(this.range) ? head - BigInt(this.range) + 1n : 1n;
    } else {
      const currentHash = await this.blockHash(checkpoint.blockNumber);
      if (currentHash.toLowerCase() !== checkpoint.blockHash.toLowerCase()) {
        reorgDetected = true;
        from =
          checkpoint.blockNumber > BigInt(this.reorgSafetyBlocks)
            ? checkpoint.blockNumber - BigInt(this.reorgSafetyBlocks) + 1n
            : 1n;
      } else {
        from = checkpoint.blockNumber + 1n;
      }
    }

    const to = head;
    if (to < from) {
      return {
        fromBlock: from,
        toBlock: to,
        events: [],
        reorgDetected,
        rangeUsed: 0,
        lag: 0n,
      };
    }

    const logs = await this.fetchLogsAdaptive(from, to);
    const events = logs
      .map((log) => this.decodeMintLog(log, now))
      .filter((event): event is MintEventInsert => event !== null);

    return {
      fromBlock: from,
      toBlock: to,
      events,
      reorgDetected,
      rangeUsed: Number(to - from) + 1,
      lag: head - from,
    };
  }

  private async fetchLogsAdaptive(from: bigint, to: bigint): Promise<Log[]> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const windowTo = from + BigInt(this.range) - 1n > to ? to : from + BigInt(this.range) - 1n;
      try {
        const logs = await this.client.getLogs({
          fromBlock: from,
          toBlock: windowTo,
          topics: [Array.from(MINT_TOPICS)],
        } as Parameters<typeof this.client.getLogs>[0]);
        // Adaptive sizing: heavy pages shrink the range; light ones grow it.
        if (logs.length > 4000 && this.range > this.minRange) {
          this.range = Math.max(this.minRange, Math.floor(this.range / 2));
        } else if (logs.length < 500 && this.range < this.maxRange) {
          this.range = Math.min(this.maxRange, this.range * 2);
        }
        if (windowTo >= to) {
          return logs;
        }
        const rest = await this.fetchLogsAdaptive(windowTo + 1n, to);
        return [...logs, ...rest];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/block range|too large|limit exceeded/i.test(message) && this.range > this.minRange) {
          this.range = Math.max(this.minRange, Math.floor(this.range / 4));
          continue;
        }
        if (attempt >= 3) {
          throw new AppError("RetryableProvider", `eth_getLogs failed: ${message.slice(0, 120)}`);
        }
      }
    }
    throw new AppError("RetryableProvider", "eth_getLogs exhausted adaptive attempts");
  }

  /** Decode a mint log; non-mint transfers and junk return null. */
  decodeMintLog(log: Log, now: Date): MintEventInsert | null {
    const topics = log.topics ?? [];
    const topic0 = topics[0]?.toLowerCase();
    try {
      // Topics are ABI-encoded 32-byte words; an address is the low 20 bytes.
      const addressFromTopic = (topic: `0x${string}`): string => `0x${topic.slice(-40)}`;
      const fromTopic = topics[2];
      const toTopic = topics[3];
      let quantity: number | null = null;

      if (topic0 === ERC721_TRANSFER_TOPIC) {
        if (topics[1] === undefined || topics[2] === undefined) {
          return null;
        }
        if (!isMintTransfer(addressFromTopic(topics[1]))) {
          return null;
        }
        quantity = 1;
      } else if (topic0 === ERC1155_TRANSFER_SINGLE_TOPIC) {
        // topics: [sig, operator, from, to]; data: (id, value)
        if (fromTopic === undefined || toTopic === undefined) {
          return null;
        }
        if (!isMintTransfer(addressFromTopic(fromTopic))) {
          return null;
        }
        const [, value] = decodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }],
          log.data,
        ) as [bigint, bigint];
        quantity = Number(value > 1_000_000n ? 1_000_000n : value);
      } else if (topic0 === ERC1155_TRANSFER_BATCH_TOPIC) {
        if (fromTopic === undefined || toTopic === undefined) {
          return null;
        }
        if (!isMintTransfer(addressFromTopic(fromTopic))) {
          return null;
        }
        const [, values] = decodeAbiParameters(
          [{ type: "uint256[]" }, { type: "uint256[]" }],
          log.data,
        ) as [readonly bigint[], readonly bigint[]];
        const total = values.reduce((acc, v) => acc + v, 0n);
        quantity = Number(total > 1_000_000n ? 1_000_000n : total);
      } else {
        return null;
      }

      if (
        log.transactionHash === null ||
        log.blockNumber === null ||
        log.blockHash === null ||
        quantity === null
      ) {
        return null;
      }
      const recipient =
        topic0 === ERC721_TRANSFER_TOPIC
          ? addressFromTopic(topics[2] as `0x${string}`)
          : addressFromTopic(toTopic as `0x${string}`);
      return {
        chainId: this.chainId,
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex ?? 0),
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        contractAddress: log.address,
        recipient,
        quantity,
        finalized: false,
        observedAt: now,
      };
    } catch {
      return null;
    }
  }
}

/** Deterministic event id for idempotency keys and evidence hashes. */
export function mintEventKey(chainId: number, txHash: string, logIndex: number): string {
  return createHash("sha256")
    .update(`${chainId}:${txHash.toLowerCase()}:${logIndex}`)
    .digest("hex")
    .slice(0, 16);
}
