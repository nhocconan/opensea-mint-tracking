/** Worker process context: validated config, db pool, logger. */
import { type AppConfig, loadEnv } from "@hoodmint/config";
import { type Db, getDb } from "@hoodmint/db";
import { getLogger, type Logger } from "@hoodmint/observability";

export interface WorkerContext {
  readonly config: AppConfig;
  readonly db: Db;
  readonly log: Logger;
}

const globalForContext = globalThis as unknown as { __hoodmintWorker?: WorkerContext };

export function context(): WorkerContext {
  if (globalForContext.__hoodmintWorker === undefined) {
    const config = loadEnv();
    globalForContext.__hoodmintWorker = {
      config,
      db: getDb(config.DATABASE_URL),
      log: getLogger("worker"),
    };
  }
  return globalForContext.__hoodmintWorker;
}
