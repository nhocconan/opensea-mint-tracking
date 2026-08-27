import { describe, expect, it } from "vitest";
import { assertCan, can } from "./rbac.ts";

describe("RBAC matrix (PRD §7.6)", () => {
  it("viewers are read-only", () => {
    expect(can("viewer", "feeds:read")).toBe(true);
    expect(can("viewer", "projects:read")).toBe(true);
    for (const action of [
      "watchlist:manage",
      "scans:run",
      "wallets:manage",
      "credentials:manage",
      "providers:configure",
      "alerts:configure",
      "users:manage",
      "audit:read",
      "system:operate",
    ] as const) {
      expect(can("viewer", action), action).toBe(false);
    }
  });

  it("operators run scans and wallets but never credentials/users", () => {
    expect(can("operator", "scans:run")).toBe(true);
    expect(can("operator", "wallets:manage")).toBe(true);
    expect(can("operator", "watchlist:manage")).toBe(true);
    expect(can("operator", "credentials:manage")).toBe(false);
    expect(can("operator", "users:manage")).toBe(false);
    expect(can("operator", "providers:configure")).toBe(false);
    expect(can("operator", "audit:read")).toBe(false);
  });

  it("admins can do everything", () => {
    for (const action of [
      "feeds:read",
      "credentials:manage",
      "users:manage",
      "audit:read",
      "system:operate",
    ] as const) {
      expect(can("admin", action), action).toBe(true);
    }
  });

  it("execution config/operate is admin-only (ADR 0008) — never granted to operator by default", () => {
    expect(can("admin", "execution:configure")).toBe(true);
    expect(can("admin", "execution:operate")).toBe(true);
    expect(can("operator", "execution:configure")).toBe(false);
    expect(can("operator", "execution:operate")).toBe(false);
    expect(can("viewer", "execution:configure")).toBe(false);
    expect(can("viewer", "execution:operate")).toBe(false);
  });

  it("unknown or missing roles are denied", () => {
    expect(can(undefined, "feeds:read")).toBe(false);
    expect(can("superuser", "users:manage")).toBe(false);
    expect(can(null, "feeds:read")).toBe(false);
  });

  it("assertCan throws a Forbidden AppError", () => {
    expect(() => assertCan("viewer", "users:manage")).toThrowError(/may not perform/);
    expect(() => assertCan("admin", "users:manage")).not.toThrow();
  });
});
