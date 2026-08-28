"use client";

import { useActionState, useEffect, useState } from "react";
import { type ActionState, createMintPlanAction } from "@/app/actions.ts";
import { formatDateTimeUtc } from "@/lib/format.ts";
import { type ProjectHit, ProjectPicker } from "./project-picker.tsx";

export interface WalletOption {
  readonly id: string;
  readonly address: string;
  readonly label: string | null;
}

export interface SignerOption {
  readonly id: string;
  readonly ownerAddress: string;
  readonly scheme: string;
}

interface StageOption {
  readonly id: string;
  readonly label: string;
  readonly startsAt: string;
}

const initial: ActionState = { ok: false, message: "" };

/** Short address for a select option label — no need to pull in the full
 *  shortAddress helper's checksum niceties for a plain <option>. */
function shortOwner(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function MintPlanForm({
  wallets,
  signers,
}: {
  wallets: WalletOption[];
  signers: SignerOption[];
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      createMintPlanAction({
        projectId: String(formData.get("projectId") ?? ""),
        walletIds: formData.getAll("walletIds").map((v) => String(v)),
        stageId: String(formData.get("stageId") ?? ""),
        signerId: String(formData.get("signerId") ?? ""),
        quantity: Number.parseInt(String(formData.get("quantity") ?? "1"), 10),
        perPlanCeilingWei: String(formData.get("perPlanCeilingWei") ?? ""),
      }),
    initial,
  );

  const [projectId, setProjectId] = useState<string | null>(null);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [selectedWalletIds, setSelectedWalletIds] = useState<string[]>([]);

  const allWalletIds = wallets.map((w) => w.id);
  const allSelected = allWalletIds.length > 0 && selectedWalletIds.length === allWalletIds.length;

  const toggleWallet = (id: string) => {
    setSelectedWalletIds((prev) =>
      prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id],
    );
  };

  const toggleSelectAll = () => {
    setSelectedWalletIds(allSelected ? [] : allWalletIds);
  };

  // Stages are project-scoped, and the project id only exists client-side
  // (ProjectPicker's own type-ahead, no page reload) — so this mirrors that
  // component's own fetch-on-selection pattern against the same project
  // detail endpoint the rest of the admin UI already reads from.
  useEffect(() => {
    if (projectId === null) {
      setStages([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/v1/projects/${projectId}`)
      .then((res) => res.json())
      .then((body: { data?: { stages?: StageOption[] } }) => {
        if (!cancelled) {
          setStages(body.data?.stages ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStages([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleProjectSelect = (hit: ProjectHit | null) => {
    setProjectId(hit?.id ?? null);
  };

  return (
    <section className="rounded-md border border-line bg-base-raised p-4">
      <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
        Create mint plan
      </h2>
      <p className="mt-1 text-[11px] text-ink-faint">
        Creates one `draft` plan per wallet selected — arming is a separate, passkey-gated step
        below (ADR 0008).
      </p>
      <form action={formAction} className="mt-3 space-y-2">
        <ProjectPicker onSelect={handleProjectSelect} />
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] text-ink-muted">
              Wallets (recipients) — {selectedWalletIds.length} selected
            </span>
            <button
              type="button"
              onClick={toggleSelectAll}
              disabled={wallets.length === 0}
              className="font-mono text-[11px] text-cyan hover:underline disabled:opacity-50"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-sm border border-line bg-base p-2">
            {wallets.map((w) => (
              <label key={w.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="walletIds"
                  value={w.id}
                  checked={selectedWalletIds.includes(w.id)}
                  onChange={() => toggleWallet(w.id)}
                />
                <span className="font-mono">{w.label ?? w.address}</span>
              </label>
            ))}
            {wallets.length === 0 ? (
              <p className="text-xs text-ink-faint">No wallets tracked yet — add one first.</p>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">
              Fire at stage (precision timing)
            </span>
            <select
              name="stageId"
              disabled={projectId === null}
              className="w-full rounded-sm border border-line bg-base px-3 py-2 text-sm disabled:opacity-50"
            >
              <option value="">Coarse tick (default, ~30s)</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} — {formatDateTimeUtc(s.startsAt)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">Signer</span>
            <select
              name="signerId"
              className="w-full rounded-sm border border-line bg-base px-3 py-2 text-sm"
            >
              <option value="">Browser wallet (manual)</option>
              {signers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.scheme} · {shortOwner(s.ownerAddress)}
                </option>
              ))}
            </select>
          </label>
        </div>
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
          disabled={pending || selectedWalletIds.length === 0}
          className="rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending
            ? "Creating…"
            : `Create draft plan${selectedWalletIds.length > 1 ? "s" : ""}${
                selectedWalletIds.length > 0 ? ` (${selectedWalletIds.length})` : ""
              }`}
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
