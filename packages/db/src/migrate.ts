/**
 * Migration runner — applies committed SQL migrations in order (PRD §14:
 * generated, reviewed migrations only; never drizzle-kit push in production).
 */

import { existsSync } from "node:fs";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, dbClient } from "./client.ts";

function migrationsFolder(): string {
  const fromEnv = process.env.MIGRATIONS_DIR;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const relative = new URL("../migrations", import.meta.url).pathname;
  if (existsSync(relative)) {
    return relative;
  }
  return "./drizzle";
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const db = createDb(url, { max: 1 });
  const started = Date.now();
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await dbClient(db).end({ timeout: 5 });
  console.log(`migrations applied in ${Date.now() - started}ms`);
}

main().catch((error: unknown) => {
  console.error("migration failed:", error);
  process.exit(1);
});
