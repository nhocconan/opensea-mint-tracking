"use client";

import { useActionState, useTransition } from "react";
import { type ActionState, scanNowAction, setDemoModeAction } from "@/app/actions.ts";

export function ScanNowButton() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, _formData: FormData) => scanNowAction(),
    { ok: false, message: "" },
  );
  return (
    <form action={formAction} className="flex items-center gap-2">
      <button
        type="submit"
        disabled={pending}
        className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
      >
        {pending ? "Enqueuing…" : "Run scan now"}
      </button>
      {state.message !== "" ? (
        <span
          role={state.ok ? "status" : "alert"}
          className={`text-xs ${state.ok ? "text-acid" : "text-magenta"}`}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

export function DemoModeToggle({ enabled }: { enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => void (await setDemoModeAction(!enabled)))}
      className="rounded-sm border border-amber/50 bg-amber/10 px-3 py-1.5 font-mono text-xs text-amber hover:bg-amber/20 disabled:opacity-50"
      aria-pressed={enabled}
    >
      {pending ? "…" : enabled ? "Disable demo mode" : "Enable demo mode"}
    </button>
  );
}
