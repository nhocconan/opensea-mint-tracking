import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyTheme,
  COLOR_TOKEN_KEYS,
  DARK_TOKENS,
  DEFAULT_THEME,
  LIGHT_TOKENS,
  parseThemePreference,
  resolveTheme,
  type ThemeRoot,
  themeTokens,
} from "./theme.ts";

function createRoot(): ThemeRoot & {
  readonly attrs: Record<string, string>;
  readonly props: Record<string, string>;
} {
  const attrs: Record<string, string> = {};
  const props: Record<string, string> = {};
  const style = {
    colorScheme: "",
    setProperty(name: string, value: string): void {
      props[name] = value;
    },
    getPropertyValue(name: string): string {
      return props[name] ?? "";
    },
  };
  return {
    attrs,
    props,
    setAttribute(name: string, value: string): void {
      attrs[name] = value;
    },
    getAttribute(name: string): string | null {
      return attrs[name] ?? null;
    },
    style,
  };
}

describe("theme maps (DESIGN.md roles)", () => {
  it("default theme is dark", () => {
    expect(DEFAULT_THEME).toBe("dark");
    expect(themeTokens("dark")).toBe(DARK_TOKENS);
    expect(themeTokens("light")).toBe(LIGHT_TOKENS);
  });

  it("light and dark disagree on every documented color token", () => {
    for (const key of COLOR_TOKEN_KEYS) {
      expect(LIGHT_TOKENS[key], key).not.toBe(DARK_TOKENS[key]);
    }
  });

  it("dark keeps the PRD obsidian / acid / cyan / magenta roles", () => {
    expect(DARK_TOKENS["--color-base"]).toBe("#070908");
    expect(DARK_TOKENS["--color-acid"]).toBe("#b8ff2e");
    expect(DARK_TOKENS["--color-cyan"]).toBe("#4fd8e8");
    expect(DARK_TOKENS["--color-magenta"]).toBe("#ff4fa3");
    expect(DARK_TOKENS["--color-ink"]).toBe("#e8ede9");
  });
});

describe("parseThemePreference / resolveTheme", () => {
  it("accepts dark, light, system; anything else is dark", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference(undefined)).toBe("dark");
    expect(parseThemePreference("neon")).toBe("dark");
  });

  it("system follows prefers-color-scheme and still defaults dark", () => {
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("stamps data-theme, color-scheme, and shipped token values", () => {
    const root = createRoot();
    applyTheme(root, "dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.style.getPropertyValue("--color-base")).toBe(DARK_TOKENS["--color-base"]);
    expect(root.style.getPropertyValue("--color-acid")).toBe(DARK_TOKENS["--color-acid"]);

    applyTheme(root, "light");
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    expect(root.style.getPropertyValue("--color-base")).toBe(LIGHT_TOKENS["--color-base"]);
    expect(root.style.getPropertyValue("--color-ink")).toBe(LIGHT_TOKENS["--color-ink"]);
    expect(root.style.getPropertyValue("--color-acid")).toBe(LIGHT_TOKENS["--color-acid"]);
    expect(root.style.getPropertyValue("--color-cyan")).toBe(LIGHT_TOKENS["--color-cyan"]);
    expect(root.style.getPropertyValue("--color-magenta")).toBe(LIGHT_TOKENS["--color-magenta"]);

    expect(root.style.getPropertyValue("--color-base")).not.toBe(DARK_TOKENS["--color-base"]);
    expect(root.style.getPropertyValue("--color-ink")).not.toBe(DARK_TOKENS["--color-ink"]);
    expect(root.style.getPropertyValue("--color-acid")).not.toBe(DARK_TOKENS["--color-acid"]);
  });

  it("writes every documented token key", () => {
    const root = createRoot();
    applyTheme(root, "light");
    for (const key of COLOR_TOKEN_KEYS) {
      expect(root.style.getPropertyValue(key)).toBe(LIGHT_TOKENS[key]);
    }
  });
});

describe("tokens.css stays locked to the JS maps", () => {
  it("declares both theme selectors and the shared token names", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tokens.css"), "utf8");
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain("color-scheme: dark");
    expect(css).toContain("color-scheme: light");
    expect(css).toContain(DARK_TOKENS["--color-base"]);
    expect(css).toContain(LIGHT_TOKENS["--color-base"]);
    expect(css).toContain(DARK_TOKENS["--color-acid"]);
    expect(css).toContain(LIGHT_TOKENS["--color-acid"]);
    for (const key of COLOR_TOKEN_KEYS) {
      expect(css).toContain(key);
    }

    const darkBlock = css.match(/:root,\s*:root\[data-theme="dark"\]\s*\{([^}]+)\}/)?.[1];
    const lightBlock = css.match(/:root\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1];
    expect(darkBlock).toBeDefined();
    expect(lightBlock).toBeDefined();
    for (const key of COLOR_TOKEN_KEYS) {
      expect(darkBlock, `dark CSS ${key}`).toContain(`${key}: ${DARK_TOKENS[key]}`);
      expect(lightBlock, `light CSS ${key}`).toContain(`${key}: ${LIGHT_TOKENS[key]}`);
    }
  });
});
