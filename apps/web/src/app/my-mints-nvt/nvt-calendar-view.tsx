"use client";

import type { NvtMint } from "@hoodmint/providers";
import { CalendarDays, Clock, ExternalLink, ShieldCheck } from "lucide-react";
import { formatTimeGmt7, getDayKey } from "@/lib/format.ts";

function formatEthPrice(price: number | string | null | undefined, currency = "ETH"): string {
  if (price === null || price === undefined) return "Unknown";
  const num = typeof price === "string" ? Number.parseFloat(price) : price;
  if (num === 0) return "FREE";
  return `${num} ${currency}`;
}

function chainBadgeColor(chain: string): string {
  switch (chain.toLowerCase()) {
    case "robinhood":
      return "border-cyan/40 bg-cyan/10 text-cyan";
    case "ethereum":
      return "border-blue-500/40 bg-blue-500/10 text-blue-400";
    case "ink":
      return "border-purple-500/40 bg-purple-500/10 text-purple-400";
    case "hyperevm":
      return "border-acid/40 bg-acid/10 text-acid";
    default:
      return "border-line bg-base-overlay text-ink-muted";
  }
}

function formatCountdown(iso: string, now: number): string {
  const diff = new Date(iso).getTime() - now;
  if (diff <= 0) return "Started";
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `in ${days}d ${hours % 24}h`;
  if (hours > 0) return `in ${hours}h ${mins % 60}m`;
  return `in ${mins}m`;
}

function dayTitle(dayKey: string): string {
  const nowDay = getDayKey(new Date());
  const tmrwDate = getDayKey(new Date(Date.now() + 86_400_000));
  const [year, month, day] = dayKey.split("-");
  const d = new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0);
  const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
  const monthName = d.toLocaleDateString("en-US", { month: "short" });

  if (dayKey === nowDay) {
    return `Today (${weekday}, ${monthName} ${day}) · GMT+7`;
  }
  if (dayKey === tmrwDate) {
    return `Tomorrow (${weekday}, ${monthName} ${day}) · GMT+7`;
  }
  return `${weekday}, ${monthName} ${day}, ${year} · GMT+7`;
}

export function NvtCalendarView({
  mints,
  getMintWlInfo,
}: {
  mints: readonly NvtMint[];
  getMintWlInfo: (mint: NvtMint) => { isWhitelisted: boolean; stages: string[] };
}) {
  const now = Date.now();

  // Group mints by Day of their primary upcoming or active stage (in GMT+7)
  const groups = new Map<string, NvtMint[]>();

  for (const mint of mints) {
    const stage = mint.active_stage ?? mint.next_stage ?? mint.stages[0];
    const dateIso = stage?.start ?? mint.updated_at ?? new Date().toISOString();
    const dayKey = getDayKey(dateIso);
    const bucket = groups.get(dayKey) ?? [];
    bucket.push(mint);
    groups.set(dayKey, bucket);
  }

  // Sort groups chronologically
  const sortedDays = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  if (sortedDays.length === 0) {
    return (
      <div className="rounded-md border border-line bg-base-raised p-8 text-center font-mono text-xs text-ink-muted">
        No mints scheduled in the radar calendar.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {sortedDays.map(([dayKey, dayMints]) => {
        const title = dayTitle(dayKey);
        const dayWlHits = dayMints.filter((m) => getMintWlInfo(m).isWhitelisted).length;

        // Sort mints within the day by stage start time
        const sortedDayMints = [...dayMints].sort((a, b) => {
          const aStart = (a.active_stage ?? a.next_stage ?? a.stages[0])?.start ?? "";
          const bStart = (b.active_stage ?? b.next_stage ?? b.stages[0])?.start ?? "";
          return aStart.localeCompare(bStart);
        });

        return (
          <section key={dayKey} className="space-y-3">
            {/* Day Header */}
            <div className="flex items-center justify-between border-b border-line pb-2">
              <div className="flex items-center gap-2">
                <CalendarDays className="size-4 text-cyan" aria-hidden />
                <h2 className="font-mono text-sm font-semibold tracking-wide text-ink">{title}</h2>
                <span className="rounded-xs bg-base-overlay px-2 py-0.5 font-mono text-[10px] text-ink-muted">
                  {dayMints.length} drop{dayMints.length === 1 ? "" : "s"}
                </span>
              </div>
              {dayWlHits > 0 ? (
                <span className="flex items-center gap-1 rounded-sm border border-acid/40 bg-acid/15 px-2 py-0.5 font-mono text-[11px] text-acid">
                  <ShieldCheck className="size-3" />
                  {dayWlHits} WL Hit{dayWlHits === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>

            {/* Timeline Cards */}
            <div className="grid gap-3">
              {sortedDayMints.map((mint) => {
                const { isWhitelisted, stages: wlStages } = getMintWlInfo(mint);
                const stage = mint.active_stage ?? mint.next_stage ?? mint.stages[0];
                const isLive = mint.status === "live";
                const startIso = stage?.start ?? "";
                const countdown = startIso ? formatCountdown(startIso, now) : "";

                return (
                  <div
                    key={mint.id}
                    className={`flex flex-col md:flex-row md:items-center justify-between gap-4 rounded-md border p-3.5 transition-colors font-mono ${
                      isWhitelisted
                        ? "border-acid/50 bg-acid/[0.04]"
                        : "border-line bg-base-raised hover:bg-base-overlay/40"
                    }`}
                  >
                    {/* Time & Countdown */}
                    <div className="flex items-center md:flex-col md:items-start gap-2 md:gap-0.5 shrink-0 md:w-36">
                      <div className="flex items-center gap-1 text-xs font-semibold text-ink">
                        <Clock className="size-3 text-ink-faint" />
                        <span>{formatTimeGmt7(startIso)} GMT+7</span>
                      </div>
                      <div>
                        {isLive ? (
                          <span className="inline-flex items-center gap-1 rounded-xs border border-acid/50 bg-acid/20 px-1.5 py-0.5 text-[9px] font-bold text-acid uppercase">
                            ● LIVE NOW
                          </span>
                        ) : countdown ? (
                          <span className="text-[10px] text-cyan">{countdown}</span>
                        ) : null}
                      </div>
                    </div>

                    {/* Main Drop Info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-sm text-ink truncate hover:text-acid">
                          {mint.name}
                        </span>
                        <span
                          className={`rounded-xs border px-1.5 py-0.2 text-[9px] font-semibold uppercase ${chainBadgeColor(
                            mint.chain,
                          )}`}
                        >
                          {mint.chain}
                        </span>
                        {mint.tier ? (
                          <span className="rounded-xs border border-line bg-base px-1 py-0.2 text-[8px] uppercase text-ink-faint">
                            {mint.tier}
                          </span>
                        ) : null}
                        {isWhitelisted ? (
                          <span className="inline-flex items-center gap-1 rounded-xs border border-acid/40 bg-acid/15 px-1.5 py-0.2 text-[9px] text-acid font-semibold">
                            <ShieldCheck className="size-2.5" />
                            WL HIT: {wlStages.join(", ")}
                          </span>
                        ) : null}
                      </div>

                      {/* Stage details */}
                      {stage ? (
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                          <span className="text-ink font-medium">
                            Stage: <span className="text-acid">{stage.label}</span> ({stage.kind})
                          </span>
                          <span>
                            Price:{" "}
                            <span className="text-ink">
                              {formatEthPrice(stage.price, stage.currency)}
                            </span>
                          </span>
                          {stage.max_per_wallet !== undefined && stage.max_per_wallet !== null ? (
                            <span>Limit: {stage.max_per_wallet}/wallet</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    {/* Supply & Actions */}
                    <div className="flex items-center justify-between md:justify-end gap-3 shrink-0">
                      <div className="text-right text-xs">
                        <div className="text-[11px] text-ink-muted">
                          Supply: {mint.supply ? mint.supply.toLocaleString() : "Open"}
                        </div>
                        <div className="text-[10px] text-ink-faint">
                          Minted:{" "}
                          {typeof mint.minted === "number"
                            ? mint.minted.toLocaleString()
                            : mint.minted}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {mint.links.opensea || mint.slug ? (
                          <a
                            href={
                              mint.links.opensea || `https://opensea.io/collection/${mint.slug}`
                            }
                            target="_blank"
                            rel="noreferrer noopener"
                            className="rounded-sm border border-cyan/50 bg-cyan/15 px-3 py-1.5 text-xs font-semibold text-cyan hover:bg-cyan/25 inline-flex items-center gap-1"
                          >
                            OpenSea <ExternalLink className="size-3" />
                          </a>
                        ) : null}
                        {mint.links.mint && mint.links.mint !== mint.links.opensea ? (
                          <a
                            href={mint.links.mint}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="rounded-sm border border-line bg-base px-2.5 py-1.5 text-xs text-ink-muted hover:text-ink"
                            title="Website / Mint Site"
                          >
                            Site ↗
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
