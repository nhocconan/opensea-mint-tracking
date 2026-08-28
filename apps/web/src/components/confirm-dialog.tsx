"use client";

import { useId, useRef, useState, useTransition } from "react";

/**
 * Shared destructive-action confirm (admin-crud-standards baseline). Built on
 * the native <dialog> element so focus trapping, `Esc` to close, and focus
 * restoration to the trigger on close are the browser's job, not hand-rolled
 * (and correct for screen readers). No raw one-click destructive action may
 * remain in the admin surface — every one routes through this.
 *
 * `requireTyping` gates the confirm button behind re-typing an exact string
 * (an email/identifier) for high-stakes deletes. `onConfirm` returns the
 * action's `{ ok, message }`: on failure the message is shown inline and the
 * dialog stays open; on success (or void) it closes.
 */
export function ConfirmDialog({
  triggerLabel,
  triggerClassName,
  triggerAriaLabel,
  title,
  consequence,
  confirmLabel,
  requireTyping,
  onConfirm,
  disabled,
}: {
  triggerLabel: string;
  triggerClassName?: string;
  triggerAriaLabel?: string;
  title: string;
  consequence: React.ReactNode;
  confirmLabel: string;
  requireTyping?: string;
  onConfirm: () => Promise<{ ok: boolean; message: string } | undefined>;
  disabled?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const typingSatisfied = requireTyping === undefined || typed === requireTyping;

  function open() {
    setTyped("");
    setError("");
    dialogRef.current?.showModal();
  }
  function close() {
    dialogRef.current?.close();
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-label={triggerAriaLabel ?? triggerLabel}
        onClick={open}
        className={
          triggerClassName ??
          "rounded-xs border border-magenta/40 px-2 py-0.5 text-[11px] text-magenta hover:bg-magenta/10 disabled:opacity-50"
        }
      >
        {triggerLabel}
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: native <dialog> handles Esc/backdrop; this click only closes on backdrop press. */}
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={descId}
        onCancel={() => {
          setError("");
        }}
        onClick={(e) => {
          // Close when the backdrop (the dialog element itself) is clicked,
          // never when the inner panel is.
          if (e.target === dialogRef.current) {
            close();
          }
        }}
        className="m-auto w-[min(92vw,28rem)] rounded-md border border-line bg-base-raised p-0 text-ink backdrop:bg-black/60"
      >
        <div className="p-4">
          <h2 id={titleId} className="font-mono text-[12px] tracking-widest text-magenta uppercase">
            {title}
          </h2>
          <div id={descId} className="mt-2 text-xs text-ink-muted">
            {consequence}
          </div>
          {requireTyping !== undefined ? (
            <div className="mt-3">
              <label htmlFor={`${titleId}-typing`} className="block text-[11px] text-ink-muted">
                Type <span className="font-mono text-ink">{requireTyping}</span> to confirm
              </label>
              <input
                id={`${titleId}-typing`}
                value={typed}
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
                className="mt-1 w-full rounded-sm border border-line bg-base px-3 py-2 font-mono text-sm"
              />
            </div>
          ) : null}
          {error !== "" ? (
            <p role="alert" className="mt-2 text-xs text-magenta">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={close}
              className="rounded-sm border border-line px-3 py-1.5 font-mono text-xs text-ink-muted hover:border-ink-faint disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending || !typingSatisfied}
              onClick={() =>
                startTransition(async () => {
                  setError("");
                  const result = await onConfirm();
                  if (result && !result.ok) {
                    setError(result.message);
                    return;
                  }
                  close();
                })
              }
              className="rounded-sm border border-magenta/50 bg-magenta/15 px-3 py-1.5 font-mono text-xs text-magenta hover:bg-magenta/25 disabled:opacity-50"
            >
              {pending ? "Working…" : confirmLabel}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
