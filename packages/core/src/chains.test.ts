import { describe, expect, it } from "vitest";
import {
  CHAINS,
  chainAddressUrl,
  chainTxUrl,
  finalityDepthFor,
  getChain,
  knownChainIds,
} from "./chains.ts";

describe("chain registry", () => {
  it("includes Robinhood Chain (4663) as the primary target with the OpenSea slug", () => {
    const rh = getChain(4663);
    expect(rh?.name).toBe("Robinhood Chain");
    expect(rh?.openSeaSlug).toBe("robinhood");
    expect(rh?.finalityDepth).toBe(12);
  });

  it("returns undefined for an unknown chain", () => {
    expect(getChain(999999)).toBeUndefined();
  });

  it("finalityDepthFor falls back for an unknown chain instead of throwing", () => {
    expect(finalityDepthFor(4663)).toBe(12);
    expect(finalityDepthFor(999999)).toBe(12);
    expect(finalityDepthFor(999999, 20)).toBe(20);
  });

  it("knownChainIds returns every registered chain id as a number", () => {
    const ids = knownChainIds();
    expect(ids).toContain(4663);
    expect(ids.every((id) => typeof id === "number")).toBe(true);
    expect(ids.length).toBe(Object.keys(CHAINS).length);
  });

  it("builds explorer URLs for known chains and null for unknown", () => {
    expect(chainTxUrl(4663, "0xabc")).toBe("https://robinscan.io/tx/0xabc");
    expect(chainAddressUrl(8453, "0xdef")).toBe("https://basescan.org/address/0xdef");
    expect(chainTxUrl(999999, "0xabc")).toBeNull();
    expect(chainAddressUrl(999999, "0xabc")).toBeNull();
  });

  it("every registered chain has a consistent, well-formed config", () => {
    for (const [key, chain] of Object.entries(CHAINS)) {
      expect(chain.chainId).toBe(Number(key)); // map key matches its own id
      expect(chain.finalityDepth).toBeGreaterThan(0);
      expect(chain.explorerBaseUrl.startsWith("https://")).toBe(true);
      expect(chain.explorerBaseUrl.endsWith("/")).toBe(false); // no trailing slash (URLs append /tx/…)
      expect(chain.nativeCurrency.length).toBeGreaterThan(0);
    }
  });
});
