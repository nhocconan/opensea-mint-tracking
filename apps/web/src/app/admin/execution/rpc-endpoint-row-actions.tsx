"use client";

import { useTransition } from "react";
import { deleteRpcEndpointAction, setRpcEndpointEnabledAction } from "@/app/actions.ts";
import { ConfirmDialog } from "@/components/confirm-dialog.tsx";

export function RpcEndpointRowActions({
  id,
  chainId,
  label,
  enabled,
}: {
  id: string;
  chainId: number;
  label: string;
  enabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex gap-1.5">
      <button
        type="button"
        disabled={pending}
        aria-label={`${enabled ? "Disable" : "Enable"} endpoint`}
        onClick={() =>
          startTransition(async () => void (await setRpcEndpointEnabledAction(id, !enabled)))
        }
        className={`rounded-xs border px-2 py-0.5 text-[11px] disabled:opacity-50 ${
          enabled
            ? "border-magenta/40 text-magenta hover:bg-magenta/10"
            : "border-acid/40 text-acid hover:bg-acid/10"
        }`}
      >
        {pending ? "…" : enabled ? "Disable" : "Enable"}
      </button>
      <ConfirmDialog
        triggerLabel="Remove"
        triggerAriaLabel={`Remove endpoint ${label}`}
        triggerClassName="rounded-xs border border-line px-2 py-0.5 text-[11px] text-ink-faint hover:border-magenta/40 hover:text-magenta disabled:opacity-50"
        title="Remove RPC endpoint"
        confirmLabel="Remove endpoint"
        consequence={
          <p>
            This permanently removes the RPC endpoint{" "}
            <span className="font-mono text-ink">{label}</span>. Execution falls back to the
            remaining enabled endpoints (or <code>RPC_URL</code> if none remain).
          </p>
        }
        onConfirm={() => deleteRpcEndpointAction(id, chainId)}
      />
    </div>
  );
}
