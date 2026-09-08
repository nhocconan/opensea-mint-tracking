"use client";

import {
  Award,
  Bell,
  BookOpen,
  ChevronRight,
  Flame,
  LayoutDashboard,
  Play,
  Radio,
  RadioTower,
  ScrollText,
  Sliders,
  Sparkles,
  UserCog,
  Users,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { ADMIN_SECTIONS, type AdminNavSection } from "@/lib/admin-nav.ts";

const ICON_MAP = {
  LayoutDashboard,
  RadioTower,
  Flame,
  Award,
  Radio,
  Wallet,
  Bell,
  Play,
  Sparkles,
  Users,
  UserCog,
  ScrollText,
  Sliders,
  BookOpen,
} as const;

const CATEGORIES = ["All", "Data & Feeds", "Operations", "Management"] as const;
type CategoryFilter = (typeof CATEGORIES)[number];

export function AdminNav() {
  const pathname = usePathname();
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("All");

  const activeSection = useMemo<AdminNavSection>(() => {
    // Exact match first
    const exact = ADMIN_SECTIONS.find((s) => s.href === pathname);
    if (exact !== undefined) return exact;

    // Longest prefix match for sub-routes
    const prefixMatches = ADMIN_SECTIONS.filter(
      (s) => s.href !== "/admin" && pathname.startsWith(`${s.href}/`),
    );
    if (prefixMatches.length > 0) {
      const best = prefixMatches.sort((a, b) => b.href.length - a.href.length)[0];
      if (best !== undefined) return best;
    }

    if (pathname.startsWith("/admin")) {
      return ADMIN_SECTIONS[0]!;
    }

    return ADMIN_SECTIONS[0]!;
  }, [pathname]);

  const filteredSections = useMemo(() => {
    if (categoryFilter === "All") return ADMIN_SECTIONS;
    return ADMIN_SECTIONS.filter((s) => s.category === categoryFilter);
  }, [categoryFilter]);

  const ActiveIcon = ICON_MAP[activeSection.icon] ?? LayoutDashboard;

  return (
    <div className="space-y-3">
      {/* Category filter pills & System breadcrumb */}
      <div className="flex items-center justify-between gap-2 border-b border-line/70 pb-2">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint mr-1 hidden sm:inline">
            Category:
          </span>
          {CATEGORIES.map((cat) => {
            const isSelected = categoryFilter === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={`rounded-md px-2.5 py-1 font-mono text-[11px] transition-all cursor-pointer ${
                  isSelected
                    ? "bg-acid/20 text-acid border border-acid/50 font-medium"
                    : "text-ink-muted hover:text-ink hover:bg-base-overlay border border-line/40"
                }`}
              >
                {cat}
              </button>
            );
          })}
        </div>

        <div className="hidden lg:flex items-center gap-2 font-mono text-[11px] text-ink-faint">
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-acid" />
            <span>Timezone: GMT+7</span>
          </span>
          <span>·</span>
          <span>Role: Admin</span>
        </div>
      </div>

      {/* Navigation items grid / rail */}
      <nav
        aria-label="Admin sections"
        className="flex flex-wrap gap-1.5 sm:gap-2"
      >
        {filteredSections.map((section) => {
          const isSectionActive = activeSection.href === section.href;
          const Icon = ICON_MAP[section.icon] ?? LayoutDashboard;

          return (
            <Link
              key={section.href}
              href={section.href}
              aria-current={isSectionActive ? "page" : undefined}
              className={`group inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-xs transition-all duration-150 ${
                isSectionActive
                  ? "border-acid bg-acid/15 text-acid font-medium shadow-[0_0_12px_rgba(184,255,46,0.12)] ring-1 ring-acid/30"
                  : "border-line bg-base-raised/70 text-ink-muted hover:border-line-strong hover:bg-base-overlay hover:text-ink"
              }`}
            >
              {isSectionActive ? (
                <span className="size-1.5 rounded-full bg-acid animate-pulse shrink-0" aria-hidden />
              ) : (
                <Icon
                  className="size-3.5 text-ink-faint group-hover:text-ink-muted transition-colors shrink-0"
                  aria-hidden
                />
              )}
              <span>{section.shortLabel ?? section.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Active Section Context Banner — explicitly tells the operator what is currently being edited */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-base-raised px-4 py-3 shadow-xs">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-acid/50 bg-acid/10 text-acid shadow-xs">
            <ActiveIcon className="size-4.5" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-mono">
              <span className="text-ink-faint">Admin</span>
              <ChevronRight className="size-3 text-ink-faint/60" aria-hidden />
              <span className="text-ink-muted">{activeSection.category}</span>
              <ChevronRight className="size-3 text-ink-faint/60" aria-hidden />
              <span className="text-acid font-medium">{activeSection.label}</span>
              <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-acid/40 bg-acid/15 px-2 py-0.5 font-mono text-[10px] font-medium text-acid">
                <span className="size-1 rounded-full bg-acid animate-pulse" />
                Active Editing
              </span>
            </div>
            <p className="mt-0.5 text-xs text-ink-muted line-clamp-1">
              {activeSection.description}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-faint ml-auto sm:ml-0">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-base px-2.5 py-1">
            <span className="size-1.5 rounded-full bg-acid" />
            <span>Encrypted at rest</span>
          </span>
        </div>
      </div>
    </div>
  );
}
