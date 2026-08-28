/**
 * xAI (Grok) OAuth 2.0 Device Authorization Grant — RFC 8628.
 *
 * Verified 2026-08-28 against xAI's OIDC discovery document and the
 * open-source Grok CLI clients (Hermes/OpenClaw/Pi) that use this same
 * public client:
 *   issuer                       https://auth.x.ai
 *   device authorization         https://auth.x.ai/oauth2/device/code
 *   token                        https://auth.x.ai/oauth2/token
 *
 * Why device-code and not Authorization Code + PKCE: the grant is completed
 * on x.ai in the operator's own browser session, so this server never
 * registers a redirect URI, never runs a callback route, and never has to
 * be publicly reachable at a stable hostname for auth to work.
 *
 * This is a PUBLIC client: there is no client_secret anywhere in this file
 * or in the credential it reads. `client_id` travels in the form body on
 * both the device and token requests — never HTTP Basic.
 *
 * xAI ROTATES the refresh token on every refresh: a successful
 * refresh_token grant returns a NEW refresh_token and invalidates the one
 * just spent. {@link parseTokenResponse} always surfaces what the response
 * carried so the caller can persist it atomically before the next attempt.
 *
 * Nothing here logs. Access tokens, refresh tokens, and device codes are
 * returned to the caller and nowhere else; the caller seals them via
 * packages/secrets.
 */
import { AppError } from "@hoodmint/core";
import { z } from "zod";
import { type FetchLike, fetchJson } from "../http.ts";

/* ── Built-in defaults ───────────────────────────────────────────────────── */

/**
 * xAI's public Grok-CLI client. Shared by design — it is a public client
 * with no secret, so it is not a credential and carries no per-operator
 * trust. Overridable via the optional `xai_oauth_client` credential when an
 * operator wants their own registered client, with no code change.
 */
export const XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

export const XAI_DEFAULT_ENDPOINTS = {
  deviceAuthorization: "https://auth.x.ai/oauth2/device/code",
  token: "https://auth.x.ai/oauth2/token",
  api: "https://api.x.ai/v1",
} as const;

/** Verbatim scope string the Grok-CLI client is authorized for. */
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";

export const XAI_DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Refresh this far ahead of expiry. Access tokens live ~6h; a 1h skew means
 * a 30-minute scan cadence gets at least two chances to refresh before the
 * token could ever be presented expired.
 */
export const XAI_REFRESH_SKEW_MS = 3600 * 1000;

/** RFC 8628 §3.5 default poll interval when the server omits one. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** RFC 8628 §3.5: a `slow_down` adds 5 seconds to the interval. */
export const SLOW_DOWN_INCREMENT_SECONDS = 5;

/* ── Stored credential shapes ────────────────────────────────────────────── */

/**
 * Optional `xai_oauth_client` credential. Absent → the built-in public
 * client and endpoints above, which is all an operator with an X Premium+ /
 * SuperGrok subscription needs.
 */
export const xaiOAuthClientSchema = z.object({
  client_id: z.string().min(1).default(XAI_DEFAULT_CLIENT_ID),
  endpoints: z
    .object({
      deviceAuthorization: z.string().url().optional(),
      token: z.string().url().optional(),
      api: z.string().url().optional(),
    })
    .optional(),
});

export type XaiOAuthClient = z.infer<typeof xaiOAuthClientSchema>;

export interface ResolvedXaiClient {
  readonly clientId: string;
  readonly deviceAuthorizationUrl: string;
  readonly tokenUrl: string;
  readonly apiBaseUrl: string;
}

/** Merge a stored (possibly partial) client over the built-in defaults. */
export function resolveXaiClient(stored?: XaiOAuthClient | null): ResolvedXaiClient {
  return {
    clientId: stored?.client_id ?? XAI_DEFAULT_CLIENT_ID,
    deviceAuthorizationUrl:
      stored?.endpoints?.deviceAuthorization ?? XAI_DEFAULT_ENDPOINTS.deviceAuthorization,
    tokenUrl: stored?.endpoints?.token ?? XAI_DEFAULT_ENDPOINTS.token,
    apiBaseUrl: (stored?.endpoints?.api ?? XAI_DEFAULT_ENDPOINTS.api).replace(/\/$/, ""),
  };
}

/** Persisted shape of the `xai_user_token` credential secret (sealed JSON). */
export const storedXaiTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullable().default(null),
  /** ISO-8601 UTC instant the access token stops being usable. */
  expires_at: z.string().min(1),
  scopes: z.array(z.string()).default([]),
});

export type StoredXaiToken = z.infer<typeof storedXaiTokenSchema>;

/**
 * Persisted shape of the short-lived `xai_device_pending` credential secret.
 * The `device_code` is bearer-equivalent — whoever holds it can complete the
 * grant — so it is sealed exactly like a token, never returned to a client.
 */
export const storedDevicePendingSchema = z.object({
  device_code: z.string().min(1),
  interval: z.number().int().positive().default(DEFAULT_POLL_INTERVAL_SECONDS),
  expires_at: z.string().min(1),
});

export type StoredDevicePending = z.infer<typeof storedDevicePendingSchema>;

/* ── Device authorization request (RFC 8628 §3.1/§3.2) ───────────────────── */

export const deviceAuthorizationResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1).optional(),
  expires_in: z.number().int().positive().default(600),
  interval: z.number().int().positive().default(DEFAULT_POLL_INTERVAL_SECONDS),
});

export type DeviceAuthorization = z.infer<typeof deviceAuthorizationResponseSchema>;

async function postForm(
  url: string,
  body: Record<string, string>,
  options: { readonly fetchImpl?: FetchLike; readonly allowStatuses?: readonly number[] } = {},
): Promise<{ status: number; json: unknown }> {
  const result = await fetchJson(url, {
    method: "POST",
    body: new URLSearchParams(body).toString(),
    // The token endpoint is form-encoded, not JSON — packages/providers'
    // fetchJson only defaults content-type when the caller omits it.
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // Never retry: a device_code poll has its own RFC 8628 cadence, and a
    // rotated refresh token is single-use — a blind retry burns it.
    retries: 0,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.allowStatuses !== undefined ? { allowStatuses: options.allowStatuses } : {}),
  });
  return { status: result.status, json: result.json };
}

export interface RequestDeviceAuthorizationInput {
  readonly client: ResolvedXaiClient;
  readonly scope?: string;
  readonly fetchImpl?: FetchLike;
}

/** Start the grant: returns the code the operator types in at x.ai. */
export async function requestDeviceAuthorization(
  input: RequestDeviceAuthorizationInput,
): Promise<DeviceAuthorization> {
  const { json } = await postForm(
    input.client.deviceAuthorizationUrl,
    { client_id: input.client.clientId, scope: input.scope ?? XAI_SCOPE },
    { ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}) },
  );
  return deviceAuthorizationResponseSchema.parse(json);
}

/* ── Token responses ─────────────────────────────────────────────────────── */

export const xaiTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
  /** Present with `offline_access`; ROTATED on every refresh. */
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

/** RFC 6749 §5.2 / RFC 8628 §3.5 error body. */
export const oauthErrorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});

/** Access-token lifetime assumed when the server omits `expires_in` (~6h). */
const DEFAULT_EXPIRES_IN_SECONDS = 6 * 3600;

/**
 * Normalize a token response into the persisted shape.
 *
 * `previousRefreshToken` is only a fallback for a refresh response that
 * omitted `refresh_token` entirely — when the response DOES carry one it
 * always wins, because the old one was invalidated the moment xAI answered.
 */
export function parseTokenResponse(
  raw: unknown,
  options: { readonly now?: Date; readonly previousRefreshToken?: string | null } = {},
): StoredXaiToken {
  const parsed = xaiTokenResponseSchema.parse(raw);
  const now = options.now ?? new Date();
  const expiresIn = parsed.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS;
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token ?? options.previousRefreshToken ?? null,
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    scopes: parsed.scope === undefined ? [] : parsed.scope.split(" ").filter((s) => s !== ""),
  };
}

/** True when the access token is expired or inside the refresh skew. */
export function isTokenExpiring(
  token: Pick<StoredXaiToken, "expires_at">,
  options: { readonly now?: Date; readonly skewMs?: number } = {},
): boolean {
  const now = (options.now ?? new Date()).getTime();
  const skewMs = options.skewMs ?? XAI_REFRESH_SKEW_MS;
  const expiresAt = Date.parse(token.expires_at);
  if (Number.isNaN(expiresAt)) {
    // An unparseable expiry is treated as expired: refresh rather than
    // present a token we cannot reason about.
    return true;
  }
  return expiresAt - now <= skewMs;
}

/* ── RFC 8628 §3.5 poll state machine (pure) ─────────────────────────────── */

export type DevicePollOutcome =
  /** Keep polling at `intervalSeconds`. */
  | { readonly status: "pending"; readonly intervalSeconds: number }
  /** Keep polling, but the server asked us to back off. */
  | { readonly status: "slow_down"; readonly intervalSeconds: number }
  /** Operator declined at x.ai — stop and clear the pending row. */
  | { readonly status: "denied" }
  /** The device code aged out — stop and clear the pending row. */
  | { readonly status: "expired" }
  | { readonly status: "success"; readonly token: StoredXaiToken }
  /** Any other OAuth error; `code` is a bare error identifier, never a body. */
  | { readonly status: "error"; readonly code: string };

export interface InterpretDeviceTokenInput {
  readonly status: number;
  readonly body: unknown;
  /** The interval currently in effect, in seconds. */
  readonly intervalSeconds: number;
  readonly now?: Date;
}

/**
 * Pure interpretation of one token-endpoint poll. Kept free of I/O so the
 * whole RFC 8628 state machine is unit-testable, and so a malformed body can
 * never do more than yield an `error` outcome.
 */
export function interpretDeviceTokenResponse(input: InterpretDeviceTokenInput): DevicePollOutcome {
  if (input.status >= 200 && input.status < 300) {
    const token = xaiTokenResponseSchema.safeParse(input.body);
    if (!token.success) {
      return { status: "error", code: "malformed_token_response" };
    }
    return {
      status: "success",
      token: parseTokenResponse(token.data, {
        ...(input.now !== undefined ? { now: input.now } : {}),
      }),
    };
  }

  const error = oauthErrorSchema.safeParse(input.body);
  if (!error.success) {
    return { status: "error", code: "malformed_error_response" };
  }
  switch (error.data.error) {
    case "authorization_pending":
      return { status: "pending", intervalSeconds: input.intervalSeconds };
    case "slow_down":
      return {
        status: "slow_down",
        intervalSeconds: input.intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS,
      };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      // `error` is a bounded OAuth identifier, never a free-text body — safe
      // to surface to the admin UI and to store as lastErrorCode.
      return { status: "error", code: error.data.error.slice(0, 64) };
  }
}

export interface PollDeviceTokenInput {
  readonly client: ResolvedXaiClient;
  readonly deviceCode: string;
  readonly intervalSeconds: number;
  readonly fetchImpl?: FetchLike;
  readonly now?: Date;
}

/** One poll of the token endpoint for a device grant. */
export async function pollDeviceToken(input: PollDeviceTokenInput): Promise<DevicePollOutcome> {
  const { status, json } = await postForm(
    input.client.tokenUrl,
    {
      grant_type: XAI_DEVICE_CODE_GRANT,
      device_code: input.deviceCode,
      client_id: input.client.clientId,
    },
    {
      // RFC 8628 signals pending/slow_down/denied/expired as 4xx bodies, so
      // these must reach the state machine instead of throwing.
      allowStatuses: [400, 401, 403, 428],
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    },
  );
  return interpretDeviceTokenResponse({
    status,
    body: json,
    intervalSeconds: input.intervalSeconds,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

export interface RefreshXaiTokenInput {
  readonly client: ResolvedXaiClient;
  readonly refreshToken: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: Date;
}

/**
 * refresh_token grant. The result carries the ROTATED refresh token —
 * persist it (atomically, with the new expiry) before the next refresh.
 * Throws AppError("AuthRequired") when the grant was revoked.
 */
export async function refreshXaiToken(input: RefreshXaiTokenInput): Promise<StoredXaiToken> {
  const { status, json } = await postForm(
    input.client.tokenUrl,
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.client.clientId,
    },
    {
      allowStatuses: [400],
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    },
  );
  if (status >= 400) {
    const error = oauthErrorSchema.safeParse(json);
    const code = error.success ? error.data.error : "invalid_grant";
    throw new AppError(
      code === "invalid_grant" ? "AuthRequired" : "RetryableProvider",
      `xAI refused the refresh grant (${code})`,
      { hint: "reconnect the X (Grok) account from Admin → Signals" },
    );
  }
  return parseTokenResponse(json, {
    previousRefreshToken: input.refreshToken,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}
