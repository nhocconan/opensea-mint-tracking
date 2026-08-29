import { can } from "@hoodmint/auth";
import {
  type FeedSocialFilter,
  type FeedSort,
  type FeedView,
  type FeedWlFilter,
  queryFeed,
  trackedWalletEligibilityForStages,
  watchedProjectIds,
} from "@hoodmint/db";
import { Suspense } from "react";
import { container } from "@/lib/container.ts";
import { decisionStage } from "@/lib/mint-presentation.ts";
import { getSessionUser } from "@/lib/session.ts";
import { FeedTable } from "./feed-table.tsx";
import { CursorPager, FilterBar } from "./filters.tsx";

export interface FeedSearchParams {
  readonly q?: string;
  readonly sort?: string;
  readonly price?: string;
  readonly wl?: string;
  readonly social?: string;
  readonly confidence?: string;
  readonly cursor?: string;
}

const SORTS: readonly FeedSort[] = [
  "recent",
  "starting",
  "velocity",
  "minted",
  "name",
  "discovered",
];

/**
 * Shared server-rendered feed view. All tab/filter/sort state lives in the
 * URL (PRD §5.1); data comes straight from repositories, never internal HTTP
 * (PRD §14).
 */
export async function FeedPage({
  view,
  title,
  description,
  searchParams,
}: {
  view: FeedView;
  title: string;
  description: string;
  searchParams: FeedSearchParams;
}) {
  const { db } = container();
  const user = await getSessionUser();

  const sort = SORTS.includes(searchParams.sort as FeedSort)
    ? (searchParams.sort as FeedSort)
    : undefined;
  const price =
    searchParams.price === "free" || searchParams.price === "paid" ? searchParams.price : undefined;
  const wl: FeedWlFilter | undefined =
    searchParams.wl === "hit" || searchParams.wl === "none" ? searchParams.wl : undefined;
  const social: FeedSocialFilter | undefined = ["twitter", "website", "either", "both"].includes(
    searchParams.social ?? "",
  )
    ? (searchParams.social as FeedSocialFilter)
    : undefined;

  // queryFeed and watchedProjectIds are independent — run them together.
  // Wallet eligibility waits on queryFeed's result on purpose: it
  // scopes the eligibility scan to just this page's project ids instead of
  // every eligibility row in the system (see the doc comment on
  // bestEligibilityByProject — this was a real load-test-confirmed
  // bottleneck on every feed page load, fixed 2026-08-22).
  const [page, watched] = await Promise.all([
    queryFeed(db, {
      view,
      userId: user?.id,
      search: searchParams.q,
      sort,
      price,
      wl,
      social,
      cursor: searchParams.cursor,
      limit: 50,
    }),
    user !== null ? watchedProjectIds(db, user.id) : Promise.resolve(new Set<string>()),
  ]);
  const eligibilityScopes = page.rows.map((row) => ({
    projectId: row.id,
    stageId: decisionStage(row).id,
  }));
  const eligibility = await trackedWalletEligibilityForStages(db, eligibilityScopes);

  const exportQuery = new URLSearchParams();
  for (const [key, value] of Object.entries({
    q: searchParams.q,
    sort,
    price,
    wl,
    social,
  })) {
    if (value !== undefined && value !== "") {
      exportQuery.set(key, value);
    }
  }
  const exportHref = (format: "csv" | "json"): string => {
    const params = new URLSearchParams(exportQuery);
    params.set("format", format);
    return `/api/v1/exports/${view}?${params.toString()}`;
  };

  return (
    <section>
      <header className="flex items-start justify-between px-4 pt-5 pb-1">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
        </div>
        <div className="mt-1 flex gap-1.5">
          {view === "live" || view === "next" || view === "latest" || view === "all" ? (
            <a
              href={`/rss/${view}`}
              title="RSS feed — read this view in any feed reader"
              aria-label="RSS feed"
              className="rounded-xs border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint hover:border-acid hover:text-acid"
            >
              RSS
            </a>
          ) : null}
          {can(user?.role, "exports:read") ? (
            <>
              <a
                href={exportHref("csv")}
                title="Export this view as CSV (PRD §7.7)"
                className="rounded-xs border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint hover:border-acid hover:text-acid"
              >
                CSV
              </a>
              <a
                href={exportHref("json")}
                title="Export this view as JSON (PRD §7.7)"
                className="rounded-xs border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-faint hover:border-acid hover:text-acid"
              >
                JSON
              </a>
            </>
          ) : null}
        </div>
      </header>
      <Suspense fallback={<div className="h-12" aria-hidden />}>
        <FilterBar view={view} />
      </Suspense>
      <Suspense
        fallback={
          <div
            role="status"
            aria-busy="true"
            aria-label="Loading feed"
            className="space-y-2 px-4 py-4"
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="hood-skeleton h-9 w-full" />
            ))}
          </div>
        }
      >
        <FeedTable
          rows={page.rows}
          eligibilityByStage={eligibility}
          watchedIds={watched}
          watchEnabled={user !== null}
          specialMintEnabled={can(user?.role, "execution:configure")}
          view={view}
        />
      </Suspense>
      <Suspense fallback={null}>
        <CursorPager view={view} nextCursor={page.nextCursor} />
      </Suspense>
    </section>
  );
}
