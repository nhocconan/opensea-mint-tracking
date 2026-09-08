import { Award, ExternalLink, Settings } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getNvtMintsAction } from "@/app/actions.ts";
import { getSessionUser } from "@/lib/session.ts";
import { NvtFeedClient } from "./nvt-feed-client.tsx";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "My Mints - NVT",
  description:
    "Full mint detail information and whitelist eligibility for your accounts from NeverFuckingTrade.",
};

export default async function MyMintsNvtPage() {
  const user = await getSessionUser();
  if (user === null) {
    redirect("/login");
  }
  if (user.role !== "admin") {
    redirect("/?denied=1");
  }

  const initialData = await getNvtMintsAction();

  return (
    <div className="space-y-4 px-4 py-5">
      {/* Header */}
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Award className="size-6 text-acid" aria-hidden />
            <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
              My Mints - NVT
            </h1>
          </div>
          <p className="mt-1 font-mono text-xs text-ink-muted">
            Full mint detail information and whitelist stages for your accounts across Robinhood
            Chain, Ethereum, Ink, and HyperEVM.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/admin/nvt"
            className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-base-raised px-2.5 py-1 font-mono text-xs text-ink-muted hover:border-line-strong hover:text-ink"
          >
            <Settings className="size-3.5" />
            NVT &amp; Discord Settings
          </Link>
          <a
            href="https://cdn.neverfuckingtrade.com/api/"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 rounded-sm border border-cyan/40 bg-cyan/10 px-2.5 py-1 font-mono text-xs text-cyan hover:bg-cyan/20"
          >
            API Reference <ExternalLink className="size-3" />
          </a>
        </div>
      </div>

      {/* Main interactive radar client */}
      <NvtFeedClient initialData={initialData} />
    </div>
  );
}
