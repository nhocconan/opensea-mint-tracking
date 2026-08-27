"use client";

import { useActionState } from "react";
import { type ActionState, registerBrowserSignerAction } from "@/app/actions.ts";

const initial: ActionState = { ok: false, message: "" };

export function SignerForm({ defaultChainId }: { defaultChainId: number }) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      registerBrowserSignerAction({
        chainId: Number.parseInt(String(formData.get("chainId") ?? ""), 10),
        ownerAddress: String(formData.get("ownerAddress") ?? ""),
      }),
    initial,
  );

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Register browser-wallet signer
      </h2>
      <p className="mt-1 text-[11px] text-ink-faint">
        Zero server custody (ADR 0008, Phase 1) — your own wallet signs client-side at mint time.
        Delegated signing (Ledger + EIP-7702) is Phase 2 and not built yet.
      </p>
      <form action={formAction} className="mt-3 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">Chain id</span>
            <input
              name="chainId"
              required
              type="number"
              defaultValue={defaultChainId}
              className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">Owner address</span>
            <input
              name="ownerAddress"
              required
              spellCheck={false}
              placeholder="0x…"
              className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Registering…" : "Register signer"}
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
