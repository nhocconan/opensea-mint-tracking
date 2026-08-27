"use client";

import { useTransition } from "react";
import { revokeSignerAction } from "@/app/actions.ts";

export function SignerRowActions({ id, status }: { id: string; status: string }) {
  const [pending, startTransition] = useTransition();
  if (status === "revoked") {
    return <span className="text-[11px] text-ink-faint">revoked</span>;
  }
  return (
    <button
      type="button"
      disabled={pending}
      aria-label="Revoke signer"
      onClick={() => startTransition(async () => void (await revokeSignerAction(id)))}
      className="rounded-xs border border-magenta/40 px-2 py-0.5 text-[11px] text-magenta hover:bg-magenta/10 disabled:opacity-50"
    >
      {pending ? "…" : "Revoke"}
    </button>
  );
}
