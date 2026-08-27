"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

export interface CommandItem {
  readonly href: string;
  readonly label: string;
  readonly group: string;
}

/**
 * Site-wide quick-nav (admin-panel-richness gap, addressed 2026-08-22):
 * ⌘K/Ctrl+K already existed but only ever focused the feed search box
 * (apps/web/src/components/app-shell.tsx, PRD §5.1) — this is additive,
 * not a replacement: app-shell still checks for a search input first and
 * only opens this when there isn't one (admin pages, project detail,
 * calendar, login/setup), so the existing feed shortcut is unchanged.
 *
 * Deliberately v1-scoped to static navigation destinations only (every
 * feed view + every admin section) — no per-project/per-wallet dynamic
 * search yet, to keep this a self-contained client component with no new
 * data dependency. A natural v2 if this proves useful.
 */
export function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: readonly CommandItem[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") {
      return items;
    }
    return items.filter(
      (item) => item.label.toLowerCase().includes(q) || item.group.toLowerCase().includes(q),
    );
  }, [items, query]);

  useEffect(() => {
    if (open) {
      restoreFocusTo.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setActiveIndex(0);
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    restoreFocusTo.current?.focus?.();
    return undefined;
  }, [open]);

  // query is the intended trigger (highlight the top result on every
  // keystroke, matching Spotlight/VSCode's command palette) even though
  // its value isn't read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) {
    return null;
  }

  const activate = (item: CommandItem): void => {
    onClose();
    router.push(item.href);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[activeIndex];
      if (item !== undefined) {
        activate(item);
      }
    }
  };

  const activeItem = filtered[activeIndex];

  return (
    // Backdrop and dialog are siblings, not parent/child — a <button>
    // wrapping the dialog would nest interactive content (the <input>
    // below) inside a <button>, which is invalid HTML. Instead: a real
    // <button> covers the full screen behind (native interactive
    // element, keyboard-operable with no lint suppression needed —
    // click-to-close is a mouse-only convenience on top of Escape,
    // handled by the input's onKeyDown), and the dialog paints over it
    // via normal DOM stacking (later sibling on top), so clicks inside
    // the dialog never reach the button underneath — no
    // stopPropagation needed either.
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh]">
      <button
        type="button"
        aria-label="Close command palette"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative z-10 w-full max-w-md rounded-md border border-line bg-base-raised shadow-xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-listbox"
          aria-activedescendant={activeItem !== undefined ? `cmd-${activeItem.href}` : undefined}
          aria-autocomplete="list"
          placeholder="Jump to…"
          className="w-full border-b border-line bg-transparent px-3 py-2.5 font-mono text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        {/* WAI-ARIA APG's "Editable Combobox With List Autocomplete"
            pattern: role="listbox"/"option" on plain <div>s, not
            <ul>/<li> — <li> carries an implicit `listitem` role that
            role="option" would be overriding, which is exactly what
            trips noNoninteractiveElementToInteractiveRole; <div> has no
            implicit role to conflict with, and is the standard way this
            pattern gets built in practice (most combobox libraries do
            the same). Options are intentionally NOT individually
            focusable — selection is driven by aria-activedescendant on
            the input above, and Enter there is the keyboard equivalent
            of the onClick below, not Tab+Enter on each option. */}
        <div
          id="command-palette-listbox"
          role="listbox"
          aria-label="Destinations"
          className="max-h-80 overflow-y-auto p-1"
        >
          {filtered.map((item, i) => (
            // Deliberately not focusable/keyboard-activated on this
            // element itself — see the WAI-ARIA APG note above the
            // listbox: selection lives on the input's
            // aria-activedescendant + arrow keys, this onClick is the
            // mouse-only path Enter-on-the-input mirrors.
            // biome-ignore lint/a11y/useFocusableInteractive: see above.
            // biome-ignore lint/a11y/useKeyWithClickEvents: see above.
            <div
              key={item.href}
              id={`cmd-${item.href}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => activate(item)}
              className={`flex cursor-pointer items-center justify-between rounded-xs px-2.5 py-1.5 font-mono text-xs ${
                i === activeIndex ? "bg-acid/15 text-acid" : "text-ink-muted"
              }`}
            >
              <span>{item.label}</span>
              <span className="text-[10px] text-ink-faint uppercase">{item.group}</span>
            </div>
          ))}
          {filtered.length === 0 ? (
            <div className="px-2.5 py-1.5 font-mono text-xs text-ink-faint">No matches.</div>
          ) : null}
        </div>
        <div className="border-t border-line px-3 py-1.5 font-mono text-[10px] text-ink-faint">
          ↑↓ navigate · ↵ select · esc close
        </div>
      </div>
    </div>
  );
}
