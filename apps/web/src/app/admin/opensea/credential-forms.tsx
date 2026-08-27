"use client";

import { useActionState, useTransition } from "react";
import { type ActionState, revokeCredentialAction, saveCredentialAction } from "@/app/actions.ts";

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
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => void (await revokeCredentialAction(id)))}
      className="rounded-xs border border-magenta/40 px-2 py-0.5 text-[11px] text-magenta hover:bg-magenta/10 disabled:opacity-50"
    >
      {pending ? "…" : "Revoke"}
    </button>
  );
}
