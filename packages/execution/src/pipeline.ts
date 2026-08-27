/**
 * The execution pipeline (ADR 0005): plan → simulate (mandatory, never
 * bypassable) → policy check → signer capability check → (shadow log |
 * hand off to the browser wallet). Every stage is pure/injectable so this
 * is fully unit-testable without a live RPC, DB, or key of any kind — see
 * pipeline.test.ts. Nothing here signs or broadcasts; the only place a
 * transaction can be signed is the owner's own browser wallet
 * (packages/signing's `browser_wallet` scheme, ADR 0008 Phase 1).
 */
import { canFireMintPlan, type MintPlanStatus } from "@hoodmint/core";
import {
  assertSignable,
  type BrowserSignRequest,
  type PreparedTransaction,
  type SignerHandle,
  toBrowserSignRequest,
} from "@hoodmint/signing";

export type SimulateFn = (input: {
  rpcUrl: string;
  from: string;
  to: string;
  data: string;
  valueWei: string;
}) => Promise<{ ok: true; gasEstimate: bigint } | { ok: false; revertReason: string }>;

export interface ExecutionPipelineDeps {
  readonly rpcUrl: string;
  /** Hard default false — shadow mode only, per ADR 0008 Phase 1. */
  readonly liveExecutionEnabled: boolean;
  readonly simulate: SimulateFn;
  readonly now: () => Date;
}

export interface ExecutionPipelineInput {
  readonly planId: string;
  readonly planStatus: MintPlanStatus;
  readonly armedUntil: Date | null;
  readonly signerCeilingWei: bigint;
  readonly perPlanCeilingWei: bigint;
  readonly spentWei: bigint;
  readonly signer: SignerHandle;
  readonly recipientAddress: string;
  readonly tx: PreparedTransaction;
}

export type PipelineOutcome =
  | { readonly stage: "blocked_policy"; readonly reason: string }
  | { readonly stage: "blocked_simulation"; readonly revertReason: string }
  | { readonly stage: "shadow_would_fire"; readonly gasEstimate: bigint }
  | { readonly stage: "blocked_scheme_not_implemented"; readonly error: string }
  | { readonly stage: "ready_for_browser_signature"; readonly signRequest: BrowserSignRequest }
  /** ADR 0004 Phase 2 (custom_executor, or any future scheme that signs
   *  server-side rather than handing off to the owner's own browser
   *  wallet): the pipeline stops here, deliberately — signing a real
   *  transaction with real key material is out of scope for this pure,
   *  fully-unit-testable module by design (see this file's header
   *  comment). The caller (apps/worker's execution worker, which already
   *  has DB/config access this module intentionally does not) resolves
   *  the signer's session-key credential, calls packages/signing to sign,
   *  and broadcasts. */
  | {
      readonly stage: "ready_for_delegated_signature";
      readonly signer: SignerHandle;
      readonly tx: PreparedTransaction;
      readonly gasEstimate: bigint;
    };

export async function runExecutionPipeline(
  input: ExecutionPipelineInput,
  deps: ExecutionPipelineDeps,
): Promise<PipelineOutcome> {
  // 1. Policy check first — cheapest, and no reason to touch the chain for
  //    a plan that can't fire regardless (ADR 0005).
  const decision = canFireMintPlan(
    {
      status: input.planStatus,
      armedUntil: input.armedUntil,
      signerCeilingWei: input.signerCeilingWei,
      perPlanCeilingWei: input.perPlanCeilingWei,
      spentWei: input.spentWei,
    },
    deps.now(),
  );
  if (!decision.ok) {
    return { stage: "blocked_policy", reason: decision.reason };
  }

  // 2. Mandatory pre-flight simulation against current chain state — never
  //    bypassable, in every phase, permanently (ADR 0005).
  const sim = await deps.simulate({
    rpcUrl: deps.rpcUrl,
    from: input.recipientAddress,
    to: input.tx.to,
    data: input.tx.data,
    valueWei: input.tx.valueWei,
  });
  if (!sim.ok) {
    return { stage: "blocked_simulation", revertReason: sim.revertReason };
  }

  // 3. Shadow mode (ADR 0008 default): prove detection/simulation timing
  //    against real drops before any signature — real or browser-prompted
  //    — is ever requested.
  if (!deps.liveExecutionEnabled) {
    return { stage: "shadow_would_fire", gasEstimate: sim.gasEstimate };
  }

  // 4. Signer capability gate — the one place a scheme gets to say "not
  //    built yet" before any calldata reaches a UI (ADR 0004).
  try {
    assertSignable(input.signer);
  } catch (error) {
    return {
      stage: "blocked_scheme_not_implemented",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // 5. Hand off according to scheme. browser_wallet: the owner's own
  //    browser wallet signs — nothing here signs. Every other
  //    assertSignable-passing scheme (custom_executor today) signs
  //    server-side via packages/signing, which this pure module
  //    deliberately does not call directly (see PipelineOutcome's doc
  //    comment on ready_for_delegated_signature).
  if (input.signer.scheme === "browser_wallet") {
    return {
      stage: "ready_for_browser_signature",
      signRequest: toBrowserSignRequest(input.planId, input.tx),
    };
  }
  return {
    stage: "ready_for_delegated_signature",
    signer: input.signer,
    tx: input.tx,
    gasEstimate: sim.gasEstimate,
  };
}
