"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client.ts";

/**
 * ADR 0008: registering a passkey here is what makes the arm flow below
 * usable at all — `requireFreshStepUp` (apps/web/src/lib/session.ts)
 * refuses to arm anything until this has happened at least once and the
 * owner re-verifies with it within 2 minutes of each arm attempt.
 */
export function PasskeyRegistration() {
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <section className="rounded-md border border-magenta/30 bg-magenta/5 p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-magenta uppercase">
        Step-up: register a passkey
      </h2>
      <p className="mt-1 text-xs text-ink-muted">
        Required before arming any mint plan (ADR 0008). This is a WebAuthn credential — a platform
        passkey or a hardware security key — never a password or TOTP code, since arming sits
        directly in front of on-chain spend caps once Phase 2 custody exists.
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setStatus(null);
          const result = await authClient.passkey.addPasskey({ name: "HoodMint Radar arm key" });
          setPending(false);
          if (result.error) {
            setStatus({ ok: false, message: result.error.message ?? "Registration failed." });
            return;
          }
          setStatus({ ok: true, message: "Passkey registered." });
        }}
        className="mt-3 rounded-sm border border-magenta/50 bg-magenta/15 px-3 py-1.5 font-mono text-xs text-magenta hover:bg-magenta/25 disabled:opacity-50"
      >
        {pending ? "Registering…" : "Register passkey"}
      </button>
      {status !== null ? (
        <p
          role={status.ok ? "status" : "alert"}
          className={`mt-2 text-xs ${status.ok ? "text-acid" : "text-magenta"}`}
        >
          {status.message}
        </p>
      ) : null}
    </section>
  );
}
