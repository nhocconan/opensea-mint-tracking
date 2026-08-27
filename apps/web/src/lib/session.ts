import type { Action } from "@hoodmint/auth";
import { assertCan, can } from "@hoodmint/auth";
import { AppError } from "@hoodmint/core";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { container } from "./container.ts";

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: "admin" | "operator" | "viewer";
}

/** Current session user or null; never throws. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const { auth } = container();
  const session = await auth.api.getSession({ headers: await headers() });
  const user = session?.user;
  if (user === undefined || user === null) {
    return null;
  }
  const role = user.role;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: role === "admin" || role === "operator" || role === "viewer" ? role : "viewer",
  };
}

/** Page guard: redirect anonymous users to login, unauthorized to feeds. */
export async function requirePage(action: Action): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user === null) {
    redirect("/login");
  }
  if (!can(user.role, action)) {
    redirect("/?denied=1");
  }
  return user;
}

/** API/action guard: throws the typed AppError from assertCan. */
export async function requireApi(action: Action): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user === null) {
    assertCan(null, action);
    throw new Error("unreachable");
  }
  assertCan(user.role, action);
  return user;
}

/**
 * ADR 0008 step-up gate: RBAC (like requireApi) PLUS proof of a genuinely
 * fresh WebAuthn/passkey ceremony — not merely a valid session, and not
 * merely a fresh session (Better Auth's own `freshAge` concept can't tell a
 * fresh passkey sign-in from a fresh password sign-in). `lastAuthMethod` is
 * stamped server-side, only on `/sign-in/passkey`, only after Better Auth's
 * own WebAuthn verification succeeds (packages/auth/src/auth.ts's `after`
 * hook) — this function never trusts anything the client claims about how
 * it authenticated. The window is intentionally tighter than the general
 * 15-minute session freshness: this gate exists specifically so a stale
 * browser tab can't arm a mint plan on muscle memory.
 */
const STEP_UP_MAX_AGE_MS = 2 * 60 * 1000;

export async function requireFreshStepUp(action: Action): Promise<SessionUser> {
  const user = await requireApi(action);
  const { auth } = container();
  const raw = await auth.api.getSession({ headers: await headers() });
  const session = raw?.session as
    | { createdAt: Date | string; lastAuthMethod?: string | null }
    | undefined;
  if (session === undefined) {
    throw new AppError("AuthRequired", "no active session");
  }
  const createdAt =
    session.createdAt instanceof Date ? session.createdAt : new Date(session.createdAt);
  const ageMs = Date.now() - createdAt.getTime();
  if (session.lastAuthMethod !== "passkey" || ageMs > STEP_UP_MAX_AGE_MS) {
    throw new AppError(
      "AuthRequired",
      "step-up re-authentication required — sign in with your passkey again, then retry within 2 minutes",
    );
  }
  return user;
}
