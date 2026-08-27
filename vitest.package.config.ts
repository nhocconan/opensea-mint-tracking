import { defineConfig } from "vitest/config";

// Shared config for package-level unit/contract tests.
// Integration tests that need real PostgreSQL/Valkey live in scripts/integration-tests.sh.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
  },
});
