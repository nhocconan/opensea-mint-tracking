import { describe, expect, it } from "vitest";
import { partitionKeys } from "./credentials.ts";

const KEYS = ["k1", "k2", "k3"];

describe("partitionKeys", () => {
  // The whole point: on 2026-09-15 background scanning exhausted the shared
  // hourly quota and the signature burst had nothing left at the open. The
  // split must make that impossible, not merely unlikely.
  it("gives scan the first N keys and mint everything else", () => {
    expect(partitionKeys(KEYS, "scan", 1)).toEqual(["k1"]);
    expect(partitionKeys(KEYS, "mint", 1)).toEqual(["k2", "k3"]);
  });

  it("never lets the two pools overlap", () => {
    const scan = partitionKeys(KEYS, "scan", 2);
    const mint = partitionKeys(KEYS, "mint", 2);
    expect(scan.some((k) => mint.includes(k))).toBe(false);
    expect([...scan, ...mint].sort()).toEqual([...KEYS].sort());
  });

  it("always leaves mint at least one key, however greedy the scan count", () => {
    expect(partitionKeys(KEYS, "mint", 99)).toEqual(["k3"]);
    expect(partitionKeys(KEYS, "scan", 99)).toEqual(["k1", "k2"]);
  });

  it("always leaves scan at least one key", () => {
    expect(partitionKeys(KEYS, "scan", 0)).toEqual(["k1"]);
  });

  // A single key is shared rather than leaving one side unable to work at all.
  it("shares a lone key instead of starving one side", () => {
    expect(partitionKeys(["only"], "scan", 1)).toEqual(["only"]);
    expect(partitionKeys(["only"], "mint", 1)).toEqual(["only"]);
  });

  it("handles an empty pool", () => {
    expect(partitionKeys([], "mint", 1)).toEqual([]);
  });
});
