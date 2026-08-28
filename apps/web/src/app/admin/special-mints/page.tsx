import {
  type ExecutionAttempt,
  getProjectDetail,
  latestAttemptPerPlan,
  listMintPlanHistory,
  listMintPlansForProject,
  listWallets,
} from "@hoodmint/db";
import type { Metadata } from "next";
import Link from "next/link";
import { Countdown } from "@/components/feed-parts.tsx";
import { container } from "@/lib/container.ts";
import { formatDateTimeGmt7, shortAddress, toDate } from "@/lib/format.ts";
import { requirePage } from "@/lib/session.ts";
import { DeleteDraftPlanControl, DisarmControl } from "../execution/mint-plan-controls.tsx";
import { ArmAllControl } from "./arm-all-control.tsx";
import {
  type ManagedWalletOption,
  SpecialMintForm,
  type StageOption,
} from "./special-mint-form.tsx";
import { TargetForm } from "./target-form.tsx";

export const metadata: Metadata = { title: "Special mints" };
export const dynamic = "force-dynamic";

function isUuidParam(value: string | string[] | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Admin → Special mints: the dedicated sniper console (admin-only, gated on
 * `execution:configure`). Pick a collection + phase, fan the plan out across
 * managed wallets with per-wallet quantities, confirm or override the fire
 * instant in GMT+7, arm the whole batch behind one passkey step-up, and
 * watch the board.
 *
 * Nothing new happens at fire time: these are ordinary `mint_plans` rows, so
 * they ride the same armed→executing atomic claim, the same 200 ms precision
 * hot loop, the same pre-sign fast path and the same LIVE_EXECUTION_ENABLED
 * shadow-mode gate as any other plan. The only addition is `fire_at`, which
 * takes precedence over the stage start as the hot loop's fire target.
 */
export default async function AdminSpecialMintsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage("execution:configure");
  const params = await searchParams;
  const projectId = isUuidParam(params.projectId) ? params.projectId : null;
  const { db, config } = container();

  const [detail, walletRows] = await Promise.all([
    projectId === null
      ? Promise.resolve(undefined)
      : getProjectDetail(db, projectId).catch(() => undefined),
    listWallets(db, { enabledOnly: true }).catch(() => []),
  ]);
  const managedWallets: ManagedWalletOption[] = walletRows
    .filter((w) => w.hasSigningKey)
    .map((w) => ({ id: w.id, address: w.address, label: w.label }));

  const plans =
    detail === undefined
      ? []
      : await listMintPlansForProject(db, detail.project.id).catch(() => []);
  // Durable history across every collection: what fired, what minted, what
  // failed and why — plans are never deleted once armed.
  const history = await listMintPlanHistory(db, 200).catch(() => []);
  const attempts = await latestAttemptPerPlan(db, [
    ...new Set([...plans.map((p) => p.id), ...history.map((p) => p.id)]),
  ]).catch(() => new Map<string, ExecutionAttempt>());

  const stages: StageOption[] =
    detail === undefined
      ? []
      : detail.stages.map((s) => ({
          id: s.id,
          label: s.label,
          kind: s.type,
          priceWei: s.priceWei,
          startsAt: toDate(s.startsAt).toISOString(),
          endsAt: s.endsAt === null ? null : toDate(s.endsAt).toISOString(),
          maxPerWallet: s.maxPerWallet,
        }));

  // Latest supply snapshot (the worker's on-chain sweep writes one every
  // 2 min for LIVE/NEXT drops). Sold out = verified minted >= max.
  const latestSupply =
    detail === undefined
      ? undefined
      : [...detail.supply].sort(
          (a, b) => toDate(b.observedAt).getTime() - toDate(a.observedAt).getTime(),
        )[0];
  const soldOut =
    latestSupply !== undefined &&
    latestSupply.verified &&
    latestSupply.maxSupply !== null &&
    latestSupply.minted >= latestSupply.maxSupply;

  const draftPlans = plans
    .filter((p) => p.status === "draft")
    .map((p) => ({ id: p.id, walletAddress: p.walletAddress, quantity: p.quantity }));

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-magenta/30 bg-magenta/5 p-4">
        <h2 className="font-mono text-[11px] tracking-widest text-magenta uppercase">
          Special mints — admin-only sniper console
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          Live execution is{" "}
          <span className={config.LIVE_EXECUTION_ENABLED ? "text-magenta" : "text-acid"}>
            {config.LIVE_EXECUTION_ENABLED ? "ENABLED" : "shadow mode (dry-run only)"}
          </span>
          . Plans created here are ordinary mint plans — same atomic claim, same 200 ms precision
          hot loop, same pre-sign fast path, same spend ceilings — with an explicit fire instant
          that overrides the published phase start. Times are entered and shown in{" "}
          <strong>GMT+7</strong> and stored in UTC. For RPC endpoints, signers and the full plan
          list see{" "}
          <Link href="/admin/execution" className="text-acid underline">
            Admin → Execution
          </Link>
          .
        </p>
      </section>

      <TargetForm currentTarget={detail?.project.slug ?? detail?.project.contractAddress ?? ""} />

      {detail === undefined ? (
        <section className="rounded-md border border-line bg-base-raised p-4">
          <p className="text-xs text-ink-faint">
            Resolve a collection above to pick its phase, wallets and fire time.
          </p>
        </section>
      ) : (
        <>
          <section className="rounded-md border border-acid/30 bg-base-raised p-4">
            <h2 className="font-display text-base font-semibold tracking-tight">
              {detail.project.name}
            </h2>
            <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-[10px] text-ink-faint uppercase">Slug</dt>
                <dd className="font-mono text-ink-muted">{detail.project.slug ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-[10px] text-ink-faint uppercase">Contract</dt>
                <dd className="font-mono text-ink-muted">
                  {detail.project.contractAddress === null
                    ? "—"
                    : shortAddress(detail.project.contractAddress)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] text-ink-faint uppercase">Chain</dt>
                <dd className="font-mono text-ink-muted">{detail.project.chainId}</dd>
              </div>
              <div>
                <dt className="text-[10px] text-ink-faint uppercase">Supply (on-chain)</dt>
                <dd className={`font-mono ${soldOut ? "text-magenta" : "text-ink-muted"}`}>
                  {latestSupply === undefined
                    ? "not read yet"
                    : `${latestSupply.minted.toString()} / ${latestSupply.maxSupply?.toString() ?? "?"}`}
                  {soldOut ? " · SOLD OUT" : ""}
                </dd>
              </div>
            </dl>
            {soldOut ? (
              <p className="mt-2 rounded-sm border border-magenta/40 bg-magenta/10 px-2 py-1 text-xs text-magenta">
                Every token is already minted on-chain — later phases have nothing left to sell.
                Arming a plan here will fail with “minted out”.
              </p>
            ) : null}
          </section>

          <SpecialMintForm projectId={detail.project.id} stages={stages} wallets={managedWallets} />

          {draftPlans.length > 0 ? <ArmAllControl plans={draftPlans} /> : null}

          <section className="rounded-md border border-line bg-base-raised p-4">
            <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
              Status board — {detail.project.name}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-[10px] text-ink-faint uppercase">
                    <th scope="col" className="py-1 font-normal">
                      Wallet
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      Qty
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      Status
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      Fires at (GMT+7)
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      In
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      Armed until
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      Pre-signed
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      Last attempt
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {plans.map((p) => {
                    // fire_at wins over the stage start — the same precedence
                    // the worker's hot loop applies.
                    const fireAt =
                      p.fireAt !== null
                        ? toDate(p.fireAt)
                        : p.stageStartsAt !== null
                          ? toDate(p.stageStartsAt)
                          : null;
                    const fireIso = fireAt === null ? null : fireAt.toISOString();
                    const attempt = attempts.get(p.id);
                    return (
                      <tr key={p.id}>
                        <td className="py-1" title={p.walletAddress}>
                          {p.walletLabel ?? shortAddress(p.walletAddress)}
                        </td>
                        <td className="py-1">{p.quantity}</td>
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
                        <td className="py-1 text-ink-muted">
                          {formatDateTimeGmt7(fireIso)}
                          <span className="block text-[10px] text-ink-faint">
                            {p.fireAt !== null
                              ? " · manual"
                              : p.stageLabel !== null
                                ? ` · ${p.stageLabel}`
                                : ""}
                          </span>
                        </td>
                        <td className="py-1">
                          <Countdown iso={fireIso} label="Fire" />
                        </td>
                        <td className="py-1 text-ink-faint">
                          {p.armedUntil === null ? "—" : formatDateTimeGmt7(toDate(p.armedUntil))}
                        </td>
                        <td className={p.presigned ? "py-1 text-acid" : "py-1 text-ink-faint"}>
                          {p.presigned ? "yes" : "no"}
                        </td>
                        <td className="py-1 text-ink-faint">
                          {attempt === undefined
                            ? "—"
                            : `${attempt.status}${
                                attempt.txHash !== null ? ` · ${shortAddress(attempt.txHash)}` : ""
                              }${attempt.errorCode !== null ? ` · ${attempt.errorCode}` : ""}`}
                        </td>
                        <td className="py-1">
                          {/* Reuses Admin → Execution's own controls: the same
                              draft-only delete and the same disarm, so a
                              batch armed here can be stood down here too
                              rather than hunted for on the other page. */}
                          {p.status === "draft" ? <DeleteDraftPlanControl id={p.id} /> : null}
                          {p.status === "armed" ? <DisarmControl id={p.id} /> : null}
                        </td>
                      </tr>
                    );
                  })}
                  {plans.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-2 text-ink-faint">
                        No plans for this collection yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="mb-1 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          History — every special mint, newest first
        </h2>
        <p className="mb-2 text-[11px] text-ink-faint">
          Outcome = the plan's final status plus its last execution attempt (tx hash on success,
          error on failure). Plans stay here forever once armed; drafts disappear if deleted.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] text-ink-faint uppercase">
                <th scope="col" className="py-1 font-normal">
                  Collection
                </th>
                <th scope="col" className="py-1 font-normal">
                  Phase
                </th>
                <th scope="col" className="py-1 font-normal">
                  Wallet
                </th>
                <th scope="col" className="py-1 font-normal">
                  Qty
                </th>
                <th scope="col" className="py-1 font-normal">
                  Fired at (GMT+7)
                </th>
                <th scope="col" className="py-1 font-normal">
                  Outcome
                </th>
                <th scope="col" className="py-1 font-normal">
                  Detail
                </th>
              </tr>
            </thead>
            <tbody>
              {history.map((p) => {
                const attempt = attempts.get(p.id);
                const fireIso =
                  p.fireAt !== null
                    ? toDate(p.fireAt).toISOString()
                    : p.stageStartsAt !== null
                      ? toDate(p.stageStartsAt).toISOString()
                      : null;
                const success = p.status === "executed" && attempt?.txHash != null;
                const failure = p.status === "failed" || p.status === "expired";
                return (
                  <tr key={p.id} className="border-t border-line/60">
                    <td className="py-1">
                      <Link
                        href={`/admin/special-mints?projectId=${p.projectId}`}
                        className="text-ink hover:text-cyan"
                      >
                        {p.projectName}
                      </Link>
                    </td>
                    <td className="py-1 text-ink-muted">
                      {p.stageLabel ?? (p.fireAt !== null ? "manual time" : "—")}
                    </td>
                    <td className="py-1 font-mono text-ink-muted">
                      {p.walletLabel ?? shortAddress(p.walletAddress)}
                    </td>
                    <td className="py-1">{p.quantity}</td>
                    <td className="py-1 text-ink-muted">
                      {fireIso === null ? "—" : formatDateTimeGmt7(fireIso)}
                    </td>
                    <td
                      className={`py-1 font-mono ${
                        success ? "text-acid" : failure ? "text-magenta" : "text-ink-muted"
                      }`}
                    >
                      {success ? "MINTED" : failure ? p.status.toUpperCase() : p.status}
                    </td>
                    <td className="py-1 font-mono text-[11px] text-ink-faint">
                      {attempt === undefined
                        ? "—"
                        : attempt.txHash !== null
                          ? shortAddress(attempt.txHash)
                          : (attempt.errorCode ?? attempt.status)}
                    </td>
                  </tr>
                );
              })}
              {history.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-2 text-ink-faint">
                    No special mints yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
