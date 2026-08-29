"use client";

import { Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useTransition } from "react";

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
      className={`flex flex-wrap items-center gap-2 px-4 py-3 ${pending ? "opacity-70" : ""}`}
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        setParam("q", new FormData(event.currentTarget).get("q")?.toString() ?? "");
      }}
    >
      <label className="flex min-w-52 flex-1 items-center gap-2 rounded-sm border border-line bg-base-raised px-2 py-1.5 focus-within:border-acid">
        <Search className="size-4 text-ink-faint" aria-hidden />
        <input
          name="q"
          type="search"
          key={search}
          defaultValue={search}
          placeholder="Search name, slug, or exact contract (⌘K)"
          aria-label="Search projects"
          className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
        />
      </label>
      {showSort ? (
        <label className="flex items-center gap-1 text-xs text-ink-muted">
          Sort
          <select
            value={sort}
            onChange={(e) => setParam("sort", e.target.value)}
            className="min-h-8 rounded-sm border border-line bg-base-raised px-2 py-1.5 text-xs"
            aria-label="Sort results"
          >
            <option value="recent">Recently seen</option>
            <option value="starting">Starting soonest</option>
            <option value="discovered">First seen</option>
            <option value="velocity">Mint velocity</option>
            <option value="minted">Minted %</option>
            <option value="name">Name</option>
          </select>
        </label>
      ) : null}
      <label className="flex items-center gap-1 text-xs text-ink-muted">
        Price
        <select
          value={price}
          onChange={(e) => setParam("price", e.target.value)}
          className="min-h-8 rounded-sm border border-line bg-base-raised px-2 py-1.5 text-xs"
          aria-label="Filter by price"
        >
          <option value="">Any</option>
          <option value="free">Free</option>
          <option value="paid">Paid</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-ink-muted">
        WL
        <select
          value={wl}
          onChange={(e) => setParam("wl", e.target.value)}
          className="min-h-8 rounded-sm border border-line bg-base-raised px-2 py-1.5 text-xs"
          aria-label="Filter by tracked-wallet whitelist hit"
        >
          <option value="">Any</option>
          <option value="hit">WL hit</option>
          <option value="none">No WL hit</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-ink-muted">
        Links
        <select
          value={social}
          onChange={(e) => setParam("social", e.target.value)}
          className="min-h-8 rounded-sm border border-line bg-base-raised px-2 py-1.5 text-xs"
          aria-label="Filter by official social links"
        >
          <option value="">Any</option>
          <option value="twitter">Has X</option>
          <option value="website">Has website</option>
          <option value="either">Has X or website</option>
          <option value="both">Has both</option>
        </select>
      </label>
      {hasFilters ? (
        <button
          type="button"
          onClick={clearFilters}
          className="min-h-8 rounded-sm border border-line px-2 py-1.5 font-mono text-[10px] text-ink-muted hover:border-acid hover:text-acid"
        >
          Clear filters
        </button>
      ) : null}
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
        className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-xs text-ink-muted hover:border-acid hover:text-acid"
      >
        Next page →
      </button>
    </div>
  );
}
