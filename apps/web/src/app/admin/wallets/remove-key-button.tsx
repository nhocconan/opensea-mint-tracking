"use client";

import { useActionState } from "react";
import { type ActionState, revokeWalletKeyAction } from "@/app/actions.ts";

const initial: ActionState = { ok: false, message: "" };

export function RemoveKeyButton({ walletId }: { walletId: string }) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, _formData: FormData) => revokeWalletKeyAction(walletId),
    initial,
  );

  return (
    <form action={formAction} className="inline">
      <button
        type="submit"
        disabled={pending}
        className="rounded-xs border border-line px-1.5 py-0.5 text-[10px] text-ink-muted hover:border-magenta/50 hover:text-magenta disabled:opacity-50"
      >
        {pending ? "…" : "Remove key"}
      </button>
      {state.message !== "" && !state.ok ? (
        <span role="alert" className="ml-1 text-[10px] text-magenta">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
