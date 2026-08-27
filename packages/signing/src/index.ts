/**
 * The signing chokepoint (ADR 0004/0005). This is the ONLY package in the
 * system allowed to construct a spend-capable signing account or decide a
 * transaction is signable — packages/execution imports this, never
 * resolves a signer itself. Phase 1: `browser_wallet` needs no key here at
 * all, because the owner signs client-side in their own wallet — that IS
 * the safety gate for this scheme (ADR 0008's "Signing mode A"). Phase 2
 * (ADR 0004's 2026-08-22 amendment — the Executor-contract fallback,
 * promoted to the real build target after confirming Ledger's device
 * firmware can't sign the ADR's originally-stated Safe/7702 delegation):
 * `custom_executor` signs here too, via a session key. Every other scheme
 * (`eip7702_safe_zodiac` — not yet buildable on real Ledger hardware, per
 * that amendment) still throws.
 *
 * Boundary note on decryption: the raw AES-256-GCM decrypt primitive
 * (`openSecret`) lives in `@hoodmint/secrets` and is shared, generic infra
 * already used for lower-sensitivity credentials (e.g. the OpenSea API
 * key) outside this package. The chokepoint this package actually owns is
 * narrower and more meaningful than "who calls openSecret": it is the only
 * place a decrypted session key is ever turned into a viem signing
 * account and used to produce a real signature. The caller resolves
 * ciphertext -> plaintext hex (same `getCredentialSecret` call already
 * used for every other credential type) and hands the plaintext straight
 * into `signExecutorTransaction` below, which builds the account, signs,
 * and lets the local variable go out of scope immediately after — never
 * cached in a long-lived signer instance, never logged (see the
 * privateKey/sessionKey redaction added to packages/observability and
 * packages/secrets alongside this).
 */
import type { SignerScheme } from "@hoodmint/core";
import { encodeFunctionData, type Hex, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface PreparedTransaction {
  readonly chainId: number;
  /** Target contract, from packages/execution's MintAdapter — never hand-typed by a caller. */
  readonly to: string;
  readonly data: string;
  readonly valueWei: string;
  /** Expected sender/recipient context, for the browser-wallet UI to display and the owner to check. */
  readonly expectedFrom: string;
}

export interface SignerHandle {
  readonly id: string;
  readonly scheme: SignerScheme;
}

export class NotImplementedSigningSchemeError extends Error {
  constructor(scheme: string) {
    super(
      `signing scheme '${scheme}' is not implemented in this codebase yet — Phase 2 delegated ` +
        "custody (ADR 0004) requires the owner's Ledger hardware confirmation, a registered " +
        "WebAuthn step-up factor, and explicit ToS-risk acceptance before it can be built and " +
        "used for real. See docs/execution-architecture.md.",
    );
    this.name = "NotImplementedSigningSchemeError";
  }
}

/**
 * Throws unless the signer is actually usable today. Call this before
 * doing anything else in an execution pipeline — it is the one place a
 * scheme gets to say "no" before any calldata is shown to anyone.
 */
export function assertSignable(signer: SignerHandle): void {
  if (signer.scheme !== "browser_wallet" && signer.scheme !== "custom_executor") {
    throw new NotImplementedSigningSchemeError(signer.scheme);
  }
}

export interface BrowserSignRequest {
  readonly planId: string;
  readonly chainId: number;
  readonly to: string;
  readonly data: string;
  readonly valueWei: string;
}

/** Shape sent to the browser for wagmi/viem `sendTransaction` — no secret ever included. */
export function toBrowserSignRequest(planId: string, tx: PreparedTransaction): BrowserSignRequest {
  return { planId, chainId: tx.chainId, to: tx.to, data: tx.data, valueWei: tx.valueWei };
}

export interface BrowserSignResult {
  readonly planId: string;
  readonly txHash: string;
}

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Validate what the browser reports back before trusting it as a real attempt. */
export function parseBrowserSignResult(input: {
  planId: unknown;
  txHash: unknown;
}): BrowserSignResult {
  if (typeof input.planId !== "string" || input.planId.length === 0) {
    throw new Error("browser sign result missing planId");
  }
  if (typeof input.txHash !== "string" || !TX_HASH_PATTERN.test(input.txHash)) {
    throw new Error("browser sign result has an invalid tx hash");
  }
  return { planId: input.planId, txHash: input.txHash.toLowerCase() };
}

/* ── custom_executor scheme (ADR 0004 Phase 2, Executor-contract fallback,
 * promoted to the real build target by the 2026-08-22 amendment) ────────── */

/** `executeMint(address target, bytes data, uint256 value)` — the one
 *  entrypoint the operator session key is ever permitted to call on the
 *  deployed MintExecutor (contracts/mint-executor/src/MintExecutor.sol).
 *  Kept as a hand-written minimal ABI fragment, not imported from the
 *  Foundry build artifact — packages/signing has no build-time dependency
 *  on the Solidity toolchain, and this is the entire ABI surface it ever
 *  needs to encode. */
const EXECUTOR_ABI = [
  {
    type: "function",
    name: "executeMint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export interface ExecutorSignRequest {
  readonly chainId: number;
  /** The deployed MintExecutor contract's own address (signers.delegateContractAddress). */
  readonly executorAddress: string;
  /** The real mint target + calldata + value — exactly what the on-chain
   *  Executor will decode and recipient-check, so this must be the final,
   *  real transaction, not a template. */
  readonly target: string;
  readonly data: string;
  readonly valueWei: string;
  readonly nonce: number;
  readonly maxFeePerGasWei: string;
  readonly maxPriorityFeePerGasWei: string;
  /** From the pipeline's own mandatory pre-flight simulation (ADR 0005) —
   *  never re-estimated here, this package has no RPC access by design. */
  readonly gas: bigint;
}

export interface SignedExecutorTransaction {
  readonly rawTx: Hex;
  readonly txHash: string;
}

/**
 * Decrypts nothing itself — `sessionKeyHex` is the already-decrypted
 * private key (the caller resolved it via the same `getCredentialSecret`
 * every other credential type uses). This function is the actual
 * chokepoint: the only place in the system a viem signing account is ever
 * constructed from that key. The local `account`/`sessionKeyHex` bindings
 * are function-scoped and go out of scope the instant this returns —
 * nothing here persists or caches key material.
 */
export async function signExecutorTransaction(
  request: ExecutorSignRequest,
  sessionKeyHex: string,
): Promise<SignedExecutorTransaction> {
  const calldata = encodeFunctionData({
    abi: EXECUTOR_ABI,
    functionName: "executeMint",
    args: [request.target as Hex, request.data as Hex, BigInt(request.valueWei)],
  });

  const account = privateKeyToAccount(sessionKeyHex as Hex);
  // signTransaction on a viem LocalAccount signs and serializes in one
  // step; this never touches the network — broadcasting is the caller's
  // job (it has the RPC url this package deliberately does not).
  const rawTx = await account.signTransaction({
    to: request.executorAddress as Hex,
    data: calldata,
    // No ETH ever leaves the operator's own EOA — the Executor forwards
    // `value` from its own contract balance (see MintExecutor.sol's own
    // doc comment on this design choice).
    value: 0n,
    chainId: request.chainId,
    nonce: request.nonce,
    gas: request.gas,
    maxFeePerGas: BigInt(request.maxFeePerGasWei),
    maxPriorityFeePerGas: BigInt(request.maxPriorityFeePerGasWei),
    type: "eip1559",
  });

  // The standard definition of a transaction hash is keccak256 of its own
  // serialized signed form — true for both legacy and typed transactions,
  // so this needs no RPC round-trip to know the hash before broadcasting.
  const txHash = keccak256(rawTx);
  return { rawTx, txHash };
}

export interface GeneratedSessionKey {
  /** Never persisted in plaintext by the caller — sealed via
   *  @hoodmint/secrets' sealSecret before it ever touches Postgres, same
   *  discipline as every other credential type. */
  readonly privateKeyHex: string;
  /** The operator address to show the owner for the setOperator step —
   *  this, not the key, is safe to display/log. */
  readonly address: string;
}

/**
 * Generates a fresh session-key keypair for a custom_executor signer
 * (ADR 0004 Phase 2). Deliberately lives here, not in a generic crypto
 * util — key GENERATION for a spend-capable role is exactly the kind of
 * operation the "signing chokepoint" header comment on this file means to
 * cover, even though the generated key isn't used to sign anything until
 * a later, separate call to signExecutorTransaction.
 */
export function generateSessionKey(): GeneratedSessionKey {
  const privateKeyHex = generatePrivateKey();
  const account = privateKeyToAccount(privateKeyHex);
  return { privateKeyHex, address: account.address };
}
