"use client";

import { createAuthClient } from "better-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

const auth = createAuthClient();

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      className="mt-6 space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setPending(true);
        setError(null);
        const { error: signInError } = await auth.signIn.email({
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        });
        setPending(false);
        if (signInError !== null) {
          setError(signInError.message ?? "Sign-in failed");
          return;
        }
        router.replace("/");
        router.refresh();
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
          autoComplete="username"
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
  );
}
