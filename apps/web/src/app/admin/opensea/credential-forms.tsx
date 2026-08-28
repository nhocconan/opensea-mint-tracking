"use client";

import { useActionState } from "react";
import { type ActionState, revokeCredentialAction, saveCredentialAction } from "@/app/actions.ts";
import { ConfirmDialog } from "@/components/confirm-dialog.tsx";

const initial: ActionState = { ok: false, message: "" };

export function CredentialForm({
  type,
  title,
  hint,
}: {
  type: "opensea_api_key" | "opensea_pat";
  title: string;
  hint: string;
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      saveCredentialAction({ type, value: String(formData.get("value") ?? "") }),
    initial,
  );

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">{title}</h2>
      <p className="mt-1 text-[11px] text-ink-muted">{hint}</p>
      <form action={formAction} className="mt-3 space-y-2">
        <input
          name="value"
          type="password"
          required
          autoComplete="off"
          placeholder="paste secret — encrypted on save"
          aria-label={`${title} value`}
          className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save encrypted"}
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

export function RevokeButton({ id }: { id: string }) {
  return (
    <ConfirmDialog
      triggerLabel="Revoke"
      triggerAriaLabel="Revoke credential"
      title="Revoke credential"
      confirmLabel="Revoke credential"
      consequence={
        <p>
          This permanently deletes the stored (encrypted) credential. Any scan or feature relying on
          it stops working until a new one is saved. This cannot be undone.
        </p>
      }
      onConfirm={() => revokeCredentialAction(id)}
    />
  );
}
