/**
 * RSS 2.0 export of Live/Next/Latest (feature backlog quick win): reads
 * from the exact same `queryFeed` used by `/api/v1/projects` — no second
 * source of truth, no new provider, no new credential. Read-only, public
 * views only (Watchlist/Eligible need per-user auth RSS readers can't
 * satisfy with a session cookie; scoped out rather than half-built —
 * see docs/feature-backlog.md).
 */
import { queryFeed } from "@hoodmint/db";
import { container } from "@/lib/container.ts";
import { toDate } from "@/lib/format.ts";

export const dynamic = "force-dynamic";

const PUBLIC_VIEWS = new Set(["live", "next", "latest", "all"]);

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ view: string }> },
): Promise<Response> {
  const { view } = await params;
  if (!PUBLIC_VIEWS.has(view)) {
    return new Response("Not found — try live, next, latest, or all.", { status: 404 });
  }
  const { db, config } = container();
  const page = await queryFeed(db, {
    view: view as "live" | "next" | "latest" | "all",
    sort: view === "next" ? "starting" : "recent",
    limit: 50,
  });

  const channelTitle = `HoodMint Radar — ${view[0]?.toUpperCase()}${view.slice(1)}`;
  const selfUrl = `${config.APP_URL}/rss/${view}`;
  const items = page.rows
    .map((row) => {
      const link = `${config.APP_URL}/projects/${row.id}`;
      const pubDate = toDate(row.stageStartsAt ?? row.lastSeenAt).toUTCString();
      const description = [
        row.stageLabel !== null ? `Stage: ${row.stageLabel}` : null,
        row.lifecycleStatus !== null ? `Status: ${row.lifecycleStatus}` : null,
        row.stagePriceWei !== null ? `Price (wei): ${row.stagePriceWei}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join(" · ");
      return `    <item>
      <title>${escapeXml(row.name)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(row.id)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(description)}</description>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${escapeXml(config.APP_URL)}</link>
    <description>Self-hosted NFT drop radar — ${escapeXml(view)} feed, read-only.</description>
    <atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}
