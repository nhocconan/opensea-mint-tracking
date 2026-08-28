"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client.ts";

// Single generic message for every failed sign-in — bad password, unknown
// email, or a live lockout. Never reveal which (no user enumeration); the
// server already returns an indistinguishable 401 for all three.
const GENERIC_ERROR = "Invalid credentials or too many attempts — try again later.";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const conditionalStarted = useRef(false);

  const onAuthed = () => {
    router.replace("/");
    router.refresh();
  };

  // Passkey conditional UI (autofill): if the browser supports it, preload a
  // discoverable-credential assertion on mount so the email field can offer a
  // passkey inline. Feature-detected and best-effort — a failure or the
  // absence of support silently leaves the password + button paths untouched.
  // Mount-only: onAuthed/router are effectively stable for this component.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    if (conditionalStarted.current) {
      return;
    }
    conditionalStarted.current = true;
    let cancelled = false;
    void (async () => {
      const mediation = globalThis.PublicKeyCredential as
        | { isConditionalMediationAvailable?: () => Promise<boolean> }
        | undefined;
      if (mediation?.isConditionalMediationAvailable === undefined) {
        return;
      }
      try {
        const available = await mediation.isConditionalMediationAvailable();
        if (!available || cancelled) {
          return;
        }
        const { error: passkeyError } = await authClient.signIn.passkey({ autoFill: true });
        if (!cancelled && passkeyError === null) {
          onAuthed();
        }
      } catch {
        // Conditional UI unsupported/aborted — the button path still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signInWithPasskey = async () => {
    setPending(true);
    setError(null);
    const { error: passkeyError } = await authClient.signIn.passkey();
    setPending(false);
    if (passkeyError !== null) {
      setError(GENERIC_ERROR);
      return;
    }
    onAuthed();
  };

  return (
    <div className="mt-6 space-y-3">
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setPending(true);
          setError(null);
          const { error: signInError } = await authClient.signIn.email({
            email: String(form.get("email") ?? ""),
            password: String(form.get("password") ?? ""),
            rememberMe: form.get("rememberMe") !== null,
          });
          setPending(false);
          if (signInError !== null) {
            setError(GENERIC_ERROR);
            return;
          }
          onAuthed();
        }}
      >
        <label className="block">
          <span className="mb-1 block font-mono text-[11px] tracking-widest text-ink-faint uppercase">
            Email
          </span>
          <input
            name="email"
            type="email"
            required
            autoComplete="username webauthn"
            className="w-full rounded-sm border border-line bg-base-raised px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[11px] tracking-widest text-ink-faint uppercase">
            Password
          </span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="w-full rounded-sm border border-line bg-base-raised px-3 py-2 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <input
            name="rememberMe"
            type="checkbox"
            defaultChecked
            className="size-4 rounded-xs border border-line accent-acid"
          />
          <span>Remember me on this device</span>
        </label>
        {error !== null ? (
          <p
            role="alert"
            className="rounded-sm border border-magenta/40 bg-magenta/10 px-3 py-2 text-sm text-magenta"
          >
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-sm border border-acid/50 bg-acid/15 px-3 py-2 font-mono text-sm text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        <span className="font-mono text-[10px] tracking-widest text-ink-faint uppercase">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={signInWithPasskey}
        className="w-full rounded-sm border border-cyan/50 bg-cyan/15 px-3 py-2 font-mono text-sm text-cyan hover:bg-cyan/25 disabled:opacity-50"
      >
        Sign in with a passkey
      </button>
    </div>
  );
}
