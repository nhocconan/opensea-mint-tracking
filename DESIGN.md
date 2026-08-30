# Design System — HoodMint Radar

Source of truth for every visual and interaction decision. Read this before
changing UI, tokens, motion, or theme behavior. Product contract: `PRD.md` §5.
Local-dev ports (OBJECTIVE override of PRD §16 `localhost:3000`) live in
`docs/decisions/0001-local-dev-ports-and-light-theme.md`.

## Product context

- **What this is:** A self-hosted, read-only NFT drop radar for Robinhood
  Chain. Operators watch discovery, eligibility, and provenance — they never
  sign or mint from this app.
- **Who it's for:** Crypto-native operators (degens who still want numbers
  they can trust). Dense data, short labels, no casino chrome.
- **Space:** On-chain monitoring / allowlist radar. Peers: mint calendars,
  OpenSea drops, explorer dashboards — most either hype or bury the signal.
- **Project type:** Authenticated operator dashboard (feeds, detail, admin).
- **Memorable thing:** "This is a radar, not a casino." Acid on obsidian.
  Public-only is never a whitelist win — the UI language must make that
  impossible to misread.

## Aesthetic direction

- **Direction:** Industrial / utilitarian with degen-native accent — flight
  strip, not landing page.
- **Decoration level:** Intentional. One low-contrast grid on the canvas,
  live pulse dots that also have a text/icon label, 1px rules. No permanent
  glow, no glassmorphism, no bouncing, no gradient CTAs.
- **Mood:** Night-ops terminal that stays readable at 2 a.m. Light mode is
  the same instrument panel on paper, not a marketing inversion.
- **Typefaces (PRD §5.4, required):** Space Grotesk for display/UI;
  Geist Mono for addresses, times, metrics, chips.

## Responsive shells

| Viewport | Shell | Nav | Content |
|---|---|---|---|
| Desktop (`md` ≥ 768px) | Horizontal: left rail + main | Persistent left rail, 12rem, logo + Pulse/All/Live/Next/Latest/Eligible/Watchlist + theme control + "read-only radar" | Dense table default; cards available |
| Mobile (`< 768px`) | Vertical: optional compact header + main + bottom nav | Fixed bottom nav (`aria-label="Primary mobile"`), icon + 10px label, safe-area padding | Card default; bottom padding so content clears the nav (`pb-16`) |

The left rail is `hidden md:flex`. The bottom nav is `md:hidden`. Do not
duplicate both at once. Keyboard: `⌘K` / `Ctrl+K` focuses the global search
input. Focus rings are 2px acid, 2px offset, visible on both themes.

Admin routes reuse the same shell; they do not invent a second chrome.

## Color — token roles

Two complete palettes. **Dark is default** (PRD §5.4 obsidian). Light is a
first-class second theme (OBJECTIVE), not a washed-out invert.

Token names are the CSS custom properties on `:root`. Tailwind utilities
(`bg-base`, `text-ink`, `text-acid`, …) read these variables, so swapping
the theme restyles the whole shell.

### Shared brand (hue, not identical hex)

| Role | Meaning | Usage |
|---|---|---|
| **base** | Canvas | `body`, page background |
| **base-raised** | Surfaces | rail, cards, table header, bottom nav |
| **base-overlay** | Hover / inset | active nav, overlays, code chips |
| **line** / **line-strong** | 1px rules | borders, table rows |
| **ink** / **ink-muted** / **ink-faint** | Text hierarchy | titles, secondary, meta |
| **acid** | Primary / LIVE / WL-adjacent ok | primary actions, active nav, ok chips |
| **cyan** | Information | Next, public-only, source/info |
| **magenta** | Exceptional / crit | restricted-hit counts, errors — rare |
| **amber** | Warning / stale / demo | STALE, DEMO DATA, paused |
| **ok / info / warn / crit** | Semantic aliases | map to acid / cyan / amber / magenta |

Status is **never color-only**: every chip has a text label (`LIVE`,
`PUBLIC ONLY`, `STALE`, …) and an accessible `title`.

### Dark (default)

| Token | Hex | Notes |
|---|---|---|
| `--color-base` | `#070908` | Obsidian (PRD) |
| `--color-base-raised` | `#0d100e` | |
| `--color-base-overlay` | `#121613` | |
| `--color-line` | `#1e2420` | |
| `--color-line-strong` | `#2c352e` | |
| `--color-ink` | `#e8ede9` | High-contrast neutral |
| `--color-ink-muted` | `#9aa69e` | |
| `--color-ink-faint` | `#747f77` | AA-safe meta text on raised dark surfaces |
| `--color-acid` | `#b8ff2e` | Acid-lime primary |
| `--color-acid-dim` | `#86c214` | |
| `--color-cyan` | `#4fd8e8` | Info |
| `--color-cyan-dim` | `#2b93a3` | |
| `--color-magenta` | `#ff4fa3` | Restrained — not a second primary |
| `--color-amber` | `#ffc247` | |

`color-scheme: dark` on the root.

### Light

Paper-terminal: warm green-cast sheet, charcoal ink, **darker** acid/cyan/
magenta so `text-acid` / `text-cyan` / `text-magenta` still meet WCAG AA
against `--color-base`. Same roles, remapped contrast.

| Token | Hex | Notes |
|---|---|---|
| `--color-base` | `#f3f6f1` | Green-cast paper |
| `--color-base-raised` | `#ffffff` | Cards / rail |
| `--color-base-overlay` | `#e7ece4` | |
| `--color-line` | `#d4dcd2` | |
| `--color-line-strong` | `#b7c2b4` | |
| `--color-ink` | `#121613` | |
| `--color-ink-muted` | `#4d5751` | |
| `--color-ink-faint` | `#647068` | AA-safe meta text on paper and white surfaces |
| `--color-acid` | `#3f6d00` | Text-safe lime |
| `--color-acid-dim` | `#5a9208` | |
| `--color-cyan` | `#0a6d78` | Text-safe info |
| `--color-cyan-dim` | `#1591a0` | |
| `--color-magenta` | `#c0166a` | Text-safe exception |
| `--color-amber` | `#985f00` | Text-safe warning on tinted paper |

`color-scheme: light` on the root.

Source of truth for the hex maps is `packages/ui/src/theme.ts`
(`DARK_TOKENS` / `LIGHT_TOKENS`). `packages/ui/src/tokens.css` must stay in
lockstep. Do not introduce a third palette.

## Theme choice and persistence

1. **Default:** `dark` when no preference is stored (PRD §5.4).
2. **Control:** A visible theme toggle in the desktop rail footer and the
   mobile header. `aria-pressed` reflects light mode; the accessible name
   announces the action ("Switch to light theme" / "Switch to dark theme").
3. **Application:** `applyTheme(root, theme)` (shipped in `@hoodmint/ui`)
   sets `data-theme`, `style.colorScheme`, and every documented `--color-*`
   variable on the root. CSS `[data-theme="light"|"dark"]` mirrors the same
   maps so a hard refresh without JS still paints correctly once the server
   has stamped `data-theme` on `<html>`.
4. **Persistence:** HttpOnly `SameSite=Lax` cookie `hoodmint-theme`
   (`dark` | `light`), `Path=/`, 1 year. Set only through the server action
   `persistThemeAction` after Zod-equivalent parse (`parseThemePreference`).
   Not readable by page scripts; SSR in `app/layout.tsx` reads it and stamps
   `<html data-theme>`. No flash of the wrong theme on subsequent loads.
5. **`system`:** `parseThemePreference` accepts `system`.
   `resolveTheme("system", prefers)` follows `prefers-color-scheme`, still
   falling back to dark. The shipped toggle writes explicit `dark`/`light`
   so an operator's choice is stable across machines that disagree on OS
   theme. First visit does **not** auto-follow the OS (default stays dark).
6. **Reduced data:** Theme is not stored in Postgres, logs, or analytics.

## Typography

| Role | Face | Loading | Notes |
|---|---|---|---|
| Display / UI | **Space Grotesk** | `next/font/google` → `--font-space-grotesk` | Titles, nav, body |
| Data / code | **Geist Mono** | `next/font/google` → `--font-geist-mono` | Addresses, times, chips, metrics; `tnum` on tables |

Scale (compact, operator-dense):

| Step | Size | Use |
|---|---|---|
| micro | 10–11px | Mobile nav labels, chip text, uppercase tracking |
| caption | 12px | Meta, DEMO banner, helper |
| body | 14px | Nav, form, table body |
| title | 18px | Page `h1` |
| stat | 30px | Pulse counts |

Tracking: chips and uppercase meta use `tracking-wide` / `tracking-widest`.
Never set raw hex addresses without a copy affordance and explorer link
(PRD §14).

## Spacing, radius, motion

- **Base unit:** 4px. Density: compact.
- **Scale:** 2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32.
- **Radius:** `--radius-xs` 4px (chips, inputs), `--radius-sm` 6px (nav
  items, buttons), `--radius-md` 10px (cards). No pill-everything.
- **Motion:** `--motion-fast` 120ms, `--motion-base` 160ms. Range 120–180ms
  only (PRD §5.4). Easing: standard `ease` / `cubic-bezier(0,0,0.2,1)` for
  the live pulse.
- **`prefers-reduced-motion: reduce`:** kill pulse animation and shimmer;
  force animation/transition duration to ~0. Status remains via text/icon.

## States (PRD §5.5)

| State | Visual | Copy rule |
|---|---|---|
| Loading | `.hood-skeleton` preserves layout; never a full-page spinner | — |
| Empty | Bordered panel + why + one relevant action | "Run scan" / "Add wallet auth" |
| Stale | `StatusChip` → `⚠ STALE` + last success timestamp | Never hide age |
| Partial failure | Cached rows stay; failed source marked; retry exposed | Dashboard never blanks |
| Demo | Sticky `DEMO DATA` banner (amber), identical layout to live | Seeded, not live |
| Eligibility | `WL` / `NOT WL` / `PUBLIC ONLY` / `AUTH NEEDED` / `UNKNOWN` / `ERROR` | **Public-only is cyan info, never acid, never "WL"** |

## Accessibility

- WCAG 2.2 AA contrast for ink-on-base and text-on-chip in **both** themes.
- Complete keyboard path: nav, filters, forms, theme toggle, dialogs.
- Visible focus (acid ring) on every interactive.
- `aria-current="page"` on active nav items; distinct `aria-label` for the
  mobile nav.
- Color is never the only channel for LIVE / STALE / WL / PUBLIC ONLY.
- Images: fixed aspect + fallback (PRD §14).
- `robots: noindex` — this is a private operator tool.

## What we refuse

- Casino clichés, neon rain, coin GIFs, infinite glow.
- Treating `PUBLIC ONLY` as a win state.
- Light mode as "desaturate dark by 20%."
- A second typeface pair "because Space Grotesk is overused." The PRD named
  the faces; the product identity is the radar language, not a font swap.
- Theme flash, theme in localStorage as the only store, or a theme that
  exists only in documentation.

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-16 | Dark default + first-class light | PRD §5.4 is dark-native; OBJECTIVE requires a real light theme |
| 2026-08-16 | Cookie + SSR `data-theme`, `applyTheme` as the testable path | No FOUC; tokens stay data-driven and unit-testable |
| 2026-08-16 | Space Grotesk + Geist Mono | PRD §5.4; identity is radar language, not a font experiment |
| 2026-08-16 | Desktop left rail / mobile bottom nav | PRD §5.1 |
| 2026-08-16 | Local host ports 3950+ | OBJECTIVE override of PRD §16 `:3000` — see ADR 0001 |
| 2026-08-17 | Local host ports 3960+ | Avoid collision with sibling stacks on 3952/3953 — see ADR 0002 |
| 2026-08-21 | Execution roadmap accepted: a distinct, magenta-accented, step-up-authenticated nav surface, never merged into the read-only radar chrome | Keeps "radar, not a casino" honest once any code path can sign — see ADR 0003 and `docs/execution-architecture.md` |
| 2026-08-22 | Minting Calendar added as 8th primary nav item (desktop rail + mobile bottom nav); Admin → Execution landed, magenta-accented per the above, RBAC-gated `execution:configure` | Phase 0/1 backend landed (shadow mode default, zero server custody) — see `docs/execution-architecture.md`. Arm/disarm UI intentionally not built yet (needs WebAuthn step-up first, ADR 0008) |
| 2026-08-22 (later same day) | WebAuthn passkey registration panel + per-plan "Verify + Arm"/"Disarm" controls added to Admin → Execution, same magenta treatment | Closes the ADR 0008 gap above — security-audited (`docs/security-audit-2026-08-22.md`), typecheck/build-verified; needs one live end-to-end passkey cycle before the owner trusts it, same as any new auth flow |
