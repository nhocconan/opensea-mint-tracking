/**
 * Theme tokens and the single application path (DESIGN.md).
 *
 * Dark is the PRD §5.4 default. Light is a first-class second map — not a
 * desaturated invert. `applyTheme` is the function tests and the client
 * toggle both call; CSS `[data-theme]` mirrors the same hex values.
 */

export const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_PREFERENCES = ["dark", "light", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const DEFAULT_THEME: Theme = "dark";
export const THEME_COOKIE = "hoodmint-theme";

export const COLOR_TOKEN_KEYS = [
  "--color-base",
  "--color-base-raised",
  "--color-base-overlay",
  "--color-line",
  "--color-line-strong",
  "--color-ink",
  "--color-ink-muted",
  "--color-ink-faint",
  "--color-acid",
  "--color-acid-dim",
  "--color-cyan",
  "--color-cyan-dim",
  "--color-magenta",
  "--color-amber",
] as const;

export type ColorTokenKey = (typeof COLOR_TOKEN_KEYS)[number];
export type ThemeTokens = Record<ColorTokenKey, string>;

export const DARK_TOKENS: ThemeTokens = {
  "--color-base": "#070908",
  "--color-base-raised": "#0d100e",
  "--color-base-overlay": "#121613",
  "--color-line": "#1e2420",
  "--color-line-strong": "#2c352e",
  "--color-ink": "#e8ede9",
  "--color-ink-muted": "#9aa69e",
  "--color-ink-faint": "#6b756e",
  "--color-acid": "#b8ff2e",
  "--color-acid-dim": "#86c214",
  "--color-cyan": "#4fd8e8",
  "--color-cyan-dim": "#2b93a3",
  "--color-magenta": "#ff4fa3",
  "--color-amber": "#ffc247",
};

export const LIGHT_TOKENS: ThemeTokens = {
  "--color-base": "#f3f6f1",
  "--color-base-raised": "#ffffff",
  "--color-base-overlay": "#e7ece4",
  "--color-line": "#d4dcd2",
  "--color-line-strong": "#b7c2b4",
  "--color-ink": "#121613",
  "--color-ink-muted": "#4d5751",
  "--color-ink-faint": "#6b756e",
  "--color-acid": "#3f6d00",
  "--color-acid-dim": "#5a9208",
  "--color-cyan": "#0a6d78",
  "--color-cyan-dim": "#1591a0",
  "--color-magenta": "#c0166a",
  "--color-amber": "#9a6200",
};

/** Minimal root surface `applyTheme` writes to — real Element or a test double. */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  style: {
    colorScheme: string;
    setProperty(name: string, value: string): void;
    getPropertyValue(name: string): string;
  };
}

export function isTheme(value: string | undefined | null): value is Theme {
  return value === "dark" || value === "light";
}

export function parseThemePreference(raw: string | undefined | null): ThemePreference {
  if (raw === "light" || raw === "dark" || raw === "system") {
    return raw;
  }
  return DEFAULT_THEME;
}

/**
 * Resolve a stored preference against optional `prefers-color-scheme`.
 * Unknown / missing / system-without-hint → dark.
 */
export function resolveTheme(preference: ThemePreference, prefersColorScheme?: Theme): Theme {
  if (preference === "light" || preference === "dark") {
    return preference;
  }
  return prefersColorScheme === "light" ? "light" : DEFAULT_THEME;
}

export function themeTokens(theme: Theme): ThemeTokens {
  return theme === "light" ? LIGHT_TOKENS : DARK_TOKENS;
}

/**
 * Apply a theme to a document (or test) root. Sets `data-theme`,
 * `color-scheme`, and every documented `--color-*` variable.
 */
export function applyTheme(root: ThemeRoot, theme: Theme): void {
  const tokens = themeTokens(theme);
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
  for (const key of COLOR_TOKEN_KEYS) {
    root.style.setProperty(key, tokens[key]);
  }
}
