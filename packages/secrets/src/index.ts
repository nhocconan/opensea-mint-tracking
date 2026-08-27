/**
 * Secret hygiene primitives (PRD §11).
 *
 * - AES-256-GCM authenticated encryption with a key version for rotation.
 * - One-way fingerprints for display instead of ever returning plaintext.
 * - Central redaction for logs/errors: anything that looks like a bearer
 *   token, API key header, or secret-bearing URL is masked before display.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const CURRENT_KEY_VERSION = 1;

/**
 * GCM authentication tag length, in bytes. Node defaults to 16 already —
 * pinned explicitly (passed to both createCipheriv and createDecipheriv)
 * as defense-in-depth per semgrep's gcm-no-tag-length rule: an implicit
 * default is one Node behavior change away from silently accepting a
 * shorter, weaker tag. Fixed 2026-08-22; sealSecret/openSecret's on-disk
 * format (12-byte nonce + 16-byte tag + ciphertext) is unchanged.
 */
const GCM_AUTH_TAG_LENGTH = 16;

export interface SealedSecret {
  /** base64 ciphertext, prefixed with base64 nonce + tag. */
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly algorithm: "aes-256-gcm";
}

function deriveKey(masterKeyB64: string): Buffer {
  const raw = Buffer.from(masterKeyB64, "base64");
  if (raw.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return raw;
}

/** Encrypt a UTF-8 secret under the given base64 master key. */
export function sealSecret(
  plaintext: string,
  masterKeyB64: string,
  keyVersion = CURRENT_KEY_VERSION,
): SealedSecret {
  const key = deriveKey(masterKeyB64);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([nonce, tag, encrypted]).toString("base64"),
    keyVersion,
    algorithm: "aes-256-gcm",
  };
}

/** Decrypt; throws on tampering (GCM auth failure) or wrong key. */
export function openSecret(sealed: SealedSecret, masterKeyB64: string): string {
  if (sealed.algorithm !== "aes-256-gcm") {
    throw new Error(`unsupported cipher ${sealed.algorithm}`);
  }
  const key = deriveKey(masterKeyB64);
  const blob = Buffer.from(sealed.ciphertext, "base64");
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(12, 12 + GCM_AUTH_TAG_LENGTH);
  const body = blob.subarray(12 + GCM_AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * Stable non-reversible display fingerprint: first 12 hex of sha256.
 * Safe to show in UI next to "last 4" without exposing the value.
 */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** "••••abcd" display form. */
export function maskTail(value: string, visible = 4): string {
  const trimmed = value.trim();
  if (trimmed.length <= visible) {
    return "••••";
  }
  return `••••${trimmed.slice(-visible)}`;
}

/** Constant-time equality for token comparison (bootstrap tokens). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-apikey",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-wallet-jwt",
  "proxy-authorization",
  // ADR 0004 Phase 2: extended to cover the delegated-custody session key's
  // field names, not just HTTP header names — redactDeep below walks
  // arbitrary object keys, not only header maps, so these belong here too.
  "privatekey",
  "sessionkey",
  "session_key",
]);

const SECRET_URL_PATTERN =
  /([?&](?:key|token|apikey|api_key|access_token|subjecttoken|secret|sig|signature|password|pass)=)[^&\s]+/gi;
// Telegram embeds the bot token in the path: /bot<token>/method.
const TELEGRAM_BOT_PATH_PATTERN = /(\/bot)[^/?\s]+/gi;

/** Redact a URL's secret-bearing query parameters and path tokens. */
export function redactUrl(url: string): string {
  return url
    .replace(SECRET_URL_PATTERN, "$1[REDACTED]")
    .replace(TELEGRAM_BOT_PATH_PATTERN, "$1[REDACTED]");
}

/**
 * Recursively redact sensitive keys and header names from an arbitrary
 * JSON-serializable object before logging/exporting it.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactUrl(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "[REDACTED]" : redactDeep(val);
    }
    return out as unknown as T;
  }
  return value;
}
