import type { EligibilityState } from "@hoodmint/core";
import type { TrackedWalletEligibility } from "@hoodmint/db";
import { EligibilityChip } from "@hoodmint/ui";
import { ExternalLink, Zap } from "lucide-react";
import Link from "next/link";
import { shortAddress } from "@/lib/format.ts";

export { decisionStage } from "@/lib/mint-presentation.ts";

export function MintActions({
  projectId,
  slug,
  specialMintEnabled,
  stageId,
  compact = false,
  mobile = false,
}: {
  projectId: string;
  slug: string | null;
  specialMintEnabled: boolean;
  stageId?: string | null;
  compact?: boolean;
  mobile?: boolean;
}) {
  const classes = compact
    ? `inline-flex min-h-6 items-center gap-1 rounded-xs border px-1.5 py-0.5 font-mono text-[10px] ${mobile ? "min-h-11 md:min-h-6" : ""}`
    : `inline-flex min-h-6 items-center justify-center gap-1.5 rounded-sm border px-3 py-1.5 font-mono text-xs ${mobile ? "min-h-11" : ""}`;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {slug !== null ? (
        <a
          href={`https://opensea.io/collection/${slug}/overview`}
          target="_blank"
          rel="noreferrer noopener"
          className={`${classes} border-acid/40 text-acid hover:bg-acid/10`}
        >
          Mint on OpenSea
          <ExternalLink className="size-3" aria-hidden />
        </a>
      ) : (
        <span
          title="No verified OpenSea collection slug is available"
          className={`${classes} cursor-not-allowed border-line text-ink-faint`}
        >
          OpenSea link unavailable
        </span>
      )}
      {specialMintEnabled ? (
        <Link
          href={{
            pathname: "/admin/special-mints",
            query: { projectId, ...(stageId !== undefined && stageId !== null ? { stageId } : {}) },
          }}
          className={`${classes} border-magenta/40 text-magenta hover:bg-magenta/10`}
        >
          <Zap className="size-3" aria-hidden />
          Special Mint
        </Link>
      ) : null}
    </span>
  );
}

export function ProjectSocialLinks({
  twitterUsername,
  projectUrl,
  discordUrl,
  safelistStatus,
  showMissing = true,
}: {
  twitterUsername: string | null;
  projectUrl: string | null;
  discordUrl?: string | null;
  safelistStatus?: string | null;
  showMissing?: boolean;
}) {
  let websiteLabel = "Website";
  if (projectUrl !== null) {
    try {
      websiteLabel = new URL(projectUrl).host.replace(/^www\./, "");
    } catch {
      // Provider URLs have already crossed validation; retain a neutral label
      // if an older stored row predates that parser.
    }
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px]">
      {safelistStatus === "verified" ? (
        <span className="text-cyan" title="OpenSea verified collection (blue check)">
          OS verified ✓
        </span>
      ) : null}
      {twitterUsername !== null ? (
        <a
          href={`https://x.com/${twitterUsername}`}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-h-6 items-center text-cyan underline-offset-2 hover:underline"
        >
          X @{twitterUsername}
        </a>
      ) : showMissing ? (
        <span className="text-ink-faint">X: none</span>
      ) : null}
      {projectUrl !== null ? (
        <a
          href={projectUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-h-6 items-center text-cyan underline-offset-2 hover:underline"
        >
          {websiteLabel}
        </a>
      ) : showMissing ? (
        <span className="text-ink-faint">Website: none</span>
      ) : null}
      {discordUrl !== undefined && discordUrl !== null ? (
        <a
          href={discordUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-h-6 items-center text-ink-faint underline-offset-2 hover:text-cyan hover:underline"
        >
          Discord
        </a>
      ) : null}
    </span>
  );
}

export function WalletEligibilityList({
  wallets,
}: {
  wallets: readonly TrackedWalletEligibility[] | undefined;
}) {
  if (wallets === undefined || wallets.length === 0) {
    return <span className="font-mono text-[10px] text-ink-faint">No tracked wallet</span>;
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {wallets.map((wallet) => (
        <span
          key={wallet.walletId}
          className="inline-flex items-center gap-1"
          title={wallet.walletAddress}
        >
          <span className="font-mono text-[10px] text-ink-faint">
            {wallet.walletLabel ?? shortAddress(wallet.walletAddress)}
          </span>
          <EligibilityChip state={wallet.status satisfies EligibilityState} />
        </span>
      ))}
    </span>
  );
}
