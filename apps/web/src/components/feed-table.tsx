import { coerceDate, mintConcentrationSeverity } from "@hoodmint/core";
import type { FeedRow } from "@hoodmint/db";
import { ConfidenceTag, EligibilityChip, SourceBadge, StatusChip } from "@hoodmint/ui";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { formatPrice, formatSupply, formatVelocity, shortAddress } from "@/lib/format.ts";
import { CopyButton, Countdown, WatchButton } from "./feed-parts.tsx";

/**
 * Collection socials + OpenSea's own verification, inline so a scam check
 * needs no click-through (user ask 2026-08-28). "OS ✓" is OpenSea's
 * safelist "verified" — the blue check — not our data confidence.
 */
function SocialLinks({ row }: { row: FeedRow }) {
  const links: { href: string; label: string; text: string }[] = [];
  if (row.twitterUsername !== null) {
    links.push({
      href: `https://x.com/${row.twitterUsername}`,
      label: `X profile @${row.twitterUsername}`,
      text: `@${row.twitterUsername}`,
    });
  }
  if (row.projectUrl !== null) {
    let host = row.projectUrl;
    try {
      host = new URL(row.projectUrl).host.replace(/^www\./, "");
    } catch {
      // keep the raw value
    }
    links.push({ href: row.projectUrl, label: `Project website ${host}`, text: host });
  }
  if (row.discordUrl !== null) {
    links.push({ href: row.discordUrl, label: "Discord", text: "discord" });
  }
  const verified = row.safelistStatus === "verified";
  if (links.length === 0 && !verified) {
    return row.safelistStatus === null ? null : (
      <span className="font-mono text-[10px] text-amber">no X / no website</span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 font-mono text-[10px]">
      {verified ? (
        <span className="text-emerald" title="OpenSea verified collection (blue check)">
          OS ✓
        </span>
      ) : null}
      {links.map((l) => (
        <a
          key={l.href}
          href={l.href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={l.label}
          className="text-ink-faint underline-offset-2 hover:text-cyan hover:underline"
        >
          {l.text}
        </a>
      ))}
    </span>
  );
}

export interface FeedTableProps {
  readonly rows: readonly FeedRow[];
  readonly eligibilityByProject: ReadonlyMap<string, string>;
  readonly watchedIds: ReadonlySet<string>;
  readonly watchEnabled: boolean;
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
    <div className="overflow-x-auto">
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
            const eligibility = eligibilityByProject.get(row.id);
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
                      {row.slug !== null ? (
                        <a
                          href={`https://opensea.io/collection/${row.slug}/overview`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="mt-0.5 inline-flex items-center gap-1 rounded-xs border border-acid/40 px-1.5 py-0.5 font-mono text-[10px] text-acid hover:bg-acid/10"
                        >
                          Mint on OpenSea
                          <ExternalLink className="size-3" aria-hidden />
                        </a>
                      ) : null}
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
                      <SocialLinks row={row} />
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
                  {row.stageLabel !== null ? (
                    <div>
                      <div className="text-xs">{row.stageLabel}</div>
                      <div className="font-mono text-[10px] text-ink-faint uppercase">
                        {row.stageKind}
                      </div>
                    </div>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {formatPrice(row.stagePriceWei ?? row.nextStagePriceWei)}
                </td>
                <td className="px-3 py-2">
                  <Countdown
                    iso={(() => {
                      // NEXT/upcoming drops have their start in nextStageStart;
                      // stageStartsAt is the currently-active stage (null until
                      // it opens) — coalesce so upcoming drops show a start
                      // time/countdown instead of blank (found live 2026-08-28).
                      const start = row.nextStageStart ?? row.stageStartsAt;
                      return start !== null ? coerceDate(start).toISOString() : null;
                    })()}
                    label="Stage start"
                    pastPrefix="opened"
                  />
                  {row.stageEndsAt !== null ? (
                    <div>
                      <Countdown
                        iso={coerceDate(row.stageEndsAt).toISOString()}
                        label="Stage end"
                      />
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
                  {eligibility !== undefined ? (
                    <EligibilityChip state={eligibility} />
                  ) : (
                    <EligibilityChip state="UNKNOWN" />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
