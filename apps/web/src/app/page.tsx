import { can } from "@hoodmint/auth";
import {
  bestEligibilityByProject,
  eligibilityStageScopeKey,
  listProviders,
  queryFeed,
  recentScanRuns,
  type TrackedWalletEligibility,
  trackedWalletEligibilityForStages,
} from "@hoodmint/db";
import { StatusChip } from "@hoodmint/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import {
  decisionStage,
  MintActions,
  ProjectSocialLinks,
  WalletEligibilityList,
} from "@/components/mint-decision.tsx";
import { container } from "@/lib/container.ts";
import { formatDateTimeUtc, formatPrice } from "@/lib/format.ts";
import { getSessionUser } from "@/lib/session.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Pulse" };

async function PulseWalletEligibility({
  eligibility,
  scopeKey,
}: {
  eligibility: Promise<ReadonlyMap<string, readonly TrackedWalletEligibility[]>>;
  scopeKey: string;
}) {
  const resolved = await eligibility;
  return <WalletEligibilityList wallets={resolved.get(scopeKey)} />;
}

/** Operational overview (PRD §5.1): velocity, new collections, provider health. */
export default async function PulsePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const denied = params.denied === "1";
  const { db, config } = container();
  const user = await getSessionUser();

  let providers: Awaited<ReturnType<typeof listProviders>> = [];
  let scans: Awaited<ReturnType<typeof recentScanRuns>> = [];
  let liveCount = 0;
  let nextCount = 0;
  let latest: Awaited<ReturnType<typeof queryFeed>>["rows"] = [];
  let eligibility = new Map<string, string>();
  let latestWallets: Promise<ReadonlyMap<string, readonly TrackedWalletEligibility[]>> =
    Promise.resolve(new Map());
  let dbUp = true;
  try {
    [providers, scans, eligibility] = await Promise.all([
      listProviders(db),
      recentScanRuns(db, 5),
      bestEligibilityByProject(db),
    ]);
    const [live, next, latestPage] = await Promise.all([
      queryFeed(db, { view: "live", limit: 5 }),
      queryFeed(db, { view: "next", limit: 5 }),
      queryFeed(db, { view: "latest", limit: 8 }),
    ]);
    liveCount = live.rows.length;
    nextCount = next.rows.length;
    latest = latestPage.rows;
    latestWallets = trackedWalletEligibilityForStages(
      db,
      latest.map((row) => ({ projectId: row.id, stageId: decisionStage(row).id })),
    ).catch(() => new Map());
  } catch {
    dbUp = false;
  }

  return (
    <section className="px-4 py-5">
      {denied ? (
        <p
          role="alert"
          className="mb-4 rounded-sm border border-magenta/40 bg-magenta/10 px-3 py-2 text-sm text-magenta"
        >
          Access denied — that area requires a higher role.
        </p>
      ) : null}

      <header className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight">Pulse</h1>
          <p className="text-xs text-ink-muted">
            Robinhood Chain · id {config.ROBINHOOD_CHAIN_ID} ·{" "}
            {config.DEMO_MODE ? "demo mode" : "live mode"}
          </p>
        </div>
        {user === null ? (
          <Link
            href="/login"
            className="rounded-sm border border-line-strong px-3 py-1.5 text-xs text-ink-muted hover:border-acid hover:text-acid"
          >
            Sign in
          </Link>
        ) : user.role === "admin" ? (
          <Link
            href="/admin"
            className="rounded-sm border border-line-strong px-3 py-1.5 text-xs text-ink-muted hover:border-acid hover:text-acid"
          >
            Admin console
          </Link>
        ) : null}
      </header>

      {!dbUp ? (
        <p
          role="status"
          className="rounded-sm border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber"
        >
          Database not reachable yet — run migrations (`make migrate`) and refresh.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          <div className="feed-card feed-track-live rounded-md border border-line bg-base-raised p-4">
            <div className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
              Minting now
            </div>
            <div className="mt-1 font-display text-3xl font-semibold text-acid">{liveCount}</div>
            <Link
              href="/live"
              className="mt-1 inline-flex min-h-6 items-center text-xs text-cyan hover:underline focus:outline-none focus:ring-2 focus:ring-cyan/50"
            >
              Open Live view →
            </Link>
          </div>
          <div className="feed-card feed-track-next rounded-md border border-line bg-base-raised p-4">
            <div className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
              Upcoming
            </div>
            <div className="mt-1 font-display text-3xl font-semibold text-cyan">{nextCount}</div>
            <Link
              href="/next"
              className="mt-1 inline-flex min-h-6 items-center text-xs text-cyan hover:underline focus:outline-none focus:ring-2 focus:ring-cyan/50"
            >
              Open Next view →
            </Link>
          </div>
          <div className="feed-card feed-track-new rounded-md border border-line bg-base-raised p-4">
            <div className="font-mono text-[11px] tracking-widest text-ink-faint uppercase">
              WL hits
            </div>
            <div className="mt-1 font-display text-3xl font-semibold text-magenta">
              {[...eligibility.values()].filter((s) => s === "ELIGIBLE_RESTRICTED").length}
            </div>
            <Link
              href="/eligible"
              className="mt-1 inline-flex min-h-6 items-center text-xs text-cyan hover:underline focus:outline-none focus:ring-2 focus:ring-cyan/50"
            >
              Open Eligible view →
            </Link>
          </div>

          <div className="rounded-md border border-line bg-base-raised p-4 md:col-span-2">
            <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
              Provider health
            </h2>
            <ul className="space-y-1.5">
              {providers.map((provider) => (
                <li key={provider.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-mono text-xs">{provider.kind}</span>
                  <span className="flex items-center gap-2">
                    <span
                      className={`inline-block size-2 rounded-full ${
                        provider.healthStatus === "healthy"
                          ? "hood-pulse bg-acid text-acid"
                          : provider.healthStatus === "degraded"
                            ? "bg-amber text-amber"
                            : provider.healthStatus === "down"
                              ? "bg-magenta text-magenta"
                              : "bg-ink-faint text-ink-faint"
                      }`}
                      aria-hidden
                    />
                    <StatusChip
                      status={
                        provider.healthStatus === "unknown"
                          ? "UNKNOWN"
                          : provider.healthStatus.toUpperCase()
                      }
                    />
                  </span>
                </li>
              ))}
              {providers.length === 0 ? (
                <li className="text-xs text-ink-faint">No providers registered yet.</li>
              ) : null}
            </ul>
          </div>

          <div className="rounded-md border border-line bg-base-raised p-4">
            <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
              Recent scans
            </h2>
            <ul className="space-y-1 font-mono text-[11px] text-ink-muted">
              {scans.map((scan) => (
                <li key={scan.id} className="flex justify-between gap-2">
                  <span>{scan.kind}</span>
                  <span
                    className={
                      scan.status === "success"
                        ? "text-acid"
                        : scan.status === "failed"
                          ? "text-magenta"
                          : "text-amber"
                    }
                  >
                    {scan.status}
                  </span>
                </li>
              ))}
              {scans.length === 0 ? <li className="text-ink-faint">No scans yet.</li> : null}
            </ul>
          </div>

          <div className="rounded-md border border-line bg-base-raised p-4 md:col-span-3">
            <h2 className="mb-2 font-mono text-[11px] tracking-widest text-ink-faint uppercase">
              Latest discoveries
            </h2>
            <ul className="space-y-2">
              {latest.map((row) => {
                const stage = decisionStage(row);
                return (
                  <li
                    key={row.id}
                    className={`feed-card feed-track-${row.lifecycleStatus.toLowerCase().replace(/_/g, "-")} grid gap-3 rounded-sm border border-line bg-base p-3 text-sm lg:grid-cols-[1fr_auto]`}
                  >
                    <div className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        {row.imageUrl !== null ? (
                          // biome-ignore lint/performance/noImgElement: allowlisted provider CDN thumbnail
                          <img
                            src={row.imageUrl}
                            alt=""
                            width={32}
                            height={32}
                            loading="lazy"
                            className="size-8 shrink-0 rounded-xs border border-line object-cover"
                          />
                        ) : null}
                        <Link
                          href={`/projects/${row.id}`}
                          className="inline-flex min-h-6 items-center font-medium hover:text-acid"
                        >
                          {row.name}
                        </Link>
                        <StatusChip status={row.lifecycleStatus} />
                      </span>
                      <ProjectSocialLinks
                        twitterUsername={row.twitterUsername}
                        projectUrl={row.projectUrl}
                        discordUrl={row.discordUrl}
                        safelistStatus={row.safelistStatus}
                        showMissing={false}
                      />
                      <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-muted">
                        <span>
                          <span className="feed-section-label">Phase </span>
                          {stage.label ?? "unknown"}
                          {stage.kind !== null ? ` · ${stage.kind}` : ""}
                        </span>
                        <span>
                          <span className="feed-section-label">Price </span>
                          <span className="text-acid">{formatPrice(stage.priceWei)}</span>
                        </span>
                        <span className="text-ink-faint">
                          seen {formatDateTimeUtc(row.firstSeenAt)}
                        </span>
                      </span>
                      <div className="mt-1">
                        <Suspense
                          fallback={
                            <span role="status" className="font-mono text-[10px] text-ink-faint">
                              WL pending…
                            </span>
                          }
                        >
                          <PulseWalletEligibility
                            eligibility={latestWallets}
                            scopeKey={eligibilityStageScopeKey(row.id, stage.id)}
                          />
                        </Suspense>
                      </div>
                    </div>
                    <div className="self-center">
                      <MintActions
                        projectId={row.id}
                        slug={row.slug}
                        specialMintEnabled={can(user?.role, "execution:configure")}
                        stageId={stage.id}
                        compact
                        mobile
                      />
                    </div>
                  </li>
                );
              })}
              {latest.length === 0 ? (
                <li className="py-2 text-xs text-ink-faint">
                  Nothing discovered yet — run a scan from Admin → System.
                </li>
              ) : null}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
