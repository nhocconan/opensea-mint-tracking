"use client";

import { useActionState } from "react";
import { type ActionState, createRpcEndpointAction } from "@/app/actions.ts";

const initial: ActionState = { ok: false, message: "" };

export function RpcEndpointForm({ defaultChainId }: { defaultChainId: number }) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      createRpcEndpointAction({
        chainId: Number.parseInt(String(formData.get("chainId") ?? ""), 10),
        label: String(formData.get("label") ?? ""),
        httpUrl: String(formData.get("httpUrl") ?? ""),
        wsUrl: String(formData.get("wsUrl") ?? ""),
      }),
    initial,
  );

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Add custom RPC endpoint
      </h2>
      <p className="mt-1 text-[11px] text-ink-faint">
        ADR 0006 — admin-configurable per chain, ranked by health then priority.
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
            <span className="mb-1 block text-[11px] text-ink-muted">Label</span>
            <input
              name="label"
              required
              placeholder="Alchemy primary"
              className="w-full rounded-sm border border-line bg-base px-3 py-2 text-sm"
            />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">HTTP RPC URL</span>
          <input
            name="httpUrl"
            required
            spellCheck={false}
            placeholder="https://…"
            className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">WebSocket URL (optional)</span>
          <input
            name="wsUrl"
            spellCheck={false}
            placeholder="wss://…"
            className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add endpoint"}
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
