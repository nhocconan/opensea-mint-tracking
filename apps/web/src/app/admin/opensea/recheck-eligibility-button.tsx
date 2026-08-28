"use client";

import { useActionState } from "react";
import { type ActionState, recheckEligibilityAction } from "@/app/actions.ts";

const initial: ActionState = { ok: false, message: "" };

/** Force all "AUTH NEEDED" eligibility verdicts to recheck now. */
export function RecheckEligibilityButton() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState) => recheckEligibilityAction(),
    initial,
  );
  return (
    <form action={formAction} className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="submit"
        disabled={pending}
        className="rounded-sm border border-cyan/50 bg-cyan/10 px-3 py-1.5 font-mono text-xs text-cyan hover:bg-cyan/20 disabled:opacity-50"
      >
        {pending ? "Re-checking…" : "Recheck eligibility now"}
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
