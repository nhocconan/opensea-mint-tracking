/**
 * BullMQ queue contracts (PRD §8.4). Job ids are deterministic so retries and
 * duplicate enqueues collapse onto one job; correctness under at-least-once
 * delivery is ultimately guarded by DB unique constraints, not memory.
 */

import { jobId as jobIdFor } from "@hoodmint/core";
import { type ConnectionOptions, type Job, Queue } from "bullmq";

export const QUEUE_NAMES = {
  discovery: "discovery",
  details: "details",
  chainSync: "chain-sync",
  eligibility: "eligibility",
  notifications: "notifications",
  maintenance: "maintenance",
  rarity: "rarity",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const defaultConnection = (url: string): ConnectionOptions => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number.parseInt(parsed.port || "6379", 10),
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(parsed.password ? { password: parsed.password } : {}),
  };
};

const globalForQueues = globalThis as unknown as {
  __hoodmintQueues?: Map<QueueName, Queue>;
};

function getQueue(name: QueueName, url: string): Queue {
  let map = globalForQueues.__hoodmintQueues;
  if (map === undefined) {
    map = new Map();
    globalForQueues.__hoodmintQueues = map;
  }
  const existing = map.get(name);
  if (existing !== undefined) {
    return existing;
  }
  const queue = new Queue(name, {
    connection: defaultConnection(url),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 3600, count: 500 },
      removeOnFail: { age: 86_400 },
    },
  });
  map.set(name, queue);
  return queue;
}

export const DISCOVERY_FEED_TYPES = ["featured", "upcoming", "recently_minted"] as const;

export interface DiscoveryJobData {
  readonly dropType: (typeof DISCOVERY_FEED_TYPES)[number];
  readonly windowStartMs: number;
}

/**
 * One discovery job per feed type, deterministically bucketed to the
 * polling interval (PRD §8.4): `windowStartMs` is floored to `intervalMs`
 * so repeated calls within the same interval collapse onto the same job id
 * via {@link enqueueDiscovery}, while each new interval still gets a fresh
 * run instead of being deduped away forever.
 */
export function scheduledDiscoveryJobs(
  nowMs: number,
  intervalMs: number,
): readonly DiscoveryJobData[] {
  const windowStartMs = Math.floor(nowMs / intervalMs) * intervalMs;
  return DISCOVERY_FEED_TYPES.map((dropType) => ({ dropType, windowStartMs }));
}

export interface DetailJobData {
  readonly slug: string;
  readonly freshnessBucket: "hot" | "warm" | "cold";
}

export interface ChainSyncJobData {
  readonly chainId: number;
  readonly fromBlock: string;
  readonly toBlock: string;
}

export interface EligibilityJobData {
  readonly walletId: string;
  readonly slug: string;
}

export interface NotificationJobData {
  readonly outboxRowId: string;
}

export interface MaintenanceJobData {
  readonly kind:
    | "retention"
    | "credential-refresh"
    | "stale-marking"
    | "quota-log"
    | "instant-key-rotation";
}

export interface RarityJobData {
  readonly projectId: string;
}

export function queues(url: string) {
  return {
    discovery: getQueue(QUEUE_NAMES.discovery, url),
    details: getQueue(QUEUE_NAMES.details, url),
    chainSync: getQueue(QUEUE_NAMES.chainSync, url),
    eligibility: getQueue(QUEUE_NAMES.eligibility, url),
    notifications: getQueue(QUEUE_NAMES.notifications, url),
    maintenance: getQueue(QUEUE_NAMES.maintenance, url),
    rarity: getQueue(QUEUE_NAMES.rarity, url),
  };
}

/** Enqueue helpers with PRD §8.4 deterministic ids. */
export function enqueueDiscovery(
  url: string,
  data: DiscoveryJobData,
): Promise<Job<DiscoveryJobData>> {
  return queues(url).discovery.add("discover", data, {
    jobId: jobIdFor.discovery("opensea", data.dropType, data.windowStartMs),
  });
}

export function enqueueDetail(url: string, data: DetailJobData): Promise<Job<DetailJobData>> {
  return queues(url).details.add("detail", data, {
    jobId: jobIdFor.detail("opensea", data.slug, data.freshnessBucket),
  });
}

export function enqueueChainSync(
  url: string,
  data: ChainSyncJobData,
): Promise<Job<ChainSyncJobData>> {
  return queues(url).chainSync.add("sync", data, {
    jobId: jobIdFor.chainSync(data.chainId, BigInt(data.fromBlock), BigInt(data.toBlock)),
  });
}

export function enqueueEligibility(
  url: string,
  data: EligibilityJobData,
  stageVersion: number,
): Promise<Job<EligibilityJobData>> {
  return queues(url).eligibility.add("check", data, {
    jobId: jobIdFor.eligibility(data.walletId, data.slug, stageVersion),
  });
}

export function enqueueNotification(
  url: string,
  data: NotificationJobData,
): Promise<Job<NotificationJobData>> {
  return queues(url).notifications.add("send", data, {
    jobId: jobIdFor.notification(data.outboxRowId),
    attempts: 8,
  });
}

export function enqueueMaintenance(
  url: string,
  data: MaintenanceJobData,
): Promise<Job<MaintenanceJobData>> {
  return queues(url).maintenance.add("maintain", data, {
    jobId: `maintain.${data.kind}.${Math.floor(Date.now() / 60_000)}`,
  });
}

export function enqueueRarity(url: string, data: RarityJobData): Promise<Job<RarityJobData>> {
  return queues(url).rarity.add("refresh", data, {
    jobId: jobIdFor.rarity(data.projectId, Date.now()),
  });
}
