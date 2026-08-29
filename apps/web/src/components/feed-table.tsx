import { coerceDate, mintConcentrationSeverity } from "@hoodmint/core";
import type { FeedRow, TrackedWalletEligibility } from "@hoodmint/db";
import { ConfidenceTag, SourceBadge, StatusChip } from "@hoodmint/ui";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { formatPrice, formatSupply, formatVelocity, shortAddress } from "@/lib/format.ts";
import { CopyButton, Countdown, WatchButton } from "./feed-parts.tsx";
import {
  decisionStage,
  MintActions,
  ProjectSocialLinks,
  WalletEligibilityList,
} from "./mint-decision.tsx";

export interface FeedTableProps {
  readonly rows: readonly FeedRow[];
  readonly eligibilityByProject: ReadonlyMap<string, readonly TrackedWalletEligibility[]>;
  readonly watchedIds: ReadonlySet<string>;
  readonly watchEnabled: boolean;
  readonly specialMintEnabled: boolean;
  readonly view: string;
}

const EXPLORER = "https://robinscan.io";

/**
 * Bot-mint concentration signal (feature backlog quick win): the same
 * rolling-window numbers `formatVelocity` already renders, run through a
 * pure threshold classifier (packages/core). Advisory only — text-labeled,
 * never color-only (DESIGN.md), and never conflated with lifecycle status.
 */
function ConcentrationBadge({
  quantity,
  uniqueRecipients,
}: {
  quantity: number;
  uniqueRecipients: number;
}) {
  const severity = mintConcentrationSeverity(quantity, uniqueRecipients);
  if (severity === "none") {
    return null;
  }
  const label = severity === "high" ? "concentrated" : "watch";
  return (
    <span
      title={`${quantity} mints across only ${uniqueRecipients} wallets in the last hour — possible bot activity`}
      className={`ml-1.5 rounded-xs border px-1 py-0.5 text-[10px] uppercase ${
        severity === "high" ? "border-magenta/40 text-magenta" : "border-amber/40 text-amber"
      }`}
    >
      {label}
    </span>
  );
}

/**
 * Dense table view (PRD §5.2). Every claim row carries status, source,
 * confidence, provenance age, and eligibility chips.
 *
 * Corrected 2026-08-22: this comment previously claimed "cards render on
 * mobile via the same data" — checked directly (grepped for a FeedCard/
 * feed-card component) and confirmed no such component exists anywhere in
 * this codebase; it never shipped. What actually happens on narrow
 * viewports is the `overflow-x-auto` wrapper below on a `min-w-[900px]`
 * table — a real, always-functional horizontal-scroll pattern, not
 * content loss, but not the purpose-built mobile card layout this comment
 * described either. A genuine backlog item, not fixed in this pass:
 * building an actual mobile card view is real, moderate-sized UI work
 * touching every view this component renders (Live/Next/Latest/Eligible/
 * Watchlist/All), not a quick fix alongside finding the gap.
 */
export function FeedTable({
  rows,
  eligibilityByProject,
  watchedIds,
  watchEnabled,
  specialMintEnabled,
}: FeedTableProps) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 border border-dashed border-line px-6 py-12 text-center">
        <p className="text-sm text-ink-muted">No projects match this view yet.</p>
        <p className="font-mono text-xs text-ink-faint">
          Run a scan from Admin → System, or relax filters. New drops appear within one discovery
          cycle.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3 p-3 md:hidden">
        {rows.map((row) => {
          const stage = decisionStage(row);
          const stale =
            Date.now() - coerceDate(row.lastSeenAt).getTime() > 3 * 60 * 60 * 1000 &&
            row.lifecycleStatus !== "ENDED";
          return (
            <article key={row.id} className="rounded-md border border-line bg-base-raised p-3">
              <div className="flex items-start gap-2">
                <WatchButton
                  projectId={row.id}
                  watched={watchedIds.has(row.id)}
                  enabled={watchEnabled}
                />
                <div className="min-w-0 flex-1">
                  <Link href={`/projects/${row.id}`} className="font-medium hover:text-acid">
                    {row.name}
                  </Link>
                  <ProjectSocialLinks
                    twitterUsername={row.twitterUsername}
                    projectUrl={row.projectUrl}
                    discordUrl={row.discordUrl}
                    safelistStatus={row.safelistStatus}
                  />
                </div>
                <StatusChip status={row.lifecycleStatus} stale={stale} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-sm border border-line bg-base px-2.5 py-2">
                <div>
                  <div className="font-mono text-[10px] text-ink-faint uppercase">Phase</div>
                  <div className="text-xs text-ink">{stage.label ?? "Unknown phase"}</div>
                  <div className="font-mono text-[10px] text-ink-faint uppercase">
                    {stage.kind ?? "unknown"}
                    {stage.maxPerWallet !== null ? ` · max ${stage.maxPerWallet}` : ""}
                  </div>
                </div>
                <div>
                  <div className="font-mono text-[10px] text-ink-faint uppercase">Price</div>
                  <div className="font-mono text-sm text-acid">{formatPrice(stage.priceWei)}</div>
                  <Countdown
                    iso={stage.startsAt !== null ? coerceDate(stage.startsAt).toISOString() : null}
                    label="Stage start"
                    pastPrefix="opened"
                  />
                </div>
              </div>
              <div className="mt-2">
                <div className="mb-1 font-mono text-[10px] text-ink-faint uppercase">
                  Tracked wallet WL
                </div>
                <WalletEligibilityList wallets={eligibilityByProject.get(row.id)} />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-ink-faint">
                <span>{formatSupply(row.minted, row.maxSupply, row.supplyVerified)}</span>
                <span>{formatVelocity(row.velocity1h, row.uniqueMinters1h)}</span>
                <span className="inline-flex items-center gap-1">
                  <SourceBadge kind="opensea" />
                  <ConfidenceTag confidence={row.confidence} />
                </span>
              </div>
              <div className="mt-3">
                <MintActions
                  projectId={row.id}
                  slug={row.slug}
                  specialMintEnabled={specialMintEnabled}
                  stageId={stage.id}
                  compact
                />
              </div>
            </article>
          );
        })}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="hood-table w-full min-w-[900px] text-left text-sm">
          <thead>
            <tr className="text-[11px] tracking-wide text-ink-faint uppercase">
              <th scope="col" className="px-3 py-2 font-normal">
                Watch
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Project
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Status
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Source
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Stage
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Price
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Starts
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Supply
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Velocity
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Wallet
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const stage = decisionStage(row);
              // row.lastSeenAt is typed Date but is actually a string at
              // runtime (every Drizzle timestamp column is — found live via
              // a production load test, 2026-08-22, not by typecheck).
              const stale =
                Date.now() - coerceDate(row.lastSeenAt).getTime() > 3 * 60 * 60 * 1000 &&
                row.lifecycleStatus !== "ENDED";
              return (
                <tr key={row.id} className="align-middle">
                  <td className="px-3 py-2">
                    <WatchButton
                      projectId={row.id}
                      watched={watchedIds.has(row.id)}
                      enabled={watchEnabled}
                    />
                  </td>
                  <td className="max-w-[260px] px-3 py-2">
                    <div className="flex items-center gap-2">
                      {row.imageUrl !== null ? (
                        // Remote images restricted to the CSP allowlist with
                        // fixed box to avoid layout shift (PRD §14). Plain <img>
                        // is deliberate: provider CDN hosts are allowlisted in
                        // CSP, and next/image adds optimization deps we don't
                        // need for 28px tiles.
                        // biome-ignore lint/performance/noImgElement: allowlisted provider CDN thumbnails
                        <img
                          src={row.imageUrl}
                          alt=""
                          width={28}
                          height={28}
                          loading="lazy"
                          className="size-7 rounded-xs border border-line object-cover"
                        />
                      ) : (
                        <div
                          className="size-7 rounded-xs border border-line bg-base-overlay"
                          aria-hidden
                        />
                      )}
                      <div className="min-w-0">
                        <Link
                          href={`/projects/${row.id}`}
                          className="block truncate font-medium hover:text-acid"
                        >
                          {row.name}
                        </Link>
                        <div className="mt-1">
                          <MintActions
                            projectId={row.id}
                            slug={row.slug}
                            specialMintEnabled={specialMintEnabled}
                            stageId={stage.id}
                            compact
                          />
                        </div>
                        {row.contractAddress !== null ? (
                          <span className="flex items-center gap-1 font-mono text-[11px] text-ink-faint">
                            {shortAddress(row.contractAddress)}
                            <CopyButton value={row.contractAddress} label="Contract" />
                            <a
                              href={`${EXPLORER}/address/${row.contractAddress}`}
                              target="_blank"
                              rel="noreferrer noopener"
                              aria-label="View contract on explorer"
                              className="text-ink-faint hover:text-cyan"
                            >
                              <ExternalLink className="size-3" aria-hidden />
                            </a>
                          </span>
                        ) : (
                          <span className="font-mono text-[11px] text-ink-faint">
                            no contract yet
                          </span>
                        )}
                        <ProjectSocialLinks
                          twitterUsername={row.twitterUsername}
                          projectUrl={row.projectUrl}
                          discordUrl={row.discordUrl}
                          safelistStatus={row.safelistStatus}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <StatusChip status={row.lifecycleStatus} stale={stale} />
                      {stale ? (
                        <span className="font-mono text-[10px] text-ink-faint">
                          seen{" "}
                          {coerceDate(row.lastSeenAt).toISOString().slice(5, 16).replace("T", " ")}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <SourceBadge kind="opensea" />
                      <ConfidenceTag confidence={row.confidence} />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {stage.label !== null ? (
                      <div>
                        <div className="text-xs">{stage.label}</div>
                        <div className="font-mono text-[10px] text-ink-faint uppercase">
                          {stage.kind}
                          {stage.maxPerWallet !== null ? ` · max ${stage.maxPerWallet}` : ""}
                        </div>
                      </div>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{formatPrice(stage.priceWei)}</td>
                  <td className="px-3 py-2">
                    <Countdown
                      iso={(() => {
                        // NEXT/upcoming drops have their start in nextStageStart;
                        // stageStartsAt is the currently-active stage (null until
                        // it opens) — coalesce so upcoming drops show a start
                        // time/countdown instead of blank (found live 2026-08-28).
                        return stage.startsAt !== null
                          ? coerceDate(stage.startsAt).toISOString()
                          : null;
                      })()}
                      label="Stage start"
                      pastPrefix="opened"
                    />
                    {stage.endsAt !== null ? (
                      <div>
                        <Countdown iso={coerceDate(stage.endsAt).toISOString()} label="Stage end" />
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatSupply(row.minted, row.maxSupply, row.supplyVerified)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatVelocity(row.velocity1h, row.uniqueMinters1h)}
                    <ConcentrationBadge
                      quantity={row.velocity1h}
                      uniqueRecipients={row.uniqueMinters1h}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <WalletEligibilityList wallets={eligibilityByProject.get(row.id)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
