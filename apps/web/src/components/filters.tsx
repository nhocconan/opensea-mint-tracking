"use client";

import { Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useTransition } from "react";

function FilterSelect({
  label,
  value,
  onChange,
  ariaLabel,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="font-mono text-[10px] tracking-widest text-ink-faint uppercase">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        className="min-h-11 w-full appearance-none rounded-sm border border-line bg-base px-2.5 py-2 text-xs text-ink outline-none transition-colors duration-[var(--motion-fast)] hover:border-line-strong focus:border-acid focus:ring-2 focus:ring-acid/30"
      >
        {children}
      </select>
    </label>
  );
}

/**
 * URL-state filters (PRD §5.1): tab, filters, sort, page size, and search all
 * live in query parameters so every view is linkable and refresh-safe.
 */
export function FilterBar({ view, showSort = true }: { view: string; showSort?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const latestQuery = useRef(params.toString());

  useEffect(() => {
    latestQuery.current = params.toString();
  }, [params]);

  const setParam = useCallback(
    (key: string, value: string) => {
      // `useSearchParams` updates after navigation. Keep an eager copy so two
      // quick select changes merge instead of the second replacing the first.
      const next = new URLSearchParams(latestQuery.current);
      if (value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      next.delete("cursor");
      const query = next.toString();
      latestQuery.current = query;
      startTransition(() =>
        router.replace(query === "" ? `/${view}` : `/${view}?${query}`, { scroll: false }),
      );
    },
    [router, view],
  );

  const search = params.get("q") ?? "";
  const sort = params.get("sort") ?? "recent";
  const price = params.get("price") ?? "";
  const wl = params.get("wl") ?? "";
  const social = params.get("social") ?? "";
  const hasFilters = search !== "" || price !== "" || wl !== "" || social !== "";
  const activeFilterCount = [search, price, wl, social].filter(Boolean).length;

  const clearFilters = useCallback(() => {
    const next = new URLSearchParams(latestQuery.current);
    for (const key of ["q", "price", "wl", "social", "cursor"]) {
      next.delete(key);
    }
    const query = next.toString();
    latestQuery.current = query;
    startTransition(() =>
      router.replace(query === "" ? `/${view}` : `/${view}?${query}`, { scroll: false }),
    );
  }, [router, view]);

  return (
    <form
      className={`feed-filter-panel mx-4 my-3 p-3 md:p-4 ${pending ? "is-pending" : ""}`}
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        setParam("q", new FormData(event.currentTarget).get("q")?.toString() ?? "");
      }}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-sm border border-line bg-base px-3 py-2 transition-colors duration-[var(--motion-fast)] focus-within:border-acid focus-within:ring-2 focus-within:ring-acid/30">
          <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
          <span className="sr-only">Search projects</span>
          <input
            name="q"
            type="search"
            key={search}
            defaultValue={search}
            placeholder="Search name, slug, or exact contract (⌘K)"
            aria-label="Search projects"
            className="min-h-11 w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
          />
        </label>
        {showSort ? (
          <div className="hidden w-44 md:block">
            <FilterSelect
              label="Sort"
              value={sort}
              onChange={(value) => setParam("sort", value)}
              ariaLabel="Sort results"
            >
              <option value="recent">Recently seen</option>
              <option value="starting">Starting soonest</option>
              <option value="discovered">First seen</option>
              <option value="velocity">Mint velocity</option>
              <option value="minted">Minted %</option>
              <option value="name">Name</option>
            </FilterSelect>
          </div>
        ) : null}
      </div>
      <div
        className={`mt-3 grid grid-cols-2 gap-2 ${showSort ? "md:grid-cols-4" : "md:grid-cols-3"}`}
      >
        {showSort ? (
          <div className="md:hidden">
            <FilterSelect
              label="Sort"
              value={sort}
              onChange={(value) => setParam("sort", value)}
              ariaLabel="Sort results"
            >
              <option value="recent">Recently seen</option>
              <option value="starting">Starting soonest</option>
              <option value="discovered">First seen</option>
              <option value="velocity">Mint velocity</option>
              <option value="minted">Minted %</option>
              <option value="name">Name</option>
            </FilterSelect>
          </div>
        ) : null}
        <FilterSelect
          label="Price"
          value={price}
          onChange={(value) => setParam("price", value)}
          ariaLabel="Filter by price"
        >
          <option value="">Any price</option>
          <option value="free">Free</option>
          <option value="paid">Paid</option>
        </FilterSelect>
        <FilterSelect
          label="Wallet gate"
          value={wl}
          onChange={(value) => setParam("wl", value)}
          ariaLabel="Filter by tracked-wallet whitelist hit"
        >
          <option value="">Any WL state</option>
          <option value="hit">WL hit</option>
          <option value="none">No WL hit</option>
        </FilterSelect>
        <FilterSelect
          label="Official links"
          value={social}
          onChange={(value) => setParam("social", value)}
          ariaLabel="Filter by official social links"
        >
          <option value="">Any links</option>
          <option value="twitter">Has X</option>
          <option value="website">Has website</option>
          <option value="either">Has X or website</option>
          <option value="both">Has both</option>
        </FilterSelect>
      </div>
      <div className="mt-3 flex min-h-8 flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <p
          className="font-mono text-[10px] tracking-wide text-ink-faint uppercase"
          aria-live="polite"
        >
          {pending
            ? "Updating radar…"
            : activeFilterCount === 0
              ? "All tracked drops"
              : `${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"} active`}
        </p>
        {hasFilters ? (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex min-h-8 items-center rounded-sm border border-line px-2.5 py-1.5 font-mono text-[10px] tracking-wide text-ink-muted uppercase transition-colors duration-[var(--motion-fast)] hover:border-acid hover:text-acid focus:outline-none focus:ring-2 focus:ring-acid/50"
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function CursorPager({ view, nextCursor }: { view: string; nextCursor: string | null }) {
  const router = useRouter();
  const params = useSearchParams();
  if (nextCursor === null) {
    return null;
  }
  return (
    <div className="px-4 py-3">
      <button
        type="button"
        onClick={() => {
          const next = new URLSearchParams(params.toString());
          next.set("cursor", nextCursor);
          router.replace(`/${view}?${next.toString()}`);
        }}
        className="inline-flex min-h-11 items-center rounded-sm border border-line-strong px-3 py-2 font-mono text-xs text-ink-muted transition-colors duration-[var(--motion-fast)] hover:border-acid hover:text-acid focus:outline-none focus:ring-2 focus:ring-acid/50"
      >
        Next page →
      </button>
    </div>
  );
}
