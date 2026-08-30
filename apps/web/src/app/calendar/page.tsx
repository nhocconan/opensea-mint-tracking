import { can } from "@hoodmint/auth";
import { coerceDate } from "@hoodmint/core";
import {
  eligibilityStageScopeKey,
  type FeedSocialFilter,
  type FeedWlFilter,
  listCalendarStages,
  type TrackedWalletEligibility,
  trackedWalletEligibilityForStages,
} from "@hoodmint/db";
import { ConfidenceTag, SourceBadge, StatusChip } from "@hoodmint/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Countdown } from "@/components/feed-parts.tsx";
import { FilterBar } from "@/components/filters.tsx";
import {
  MintActions,
  ProjectSocialLinks,
  WalletEligibilityList,
} from "@/components/mint-decision.tsx";
import { container } from "@/lib/container.ts";
import { formatDateTimeLocal, formatDateTimeUtc, formatPrice } from "@/lib/format.ts";
import { singleValue } from "@/lib/search-params.ts";
import { getSessionUser } from "@/lib/session.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Minting calendar" };

async function CalendarWalletEligibility({
  eligibility,
  scopeKey,
}: {
  eligibility: Promise<ReadonlyMap<string, readonly TrackedWalletEligibility[]>>;
  scopeKey: string;
}) {
  const resolved = await eligibility;
  return <WalletEligibilityList wallets={resolved.get(scopeKey)} />;
}

/** Phase-level agenda: one row per upcoming stage, never one row per project. */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = singleValue(await searchParams);
  const { db } = container();
  const user = await getSessionUser();
  const price = params.price === "free" || params.price === "paid" ? params.price : undefined;
  const wl: FeedWlFilter | undefined =
    params.wl === "hit" || params.wl === "none" ? params.wl : undefined;
  const social: FeedSocialFilter | undefined = ["twitter", "website", "either", "both"].includes(
    params.social ?? "",
  )
    ? (params.social as FeedSocialFilter)
    : undefined;
  const hasFilters =
    (params.q !== undefined && params.q.trim() !== "") ||
    price !== undefined ||
    wl !== undefined ||
    social !== undefined;
  const stages = await listCalendarStages(db, {
    now: new Date(),
    limit: 250,
    ...(params.q !== undefined ? { search: params.q } : {}),
    ...(price !== undefined ? { price } : {}),
    ...(wl !== undefined ? { wl } : {}),
    ...(social !== undefined ? { social } : {}),
  }).catch(() => []);
  const eligibility = trackedWalletEligibilityForStages(
    db,
    stages.map((stage) => ({ projectId: stage.projectId, stageId: stage.stageId })),
  ).catch(() => new Map());

  const groups = new Map<string, typeof stages>();
  for (const stage of stages) {
    const dayKey = coerceDate(stage.startsAt).toISOString().slice(0, 10);
    const bucket = groups.get(dayKey) ?? [];
    bucket.push(stage);
    groups.set(dayKey, bucket);
  }
  const days = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const specialMintEnabled = can(user?.role, "execution:configure");

  return (
    <div className="px-4 py-5">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight">Minting calendar</h1>
          <p className="mt-1 max-w-3xl text-xs text-ink-muted">
            Every known upcoming phase, grouped by UTC day. Each event shows the phase, verified
            price, tracked-wallet WL verdict, official links and direct mint actions.
          </p>
        </div>
        <Link
          href="/next"
          className="rounded-xs border border-line px-2 py-1 font-mono text-[10px] text-cyan hover:border-cyan"
        >
          Open Next feed →
        </Link>
      </header>

      <Suspense fallback={<div className="h-12" aria-hidden />}>
        <FilterBar view="calendar" showSort={false} />
      </Suspense>

      {days.length === 0 ? (
        <div className="rounded-md border border-line bg-base-raised p-5 text-sm text-ink-muted">
          {hasFilters ? (
            <>
              <p>No upcoming mint phases match these filters.</p>
              <Link href="/calendar" className="mt-1 inline-block font-mono text-xs text-cyan">
                Clear filters →
              </Link>
            </>
          ) : (
            <>
              <p>No upcoming mint phases have been discovered yet.</p>
              <p className="mt-1 font-mono text-xs">
                Run a scan in Admin → System or track a specific OpenSea collection in Admin →
                Sources.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {days.map(([dayKey, dayStages]) => (
            <section key={dayKey} aria-labelledby={`day-${dayKey}`}>
              <h2
                id={`day-${dayKey}`}
                className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase"
              >
                {new Date(`${dayKey}T00:00:00Z`).toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "short",
                  day: "2-digit",
                  timeZone: "UTC",
                })}{" "}
                · {dayKey} UTC
              </h2>
              <div className="grid gap-3 xl:grid-cols-2">
                {dayStages.map((stage) => {
                  const start = coerceDate(stage.startsAt);
                  const stale =
                    Date.now() - coerceDate(stage.lastSeenAt).getTime() > 3 * 60 * 60 * 1000;
                  return (
                    <article
                      key={stage.stageId}
                      className="rounded-md border border-line bg-base-raised p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <Link
                            href={`/projects/${stage.projectId}`}
                            className="font-medium hover:text-acid"
                          >
                            {stage.projectName}
                          </Link>
                          <ProjectSocialLinks
                            twitterUsername={stage.twitterUsername}
                            projectUrl={stage.projectUrl}
                            discordUrl={stage.discordUrl}
                            safelistStatus={stage.safelistStatus}
                          />
                        </div>
                        <span className="flex items-center gap-1">
                          <StatusChip status={stage.lifecycleStatus} stale={stale} />
                          <ConfidenceTag confidence={stage.confidence} />
                        </span>
                      </div>

                      <dl className="mt-3 grid gap-2 rounded-sm border border-line bg-base p-2.5 sm:grid-cols-3">
                        <div>
                          <dt className="font-mono text-[10px] text-ink-faint uppercase">Phase</dt>
                          <dd className="text-sm">{stage.stageLabel}</dd>
                          <dd className="font-mono text-[10px] text-ink-faint uppercase">
                            {stage.stageKind}
                            {stage.stageMaxPerWallet !== null
                              ? ` · max ${stage.stageMaxPerWallet}/wallet`
                              : ""}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-mono text-[10px] text-ink-faint uppercase">Price</dt>
                          <dd className="font-mono text-sm text-acid">
                            {formatPrice(stage.stagePriceWei)}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-mono text-[10px] text-ink-faint uppercase">Starts</dt>
                          <dd className="font-mono text-xs" title={formatDateTimeUtc(start)}>
                            {formatDateTimeLocal(start)}
                          </dd>
                          <dd>
                            <Countdown iso={start.toISOString()} label="Stage start" />
                          </dd>
                        </div>
                      </dl>

                      <div className="mt-2">
                        <div className="mb-1 font-mono text-[10px] text-ink-faint uppercase">
                          Tracked wallet WL
                        </div>
                        <Suspense
                          fallback={
                            <span role="status" className="font-mono text-[10px] text-ink-faint">
                              WL pending…
                            </span>
                          }
                        >
                          <CalendarWalletEligibility
                            eligibility={eligibility}
                            scopeKey={eligibilityStageScopeKey(stage.projectId, stage.stageId)}
                          />
                        </Suspense>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <MintActions
                          projectId={stage.projectId}
                          slug={stage.projectSlug}
                          specialMintEnabled={specialMintEnabled}
                          stageId={stage.stageId}
                          compact
                        />
                        <span className="inline-flex items-center gap-1">
                          <SourceBadge kind="opensea" />
                          {stale ? (
                            <span
                              className="font-mono text-[10px] text-amber"
                              title={formatDateTimeUtc(stage.lastSeenAt)}
                            >
                              stale evidence
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
