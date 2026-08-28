/**
 * Credential resolution for OpenSea calls (PRD §7.1/§12):
 * 1. Admin-entered Developer Portal key (encrypted credential).
 * 2. Managed instant key: created via POST /api/v2/auth/keys, stored
 *    encrypted, rotated before its 7-day expiry by maintenance.
 * 3. Env-provided key (headless bootstrap).
 *
 * Wallet JWTs from PAT exchange are kept in process memory only — never in
 * plaintext DB columns (PRD §11).
 */

import { AppError, isAppError } from "@hoodmint/core";
import type { Db } from "@hoodmint/db";
import {
  createCredential,
  findCredentialByType,
  findCredentialsByType,
  getCredentialSecret,
  getSetting,
  revokeCredential,
  setSetting,
  updateCredentialMetadata,
  updateCredentialSecret,
} from "@hoodmint/db";
import type { Logger } from "@hoodmint/observability";
import {
  isTokenExpiring,
  OpenSeaClient,
  refreshXaiToken,
  resolveXaiClient,
  storedXaiTokenSchema,
  xaiOAuthClientSchema,
} from "@hoodmint/providers";

const INSTANT_KEY_BACKOFF_SETTING = "opensea_instant_key_backoff_until";

export interface ResolvedKey {
  /** Primary key (first of `apiKeys`) — kept for single-key callers. */
  readonly apiKey: string;
  /** Every usable key: all saved Developer keys, load-balanced by the
   *  OpenSea client's per-key pacing (N keys ≈ N× the 120/min budget). */
  readonly apiKeys: readonly string[];
  readonly instant: boolean;
  readonly expiresAt: Date | null;
}

/**
 * OpenSea answered 401 with the key we hold. A free instant key can be
 * invalidated server-side well before its nominal 7-day expiry (found live
 * 2026-08-28: every discovery call 401'd for 30+ min while `expires_at` still
 * said next week, so the <24h rotation never triggered and the provider sat
 * "down"). Drop the dead instant credential so the next `resolveOpenSeaKey`
 * bootstraps a fresh one. A Developer-portal key is never touched — a 401
 * there is the operator's to fix in Admin → OpenSea.
 */
export async function invalidateInstantKeyOnAuthFailure(
  db: Db,
  resolved: Pick<ResolvedKey, "instant">,
): Promise<boolean> {
  if (!resolved.instant) {
    return false;
  }
  const instant = await findCredentialByType(db, "opensea_instant_key");
  if (instant === undefined) {
    return false;
  }
  await revokeCredential(db, instant.id);
  return true;
}

export async function resolveOpenSeaKey(
  db: Db,
  masterKey: string,
  envKey?: string,
): Promise<ResolvedKey> {
  // Every saved Developer key, decrypted — the client spreads load across
  // all of them. The operator can add more keys in Admin → OpenSea to scale
  // the per-minute budget linearly.
  const portals = await findCredentialsByType(db, "opensea_api_key");
  const portalKeys: string[] = [];
  for (const portal of portals) {
    const secret = await getCredentialSecret(db, portal.id, masterKey);
    if (secret !== undefined && secret.trim() !== "") {
      portalKeys.push(secret);
    }
  }
  if (envKey !== undefined && envKey !== "" && !portalKeys.includes(envKey)) {
    portalKeys.push(envKey);
  }
  if (portalKeys.length > 0) {
    return {
      apiKey: portalKeys[0] as string,
      apiKeys: portalKeys,
      instant: false,
      expiresAt: portals[0]?.expiresAt ?? null,
    };
  }

  const instant = await findCredentialByType(db, "opensea_instant_key");
  if (instant !== undefined) {
    const secret = await getCredentialSecret(db, instant.id, masterKey);
    const expiresAt = instant.expiresAt;
    if (
      secret !== undefined &&
      (expiresAt === null || expiresAt.getTime() > Date.now() + 24 * 3600 * 1000)
    ) {
      return { apiKey: secret, apiKeys: [secret], instant: true, expiresAt };
    }
  }

  // Bootstrap a fresh instant key (free tier; rotated by maintenance).
  // OpenSea rate-limits KEY CREATION itself ("Key creation rate limit
  // exceeded", 429). Every worker pass calls this resolver, so without a
  // cooldown a dead key turns into a hammer on that endpoint that keeps the
  // 429 alive indefinitely (found live 2026-08-28). Back off 15 min after a
  // failed bootstrap; passes fail fast (AuthRequired) until then.
  const backoffUntil = await getSetting<number>(db, INSTANT_KEY_BACKOFF_SETTING);
  if (backoffUntil !== undefined && backoffUntil > Date.now()) {
    throw new AppError(
      "AuthRequired",
      "no OpenSea key: instant-key issuance is rate-limited — add a Developer API key in Admin → OpenSea",
      { statusCode: 401 },
    );
  }
  const bootstrap = new OpenSeaClient();
  let created: { apiKey: string; expiresAt: Date | null };
  try {
    created = await bootstrap.createInstantKey();
  } catch (error) {
    await setSetting(db, INSTANT_KEY_BACKOFF_SETTING, Date.now() + 15 * 60 * 1000).catch(
      () => undefined,
    );
    throw error;
  }
  const expiresAt = created.expiresAt ?? new Date(Date.now() + 6 * 24 * 3600 * 1000);
  await createCredential(db, {
    type: "opensea_instant_key",
    name: "Managed instant key",
    secret: created.apiKey,
    masterKey,
    expiresAt,
  });
  return { apiKey: created.apiKey, apiKeys: [created.apiKey], instant: true, expiresAt };
}

/** In-memory JWT cache keyed by PAT fingerprint. */
const jwtCache = new Map<string, { jwt: string; expiresAt: Date }>();

export async function getWalletJwt(
  db: Db,
  masterKey: string,
  envPat: string | undefined,
  clientFactory: (apiKey?: string) => OpenSeaClient,
): Promise<string | null> {
  const pat =
    envPat !== undefined && envPat !== ""
      ? { secret: envPat, fingerprint: `env:${envPat.length}` }
      : await (async () => {
          const credential = await findCredentialByType(db, "opensea_pat");
          if (credential === undefined) {
            return null;
          }
          const secret = await getCredentialSecret(db, credential.id, masterKey);
          return secret === undefined ? null : { secret, fingerprint: credential.fingerprint };
        })();
  if (pat === null) {
    return null;
  }

  const cached = jwtCache.get(pat.fingerprint);
  if (cached !== undefined && cached.expiresAt.getTime() > Date.now() + 5 * 60 * 1000) {
    return cached.jwt;
  }
  try {
    const exchanged = await clientFactory().exchangePat(pat.secret);
    jwtCache.set(pat.fingerprint, exchanged);
    return exchanged.jwt;
  } catch (error) {
    if (error instanceof AppError && error.category === "AuthRequired") {
      return null;
    }
    throw error;
  }
}

/* ── xAI (Grok) hype-signal token resolution (ADR 0007) ──────────────────── */

/** Which credential answered. For logs/summaries only — never the token. */
export type XaiTokenSource = "subscription_oauth" | "stored_api_key" | "env_api_key";

export interface ResolvedXaiToken {
  readonly token: string;
  readonly source: XaiTokenSource;
}

export interface XaiResolveDeps {
  readonly db: Db;
  readonly masterKey: string;
  readonly envApiKey?: string | undefined;
  readonly log?: Pick<Logger, "warn" | "info"> | undefined;
  readonly now?: Date | undefined;
}

/**
 * Load the optional `xai_oauth_client` override, falling back to the
 * built-in public Grok-CLI client and endpoints. A malformed or
 * undecryptable override degrades to the defaults rather than failing the
 * scan — the defaults are what a subscriber needs anyway.
 */
export async function resolveXaiClientConfig(deps: XaiResolveDeps) {
  const credential = await findCredentialByType(deps.db, "xai_oauth_client");
  if (credential === undefined) {
    return resolveXaiClient(null);
  }
  const sealed = await getCredentialSecret(deps.db, credential.id, deps.masterKey);
  if (sealed === undefined) {
    return resolveXaiClient(null);
  }
  const parsed = xaiOAuthClientSchema.safeParse(safeJsonParse(sealed));
  return resolveXaiClient(parsed.success ? parsed.data : null);
}

/**
 * Resolve the xAI bearer in priority order (PRD §11 secret hygiene — no
 * branch here puts a token in a log field, an error message, or credential
 * metadata):
 *
 *   1. `xai_user_token` — the operator's X Premium+/SuperGrok subscription
 *      via device-code OAuth. Refreshed in place when inside the 1-hour
 *      skew; xAI ROTATES the refresh token, so the new one is persisted
 *      atomically (one UPDATE) before the access token is used.
 *   2. `xai_api_key` — a console.x.ai API key (separate xAI billing).
 *   3. `XAI_API_KEY` — env fallback for headless bootstrap.
 *
 * Returns null when none is configured. Never throws for a credential
 * problem: a revoked grant marks the credential unhealthy in its
 * (non-secret) metadata and falls through, so the scan loop degrades
 * instead of crashing.
 */
export async function resolveXaiToken(deps: XaiResolveDeps): Promise<ResolvedXaiToken | null> {
  const subscription = await resolveXaiSubscriptionToken(deps);
  if (subscription !== null) {
    return { token: subscription, source: "subscription_oauth" };
  }

  const stored = await findCredentialByType(deps.db, "xai_api_key");
  if (stored !== undefined) {
    const secret = await getCredentialSecret(deps.db, stored.id, deps.masterKey);
    if (secret !== undefined && secret.trim() !== "") {
      return { token: secret, source: "stored_api_key" };
    }
  }

  const env = deps.envApiKey;
  if (env !== undefined && env.trim() !== "") {
    return { token: env, source: "env_api_key" };
  }
  return null;
}

async function resolveXaiSubscriptionToken(deps: XaiResolveDeps): Promise<string | null> {
  const credential = await findCredentialByType(deps.db, "xai_user_token");
  if (credential === undefined) {
    return null;
  }
  const sealed = await getCredentialSecret(deps.db, credential.id, deps.masterKey);
  if (sealed === undefined) {
    return null;
  }
  const parsed = storedXaiTokenSchema.safeParse(safeJsonParse(sealed));
  if (!parsed.success) {
    await markXaiCredentialUnhealthy(deps, credential.id, "malformed_stored_token");
    return null;
  }
  const token = parsed.data;
  const now = deps.now ?? new Date();
  if (!isTokenExpiring(token, { now })) {
    return token.access_token;
  }

  if (token.refresh_token === null) {
    await markXaiCredentialUnhealthy(deps, credential.id, "expired_no_refresh_token");
    return null;
  }

  try {
    const client = await resolveXaiClientConfig(deps);
    const refreshed = await refreshXaiToken({
      client,
      refreshToken: token.refresh_token,
      now,
    });
    // One UPDATE: rotated refresh token + new expiry + health land together,
    // so a crash can never strand an already-invalidated refresh token.
    await updateCredentialSecret(deps.db, credential.id, {
      secret: JSON.stringify(refreshed),
      masterKey: deps.masterKey,
      expiresAt: new Date(refreshed.expires_at),
      metadata: {
        ...(credential.metadata ?? {}),
        scopes: refreshed.scopes,
        health: "healthy",
        lastErrorCode: null,
        refreshedAt: now.toISOString(),
      },
    });
    deps.log?.info({ source: "subscription_oauth" }, "refreshed xAI subscription token");
    return refreshed.access_token;
  } catch (error) {
    await markXaiCredentialUnhealthy(
      deps,
      credential.id,
      isAppError(error) ? error.category : "refresh_failed",
    );
    deps.log?.warn(
      { errorCode: isAppError(error) ? error.category : "unknown" },
      "xAI subscription token refresh failed — falling back to API key",
    );
    return null;
  }
}

/**
 * Mark the subscription token unhealthy from OUTSIDE the refresh path — e.g.
 * api.x.ai answering 403 "personal-team-blocked:spending-limit" (account has
 * no API credits / Grok subscription entitlement) on an otherwise valid,
 * unexpired token. Surfaces the real reason in Admin → Signals instead of
 * silent per-project failures.
 */
export async function markXaiTokenUnhealthy(deps: XaiResolveDeps, code: string): Promise<void> {
  const credential = await findCredentialByType(deps.db, "xai_user_token");
  if (credential !== undefined) {
    await markXaiCredentialUnhealthy(deps, credential.id, code);
  }
}

/** Non-secret health marker on the credential row (mirrors provider health). */
async function markXaiCredentialUnhealthy(
  deps: XaiResolveDeps,
  id: string,
  code: string,
): Promise<void> {
  await updateCredentialMetadata(deps.db, id, {
    health: "unhealthy",
    lastErrorCode: code,
    lastErrorAt: (deps.now ?? new Date()).toISOString(),
  }).catch(() => undefined);
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
