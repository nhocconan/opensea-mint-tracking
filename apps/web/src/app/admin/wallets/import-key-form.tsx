"use client";

import { useState, useTransition } from "react";
import { importWalletKeyAction } from "@/app/actions.ts";
import { authClient } from "@/lib/auth-client.ts";

/**
 * Import a burner wallet's private key for autonomous managed-key minting.
 * The key is AES-256-GCM encrypted server-side on save and only decrypted in
 * the worker at fire time. Importing is a spend-capable action, so — exactly
 * like arming a mint (ArmControls) — it requires a fresh WebAuthn passkey
 * step-up: we run the passkey ceremony here first, then the server action
 * re-checks it. Register a passkey at Admin → Account first, or the ceremony
 * has nothing to assert.
 */
export function ImportKeyForm() {
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <section className="rounded-md border border-magenta/30 bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Import minting key
      </h2>
      <p className="mt-1 text-[11px] text-amber">
        Burner wallets only — hold only your mint budget + gas. Encrypted at rest (AES-256-GCM),
        decrypted only at the mint instant. Requires a passkey (register one at{" "}
        <a href="/admin/account" className="underline">
          Admin → Account
        </a>{" "}
        first) and the live-execution switch.
      </p>
      <form
        className="mt-3 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          startTransition(async () => {
            setStatus(null);
            // Fresh passkey step-up (same ceremony as arming) before the
            // server action, which re-verifies it server-side.
            const signIn = await authClient.signIn.passkey();
            if (signIn?.error) {
              setStatus({
                ok: false,
                message:
                  signIn.error.message ??
                  "Passkey verification failed or was cancelled. Register a passkey at Admin → Account first.",
              });
              return;
            }
            const result = await importWalletKeyAction({
              privateKey: String(form.get("privateKey") ?? ""),
              label: String(form.get("label") ?? ""),
            });
            setStatus(result);
          });
        }}
      >
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
          {pending ? "Verifying + encrypting…" : "Verify passkey + import key"}
        </button>
        {status !== null ? (
          <p
            role={status.ok ? "status" : "alert"}
            className={`text-xs ${status.ok ? "text-acid" : "text-magenta"}`}
          >
            {status.message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
