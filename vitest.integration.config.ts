import { defineConfig } from "vitest/config";

// Integration tests run against real PostgreSQL/Valkey provisioned by
// scripts/integration-tests.sh — never in the default `pnpm test` path.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    passWithNoTests: false,
  },
});
