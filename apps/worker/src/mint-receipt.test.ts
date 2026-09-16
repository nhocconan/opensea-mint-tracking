import { beforeEach, describe, expect, it, vi } from "vitest";

const { getTransactionReceipt } = vi.hoisted(() => ({
  getTransactionReceipt: vi.fn(),
}));

vi.mock("viem", () => ({
  createPublicClient: () => ({ getTransactionReceipt }),
  http: () => ({}),
}));

const { pickBroadcastError, resolveTxOutcome, waitForMintReceipt } = await import(
  "./mint-receipt.ts"
);

const RPC_URL = "http://127.0.0.1:8545";
const TX_HASH = `0x${"ab".repeat(32)}`;

beforeEach(() => {
  getTransactionReceipt.mockReset();
});

describe("pickBroadcastError", () => {
  it("does not pick errors[0] blindly: a later nonce error beats an earlier generic transport error", () => {
    // The defect this guards: Promise.any's errors[0] is whichever endpoint
    // happened to sit first in the array, not the most meaningful failure.
    const transportErr = new Error("HTTP request failed");
    const nonceErr = new Error("nonce too low: next nonce 5, tx nonce 4");
    const aggregate = new AggregateError([transportErr, nonceErr], "All promises rejected");
    expect(pickBroadcastError(aggregate)).toBe(nonceErr);
  });

  it("ranks insufficient funds above a nonce error, since a retry cannot change the balance", () => {
    const nonceErr = new Error("nonce too low");
    const fundsErr = new Error("insufficient funds for gas * price + value");
    const aggregate = new AggregateError([nonceErr, fundsErr]);
    expect(pickBroadcastError(aggregate)).toBe(fundsErr);
  });

  it("returns a fee-too-low error when it is the most specific one present", () => {
    const transportErr = new Error("connection reset");
    const feeErr = new Error("max fee per gas less than block base fee");
    const aggregate = new AggregateError([transportErr, feeErr]);
    expect(pickBroadcastError(aggregate)).toBe(feeErr);
  });

  it("returns a revert error when it is the most specific one present", () => {
    const transportErr = new Error("socket hang up");
    const revertErr = new Error("execution reverted: stage not active");
    const aggregate = new AggregateError([transportErr, revertErr]);
    expect(pickBroadcastError(aggregate)).toBe(revertErr);
  });

  it("returns a usable Error for a non-AggregateError input", () => {
    const err = new Error("connection refused");
    expect(pickBroadcastError(err)).toBe(err);
  });

  it("returns a usable Error for a plain string input", () => {
    const result = pickBroadcastError("boom");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("boom");
  });

  it("returns a usable Error for an AggregateError with no matching pattern, instead of throwing or returning undefined", () => {
    const e1 = new Error("weird failure one");
    const e2 = new Error("weird failure two");
    const aggregate = new AggregateError([e1, e2]);
    const result = pickBroadcastError(aggregate);
    expect(result).toBeInstanceOf(Error);
    expect(result).toBe(e1);
  });

  it("converts non-Error members instead of dropping them", () => {
    const aggregate = new AggregateError(
      ["nonce too low: bad nonce", "some other transport string"],
      "combined",
    );
    const result = pickBroadcastError(aggregate);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("nonce too low");
  });
});

describe("waitForMintReceipt", () => {
  it("returns success for a receipt with status success", async () => {
    getTransactionReceipt.mockResolvedValue({ status: "success" });
    const outcome = await waitForMintReceipt(RPC_URL, TX_HASH, { timeoutMs: 200, pollMs: 10 });
    expect(outcome).toBe("success");
  });

  it("returns reverted for a receipt with status reverted", async () => {
    getTransactionReceipt.mockResolvedValue({ status: "reverted" });
    const outcome = await waitForMintReceipt(RPC_URL, TX_HASH, { timeoutMs: 200, pollMs: 10 });
    expect(outcome).toBe("reverted");
  });

  it("returns unknown (not a failure) when the receipt lookup keeps throwing past the deadline", async () => {
    // The caller must treat "unknown" as still-in-flight: re-arming a plan
    // whose transaction may yet mine is how a wallet mints twice.
    getTransactionReceipt.mockRejectedValue(new Error("TransactionReceiptNotFoundError"));
    const outcome = await waitForMintReceipt(RPC_URL, TX_HASH, { timeoutMs: 50, pollMs: 10 });
    expect(outcome).toBe("unknown");
  });
});

describe("resolveTxOutcome", () => {
  it("reports success when the receipt succeeded", async () => {
    getTransactionReceipt.mockResolvedValueOnce({ status: "success" });
    expect(await resolveTxOutcome(RPC_URL, TX_HASH)).toBe("success");
  });

  // The whole point of the tri-state. This function used to return a bare
  // boolean, so a transaction that LANDED AND REVERTED — a pre-signed blob
  // broadcast a hair before the stage opened — came back `true`, the caller
  // read that as "already minted", marked the plan executed and consumed the
  // arm. Nothing was minted and nobody was told. If this ever returns
  // "success" for a reverted receipt again, that bug is back.
  it("reports reverted when the transaction landed but reverted", async () => {
    getTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });
    expect(await resolveTxOutcome(RPC_URL, TX_HASH)).toBe("reverted");
  });

  it("reports unknown when the receipt lookup throws", async () => {
    getTransactionReceipt.mockRejectedValueOnce(new Error("not found"));
    expect(await resolveTxOutcome(RPC_URL, TX_HASH)).toBe("unknown");
  });

  it("reports unknown when the endpoint answers with no receipt", async () => {
    getTransactionReceipt.mockResolvedValueOnce(null);
    expect(await resolveTxOutcome(RPC_URL, TX_HASH)).toBe("unknown");
  });
});
