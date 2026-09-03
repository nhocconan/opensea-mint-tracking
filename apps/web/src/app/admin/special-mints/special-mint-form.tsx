"use client";

import { mintSpendCeilingWei } from "@hoodmint/core";
import { useActionState, useMemo, useState } from "react";
import { type ActionState, createSpecialMintAction } from "@/app/actions.ts";
import { Countdown } from "@/components/feed-parts.tsx";
import { formatBalance, formatDateTimeGmt7, formatPrice } from "@/lib/format.ts";
import { gmt7LocalToUtc, utcToGmt7LocalInput } from "@/lib/mint-target.ts";

export interface StageOption {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly priceWei: string | null;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly maxPerWallet: number | null;
}

export interface ManagedWalletOption {
  readonly id: string;
  readonly address: string;
  readonly label: string | null;
  /** Worker-owned native balance snapshot (wei string) + when it was read. */
  readonly nativeBalanceWei: string | null;
  readonly balanceCheckedAt: string | null;
}

const initial: ActionState = { ok: false, message: "" };
const MAX_QUANTITY = 20;

/** (Stage price + OpenSea mint fee allowance) × quantity — a "free" mint
 *  still pays OpenSea's ~0.00008 ETH SeaDrop fee, so a 1-wei ceiling would
 *  refuse every fire (found live 2026-08-28). */
function defaultCeilingWei(priceWei: string | null, quantity: number): string {
  return mintSpendCeilingWei(priceWei, quantity);
}

/** Snapshot balance below price × qty + fee allowance — a visual hint only;
 *  the server-side arm gate (live read, plus gas) is the real refusal. */
function underfunded(w: ManagedWalletOption, priceWei: string | null, quantity: number): boolean {
  if (w.nativeBalanceWei === null || !/^[0-9]+$/.test(w.nativeBalanceWei)) {
    return false;
  }
  return BigInt(w.nativeBalanceWei) < BigInt(mintSpendCeilingWei(priceWei, quantity));
}

/**
 * Steps 2–4 of the sniper console: pick the phase, confirm or override the
 * fire instant (typed in GMT+7, converted to UTC server-side), then pick the
 * managed wallets and their per-wallet quantities. Submitting creates one
 * DRAFT plan per wallet — nothing here can fire.
 */
export function SpecialMintForm({
  projectId,
  stages,
  wallets,
  initialStageId,
}: {
  projectId: string;
  stages: StageOption[];
  wallets: ManagedWalletOption[];
  initialStageId: string | null;
}) {
  const selectedInitialStage = stages.some((stage) => stage.id === initialStageId)
    ? (initialStageId ?? "")
    : (stages[0]?.id ?? "");
  const [stageId, setStageId] = useState<string>(selectedInitialStage);
  const [manualFire, setManualFire] = useState(false);
  const [fireAtGmt7, setFireAtGmt7] = useState<string>("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [ceilingTouched, setCeilingTouched] = useState(false);
  const [ceilingWei, setCeilingWei] = useState<string>("");

  const stage = stages.find((s) => s.id === stageId);
  const maxQuantity = selected.reduce((max, id) => Math.max(max, quantities[id] ?? 1), 1);
  const suggestedCeiling = defaultCeilingWei(stage?.priceWei ?? null, maxQuantity);
  const effectiveCeiling = ceilingTouched ? ceilingWei : suggestedCeiling;

  // The fire instant actually in force: a manual GMT+7 entry when set,
  // otherwise the auto-detected phase start. Shown as UTC + GMT+7 + a live
  // countdown so there is no ambiguity about when this will go.
  const fireAtUtcIso = useMemo(() => {
    if (manualFire) {
      return gmt7LocalToUtc(fireAtGmt7)?.toISOString() ?? null;
    }
    return stage?.startsAt ?? null;
  }, [manualFire, fireAtGmt7, stage]);

  const [state, formAction, pending] = useActionState(
    async (_prev: ActionState, formData: FormData) =>
      createSpecialMintAction({
        projectId,
        stageId: String(formData.get("stageId") ?? ""),
        fireAtGmt7: manualFire ? fireAtGmt7 : "",
        wallets: selected.map((walletId) => ({ walletId, quantity: quantities[walletId] ?? 1 })),
        perPlanCeilingWei: String(formData.get("perPlanCeilingWei") ?? ""),
      }),
    initial,
  );

  const toggleWallet = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]));
  };

  const pickStage = (id: string) => {
    setStageId(id);
    const next = stages.find((s) => s.id === id);
    if (next !== undefined && fireAtGmt7 === "") {
      setFireAtGmt7(utcToGmt7LocalInput(next.startsAt));
    }
  };

  const allSelected = wallets.length > 0 && selected.length === wallets.length;

  return (
    <form action={formAction} className="space-y-3">
      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          2 · Phase
        </h2>
        {stages.length === 0 ? (
          <p className="mt-2 text-xs text-ink-faint">
            No phases published for this collection — type a manual fire time below instead.
          </p>
        ) : null}
        <fieldset className="mt-2 space-y-1">
          <legend className="sr-only">Mint phase</legend>
          {stages.map((s) => (
            <label
              key={s.id}
              className="flex flex-wrap items-center gap-2 rounded-sm border border-line bg-base px-2 py-1.5 text-xs"
            >
              <input
                type="radio"
                name="stageId"
                value={s.id}
                checked={stageId === s.id}
                onChange={() => pickStage(s.id)}
              />
              <span className="font-mono text-ink">{s.label}</span>
              <span className="rounded-xs border border-line px-1 font-mono text-[10px] text-ink-faint uppercase">
                {s.kind}
              </span>
              <span className="font-mono text-cyan">{formatPrice(s.priceWei)}</span>
              <span className="font-mono text-ink-muted">{formatDateTimeGmt7(s.startsAt)}</span>
              {s.endsAt !== null ? (
                <span className="font-mono text-ink-faint">
                  ends {formatDateTimeGmt7(s.endsAt)}
                </span>
              ) : null}
              {s.maxPerWallet !== null ? (
                <span className="font-mono text-ink-faint">max {s.maxPerWallet}/wallet</span>
              ) : null}
            </label>
          ))}
          <label className="flex items-center gap-2 rounded-sm border border-line bg-base px-2 py-1.5 text-xs">
            <input
              type="radio"
              name="stageId"
              value=""
              checked={stageId === ""}
              onChange={() => setStageId("")}
            />
            <span className="text-ink-muted">No phase — manual fire time only</span>
          </label>
        </fieldset>
      </section>

      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          3 · Fire time
        </h2>
        <label className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={manualFire}
            onChange={(e) => {
              setManualFire(e.target.checked);
              if (e.target.checked && fireAtGmt7 === "" && stage !== undefined) {
                setFireAtGmt7(utcToGmt7LocalInput(stage.startsAt));
              }
            }}
          />
          Manual override — type the open instant in <strong>GMT+7</strong> (Asia/Ho_Chi_Minh)
        </label>
        {manualFire ? (
          <label className="mt-2 block max-w-xs">
            <span className="mb-1 block text-[11px] text-ink-muted">Fire at (GMT+7)</span>
            <input
              type="datetime-local"
              value={fireAtGmt7}
              onChange={(e) => setFireAtGmt7(e.target.value)}
              step={1}
              className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
            />
          </label>
        ) : (
          <p className="mt-2 text-[11px] text-ink-faint">
            Auto-detected from the selected phase. The worker re-checks the chain clock offset and
            fires on a 200 ms hot loop at that instant.
          </p>
        )}
        <dl className="mt-3 grid gap-1 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-[10px] text-ink-faint uppercase">GMT+7</dt>
            <dd className="font-mono text-ink">{formatDateTimeGmt7(fireAtUtcIso)}</dd>
          </div>
          <div>
            <dt className="text-[10px] text-ink-faint uppercase">Countdown</dt>
            <dd>
              <Countdown iso={fireAtUtcIso} label="Fire" />
            </dd>
          </div>
        </dl>
        {manualFire && fireAtGmt7 !== "" && fireAtUtcIso === null ? (
          <p role="alert" className="mt-2 text-xs text-magenta">
            That is not a real date/time.
          </p>
        ) : null}
      </section>

      <section className="rounded-md border border-line bg-base-raised p-4">
        <h2 className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
          4 · Wallets &amp; quantity
        </h2>
        <div className="mt-2 mb-1 flex items-center justify-between">
          <span className="text-[11px] text-ink-muted">
            Managed wallets only — {selected.length} selected
          </span>
          <button
            type="button"
            onClick={() => setSelected(allSelected ? [] : wallets.map((w) => w.id))}
            disabled={wallets.length === 0}
            className="font-mono text-[11px] text-cyan hover:underline disabled:opacity-50"
          >
            {allSelected ? "Deselect all" : "Select all"}
          </button>
        </div>
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-sm border border-line bg-base p-2">
          {wallets.map((w) => (
            <div key={w.id} className="flex items-center gap-2 text-sm">
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.includes(w.id)}
                  onChange={() => toggleWallet(w.id)}
                />
                <span className="font-mono text-xs">{w.label ?? w.address}</span>
                {w.label !== null ? (
                  <span className="font-mono text-[10px] text-ink-faint">{w.address}</span>
                ) : null}
                <span
                  className={`ml-auto font-mono text-[10px] ${
                    underfunded(w, stage?.priceWei ?? null, quantities[w.id] ?? 1)
                      ? "text-magenta"
                      : "text-ink-faint"
                  }`}
                  title="Native balance (worker snapshot). Arming refuses a wallet that cannot cover price × qty + OpenSea fee + gas."
                >
                  {formatBalance(w.nativeBalanceWei, w.balanceCheckedAt)}
                </span>
              </label>
              <label className="flex items-center gap-1">
                <span className="text-[10px] text-ink-faint uppercase">Qty</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_QUANTITY}
                  value={quantities[w.id] ?? 1}
                  aria-label={`Quantity for ${w.label ?? w.address}`}
                  onChange={(e) =>
                    setQuantities((prev) => ({
                      ...prev,
                      [w.id]: Number.parseInt(e.target.value, 10) || 1,
                    }))
                  }
                  className="w-16 rounded-xs border border-line bg-base px-1.5 py-0.5 font-mono text-xs"
                />
              </label>
            </div>
          ))}
          {wallets.length === 0 ? (
            <p className="text-xs text-ink-faint">
              No managed wallets — import a minting key on Admin → Wallets first.
            </p>
          ) : null}
        </div>
        <label className="mt-3 block max-w-md">
          <span className="mb-1 block text-[11px] text-ink-muted">
            Per-plan ceiling (wei) — default = phase price × highest quantity
          </span>
          <input
            name="perPlanCeilingWei"
            value={effectiveCeiling}
            onChange={(e) => {
              setCeilingTouched(true);
              setCeilingWei(e.target.value);
            }}
            required
            spellCheck={false}
            className="w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={pending || selected.length === 0}
          className="mt-3 rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
        >
          {pending ? "Creating…" : `Create ${selected.length} draft plan(s)`}
        </button>
        {state.message !== "" ? (
          <p
            role={state.ok ? "status" : "alert"}
            className={`mt-2 text-xs ${state.ok ? "text-acid" : "text-magenta"}`}
          >
            {state.message}
          </p>
        ) : null}
      </section>
    </form>
  );
}
