"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { armSpecialMintPlansAction, type SpecialMintArmState } from "@/app/actions.ts";
import { authClient } from "@/lib/auth-client.ts";
import { shortAddress } from "@/lib/format.ts";

/**
 * One passkey ceremony, every draft plan armed. The ceremony runs here in
 * the browser but proves nothing by itself — `armSpecialMintPlansAction`
 * re-verifies server-side (`requireFreshStepUp`, ADR 0008) that a real
 * WebAuthn assertion just succeeded. The step-up stamp is valid for two
 * minutes, which is what makes arming the whole batch on one verification
 * legitimate rather than a shortcut.
 */
export function ArmAllControl({
  plans,
}: {
  plans: { id: string; walletAddress: string; quantity: number }[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SpecialMintArmState | null>(null);
  const [pending, startTransition] = useTransition();

  const byId = new Map(plans.map((p) => [p.id, p]));

  return (
    <section className="rounded-md border border-magenta/40 bg-magenta/5 p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-magenta uppercase">
        5 · Arm all
      </h2>
      <p className="mt-1 text-[11px] text-ink-faint">
        Arms {plans.length} draft plan(s) after a single passkey verification. The window is derived
        server-side from each plan's own phase end (capped 24h) or manual fire time + 4h. Armed
        plans expire on their own — arming is never open-ended.
      </p>
      <button
        type="button"
        disabled={pending || plans.length === 0}
        onClick={() =>
          startTransition(async () => {
            setState(null);
            const signIn = await authClient.signIn.passkey();
            if (signIn?.error) {
              setState({
                ok: false,
                message: signIn.error.message ?? "Passkey verification failed or was cancelled.",
                results: [],
              });
              return;
            }
            const result = await armSpecialMintPlansAction(plans.map((p) => p.id));
            setState(result);
            router.refresh();
          })
        }
        className="mt-3 rounded-sm border border-magenta/50 bg-magenta/15 px-3 py-1.5 font-mono text-xs text-magenta hover:bg-magenta/25 disabled:opacity-50"
      >
        {pending ? "Verifying…" : `Verify passkey + arm all (${plans.length})`}
      </button>
      {state !== null ? (
        <div className="mt-2">
          <p
            role={state.ok ? "status" : "alert"}
            className={`text-xs ${state.ok ? "text-acid" : "text-magenta"}`}
          >
            {state.message}
          </p>
          {state.results.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {state.results.map((r) => {
                const plan = byId.get(r.planId);
                return (
                  <li key={r.planId} className="font-mono text-[11px]">
                    <span className="text-ink-muted">
                      {plan === undefined
                        ? r.planId.slice(0, 8)
                        : `${shortAddress(plan.walletAddress)} ×${plan.quantity}`}
                    </span>{" "}
                    <span className={r.ok ? "text-acid" : "text-magenta"}>{r.message}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
