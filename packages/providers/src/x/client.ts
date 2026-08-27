/**
 * X (Twitter) API v2 client (ADR 0007) — read-only public-post search via
 * app-only Bearer auth. No per-user OAuth login flow: this only ever reads
 * public posts matching a search query (collection/contract mentions),
 * never a specific user's private timeline, so app-only auth is the
 * correct, simplest fit — not a scope-reduction shortcut.
 *
 * Verified 2026-08-21/22 against docs.x.com: the free API tier was retired
 * February 2026; this is a metered pay-per-use endpoint. Nothing in this
 * codebase calls it unless the operator has both provided a real bearer
 * token AND explicitly enabled it (packages/config's X_SIGNALS_ENABLED,
 * hard default false) — see docs/execution-architecture.md.
 */
import { AppError } from "@hoodmint/core";
import { type FetchLike, fetchJson } from "../http.ts";
import { type ParsedTweet, searchRecentResponseSchema } from "./schemas.ts";

export interface XClientOptions {
  readonly bearerToken: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

export interface SearchRecentResult {
  readonly tweets: ParsedTweet[];
  readonly newestId: string | null;
}

export class XClient {
  private readonly bearerToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl?: FetchLike | undefined;

  constructor(options: XClientOptions) {
    if (options.bearerToken.trim() === "") {
      throw new AppError("PermanentConfig", "XClient requires a non-empty bearer token");
    }
    this.bearerToken = options.bearerToken;
    this.baseUrl = (options.baseUrl ?? "https://api.x.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl;
  }

  /**
   * Public posts matching `query` in roughly the last 7 days (the
   * `search/recent` endpoint's own window — not configurable per-call).
   * `sinceId` bounds the search to posts newer than a previous scan's
   * `newestId`, for mention-velocity comparison across scans.
   */
  async searchRecentMentions(query: string, sinceId?: string): Promise<SearchRecentResult> {
    const params = new URLSearchParams({
      query,
      max_results: "100",
      "tweet.fields": "public_metrics,created_at,author_id",
    });
    if (sinceId !== undefined) {
      params.set("since_id", sinceId);
    }
    const result = await fetchJson(`${this.baseUrl}/2/tweets/search/recent?${params.toString()}`, {
      headers: { authorization: `Bearer ${this.bearerToken}` },
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    });
    const parsed = searchRecentResponseSchema.parse(result.json);
    return { tweets: parsed.data, newestId: parsed.meta?.newest_id ?? null };
  }
}
