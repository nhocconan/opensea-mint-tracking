/**
 * Single source of truth for building an OpenSea SeaDrop mint transaction
 * (finding #8, code review 2026-08-23). Both the speculative pre-build pass
 * (P4) and the claim-time execution pass need the identical
 * resolveOpenSeaKey → OpenSeaClient → openSeaSeaDropAdapter →
 * buildTransaction sequence; having each hand-roll its own copy meant the
 * pre-built (cached) calldata was only valid so long as the two copies
 * stayed byte-identical — any drift silently caches/broadcasts a
 * mismatched transaction on the exact mint-race hot path P4 optimizes.
 * This is that sequence, once.
 */
import { openSeaSeaDropAdapter } from "@hoodmint/execution";
import { OpenSeaClient } from "@hoodmint/providers";
import type { WorkerContext } from "./context.ts";
import { resolveOpenSeaKey } from "./credentials.ts";

export interface BuiltMintTx {
  readonly to: string;
  readonly data: string;
  readonly valueWei: string;
  readonly chainId: number;
}

/**
 * Build the ready-to-broadcast SeaDrop mint tx for a plan's target. The
 * caller resolves project/wallet (both already do, for other reasons) and
 * passes the pieces — this owns only the shared OpenSea round-trip so the
 * cached and claim-time builds can never diverge.
 */
/** OpenSea `/mint` answers that mean "stop polling — this will never sign". */
/**
 * OpenSea `/mint` answers that are terminal for the WHOLE DROP — no quantity,
 * no wallet, and no amount of waiting changes them.
 */
export function isTerminalMintBuildError(message: string): boolean {
  return /minted out|sold out|insufficient balance/i.test(message);
}

/**
 * OpenSea refusing THIS WALLET AT THIS QUANTITY — not the drop, and not the
 * plan.
 *
 * max_per_wallet on SeaDrop is cumulative across every phase, so a wallet
 * that already took 1 on a GTD phase gets "exceeds max per wallet" when it
 * asks for 2 on the FCFS phase — while a request for 1 would have succeeded.
 * Treating that as terminal threw away a mint the operator was entitled to.
 * It is also what a still-active EARLIER phase answers about a plan aimed at
 * a LATER one, before the phase the operator actually wants has opened.
 *
 * So this is never terminal on its own: inside the burst it must not stop the
 * polling (the phase may yet flip), and at the caller it is the signal to
 * rebuild at a smaller quantity.
 */
export function isPerWalletLimitError(message: string): boolean {
  return /max(?:imum)?[^.]{0,40}per wallet|already minted|exceeds/i.test(message);
}

/**
 * Signature burst for time-critical fires (SOTA on a FIFO sequencer): poll
 * OpenSea's `/mint` in PARALLEL across every Developer key at a fixed
 * cadence, unpaced, from the moment we're called until the first 200 — then
 * resolve immediately with that calldata (which, for signed_presale stages,
 * carries the one-time server signature). "Not eligible for the active
 * stage" / 5xx before OpenSea's clock flips the stage are expected and
 * ignored; terminal answers (minted out, insufficient balance) abort.
 *
 * Why: the winners of Goat Street's FCFS (2026-08-28, 1,331 mints in 2.6s)
 * were simply the wallets whose signature request landed first once the
 * stage flipped. One serialized, rate-limit-paced call per 200ms tick cannot
 * win that race; N keys × ~12 calls/s can.
 */
export async function burstBuildOpenSeaMintTx(
  ctx: WorkerContext,
  input: { slug: string; chainId: number; minter: string; quantity: number },
  opts: { maxMs: number; cadenceMs: number },
): Promise<BuiltMintTx> {
  const { db, config, log } = ctx;
  const key = await resolveOpenSeaKey(db, config.APP_ENCRYPTION_KEY, config.OPENSEA_API_KEY);
  const keys = key.apiKeys.length > 0 ? key.apiKeys : key.apiKey !== undefined ? [key.apiKey] : [];
  if (keys.length === 0) {
    return buildOpenSeaMintTx(ctx, input);
  }
  // One UNPACED client per key: the process-wide token bucket is for the
  // background sweeps, not the fire instant.
  const clients = keys.map((apiKey) => new OpenSeaClient({ apiKey }));
  const deadline = Date.now() + opts.maxMs;
  const penalized = new Map<number, number>();
  let attempts = 0;
  let lastError = "no attempt";
  return new Promise<BuiltMintTx>((resolve, reject) => {
    let settled = false;
    let inFlight = 0;
    let i = 0;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearInterval(timer);
        fn();
      }
    };
    const fire = () => {
      if (settled) {
        return;
      }
      if (Date.now() > deadline) {
        if (inFlight === 0) {
          finish(() =>
            reject(new Error(`signature burst timed out after ${attempts} attempts: ${lastError}`)),
          );
        }
        return;
      }
      const idx = i % clients.length;
      i += 1;
      if ((penalized.get(idx) ?? 0) > Date.now()) {
        return;
      }
      const client = clients[idx];
      if (client === undefined) {
        return;
      }
      attempts += 1;
      inFlight += 1;
      const t0 = Date.now();
      client
        .buildDropMintTransaction(input.slug, { minter: input.minter, quantity: input.quantity })
        .then((tx) => {
          finish(() => {
            log.info(
              { slug: input.slug, attempts, ms: Date.now() - t0, keys: keys.length },
              "signature burst: mint calldata obtained",
            );
            resolve({
              to: tx.target,
              data: tx.calldata,
              valueWei: tx.valueWei,
              chainId: input.chainId,
            });
          });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          lastError = message.replace(/\s+/g, " ").slice(0, 160);
          if (/429|rate limit/i.test(message)) {
            penalized.set(idx, Date.now() + 1_500);
          }
          // A per-wallet-limit answer must NOT stop the burst. Before the
          // target phase opens, OpenSea answers about whichever phase is
          // active now — so this is routinely a statement about a DIFFERENT
          // phase, and aborting here permanently failed a plan whose phase
          // had not opened yet. Keep polling; the caller decides what to do
          // with it once the burst returns.
          if (isTerminalMintBuildError(message) && !isPerWalletLimitError(message)) {
            finish(() => reject(error instanceof Error ? error : new Error(message)));
          }
        })
        .finally(() => {
          inFlight -= 1;
          if (!settled && Date.now() > deadline && inFlight === 0) {
            finish(() =>
              reject(
                new Error(`signature burst timed out after ${attempts} attempts: ${lastError}`),
              ),
            );
          }
        });
    };
    const timer = setInterval(fire, opts.cadenceMs);
    fire();
  });
}

export async function buildOpenSeaMintTx(
  ctx: WorkerContext,
  input: { slug: string; chainId: number; minter: string; quantity: number },
): Promise<BuiltMintTx> {
  const { db, config } = ctx;
  const key = await resolveOpenSeaKey(db, config.APP_ENCRYPTION_KEY, config.OPENSEA_API_KEY);
  const client = new OpenSeaClient({
    apiKey: key.apiKey,
    apiKeys: key.apiKeys,
    perMinuteLimit: config.OPENSEA_PER_MINUTE_LIMIT,
  });
  const adapter = openSeaSeaDropAdapter(client, input.slug);
  const tx = await adapter.buildTransaction({
    chainId: input.chainId,
    minter: input.minter,
    quantity: input.quantity,
  });
  return { to: tx.to, data: tx.data, valueWei: tx.valueWei, chainId: tx.chainId };
}

/**
 * Is a provider "minted out" answer terminal for THIS plan?
 *
 * OpenSea's /mint takes no stage argument — it answers about whichever stage
 * it currently considers active, and its clock trails ours by a measured
 * 343-1200 ms. So a "minted out" arriving around our stage start is usually a
 * statement about the PREVIOUS phase, whose allocation is naturally spent by
 * then, not about ours.
 *
 * The first version of this guard compared `now >= fireTarget` and nothing
 * else. That protects the wrong half of the window: on the 2026-09-16 21:30
 * projectcpu FCFS the plan was killed at T+2 s on a 422 about the GTD phase,
 * and the collection then minted 14,774 more tokens in eight minutes
 * (10,517 -> 25,291 of 29,150) with our plan already dead.
 *
 * So the clock is no longer the authority; the contract is (playbook §4).
 * `getMintStats` reports the collection's real supply, and a drop with
 * tokens left is not minted out no matter what the message says — a spent
 * per-stage `maxTokenSupplyForStage` reads identically from the outside.
 * Retrying stays bounded by the plan deadline and revert cap, so this cannot
 * run away.
 */
export const MINTED_OUT_CLOCK_LAG_GRACE_MS = 5_000;

export function mintedOutIsTerminal(input: {
  nowMs: number;
  fireTargetMs: number | null;
  /** On-chain supply, when `getMintStats` could be read. */
  supply?: { currentTotalSupply: bigint; maxSupply: bigint } | null;
  graceMs?: number;
}): boolean {
  // The contract wins. Tokens left ⇒ the drop is not minted out, and the
  // message is about a phase allocation or a stage we have not reached.
  if (input.supply != null && input.supply.maxSupply > 0n) {
    return input.supply.currentTotalSupply >= input.supply.maxSupply;
  }
  // No supply reading: fall back to the clock, but only past a grace wide
  // enough to cover OpenSea's lag, so T+2 s can never be terminal again.
  if (input.fireTargetMs === null) {
    // No known target: we cannot argue it is early, so trust the provider.
    return true;
  }
  return input.nowMs >= input.fireTargetMs + (input.graceMs ?? MINTED_OUT_CLOCK_LAG_GRACE_MS);
}

/**
 * What the CONTRACT says a plan may still do, before OpenSea is asked anything.
 *
 * Two facts decide every contested allowlist mint and neither was read before
 * the burst: how many tokens this wallet may still mint, and whether the
 * collection has supply. Without them the fire path could only learn its fate
 * by failing at T+0 and then guessing from an OpenSea error string — and that
 * string describes whichever phase OpenSea currently considers active, not the
 * one the plan targets. Every failure of the last few days is that guess.
 *
 * `cap` is the stage's cumulative `maxTotalMintableByWallet` (from
 * eligibility_checks); null means unknown, in which case the wallet's
 * allowance cannot be argued about and the request is left at full size.
 */
export type PrecheckVerdict =
  | { verdict: "ok"; quantity: number }
  | { verdict: "minted_out" }
  | { verdict: "allowance_exhausted"; cap: number };

export function precheckAllowance(input: {
  requested: number;
  cap: number | null;
  minterNumMinted: bigint;
  currentTotalSupply: bigint;
  maxSupply: bigint;
}): PrecheckVerdict {
  // maxSupply 0 means the contract does not publish a cap; treat supply as
  // unbounded rather than as exhausted.
  const supplyLeft =
    input.maxSupply > 0n
      ? Number(input.maxSupply - input.currentTotalSupply)
      : Number.MAX_SAFE_INTEGER;
  if (supplyLeft <= 0) {
    return { verdict: "minted_out" };
  }
  if (input.cap !== null) {
    const remaining = input.cap - Number(input.minterNumMinted);
    if (remaining <= 0) {
      // Terminal from a contract fact, not a string: the cumulative cap is
      // spent, so no signature OpenSea could issue would pass
      // _checkMintQuantity. Retrying is pure API spend.
      return { verdict: "allowance_exhausted", cap: input.cap };
    }
    return {
      verdict: "ok",
      quantity: Math.max(1, Math.min(input.requested, remaining, supplyLeft)),
    };
  }
  return { verdict: "ok", quantity: Math.max(1, Math.min(input.requested, supplyLeft)) };
}
