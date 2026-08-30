# 0012 — AA-safe faint ink and compact targets

Date: 2026-08-30
Status: accepted

## Context

Rendered axe checks found that the original shared `ink-faint` value reached only 4.0:1 on raised
dark surfaces and 4.38:1 on the light base, below the 4.5:1 requirement for 10–11px metadata.
Compact copy and explorer controls in feed rows also rendered at 20px and 12px respectively,
below the WCAG 2.2 minimum target size.

## Decision

Use theme-specific faint ink values: `#747f77` in dark mode and `#647068` in light mode. They keep
the intended muted hierarchy while reaching at least 4.5:1 on the surfaces where the role is used.
Light warning text uses `#985f00` so it also remains compliant on its tinted background. Compact
icon controls use a 24px interaction box while retaining their 12px glyphs.

## Consequences

Metadata is slightly brighter in dark mode and slightly darker in light mode. The layout gains at
most four pixels around compact controls, with no change to their visual glyph size or meaning.
