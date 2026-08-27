"use client";

import { useState, useTransition } from "react";
import { armMintPlanAction, disarmMintPlanAction } from "@/app/actions.ts";
import { authClient } from "@/lib/auth-client.ts";

/**
 * The step-up ceremony lives here, client-side, but proves nothing by
 * itself — `armMintPlanAction` re-checks server-side (packages/auth's
 * `after` hook + `requireFreshStepUp`) that a real WebAuthn assertion just
 * verified, not merely that this button was clicked (ADR 0008).
 */
export function ArmControls({ id }: { id: string }) {
  const [windowMinutes, setWindowMinutes] = useState(5);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={1}
        max={60}
        value={windowMinutes}
        onChange={(e) => setWindowMinutes(Number.parseInt(e.target.value, 10) || 5)}
        aria-label="Arm window (minutes)"
        className="w-14 rounded-xs border border-line bg-base px-1.5 py-0.5 font-mono text-[11px]"
      />
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setStatus(null);
            const signIn = await authClient.signIn.passkey();
            if (signIn?.error) {
              setStatus({
                ok: false,
                message: signIn.error.message ?? "Passkey verification failed or was cancelled.",
              });
              return;
            }
            const result = await armMintPlanAction(id, windowMinutes);
            setStatus(result);
          })
        }
        className="rounded-xs border border-magenta/40 px-2 py-0.5 text-[11px] text-magenta hover:bg-magenta/10 disabled:opacity-50"
      >
        {pending ? "Verifying…" : "Verify + Arm"}
      </button>
      {status !== null ? (
        <span
          role={status.ok ? "status" : "alert"}
          className={status.ok ? "text-[11px] text-acid" : "text-[11px] text-magenta"}
        >
          {status.message}
        </span>
      ) : null}
    </div>
  );
}

export function DisarmControl({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => void (await disarmMintPlanAction(id)))}
      className="rounded-xs border border-line px-2 py-0.5 text-[11px] text-ink-faint hover:border-magenta/40 hover:text-magenta disabled:opacity-50"
    >
      {pending ? "…" : "Disarm"}
    </button>
  );
}
