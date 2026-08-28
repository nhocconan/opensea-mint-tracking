import {
  listExecutionAttempts,
  listMintPlans,
  listPendingSignatures,
  listRpcEndpoints,
  listSigners,
  listWallets,
} from "@hoodmint/db";
import { classifyLatency, getGasSnapshot } from "@hoodmint/providers";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc, shortAddress } from "@/lib/format.ts";
import { requirePage } from "@/lib/session.ts";
import { BrowserSignPrompt } from "./browser-sign-prompt.tsx";
import { ExecutorOnboarding } from "./executor-onboarding.tsx";
import { ArmControls, DisarmControl } from "./mint-plan-controls.tsx";
import { MintPlanForm } from "./mint-plan-form.tsx";
import { PasskeyRegistration } from "./passkey-registration.tsx";
import { RpcEndpointForm } from "./rpc-endpoint-form.tsx";
import { RpcEndpointRowActions } from "./rpc-endpoint-row-actions.tsx";
import { SignerForm } from "./signer-form.tsx";
import { SignerRowActions } from "./signer-row-actions.tsx";

export const dynamic = "force-dynamic";

/**
 * Admin → Execution (ADR 0003–0008; docs/execution-architecture.md).
 * Phase 1: RPC endpoints and browser-wallet signers are live and
 * configurable here. Draft mint plans can be armed once a passkey is
 * registered — arming requires a fresh WebAuthn ceremony re-verified
 * server-side (`requireFreshStepUp`), not merely a valid admin session.
 * Even armed and firing, only `browser_wallet` can ever sign anything, and
 * LIVE_EXECUTION_ENABLED defaults false (shadow mode).
 */
export default async function AdminExecutionPage() {
  await requirePage("execution:configure");
  const { db, config } = container();
  const [rpcEndpoints, signers, mintPlans, attempts, pendingSignatures, wallets] =
    await Promise.all([
      listRpcEndpoints(db).catch(() => []),
      listSigners(db).catch(() => []),
      listMintPlans(db, 25).catch(() => []),
      listExecutionAttempts(db, 25).catch(() => []),
      listPendingSignatures(db).catch(() => []),
      listWallets(db).catch(() => []),
    ]);

  // Gas/RPC health widget (feature backlog): best-effort, bounded, never
  // blocks the page on a dead endpoint. Capped at 10 so a large endpoint
  // list can't turn this into a slow page load.
  const gasSnapshots = new Map<string, { gwei: string; latency: string; class: string }>();
  await Promise.allSettled(
    rpcEndpoints
      .filter((e) => e.enabled)
      .slice(0, 10)
      .map(async (e) => {
        const snapshot = await getGasSnapshot(e.httpUrl);
        gasSnapshots.set(e.id, {
          gwei: (Number(snapshot.gasPriceWei) / 1e9).toFixed(2),
          latency: `${snapshot.latencyMs}ms`,
          class: classifyLatency(snapshot.latencyMs),
        });
      }),
  );

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-magenta/30 bg-magenta/5 p-4">
        <h2 className="font-mono text-[11px] tracking-widest text-magenta uppercase">
          Execution — opt-in, not the default radar
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          Live execution is{" "}
          <span className={config.LIVE_EXECUTION_ENABLED ? "text-magenta" : "text-acid"}>
            {config.LIVE_EXECUTION_ENABLED ? "ENABLED" : "shadow mode (dry-run only)"}
          </span>{" "}
          — set by <code className="font-mono">LIVE_EXECUTION_ENABLED</code>. Even when enabled,
          only two signer schemes can ever sign anything:{" "}
          <code className="font-mono">browser_wallet</code> (the owner's own wallet, per
          transaction) and <code className="font-mono">custom_executor</code> (ADR 0004's Executor
          contract fallback — a hot session key, capped and recipient-pinned on-chain, no human in
          the loop once activated). <code className="font-mono">eip7702_safe_zodiac</code> is not
          buildable on real Ledger hardware today (device firmware only whitelists the Ethereum
          Foundation's reference 7702 delegate, not Safe's — see ADR 0004's 2026-08-22 amendment)
          and remains refused. No hardware wallet is ever an automated signer in any scheme — a
          Ledger only ever signs the onboarding/allowlist steps below, individually, never a live
          mint. See <code className="font-mono">docs/execution-architecture.md</code>.
        </p>
      </section>

      <PasskeyRegistration />

      {pendingSignatures.length > 0 ? (
        <section className="rounded-md border border-magenta/40 bg-magenta/10 p-4">
          <h2 className="mb-2 font-mono text-[11px] tracking-widest text-magenta uppercase">
            Waiting on your wallet
          </h2>
          <div className="space-y-2">
            {pendingSignatures.map((a) =>
              a.pendingTx !== null ? (
                <BrowserSignPrompt
                  key={a.id}
                  attemptId={a.id}
                  to={a.pendingTx.to}
                  data={a.pendingTx.data}
                  valueWei={a.pendingTx.valueWei}
                  chainId={a.pendingTx.chainId}
                />
              ) : null,
            )}
          </div>
        </section>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <RpcEndpointForm defaultChainId={config.ROBINHOOD_CHAIN_ID} />

        <section className="rounded-md border border-line bg-base-raised p-4">
          <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
            RPC endpoints
          </h2>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] text-ink-faint uppercase">
                <th scope="col" className="py-1 font-normal">
                  Chain
                </th>
                <th scope="col" className="py-1 font-normal">
                  Label
                </th>
                <th scope="col" className="py-1 font-normal">
                  Health
                </th>
                <th scope="col" className="py-1 font-normal">
                  Gas / latency
                </th>
                <th scope="col" className="py-1 font-normal">
                  Priority
                </th>
                <th scope="col" className="py-1 font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rpcEndpoints.map((e) => {
                const gas = gasSnapshots.get(e.id);
                return (
                  <tr key={e.id} className={e.enabled ? "" : "opacity-50"}>
                    <td className="py-1">{e.chainId}</td>
                    <td className="py-1" title={e.httpUrl}>
                      {e.label}
                    </td>
                    <td
                      className={
                        e.healthStatus === "healthy"
                          ? "text-acid"
                          : e.healthStatus === "down"
                            ? "text-magenta"
                            : "text-ink-faint"
                      }
                    >
                      {e.healthStatus}
                    </td>
                    <td
                      className={
                        gas === undefined
                          ? "py-1 text-ink-faint"
                          : gas.class === "slow"
                            ? "py-1 text-amber"
                            : "py-1 text-ink-muted"
                      }
                    >
                      {gas === undefined ? "—" : `${gas.gwei} gwei · ${gas.latency}`}
                    </td>
                    <td className="py-1">{e.priority}</td>
                    <td className="py-1">
                      <RpcEndpointRowActions id={e.id} chainId={e.chainId} enabled={e.enabled} />
                    </td>
                  </tr>
                );
              })}
              {rpcEndpoints.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-2 text-ink-faint">
                    No custom RPC endpoints — falls back to <code>RPC_URL</code>.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <SignerForm defaultChainId={config.ROBINHOOD_CHAIN_ID} />

        <section className="rounded-md border border-line bg-base-raised p-4">
          <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
            Signers
          </h2>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] text-ink-faint uppercase">
                <th scope="col" className="py-1 font-normal">
                  Chain
                </th>
                <th scope="col" className="py-1 font-normal">
                  Owner
                </th>
                <th scope="col" className="py-1 font-normal">
                  Scheme
                </th>
                <th scope="col" className="py-1 font-normal">
                  Status
                </th>
                <th scope="col" className="py-1 font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {signers.map((s) => (
                <tr key={s.id}>
                  <td className="py-1">{s.chainId}</td>
                  <td className="py-1" title={s.ownerAddress}>
                    {shortAddress(s.ownerAddress)}
                  </td>
                  <td className="py-1">{s.scheme}</td>
                  <td className={s.status === "active" ? "py-1 text-acid" : "py-1 text-ink-faint"}>
                    {s.status}
                  </td>
                  <td className="py-1">
                    <SignerRowActions id={s.id} status={s.status} />
                  </td>
                </tr>
              ))}
              {signers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-2 text-ink-faint">
                    No signers registered yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      </div>

      <ExecutorOnboarding defaultChainId={config.ROBINHOOD_CHAIN_ID} />

      <MintPlanForm
        wallets={wallets}
        signers={signers
          .filter((s) => s.status === "active")
          .map((s) => ({ id: s.id, ownerAddress: s.ownerAddress, scheme: s.scheme }))}
      />

      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Mint plans
        </h2>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] text-ink-faint uppercase">
              <th scope="col" className="py-1 font-normal">
                Status
              </th>
              <th scope="col" className="py-1 font-normal">
                Qty
              </th>
              <th scope="col" className="py-1 font-normal">
                Per-plan ceiling (wei)
              </th>
              <th scope="col" className="py-1 font-normal">
                Armed until
              </th>
              <th scope="col" className="py-1 font-normal">
                Created
              </th>
              <th scope="col" className="py-1 font-normal">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {mintPlans.map((p) => (
              <tr key={p.id}>
                <td
                  className={`py-1 ${
                    p.status === "armed" || p.status === "executing"
                      ? "text-magenta"
                      : p.status === "executed"
                        ? "text-acid"
                        : "text-ink-faint"
                  }`}
                >
                  {p.status}
                </td>
                <td className="py-1">{p.quantity}</td>
                <td className="py-1">{p.perPlanCeilingWei}</td>
                <td className="py-1">{formatDateTimeUtc(p.armedUntil)}</td>
                <td className="py-1 text-ink-faint">{formatDateTimeUtc(p.createdAt)}</td>
                <td className="py-1">
                  {p.status === "draft" ? <ArmControls id={p.id} /> : null}
                  {p.status === "armed" ? <DisarmControl id={p.id} /> : null}
                </td>
              </tr>
            ))}
            {mintPlans.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-2 text-ink-faint">
                  No mint plans yet — create one above.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Execution history
        </h2>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] text-ink-faint uppercase">
              <th scope="col" className="py-1 font-normal">
                Status
              </th>
              <th scope="col" className="py-1 font-normal">
                Tx hash
              </th>
              <th scope="col" className="py-1 font-normal">
                Error
              </th>
              <th scope="col" className="py-1 font-normal">
                At
              </th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {attempts.map((a) => (
              <tr key={a.id}>
                <td
                  className={`py-1 ${
                    a.status === "confirmed"
                      ? "text-acid"
                      : a.status === "failed" || a.status === "simulated_revert"
                        ? "text-magenta"
                        : "text-cyan"
                  }`}
                >
                  {a.status}
                </td>
                <td className="py-1">{a.txHash ? shortAddress(a.txHash) : "—"}</td>
                <td className="py-1 text-ink-faint">{a.errorCode ?? "—"}</td>
                <td className="py-1 text-ink-faint">{formatDateTimeUtc(a.attemptAt)}</td>
              </tr>
            ))}
            {attempts.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-2 text-ink-faint">
                  No execution attempts yet — immutable audit trail once mint plans start firing.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
