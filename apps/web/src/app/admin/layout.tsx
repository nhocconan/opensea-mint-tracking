import type { Metadata } from "next";
import { Shield } from "lucide-react";
import { AdminNav } from "@/components/admin-nav.tsx";
import { SignOutButton } from "@/components/sign-out-button.tsx";
import { getSessionUser, requirePage } from "@/lib/session.ts";

export const metadata: Metadata = { title: "Admin" };

/** /admin requires the admin role (PRD §7.5) — enforced server-side. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePage("audit:read");
  const user = await getSessionUser();

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 space-y-6">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-md border border-acid/50 bg-acid/15 text-acid">
              <Shield className="size-4" aria-hidden />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-display text-lg font-bold tracking-tight text-ink">
                  Admin Console
                </h1>
                <span className="rounded-full border border-acid/40 bg-acid/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-acid uppercase tracking-wider">
                  Protected
                </span>
              </div>
              <p className="font-mono text-[11px] text-ink-faint">
                HoodMint Radar Operator Control Center · Autonomous mint tracking &amp; execution
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {user?.email !== undefined ? (
              <div className="flex items-center gap-1.5 rounded-md border border-line bg-base-raised px-2.5 py-1">
                <span className="size-1.5 rounded-full bg-acid" />
                <span className="font-mono text-xs text-ink-muted">{user.email}</span>
                <span className="rounded-xs border border-line bg-base px-1 font-mono text-[9px] uppercase text-ink-faint">
                  Admin
                </span>
              </div>
            ) : null}
            <SignOutButton />
          </div>
        </div>

        <AdminNav />
      </header>

      <main className="min-w-0">{children}</main>
    </div>
  );
}

