"use client";

import { useState, useTransition } from "react";
import { deleteWalletAction, updateWalletAction } from "@/app/actions.ts";
import { ConfirmDialog } from "@/components/confirm-dialog.tsx";

/** Inline label edit + a compact status line, shown in the Label cell. */
export function WalletLabelCell({ id, label }: { id: string; label: string | null }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label ?? "");
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        <span>{label ?? "—"}</span>
        <button
          type="button"
          aria-label="Edit label"
          onClick={() => {
            setValue(label ?? "");
            setStatus(null);
            setEditing(true);
          }}
          className="rounded-xs border border-line px-1.5 py-0.5 text-[10px] text-ink-faint hover:border-cyan/40 hover:text-cyan"
        >
          Edit
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      <label htmlFor={`label-${id}`} className="sr-only">
        Wallet label
      </label>
      <input
        id={`label-${id}`}
        value={value}
        maxLength={80}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        className="w-32 rounded-xs border border-line bg-base px-1.5 py-0.5 font-mono text-[11px]"
      />
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await updateWalletAction({ id, label: value });
            setStatus(result);
            if (result.ok) {
              setEditing(false);
            }
          })
        }
        className="rounded-xs border border-acid/40 px-1.5 py-0.5 text-[10px] text-acid hover:bg-acid/10 disabled:opacity-50"
      >
        {pending ? "…" : "Save"}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => setEditing(false)}
        className="rounded-xs border border-line px-1.5 py-0.5 text-[10px] text-ink-faint hover:border-ink-muted disabled:opacity-50"
      >
        Cancel
      </button>
      {status !== null && !status.ok ? (
        <span role="alert" className="text-[10px] text-magenta">
          {status.message}
        </span>
      ) : null}
    </span>
  );
}

/** Enable/disable toggle + delete-behind-confirm, shown in the Actions cell. */
export function WalletRowActions({
  id,
  address,
  enabled,
  hasSigningKey,
}: {
  id: string;
  address: string;
  enabled: boolean;
  hasSigningKey: boolean;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={pending}
        aria-label={enabled ? "Disable wallet" : "Enable wallet"}
        onClick={() =>
          startTransition(async () => void (await updateWalletAction({ id, enabled: !enabled })))
        }
        className={`rounded-xs border px-2 py-0.5 text-[11px] disabled:opacity-50 ${
          enabled
            ? "border-magenta/40 text-magenta hover:bg-magenta/10"
            : "border-acid/40 text-acid hover:bg-acid/10"
        }`}
      >
        {pending ? "…" : enabled ? "Disable" : "Enable"}
      </button>
      <ConfirmDialog
        triggerLabel="Delete"
        triggerAriaLabel={`Delete wallet ${address}`}
        title="Delete wallet"
        confirmLabel="Delete wallet"
        requireTyping={address}
        consequence={
          <>
            <p>
              This permanently removes the wallet{" "}
              <span className="font-mono text-ink">{address}</span> from eligibility tracking.
            </p>
            {hasSigningKey ? (
              <p className="mt-2 text-magenta">
                This wallet holds a managed encrypted signing key — that key ciphertext is destroyed
                with it and cannot be recovered.
              </p>
            ) : null}
          </>
        }
        onConfirm={() => deleteWalletAction(id)}
      />
    </span>
  );
}
