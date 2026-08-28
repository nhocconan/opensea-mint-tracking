/**
 * OpenSea Drops API client (PRD §7.1).
 *
 * Behaviors pinned by contract fixtures:
 * - Chain identifier resolved from GET /api/v2/chains (never hard-coded only)
 *   with the configured fallback slug when the chain is not yet listed.
 * - If server-side chain filtering 400s (new chains land before their enum),
 *   retries unfiltered and filters rows locally (behavioral parity with the
 *   Python reference).
 * - Cursor pagination with a configurable max page count.
 * - Rate-limit headers surfaced after every call; quota guard consults
 *   core.allowedRequests before each request.
 * - ETags cached for conditional GETs.
 * - PAT → wallet JWT exchange (server-side only), and free instant-key
 *   bootstrap/rotation for headless deployments.
 */
import { AppError, allowedRequests, parseRateLimitHeaders, type QuotaState } from "@hoodmint/core";
import { type FetchLike, fetchJson } from "../http.ts";
import { acquire, penalize, pickKey } from "./rate-limiter.ts";
import type { ParsedEligibility } from "./schemas.ts";
import {
  chainsResponseSchema,
  dropMintResponseSchema,
  eligibilityResponseSchema,
  exchangeResponseSchema,
  instantKeyResponseSchema,
  matchesChain,
  type ParsedCollectionSocials,
  type ParsedCollectionsPage,
  type ParsedDropsPage,
  type ParsedNftsPage,
  parseCollectionSocials,
  parseCollectionsPage,
  parseDropsPage,
  parseEligibility,
  parseNftsPage,
} from "./schemas.ts";

/** OpenSea-computed, ready-to-broadcast mint calldata (never hand-rolled). */
export interface DropMintTransaction {
  readonly target: string;
  readonly calldata: string;
  readonly valueWei: string;
}

export type DropFeedType = "featured" | "upcoming" | "recently_minted";

export interface RateLimitSnapshot {
  readonly remaining: number | null;
  readonly limit: number | null;
  readonly resetAtEpochSeconds: number | null;
}

export interface OpenSeaClientOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: FetchLike;
  readonly maxPages?: number;
  readonly pageLimit?: number;
  readonly hourlyLimit?: number;
  /** All Developer keys to load-balance across (each paced independently).
   *  Falls back to `apiKey` alone. */
  readonly apiKeys?: readonly string[];
  /** Per-key requests/minute pacing (see rate-limiter.ts). */
  readonly perMinuteLimit?: number;
  readonly reservePercent?: number;
}

export interface ListDropsResult {
  readonly rows: ParsedDropsPage["rows"];
  readonly malformed: number;
  readonly pages: number;
  readonly chainFilterDropped: boolean;
}

export interface ListCollectionsResult {
  readonly rows: ParsedCollectionsPage["rows"];
  readonly malformed: number;
  readonly pages: number;
}

export class OpenSeaClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string | undefined;
  private readonly apiKeys: readonly string[];
  private readonly perMinuteLimit: number | undefined;
  private readonly fetchImpl?: FetchLike | undefined;
  private readonly maxPages: number;
  private readonly pageLimit: number;
  private readonly etagCache = new Map<string, { etag: string; json: unknown }>();
  private quota: QuotaState;
  private providerLimit: number | null = null;

  constructor(options: OpenSeaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.opensea.io").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.apiKeys =
      options.apiKeys !== undefined && options.apiKeys.length > 0
        ? options.apiKeys
        : options.apiKey !== undefined
          ? [options.apiKey]
          : [];
    this.perMinuteLimit = options.perMinuteLimit;
    this.fetchImpl = options.fetchImpl;
    this.maxPages = options.maxPages ?? 5;
    this.pageLimit = Math.min(options.pageLimit ?? 50, 100);
    this.quota = {
      limitPerHour: options.hourlyLimit ?? 600,
      remaining: null,
      resetAtEpochSeconds: null,
      reservePercent: options.reservePercent ?? 10,
    };
  }

  rateLimit(): RateLimitSnapshot {
    return {
      remaining: this.quota.remaining,
      limit: this.providerLimit,
      resetAtEpochSeconds: this.quota.resetAtEpochSeconds,
    };
  }

  private updateQuota(headers: Record<string, string>): void {
    const parsed = parseRateLimitHeaders(headers);
    if (parsed.remaining !== null || parsed.limit !== null || parsed.resetAtEpochSeconds !== null) {
      if (parsed.limit !== null) {
        this.providerLimit = parsed.limit;
      }
      this.quota = {
        limitPerHour: parsed.limit ?? this.quota.limitPerHour,
        remaining: parsed.remaining ?? this.quota.remaining,
        resetAtEpochSeconds: parsed.resetAtEpochSeconds ?? this.quota.resetAtEpochSeconds,
        reservePercent: this.quota.reservePercent,
      };
    }
  }

  private assertQuota(): void {
    const decision = allowedRequests(this.quota);
    if (decision.blocked) {
      throw new AppError("RateLimited", "opensea quota reserve reached; deferring requests", {
        hint: "waits for window reset or key rotation",
      });
    }
  }

  private async call(
    path: string,
    init: { method?: "GET" | "POST"; body?: string; authenticated?: string } = {},
  ): Promise<{ json: unknown; headers: Record<string, string> }> {
    this.assertQuota();
    const headers: Record<string, string> = {};
    // Process-wide pacing: pick the Developer key with the most budget left
    // and wait for a token before touching the network (rate-limiter.ts).
    // Only when a per-minute limit is configured — tests and the keyless
    // instant-key bootstrap stay unpaced.
    let pacedKey: string | undefined;
    if (this.apiKeys.length > 0 && this.perMinuteLimit !== undefined) {
      pacedKey = pickKey(this.apiKeys, this.perMinuteLimit);
      await acquire(pacedKey, this.perMinuteLimit);
      headers["x-api-key"] = pacedKey;
    } else if (this.apiKey !== undefined) {
      headers["x-api-key"] = this.apiKey;
    }
    if (init.authenticated !== undefined) {
      headers.authorization = `Bearer ${init.authenticated}`;
    }
    const options: import("../http.ts").FetchJsonOptions = {
      headers,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      ...(init.method !== undefined ? { method: init.method } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
    };
    try {
      const result = await fetchJson(`${this.baseUrl}${path}`, options, this.etagCache);
      this.updateQuota(result.headers);
      return { json: result.json, headers: result.headers };
    } catch (error) {
      // Upstream 429 despite pacing → drain that key's bucket for the
      // advertised Retry-After so concurrent loops back off instead of piling on.
      if (
        pacedKey !== undefined &&
        this.perMinuteLimit !== undefined &&
        error instanceof AppError &&
        error.category === "RateLimited"
      ) {
        penalize(pacedKey, error.retryAfterSeconds ?? 5, this.perMinuteLimit);
      }
      throw error;
    }
  }

  /**
   * Resolve the OpenSea chain slug for the target network. `/api/v2/chains`
   * currently exposes slugs, not numeric ids; we match the fallback slug
   * (env-configurable) and fall back to it when absent, exactly the
   * dynamic-first strategy the PRD requires.
   */
  async resolveChainIdentifier(fallbackSlug: string): Promise<string> {
    try {
      const { json } = await this.call("/api/v2/chains");
      const parsed = chainsResponseSchema.parse(json);
      const normalized = fallbackSlug.toLowerCase();
      const match = parsed.chains.find(
        (c) => c.chain.toLowerCase() === normalized || c.name.toLowerCase().includes(normalized),
      );
      return match?.chain ?? fallbackSlug;
    } catch (error) {
      if (error instanceof AppError && error.category === "RateLimited") {
        throw error;
      }
      // /chains is an unstable surface for new networks; fallback keeps
      // discovery alive (fixture: chains-real-2026-08.json has no 4663 row).
      return fallbackSlug;
    }
  }

  async listDrops(
    dropType: DropFeedType,
    chainSlug: string,
    options: { localChainFilter?: boolean } = {},
  ): Promise<ListDropsResult> {
    const rows: ParsedDropsPage["rows"] = [];
    let malformed = 0;
    let pages = 0;
    let cursor: string | null = null;
    let chainFilterDropped = false;

    for (;;) {
      if (pages >= this.maxPages) {
        break;
      }
      const params = new URLSearchParams({
        type: dropType,
        limit: String(this.pageLimit),
        chains: chainSlug,
      });
      if (cursor !== null) {
        params.set("cursor", cursor);
      }
      let page: ParsedDropsPage;
      try {
        const { json } = await this.call(`/api/v2/drops?${params.toString()}`);
        page = parseDropsPage(json);
      } catch (error) {
        if (
          error instanceof AppError &&
          error.category === "InvalidPayload" &&
          error.message.includes("400")
        ) {
          // New chains can 400 before their enum ships: refetch unfiltered
          // and keep only identifiable rows for the target chain.
          chainFilterDropped = true;
          const unfiltered = new URLSearchParams({ type: dropType, limit: String(this.pageLimit) });
          if (cursor !== null) {
            unfiltered.set("cursor", cursor);
          }
          const { json } = await this.call(`/api/v2/drops?${unfiltered.toString()}`);
          page = parseDropsPage(json);
          page = { ...page, rows: page.rows.filter((row) => matchesChain(row.chain, chainSlug)) };
        } else {
          throw error;
        }
      }
      rows.push(...page.rows);
      malformed += page.malformed;
      pages += 1;
      cursor = page.next;
      if (cursor === null) {
        break;
      }
    }

    if (options.localChainFilter === true && !chainFilterDropped) {
      const filtered = rows.filter((row) => matchesChain(row.chain, chainSlug));
      chainFilterDropped = rows.length !== filtered.length;
      return { rows: filtered, malformed, pages, chainFilterDropped };
    }
    return { rows, malformed, pages, chainFilterDropped };
  }

  /**
   * Chain-wide collection discovery (mirrors {@link listDrops}'s structure):
   * paginates `GET /api/v2/collections?chain=<slug>&order_by=<orderBy>
   * &order_direction=desc&limit=<n>[&next=<cursor>]`, newest first. Bounded by
   * `maxPages` (defaults to the client's drops-listing cap) so a broad sweep
   * of a large chain cannot exhaust the free-tier quota — each request is
   * still ETag-cached and quota-guarded via `this.call`. Rows are filtered to
   * a contract on the target chain inside `parseCollectionsPage`.
   */
  async listCollections(
    chainSlug: string,
    opts: { orderBy?: string; maxPages?: number; pageLimit?: number } = {},
  ): Promise<ListCollectionsResult> {
    const rows: ParsedCollectionsPage["rows"] = [];
    let malformed = 0;
    let pages = 0;
    let cursor: string | null = null;
    const maxPages = opts.maxPages ?? this.maxPages;
    const pageLimit = Math.min(opts.pageLimit ?? this.pageLimit, 100);
    const orderBy = opts.orderBy ?? "created_date";

    for (;;) {
      if (pages >= maxPages) {
        break;
      }
      const params = new URLSearchParams({
        chain: chainSlug,
        order_by: orderBy,
        order_direction: "desc",
        limit: String(pageLimit),
      });
      if (cursor !== null) {
        params.set("next", cursor);
      }
      const { json } = await this.call(`/api/v2/collections?${params.toString()}`);
      const page = parseCollectionsPage(json, chainSlug);
      rows.push(...page.rows);
      malformed += page.malformed;
      pages += 1;
      cursor = page.next;
      if (cursor === null) {
        break;
      }
    }
    return { rows, malformed, pages };
  }

  async getDrop(slug: string): Promise<unknown> {
    const { json } = await this.call(`/api/v2/drops/${encodeURIComponent(slug)}`);
    return json;
  }

  /** Collection socials + OpenSea verification status (one Read call). */
  async getCollectionSocials(slug: string): Promise<ParsedCollectionSocials> {
    const { json } = await this.call(`/api/v2/collections/${encodeURIComponent(slug)}`);
    return parseCollectionSocials(json);
  }

  /**
   * Trait rarity ranking (feature-backlog.md §2, shipped 2026-08-22): the
   * per-token endpoint, distinct from the collection-level /drops endpoints
   * above. Falls under the standard Read rate-limit bucket, not the
   * write-scoped one P4's quota guard exists for.
   *
   * `maxPagesOverride` bounds this call independently of `this.maxPages`
   * (the drops-listing default) — a rarity refresh explicitly caps how much
   * of a (possibly 10k+ token) collection it will fetch per call, matching
   * this method's own caller (apps/worker's rarity worker) documenting that
   * cap plainly to the admin who triggers it, not silently truncating.
   */
  async listCollectionNfts(
    slug: string,
    options: { maxPagesOverride?: number } = {},
  ): Promise<{
    rows: ParsedNftsPage["rows"];
    malformed: number;
    pages: number;
    /**
     * True iff the page cap was hit before OpenSea's cursor was exhausted —
     * i.e. this is a partial fetch, not the full collection. Rarity is a
     * function of collection-wide trait frequency, so the caller MUST treat
     * a truncated fetch as unusable for ranking, not a slightly-smaller-but-
     * still-valid sample (pagination order is by token id, not random, so a
     * prefix is not a representative sample).
     */
    truncated: boolean;
  }> {
    const rows: ParsedNftsPage["rows"] = [];
    let malformed = 0;
    let pages = 0;
    let cursor: string | null = null;
    const maxPages = options.maxPagesOverride ?? this.maxPages;
    let truncated = false;

    for (;;) {
      if (pages >= maxPages) {
        truncated = cursor !== null;
        break;
      }
      const params = new URLSearchParams({ limit: String(this.pageLimit) });
      if (cursor !== null) {
        params.set("next", cursor);
      }
      const { json } = await this.call(
        `/api/v2/collection/${encodeURIComponent(slug)}/nfts?${params.toString()}`,
      );
      const page = parseNftsPage(json);
      rows.push(...page.rows);
      malformed += page.malformed;
      pages += 1;
      cursor = page.next;
      if (cursor === null) {
        break;
      }
    }
    return { rows, malformed, pages, truncated };
  }

  async getEligibility(slug: string, walletJwt: string): Promise<ParsedEligibility> {
    const { json } = await this.call(`/api/v2/drops/${encodeURIComponent(slug)}/eligibility`, {
      authenticated: walletJwt,
    });
    return parseEligibility(eligibilityResponseSchema.parse(json));
  }

  /** Exchange a read:eligibility PAT for a ~12h wallet JWT (server-side only). */
  async exchangePat(pat: string): Promise<{ jwt: string; expiresAt: Date }> {
    const { json } = await this.call("/api/v2/auth/tokens/exchange", {
      method: "POST",
      body: JSON.stringify({ subjectToken: pat, subjectTokenType: "ACCESS_TOKEN" }),
    });
    const parsed = exchangeResponseSchema.parse(json);
    const jwt = parsed.accessToken ?? parsed.access_token ?? parsed.token;
    if (jwt === undefined) {
      throw new AppError("InvalidPayload", "token exchange returned no access token");
    }
    const expiresInSeconds = parsed.expiresIn ?? parsed.expires_in ?? 12 * 60 * 60;
    return { jwt, expiresAt: new Date(Date.now() + (expiresInSeconds ?? 43_200) * 1000) };
  }

  /**
   * Build an OpenSea-hosted drop's mint transaction server-side (ADR 0004
   * amendment): `minter` is the intended recipient, independent of whoever
   * ends up signing/broadcasting. Never used to sign or broadcast anything
   * itself — the caller (packages/execution, not yet wired to a live
   * signer) still runs mandatory pre-flight simulation against the
   * returned calldata before any real key ever sees it.
   */
  async buildDropMintTransaction(
    slug: string,
    params: { minter: string; quantity: number },
  ): Promise<DropMintTransaction> {
    const { json } = await this.call(`/api/v2/drops/${encodeURIComponent(slug)}/mint`, {
      method: "POST",
      body: JSON.stringify({ minter: params.minter, quantity: params.quantity }),
    });
    const parsed = dropMintResponseSchema.parse(json);
    return { target: parsed.target, calldata: parsed.calldata, valueWei: parsed.value };
  }

  /** Create a free 7-day instant key (headless bootstrap path). */
  async createInstantKey(): Promise<{ apiKey: string; expiresAt: Date | null }> {
    const { json } = await this.call("/api/v2/auth/keys", { method: "POST", body: "{}" });
    const parsed = instantKeyResponseSchema.parse(json);
    const apiKey = parsed.api_key ?? parsed.apiKey;
    if (apiKey === undefined) {
      throw new AppError("InvalidPayload", "instant key response contained no key");
    }
    const expiresAt = parsed.expires_at ?? parsed.expiresAt;
    return {
      apiKey,
      expiresAt: expiresAt !== undefined && expiresAt !== null ? new Date(expiresAt) : null,
    };
  }
}
