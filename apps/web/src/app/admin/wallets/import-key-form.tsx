"use client";

import type React from "react";
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
export function ImportKeyForm({ envelopeSealing }: { envelopeSealing: boolean }) {
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [reveal, setReveal] = useState(false);

  return (
    <section className="rounded-md border border-magenta/30 bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Import minting key
      </h2>
      <p className="mt-1 text-[11px] text-amber">
        A whitelist/allowlist is tied to a specific address — a burner is NOT on your allowlist and
        cannot mint your WL. Import the key of the wallet that actually holds the spot to mint it
        autonomously (or use browser-wallet signing to keep the key off the server). Use a{" "}
        <strong>burner</strong> (mint budget + gas only) for public/FCFS mints. Keys are encrypted
        at rest (AES-256-GCM), decrypted only at the mint instant, and require a passkey (register
        one at{" "}
        <a href="/admin/account" className="underline">
          Admin → Account
        </a>
        ) plus the live-execution switch.
      </p>
      {envelopeSealing ? null : (
        <p role="note" className="mt-1 text-[11px] text-magenta">
          Worker-only sealing is OFF: no <code>WALLET_KEY_PUBLIC_KEY</code> configured, so imports
          fall back to the shared <code>APP_ENCRYPTION_KEY</code>. Run <code>make wallet-keys</code>{" "}
          and set the public key on web + the private key on the worker.
        </p>
      )}
      <form
        className="mt-3 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const formEl = event.currentTarget;
          const form = new FormData(formEl);
          // Drop the key from the DOM immediately — the server has it from
          // here on and the field must not linger on screen or in a resubmit.
          formEl.reset();
          setReveal(false);
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
          <span className="mb-1 flex items-center justify-between text-[11px] text-ink-muted">
            <span>Private key (0x + 64 hex)</span>
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-pressed={reveal}
              className="text-[11px] text-ink-faint underline"
            >
              {reveal ? "hide" : "show"}
            </button>
          </span>
          {/* Deliberately NOT type="password": browsers offer to save
              password fields into the OS/password-manager vault regardless of
              autocomplete="off", which would copy the minting key somewhere
              we do not control. Masking via text-security keeps it off-screen
              without ever declaring it a credential. */}
          <input
            name="privateKey"
            type="text"
            inputMode="text"
            required
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            placeholder="0x…"
            style={reveal ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)}
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
