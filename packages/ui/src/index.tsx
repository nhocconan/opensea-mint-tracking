/**
 * Shared pure display components (no hooks → usable in RSC). Interactive
 * islands (countdown, copy, watch, theme toggle) live in apps/web as client
 * components. Theme maps and `applyTheme` are pure — see ./theme.ts.
 */
import type { ReactNode } from "react";

export type {
  ColorTokenKey,
  Theme,
  ThemePreference,
  ThemeRoot,
  ThemeTokens,
} from "./theme.ts";
export {
  applyTheme,
  COLOR_TOKEN_KEYS,
  DARK_TOKENS,
  DEFAULT_THEME,
  isTheme,
  LIGHT_TOKENS,
  parseThemePreference,
  resolveTheme,
  THEME_COOKIE,
  THEME_PREFERENCES,
  THEMES,
  themeTokens,
} from "./theme.ts";

export type ChipTone = "ok" | "info" | "warn" | "crit" | "neutral";

const TONE_CLASSES: Record<ChipTone, string> = {
  ok: "border-acid/40 text-acid bg-acid/10",
  info: "border-cyan/40 text-cyan bg-cyan/10",
  warn: "border-amber/40 text-amber bg-amber/10",
  crit: "border-magenta/40 text-magenta bg-magenta/10",
  neutral: "border-line-strong text-ink-muted bg-base-raised",
};

export function Chip({
  tone = "neutral",
  children,
  title,
}: {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-xs border px-1.5 py-0.5 font-mono text-[11px] leading-4 tracking-wide uppercase ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

export const STATUS_TONES: Record<string, ChipTone> = {
  LIVE: "ok",
  NEXT: "info",
  ENDED: "neutral",
  SOLD_OUT: "warn",
  PAUSED: "warn",
  UNKNOWN: "neutral",
  STALE: "warn",
  NEW: "info",
};

export function StatusChip({ status, stale }: { status: string; stale?: boolean }) {
  const label = stale ? "⚠ STALE" : status;
  const tone = stale ? "warn" : (STATUS_TONES[status] ?? "neutral");
  return (
    <Chip
      tone={tone}
      title={stale ? "Data older than freshness threshold" : `Lifecycle: ${status}`}
    >
      {label}
    </Chip>
  );
}

export function SourceBadge({ kind }: { kind: string }) {
  const labels: Record<string, string> = {
    opensea: "OpenSea",
    robinhood_rpc: "On-chain",
    calendar: "Calendar",
    manual: "Manual",
  };
  return (
    <span
      title={`Discovered via ${labels[kind] ?? kind}`}
      className="inline-flex items-center rounded-xs border border-line px-1.5 py-0.5 font-mono text-[11px] leading-4 text-ink-muted"
    >
      {labels[kind] ?? kind}
    </span>
  );
}

export function ConfidenceTag({ confidence }: { confidence: string }) {
  const tone: Record<string, ChipTone> = {
    verified: "ok",
    corroborated: "info",
    "single-source": "neutral",
    unverified: "warn",
  };
  return (
    <Chip tone={tone[confidence] ?? "neutral"} title={`Claim confidence: ${confidence}`}>
      {confidence}
    </Chip>
  );
}

export const ELIGIBILITY_TONES: Record<string, ChipTone> = {
  ELIGIBLE_RESTRICTED: "ok",
  INELIGIBLE_RESTRICTED: "neutral",
  PUBLIC_ONLY: "info",
  AUTH_REQUIRED: "warn",
  UNKNOWN: "neutral",
  ERROR: "crit",
};

export const ELIGIBILITY_LABELS: Record<string, string> = {
  ELIGIBLE_RESTRICTED: "WL",
  INELIGIBLE_RESTRICTED: "NOT WL",
  PUBLIC_ONLY: "PUBLIC ONLY",
  AUTH_REQUIRED: "AUTH NEEDED",
  UNKNOWN: "UNKNOWN",
  ERROR: "ERROR",
};

export function EligibilityChip({ state }: { state: string }) {
  return (
    <Chip
      tone={ELIGIBILITY_TONES[state] ?? "neutral"}
      title={
        state === "PUBLIC_ONLY"
          ? "Public mint only — open to everyone, not a whitelist win"
          : `Wallet eligibility: ${state}`
      }
    >
      {ELIGIBILITY_LABELS[state] ?? state}
    </Chip>
  );
}

export function DemoBanner() {
  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex items-center justify-center gap-2 border-b border-amber/40 bg-amber/15 px-4 py-1.5 font-mono text-[12px] tracking-widest text-amber uppercase"
    >
      <span aria-hidden>◆</span> Demo data — seeded, not live <span aria-hidden>◆</span>
    </div>
  );
}
