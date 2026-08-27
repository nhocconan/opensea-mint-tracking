/**
 * End-to-end custody-stack verification (ADR 0004 Phase 2). Not a unit
 * test — invoked by script/verify-e2e.sh, which deploys/configures a fresh
 * MintExecutor + fake mint target on a throwaway local anvil chain first.
 * This file's job is narrower and more important than the Solidity test
 * suite's: prove the REAL packages/signing + packages/providers TypeScript
 * code (not mocks, not Foundry's own test harness) can sign and broadcast
 * a working transaction against a real chain, and that a malicious
 * recipient-redirect attempt genuinely reverts on-chain end to end.
 */
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  broadcastRawTransaction,
  fetchFeeContext,
} from "../../../packages/providers/src/chain/broadcast.ts";
import { signExecutorTransaction } from "../../../packages/signing/src/index.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

const RPC_URL = requireEnv("RPC_URL");
const OPERATOR_KEY = requireEnv("OPERATOR_KEY");
const OWNER_ADDRESS = requireEnv("OWNER_ADDRESS");
const EXECUTOR_ADDRESS = requireEnv("EXECUTOR_ADDRESS");
const TARGET_ADDRESS = requireEnv("TARGET_ADDRESS");
// Anvil default account #2 — a real, valid, checksummed address that is
// simply not the owner, standing in for an attacker's address.
const ATTACKER_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const FAKE_MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "quantity", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

async function getReceiptStatus(txHash: string): Promise<string> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_getTransactionReceipt",
      params: [txHash],
      id: 1,
    }),
  });
  const json = (await res.json()) as { result: { status: string } | null };
  if (json.result === null) {
    throw new Error(`no receipt yet for ${txHash}`);
  }
  return json.result.status;
}

async function signAndBroadcast(recipient: string, quantity: bigint): Promise<string> {
  const operatorAccount = privateKeyToAccount(OPERATOR_KEY as `0x${string}`);
  const fees = await fetchFeeContext(RPC_URL, operatorAccount.address);

  const mintCalldata = encodeFunctionData({
    abi: FAKE_MINT_ABI,
    functionName: "mint",
    args: [recipient as `0x${string}`, quantity],
  });

  const { rawTx, txHash } = await signExecutorTransaction(
    {
      chainId: 31337,
      executorAddress: EXECUTOR_ADDRESS,
      target: TARGET_ADDRESS,
      data: mintCalldata,
      valueWei: "0",
      nonce: fees.nonce,
      maxFeePerGasWei: fees.maxFeePerGasWei,
      maxPriorityFeePerGasWei: fees.maxPriorityFeePerGasWei,
      gas: 200_000n,
    },
    OPERATOR_KEY,
  );

  const result = await broadcastRawTransaction(RPC_URL, rawTx);
  if (result.txHash.toLowerCase() !== txHash.toLowerCase()) {
    throw new Error("MISMATCH: packages/signing's pre-computed hash != RPC-returned hash");
  }
  return result.txHash;
}

async function main(): Promise<void> {
  console.log("=== Test 1: legitimate mint to the real owner (must succeed) ===");
  const goodHash = await signAndBroadcast(OWNER_ADDRESS, 3n);
  await new Promise((r) => setTimeout(r, 200)); // anvil auto-mines instantly, small margin for receipt indexing
  const goodStatus = await getReceiptStatus(goodHash);
  console.log(`  ${goodHash} -> status ${goodStatus} (0x1 = success)`);
  if (goodStatus !== "0x1") {
    throw new Error("FAIL: legitimate mint transaction did not succeed on-chain");
  }

  console.log("\n=== Test 2: malicious mint redirecting recipient to attacker (must revert) ===");
  const badHash = await signAndBroadcast(ATTACKER_ADDRESS, 1n);
  await new Promise((r) => setTimeout(r, 200));
  const badStatus = await getReceiptStatus(badHash);
  console.log(`  ${badHash} -> status ${badStatus} (0x0 = reverted, as required)`);
  if (badStatus !== "0x0") {
    throw new Error("CRITICAL FAIL: malicious recipient redirect did NOT revert on-chain");
  }

  console.log(
    "\n✅ End-to-end verification passed: real signing + broadcast code, real chain, real revert.",
  );
}

main().catch((error: unknown) => {
  console.error("❌ E2E verification failed:", error);
  process.exit(1);
});
