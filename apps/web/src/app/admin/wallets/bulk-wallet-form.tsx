"use client";

import { useActionState } from "react";
import { type ActionState, createWalletsBulkAction } from "@/app/actions.ts";

const initial: ActionState = { ok: false, message: "" };

export function BulkWalletForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      createWalletsBulkAction({
        entries: String(formData.get("entries") ?? ""),
      }),
    initial,
  );

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Bulk add wallets
      </h2>
      <p className="mt-1 text-[11px] text-ink-faint">
        One wallet per line — <code>0xADDRESS</code> or <code>0xADDRESS,label</code>. Up to 100
        lines per submit.
      </p>
      <form action={formAction} className="mt-3 space-y-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">
            Wallets (read-only tracking)
          </span>
          <textarea
            name="entries"
            required
            rows={8}
            spellCheck={false}
            placeholder={
              "0x0000000000000000000000000000000000000001,degen 1\n0x0000000000000000000000000000000000000002"
            }
            className="w-full resize-y rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add wallets"}
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
