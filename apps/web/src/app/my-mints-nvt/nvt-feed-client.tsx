"use client";

import type { NvtMint } from "@hoodmint/providers";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { getNvtMintsAction, type NvtMintsActionResult, scanNvtWlAction } from "@/app/actions.ts";
import { NvtCalendarView } from "./nvt-calendar-view.tsx";
import { NvtListView } from "./nvt-list-view.tsx";
import { NvtMintCard } from "./nvt-mint-card.tsx";

export function NvtFeedClient({ initialData }: { initialData: NvtMintsActionResult }) {
  const [data, setData] = useState<NvtMintsActionResult>(initialData);
  const [viewMode, setViewMode] = useState<"cards" | "list" | "calendar">("cards");
  const [selectedAccount, setSelectedAccount] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedChain, setSelectedChain] = useState<string>("all");
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [selectedTier, setSelectedTier] = useState<string>("all");
  const [freeOnly, setFreeOnly] = useState(false);
  const [whitelistedOnly, setWhitelistedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<"time" | "tier" | "supply" | "name">("time");

  // Whitelist cache per account: Map<address, Map<slugOrContract, stages[]>>
  const [wlCache, setWlCache] = useState<Map<string, Map<string, string[]>>>(new Map());
  const [isScanning, startScanTransition] = useTransition();
  const [isRefreshing, startRefreshTransition] = useTransition();
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  // Refresh mints list
  const handleRefresh = () => {
    startRefreshTransition(async () => {
      const res = await getNvtMintsAction();
      setData(res);
    });
  };

  // Run a WL scan for the selected or primary account
  const handleScanWl = (targetAddress?: string) => {
    const addressToScan =
      targetAddress ?? (selectedAccount !== "all" ? selectedAccount : data.accounts[0]?.address);

    if (!addressToScan) return;

    startScanTransition(async () => {
      setScanMessage(
        `Scanning whitelist for ${addressToScan.slice(0, 6)}…${addressToScan.slice(-4)}`,
      );
      const res = await scanNvtWlAction(addressToScan);
      if (res.ok && res.listed) {
        setScanMessage(res.message);
        // Build map for this address
        const accountMap = new Map<string, string[]>();
        for (const item of res.listed) {
          const stages = item.stages.map((s) => s.label || s.kind || "Whitelisted");
          if (item.slug) accountMap.set(item.slug.toLowerCase(), stages);
          if (item.contract) accountMap.set(item.contract.toLowerCase(), stages);
        }
        setWlCache((prev) => {
          const next = new Map(prev);
          next.set(addressToScan.toLowerCase(), accountMap);
          return next;
        });
      } else {
        setScanMessage(res.message ?? "Scan returned no whitelist matches.");
      }
    });
  };

  // Helper to check if a mint is whitelisted for the selected account
  const getMintWlInfo = useMemo(() => {
    return (mint: NvtMint): { isWhitelisted: boolean; stages: string[] } => {
      if (selectedAccount !== "all") {
        const accountMap = wlCache.get(selectedAccount.toLowerCase());
        if (!accountMap) return { isWhitelisted: false, stages: [] };
        const slugStages = mint.slug ? accountMap.get(mint.slug.toLowerCase()) : undefined;
        const contractStages = mint.contract
          ? accountMap.get(mint.contract.toLowerCase())
          : undefined;
        const stages = slugStages ?? contractStages ?? [];
        return { isWhitelisted: stages.length > 0, stages };
      }

      // If "all", check across any account map
      for (const [, accountMap] of wlCache) {
        const slugStages = mint.slug ? accountMap.get(mint.slug.toLowerCase()) : undefined;
        const contractStages = mint.contract
          ? accountMap.get(mint.contract.toLowerCase())
          : undefined;
        const stages = slugStages ?? contractStages;
        if (stages && stages.length > 0) {
          return { isWhitelisted: true, stages };
        }
      }
      return { isWhitelisted: false, stages: [] };
    };
  }, [selectedAccount, wlCache]);

  // Filter and sort mints
  const filteredMints = useMemo(() => {
    return data.mints
      .filter((mint) => {
        // Search query
        if (searchQuery.trim() !== "") {
          const q = searchQuery.toLowerCase();
          const matchesName = mint.name.toLowerCase().includes(q);
          const matchesSlug = mint.slug?.toLowerCase().includes(q);
          const matchesContract = mint.contract.toLowerCase().includes(q);
          if (!matchesName && !matchesSlug && !matchesContract) return false;
        }

        // Chain filter
        if (selectedChain !== "all" && mint.chain.toLowerCase() !== selectedChain.toLowerCase()) {
          return false;
        }

        // Status filter
        if (selectedStatus !== "all") {
          if (selectedStatus === "live" && mint.status.toLowerCase() !== "live") return false;
          if (selectedStatus === "upcoming" && mint.status.toLowerCase() !== "upcoming")
            return false;
          if (
            selectedStatus === "ended" &&
            mint.status.toLowerCase() !== "ended" &&
            mint.status.toLowerCase() !== "sold_out"
          )
            return false;
        }

        // Tier filter
        if (selectedTier !== "all" && mint.tier.toLowerCase() !== selectedTier.toLowerCase()) {
          return false;
        }

        // Free only filter
        if (freeOnly) {
          const hasFreeStage = mint.stages.some((s) => {
            const p = typeof s.price === "string" ? Number.parseFloat(s.price) : s.price;
            return p === 0;
          });
          if (!hasFreeStage) return false;
        }

        // Whitelisted only filter
        if (whitelistedOnly) {
          const { isWhitelisted } = getMintWlInfo(mint);
          if (!isWhitelisted) return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (sortBy === "name") {
          return a.name.localeCompare(b.name);
        }
        if (sortBy === "supply") {
          const aSup =
            typeof a.supply === "string" ? Number.parseInt(a.supply, 10) : (a.supply ?? 0);
          const bSup =
            typeof b.supply === "string" ? Number.parseInt(b.supply, 10) : (b.supply ?? 0);
          return bSup - aSup;
        }
        if (sortBy === "tier") {
          const ranks: Record<string, number> = { hot: 0, warm: 1, cold: 2, dust: 3 };
          return (ranks[a.tier.toLowerCase()] ?? 4) - (ranks[b.tier.toLowerCase()] ?? 4);
        }
        // "time" - live first, then earliest start
        if (a.status === "live" && b.status !== "live") return -1;
        if (b.status === "live" && a.status !== "live") return 1;
        const aStart = a.active_stage?.start ?? a.next_stage?.start ?? a.stages[0]?.start ?? "";
        const bStart = b.active_stage?.start ?? b.next_stage?.start ?? b.stages[0]?.start ?? "";
        return aStart.localeCompare(bStart);
      });
  }, [
    data.mints,
    searchQuery,
    selectedChain,
    selectedStatus,
    selectedTier,
    freeOnly,
    whitelistedOnly,
    sortBy,
    getMintWlInfo,
  ]);

  if (!data.configured) {
    return (
      <div className="rounded-md border border-amber/50 bg-amber/10 p-6 text-center">
        <AlertCircle className="mx-auto size-8 text-amber" />
        <h2 className="mt-2 font-display text-lg font-semibold text-ink">
          NeverFuckingTrade API Key Required
        </h2>
        <p className="mx-auto mt-2 max-w-md text-xs text-ink-muted">
          To view your eligible mints and live mint radar feeds from NeverFuckingTrade, please add
          your API key in the Admin console.
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <Link
            href="/admin/nvt"
            className="rounded-sm border border-acid/60 bg-acid/15 px-4 py-2 font-mono text-xs font-semibold text-acid hover:bg-acid/25"
          >
            Configure NVT in Admin &rarr;
          </Link>
          <a
            href="https://cdn.neverfuckingtrade.com/api/"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 rounded-sm border border-line px-3 py-2 font-mono text-xs text-ink-muted hover:text-ink"
          >
            Read API docs <ExternalLink className="size-3" />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Account Bar & Whitelist Scan */}
      <section className="rounded-md border border-line bg-base-raised p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Wallet className="size-4 text-cyan" aria-hidden />
            <span className="font-mono text-xs font-semibold text-ink">My Accounts:</span>
            <select
              value={selectedAccount}
              onChange={(e) => setSelectedAccount(e.target.value)}
              className="rounded-sm border border-line bg-base px-2.5 py-1 font-mono text-xs text-ink focus:border-cyan focus:outline-none"
            >
              <option value="all">All Accounts ({data.accounts.length})</option>
              {data.accounts.map((acc) => (
                <option key={acc.address} value={acc.address}>
                  {acc.label
                    ? `${acc.label} (${acc.address.slice(0, 6)}…${acc.address.slice(-4)})`
                    : acc.address}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleScanWl()}
              disabled={isScanning || data.accounts.length === 0}
              className="inline-flex items-center gap-1.5 rounded-sm border border-acid/50 bg-acid/15 px-3 py-1.5 font-mono text-xs text-acid hover:bg-acid/25 disabled:opacity-50"
            >
              <ShieldCheck className="size-3.5" />
              {isScanning ? "Scanning NVT Whitelist…" : "Scan Whitelist at NVT"}
            </button>

            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              title="Refresh mints board from NVT"
              className="inline-flex items-center gap-1 rounded-sm border border-line bg-base px-2.5 py-1.5 font-mono text-xs text-ink-muted hover:text-ink disabled:opacity-50"
            >
              <RefreshCw className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Status / Scan notification */}
        {scanMessage ? (
          <div className="mt-3 flex items-center gap-2 rounded-xs border border-acid/30 bg-acid/10 px-3 py-1.5 font-mono text-xs text-acid">
            <CheckCircle2 className="size-3.5 shrink-0" />
            <span className="truncate">{scanMessage}</span>
          </div>
        ) : null}

        {/* NVT Service telemetry */}
        {data.nvtStatus ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line/60 pt-2 font-mono text-[11px] text-ink-faint">
            {data.nvtStatus.tier ? (
              <span>
                Tier:{" "}
                <span className="text-acid uppercase font-semibold">{data.nvtStatus.tier}</span>
              </span>
            ) : null}
            {data.nvtStatus.usage !== undefined && data.nvtStatus.limit !== undefined ? (
              <span>
                Usage:{" "}
                <span className="text-ink-muted">
                  {data.nvtStatus.usage}/{data.nvtStatus.limit} req/min
                </span>
              </span>
            ) : null}
            {data.nvtStatus.prefix ? (
              <span>
                Key: <span className="text-ink-muted">{data.nvtStatus.prefix}</span>
              </span>
            ) : null}
            <span>
              Total board mints: <span className="text-ink-muted">{data.mints.length}</span>
            </span>
          </div>
        ) : null}
      </section>

      {/* Filter and Search Bar */}
      <section className="rounded-md border border-line bg-base-raised p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {/* Search box */}
          <div className="relative sm:col-span-2">
            <Search className="absolute left-2.5 top-2.5 size-4 text-ink-faint" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, slug, or contract…"
              aria-label="Search mints"
              className="w-full rounded-sm border border-line bg-base pl-9 pr-3 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-acid focus:outline-none"
            />
          </div>

          {/* Chain filter */}
          <div>
            <select
              value={selectedChain}
              onChange={(e) => setSelectedChain(e.target.value)}
              aria-label="Filter by chain"
              className="w-full rounded-sm border border-line bg-base px-2.5 py-1.5 font-mono text-xs text-ink focus:border-cyan focus:outline-none"
            >
              <option value="all">All Chains</option>
              <option value="robinhood">Robinhood Chain</option>
              <option value="ethereum">Ethereum</option>
              <option value="ink">Ink</option>
              <option value="hyperevm">HyperEVM</option>
            </select>
          </div>

          {/* Status filter */}
          <div>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              aria-label="Filter by status"
              className="w-full rounded-sm border border-line bg-base px-2.5 py-1.5 font-mono text-xs text-ink focus:border-cyan focus:outline-none"
            >
              <option value="all">All Statuses</option>
              <option value="live">● Live Now</option>
              <option value="upcoming">Upcoming</option>
              <option value="ended">Ended / Sold Out</option>
            </select>
          </div>

          {/* Sort By */}
          <div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "time" | "tier" | "supply" | "name")}
              aria-label="Sort mints"
              className="w-full rounded-sm border border-line bg-base px-2.5 py-1.5 font-mono text-xs text-ink focus:border-cyan focus:outline-none"
            >
              <option value="time">Sort: Live &amp; Soonest</option>
              <option value="tier">Sort: Hype Tier (Hot first)</option>
              <option value="supply">Sort: Max Supply</option>
              <option value="name">Sort: Name (A-Z)</option>
            </select>
          </div>
        </div>

        {/* Toggles bar */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line/60 pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setWhitelistedOnly(!whitelistedOnly)}
              className={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                whitelistedOnly
                  ? "border-acid bg-acid/20 text-acid font-medium"
                  : "border-line bg-base text-ink-muted hover:border-line-strong hover:text-ink"
              }`}
            >
              <ShieldCheck className="size-3.5" />
              Whitelisted / Eligible Only
            </button>

            <button
              type="button"
              onClick={() => setFreeOnly(!freeOnly)}
              className={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                freeOnly
                  ? "border-acid bg-acid/20 text-acid font-medium"
                  : "border-line bg-base text-ink-muted hover:border-line-strong hover:text-ink"
              }`}
            >
              <Sparkles className="size-3.5" />
              Free Mints Only (0 ETH)
            </button>

            {/* Tier quick buttons */}
            <div className="flex items-center gap-1 font-mono text-xs">
              <span className="text-ink-faint mr-1">Tier:</span>
              {["all", "hot", "warm", "cold"].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSelectedTier(t)}
                  className={`rounded-xs px-2 py-0.5 uppercase ${
                    selectedTier === t
                      ? "bg-acid/20 text-acid font-semibold"
                      : "text-ink-faint hover:text-ink"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-sm border border-line bg-base p-0.5">
              <button
                type="button"
                onClick={() => setViewMode("cards")}
                title="Cards view"
                className={`inline-flex items-center gap-1 rounded-xs px-2.5 py-1 font-mono text-xs transition-colors ${
                  viewMode === "cards"
                    ? "bg-base-raised text-acid font-semibold shadow-xs"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                <LayoutGrid className="size-3.5" />
                Cards
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                title="List view"
                className={`inline-flex items-center gap-1 rounded-xs px-2.5 py-1 font-mono text-xs transition-colors ${
                  viewMode === "list"
                    ? "bg-base-raised text-acid font-semibold shadow-xs"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                <List className="size-3.5" />
                List
              </button>
              <button
                type="button"
                onClick={() => setViewMode("calendar")}
                title="Calendar view"
                className={`inline-flex items-center gap-1 rounded-xs px-2.5 py-1 font-mono text-xs transition-colors ${
                  viewMode === "calendar"
                    ? "bg-base-raised text-acid font-semibold shadow-xs"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                <CalendarDays className="size-3.5" />
                Calendar
              </button>
            </div>

            <div className="font-mono text-xs text-ink-muted">
              Showing <span className="font-semibold text-ink">{filteredMints.length}</span> of{" "}
              {data.mints.length} mints
            </div>
          </div>
        </div>
      </section>

      {/* Mints Display (Cards / List / Calendar) */}
      {filteredMints.length > 0 ? (
        viewMode === "list" ? (
          <NvtListView mints={filteredMints} getMintWlInfo={getMintWlInfo} />
        ) : viewMode === "calendar" ? (
          <NvtCalendarView mints={filteredMints} getMintWlInfo={getMintWlInfo} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredMints.map((mint) => {
              const { isWhitelisted, stages } = getMintWlInfo(mint);
              return (
                <NvtMintCard
                  key={mint.id}
                  mint={mint}
                  selectedAccount={selectedAccount !== "all" ? selectedAccount : undefined}
                  isWhitelisted={isWhitelisted}
                  whitelistedStages={stages}
                />
              );
            })}
          </div>
        )
      ) : (
        <div className="rounded-md border border-line bg-base-raised p-8 text-center font-mono text-xs text-ink-muted">
          No mints match your current search and filter settings.
          <div className="mt-2">
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                setSelectedChain("all");
                setSelectedStatus("all");
                setSelectedTier("all");
                setFreeOnly(false);
                setWhitelistedOnly(false);
              }}
              className="text-cyan underline hover:text-cyan/80"
            >
              Clear all filters
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
