import { describe, expect, it } from "vitest";
import { deriveRpcUrl, detectRpcProvider, rpcUrlServesChain } from "./rpc-derive.ts";

const ALCHEMY = "https://robinhood-mainnet.g.alchemy.com/v2/KEY123";
const DRPC = "https://lb.drpc.live/robinhood/KEY456";
const CHAINSTACK = "https://robinhood-mainnet.core.chainstack.com/NODETOKEN";

describe("detectRpcProvider", () => {
  it("recognises each provider by host", () => {
    expect(detectRpcProvider(ALCHEMY)).toBe("alchemy");
    expect(detectRpcProvider(DRPC)).toBe("drpc");
    expect(detectRpcProvider("https://lb.drpc.org/ogrpc/base/K")).toBe("drpc");
    expect(detectRpcProvider(CHAINSTACK)).toBe("chainstack");
    expect(detectRpcProvider("https://rpc.mainnet.chain.robinhood.com")).toBe("unknown");
    expect(detectRpcProvider("not a url")).toBe("unknown");
  });
});

describe("deriveRpcUrl", () => {
  it("swaps only the network label for Alchemy, keeping the key", () => {
    expect(deriveRpcUrl(ALCHEMY, 8453)).toBe("https://base-mainnet.g.alchemy.com/v2/KEY123");
    expect(deriveRpcUrl(ALCHEMY, 1)).toBe("https://eth-mainnet.g.alchemy.com/v2/KEY123");
    expect(deriveRpcUrl(ALCHEMY, 42161)).toBe("https://arb-mainnet.g.alchemy.com/v2/KEY123");
  });

  it("swaps only the first path segment for dRPC, keeping the key", () => {
    expect(deriveRpcUrl(DRPC, 8453)).toBe("https://lb.drpc.live/base/KEY456");
    expect(deriveRpcUrl(DRPC, 1)).toBe("https://lb.drpc.live/ethereum/KEY456");
  });

  // The important refusal: a Chainstack path segment is a per-node token, so a
  // derived URL would be a plausible string that authenticates as nothing —
  // and it would only fail at the fire instant.
  it("refuses to derive Chainstack rather than guessing a node token", () => {
    expect(deriveRpcUrl(CHAINSTACK, 8453)).toBeUndefined();
    expect(deriveRpcUrl(CHAINSTACK, 1)).toBeUndefined();
  });

  it("refuses an unknown provider and an unknown chain", () => {
    expect(deriveRpcUrl("https://rpc.mainnet.chain.robinhood.com", 8453)).toBeUndefined();
    expect(deriveRpcUrl(ALCHEMY, 999999)).toBeUndefined();
  });

  it("round-trips the network it came from", () => {
    expect(rpcUrlServesChain(ALCHEMY, 4663)).toBe(true);
    expect(rpcUrlServesChain(DRPC, 4663)).toBe(true);
    expect(rpcUrlServesChain(ALCHEMY, 8453)).toBe(false);
  });
});

describe("rpcUrlServesChain", () => {
  // The regression this locks down: using "is it derivable" to answer "does it
  // serve this chain" dropped Chainstack from the fire path for Robinhood —
  // the very chain it was configured for — because Chainstack is not derivable.
  it("recognises a non-derivable provider on its own chain", () => {
    expect(rpcUrlServesChain(CHAINSTACK, 4663)).toBe(true);
    expect(rpcUrlServesChain(CHAINSTACK, 8453)).toBe(false);
  });

  it("recognises a provider's own spelling of a network", () => {
    expect(rpcUrlServesChain("https://eth-mainnet.g.alchemy.com/v2/K", 1)).toBe(true);
    expect(rpcUrlServesChain("https://lb.drpc.live/ethereum/K", 1)).toBe(true);
  });
});
