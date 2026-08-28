"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client.ts";

/** Sign out and return to the login screen. */
export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await authClient.signOut();
        router.replace("/login");
        router.refresh();
      }}
      className={
        className ??
        "flex items-center gap-1 rounded-xs border border-line px-2 py-1 font-mono text-[11px] text-ink-muted hover:border-magenta/50 hover:text-magenta disabled:opacity-50"
      }
    >
      <LogOut className="size-3" aria-hidden />
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
