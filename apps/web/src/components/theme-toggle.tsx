"use client";

import { applyTheme, type Theme } from "@hoodmint/ui";
import { Moon, Sun } from "lucide-react";
import { useState, useTransition } from "react";
import { persistThemeAction } from "@/app/theme-actions.ts";

export function ThemeToggle({ initialTheme }: { initialTheme: Theme }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [, startTransition] = useTransition();

  const next: Theme = theme === "dark" ? "light" : "dark";

  const onToggle = (): void => {
    setTheme(next);
    applyTheme(document.documentElement, next);
    startTransition(() => {
      void persistThemeAction(next);
    });
  };

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={theme === "light"}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Light theme" : "Dark theme"}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-ink-muted transition-colors duration-[var(--motion-fast)] hover:bg-base-overlay hover:text-ink focus:outline-none focus:ring-2 focus:ring-acid/50"
    >
      {theme === "dark" ? (
        <Sun className="size-3.5" aria-hidden />
      ) : (
        <Moon className="size-3.5" aria-hidden />
      )}
      <span className="hidden md:inline">{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}
