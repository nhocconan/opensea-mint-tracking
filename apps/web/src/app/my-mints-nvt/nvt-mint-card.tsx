"use client";

import type { NvtMint } from "@hoodmint/providers";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Globe,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { formatDateTime } from "@/lib/format.ts";

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

function statusBadgeColor(status: string): string {
  switch (status.toLowerCase()) {
    case "live":
      return "border-acid/50 bg-acid/15 text-acid font-semibold";
    case "upcoming":
      return "border-cyan/50 bg-cyan/15 text-cyan";
    case "sold_out":
      return "border-line bg-base-overlay text-ink-faint";
    case "ended":
      return "border-line bg-base-overlay text-ink-faint";
    default:
      return "border-line bg-base-overlay text-ink-muted";
  }
}

function tierBadgeColor(tier: string): string {
  switch (tier.toLowerCase()) {
    case "hot":
      return "border-acid/50 bg-acid/10 text-acid";
    case "warm":
      return "border-amber/50 bg-amber/10 text-amber";
    case "cold":
      return "border-line bg-base-overlay text-ink-muted";
    default:
      return "border-line bg-base-overlay text-ink-faint";
  }
}

export function NvtMintCard({
  mint,
  selectedAccount,
  isWhitelisted,
  whitelistedStages,
}: {
  mint: NvtMint;
  selectedAccount?: string | undefined;
  isWhitelisted: boolean;
  whitelistedStages?: readonly string[] | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const copyContract = async () => {
    try {
      await navigator.clipboard.writeText(mint.contract);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const mintedNum =
    typeof mint.minted === "string" ? Number.parseInt(mint.minted, 10) : (mint.minted ?? 0);
  const supplyNum =
    typeof mint.supply === "string" ? Number.parseInt(mint.supply, 10) : (mint.supply ?? null);
  const percentMinted =
    supplyNum !== null && supplyNum > 0
      ? Math.min(100, Math.round((mintedNum / supplyNum) * 100))
      : null;

  // Active or upcoming stage
  const primaryStage = mint.active_stage ?? mint.next_stage ?? mint.stages[0];

  return (
    <article
      className={`rounded-md border p-4 transition-colors ${
        isWhitelisted
          ? "border-acid/60 bg-base-raised ring-1 ring-acid/20"
          : "border-line bg-base-raised hover:border-line-strong"
      }`}
    >
      {/* Header Bar */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
            <span
              className={`rounded-xs border px-1.5 py-0.5 uppercase tracking-wide ${chainBadgeColor(
                mint.chain,
              )}`}
            >
              {mint.chain}
            </span>
            <span
              className={`rounded-xs border px-1.5 py-0.5 uppercase tracking-wide ${statusBadgeColor(
                mint.status,
              )}`}
            >
              {mint.status === "live" ? "● LIVE NOW" : mint.status.replace("_", " ")}
            </span>
            <span
              className={`rounded-xs border px-1.5 py-0.5 uppercase tracking-wide ${tierBadgeColor(
                mint.tier,
              )}`}
            >
              {mint.tier}
            </span>
            {isWhitelisted ? (
              <span className="inline-flex items-center gap-1 rounded-xs border border-acid/60 bg-acid/20 px-1.5 py-0.5 font-semibold text-acid uppercase">
                <ShieldCheck className="size-3" aria-hidden />
                WHITELISTED
              </span>
            ) : null}
          </div>

          <h3 className="mt-1.5 truncate font-display text-base font-semibold text-ink">
            {mint.name}
          </h3>

          <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
            <span className="truncate">{mint.contract}</span>
            <button
              type="button"
              onClick={copyContract}
              title="Copy contract address"
              className="text-ink-faint hover:text-ink focus:outline-none"
            >
              {copied ? <Check className="size-3 text-acid" /> : <Copy className="size-3" />}
            </button>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1.5">
          {mint.links?.opensea || mint.slug ? (
            <a
              href={mint.links?.opensea || `https://opensea.io/collection/${mint.slug}`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 rounded-sm border border-cyan/50 bg-cyan/15 px-2.5 py-1 font-mono text-xs font-medium text-cyan hover:bg-cyan/25"
            >
              OpenSea <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
          {mint.links?.mint && mint.links.mint !== mint.links?.opensea ? (
            <a
              href={mint.links.mint}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 rounded-sm border border-line bg-base px-2 py-1 font-mono text-xs text-ink-muted hover:text-ink hover:border-line-strong"
            >
              Site <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </div>
      </div>

      {/* Flags notice */}
      {mint.flags && mint.flags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1 font-mono text-[10px]">
          {mint.flags.map((flag) => (
            <span
              key={flag}
              className="rounded-xs border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-amber"
            >
              ⚠️ {flag.replace("_", " ")}
            </span>
          ))}
        </div>
      ) : null}

      {/* Supply and Progress */}
      <div className="mt-3">
        <div className="flex justify-between font-mono text-xs">
          <span className="text-ink-faint">Supply / Minted</span>
          <span className="text-ink">
            {mintedNum.toLocaleString()} / {supplyNum !== null ? supplyNum.toLocaleString() : "∞"}
            {percentMinted !== null ? ` (${percentMinted}%)` : ""}
          </span>
        </div>
        {percentMinted !== null ? (
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-base">
            <div
              className={`h-full transition-all ${
                percentMinted >= 100
                  ? "bg-ink-muted"
                  : mint.status === "live"
                    ? "bg-acid"
                    : "bg-cyan"
              }`}
              style={{ width: `${percentMinted}%` }}
            />
          </div>
        ) : null}
      </div>

      {/* Primary Stage Box */}
      {primaryStage ? (
        <div className="mt-3 rounded-sm border border-line bg-base p-2.5 font-mono text-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-ink flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-cyan inline-block" />
              {primaryStage.label}
              {primaryStage.kind ? (
                <span className="text-[10px] text-ink-faint uppercase">({primaryStage.kind})</span>
              ) : null}
            </span>
            <span className="font-semibold text-acid">
              {formatEthPrice(primaryStage.price, primaryStage.currency)}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[11px] text-ink-muted">
            <div>
              <span className="text-ink-faint">Starts: </span>
              {formatDateTime(new Date(primaryStage.start))}
            </div>
            {primaryStage.end ? (
              <div>
                <span className="text-ink-faint">Ends: </span>
                {formatDateTime(new Date(primaryStage.end))}
              </div>
            ) : null}
            {primaryStage.max_per_wallet !== undefined && primaryStage.max_per_wallet !== null ? (
              <div>
                <span className="text-ink-faint">Max/wallet: </span>
                {primaryStage.max_per_wallet}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Whitelist status info */}
      {isWhitelisted && whitelistedStages && whitelistedStages.length > 0 ? (
        <div className="mt-2 rounded-sm border border-acid/40 bg-acid/10 px-2.5 py-1.5 font-mono text-[11px] text-acid">
          <span className="font-semibold">Eligible Stages:</span> {whitelistedStages.join(", ")}
          {selectedAccount ? (
            <span className="ml-2 text-[10px] text-ink-muted">
              (for {selectedAccount.slice(0, 6)}…{selectedAccount.slice(-4)})
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Expand/Collapse Stages Toggle */}
      {mint.stages && mint.stages.length > 0 ? (
        <div className="mt-3 border-t border-line/60 pt-2">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center justify-between font-mono text-[11px] text-ink-muted hover:text-ink focus:outline-none"
          >
            <span>All Stages ({mint.stages.length})</span>
            <span className="flex items-center gap-0.5 text-cyan">
              {expanded ? (
                <>
                  Less <ChevronUp className="size-3" />
                </>
              ) : (
                <>
                  View all stages <ChevronDown className="size-3" />
                </>
              )}
            </span>
          </button>

          {expanded ? (
            <div className="mt-2 space-y-2">
              {mint.stages.map((stage, idx) => (
                <div
                  key={`${stage.label}-${idx}`}
                  className="rounded-xs border border-line bg-base p-2 font-mono text-[11px]"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-ink flex items-center gap-1.5">
                      <span className="text-ink-faint">{idx + 1}.</span>
                      {stage.label}
                      <span className="text-[10px] text-ink-faint uppercase">[{stage.kind}]</span>
                      {stage.public ? (
                        <span className="text-[10px] text-ink-faint uppercase">(Public)</span>
                      ) : (
                        <span className="text-[10px] text-acid uppercase">(Gated)</span>
                      )}
                    </span>
                    <span className="text-acid font-semibold">
                      {formatEthPrice(stage.price, stage.currency)}
                    </span>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-x-2 text-[10px] text-ink-faint">
                    <div>Start: {formatDateTime(new Date(stage.start))}</div>
                    <div>End: {stage.end ? formatDateTime(new Date(stage.end)) : "Open"}</div>
                    {stage.max_per_wallet !== undefined && stage.max_per_wallet !== null ? (
                      <div>Limit: {stage.max_per_wallet} per wallet</div>
                    ) : null}
                    <div>
                      Status: <span className="capitalize">{stage.state ?? "scheduled"}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* External Links Bar */}
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line/60 pt-2 font-mono text-xs">
        {mint.links?.site ? (
          <a
            href={mint.links.site}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1 text-ink-muted hover:text-cyan"
          >
            <Globe className="size-3" /> Website
          </a>
        ) : null}
        {mint.links?.x ? (
          <a
            href={mint.links.x}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1 text-ink-muted hover:text-cyan"
          >
            𝕏 Profile
          </a>
        ) : null}
        {mint.links?.opensea ? (
          <a
            href={mint.links.opensea}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1 text-ink-muted hover:text-cyan"
          >
            OpenSea
          </a>
        ) : null}
        {mint.links?.mint ? (
          <a
            href={mint.links.mint}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1 text-ink-muted hover:text-acid"
          >
            Mint Portal
          </a>
        ) : null}
      </div>
    </article>
  );
}
