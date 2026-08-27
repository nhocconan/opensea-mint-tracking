import type { Metadata } from "next";
import { FeedPage } from "@/components/feed-page.tsx";
import { singleValue } from "@/lib/search-params.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Live mints" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <FeedPage
      view="live"
      title="Live mints"
      description="At least one active stage, not sold out or paused."
      searchParams={singleValue(params)}
    />
  );
}
