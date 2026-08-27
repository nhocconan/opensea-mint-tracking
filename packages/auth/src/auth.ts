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

export interface CreateAuthOptions {
  readonly db: Db;
  readonly secret: string;
  readonly baseUrl: string;
  readonly secureCookies: boolean;
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
        if (ctx.path !== "/sign-in/passkey") {
          return;
        }
        const newSession = ctx.context.newSession;
        if (newSession === undefined || newSession === null) {
          return;
        }
        await options.db
          .update(sessionTable)
          .set({ lastAuthMethod: "passkey" })
          .where(eq(sessionTable.token, newSession.session.token));
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
// Apps infer session shape from their own singleton:
//   type Session = typeof auth.$Infer.Session;
