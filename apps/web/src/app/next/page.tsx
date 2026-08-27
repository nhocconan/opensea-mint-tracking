import type { Metadata } from "next";
import { FeedPage } from "@/components/feed-page.tsx";
import { singleValue } from "@/lib/search-params.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Up next" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <FeedPage
      view="next"
      title="Up next"
      description="Future stages ordered by nearest start time."
      searchParams={singleValue(params)}
    />
  );
}
