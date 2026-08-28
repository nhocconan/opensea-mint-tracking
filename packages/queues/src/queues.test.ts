import { jobId } from "@hoodmint/core";
import { describe, expect, it } from "vitest";
import { DISCOVERY_FEED_TYPES, scheduledDiscoveryJobs } from "./queues.ts";

describe("scheduledDiscoveryJobs", () => {
  it("schedules all three feed types every pass", () => {
    const jobs = scheduledDiscoveryJobs(1_000_000, 300_000);
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.dropType)).toEqual([...DISCOVERY_FEED_TYPES]);
    expect(jobs.map((j) => j.dropType)).toEqual(["featured", "upcoming", "recently_minted"]);
  });

  it("buckets windowStartMs to the interval, giving repeat calls within the same interval identical deterministic job ids", () => {
    const a = scheduledDiscoveryJobs(1_000_050, 300_000);
    const b = scheduledDiscoveryJobs(1_000_250, 300_000);
    expect(a.map((j) => j.windowStartMs)).toEqual(b.map((j) => j.windowStartMs));
    for (let i = 0; i < a.length; i += 1) {
      const jobA = a[i];
      const jobB = b[i];
      expect(jobA).toBeDefined();
      expect(jobB).toBeDefined();
      if (jobA === undefined || jobB === undefined) {
        continue;
      }
      expect(jobId.discovery("opensea", jobA.dropType, jobA.windowStartMs)).toBe(
        jobId.discovery("opensea", jobB.dropType, jobB.windowStartMs),
      );
    }
  });

  it("advances windowStartMs to a new bucket on the next interval", () => {
    const a = scheduledDiscoveryJobs(1_000_000, 300_000);
    const b = scheduledDiscoveryJobs(1_300_000, 300_000);
    expect(a[0]?.windowStartMs).not.toBe(b[0]?.windowStartMs);
  });
});
