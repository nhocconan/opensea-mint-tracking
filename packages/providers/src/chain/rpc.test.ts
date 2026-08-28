import { encodeAbiParameters, type Log, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { ChainRadar, isOversizedLogsError } from "./rpc.ts";
import { isMintTransfer, SEADROP_ADDRESS, ZERO_ADDRESS } from "./seadrop.ts";

const radar = new ChainRadar({ rpcUrl: "http://127.0.0.1:8545", chainId: 4663, initialRange: 100 });

const TX = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const CONTRACT = `0x${"11".repeat(20)}`;
const MINTER = "0xabcdef0123456789abcdef0123456789abcdef01";
const ERC721_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function topicAddress(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function baseLog(overrides: Partial<Log>): Log {
  return {
    address: CONTRACT,
    topics: [],
    data: "0x",
    transactionHash: TX,
    logIndex: 1n,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    transactionIndex: 0n,
    removed: false,
    ...overrides,
  } as Log;
}

describe("mint classification", () => {
  it("zero-address and SeaDrop senders are mints; others are transfers", () => {
    expect(isMintTransfer(ZERO_ADDRESS)).toBe(true);
    expect(isMintTransfer(SEADROP_ADDRESS)).toBe(true);
    expect(isMintTransfer(MINTER)).toBe(false);
    expect(isMintTransfer(SEADROP_ADDRESS.toUpperCase())).toBe(true);
  });
});

describe("isOversizedLogsError", () => {
  it("matches classic range/limit phrasings in the message", () => {
    expect(isOversizedLogsError(new Error("query exceeds max block range"))).toBe(true);
    expect(isOversizedLogsError(new Error("result set too large"))).toBe(true);
    expect(isOversizedLogsError(new Error("limit exceeded"))).toBe(true);
  });

  it("matches the raw RPC reason hidden in viem's `details` field", () => {
    // Robinhood Chain RPC: viem surfaces InvalidParamsRpcError with a generic
    // message and puts the real reason in `details`.
    const viemStyle = Object.assign(new Error("Missing or invalid parameters."), {
      details: "logs matched by query exceeds limit of 10000",
    });
    expect(isOversizedLogsError(viemStyle)).toBe(true);
  });

  it("matches viem's HTTP response-body size cap on oversized log pages", () => {
    expect(
      isOversizedLogsError(
        new Error(
          "HTTP response body exceeded the size limit.\n\nMax: 10485760 bytes\nReceived: 10502144 bytes",
        ),
      ),
    ).toBe(true);
  });

  it("treats transport timeouts as shrink signals", () => {
    expect(isOversizedLogsError(new Error("The request took too long to respond."))).toBe(true);
    expect(isOversizedLogsError(new Error("Request timed out"))).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isOversizedLogsError(new Error("connection refused"))).toBe(false);
    expect(isOversizedLogsError(new Error("HTTP 500 internal server error"))).toBe(false);
  });
});

describe("ChainRadar.decodeMintLog", () => {
  const NOW = new Date("2026-08-16T12:00:00Z");

  it("decodes an ERC-721 mint (from zero) with quantity 1", () => {
    const log = baseLog({
      topics: [ERC721_TRANSFER, topicAddress(ZERO_ADDRESS), topicAddress(MINTER)],
    });
    const event = radar.decodeMintLog(log, NOW);
    expect(event).not.toBeNull();
    expect(event?.recipient).toBe(MINTER);
    expect(event?.quantity).toBe(1);
    expect(event?.contractAddress).toBe(CONTRACT);
    expect(event?.chainId).toBe(4663);
    expect(event?.finalized).toBe(false);
  });

  it("ignores a secondary ERC-721 transfer (from a wallet)", () => {
    const log = baseLog({
      topics: [ERC721_TRANSFER, topicAddress(MINTER), topicAddress(`0x${"22".repeat(20)}`)],
    });
    expect(radar.decodeMintLog(log, NOW)).toBeNull();
  });

  it("decodes an ERC-1155 TransferSingle mint with quantity from data", () => {
    const data = encodeAbiParameters(parseAbiParameters("uint256 id, uint256 value"), [7n, 5n]);
    const log = baseLog({
      topics: [
        "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
        topicAddress(ZERO_ADDRESS),
        topicAddress(ZERO_ADDRESS),
        topicAddress(MINTER),
      ],
      data,
    });
    const event = radar.decodeMintLog(log, NOW);
    expect(event?.quantity).toBe(5);
    expect(event?.recipient).toBe(MINTER);
  });

  it("decodes an ERC-1155 TransferBatch mint by summing values", () => {
    const data = encodeAbiParameters(parseAbiParameters("uint256[] ids, uint256[] values"), [
      [1n, 2n],
      [3n, 4n],
    ]);
    const log = baseLog({
      topics: [
        "0x4a39dc06d4c0dbc64b70b58deeb0eb1e6b49e6f3a6f0a3ba54a5eb02d7b630f6",
        topicAddress(ZERO_ADDRESS),
        topicAddress(ZERO_ADDRESS),
        topicAddress(MINTER),
      ],
      data,
    });
    const event = radar.decodeMintLog(log, NOW);
    expect(event?.quantity).toBe(7);
  });

  it("returns null for junk instead of throwing", () => {
    expect(radar.decodeMintLog(baseLog({ topics: ["0xdeadbeef"], data: "0xzz" }), NOW)).toBeNull();
    expect(radar.decodeMintLog(baseLog({ topics: [] }), NOW)).toBeNull();
  });
});
