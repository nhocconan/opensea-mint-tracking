import { describe, expect, it } from "vitest";
import {
  interpretDeviceTokenResponse,
  isTokenExpiring,
  parseTokenResponse,
  pollDeviceToken,
  refreshXaiToken,
  requestDeviceAuthorization,
  resolveXaiClient,
  SLOW_DOWN_INCREMENT_SECONDS,
  storedDevicePendingSchema,
  storedXaiTokenSchema,
  XAI_DEFAULT_CLIENT_ID,
  XAI_DEFAULT_ENDPOINTS,
  XAI_DEVICE_CODE_GRANT,
  XAI_REFRESH_SKEW_MS,
  XAI_SCOPE,
  xaiOAuthClientSchema,
} from "./oauth.ts";

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonFetch(body: unknown, log: RecordedCall[] = [], status = 200) {
  return ((url: string, init: RequestInit) => {
    log.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as (url: string, init: RequestInit) => Promise<Response>;
}

const formBody = (init: RequestInit) => new URLSearchParams(String(init.body ?? ""));
const headerOf = (init: RequestInit, name: string) =>
  (init.headers as Record<string, string> | undefined)?.[name];

const DEFAULTS = resolveXaiClient(null);

describe("resolveXaiClient", () => {
  it("falls back to the built-in public Grok-CLI client and endpoints", () => {
    expect(DEFAULTS).toEqual({
      clientId: XAI_DEFAULT_CLIENT_ID,
      deviceAuthorizationUrl: "https://auth.x.ai/oauth2/device/code",
      tokenUrl: "https://auth.x.ai/oauth2/token",
      apiBaseUrl: "https://api.x.ai/v1",
    });
    expect(XAI_DEFAULT_ENDPOINTS.token).toBe("https://auth.x.ai/oauth2/token");
  });

  it("lets a stored credential override the client id and any endpoint", () => {
    const resolved = resolveXaiClient(
      xaiOAuthClientSchema.parse({
        client_id: "private-client",
        endpoints: { token: "https://auth.example.com/token" },
      }),
    );
    expect(resolved.clientId).toBe("private-client");
    expect(resolved.tokenUrl).toBe("https://auth.example.com/token");
    // Unspecified endpoints keep the defaults.
    expect(resolved.deviceAuthorizationUrl).toBe(XAI_DEFAULT_ENDPOINTS.deviceAuthorization);
  });

  it("defaults the client id when the stored override omits it", () => {
    expect(xaiOAuthClientSchema.parse({}).client_id).toBe(XAI_DEFAULT_CLIENT_ID);
  });
});

describe("requestDeviceAuthorization", () => {
  it("posts client_id and the verbatim scope, form-encoded, no Basic auth", async () => {
    const log: RecordedCall[] = [];
    const device = await requestDeviceAuthorization({
      client: DEFAULTS,
      fetchImpl: jsonFetch(
        {
          device_code: "dev-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://x.ai/device",
          verification_uri_complete: "https://x.ai/device?code=ABCD-EFGH",
          expires_in: 600,
          interval: 5,
        },
        log,
      ),
    });
    const call = log[0];
    expect(call?.url).toBe("https://auth.x.ai/oauth2/device/code");
    expect(call?.init.method).toBe("POST");
    expect(headerOf(call?.init ?? {}, "content-type")).toBe("application/x-www-form-urlencoded");
    // Public client: the id goes in the body, and there is no secret at all.
    expect(headerOf(call?.init ?? {}, "authorization")).toBeUndefined();
    expect(formBody(call?.init ?? {}).get("client_id")).toBe(XAI_DEFAULT_CLIENT_ID);
    expect(formBody(call?.init ?? {}).get("scope")).toBe(XAI_SCOPE);
    expect(XAI_SCOPE).toBe("openid profile email offline_access grok-cli:access api:access");
    expect(device.user_code).toBe("ABCD-EFGH");
    expect(device.verification_uri_complete).toBe("https://x.ai/device?code=ABCD-EFGH");
  });

  it("defaults interval and expiry when the server omits them", async () => {
    const device = await requestDeviceAuthorization({
      client: DEFAULTS,
      fetchImpl: jsonFetch({
        device_code: "d",
        user_code: "U",
        verification_uri: "https://x.ai/device",
      }),
    });
    expect(device.interval).toBe(5);
    expect(device.expires_in).toBe(600);
  });
});

describe("RFC 8628 poll state machine", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");

  it("keeps polling at the same interval on authorization_pending", () => {
    expect(
      interpretDeviceTokenResponse({
        status: 400,
        body: { error: "authorization_pending" },
        intervalSeconds: 5,
      }),
    ).toEqual({ status: "pending", intervalSeconds: 5 });
  });

  it("adds exactly 5 seconds to the interval on slow_down", () => {
    expect(
      interpretDeviceTokenResponse({
        status: 400,
        body: { error: "slow_down" },
        intervalSeconds: 5,
      }),
    ).toEqual({ status: "slow_down", intervalSeconds: 5 + SLOW_DOWN_INCREMENT_SECONDS });
  });

  it("compounds slow_down across repeated backoffs", () => {
    let interval = 5;
    for (let i = 0; i < 3; i += 1) {
      const outcome = interpretDeviceTokenResponse({
        status: 400,
        body: { error: "slow_down" },
        intervalSeconds: interval,
      });
      expect(outcome.status).toBe("slow_down");
      interval = outcome.status === "slow_down" ? outcome.intervalSeconds : interval;
    }
    expect(interval).toBe(20);
  });

  it("is terminal on access_denied and expired_token", () => {
    expect(
      interpretDeviceTokenResponse({
        status: 400,
        body: { error: "access_denied" },
        intervalSeconds: 5,
      }),
    ).toEqual({ status: "denied" });
    expect(
      interpretDeviceTokenResponse({
        status: 400,
        body: { error: "expired_token" },
        intervalSeconds: 5,
      }),
    ).toEqual({ status: "expired" });
  });

  it("surfaces an unknown OAuth error as a bare code, never a body", () => {
    const outcome = interpretDeviceTokenResponse({
      status: 400,
      body: { error: "invalid_client", error_description: "secret leaked here" },
      intervalSeconds: 5,
    });
    expect(outcome).toEqual({ status: "error", code: "invalid_client" });
    expect(JSON.stringify(outcome)).not.toContain("secret leaked here");
  });

  it("treats a malformed error body as an error rather than throwing", () => {
    expect(
      interpretDeviceTokenResponse({ status: 400, body: "<html>", intervalSeconds: 5 }),
    ).toEqual({ status: "error", code: "malformed_error_response" });
  });

  it("treats a 200 without an access token as an error rather than success", () => {
    expect(
      interpretDeviceTokenResponse({
        status: 200,
        body: { token_type: "bearer" },
        intervalSeconds: 5,
      }),
    ).toEqual({ status: "error", code: "malformed_token_response" });
  });

  it("returns the persisted token shape on success", () => {
    const outcome = interpretDeviceTokenResponse({
      status: 200,
      body: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 21600,
        scope: XAI_SCOPE,
      },
      intervalSeconds: 5,
      now,
    });
    expect(outcome).toEqual({
      status: "success",
      token: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_at: "2026-08-28T18:00:00.000Z",
        scopes: XAI_SCOPE.split(" "),
      },
    });
  });
});

describe("pollDeviceToken", () => {
  it("sends the device_code grant with client_id in the body", async () => {
    const log: RecordedCall[] = [];
    const outcome = await pollDeviceToken({
      client: DEFAULTS,
      deviceCode: "dev-code",
      intervalSeconds: 5,
      fetchImpl: jsonFetch({ error: "authorization_pending" }, log, 400),
    });
    const body = formBody(log[0]?.init ?? {});
    expect(log[0]?.url).toBe("https://auth.x.ai/oauth2/token");
    expect(body.get("grant_type")).toBe(XAI_DEVICE_CODE_GRANT);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(body.get("device_code")).toBe("dev-code");
    expect(body.get("client_id")).toBe(XAI_DEFAULT_CLIENT_ID);
    // A 400 carrying authorization_pending must reach the state machine,
    // not be mapped to a thrown AppError by the fetch wrapper.
    expect(outcome).toEqual({ status: "pending", intervalSeconds: 5 });
  });

  it("resolves a completed grant into a storable token", async () => {
    const outcome = await pollDeviceToken({
      client: DEFAULTS,
      deviceCode: "dev-code",
      intervalSeconds: 5,
      fetchImpl: jsonFetch({ access_token: "a", refresh_token: "r", expires_in: 21600 }),
      now: new Date("2026-08-28T12:00:00.000Z"),
    });
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") {
      expect(storedXaiTokenSchema.parse(JSON.parse(JSON.stringify(outcome.token)))).toEqual(
        outcome.token,
      );
    }
  });
});

describe("parseTokenResponse", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");

  it("maps a device-grant response into the persisted shape", () => {
    const stored = parseTokenResponse(
      {
        token_type: "bearer",
        expires_in: 21600,
        access_token: "access-1",
        refresh_token: "refresh-1",
        scope: XAI_SCOPE,
      },
      { now },
    );
    expect(stored).toEqual({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_at: "2026-08-28T18:00:00.000Z",
      scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    });
    // The persisted shape must round-trip through its own Zod boundary.
    expect(storedXaiTokenSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("keeps the ROTATED refresh token, never the one that was just spent", () => {
    const stored = parseTokenResponse(
      { access_token: "access-2", refresh_token: "refresh-2", expires_in: 100 },
      { now, previousRefreshToken: "refresh-1" },
    );
    expect(stored.refresh_token).toBe("refresh-2");
    expect(stored.refresh_token).not.toBe("refresh-1");
  });

  it("falls back to the previous refresh token only when the response omits one", () => {
    expect(
      parseTokenResponse(
        { access_token: "a", expires_in: 100 },
        { now, previousRefreshToken: "refresh-1" },
      ).refresh_token,
    ).toBe("refresh-1");
  });

  it("defaults refresh_token to null and expiry to ~6h when both are absent", () => {
    const stored = parseTokenResponse({ access_token: "a" }, { now });
    expect(stored.refresh_token).toBeNull();
    expect(stored.expires_at).toBe("2026-08-28T18:00:00.000Z");
    expect(stored.scopes).toEqual([]);
  });

  it("rejects a response without an access token instead of storing junk", () => {
    expect(() => parseTokenResponse({ refresh_token: "r" }, { now })).toThrow();
    expect(() => parseTokenResponse({ access_token: "" }, { now })).toThrow();
  });
});

describe("isTokenExpiring (1h refresh skew)", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");

  it("uses a one-hour skew by default", () => {
    expect(XAI_REFRESH_SKEW_MS).toBe(3600 * 1000);
  });

  it("is false for a fresh ~6h token", () => {
    expect(isTokenExpiring({ expires_at: "2026-08-28T18:00:00.000Z" }, { now })).toBe(false);
  });

  it("is false just outside the skew", () => {
    expect(isTokenExpiring({ expires_at: "2026-08-28T13:00:01.000Z" }, { now })).toBe(false);
  });

  it("is true exactly at the skew boundary — refresh early, never late", () => {
    expect(isTokenExpiring({ expires_at: "2026-08-28T13:00:00.000Z" }, { now })).toBe(true);
  });

  it("leaves room for a 30-minute scan cadence to retry before expiry", () => {
    // A token inside the skew is refreshed now; even if that pass failed,
    // the next 30-minute pass still runs ~30 min before real expiry.
    const expiresAt = new Date(now.getTime() + XAI_REFRESH_SKEW_MS - 60_000);
    const nextPass = new Date(now.getTime() + 30 * 60_000);
    expect(isTokenExpiring({ expires_at: expiresAt.toISOString() }, { now })).toBe(true);
    expect(expiresAt.getTime()).toBeGreaterThan(nextPass.getTime());
  });

  it("is true for an already-expired token and an unparseable expiry", () => {
    expect(isTokenExpiring({ expires_at: "2026-08-28T11:00:00.000Z" }, { now })).toBe(true);
    expect(isTokenExpiring({ expires_at: "not-a-date" }, { now })).toBe(true);
  });
});

describe("refreshXaiToken", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");

  it("sends the refresh_token grant with client_id and returns the rotated token", async () => {
    const log: RecordedCall[] = [];
    const refreshed = await refreshXaiToken({
      client: DEFAULTS,
      refreshToken: "old-refresh",
      fetchImpl: jsonFetch(
        {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 21600,
          scope: XAI_SCOPE,
        },
        log,
      ),
      now,
    });
    const body = formBody(log[0]?.init ?? {});
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
    expect(body.get("client_id")).toBe(XAI_DEFAULT_CLIENT_ID);
    expect(headerOf(log[0]?.init ?? {}, "authorization")).toBeUndefined();
    expect(refreshed.refresh_token).toBe("new-refresh");
    expect(refreshed.expires_at).toBe("2026-08-28T18:00:00.000Z");
  });

  it("maps a revoked grant to AuthRequired without echoing the token", async () => {
    await expect(
      refreshXaiToken({
        client: DEFAULTS,
        refreshToken: "revoked-refresh",
        fetchImpl: jsonFetch(
          { error: "invalid_grant", error_description: "revoked-refresh is dead" },
          [],
          400,
        ),
        now,
      }),
    ).rejects.toMatchObject({ category: "AuthRequired" });

    await expect(
      refreshXaiToken({
        client: DEFAULTS,
        refreshToken: "revoked-refresh",
        fetchImpl: jsonFetch({ error: "invalid_grant" }, [], 400),
        now,
      }),
    ).rejects.toThrow(/^(?!.*revoked-refresh).*$/);
  });
});

describe("storedDevicePendingSchema", () => {
  it("round-trips the sealed pending-grant shape", () => {
    const parsed = storedDevicePendingSchema.parse({
      device_code: "dev-code",
      interval: 5,
      expires_at: "2026-08-28T12:10:00.000Z",
    });
    expect(parsed.device_code).toBe("dev-code");
  });

  it("defaults the interval and rejects a missing device code", () => {
    expect(
      storedDevicePendingSchema.parse({ device_code: "d", expires_at: "2026-08-28T12:10:00.000Z" })
        .interval,
    ).toBe(5);
    expect(() => storedDevicePendingSchema.parse({ expires_at: "x" })).toThrow();
  });
});
