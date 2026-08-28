import { describe, expect, it } from "vitest";
import { isAdminRole, isUuid, parsePage, validateNewUser } from "./admin-validation.ts";

describe("admin-validation (fail-closed pure validators)", () => {
  it("isUuid accepts a v4-shaped id and trims, rejects junk", () => {
    expect(isUuid("2b3f1c8a-1a2b-4c3d-9e4f-5a6b7c8d9e0f")).toBe(true);
    expect(isUuid("  2b3f1c8a-1a2b-4c3d-9e4f-5a6b7c8d9e0f  ")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("2b3f1c8a1a2b4c3d9e4f5a6b7c8d9e0f")).toBe(false);
  });

  it("isAdminRole only allows the three app roles", () => {
    expect(isAdminRole("viewer")).toBe(true);
    expect(isAdminRole("operator")).toBe(true);
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("superuser")).toBe(false);
    expect(isAdminRole("user")).toBe(false);
  });

  it("validateNewUser enforces email, name, 12-char password, valid role", () => {
    const good = {
      email: "ops@example.com",
      password: "correcthorsebattery",
      name: "Ops",
      role: "operator",
    };
    expect(validateNewUser(good)).toEqual({ ok: true });
    expect(validateNewUser({ ...good, email: "bad" }).ok).toBe(false);
    expect(validateNewUser({ ...good, name: "  " }).ok).toBe(false);
    expect(validateNewUser({ ...good, password: "short" }).ok).toBe(false);
    expect(validateNewUser({ ...good, role: "root" }).ok).toBe(false);
  });

  it("parsePage clamps to >= 1 and defaults on junk", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-4")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("7")).toBe(7);
  });
});
