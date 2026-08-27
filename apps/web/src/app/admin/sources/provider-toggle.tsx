"use client";

import { useTransition } from "react";
import { toggleProviderAction } from "@/app/actions.ts";

export function ProviderToggle({ kind, enabled }: { kind: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      aria-label={`${enabled ? "Disable" : "Enable"} ${kind}`}
      onClick={() => startTransition(async () => void (await toggleProviderAction(kind, !enabled)))}
      className={`rounded-xs border px-2 py-0.5 text-[11px] disabled:opacity-50 ${
        enabled
          ? "border-magenta/40 text-magenta hover:bg-magenta/10"
          : "border-acid/40 text-acid hover:bg-acid/10"
      }`}
    >
      {pending ? "…" : enabled ? "Disable" : "Enable"}
    </button>
  );
}
