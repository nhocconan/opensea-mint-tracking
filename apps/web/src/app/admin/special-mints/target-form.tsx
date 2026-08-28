"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { resolveSpecialMintTargetAction, type SpecialMintTargetState } from "@/app/actions.ts";

const initial: SpecialMintTargetState = { ok: false, message: "" };

/**
 * Step 1 of the sniper console: turn whatever the operator pasted — an
 * OpenSea collection URL, a slug, or a raw contract address — into a
 * resolved project. The resolved id goes into the URL (`?projectId=`) rather
 * than component state so the rest of the page can stay a server component
 * (stages, plans and attempts are read fresh on the server) and so a
 * prepared target is a shareable, reloadable link.
 */
export function TargetForm({ currentTarget }: { currentTarget: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    async (_prev: SpecialMintTargetState, formData: FormData) =>
      resolveSpecialMintTargetAction({ target: String(formData.get("target") ?? "") }),
    initial,
  );

  useEffect(() => {
    if (state.ok && state.projectId !== undefined) {
      router.replace(`/admin/special-mints?projectId=${state.projectId}`);
    }
  }, [state, router]);

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">1 · Target</h2>
      <p className="mt-1 text-[11px] text-ink-faint">
        Paste an OpenSea collection URL, a collection slug, or a{" "}
        <code className="font-mono">0x…</code> contract address.
      </p>
      <form action={formAction} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="block min-w-[18rem] flex-1">
          <span className="mb-1 block text-[11px] text-ink-muted">Collection</span>
          <input
            name="target"
            defaultValue={currentTarget}
            required
            spellCheck={false}
            autoComplete="off"
            placeholder="https://opensea.io/collection/0xc21159…/overview"
            className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-2 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Resolving…" : "Resolve"}
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
