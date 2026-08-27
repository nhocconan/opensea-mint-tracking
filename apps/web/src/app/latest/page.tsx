import type { Metadata } from "next";
import { FeedPage } from "@/components/feed-page.tsx";
import { singleValue } from "@/lib/search-params.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Latest discoveries" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <FeedPage
      view="latest"
      title="Latest discoveries"
      description="Newly found projects by first-seen time."
      searchParams={singleValue(params)}
    />
  );
}
