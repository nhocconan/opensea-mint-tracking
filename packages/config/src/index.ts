/**
 * Validated runtime configuration.
 *
 * Every environment variable crosses a Zod boundary exactly once here.
 * Downstream code imports the parsed `AppConfig` type — it must never read
 * `process.env` directly, so an invalid deployment fails loudly at boot with
 * a complete list of problems instead of misbehaving at runtime.
 */
import { z } from "zod";

const bool = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(["1", "0", "true", "false", "yes", "no", "on", "off"]))
  .transform((v) => ["1", "true", "yes", "on"].includes(v));

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

const base64Key32 = z
  .string()
  .trim()
  .refine((v) => v.length > 0, "must not be empty")
  .refine((v) => {
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  }, "must be base64 encoding exactly 32 bytes (run: make bootstrap)");

/**
 * Optional EVM address. A blank value (`FOO=` in a .env template) means
 * "unset", never the empty string — downstream `?? fallback` checks rely on
 * `undefined`. Format is validated here so a typo fails at boot, not at the
 * first `normalizeAddress` call deep in a worker.
 */
const optionalEvmAddress = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .refine(
    (v) => v === undefined || /^0x[0-9a-fA-F]{40}$/.test(v),
    "must be a 0x-prefixed, 40-hex-character EVM address",
  )
  .optional();

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine(
    (v) => v.startsWith("https://") || v.startsWith("http://localhost"),
    "must be an https:// URL (http allowed only for localhost)",
  );

export const envSchema = z.object({
  APP_ENV: z.enum(["development", "production"]).default("production"),
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
  APP_URL: httpsUrl.default("http://localhost:3960"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  APP_ENCRYPTION_KEY: base64Key32,
  BETTER_AUTH_SECRET: z.string().trim().min(32),

  DATABASE_URL: z.string().trim().startsWith("postgres://", "must be a postgres:// URL"),
  VALKEY_URL: z.string().trim().startsWith("redis://", "must be a redis:// URL"),

  ROBINHOOD_CHAIN_ID: nonNegativeInt.default(4663),
  RPC_URL: z.string().trim().optional(),
  RPC_WS_URL: z.string().trim().optional(),
  CHAIN_SYNC_INITIAL_RANGE: positiveInt.default(5000),
  CHAIN_SYNC_INTERVAL_SECONDS: positiveInt.default(15),

  OPENSEA_API_KEY: z.string().trim().optional(),
  OPENSEA_API_BASE: httpsUrl.default("https://api.opensea.io"),
  OPENSEA_CHAIN_FALLBACK: z.string().trim().min(1).default("robinhood"),
  DISCOVERY_INTERVAL_SECONDS: positiveInt.default(300),
  OPENSEA_MAX_PAGES: positiveInt.default(5),
  /** Chain-wide collection discovery (finds ALL Robinhood Chain collections,
   *  not just the curated /drops feed). Kept small and on a slower cadence
   *  than /drops discovery because it is a broad, quota-heavy sweep: page
   *  count × page size × interval bounds how much of the free OpenSea tier it
   *  can burn per hour. See apps/worker discovery.runCollectionDiscovery. */
  COLLECTION_DISCOVERY_MAX_PAGES: positiveInt.default(3),
  COLLECTION_DISCOVERY_INTERVAL_SECONDS: positiveInt.default(900),
  /** Hard per-pass ceiling on how many newest collections one sweep will
   *  upsert+enqueue, so a very large chain can never create tens of thousands
   *  of detail jobs in a single tick (defense on top of MAX_PAGES). */
  COLLECTION_DISCOVERY_MAX_TOTAL: positiveInt.default(300),
  OPENSEA_RATE_RESERVE_PERCENT: nonNegativeInt
    .default(10)
    .refine((v) => v < 100, "reserve must leave room for traffic (< 100)"),
  OPENSEA_HOURLY_LIMIT: positiveInt.default(600),
  OPENSEA_WALLET_PAT: z.string().trim().optional(),

  ALERT_STAGE_WINDOWS_MINUTES: z
    .string()
    .trim()
    .default("60,15,5")
    .transform((v) =>
      v
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => Number.parseInt(part, 10))
        .sort((a, b) => b - a),
    )
    .refine(
      (parts) => parts.length > 0 && parts.every((p) => p > 0),
      "must be comma-separated positive minutes",
    ),

  DEMO_MODE: bool.default(false),
  /** Dev-only prefill for Admin → Wallets. There is no baked-in wallet: the
   *  app tracks nothing until an operator adds an address in the admin panel
   *  (or sets this var for local convenience). */
  DEFAULT_WALLET_ADDRESS: optionalEvmAddress,

  /** ADR 0008: hard default OFF. Even when true, only the `browser_wallet`
   *  signer scheme can act on it — Phase 2 delegated custody schemes are
   *  not implemented (packages/signing throws), so this flag alone can
   *  never cause a server-held key to sign anything. */
  LIVE_EXECUTION_ENABLED: bool.default(false),
  MINT_WATCH_INTERVAL_SECONDS: positiveInt.default(30),

  /** Precision fire scheduling (ADR 0009 competitiveness — see
   *  packages/core/fire-schedule.ts). The 30s MINT_WATCH interval above is
   *  the coarse fallback claim; these drive the fast hot-loop that fires a
   *  time-critical armed plan AT its stage-open instant (clock-corrected)
   *  rather than on the next coarse tick. On Robinhood Chain's FIFO
   *  sequencer, winning an FCFS is a latency race — these are the knobs. */
  MINT_HOT_LOOP_INTERVAL_MS: positiveInt.default(200),
  /** How early to leave "waiting" and start spinning tight before fire. */
  MINT_FIRE_HOT_WINDOW_MS: positiveInt.default(2_000),
  /** Fire this many ms before the stage's own open, to absorb
   *  submit→sequencer latency. Tune to measured round-trip to your RPC. */
  MINT_FIRE_LEAD_MS: nonNegativeInt.default(150),
  /** Keep re-firing this many ms past stage open before giving up — the
   *  "chạy liên tục để compete" burst on a FIFO chain. */
  MINT_FIRE_CONTINUE_MS: positiveInt.default(4_000),

  /** ADR 0007: hard default OFF. X's free API tier was retired Feb 2026 —
   *  this is metered pay-per-use, so nothing may call it without both an
   *  explicit opt-in AND a real bearer token the operator supplies. The
   *  sentiment worker (apps/worker/src/workers/sentiment.ts) reads this and
   *  self-gates to a no-op unless it is true AND X_API_BEARER_TOKEN is set. */
  X_SIGNALS_ENABLED: bool.default(false),
  X_API_BEARER_TOKEN: z.string().trim().optional(),
  /** ADR 0007 (revised 2026-08-28): the scan now reads X through xAI's Grok
   *  with the server-side x_search tool, authorized by the operator's X
   *  Premium+/SuperGrok subscription (device-code OAuth, stored encrypted)
   *  or a console.x.ai API key — no separate X API billing. This env var is
   *  the last-resort key fallback for a headless bootstrap; the stored
   *  credentials take priority. Model ids rev (grok-4.5/4.6 exist), so the
   *  model is configurable rather than pinned in code. */
  XAI_MODEL: z.string().trim().min(1).default("grok-4"),
  XAI_API_KEY: z.string().trim().optional(),

  /** Web Push channel (feature-backlog.md, shipped 2026-08-22): opt-in
   *  like X signals above — no channel is active without an operator-
   *  generated VAPID keypair (`pnpm vapid-keys`). Unset means the
   *  "Browser push" section on /admin/alerts stays hidden rather than
   *  erroring; sendNotification is never called without all three set. */
  VAPID_PUBLIC_KEY: z.string().trim().optional(),
  VAPID_PRIVATE_KEY: z.string().trim().optional(),
  /** RFC 8292: must be a mailto: address or https: URL identifying the
   *  operator, sent to push services so they can contact you about a
   *  misbehaving sender — not a secret. */
  VAPID_SUBJECT: z.string().trim().optional(),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().trim().optional(),

  PORT: positiveInt.default(3960),
  WORKER_HEALTH_PORT: positiveInt.default(3963),
});

export type RawEnv = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export type AppConfig = Readonly<RawEnv>;

export interface LoadEnvOptions {
  /** Defaults to process.env; injectable for tests. */
  readonly source?: Record<string, string | undefined>;
}

/**
 * Parse and validate environment configuration.
 * Throws {@link ConfigError} listing every problem at once.
 */
export function loadEnv(options: LoadEnvOptions = {}): AppConfig {
  const source = options.source ?? process.env;
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new ConfigError(issues);
  }
  return result.data;
}

/** Non-throwing variant for health/diagnostic endpoints. */
export function safeLoadEnv(
  options: LoadEnvOptions = {},
): { ok: true; config: AppConfig } | { ok: false; issues: string[] } {
  const source = options.source ?? process.env;
  const result = envSchema.safeParse(source);
  if (result.success) {
    return { ok: true, config: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}

/**
 * Masked summary safe for diagnostics export — never includes secret values.
 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    appEnv: config.APP_ENV,
    appUrl: config.APP_URL,
    chainId: config.ROBINHOOD_CHAIN_ID,
    rpcConfigured: Boolean(config.RPC_URL),
    wsConfigured: Boolean(config.RPC_WS_URL),
    openseaKeyFromEnv: Boolean(config.OPENSEA_API_KEY),
    patFromEnv: Boolean(config.OPENSEA_WALLET_PAT),
    discoveryIntervalSeconds: config.DISCOVERY_INTERVAL_SECONDS,
    collectionDiscoveryIntervalSeconds: config.COLLECTION_DISCOVERY_INTERVAL_SECONDS,
    alertWindowsMinutes: config.ALERT_STAGE_WINDOWS_MINUTES,
    demoMode: config.DEMO_MODE,
    logLevel: config.LOG_LEVEL,
  };
}
