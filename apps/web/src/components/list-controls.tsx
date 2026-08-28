import Link from "next/link";

/**
 * Shared, server-rendered list controls for the admin lists (wallets, audit).
 * A plain GET <form> for search (query-param state, no client JS) and
 * prev/next links that preserve the current search term — the simple,
 * consistent pagination the admin-crud-standards baseline asks for without
 * pulling in a data-grid.
 */

export const PAGE_SIZE = 20;

export function SearchBox({
  name = "q",
  value,
  placeholder,
  label,
  action,
}: {
  name?: string;
  value: string;
  placeholder: string;
  label: string;
  /** Route the form submits to (defaults to the current page). */
  action?: string;
}) {
  return (
    <search>
      <form action={action} method="get" className="flex items-center gap-2">
        <label htmlFor={`search-${name}`} className="sr-only">
          {label}
        </label>
        <input
          id={`search-${name}`}
          name={name}
          defaultValue={value}
          placeholder={placeholder}
          aria-label={label}
          className="w-56 rounded-sm border border-line bg-base px-3 py-1.5 font-mono text-xs"
        />
        <button
          type="submit"
          className="rounded-sm border border-cyan/40 px-3 py-1.5 font-mono text-xs text-cyan hover:bg-cyan/10"
        >
          Search
        </button>
        {value !== "" ? (
          <Link
            href={action ?? "?"}
            className="font-mono text-[11px] text-ink-faint hover:text-ink-muted"
          >
            Clear
          </Link>
        ) : null}
      </form>
    </search>
  );
}

export function Pagination({
  page,
  total,
  pageSize = PAGE_SIZE,
  query,
  basePath = "",
}: {
  page: number;
  total: number;
  pageSize?: number;
  /** Existing query params to preserve (e.g. the search term), without `page`. */
  query: Record<string, string>;
  basePath?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, page), pageCount);
  const build = (p: number) => {
    const params = new URLSearchParams(query);
    params.set("page", String(p));
    return `${basePath}?${params.toString()}`;
  };
  const start = total === 0 ? 0 : (clamped - 1) * pageSize + 1;
  const end = Math.min(total, clamped * pageSize);

  return (
    <nav
      aria-label="Pagination"
      className="mt-3 flex items-center justify-between font-mono text-[11px] text-ink-faint"
    >
      <span>{total === 0 ? "0 results" : `${start}–${end} of ${total}`}</span>
      <span className="flex items-center gap-2">
        {clamped > 1 ? (
          <Link href={build(clamped - 1)} className="text-cyan hover:underline" rel="prev">
            ← Prev
          </Link>
        ) : (
          <span className="opacity-40">← Prev</span>
        )}
        <span>
          Page {clamped} / {pageCount}
        </span>
        {clamped < pageCount ? (
          <Link href={build(clamped + 1)} className="text-cyan hover:underline" rel="next">
            Next →
          </Link>
        ) : (
          <span className="opacity-40">Next →</span>
        )}
      </span>
    </nav>
  );
}
