"use client";

import { useTransition } from "react";
import { deleteRpcEndpointAction, setRpcEndpointEnabledAction } from "@/app/actions.ts";

export function RpcEndpointRowActions({
  id,
  chainId,
  enabled,
}: {
  id: string;
  chainId: number;
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
      <button
        type="button"
        disabled={pending}
        aria-label="Remove endpoint"
        onClick={() =>
          startTransition(async () => void (await deleteRpcEndpointAction(id, chainId)))
        }
        className="rounded-xs border border-line px-2 py-0.5 text-[11px] text-ink-faint hover:border-magenta/40 hover:text-magenta disabled:opacity-50"
      >
        {pending ? "…" : "Remove"}
      </button>
    </div>
  );
}
