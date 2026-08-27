/**
 * `make token` — mint a one-time /setup bootstrap token (PRD §7.6).
 * Runs inside the worker package so tsx can resolve workspace imports.
 */
import { issueBootstrapToken } from "@hoodmint/auth";
import { loadEnv } from "@hoodmint/config";
import { createDb, dbClient } from "@hoodmint/db";

async function main(): Promise<void> {
  const config = loadEnv();
  const db = createDb(config.DATABASE_URL, { max: 1 });
  const issued = await issueBootstrapToken(db);
  await dbClient(db).end({ timeout: 5 });
  console.log("One-time setup token (valid 30 minutes, single use):");
  console.log(`  ${issued.token}`);
  console.log(`Open ${config.APP_URL}/setup and paste the token.`);
}

main().catch((error: unknown) => {
  console.error("failed to issue bootstrap token:", error instanceof Error ? error.message : error);
  console.error(
    "Is PostgreSQL up and migrated? Try: docker compose up -d postgres && make migrate",
  );
  process.exit(1);
});
