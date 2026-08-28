"use client";

import { useTransition } from "react";
import { deleteAlertChannelAction, setAlertChannelEnabledAction } from "@/app/actions.ts";
import { ConfirmDialog } from "@/components/confirm-dialog.tsx";

export function ChannelRowActions({
  id,
  name,
  kind,
  enabled,
}: {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={pending}
        aria-label={enabled ? "Disable channel" : "Enable channel"}
        onClick={() =>
          startTransition(async () => void (await setAlertChannelEnabledAction(id, !enabled)))
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
        triggerLabel="Delete"
        triggerAriaLabel={`Delete channel ${name}`}
        title="Delete alert channel"
        confirmLabel="Delete channel"
        consequence={
          <p>
            This permanently removes the <span className="font-mono text-ink">{kind}</span> channel
            &ldquo;{name}&rdquo; and revokes its stored credential (bot token / webhook URL). Alerts
            will no longer be delivered here.
          </p>
        }
        onConfirm={() => deleteAlertChannelAction(id)}
      />
    </span>
  );
}
