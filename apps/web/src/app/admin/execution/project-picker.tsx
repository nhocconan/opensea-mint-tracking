"use client";

import { useEffect, useRef, useState } from "react";

interface ProjectHit {
  readonly id: string;
  readonly name: string;
  readonly chainId: number;
  readonly contractAddress: string | null;
}

/**
 * Type-ahead over the existing /api/v1/projects feed endpoint — no new
 * search infrastructure, just a UI on top of what discovery already
 * indexes. Selecting a hit fills the hidden `projectId` input the
 * surrounding form submits.
 */
export function ProjectPicker({ name = "projectId" }: { name?: string }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProjectHit[]>([]);
  const [selected, setSelected] = useState<ProjectHit | null>(null);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    if (query.trim().length < 2) {
      setHits([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams({ view: "all", q: query.trim(), limit: "8" });
      fetch(`/api/v1/projects?${params.toString()}`)
        .then((res) => res.json())
        .then((body: { data?: ProjectHit[] }) => setHits(body.data ?? []))
        .catch(() => setHits([]));
    }, 250);
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  const listboxId = "project-picker-listbox";

  return (
    <div className="relative">
      <label className="block">
        <span className="mb-1 block text-[11px] text-ink-muted">Project</span>
        <input
          value={selected !== null ? selected.name : query}
          onChange={(e) => {
            setSelected(null);
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder="Search by name or slug…"
          autoComplete="off"
          role="combobox"
          aria-expanded={open && hits.length > 0}
          aria-controls={listboxId}
          aria-autocomplete="list"
          className="w-full rounded-sm border border-line bg-base px-3 py-2 text-sm"
        />
      </label>
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      {open && hits.length > 0 ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Matching projects"
          className="absolute z-10 mt-1 w-full rounded-sm border border-line bg-base-raised text-xs shadow-lg"
        >
          {hits.map((hit) => (
            <button
              key={hit.id}
              type="button"
              role="option"
              aria-selected={selected?.id === hit.id}
              onClick={() => {
                setSelected(hit);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left hover:bg-base-overlay"
            >
              <span className="text-ink">{hit.name}</span>{" "}
              <span className="font-mono text-ink-faint">chain {hit.chainId}</span>
            </button>
          ))}
        </div>
      ) : null}
      <p className="mt-1 text-[11px] text-ink-faint" aria-live="polite">
        {selected === null && query.trim().length >= 2 && hits.length === 0
          ? "No matches yet."
          : ""}
      </p>
    </div>
  );
}
