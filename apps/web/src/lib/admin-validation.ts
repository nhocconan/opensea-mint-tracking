/**
 * Pure, framework-free validators shared by admin server actions and the
 * client forms that call the Better Auth admin plugin. Kept out of the
 * "use server" module so they can be unit-tested without pulling in
 * next/headers or the DB container.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` (trimmed) is a v4-shaped UUID. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export const ADMIN_ROLES = ["viewer", "operator", "admin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

export interface NewUserInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly role: string;
}

export type Validation = { ok: true } | { ok: false; message: string };

/**
 * Fail-closed validation for `authClient.admin.createUser`. Mirrors the
 * 12-char password floor the /setup bootstrap flow enforces so an
 * admin-created account is never weaker than the first admin's.
 */
export function validateNewUser(input: NewUserInput): Validation {
  const email = input.email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, message: "Enter a valid email address." };
  }
  if (input.name.trim() === "") {
    return { ok: false, message: "Name is required." };
  }
  if (input.password.length < 12) {
    return { ok: false, message: "Password must be at least 12 characters." };
  }
  if (!isAdminRole(input.role)) {
    return { ok: false, message: "Pick a role (viewer, operator, or admin)." };
  }
  return { ok: true };
}

/** Clamp a 1-based page number parsed from an untrusted query param. */
export function parsePage(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
