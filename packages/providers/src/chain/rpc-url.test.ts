import { describe, expect, it } from "vitest";
import { assertSafeRpcUrl } from "./rpc-url.ts";

describe("assertSafeRpcUrl", () => {
  it("allows a normal public https RPC URL", async () => {
    await expect(
      assertSafeRpcUrl("https://rpc.mainnet.chain.robinhood.com"),
    ).resolves.toBeInstanceOf(URL);
  });

  it("allows a private/LAN address — self-hosted nodes are a legitimate target (ADR 0006)", async () => {
    await expect(assertSafeRpcUrl("http://192.168.1.50:8545")).resolves.toBeInstanceOf(URL);
    await expect(assertSafeRpcUrl("http://10.0.0.5:8545")).resolves.toBeInstanceOf(URL);
    await expect(assertSafeRpcUrl("http://localhost:8545")).resolves.toBeInstanceOf(URL);
  });

  it("allows ws/wss for the WebSocket hint path", async () => {
    await expect(assertSafeRpcUrl("wss://rpc.example.com")).resolves.toBeInstanceOf(URL);
  });

  it("blocks the literal AWS/Azure/GCP metadata IP", async () => {
    await expect(assertSafeRpcUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /metadata/,
    );
  });

  it("blocks the GCP metadata hostname", async () => {
    await expect(
      assertSafeRpcUrl("http://metadata.google.internal/computeMetadata/v1/"),
    ).rejects.toThrow(/metadata/);
  });

  it("blocks a hostname that DNS-resolves to the metadata IP (rebinding-style)", async () => {
    await expect(
      assertSafeRpcUrl("http://sneaky.example.com", {
        dnsLookup: async () => [{ address: "169.254.169.254" }],
      }),
    ).rejects.toThrow(/metadata/);
  });

  it("rejects a malformed URL", async () => {
    await expect(assertSafeRpcUrl("not a url")).rejects.toThrow();
  });

  it("rejects a non-RPC protocol", async () => {
    await expect(assertSafeRpcUrl("ftp://example.com")).rejects.toThrow(/http\(s\) or ws\(s\)/);
  });
});
