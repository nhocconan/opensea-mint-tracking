import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadEnv, safeLoadEnv } from "./index.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");

function validSource(): Record<string, string> {
  return {
    APP_ENCRYPTION_KEY: KEY,
    BETTER_AUTH_SECRET: "x".repeat(40),
    DATABASE_URL: "postgres://u:p@localhost:5432/app",
    VALKEY_URL: "redis://localhost:6379/0",
  };
}

describe("loadEnv", () => {
  it("applies documented defaults", () => {
    const config = loadEnv({ source: validSource() });
    expect(config.APP_ENV).toBe("production");
    expect(config.ROBINHOOD_CHAIN_ID).toBe(4663);
    expect(config.DISCOVERY_INTERVAL_SECONDS).toBe(300);
    expect(config.OPENSEA_RATE_RESERVE_PERCENT).toBe(10);
    expect(config.ALERT_STAGE_WINDOWS_MINUTES).toEqual([60, 15, 5]);
    expect(config.DEMO_MODE).toBe(false);
    expect(config.APP_URL).toBe("http://localhost:3960");
    expect(config.PORT).toBe(3960);
    expect(config.WORKER_HEALTH_PORT).toBe(3963);
  });

  it("parses alert windows, trims, and sorts descending", () => {
    const config = loadEnv({
      source: { ...validSource(), ALERT_STAGE_WINDOWS_MINUTES: " 5, 60 ,15" },
    });
    expect(config.ALERT_STAGE_WINDOWS_MINUTES).toEqual([60, 15, 5]);
  });

  it("rejects a non-32-byte encryption key", () => {
    expect(() => loadEnv({ source: { ...validSource(), APP_ENCRYPTION_KEY: "c2hvcnQ=" } })).toThrow(
      ConfigError,
    );
  });

  it("rejects an http app url in production posture and non-pg databases together, listing every issue", () => {
    try {
      loadEnv({
        source: {
          ...validSource(),
          APP_URL: "http://example.com",
          DATABASE_URL: "mysql://nope",
          OPENSEA_RATE_RESERVE_PERCENT: "150",
        },
      });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join("\n");
      expect(issues).toContain("APP_URL");
      expect(issues).toContain("DATABASE_URL");
      expect(issues).toContain("OPENSEA_RATE_RESERVE_PERCENT");
    }
  });

  it("rejects an auth secret shorter than 32 chars", () => {
    expect(() => loadEnv({ source: { ...validSource(), BETTER_AUTH_SECRET: "short" } })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it("safeLoadEnv reports issues without throwing", () => {
    const bad = safeLoadEnv({ source: { DATABASE_URL: "postgres://x" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("describeConfig never exposes secret values", () => {
    const config = loadEnv({
      source: {
        ...validSource(),
        OPENSEA_API_KEY: "sk-secret-value",
        OPENSEA_WALLET_PAT: "pat-secret",
      },
    });
    const described = JSON.stringify(describeConfig(config));
    expect(described).not.toContain("sk-secret-value");
    expect(described).not.toContain("pat-secret");
    expect(described).toContain('"openseaKeyFromEnv":true');
  });
});
