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

import { AppError } from "@hoodmint/core";
import type { Db } from "@hoodmint/db";
import { createCredential, findCredentialByType, getCredentialSecret } from "@hoodmint/db";
import { OpenSeaClient } from "@hoodmint/providers";

export interface ResolvedKey {
  readonly apiKey: string;
  readonly instant: boolean;
  readonly expiresAt: Date | null;
}

export async function resolveOpenSeaKey(
  db: Db,
  masterKey: string,
  envKey?: string,
): Promise<ResolvedKey> {
  const portal = await findCredentialByType(db, "opensea_api_key");
  if (portal !== undefined) {
    const secret = await getCredentialSecret(db, portal.id, masterKey);
    if (secret !== undefined) {
      return { apiKey: secret, instant: false, expiresAt: portal.expiresAt };
    }
  }
  if (envKey !== undefined && envKey !== "") {
    return { apiKey: envKey, instant: false, expiresAt: null };
  }

  const instant = await findCredentialByType(db, "opensea_instant_key");
  if (instant !== undefined) {
    const secret = await getCredentialSecret(db, instant.id, masterKey);
    const expiresAt = instant.expiresAt;
    if (
      secret !== undefined &&
      (expiresAt === null || expiresAt.getTime() > Date.now() + 24 * 3600 * 1000)
    ) {
      return { apiKey: secret, instant: true, expiresAt };
    }
  }

  // Bootstrap a fresh instant key (free tier; rotated by maintenance).
  const bootstrap = new OpenSeaClient();
  const created = await bootstrap.createInstantKey();
  const expiresAt = created.expiresAt ?? new Date(Date.now() + 6 * 24 * 3600 * 1000);
  await createCredential(db, {
    type: "opensea_instant_key",
    name: "Managed instant key",
    secret: created.apiKey,
    masterKey,
    expiresAt,
  });
  return { apiKey: created.apiKey, instant: true, expiresAt };
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
