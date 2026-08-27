"use client";

import { useActionState } from "react";
import { type ActionState, createMintPlanAction } from "@/app/actions.ts";
import { ProjectPicker } from "./project-picker.tsx";

export interface WalletOption {
  readonly id: string;
  readonly address: string;
  readonly label: string | null;
}

const initial: ActionState = { ok: false, message: "" };

export function MintPlanForm({ wallets }: { wallets: WalletOption[] }) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      createMintPlanAction({
        projectId: String(formData.get("projectId") ?? ""),
        walletId: String(formData.get("walletId") ?? ""),
        quantity: Number.parseInt(String(formData.get("quantity") ?? "1"), 10),
        perPlanCeilingWei: String(formData.get("perPlanCeilingWei") ?? ""),
      }),
    initial,
  );

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Create mint plan
      </h2>
      <p className="mt-1 text-[11px] text-ink-faint">
        Creates a `draft` plan only — arming is a separate, passkey-gated step below (ADR 0008).
      </p>
      <form action={formAction} className="mt-3 space-y-2">
        <ProjectPicker />
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-muted">Wallet (recipient)</span>
          <select
            name="walletId"
            required
            className="w-full rounded-sm border border-line bg-base px-3 py-2 text-sm"
          >
            <option value="">Select a wallet…</option>
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label ?? w.address}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">Quantity</span>
            <input
              name="quantity"
              type="number"
              min={1}
              defaultValue={1}
              required
              className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">Per-plan ceiling (wei)</span>
            <input
              name="perPlanCeilingWei"
              required
              placeholder="e.g. 100000000000000000"
              spellCheck={false}
              className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create draft plan"}
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
