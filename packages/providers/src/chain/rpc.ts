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
import {
  createPublicClient,
  decodeAbiParameters,
  http,
  type Log,
  numberToHex,
  type PublicClient,
  type RpcLog,
} from "viem";
import { formatLog } from "viem/utils";
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

/**
 * True when an eth_getLogs failure means "narrow the block window and retry".
 * viem hides the raw RPC reason (e.g. Robinhood's "logs matched by query
 * exceeds limit of 10000") in `details`, leaving a generic "Missing or
 * invalid parameters." message — so both fields are matched.
 */
export function isOversizedLogsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const details =
    error !== null && typeof error === "object" && "details" in error
      ? String((error as { details?: unknown }).details ?? "")
      : "";
  // "exceed" covers "limit exceeded", "exceeds limit of 10000" (Robinhood
  // RPC) and "HTTP response body exceeded the size limit" (viem's own 10MB
  // transport cap on oversized log pages). Timeouts count too: a getLogs
  // window that can't answer inside the transport timeout is best treated
  // as too big — shrinking is the adaptive response that makes progress.
  return /block range|too large|exceed|more than|invalid parameters|took too long|timed? ?out/i.test(
    `${message}\n${details}`,
  );
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
      // 30s timeout: the Robinhood RPC needs 2-4s per 1000-block getLogs
      // window, so a grown 5000-20000-block window legitimately exceeds
      // viem's 10s default and was surfacing as "RPC Request failed".
      transport: http(options.rpcUrl, { retryCount: 2, timeout: 30_000 }),
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

    // Bound each pass so catch-up after downtime advances the checkpoint
    // incrementally instead of demanding one atomic checkpoint→head sweep —
    // where any transient RPC failure discarded the entire pass and the
    // checkpoint never moved. 1000 blocks ≈ up to ~80k matched logs on
    // this chain (~80 mint-transfers/block), i.e. roughly a minute of
    // decode+insert per pass — small enough to keep memory and pass
    // duration bounded, large enough to out-pace ~6 blocks/s head growth.
    // The lag metric still measures against the true head; the next tick
    // resumes from the saved checkpoint.
    const maxSpan = BigInt(Math.min(this.maxRange, 1000));
    const to = head - from + 1n > maxSpan ? from + maxSpan - 1n : head;
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

    // Iterative pager: decode each window's logs immediately and keep only
    // the (much smaller) MintEventInsert rows. The previous recursive
    // implementation accumulated every raw Log for the whole span before
    // decoding — on a dense catch-up that is hundreds of MB and OOM-killed
    // the 512M worker container.
    const events: MintEventInsert[] = [];
    let cursor = from;
    while (cursor <= to) {
      const { logs, windowTo } = await this.fetchLogsWindow(cursor, to);
      for (const log of logs) {
        const event = this.decodeMintLog(log, now);
        if (event !== null) {
          events.push(event);
        }
      }
      cursor = windowTo + 1n;
    }

    return {
      fromBlock: from,
      toBlock: to,
      events,
      reorgDetected,
      rangeUsed: Number(to - from) + 1,
      lag: head - from,
    };
  }

  /**
   * Fetch one adaptively-sized window of logs starting at `from` (never
   * past `to`) and report the window bound actually used, so the caller's
   * pager can advance its cursor. Oversize shrinks get their own budget,
   * separate from transient failures: a dense block region can
   * legitimately need several shrinks (5000 → 1250 → 312 → 78 → 19 → 10)
   * before a window fits under both the RPC's matched-log cap and viem's
   * 10MB response-body cap, and burning the transient-retry budget on
   * those made catch-up through busy regions impossible. HARD_FLOOR
   * deliberately undercuts the configured minRange — minRange bounds the
   * *adaptive* sizing on success; a region so dense that even minRange
   * overflows must still be traversable rather than wedging the
   * checkpoint forever.
   */
  private async fetchLogsWindow(
    from: bigint,
    to: bigint,
  ): Promise<{ logs: Log[]; windowTo: bigint }> {
    const HARD_FLOOR = 10;
    let transientFailures = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const windowTo = from + BigInt(this.range) - 1n > to ? to : from + BigInt(this.range) - 1n;
      try {
        // Raw eth_getLogs via client.request: viem's typed getLogs() does
        // NOT accept a raw `topics` param — the earlier `as`-cast call
        // silently dropped the filter and fetched EVERY log on the chain,
        // which is what actually blew the RPC's matched-log cap and viem's
        // 10MB body cap at even tiny windows (found live 2026-08-27; this
        // chain runs ~80 mint-transfer logs per block WITH the filter).
        const rawLogs = (await this.client.request({
          method: "eth_getLogs",
          params: [
            {
              fromBlock: numberToHex(from),
              toBlock: numberToHex(windowTo),
              topics: [Array.from(MINT_TOPICS)],
            },
          ],
        })) as RpcLog[];
        const logs = rawLogs.map((raw) => formatLog(raw));
        // Adaptive sizing: heavy pages shrink the range; light ones grow it.
        if (logs.length > 4000 && this.range > this.minRange) {
          this.range = Math.max(this.minRange, Math.floor(this.range / 2));
        } else if (logs.length < 500 && this.range < this.maxRange) {
          this.range = Math.min(this.maxRange, this.range * 2);
        }
        return { logs, windowTo };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isOversizedLogsError(error) && this.range > HARD_FLOOR) {
          this.range = Math.max(HARD_FLOOR, Math.floor(this.range / 4));
          continue;
        }
        transientFailures += 1;
        if (transientFailures >= 4) {
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
