"use client";

import { useActionState } from "react";
import { type ActionState, refreshRarityAction } from "@/app/actions.ts";

export function RarityRefreshButton({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, _formData: FormData) => refreshRarityAction(projectId),
    { ok: false, message: "" },
  );
  return (
    <form action={formAction} className="flex items-center gap-2">
      <button
        type="submit"
        disabled={pending}
        className="rounded-sm border border-acid/50 bg-acid/15 px-2 py-1 font-mono text-[11px] text-acid hover:bg-acid/25 disabled:opacity-50"
      >
        {pending ? "Enqueuing…" : "Refresh rarity"}
      </button>
      {state.message !== "" ? (
        <span
          role={state.ok ? "status" : "alert"}
          className={`text-[11px] ${state.ok ? "text-acid" : "text-magenta"}`}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
