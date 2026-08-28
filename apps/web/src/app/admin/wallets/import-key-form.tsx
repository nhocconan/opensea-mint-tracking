"use client";

import { useActionState } from "react";
import { type ActionState, importWalletKeyAction } from "@/app/actions.ts";

const initial: ActionState = { ok: false, message: "" };

/**
 * Import a burner wallet's private key for autonomous managed-key minting.
 * The key is AES-256-GCM encrypted server-side on save and only decrypted in
 * the worker at fire time. Requires a passkey step-up (enforced server-side).
 */
export function ImportKeyForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      importWalletKeyAction({
        privateKey: String(formData.get("privateKey") ?? ""),
        label: String(formData.get("label") ?? ""),
      }),
    initial,
  );

  return (
    <section className="rounded-md border border-magenta/30 bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Import minting key
      </h2>
      <p className="mt-1 text-[11px] text-amber">
        Burner wallets only — hold only your mint budget + gas. Encrypted at rest (AES-256-GCM),
        decrypted only at the mint instant. Requires a passkey and the live-execution switch.
      </p>
      <form action={formAction} className="mt-3 space-y-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">Private key (0x + 64 hex)</span>
          <input
            name="privateKey"
            type="password"
            required
            autoComplete="off"
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
            placeholder="burner #1"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-magenta/50 bg-magenta/15 px-3 py-1.5 font-mono text-xs text-magenta hover:bg-magenta/25 disabled:opacity-50"
        >
          {pending ? "Encrypting…" : "Import & encrypt key"}
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
