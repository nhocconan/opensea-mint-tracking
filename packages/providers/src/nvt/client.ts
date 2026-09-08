/**
 * NeverFuckingTrade (NFT Trencher) API client.
 *
 * Implements authenticated access for live NFT mint tracking and whitelist checking.
 * Hardened with bounded payloads, timeout, Retry-After handling, and header redaction (PRD §14).
 *
 * Reference: https://cdn.neverfuckingtrade.com/api/
 */
import { AppError } from "@hoodmint/core";
import { type FetchLike, fetchJson } from "../http.ts";
import {
  type NvtMeResponse,
  type NvtMint,
  type NvtMintsResponse,
  type NvtWlNonceResponse,
  type NvtWlPassResponse,
  type NvtWlScanResponse,
  nvtMeResponseSchema,
  nvtMintSchema,
  nvtMintsResponseSchema,
  nvtWlNonceResponseSchema,
  nvtWlPassResponseSchema,
  nvtWlScanResponseSchema,
} from "./schemas.ts";

export interface NvtClientOptions {
  readonly apiKey: string | (() => Promise<string | undefined> | string | undefined);
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export interface NvtMintsFilter {
  readonly chain?: "robinhood" | "ethereum" | "ink" | "hyperevm" | string;
  readonly status?: "upcoming" | "live" | "sold_out" | "ended" | string;
  readonly tier?: "hot" | "warm" | "cold" | "dust" | string;
}

export interface NvtScanOptions {
  readonly address: string;
  readonly slugs?: readonly string[];
  readonly openSeaPass?: string;
}

export class NvtClient {
  private readonly apiKeyProvider: () => Promise<string | undefined> | string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl?: FetchLike | undefined;
  private readonly timeoutMs: number;

  constructor(options: NvtClientOptions) {
    this.apiKeyProvider =
      typeof options.apiKey === "function" ? options.apiKey : () => options.apiKey as string;
    this.baseUrl = (options.baseUrl ?? "https://cdn.neverfuckingtrade.com/api/v1").replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const key = await this.apiKeyProvider();
    if (!key || key.trim() === "") {
      throw new AppError("AuthRequired", "NeverFuckingTrade API key is missing or empty", {
        hint: "Configure NVT API key in Admin -> NeverFuckingTrade",
      });
    }
    return {
      "X-API-Key": key.trim(),
      Accept: "application/json",
    };
  }

  /**
   * GET /api/v1/me
   * Fetches key profile, prefix, usage, limits, and connected wallets.
   */
  public async getMe(): Promise<NvtMeResponse> {
    const headers = await this.getAuthHeaders();
    const url = `${this.baseUrl}/me`;
    const result = await fetchJson(url, {
      method: "GET",
      headers,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      timeoutMs: this.timeoutMs,
      retries: 2,
    });

    const parsed = nvtMeResponseSchema.safeParse(result.json);
    if (!parsed.success) {
      throw new AppError("InvalidPayload", "failed to parse /me response from NVT", {
        hint: parsed.error.message,
      });
    }
    return parsed.data;
  }

  /**
   * GET /api/v1/mints
   * Fetches the board slice of mints with optional chain, status, and tier filters.
   */
  public async getMints(filters?: NvtMintsFilter): Promise<NvtMintsResponse> {
    const headers = await this.getAuthHeaders();
    const url = new URL(`${this.baseUrl}/mints`);
    if (filters?.chain) url.searchParams.set("chain", filters.chain);
    if (filters?.status) url.searchParams.set("status", filters.status);
    if (filters?.tier) url.searchParams.set("tier", filters.tier);

    const result = await fetchJson(url.toString(), {
      method: "GET",
      headers,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      timeoutMs: this.timeoutMs,
      retries: 2,
    });

    const parsed = nvtMintsResponseSchema.safeParse(result.json);
    if (!parsed.success) {
      throw new AppError("InvalidPayload", "failed to parse /mints response from NVT", {
        hint: parsed.error.message,
      });
    }
    return parsed.data;
  }

  /**
   * GET /api/v1/mints/{id}
   * Fetches full detail for a single mint (by chain:contract, address, or slug).
   */
  public async getMint(id: string): Promise<NvtMint> {
    const headers = await this.getAuthHeaders();
    const url = `${this.baseUrl}/mints/${encodeURIComponent(id)}`;

    const result = await fetchJson(url, {
      method: "GET",
      headers,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      timeoutMs: this.timeoutMs,
      retries: 2,
    });

    const parsed = nvtMintSchema.safeParse(result.json);
    if (!parsed.success) {
      throw new AppError("InvalidPayload", `failed to parse /mints/${id} response from NVT`, {
        hint: parsed.error.message,
      });
    }
    return parsed.data;
  }

  /**
   * POST /api/v1/wl/scan
   * Scans whitelist eligibility for a given wallet address against gated drop stages.
   */
  public async scanWl(options: NvtScanOptions): Promise<NvtWlScanResponse> {
    const headers = await this.getAuthHeaders();
    headers["Content-Type"] = "application/json";
    if (options.openSeaPass) {
      headers["X-OpenSea-Pass"] = options.openSeaPass;
    }

    // Whitelist scan runs on the main edge endpoint if not already directed
    const wlBase = this.baseUrl.includes("cdn.neverfuckingtrade.com")
      ? this.baseUrl.replace("cdn.neverfuckingtrade.com", "neverfuckingtrade.com")
      : this.baseUrl;
    const url = `${wlBase}/wl/scan`;

    const bodyObj: { address: string; slugs?: readonly string[] } = {
      address: options.address,
    };
    if (options.slugs && options.slugs.length > 0) {
      bodyObj.slugs = options.slugs;
    }

    const result = await fetchJson(url, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyObj),
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      timeoutMs: Math.max(this.timeoutMs, 20_000), // scanning up to 130 slugs takes ~10s
      retries: 1,
    });

    const parsed = nvtWlScanResponseSchema.safeParse(result.json);
    if (!parsed.success) {
      throw new AppError("InvalidPayload", "failed to parse /wl/scan response from NVT", {
        hint: parsed.error.message,
      });
    }
    return parsed.data;
  }

  /**
   * GET /api/v1/wl/nonce?address=0x...
   * Fetches the SIWE message text for signing.
   */
  public async getWlNonce(address: string): Promise<NvtWlNonceResponse> {
    const headers = await this.getAuthHeaders();
    const wlBase = this.baseUrl.includes("cdn.neverfuckingtrade.com")
      ? this.baseUrl.replace("cdn.neverfuckingtrade.com", "neverfuckingtrade.com")
      : this.baseUrl;
    const url = `${wlBase}/wl/nonce?address=${encodeURIComponent(address)}`;

    const result = await fetchJson(url, {
      method: "GET",
      headers,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      timeoutMs: this.timeoutMs,
      retries: 2,
    });

    const parsed = nvtWlNonceResponseSchema.safeParse(result.json);
    if (!parsed.success) {
      throw new AppError("InvalidPayload", "failed to parse /wl/nonce response from NVT", {
        hint: parsed.error.message,
      });
    }
    return parsed.data;
  }

  /**
   * POST /api/v1/wl/pass
   * Exchanges an EIP-191 signed SIWE message for a 3-day (72h) OpenSea session pass.
   */
  public async submitWlPass(options: {
    address: string;
    message: string;
    signature: string;
  }): Promise<NvtWlPassResponse> {
    const headers = await this.getAuthHeaders();
    headers["Content-Type"] = "application/json";

    const wlBase = this.baseUrl.includes("cdn.neverfuckingtrade.com")
      ? this.baseUrl.replace("cdn.neverfuckingtrade.com", "neverfuckingtrade.com")
      : this.baseUrl;
    const url = `${wlBase}/wl/pass`;

    const result = await fetchJson(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        address: options.address,
        message: options.message,
        signature: options.signature,
      }),
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      timeoutMs: this.timeoutMs,
      retries: 1,
    });

    const parsed = nvtWlPassResponseSchema.safeParse(result.json);
    if (!parsed.success) {
      throw new AppError("InvalidPayload", "failed to parse /wl/pass response from NVT", {
        hint: parsed.error.message,
      });
    }
    return parsed.data;
  }
}
