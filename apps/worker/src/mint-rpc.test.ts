import { describe, expect, it } from "vitest";
import { mintRpcUrls, mintRpcUrlsForChain } from "./mint-rpc.ts";

const cfg = {
  ALCHEMY_ROBINHOOD_RPC: "https://robinhood-mainnet.g.alchemy.com/v2/AK",
  DRPC_ROBINHOOD_RPC: "https://lb.drpc.live/robinhood/DK",
  CHAINSTACK_ROBINHOOD_RPC: "https://robinhood-mainnet.core.chainstack.com/CT",
  RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
};

describe("mintRpcUrls ordering", () => {
  // Measured 2026-09-16: dRPC 66ms, Chainstack 68ms, Alchemy 133ms. Reads fail
  // over in order, so the first entry is the latency the mint pays.
  it("puts the fastest provider first", () => {
    const urls = mintRpcUrls(cfg);
    expect(urls[0]).toContain("drpc");
    expect(urls[1]).toContain("chainstack");
    expect(urls[2]).toContain("alchemy");
  });

  it("appends registry endpoints behind the premium ones and de-duplicates", () => {
    const urls = mintRpcUrls(cfg, ["https://rpc.mainnet.chain.robinhood.com"]);
    expect(urls.filter((u) => u.includes("chain.robinhood.com"))).toHaveLength(1);
    expect(urls.indexOf("https://rpc.mainnet.chain.robinhood.com")).toBe(3);
  });
});

describe("mintRpcUrlsForChain", () => {
  it("returns the configured premium URLs unchanged for the configured chain", () => {
    // RPC_URL names one chain's public node, so only mintRpcUrls (the
    // single-chain helper) appends it; the chain-aware form leaves the
    // per-chain fallback to the caller's registry list.
    expect(mintRpcUrlsForChain(cfg, 4663)).toEqual([
      cfg.DRPC_ROBINHOOD_RPC,
      cfg.CHAINSTACK_ROBINHOOD_RPC,
      cfg.ALCHEMY_ROBINHOOD_RPC,
    ]);
    expect(mintRpcUrls(cfg)).toEqual([
      cfg.DRPC_ROBINHOOD_RPC,
      cfg.CHAINSTACK_ROBINHOOD_RPC,
      cfg.ALCHEMY_ROBINHOOD_RPC,
      cfg.RPC_URL,
    ]);
  });

  // The operator enters each provider ONCE; other networks are derived.
  it("derives Alchemy and dRPC for another chain", () => {
    const urls = mintRpcUrlsForChain(cfg, 8453);
    expect(urls).toContain("https://lb.drpc.live/base/DK");
    expect(urls).toContain("https://base-mainnet.g.alchemy.com/v2/AK");
  });

  // Chainstack's path is a per-node token — a derived URL would authenticate
  // as nothing, and would only fail at the fire instant.
  it("drops Chainstack for a chain it was not configured for", () => {
    const urls = mintRpcUrlsForChain(cfg, 8453);
    expect(urls.some((u) => u.includes("chainstack"))).toBe(false);
  });

  it("drops every provider for a chain it cannot spell", () => {
    expect(mintRpcUrlsForChain(cfg, 999999)).toEqual([]);
  });
});
