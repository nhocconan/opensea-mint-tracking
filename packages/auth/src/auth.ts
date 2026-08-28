/**
 * Better Auth server instance (PRD §7.6): PostgreSQL persistence via the
 * Drizzle adapter, secure HTTP-only cookies, admin + 2FA plugins, public
 * signup disabled (bootstrap admin only in v1).
 */

import { passkey } from "@better-auth/passkey";
import type { Db } from "@hoodmint/db";
import {
  account as accountTable,
  passkey as passkeyTable,
  session as sessionTable,
  twoFactor as twoFactorTable,
  user as userTable,
  verification as verificationTable,
} from "@hoodmint/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, twoFactor } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { initialLockoutState, isLocked, type LockoutState, recordFailure } from "./lockout.ts";

export interface CreateAuthOptions {
  readonly db: Db;
  readonly secret: string;
  readonly baseUrl: string;
  readonly secureCookies: boolean;
}

/**
 * Generic message for every failed authentication — bad password, unknown
 * email, or a live lockout all surface this exact string with the same 401
 * status, so the response never reveals which case occurred (no user
 * enumeration). Better Auth already returns a generic message for bad
 * password vs unknown email; this keeps the lockout indistinguishable too.
 */
const GENERIC_AUTH_FAILURE = "Invalid credentials or too many attempts — try again later.";

/**
 * In-memory brute-force lockout keyed by `email|ip`, matching the deliberate
 * `rateLimit.storage: "memory"` decision below — no DB table, counters reset
 * on restart (acceptable for this single-instance deploy). Defense-in-depth
 * layered on top of the per-path `rateLimit.customRules`; the pure escalation
 * logic lives in lockout.ts. Never logged (would leak an email + IP pair).
 */
const lockoutStore = new Map<string, LockoutState>();

/** Bound the map: drop entries that are neither locked nor recently active. */
function pruneLockouts(now: number): void {
  if (lockoutStore.size < 1000) {
    return;
  }
  for (const [key, state] of lockoutStore) {
    if (!isLocked(state, now) && now - state.lastFailureAt > 60 * 60_000) {
      lockoutStore.delete(key);
    }
  }
}

/**
 * Left-most token of `X-Forwarded-For` (the original client, as this app runs
 * behind Traefik which appends the real client IP on the left), falling back
 * to `X-Real-IP`. Returns "unknown" when neither is present so keying still
 * works. Only ever used as an opaque lockout-key component — never logged.
 */
function clientIp(headers: Headers | undefined): string {
  const forwarded = headers?.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return headers?.get("x-real-ip")?.trim() || "unknown";
}

/** Lockout key for the current sign-in attempt, or null if no email is present. */
function lockoutKey(ctx: { body?: unknown; headers?: Headers | undefined }): string | null {
  const body = ctx.body as { email?: unknown } | undefined;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email === "") {
    return null;
  }
  return `${email}|${clientIp(ctx.headers)}`;
}

export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(options.db, {
      provider: "pg",
      schema: {
        user: userTable,
        session: sessionTable,
        account: accountTable,
        verification: verificationTable,
        twoFactor: twoFactorTable,
        passkey: passkeyTable,
      },
    }),
    secret: options.secret,
    baseURL: options.baseUrl,
    trustedOrigins: [options.baseUrl],
    advanced: {
      cookieOptions: {
        secure: options.secureCookies,
        sameSite: "lax",
        httpOnly: true,
      },
      useSecureCookies: options.secureCookies,
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      requireEmailVerification: false,
    },
    user: {
      additionalFields: {
        role: { type: "string", required: true, defaultValue: "viewer", input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // ADR 0008's step-up gate uses this alongside lastAuthMethod below —
      // freshAge alone (Better Auth's own concept: session.createdAt within
      // this window) doesn't prove *which* factor was used, so arming
      // requires both. 15 min is generous for ordinary admin actions; the
      // arm-specific check (apps/web/src/lib/session.ts) uses a tighter
      // window of its own.
      freshAge: 60 * 15,
      additionalFields: {
        lastAuthMethod: { type: "string", required: false, input: false },
      },
    },
    rateLimit: {
      enabled: true,
      // "database" storage requires a `rateLimit` table Better Auth's
      // Drizzle adapter never had (found live 2026-08-22: every request
      // logged `[BetterAuthError]: The model "rateLimit" was not found
      // in the schema object` — rate limiting was silently non-functional
      // the whole time, not just unpersisted). "memory" is Better Auth's
      // own default and, per its docs, the recommended choice for
      // exactly this deployment shape (single self-hosted instance, no
      // distributed workers sharing rate-limit state — PRD §3's explicit
      // non-goal). Counters reset on restart, an acceptable tradeoff here.
      storage: "memory",
      window: 60,
      max: 100,
      // Auth endpoints are the brute-force surface, so they get far tighter
      // per-path buckets than the global 100/60s. Better Auth matches these
      // against the sub-path (baseURL stripped) and supports `*` wildcards.
      // NOTE: keyed by client IP the same way as the global limiter; behind a
      // multi-hop proxy without `advanced.ipAddress.trustedProxies` set,
      // Better Auth falls back to one shared per-path bucket — still a hard
      // cap on total attempts. The per-identifier lockout hook below is the
      // IP-aware, escalating second layer.
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        // Real passkey sign-in endpoint (not /sign-in/passkey).
        "/passkey/verify-authentication": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 3 },
        "/two-factor/*": { window: 60, max: 5 },
      },
    },
    plugins: [
      admin({
        adminRole: "admin",
        adminUserId: undefined,
        defaultRole: "viewer",
      }),
      twoFactor({
        issuer: "HoodMint Radar",
      }),
      // ADR 0008: WebAuthn/hardware-key step-up for arming a mint plan —
      // explicitly not a password/TOTP re-prompt, since a phished software
      // gate would sit directly in front of the on-chain caps. rpID is
      // derived from baseUrl so it's correct in both dev (localhost) and
      // production, never hard-coded.
      passkey({
        rpID: new URL(options.baseUrl).hostname,
        rpName: "HoodMint Radar",
      }),
    ],
    hooks: {
      // Public signup exists only for the /setup first-admin flow; once any
      // user exists it is closed (PRD §7.6). Admins create users explicitly.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email") {
          const existing = await options.db
            .select({ count: sql<number>`count(*)::int` })
            .from(userTable);
          if ((existing[0]?.count ?? 0) > 0) {
            throw new APIError("FORBIDDEN", {
              message: "Sign-up is disabled; ask an administrator to create accounts.",
            });
          }
        }
        // Brute-force lockout: reject a locked identifier BEFORE any password
        // verification runs. Same 401 + generic message as a bad password, so
        // a locked account is indistinguishable from a wrong one.
        if (ctx.path === "/sign-in/email") {
          const key = lockoutKey(ctx);
          if (key !== null) {
            const state = lockoutStore.get(key) ?? initialLockoutState;
            if (isLocked(state, Date.now())) {
              throw new APIError("UNAUTHORIZED", { message: GENERIC_AUTH_FAILURE });
            }
          }
        }
      }),
      // Stamps lastAuthMethod="passkey" on the freshly-created session, and
      // ONLY on the freshly-created session from a real, server-verified
      // WebAuthn ceremony (ctx.context.newSession is populated by Better
      // Auth's own core only after passkey verification succeeds — this
      // hook never runs on a failed assertion). This is what the ADR 0008
      // step-up check (apps/web/src/lib/session.ts) actually gates on,
      // since Better Auth's session.freshAge alone can't distinguish a
      // fresh passkey sign-in from a fresh password sign-in.
      after: createAuthMiddleware(async (ctx) => {
        // Password sign-in outcome feeds the brute-force lockout. The handler
        // populates ctx.context.newSession only after a fully successful sign-in
        // (see setSessionCookie); on any failure it threw an APIError and this
        // hook still runs (dispatch runs after-hooks on error responses too).
        if (ctx.path === "/sign-in/email") {
          const key = lockoutKey(ctx);
          if (key !== null) {
            const now = Date.now();
            if (ctx.context.newSession) {
              // Success clears the identifier (recordSuccess semantics).
              lockoutStore.delete(key);
            } else {
              lockoutStore.set(
                key,
                recordFailure(lockoutStore.get(key) ?? initialLockoutState, now),
              );
            }
            pruneLockouts(now);
          }
          return;
        }
        // The @better-auth/passkey plugin's sign-in endpoint is
        // "/passkey/verify-authentication" (it calls createSession +
        // setSessionCookie there) — NOT "/sign-in/passkey", which never
        // fires. Matching the wrong path meant lastAuthMethod was never
        // stamped, so requireFreshStepUp rejected every arm/import forever
        // even right after a successful passkey ceremony (found live
        // 2026-08-28). Match the real endpoint.
        if (ctx.path !== "/passkey/verify-authentication") {
          return;
        }
        const newSession = ctx.context.newSession;
        if (newSession === undefined || newSession === null) {
          return;
        }
        // Stamp lastAuthMethod AND refresh createdAt so the step-up freshness
        // window measures from THIS passkey ceremony, not the original login
        // (createSession copies the row but the 2-minute gate must key off the
        // ceremony instant).
        await options.db
          .update(sessionTable)
          .set({ lastAuthMethod: "passkey", createdAt: new Date() })
          .where(eq(sessionTable.token, newSession.session.token));
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
// Apps infer session shape from their own singleton:
//   type Session = typeof auth.$Infer.Session;
