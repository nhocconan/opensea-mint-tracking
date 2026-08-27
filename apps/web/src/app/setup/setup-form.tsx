"use client";

import { useActionState } from "react";
import { type ActionState, setupAction } from "@/app/actions.ts";

const initial: ActionState = { ok: false, message: "" };

export function SetupForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      setupAction({
        token: String(formData.get("token") ?? ""),
        email: String(formData.get("email") ?? ""),
        name: String(formData.get("name") ?? ""),
        password: String(formData.get("password") ?? ""),
      }),
    initial,
  );

  return (
    <form action={formAction} className="mt-6 space-y-3">
      <label className="block">
        <span className="mb-1 block font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Bootstrap token
        </span>
        <input
          name="token"
          required
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-sm border border-line bg-base-raised px-3 py-2 font-mono text-sm"
          placeholder="from `make token` or server logs"
        />
      </label>
      <label className="block">
        <span className="mb-1 block font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          Your name
        </span>
        <input
          name="name"
          required
          className="w-full rounded-sm border border-line bg-base-raised px-3 py-2 text-sm"
        />
      </label>
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
          Password (min 12 chars)
        </span>
        <input
          name="password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          className="w-full rounded-sm border border-line bg-base-raised px-3 py-2 text-sm"
        />
      </label>
      {state.message !== "" ? (
        <p
          role={state.ok ? "status" : "alert"}
          className={`rounded-sm border px-3 py-2 text-sm ${
            state.ok
              ? "border-acid/40 bg-acid/10 text-acid"
              : "border-magenta/40 bg-magenta/10 text-magenta"
          }`}
        >
          {state.message}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-sm border border-acid/50 bg-acid/15 px-3 py-2 font-mono text-sm text-acid hover:bg-acid/25 disabled:opacity-50"
      >
        {pending ? "Creating admin…" : "Create admin"}
      </button>
    </form>
  );
}
