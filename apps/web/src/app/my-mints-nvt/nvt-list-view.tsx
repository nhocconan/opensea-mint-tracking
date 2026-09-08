"use client";

import type { NvtMint } from "@hoodmint/providers";
import { Check, Copy, ExternalLink, Globe, ShieldCheck } from "lucide-react";
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

export function NvtListView({
  mints,
  getMintWlInfo,
}: {
  mints: readonly NvtMint[];
  getMintWlInfo: (mint: NvtMint) => { isWhitelisted: boolean; stages: string[] };
}) {
  const [copiedContract, setCopiedContract] = useState<string | null>(null);

  const copyContract = (contract: string) => {
    navigator.clipboard.writeText(contract);
    setCopiedContract(contract);
    setTimeout(() => setCopiedContract(null), 2000);
  };

  return (
    <div className="overflow-x-auto rounded-md border border-line bg-base-raised">
      <table className="w-full border-collapse text-left font-mono text-xs">
        <caption className="sr-only">NeverFuckingTrade Drops List View</caption>
        <thead>
          <tr className="border-b border-line bg-base-overlay/40 text-[10px] tracking-wider text-ink-faint uppercase">
            <th scope="col" className="px-3 py-2.5">
              Status &amp; Chain
            </th>
            <th scope="col" className="px-3 py-2.5">
              Project / Drop
            </th>
            <th scope="col" className="px-3 py-2.5">
              Primary Stage &amp; Price
            </th>
            <th scope="col" className="px-3 py-2.5">
              WL Eligibility
            </th>
            <th scope="col" className="px-3 py-2.5">
              Supply / Minted
            </th>
            <th scope="col" className="px-3 py-2.5">
              Starts At (GMT+7)
            </th>
            <th scope="col" className="px-3 py-2.5 text-right">
              Links
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">
          {mints.map((mint) => {
            const { isWhitelisted, stages: wlStages } = getMintWlInfo(mint);
            const primaryStage = mint.active_stage ?? mint.next_stage ?? mint.stages[0];
            const mintedNum =
              typeof mint.minted === "string" ? Number.parseFloat(mint.minted) : mint.minted;
            const supplyNum =
              mint.supply !== null && mint.supply !== undefined
                ? typeof mint.supply === "string"
                  ? Number.parseFloat(mint.supply)
                  : mint.supply
                : undefined;
            const progress =
              supplyNum && supplyNum > 0
                ? Math.min(100, Math.round((mintedNum / supplyNum) * 100))
                : undefined;

            return (
              <tr
                key={mint.id}
                className={`transition-colors hover:bg-base-overlay/30 ${
                  isWhitelisted ? "bg-acid/[0.03]" : ""
                }`}
              >
                {/* Status & Chain */}
                <td className="whitespace-nowrap px-3 py-3">
                  <div className="flex flex-col gap-1">
                    <span
                      className={`inline-flex w-fit items-center rounded-xs border px-1.5 py-0.5 text-[9px] uppercase ${statusBadgeColor(
                        mint.status,
                      )}`}
                    >
                      {mint.status === "live" ? "● LIVE" : mint.status}
                    </span>
                    <span
                      className={`inline-flex w-fit items-center rounded-xs border px-1.5 py-0.5 text-[9px] font-semibold uppercase ${chainBadgeColor(
                        mint.chain,
                      )}`}
                    >
                      {mint.chain}
                    </span>
                  </div>
                </td>

                {/* Project / Drop */}
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <div className="font-semibold text-ink hover:text-acid truncate max-w-[200px]">
                      {mint.name}
                    </div>
                    {mint.tier ? (
                      <span
                        className={`rounded-xs border px-1 py-0.2 text-[8px] uppercase ${tierBadgeColor(
                          mint.tier,
                        )}`}
                      >
                        {mint.tier}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-muted">
                    {mint.slug ? <span>{mint.slug}</span> : null}
                    <button
                      type="button"
                      onClick={() => copyContract(mint.contract)}
                      className="inline-flex items-center gap-0.5 hover:text-ink text-ink-faint"
                      title="Copy contract"
                    >
                      <span>
                        {mint.contract.slice(0, 6)}…{mint.contract.slice(-4)}
                      </span>
                      {copiedContract === mint.contract ? (
                        <Check className="size-2.5 text-acid" />
                      ) : (
                        <Copy className="size-2.5" />
                      )}
                    </button>
                  </div>
                </td>

                {/* Primary Stage & Price */}
                <td className="px-3 py-3">
                  {primaryStage ? (
                    <div>
                      <div className="font-medium text-ink flex items-center gap-1">
                        <span>{primaryStage.label}</span>
                        <span className="text-[10px] text-ink-faint uppercase">
                          ({primaryStage.kind})
                        </span>
                      </div>
                      <div className="text-[11px] text-acid">
                        {formatEthPrice(primaryStage.price, primaryStage.currency)}
                      </div>
                    </div>
                  ) : (
                    <span className="text-ink-faint">No stages</span>
                  )}
                </td>

                {/* WL Eligibility */}
                <td className="whitespace-nowrap px-3 py-3">
                  {isWhitelisted ? (
                    <div className="inline-flex items-center gap-1 rounded-sm border border-acid/40 bg-acid/15 px-2 py-0.5 text-acid font-medium text-[11px]">
                      <ShieldCheck className="size-3" />
                      <span>Eligible: {wlStages.join(", ") || "Whitelisted"}</span>
                    </div>
                  ) : (
                    <span className="text-ink-faint text-[10px]">No WL hits</span>
                  )}
                </td>

                {/* Supply / Minted */}
                <td className="whitespace-nowrap px-3 py-3">
                  <div>
                    <span className="text-ink font-medium">{mintedNum.toLocaleString()}</span>
                    <span className="text-ink-faint">
                      {" "}
                      / {supplyNum !== undefined ? supplyNum.toLocaleString() : "∞"}
                    </span>
                    {progress !== undefined ? (
                      <span className="ml-1 text-[10px] text-ink-muted">({progress}%)</span>
                    ) : null}
                  </div>
                  {progress !== undefined ? (
                    <div className="mt-1 h-1 w-24 rounded-full bg-line overflow-hidden">
                      <div
                        className="h-full bg-acid rounded-full"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  ) : null}
                </td>

                {/* Starts At */}
                <td className="whitespace-nowrap px-3 py-3 text-[11px]">
                  {primaryStage?.start ? (
                    <div>
                      <div className="text-ink">{formatDateTime(new Date(primaryStage.start))}</div>
                      {primaryStage.end ? (
                        <div className="text-[10px] text-ink-faint">
                          Ends: {formatDateTime(new Date(primaryStage.end))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>

                {/* Links */}
                <td className="whitespace-nowrap px-3 py-3 text-right">
                  <div className="inline-flex items-center gap-1.5">
                    {mint.links.mint ? (
                      <a
                        href={mint.links.mint}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="rounded-xs border border-acid/40 bg-acid/10 px-2 py-1 text-[10px] font-semibold text-acid hover:bg-acid/20"
                      >
                        Mint ↗
                      </a>
                    ) : null}
                    {mint.links.opensea ? (
                      <a
                        href={mint.links.opensea}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="rounded-xs border border-cyan/40 bg-cyan/10 p-1 text-cyan hover:bg-cyan/20"
                        title="OpenSea"
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                    {mint.links.site ? (
                      <a
                        href={mint.links.site}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="rounded-xs border border-line bg-base p-1 text-ink-muted hover:text-ink"
                        title="Website"
                      >
                        <Globe className="size-3" />
                      </a>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
