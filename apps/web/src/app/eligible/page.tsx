import type { Metadata } from "next";
import { FeedPage } from "@/components/feed-page.tsx";
import { singleValue } from "@/lib/search-params.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Eligible" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <FeedPage
      view="eligible"
      title="Eligible"
      description="Restricted-stage whitelist hits grouped by wallet. Public-only stages never appear here."
      searchParams={singleValue(params)}
    />
  );
}
