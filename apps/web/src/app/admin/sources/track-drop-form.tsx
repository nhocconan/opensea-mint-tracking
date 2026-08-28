"use client";

import { useActionState } from "react";
import { type ActionState, trackDropAction } from "@/app/actions.ts";

const initial: ActionState = { ok: false, message: "" };

/**
 * Track a specific OpenSea drop that automatic discovery missed (e.g. a
 * direct/non-curated mint not in OpenSea's /drops list feed). Paste the
 * collection URL or slug; the worker fetches it and it appears in the
 * calendar/feeds/eligibility.
 */
export function TrackDropForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      trackDropAction({ input: String(formData.get("input") ?? "") }),
    initial,
  );

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Track a drop manually
      </h2>
      <p className="mt-1 text-[11px] text-ink-faint">
        Discovery only sees OpenSea's curated drops list. Paste a collection URL or slug to track a
        specific mint (e.g. <span className="text-ink-muted">sherwood-outlaws</span>).
      </p>
      <form action={formAction} className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex-1">
          <span className="sr-only">OpenSea collection URL or slug</span>
          <input
            name="input"
            required
            spellCheck={false}
            placeholder="https://opensea.io/collection/… or slug"
            className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-2 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Fetching…" : "Track drop"}
        </button>
      </form>
      {state.message !== "" ? (
        <p
          role={state.ok ? "status" : "alert"}
          className={`mt-2 text-xs ${state.ok ? "text-acid" : "text-magenta"}`}
        >
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
