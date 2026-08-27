"use client";

import type { Theme } from "@hoodmint/ui";
import {
  Activity,
  CalendarDays,
  Clock3,
  Eye,
  Flame,
  Layers,
  Radar,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { ADMIN_NAV } from "@/lib/admin-nav.ts";
import { type CommandItem, CommandPalette } from "./command-palette.tsx";
import { useRadarEvents } from "./sse.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

const NAV = [
  { href: "/", label: "Pulse", icon: Activity },
  { href: "/all", label: "All", icon: Layers },
  { href: "/live", label: "Live", icon: Flame },
  { href: "/next", label: "Next", icon: Clock3 },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/latest", label: "Latest", icon: Sparkles },
  { href: "/eligible", label: "Eligible", icon: ShieldCheck },
  { href: "/watchlist", label: "Watchlist", icon: Star },
] as const;

const COMMAND_ITEMS: readonly CommandItem[] = [
  ...NAV.map(({ href, label }) => ({ href, label, group: "Navigate" })),
  ...ADMIN_NAV.map(([href, label]) => ({ href, label, group: "Admin" })),
];

export function AppShell({ children, theme }: { children: ReactNode; theme: Theme }) {
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useRadarEvents();

  useEffect(() => {
    // ⌘K / Ctrl+K: focus the feed search box where one exists (PRD §5.1,
    // unchanged); everywhere else (admin, project detail, calendar,
    // login/setup) it opens the site-wide command palette instead —
    // additive, not a shortcut conflict.
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const search = document.querySelector<HTMLInputElement>('input[name="q"]');
        if (search !== null) {
          search.focus();
        } else {
          setPaletteOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isActive = (href: string): boolean =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/* Desktop left rail */}
      <nav
        aria-label="Primary"
        className="hidden shrink-0 flex-col gap-1 border-r border-line bg-base-raised p-3 md:flex md:w-48"
      >
        <Link href="/" className="mb-4 flex items-center gap-2 px-2 py-1">
          <Radar className="size-5 text-acid" aria-hidden />
          <span className="font-display text-sm font-semibold tracking-wide">HOODMINT</span>
        </Link>
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(href) ? "page" : undefined}
            className={`flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors duration-[var(--motion-fast)] hover:bg-base-overlay ${
              isActive(href) ? "bg-base-overlay text-acid" : "text-ink-muted"
            }`}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </Link>
        ))}
        <div className="mt-auto flex flex-col gap-1 px-1 py-1">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex items-center justify-between rounded-sm px-2 py-1 text-left text-[11px] text-ink-faint hover:bg-base-overlay hover:text-ink-muted"
          >
            <span>Jump to…</span>
            <kbd className="rounded-xs border border-line px-1 font-mono text-[10px]">⌘K</kbd>
          </button>
          <ThemeToggle initialTheme={theme} />
          <div className="px-2 text-[11px] text-ink-faint">
            <Eye className="mr-1 inline size-3" aria-hidden />
            read-only radar
          </div>
        </div>
      </nav>

      <header className="flex items-center justify-between border-b border-line bg-base-raised px-3 py-2 md:hidden">
        <Link href="/" className="flex items-center gap-2">
          <Radar className="size-5 text-acid" aria-hidden />
          <span className="font-display text-sm font-semibold tracking-wide">HOODMINT</span>
        </Link>
        <div className="flex items-center gap-1">
          {/* Mobile-responsive-design gap, found and fixed 2026-08-22: the
              command palette's only trigger was the desktop rail's "Jump
              to… ⌘K" button (hidden below md) plus the ⌘K keyboard
              shortcut, which isn't a real affordance on a touchscreen —
              this left the palette completely unreachable on mobile. */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Jump to…"
            className="rounded-sm p-1.5 text-ink-muted hover:bg-base-overlay hover:text-ink"
          >
            <Search className="size-4" aria-hidden />
          </button>
          <ThemeToggle initialTheme={theme} />
        </div>
      </header>

      <main className="hood-grid min-w-0 flex-1 pb-16 md:pb-0">{children}</main>

      {/* Mobile bottom navigation */}
      <nav
        aria-label="Primary mobile"
        className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-line bg-base-raised/95 py-1 backdrop-blur md:hidden"
      >
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(href) ? "page" : undefined}
            aria-label={label}
            className={`flex min-w-14 flex-col items-center gap-0.5 rounded-sm px-2 py-1 text-[10px] ${
              isActive(href) ? "text-acid" : "text-ink-muted"
            }`}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </Link>
        ))}
      </nav>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={COMMAND_ITEMS}
      />
    </div>
  );
}
