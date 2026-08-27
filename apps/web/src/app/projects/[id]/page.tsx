import {
  chainAddressUrl,
  chainTxUrl,
  coerceDate,
  computeLifecycle,
  holderConcentrationSeverity,
} from "@hoodmint/core";
import {
  eligibilityForProject,
  getHolderConcentration,
  getProjectDetail,
  getRaritySnapshot,
  latestSignalsForProject,
  recentMintEvents,
  velocitySeries,
} from "@hoodmint/db";
import { ConfidenceTag, EligibilityChip, SourceBadge, StatusChip } from "@hoodmint/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton, Countdown } from "@/components/feed-parts.tsx";
import { container } from "@/lib/container.ts";
import { formatDateTimeLocal, formatDateTimeUtc, formatPrice, shortAddress } from "@/lib/format.ts";
import { RarityRefreshButton } from "./rarity-refresh-button.tsx";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = container();
  const detail = await getProjectDetail(db, id);
  if (detail === undefined) {
    notFound();
  }
  const { project, stages, supply, aliases, conflicts, evidenceRows } = detail;
  const [eligibility, mints, velocity, holders, rarity, signals] = await Promise.all([
    eligibilityForProject(db, project.id),
    recentMintEvents(db, project.id, 15),
    velocitySeries(db, project.id),
    getHolderConcentration(db, project.id),
    getRaritySnapshot(db, project.id),
    latestSignalsForProject(db, project.id),
  ]);

  const latestSupply = supply[0];
  const lifecycle = computeLifecycle({
    stages: stages.map((s) => ({
      label: s.label,
      kind: s.type,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt?.toISOString() ?? null,
      paused: s.paused,
    })),
    isoNow: new Date().toISOString(),
    paused: stages.some((s) => s.paused) ? true : null,
    supply: {
      minted: latestSupply?.minted ?? null,
      maxSupply: latestSupply?.maxSupply ?? null,
      verified: latestSupply?.verified ?? false,
    },
  });
  // project.lastSeenAt is typed Date but is a string at runtime — every
  // Drizzle timestamp column is (found live, 2026-08-22, not by typecheck).
  const stale = Date.now() - coerceDate(project.lastSeenAt).getTime() > 3 * 60 * 60 * 1000;

  return (
    <article className="px-4 py-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-lg font-semibold tracking-tight">{project.name}</h1>
            <StatusChip status={lifecycle} stale={stale} />
            <ConfidenceTag confidence={project.confidence} />
            {aliases.map((a) => (
              <SourceBadge key={a.providerKind} kind={a.providerKind} />
            ))}
          </div>
          {project.contractAddress !== null ? (
            <p className="mt-1 flex items-center gap-1 font-mono text-xs text-ink-muted">
              <a
                href={
                  chainAddressUrl(project.chainId, project.contractAddress) ??
                  `https://robinscan.io/address/${project.contractAddress}`
                }
                target="_blank"
                rel="noreferrer noopener"
                className="hover:text-cyan"
              >
                {shortAddress(project.contractAddress)}
              </a>
              <CopyButton value={project.contractAddress} label="Contract" />
            </p>
          ) : (
            <p className="mt-1 font-mono text-xs text-ink-faint">contract not yet known</p>
          )}
        </div>
        {project.slug !== null ? (
          <a
            href={`https://opensea.io/collection/${project.slug}/overview`}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-sm border border-acid/40 bg-acid/10 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/20"
          >
            Verified mint link ↗
          </a>
        ) : null}
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <section
          aria-labelledby="stage-timeline"
          className="rounded-md border border-line bg-base-raised p-4"
        >
          <h2
            id="stage-timeline"
            className="mb-3 font-mono text-[11px] tracking-widest text-ink-faint uppercase"
          >
            Stage timeline
          </h2>
          <ol className="space-y-3">
            {stages.map((stage) => (
              <li key={stage.id} className="border-l border-line pl-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{stage.label}</span>
                  <span className="font-mono text-[10px] text-ink-faint uppercase">
                    {stage.type}
                  </span>
                  {stage.paused ? <StatusChip status="PAUSED" /> : null}
                </div>
                <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-muted">
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-faint">start</dt>
                    <dd title={stage.startsAt.toISOString()}>
                      {formatDateTimeLocal(stage.startsAt)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-faint">end</dt>
                    <dd title={stage.endsAt?.toISOString() ?? undefined}>
                      {formatDateTimeLocal(stage.endsAt)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-faint">price</dt>
                    <dd>{formatPrice(stage.priceWei)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-faint">max/wallet</dt>
                    <dd>{stage.maxPerWallet ?? "—"}</dd>
                  </div>
                </dl>
                <div className="mt-1">
                  <Countdown iso={stage.startsAt.toISOString()} label="Start" />
                </div>
              </li>
            ))}
            {stages.length === 0 ? (
              <li className="text-xs text-ink-faint">No stages known.</li>
            ) : null}
          </ol>
        </section>

        <section
          aria-labelledby="eligibility-matrix"
          className="rounded-md border border-line bg-base-raised p-4"
        >
          <h2
            id="eligibility-matrix"
            className="mb-3 font-mono text-[11px] tracking-widest text-ink-faint uppercase"
          >
            Wallet × stage eligibility
          </h2>
          {eligibility.length === 0 ? (
            <p className="text-xs text-ink-muted">
              No wallets configured or no checks yet.{" "}
              <Link href="/admin/wallets" className="text-cyan hover:underline">
                Add a wallet
              </Link>{" "}
              to start eligibility tracking.
            </p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-[10px] tracking-wide text-ink-faint uppercase">
                  <th scope="col" className="py-1 font-normal">
                    Wallet
                  </th>
                  <th scope="col" className="py-1 font-normal">
                    Stage
                  </th>
                  <th scope="col" className="py-1 font-normal">
                    Verdict
                  </th>
                  <th scope="col" className="py-1 font-normal">
                    Checked
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line font-mono">
                {eligibility.map((row) => (
                  <tr key={`${row.walletId}-${row.stageId}`}>
                    <td className="py-1.5" title={row.walletAddress}>
                      {row.walletLabel ?? shortAddress(row.walletAddress)}
                    </td>
                    <td className="py-1.5">{row.stageLabel}</td>
                    <td className="py-1.5">
                      <EligibilityChip state={row.status} />
                    </td>
                    <td className="py-1.5 text-ink-faint" title={row.checkedAt.toISOString()}>
                      {formatDateTimeLocal(row.checkedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section
          aria-labelledby="supply-velocity"
          className="rounded-md border border-line bg-base-raised p-4"
        >
          <h2
            id="supply-velocity"
            className="mb-3 font-mono text-[11px] tracking-widest text-ink-faint uppercase"
          >
            Supply &amp; mint velocity
          </h2>
          <p className="font-mono text-sm">
            {latestSupply === undefined
              ? "No supply snapshot yet."
              : `${latestSupply.minted.toString()} minted${
                  latestSupply.maxSupply !== null
                    ? ` / ${latestSupply.maxSupply.toString()} (${latestSupply.verified ? "verified" : "unverified"})`
                    : " (no verified cap — never inferred)"
                }`}
          </p>
          {/* Text alternative satisfies the accessible-description requirement
              for charts (PRD §5.3). */}
          <table className="mt-3 w-full text-left font-mono text-[11px]">
            <caption className="sr-only">
              Five-minute mint quantity and unique minters over the last 48 buckets
            </caption>
            <thead>
              <tr className="text-ink-faint">
                <th scope="col" className="py-1 font-normal">
                  Bucket (UTC)
                </th>
                <th scope="col" className="py-1 font-normal">
                  Mints
                </th>
                <th scope="col" className="py-1 font-normal">
                  Unique wallets
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {velocity.slice(0, 10).map((bucket) => (
                <tr key={bucket.bucketStart.toISOString()}>
                  <td className="py-1">
                    {bucket.bucketStart.toISOString().slice(5, 16).replace("T", " ")}
                  </td>
                  <td className="py-1">{bucket.quantity}</td>
                  <td className="py-1">{bucket.uniqueRecipients}</td>
                </tr>
              ))}
              {velocity.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-2 text-ink-faint">
                    No on-chain activity observed yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <section
          aria-labelledby="holder-concentration"
          className="rounded-md border border-line bg-base-raised p-4"
        >
          <h2
            id="holder-concentration"
            className="mb-3 font-mono text-[11px] tracking-widest text-ink-faint uppercase"
          >
            Holder concentration
          </h2>
          {holders === null || holders.totalMinted === 0 ? (
            <p className="font-mono text-sm text-ink-faint">No mints recorded yet.</p>
          ) : (
            (() => {
              const severity = holderConcentrationSeverity(
                holders.top10SharePct,
                holders.totalMinted,
              );
              const barColor =
                severity === "high" ? "bg-magenta" : severity === "watch" ? "bg-amber" : "bg-acid";
              return (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-mono text-sm">
                      Top 10 wallets hold{" "}
                      <span
                        className={
                          severity === "high"
                            ? "text-magenta"
                            : severity === "watch"
                              ? "text-amber"
                              : "text-ink"
                        }
                      >
                        {holders.top10SharePct}%
                      </span>{" "}
                      of {holders.totalMinted} minted ({holders.uniqueHolders} unique holders)
                    </p>
                    {severity !== "none" ? (
                      <span
                        className={`rounded-xs border px-1.5 py-0.5 text-[10px] uppercase ${
                          severity === "high"
                            ? "border-magenta/40 text-magenta"
                            : "border-amber/40 text-amber"
                        }`}
                      >
                        {severity === "high" ? "concentrated" : "watch"}
                      </span>
                    ) : null}
                  </div>
                  {/* Decorative bar; the text above already states the same
                      percentage — color is never the only channel (PRD a11y bar). */}
                  <div
                    role="img"
                    aria-label={`Top 10 wallets hold ${holders.top10SharePct} percent of minted supply`}
                    className="mt-2 h-2 w-full overflow-hidden rounded-full bg-base"
                  >
                    <div
                      aria-hidden="true"
                      className={`h-full ${barColor}`}
                      style={{ width: `${Math.min(100, holders.top10SharePct)}%` }}
                    />
                  </div>
                  <table className="mt-3 w-full text-left font-mono text-[11px]">
                    <caption className="sr-only">Top holders by minted quantity</caption>
                    <thead>
                      <tr className="text-ink-faint">
                        <th scope="col" className="py-1 font-normal">
                          Wallet
                        </th>
                        <th scope="col" className="py-1 font-normal">
                          Minted
                        </th>
                        <th scope="col" className="py-1 font-normal">
                          Share
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {holders.topHolders.slice(0, 5).map((h) => (
                        <tr key={h.recipient}>
                          <td className="py-1">
                            <a
                              href={
                                chainAddressUrl(project.chainId, h.recipient) ??
                                `https://robinscan.io/address/${h.recipient}`
                              }
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-cyan hover:underline"
                            >
                              {shortAddress(h.recipient)}
                            </a>
                          </td>
                          <td className="py-1">{h.quantity}</td>
                          <td className="py-1">{h.sharePct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-[10px] text-ink-faint">
                    Computed {formatDateTimeUtc(holders.computedAt)} · advisory only — never a
                    block, never eligibility.
                  </p>
                </>
              );
            })()
          )}
        </section>

        <section
          aria-labelledby="community-signals"
          className="rounded-md border border-line bg-base-raised p-4"
        >
          <h2
            id="community-signals"
            className="mb-3 font-mono text-[11px] tracking-widest text-ink-faint uppercase"
          >
            Community signals (X)
          </h2>
          {signals.hype === undefined && signals.risk === undefined ? (
            <p className="font-mono text-sm text-ink-faint">
              No sentiment scan yet — enable with{" "}
              <code className="font-mono">X_SIGNALS_ENABLED</code> and an X API token.
            </p>
          ) : (
            <div className="space-y-3">
              {signals.hype !== undefined ? (
                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-mono text-sm">
                      Hype{" "}
                      <span
                        className={
                          signals.hype.score >= 60
                            ? "text-acid"
                            : signals.hype.score >= 30
                              ? "text-cyan"
                              : "text-ink-muted"
                        }
                      >
                        {signals.hype.score}/100
                      </span>
                    </span>
                    <span className="text-[10px] text-ink-faint">{signals.hype.confidence}</span>
                  </div>
                  <div
                    role="img"
                    aria-label={`Hype score ${signals.hype.score} of 100`}
                    className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-base"
                  >
                    <div
                      aria-hidden="true"
                      className="h-full bg-acid"
                      style={{ width: `${Math.min(100, signals.hype.score)}%` }}
                    />
                  </div>
                </div>
              ) : null}
              {signals.risk !== undefined ? (
                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-mono text-sm">
                      Phishing risk{" "}
                      <span
                        className={
                          signals.risk.score >= 50
                            ? "text-magenta"
                            : signals.risk.score >= 20
                              ? "text-amber"
                              : "text-ink-muted"
                        }
                      >
                        {signals.risk.score}/100
                      </span>
                    </span>
                    {signals.risk.score >= 50 ? (
                      <span className="rounded-xs border border-magenta/40 px-1.5 py-0.5 text-[10px] text-magenta uppercase">
                        high risk
                      </span>
                    ) : null}
                  </div>
                  {Array.isArray(signals.risk.evidence?.flags) &&
                  signals.risk.evidence.flags.length > 0 ? (
                    <p className="mt-1 font-mono text-[10px] text-ink-faint">
                      flags: {(signals.risk.evidence.flags as string[]).slice(0, 6).join(", ")}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <p className="text-[10px] text-ink-faint">
                Advisory only — X chatter, never a block, never eligibility or confidence.{" "}
                {signals.hype !== undefined
                  ? `Computed ${formatDateTimeUtc(signals.hype.observedAt)}`
                  : null}
              </p>
            </div>
          )}
        </section>

        <section
          aria-labelledby="trait-rarity"
          className="rounded-md border border-line bg-base-raised p-4"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2
              id="trait-rarity"
              className="font-mono text-[11px] tracking-widest text-ink-faint uppercase"
            >
              Trait rarity
            </h2>
            {project.slug !== null ? (
              <RarityRefreshButton projectId={project.id} />
            ) : (
              <span className="text-[11px] text-ink-faint">
                No OpenSea slug linked — cannot fetch traits.
              </span>
            )}
          </div>
          {rarity === null ? (
            <p className="font-mono text-sm text-ink-faint">
              Not computed yet — click "Refresh rarity" above.
            </p>
          ) : (
            <>
              <table className="w-full text-left font-mono text-[11px]">
                <caption className="sr-only">Rarest tokens by rarity score</caption>
                <thead>
                  <tr className="text-ink-faint">
                    <th scope="col" className="py-1 font-normal">
                      Rank
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      Token
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      Score
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      Traits
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rarity.topRarest.slice(0, 10).map((token) => (
                    <tr key={token.tokenId}>
                      <td className="py-1 text-cyan">#{token.rank}</td>
                      <td className="py-1">{token.tokenId}</td>
                      <td className="py-1">{token.rarityScore.toFixed(2)}</td>
                      <td className="py-1 text-ink-faint">
                        {token.traits
                          .slice(0, 3)
                          .map((t) => `${t.traitType}: ${t.value}`)
                          .join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[10px] text-ink-faint">
                {rarity.totalTokens} tokens ranked · computed {formatDateTimeUtc(rarity.computedAt)}{" "}
                · "Rarity Score" method (sum of 1/trait-frequency) — advisory only.
              </p>
            </>
          )}
        </section>

        <section
          aria-labelledby="mint-events"
          className="rounded-md border border-line bg-base-raised p-4"
        >
          <h2
            id="mint-events"
            className="mb-3 font-mono text-[11px] tracking-widest text-ink-faint uppercase"
          >
            Recent on-chain mints
          </h2>
          <ul className="divide-y divide-line font-mono text-[11px]">
            {mints.map((mint) => (
              <li key={mint.id} className="flex items-center justify-between gap-2 py-1.5">
                <a
                  href={
                    chainTxUrl(project.chainId, mint.txHash) ??
                    `https://robinscan.io/tx/${mint.txHash}`
                  }
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-cyan hover:underline"
                >
                  {shortAddress(mint.txHash)}
                </a>
                <span className="text-ink-muted">
                  → {shortAddress(mint.recipient)} ×{mint.quantity} blk{" "}
                  {mint.blockNumber.toString()}
                  {mint.finalized ? "" : " · unfinalized"}
                </span>
              </li>
            ))}
            {mints.length === 0 ? (
              <li className="py-2 text-ink-faint">No mint events yet.</li>
            ) : null}
          </ul>
        </section>

        <section
          aria-labelledby="evidence"
          className="rounded-md border border-line bg-base-raised p-4 lg:col-span-2"
        >
          <h2
            id="evidence"
            className="mb-3 font-mono text-[11px] tracking-widest text-ink-faint uppercase"
          >
            Source evidence &amp; provenance
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <h3 className="mb-1 text-xs text-ink-muted">Observations</h3>
              <ul className="space-y-1 font-mono text-[11px] text-ink-muted">
                {aliases.map((alias) => (
                  <li key={alias.providerKind} className="flex justify-between gap-2">
                    <span>
                      <SourceBadge kind={alias.providerKind} /> {alias.externalId}
                    </span>
                    <span
                      className="text-ink-faint"
                      title={coerceDate(alias.lastSeenAt).toISOString()}
                    >
                      seen {formatDateTimeUtc(alias.lastSeenAt)}
                    </span>
                  </li>
                ))}
              </ul>
              <h3 className="mt-3 mb-1 text-xs text-ink-muted">Raw evidence (fetched windows)</h3>
              <ul className="space-y-1 font-mono text-[11px] text-ink-faint">
                {evidenceRows.map((ev) => (
                  <li key={ev.id} className="flex justify-between gap-2">
                    <span>{ev.kind}</span>
                    <span title={ev.fetchedAt.toISOString()}>
                      {formatDateTimeUtc(ev.fetchedAt)}
                    </span>
                  </li>
                ))}
                {evidenceRows.length === 0 ? <li>No evidence retained yet.</li> : null}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 text-xs text-ink-muted">
                Unresolved conflicts {conflicts.length > 0 ? `(${conflicts.length})` : ""}
              </h3>
              {conflicts.length === 0 ? (
                <p className="font-mono text-[11px] text-ink-faint">
                  No conflicting claims. On-chain wins contract identity; OpenSea wins its own
                  schedule.
                </p>
              ) : (
                <ul className="space-y-1 font-mono text-[11px] text-amber">
                  {conflicts.map((conflict, index) => (
                    <li key={index}>
                      {conflict.field}: {JSON.stringify(conflict.valueJson)} (
                      {conflict.providerKind ?? "unknown"}, {formatDateTimeUtc(conflict.observedAt)}
                      )
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 font-mono text-[10px] text-ink-faint">
                Project first seen {formatDateTimeUtc(project.firstSeenAt)} · last seen{" "}
                {formatDateTimeUtc(project.lastSeenAt)}
                {stale ? " · STALE" : ""}
              </p>
            </div>
          </div>
        </section>
      </div>
    </article>
  );
}
