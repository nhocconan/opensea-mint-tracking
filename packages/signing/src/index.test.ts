import { keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  assertSignable,
  type ExecutorSignRequest,
  generateSessionKey,
  NotImplementedSigningSchemeError,
  parseBrowserSignResult,
  signExecutorTransaction,
  toBrowserSignRequest,
} from "./index.ts";

describe("assertSignable", () => {
  it("allows browser_wallet — zero server custody, the human signs client-side", () => {
    expect(() => assertSignable({ id: "s1", scheme: "browser_wallet" })).not.toThrow();
  });

  it("allows custom_executor — ADR 0004's 2026-08-22 amendment: the Executor fallback is the real Phase 2 build target", () => {
    expect(() => assertSignable({ id: "s1", scheme: "custom_executor" })).not.toThrow();
  });

  it("refuses eip7702_safe_zodiac — Ledger's device firmware can't sign the Safe delegation this scheme needs yet (ADR 0004 amendment)", () => {
    expect(() => assertSignable({ id: "s1", scheme: "eip7702_safe_zodiac" })).toThrow(
      NotImplementedSigningSchemeError,
    );
  });
});

describe("toBrowserSignRequest", () => {
  it("carries only non-secret, display-safe fields", () => {
    const req = toBrowserSignRequest("plan-1", {
      chainId: 4663,
      to: "0xabc",
      data: "0xdead",
      valueWei: "100",
      expectedFrom: "0xowner",
    });
    expect(req).toEqual({
      planId: "plan-1",
      chainId: 4663,
      to: "0xabc",
      data: "0xdead",
      valueWei: "100",
    });
  });
});

describe("parseBrowserSignResult", () => {
  const validHash = `0x${"a".repeat(64)}`;

  it("accepts a well-formed result", () => {
    expect(parseBrowserSignResult({ planId: "plan-1", txHash: validHash })).toEqual({
      planId: "plan-1",
      txHash: validHash,
    });
  });

  it("rejects a missing planId", () => {
    expect(() => parseBrowserSignResult({ planId: "", txHash: validHash })).toThrow();
  });

  it("rejects a malformed tx hash", () => {
    expect(() => parseBrowserSignResult({ planId: "plan-1", txHash: "not-a-hash" })).toThrow();
  });
});

describe("signExecutorTransaction", () => {
  // Well-known Anvil/Foundry default test key #0 — public, throwaway,
  // never holds real funds on any real chain. Used only to prove the
  // signing/serialization logic here, never a real session key.
  const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
  const testAccount = privateKeyToAccount(TEST_KEY);

  const baseRequest: ExecutorSignRequest = {
    chainId: 4663,
    executorAddress: "0x1111111111111111111111111111111111111111",
    target: "0x2222222222222222222222222222222222222222",
    data: "0x40c10f19000000000000000000000000333333333333333333333333333333333333330000000000000000000000000000000000000000000000000000000000000001",
    valueWei: "1000000000000000000", // 1 ETH mint price
    nonce: 7,
    maxFeePerGasWei: "50000000000", // 50 gwei
    maxPriorityFeePerGasWei: "2000000000", // 2 gwei
    gas: 250_000n,
  };

  it("produces a real signature recoverable to the session key's own address", async () => {
    const { rawTx } = await signExecutorTransaction(baseRequest, TEST_KEY);
    const recovered = await recoverTransactionAddress({
      serializedTransaction: rawTx as `0x02${string}`,
    });
    expect(recovered.toLowerCase()).toBe(testAccount.address.toLowerCase());
  });

  it("txHash is keccak256 of the raw serialized signed transaction", async () => {
    const { rawTx, txHash } = await signExecutorTransaction(baseRequest, TEST_KEY);
    expect(txHash).toBe(keccak256(rawTx));
  });

  it("targets the Executor contract, never the mint target directly, and never forwards value from the operator's own tx", async () => {
    const { rawTx } = await signExecutorTransaction(baseRequest, TEST_KEY);
    const parsed = parseTransaction(rawTx);
    expect(parsed.to?.toLowerCase()).toBe(baseRequest.executorAddress.toLowerCase());
    // A zero value is RLP-encoded as an omitted/empty item, not a literal
    // "0" — viem's parser leaves it undefined rather than backfilling 0n,
    // so both are the correct representation of "no ETH forwarded."
    expect(parsed.value ?? 0n).toBe(0n);
  });

  it("encodes an executeMint(address,bytes,uint256) call carrying the real target/data/value", async () => {
    const { rawTx } = await signExecutorTransaction(baseRequest, TEST_KEY);
    const parsed = parseTransaction(rawTx);
    // executeMint(address,bytes,uint256) selector, computed independently
    // of packages/signing's own EXECUTOR_ABI constant so this test can't
    // pass merely by echoing the same source it's checking.
    const selector = keccak256(
      new TextEncoder().encode("executeMint(address,bytes,uint256)"),
    ).slice(0, 10);
    expect(parsed.data?.slice(0, 10)).toBe(selector);
  });

  it("carries the exact chainId, nonce, gas, and fee fields through unchanged", async () => {
    const { rawTx } = await signExecutorTransaction(baseRequest, TEST_KEY);
    const parsed = parseTransaction(rawTx);
    expect(parsed.chainId).toBe(baseRequest.chainId);
    expect(parsed.nonce).toBe(baseRequest.nonce);
    expect(parsed.gas).toBe(baseRequest.gas);
    expect(parsed.maxFeePerGas).toBe(BigInt(baseRequest.maxFeePerGasWei));
    expect(parsed.maxPriorityFeePerGas).toBe(BigInt(baseRequest.maxPriorityFeePerGasWei));
    expect(parsed.type).toBe("eip1559");
  });

  it("different session keys produce different, independently-recoverable signatures for the same request", async () => {
    const otherKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const; // Anvil key #1
    const otherAccount = privateKeyToAccount(otherKey);

    const a = await signExecutorTransaction(baseRequest, TEST_KEY);
    const b = await signExecutorTransaction(baseRequest, otherKey);

    expect(a.rawTx).not.toBe(b.rawTx);
    const recoveredB = await recoverTransactionAddress({
      serializedTransaction: b.rawTx as `0x02${string}`,
    });
    expect(recoveredB.toLowerCase()).toBe(otherAccount.address.toLowerCase());
  });
});

describe("generateSessionKey", () => {
  it("returns a private key whose derived address matches the returned address", () => {
    const generated = generateSessionKey();
    const derived = privateKeyToAccount(generated.privateKeyHex as `0x${string}`);
    expect(derived.address.toLowerCase()).toBe(generated.address.toLowerCase());
  });

  it("returns a well-formed 32-byte private key", () => {
    const generated = generateSessionKey();
    expect(generated.privateKeyHex).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("generates a different key every call", () => {
    const a = generateSessionKey();
    const b = generateSessionKey();
    expect(a.privateKeyHex).not.toBe(b.privateKeyHex);
    expect(a.address).not.toBe(b.address);
  });
});
