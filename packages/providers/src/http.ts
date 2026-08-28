/**
 * Hardened HTTP fetch wrapper (PRD §14): every external call has an overall
 * timeout, bounded response body, categorized errors, Retry-After handling,
 * and exponential backoff with full jitter for retryable failures.
 */
import { AppError } from "@hoodmint/core";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchJsonOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Retries for idempotent methods only; 429/5xx/network are retryable. */
  readonly retries?: number;
  readonly maxRetryDelayMs?: number;
  /** Extra headers; secrets live here and are never logged. */
  readonly headers?: Record<string, string>;
  readonly method?: "GET" | "POST";
  readonly body?: string;
  /**
   * Statuses returned to the caller as an ordinary result (parsed body,
   * no throw) instead of being mapped to an AppError. Needed for protocols
   * that carry meaning in a 4xx body — RFC 8628 device-code polling signals
   * `authorization_pending` / `slow_down` as HTTP 400.
   */
  readonly allowStatuses?: readonly number[];
}

export interface FetchJsonResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown | null;
  readonly fromCache: boolean;
}

const REDACTED_HEADERS = new Set(["x-api-key", "authorization", "cookie"]);

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = REDACTED_HEADERS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  });
  return out;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && Number.parseInt(lengthHeader, 10) > maxBytes) {
    throw new AppError("InvalidPayload", "response body exceeds limit", {
      hint: `provider returned >${maxBytes} bytes`,
    });
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return response.text();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError("InvalidPayload", "response body exceeds limit");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function fullJitterDelay(attempt: number, capMs: number): number {
  const base = Math.min(1000 * 2 ** attempt, capMs);
  return Math.floor(Math.random() * base);
}

function retryAfterSeconds(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : Math.min(Math.max(parsed, 0), 600);
}

/**
 * Fetch JSON with resilience policies. Never throws raw network errors —
 * everything is categorized AppError. `etagCache` enables conditional GETs.
 */
export async function fetchJson(
  url: string,
  options: FetchJsonOptions = {},
  etagCache?: Map<string, { etag: string; json: unknown }>,
): Promise<FetchJsonResult> {
  const fetchImpl = options.fetchImpl ?? ((u, i) => fetch(u, i));
  const method = options.method ?? "GET";
  const idempotent = method === "GET";
  const retries = options.retries ?? 2;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;

  const cacheKey = `${method} ${url}`;
  const cached = etagCache?.get(cacheKey);
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (method === "GET" && cached !== undefined) {
    headers["if-none-match"] = cached.etag;
  }
  // JSON is the default request encoding, but callers may override it —
  // X's OAuth token endpoint requires application/x-www-form-urlencoded.
  if (options.body !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }

  let attempt = 0;
  for (;;) {
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      const responseHeaders = headersToRecord(response.headers);

      if (response.status === 304 && cached !== undefined) {
        return { status: 200, headers: responseHeaders, json: cached.json, fromCache: true };
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        // redirect:"error" should have thrown; treat any 3xx as a hard stop
        // so a permissive fetch implementation cannot silently follow.
        throw new AppError("PermanentConfig", "redirect blocked by outbound policy");
      }
      // Caller-declared meaningful statuses bypass error mapping entirely.
      // Checked after the redirect guard so it can never re-open 3xx.
      if (options.allowStatuses?.includes(response.status) === true) {
        const text = await readBounded(response, maxBytes);
        let json: unknown = null;
        if (text.length > 0) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
        return { status: response.status, headers: responseHeaders, json, fromCache: false };
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = retryAfterSeconds(responseHeaders);
        if (idempotent && attempt < retries) {
          const delay =
            retryAfter !== undefined
              ? retryAfter * 1000
              : fullJitterDelay(attempt, options.maxRetryDelayMs ?? 30_000);
          await response.body?.cancel().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, delay));
          attempt += 1;
          continue;
        }
        if (response.status === 429) {
          throw new AppError("RateLimited", "provider rate limited", {
            ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
            hint: "quota reserve reached or upstream 429",
          });
        }
        throw new AppError("RetryableProvider", `provider server error (${response.status})`);
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new AppError("AuthRequired", `provider rejected credentials (${response.status})`);
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        throw new AppError("NotFound", "resource not found");
      }
      if (response.status >= 400) {
        const text = await readBounded(response, 4096);
        throw new AppError(
          response.status === 400 || response.status === 409 || response.status === 422
            ? "InvalidPayload"
            : "RetryableProvider",
          `provider returned ${response.status}: ${text.slice(0, 200)}`,
        );
      }

      const text = await readBounded(response, maxBytes);
      let json: unknown = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new AppError("InvalidPayload", "provider returned malformed JSON");
        }
      }
      const etag = response.headers.get("etag");
      if (method === "GET" && etag !== null && etagCache !== undefined && json !== null) {
        etagCache.set(cacheKey, { etag, json });
      }
      return { status: response.status, headers: responseHeaders, json, fromCache: false };
    } catch (error) {
      if (error instanceof AppError) {
        const canRetry =
          idempotent &&
          attempt < retries &&
          (error.category === "RetryableProvider" ||
            (error.category === "RateLimited" && error.retryAfterSeconds !== undefined));
        if (!canRetry) {
          throw error;
        }
        const delay =
          error.category === "RateLimited" && error.retryAfterSeconds !== undefined
            ? error.retryAfterSeconds * 1000
            : fullJitterDelay(attempt, options.maxRetryDelayMs ?? 30_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt += 1;
        continue;
      }
      // Network/abort errors are retryable for idempotent requests.
      if (idempotent && attempt < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, fullJitterDelay(attempt, options.maxRetryDelayMs ?? 30_000)),
        );
        attempt += 1;
        continue;
      }
      const message = error instanceof Error ? error.message : "network error";
      throw new AppError(
        "RetryableProvider",
        `network failure: ${message.replace(/[?]\S+/g, "?…")}`,
      );
    }
  }
}
