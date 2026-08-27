"use client";

import { useActionState } from "react";
import { type ActionState, createWalletAction } from "@/app/actions.ts";

const initial: ActionState = { ok: false, message: "" };

export function WalletForm({ prefill }: { prefill: string }) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      createWalletAction({
        address: String(formData.get("address") ?? ""),
        label: String(formData.get("label") ?? ""),
      }),
    initial,
  );

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">Add wallet</h2>
      <form action={formAction} className="mt-3 space-y-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">
            Address (read-only tracking)
          </span>
          <input
            name="address"
            required
            defaultValue={prefill}
            spellCheck={false}
            placeholder="0x…"
            className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">Label (optional)</span>
          <input
            name="label"
            className="w-full rounded-sm border border-line bg-base px-3 py-2 text-sm"
            placeholder="degen main"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add wallet"}
        </button>
        {state.message !== "" ? (
          <p
            role={state.ok ? "status" : "alert"}
            className={`text-xs ${state.ok ? "text-acid" : "text-magenta"}`}
          >
            {state.message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
