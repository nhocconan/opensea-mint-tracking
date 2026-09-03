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
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
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

/**
 * Asymmetric envelope (managed minting keys, 2026-08-28 hardening): sealed
 * to a *recipient public key* so the process that encrypts (the
 * internet-facing web app at import time) holds nothing that can decrypt.
 * Only the worker — the one process that must sign — holds the matching
 * X25519 private key. Layout: ephemeral X25519 public key (32) || nonce (12)
 * || GCM tag (16) || body, base64. Key = HKDF-SHA256(ECDH shared secret,
 * salt = ephPub || recipientPub, info = "hoodmint/wallet-key/v1").
 */
export interface SealedToRecipient {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly algorithm: typeof ASYMMETRIC_ALGORITHM;
}

export const ASYMMETRIC_ALGORITHM = "x25519-hkdf-sha256-aes-256-gcm" as const;

/** Any sealed blob a wallet row may carry: legacy symmetric or envelope. */
export type SealedWalletKey = SealedSecret | SealedToRecipient;

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

/* ── X25519 envelope primitives ─────────────────────────────────────────── */

// Raw 32-byte X25519 keys wrapped in their fixed DER prefixes (RFC 8410),
// so the operator-facing format is just base64 of 32 bytes — same shape as
// APP_ENCRYPTION_KEY — and never a PEM file on disk.
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const HKDF_INFO = "hoodmint/wallet-key/v1";

function raw32(b64: string, what: string): Buffer {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) {
    throw new Error(`${what} must decode to exactly 32 bytes`);
  }
  return raw;
}

function publicKeyFromRaw(raw: Buffer) {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

function privateKeyFromRaw(raw: Buffer) {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function rawPublicKey(key: ReturnType<typeof createPublicKey>): Buffer {
  return Buffer.from(key.export({ format: "der", type: "spki" })).subarray(X25519_SPKI_PREFIX.length);
}

export interface WalletKeypair {
  /** Give to the web app (WALLET_KEY_PUBLIC_KEY). Encrypt-only; not secret. */
  readonly publicKeyB64: string;
  /** Worker ONLY (WALLET_KEY_PRIVATE_KEY). The one thing that can decrypt. */
  readonly privateKeyB64: string;
}

/** Fresh X25519 recipient keypair, both halves as base64 raw 32 bytes. */
export function generateWalletKeypair(): WalletKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const rawPriv = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).subarray(
    X25519_PKCS8_PREFIX.length,
  );
  return {
    publicKeyB64: rawPublicKey(publicKey).toString("base64"),
    privateKeyB64: rawPriv.toString("base64"),
  };
}

/** Public half of a base64 raw X25519 private key (for config self-checks). */
export function walletPublicKeyFor(privateKeyB64: string): string {
  const priv = privateKeyFromRaw(raw32(privateKeyB64, "WALLET_KEY_PRIVATE_KEY"));
  return rawPublicKey(createPublicKey(priv)).toString("base64");
}

/** Encrypt a UTF-8 secret so that only the holder of the private key can read it. */
export function sealToRecipient(plaintext: string, recipientPublicKeyB64: string): SealedToRecipient {
  const recipientRaw = raw32(recipientPublicKeyB64, "WALLET_KEY_PUBLIC_KEY");
  const recipient = publicKeyFromRaw(recipientRaw);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = rawPublicKey(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.concat([ephemeralRaw, recipientRaw]), HKDF_INFO, 32),
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  shared.fill(0);
  return {
    ciphertext: Buffer.concat([ephemeralRaw, nonce, tag, encrypted]).toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
    algorithm: ASYMMETRIC_ALGORITHM,
  };
}

/** Decrypt an envelope with the recipient private key; throws on tamper/wrong key. */
export function openFromRecipient(sealed: SealedToRecipient, recipientPrivateKeyB64: string): string {
  if (sealed.algorithm !== ASYMMETRIC_ALGORITHM) {
    throw new Error(`unsupported cipher ${sealed.algorithm}`);
  }
  const priv = privateKeyFromRaw(raw32(recipientPrivateKeyB64, "WALLET_KEY_PRIVATE_KEY"));
  const recipientRaw = rawPublicKey(createPublicKey(priv));
  const blob = Buffer.from(sealed.ciphertext, "base64");
  const ephemeralRaw = blob.subarray(0, 32);
  const nonce = blob.subarray(32, 44);
  const tag = blob.subarray(44, 44 + GCM_AUTH_TAG_LENGTH);
  const body = blob.subarray(44 + GCM_AUTH_TAG_LENGTH);
  const shared = diffieHellman({ privateKey: priv, publicKey: publicKeyFromRaw(ephemeralRaw) });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.concat([ephemeralRaw, recipientRaw]), HKDF_INFO, 32),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } finally {
    key.fill(0);
    shared.fill(0);
  }
}

export interface WalletKeyOpeners {
  /** APP_ENCRYPTION_KEY — opens legacy symmetric blobs (pre-envelope imports). */
  readonly masterKeyB64: string;
  /** WALLET_KEY_PRIVATE_KEY — opens envelope blobs. Worker only. */
  readonly walletPrivateKeyB64?: string | undefined;
}

export function isSealedToRecipient(sealed: SealedWalletKey): sealed is SealedToRecipient {
  return sealed.algorithm === ASYMMETRIC_ALGORITHM;
}

/**
 * Parse + open a wallet's stored sealed-key JSON whichever scheme sealed it.
 * The stored JSON is validated structurally BEFORE any crypto so a corrupt
 * blob raises a fixed message — JSON.parse's own SyntaxError would quote a
 * slice of the (cipher)text into the error, which then lands in attempt
 * rows and logs.
 */
export function openWalletKey(sealedJson: string, openers: WalletKeyOpeners): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sealedJson);
  } catch {
    throw new Error("stored wallet key blob is not valid JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as { ciphertext?: unknown }).ciphertext !== "string" ||
    typeof (parsed as { algorithm?: unknown }).algorithm !== "string"
  ) {
    throw new Error("stored wallet key blob has an unexpected shape");
  }
  const sealed = parsed as SealedWalletKey;
  if (isSealedToRecipient(sealed)) {
    if (openers.walletPrivateKeyB64 === undefined) {
      throw new Error(
        "wallet key is sealed to the worker keypair but WALLET_KEY_PRIVATE_KEY is not configured",
      );
    }
    return openFromRecipient(sealed, openers.walletPrivateKeyB64);
  }
  return openSecret(sealed, openers.masterKeyB64);
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
