/**
 * Server-side RBAC (PRD §7.6): authorization is enforced here, in every
 * server action / route handler / API path — hiding a button is not authz.
 * Roles: admin > operator > viewer.
 */
import { AppError } from "@hoodmint/core";

export type Role = "admin" | "operator" | "viewer";

export const ACTIONS = [
  "feeds:read",
  "projects:read",
  "watchlist:manage",
  "scans:run",
  "wallets:manage",
  "credentials:manage",
  "providers:configure",
  "alerts:configure",
  "users:manage",
  "audit:read",
  "system:operate",
  "exports:read",
  /** ADR 0008: execution config (RPC endpoints, signers) and mint-plan
   *  arm/disarm are admin-only, distinct from every read-only action above
   *  — never granted to operator by default, regardless of what operator
   *  gains later, without a deliberate ADR-level decision to widen it. */
  "execution:configure",
  "execution:operate",
] as const;

export type Action = (typeof ACTIONS)[number];

const MATRIX: Readonly<Record<Role, ReadonlySet<Action>>> = {
  viewer: new Set<Action>(["feeds:read", "projects:read"]),
  operator: new Set<Action>([
    "feeds:read",
    "projects:read",
    "watchlist:manage",
    "scans:run",
    "wallets:manage",
    "exports:read",
  ]),
  admin: new Set<Action>(ACTIONS),
};

export function can(role: string | undefined | null, action: Action): boolean {
  if (role !== "admin" && role !== "operator" && role !== "viewer") {
    return false;
  }
  return MATRIX[role].has(action);
}

export function assertCan(role: string | undefined | null, action: Action): void {
  if (!can(role, action)) {
    throw new AppError("Forbidden", `role "${role ?? "anonymous"}" may not perform ${action}`, {
      statusCode: 403,
    });
  }
}

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  admin: "Admin — full control including credentials and users",
  operator: "Operator — scans, wallets, watchlists; no credentials/users",
  viewer: "Viewer — read-only feeds and project detail",
};
