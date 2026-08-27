import type { Metadata } from "next";
import Link from "next/link";
import { ADMIN_NAV } from "@/lib/admin-nav.ts";
import { requirePage } from "@/lib/session.ts";

export const metadata: Metadata = { title: "Admin" };

/** /admin requires the admin role (PRD §7.5) — enforced server-side. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePage("audit:read");

  return (
    <div className="px-4 py-5">
      <header className="mb-4">
        <h1 className="font-display text-lg font-semibold tracking-tight">Admin console</h1>
        <nav aria-label="Admin sections" className="mt-2 flex flex-wrap gap-1.5">
          {ADMIN_NAV.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="rounded-xs border border-line px-2.5 py-1 font-mono text-[11px] text-ink-muted hover:border-acid hover:text-acid"
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </div>
  );
}
