"use client";

import { revokeSignerAction } from "@/app/actions.ts";
import { ConfirmDialog } from "@/components/confirm-dialog.tsx";

export function SignerRowActions({ id, status }: { id: string; status: string }) {
  if (status === "revoked") {
    return <span className="text-[11px] text-ink-faint">revoked</span>;
  }
  return (
    <ConfirmDialog
      triggerLabel="Revoke"
      triggerAriaLabel="Revoke signer"
      title="Revoke signer"
      confirmLabel="Revoke signer"
      consequence={
        <p>
          This permanently revokes the signer. Any mint plan referencing it can no longer be armed
          or fired with it, and (for a custom_executor) the worker will stop treating it as capable.
          This cannot be undone — re-onboard to get a new signer.
        </p>
      }
      onConfirm={() => revokeSignerAction(id)}
    />
  );
}
